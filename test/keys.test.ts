/**
 * Bearers are explicit credentials, never people or a fallback to ambient credentials.
 * Decisions where the contract leaves room:
 * - addKey rejects duplicate/invalid names without rotating an existing key; its only secret result is a string.
 * - sha256 covers the whole returned token. The JSON container and hash text encoding are not prescribed here.
 * - revocation is effective on the immediate request after await revokeKey (no one-second grace).
 * - a verified bearer bypasses Origin even if an unrelated Origin/proxy header/cookie is present.
 * Constant-time comparison is intentionally not tested: HTTP timing is not a reliable oracle for it.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, test } from "vitest";
import { WebSocket } from "ws";

import { endpoint } from "../src/contract.ts";
import { array, boolean, object, record, string } from "../src/schema.ts";
import { parseWebConfig } from "../src/server/config.ts";
import type { WebConfig } from "../src/server/config.ts";
import { addKey, revokeKey } from "../src/server/keys.ts";
import { Log, scoped } from "../src/server/log.ts";
import { route, serveWeb } from "../src/server/web.ts";
import type { Caller } from "../src/server/web.ts";
import { identityProvider } from "../src/test/oidc.ts";

/** vitest's matchers are typed `any`; held as `unknown` they nest in expected values safely. */
const anyString: unknown = expect.any(String);

const callerShape = object({ identities: array(string()), person: boolean(), login: string() });
const read = endpoint("GET", "/api/read", object({}), callerShape);
const act = endpoint("POST", "/api/act", object({}), callerShape);
const person = endpoint("POST", "/api/person", object({}), callerShape, { person: true });

const view = (caller: Caller) => ({
  identities: caller.identities,
  person: caller.person,
  login: caller.login,
});

const keyCaller = {
  identities: ["key:robot"],
  person: false,
  login: "key" satisfies Caller["login"],
};

async function login(url: string): Promise<string> {
  let response = await fetch(new URL("/auth/login", url), { redirect: "manual" });
  expect(response.status).toBe(302);
  response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
  response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
  expect(response.status).toBe(302);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toMatch(/^key_session=./);

  return cookie;
}

type Fixture = {
  home: string;
  token: string;
  url: string;
  cookie: string;
  log: Log;
  calls: string[];
};

async function withServer(
  run: (fixture: Fixture) => Promise<void>,
  options: { allow?: string[]; access?: WebConfig["access"] } = {}
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "slopkit-keys-"));
  const provider = await identityProvider("owner");
  let server: Awaited<ReturnType<typeof serveWeb>> | undefined;

  try {
    const token: string = await addKey(home, "robot");

    const config = parseWebConfig(
      {
        port: 0,
        oidc: { issuer: provider.issuer, clientId: "test" },
        allow: options.allow ?? ["sub:owner", "key:robot"],
        ...(options.access === undefined ? {} : { access: options.access }),
      },
      []
    );

    const log = new Log(home, "test", { echo: false });
    const calls: string[] = [];
    server = await serveWeb({
      home,
      config,
      env: {},
      log: scoped(log, "web"),
      assets: home,
      manifest: {},
      cookie: "key_session",
      routes: [read, act, person].map((each) =>
        route(each, (_request, caller) => {
          calls.push(each.path);

          return view(caller);
        })
      ),
      socket: {
        path: "/live",
        open: (send, caller) => {
          send(view(caller));

          return () => {};
        },
      },
    });
    await run({ home, token, url: server.url, cookie: await login(server.url), log, calls });
  } finally {
    await server?.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
}

async function refused(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ kind: "forbidden" });
}

async function logs(log: Log): Promise<string> {
  await log.flushed();
  const files = await readdir(log.directory);

  return (
    await Promise.all(files.map((name) => readFile(join(log.directory, name), "utf-8")))
  ).join("");
}

