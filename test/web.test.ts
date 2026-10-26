import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";

import { expect, test } from "vitest";

import { endpoint } from "../src/contract.ts";
import { array, object, string } from "../src/schema.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { addKey } from "../src/server/keys.ts";
import * as web from "../src/server/web.ts";
import { route, serveWeb } from "../src/server/web.ts";
import { identityProvider } from "../src/test/oidc.ts";

const who = endpoint("GET", "/api/who", object({}), object({ identities: array(string()) }));

// The session cookie is the app's: a login through the server's own OIDC opens a session the next request is known by,
// whatever the cookie is called (the kit once read a fixed name, so only one app's sessions ever worked).
test("an app's own session cookie signs its requests in", async () => {
  const home = await mkdtemp(join(tmpdir(), "slopkit-web-"));
  const provider = await identityProvider("someone");
  await writeFile(join(home, "index.html"), "<!doctype html>");
  const warnings: string[] = [];

  const config = parseWebConfig(
    { port: 0, oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
    warnings
  );

  expect(warnings).toStrictEqual([]);

  const server = await serveWeb({
    home,
    config,
    env: {},
    log: () => {},
    assets: home,
    manifest: {},
    cookie: "hello_session",
    routes: [route(who, (_request, caller) => ({ identities: caller.identities }))],
  });

  try {
    expect((await fetch(new URL("/api/who", server.url))).status).toBe(401);
    let response = await fetch(new URL("/auth/login", server.url), { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^hello_session=./);
    response = await fetch(new URL("/api/who", server.url), { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ identities: ["sub:someone"] });
  } finally {
    await server.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});

// A link opened before signing in is where the person meant to go: the sign-in comes back to it, and only ever to a
// path on this server.
test("sign-in returns to the page it interrupted, never off this server", async () => {
  const home = await mkdtemp(join(tmpdir(), "slopkit-web-"));
  const provider = await identityProvider("someone");
  await writeFile(join(home, "index.html"), "<!doctype html>");

  const server = await serveWeb({
    home,
    config: parseWebConfig(
      { port: 0, oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
      []
    ),
    env: {},
    log: () => {},
    assets: home,
    manifest: {},
    cookie: "hello_session",
    routes: [route(who, (_request, caller) => ({ identities: caller.identities }))],
  });

  /** Follow a sign-in from `start` (with the cookies it sets) to where the callback sends the browser. */
  const signIn = async (start: Response): Promise<string | null> => {
    const login = new URL(start.headers.get("location") ?? "", server.url);
    let response = await fetch(login, { redirect: "manual" });
    const back = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { cookie: back },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie") ?? "").toMatch(/^hello_session=./);

    return response.headers.get("location");
  };

  try {
    const page = await fetch(new URL("/c/abc123?item=a.png", server.url), {
      redirect: "manual",
      headers: { accept: "text/html" },
    });

    expect(page.status).toBe(302);
    expect(await signIn(page)).toBe("/c/abc123?item=a.png");

    // Off this server, or a character a Location header refuses: the sign-in still lands, at the root.
    for (const elsewhere of [
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example/",
      "/\u0001x",
      "/\u007F",
      "/caf\u00E9",
    ]) {
      const forged = new Response(null, {
        status: 302,
        headers: { location: `/auth/login?back=${encodeURIComponent(elsewhere)}` },
      });

      expect(await signIn(forged)).toBe("/");
    }

    const plain = new Response(null, { status: 302, headers: { location: "/auth/login" } });
    expect(await signIn(plain)).toBe("/");
  } finally {
    await server.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});

// A build may keep a brotli copy beside a file: a client that takes brotli gets those bytes, any other the file itself
// (gzipped when it takes that), so every client decodes to the same asset.
test("a file's brotli copy goes only to a client that takes brotli", async () => {
  const home = await mkdtemp(join(tmpdir(), "slopkit-web-"));
  const provider = await identityProvider("someone");
  const script = `export const x = ${JSON.stringify("slop ".repeat(400))};`;
  await writeFile(join(home, "index.html"), "<!doctype html>");
  await writeFile(join(home, "app.ABCD1234.js"), script);
  await writeFile(join(home, "app.ABCD1234.js.br"), brotliCompressSync(script));

  const server = await serveWeb({
    home,
    config: parseWebConfig(
      { port: 0, oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
      []
    ),
    env: {},
    log: () => {},
    assets: home,
    manifest: {},
    cookie: "hello_session",
    routes: [],
  });

  try {
    let response = await fetch(new URL("/auth/login", server.url), { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const raw = (encoding: string) =>
      new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
        const url = new URL("/app.ABCD1234.js", server.url);
        get(url, { headers: { cookie, "accept-encoding": encoding } }, (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          answer.on("end", () =>
            resolve({ encoding: answer.headers["content-encoding"], body: Buffer.concat(chunks) })
          );
        }).on("error", reject);
      });

    const brotli = await raw("gzip, deflate, br, zstd");
    expect(brotli.encoding).toBe("br");
    expect(brotliDecompressSync(brotli.body).toString()).toBe(script);
    const gzip = await raw("gzip");
    expect(gzip.encoding).toBe("gzip");
    expect(gunzipSync(gzip.body).toString()).toBe(script);
    const plain = await raw("identity");
    expect(plain.encoding).toBeUndefined();
    expect(plain.body.toString()).toBe(script);
  } finally {
    await server.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});

const personKey = (identities: readonly string[]) =>
  createHash("sha256").update(identities.toSorted().join("\n")).digest("base64url").slice(0, 22);

const whoCookies = (response: Response) =>
  response.headers.getSetCookie().filter((cookie) => cookie.startsWith("hello_who="));

test("whoOf names the sorted whole identity set with a 22-character base64url SHA256", () => {
  const identities = ["sub:z", "email:a@example.test", "sub:a"];
  const before = [...identities];
  expect(web.whoOf(identities)).toBe(personKey(identities));
  expect(web.whoOf(identities.toReversed())).toBe(personKey(identities));
  expect(web.whoOf([])).toBe("47DEQpj8HBSa-_TImW-5JC");
  expect(web.whoOf(["sub:a"])).not.toBe(web.whoOf(["sub:z"]));
  expect(identities).toStrictEqual(before);
});

test.each(["http://127.0.0.1", "public.example"])(
  "the readable who-cookie names the callback's session, repairs identified responses, and survives logout (%s)",
  async (host) => {
    const home = await mkdtemp(join(tmpdir(), "slopkit-who-"));
    const provider = await identityProvider("someone");
    await writeFile(join(home, "index.html"), "<!doctype html>");
    const token = await addKey(home, "fixture");

    const server = await serveWeb({
      home,
      config: parseWebConfig(
        {
          port: 0,
          oidc: { issuer: provider.issuer, clientId: "test" },
          allow: ["sub:someone", "key:fixture"],
          host,
        },
        []
      ),
      env: {},
      log: () => {},
      assets: home,
      manifest: {},
      cookie: "hello_session",
      who: "hello_who",
      routes: [route(who, (_request, caller) => ({ identities: caller.identities }))],
    });

    const expected = `hello_who=${personKey(["sub:someone"])}`;

    const checkCookie = (response: Response, secure = host === "public.example") => {
      const cookies = whoCookies(response);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]?.split(";")[0]).toBe(expected);
      expect(cookies[0]).toMatch(/; Path=\//i);
      expect(cookies[0]).toMatch(/; SameSite=Lax/i);
      expect(cookies[0]).toMatch(/; Max-Age=34560000(?:;|$)/i);
      expect(cookies[0]).not.toMatch(/HttpOnly/i);
      expect(/; Secure(?:;|$)/i.test(cookies[0] ?? "")).toBe(secure);
    };

    try {
      expect(whoCookies(await fetch(new URL("/api/who", server.url)))).toStrictEqual([]);
      let response = await fetch(new URL("/auth/login", server.url), { redirect: "manual" });
      response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
      response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
      expect(response.status).toBe(302);
      checkCookie(response);

      const session =
        response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("hello_session="))
          ?.split(";")[0] ?? "";

      expect(session).toMatch(/^hello_session=./);

      for (const path of ["/api/who", "/", "/missing.js"]) {
        checkCookie(
          await fetch(new URL(path, server.url), {
            headers: { cookie: `${session}; hello_who=old` },
          })
        );
      }

      if (host === "public.example") {
        checkCookie(
          await fetch(new URL("/api/who", server.url), {
            headers: { cookie: session, host },
          }),
          true
        );
      }

      expect(
        whoCookies(
          await fetch(new URL("/api/who", server.url), {
            headers: { cookie: `${session}; ${expected}` },
          })
        )
      ).toStrictEqual([]);
      expect(
        whoCookies(
          await fetch(new URL("/api/who", server.url), {
            headers: { authorization: `Bearer ${token}`, cookie: "hello_who=old" },
          })
        )
      ).toStrictEqual([]);

      const logout = await fetch(new URL("/auth/logout", server.url), {
        method: "POST",
        headers: { cookie: `${session}; ${expected}`, origin: new URL(server.url).origin },
      });

      expect(logout.status).toBe(204);
      expect(whoCookies(logout)).toStrictEqual([]);
      expect(
        logout.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith("hello_session=") && cookie.includes("Max-Age=0"))
      ).toBe(true);
    } finally {
      await server.close();
      await provider.close();
      await rm(home, { recursive: true, force: true });
    }
  }
);