// A real signed proxy token and loopback JWKS endpoint, not an identity stub in the server.
async function withProxy(
  run: (access: NonNullable<WebConfig["access"]>, jwt: string) => Promise<void>
): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "proxy", alg: "RS256", use: "sig" };

  const server = createServer((request, response) => {
    response.writeHead(request.url === "/cdn-cgi/access/certs" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ keys: [jwk] }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- server.address() is AddressInfo | string | null
  if (typeof address !== "object" || address === null) {
    throw new Error("proxy did not bind TCP");
  }

  const teamDomain = `http://127.0.0.1:${address.port}`;

  try {
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "proxy" })
      .setIssuer(teamDomain)
      .setAudience("test")
      .setSubject("proxy-owner")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    await run({ teamDomain, audience: "test", subjectClaim: "sub" }, jwt);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

test("addKey returns a named 32-byte base64url token once and stores only SHA-256 at mode 0600", async () => {
  const home = await mkdtemp(join(tmpdir(), "slopkit-key-file-"));

  try {
    const token: string = await addKey(home, "a");
    expect(token).toMatch(/^a\.[A-Za-z0-9_-]{43}$/);
    const secret = token.slice(2);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(Buffer.from(secret, "base64url").toString("base64url")).toBe(secret);
    const path = join(home, "web-keys.json");
    const original = await readFile(path, "utf-8");
    const stored: unknown = JSON.parse(original);
    const entry = object({ name: string(), sha256: string() }, { strict: true });

    const entries = Array.isArray(stored)
      ? array(entry).parse(stored)
      : Object.values(record(entry).parse(stored));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toStrictEqual({ name: "a", sha256: anyString });
    const hash = entries[0]?.sha256 ?? "";

    const bytes = /^[0-9a-f]{64}$/i.test(hash)
      ? Buffer.from(hash, "hex")
      : Buffer.from(hash, "base64url");

    expect(bytes).toStrictEqual(createHash("sha256").update(token).digest());
    expect(original).not.toContain(token);
    expect(original).not.toContain(secret);
    expect((await stat(path)).mode % 0o1_0000).toBe(0o600);
    await expect(Promise.resolve().then(() => addKey(home, "a"))).rejects.toThrow(/.+/);
    expect(await readFile(path, "utf-8")).toBe(original);
    const second: string = await addKey(home, "b".repeat(32));
    expect(second).toMatch(/^b{32}\.[A-Za-z0-9_-]{43}$/);
    expect(second.split(".")[1]).not.toBe(secret);
    expect((await stat(path)).mode % 0o1_0000).toBe(0o600);
    await revokeKey(home, "a");
    expect(await readFile(path, "utf-8")).not.toContain('"a"');
    expect((await stat(path)).mode % 0o1_0000).toBe(0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["", "A", "a_b", "a.b", "a/b", "../a", "a b", "a\n", "a\u0000", "é", "a".repeat(33)])(
  "invalid key name %j is rejected without touching existing keys",
  async (name) => {
    const home = await mkdtemp(join(tmpdir(), "slopkit-key-name-"));

    try {
      await addKey(home, "keep-1");
      const path = join(home, "web-keys.json");
      const before = await readFile(path, "utf-8");
      await expect(Promise.resolve().then(() => addKey(home, name))).rejects.toThrow(/.+/);
      expect(await readFile(path, "utf-8")).toBe(before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
);

test("an allowed key reads as key:<name>, never a person, with login key", () =>
  withServer(async ({ url, token, calls }) => {
    const response = await fetch(new URL(read.path, url), {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(keyCaller);
    expect(calls).toStrictEqual([read.path]);
  }));

test("a valid bearer wins over a valid cookie and an invalid proxy assertion", () =>
  withServer(async ({ url, token, cookie }) => {
    const response = await fetch(new URL(read.path, url), {
      headers: { authorization: `Bearer ${token}`, cookie, "cf-access-jwt-assertion": "bad" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(keyCaller);
  }));

test.each([
  "Bearer",
  "Bearer not-a-key",
  `Bearer missing.${"A".repeat(43)}`,
  `Bearer robot.${"A".repeat(43)}`,
])(
  "a malformed, unknown or wrong bearer (%s) never falls back to a valid cookie and is logged",
  (authorization) =>
    withServer(async ({ url, cookie, calls, log }) => {
      const cookieOnly = await fetch(new URL(read.path, url), { headers: { cookie } });
      expect(cookieOnly.status).toBe(200);
      expect(await cookieOnly.json()).toMatchObject({ person: true, login: "oidc" });
      calls.length = 0;
      await refused(await fetch(new URL(read.path, url), { headers: { authorization, cookie } }));
      expect(calls).toStrictEqual([]);
      const text = await logs(log);

      const lines: unknown = JSON.parse(`[${text.trim().split("\n").join(",")}]`);

      const attributes: unknown = expect.objectContaining({ path: read.path });

      expect(lines).toContainEqual(
        expect.objectContaining({
          severity: "warn",
          attributes,
        })
      );

      // A bare 'Bearer' has no secret; diagnostics may name the authentication scheme.
      for (const badToken of authorization.split(" ").slice(1)) {
        expect(text).not.toContain(badToken);
      }
    })
);

test("a bearer alone decides beside a valid signed proxy identity, whose own Origin guard remains", () =>
  withProxy((access, jwt) =>
    withServer(
      async ({ url, token, calls }) => {
        const headers = { "cf-access-jwt-assertion": jwt };
        const good = await fetch(new URL(read.path, url), { headers });
        expect(good.status).toBe(200);
        expect(await good.json()).toMatchObject({
          identities: ["sub:proxy-owner"],
          login: "access",
        });

        const bearerWins = await fetch(new URL(read.path, url), {
          headers: { ...headers, authorization: `Bearer ${token}` },
        });

        expect(bearerWins.status).toBe(200);
        expect(await bearerWins.json()).toStrictEqual(keyCaller);
        calls.length = 0;
        await refused(await fetch(new URL(act.path, url), { method: "POST", headers, body: "{}" }));
        expect(calls).toStrictEqual([]);
        await refused(
          await fetch(new URL(read.path, url), {
            headers: { ...headers, authorization: "Bearer malformed" },
          })
        );
        expect(calls).toStrictEqual([]);
      },
      { access, allow: ["sub:owner", "sub:proxy-owner", "key:robot"] }
    )
  ));

test("a verified bearer can POST without Origin or with a foreign Origin", () =>
  withServer(async ({ url, token }) => {
    for (const extra of [{}, { origin: "https://foreign.invalid" }]) {
      const response = await fetch(new URL(act.path, url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...extra },
        body: "{}",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual(keyCaller);
    }
  }));

test("cookie POST still requires the app's Origin, even when Authorization is present but bad", () =>
  withServer(async ({ url, cookie, calls }) => {
    for (const extra of [
      {},
      { origin: "https://foreign.invalid" },
      { authorization: "Bearer bad" },
    ]) {
      await refused(
        await fetch(new URL(act.path, url), {
          method: "POST",
          headers: { cookie, ...extra },
          body: "{}",
        })
      );
    }

    expect(calls).toStrictEqual([]);

    const response = await fetch(new URL(act.path, url), {
      method: "POST",
      headers: { cookie, origin: new URL(url).origin },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ person: true, login: "oidc" });
  }));

test("person endpoints refuse a key even beside a valid person's cookie", () =>
  withServer(async ({ url, token, cookie, calls }) => {
    await refused(
      await fetch(new URL(person.path, url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, cookie, origin: new URL(url).origin },
        body: "{}",
      })
    );
    expect(calls).toStrictEqual([]);

    const response = await fetch(new URL(person.path, url), {
      method: "POST",
      headers: { cookie, origin: new URL(url).origin },
      body: "{}",
    });

    expect(response.status).toBe(200);
  }));

test("a present but unlisted key is forbidden even beside a valid cookie", () =>
  withServer(
    async ({ url, token, cookie, calls }) => {
      await refused(
        await fetch(new URL(read.path, url), {
          headers: { authorization: `Bearer ${token}`, cookie },
        })
      );
      expect(calls).toStrictEqual([]);
    },
    { allow: ["sub:owner"] }
  ));

test("revocation refuses the very next request, keeps other keys valid and never falls back to a cookie", () =>
  withServer(
    async ({ home, url, token, cookie, calls }) => {
      const other: string = await addKey(home, "other");
      expect(
        (await fetch(new URL(read.path, url), { headers: { authorization: `Bearer ${token}` } }))
          .status
      ).toBe(200);
      await revokeKey(home, "robot");
      calls.length = 0;
      await refused(
        await fetch(new URL(read.path, url), {
          headers: { authorization: `Bearer ${token}`, cookie },
        })
      );
      expect(calls).toStrictEqual([]);

      const response = await fetch(new URL(read.path, url), {
        headers: { authorization: `Bearer ${other}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ identities: ["key:other"] });
    },
    { allow: ["sub:owner", "key:robot", "key:other"] }
  ));

test("a socket upgrade accepts a verified bearer without Origin and reports the key identity", () =>
  withServer(async ({ url, token }) => {
    const target = new URL("/live", url);
    target.protocol = "ws:";
    const socket = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });

    try {
      const message = await new Promise<string>((resolve, reject) => {
        socket.once("message", (data) =>
          resolve(new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data))
        );
        socket.once("error", reject);
      });

      expect(JSON.parse(message)).toStrictEqual(keyCaller);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        });

        socket.terminate();
        await closed;
      }
    }
  }));

test("request logs carry caller key:<name>, status and request id, never the token or its secret", () =>
  withServer(async ({ url, token, log }) => {
    const response = await fetch(new URL(read.path, url), {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await response.text();
    const text = await logs(log);

    const lines: unknown = JSON.parse(`[${text.trim().split("\n").join(",")}]`);

    const attributes: unknown = expect.objectContaining({
      caller: "key:robot",
      path: read.path,
      status: 200,
      person: false,
      request: anyString,
    });

    expect(lines).toContainEqual(
      expect.objectContaining({
        body: "request",
        attributes,
      })
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[1]);
  }));
