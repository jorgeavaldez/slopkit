/**
 * Raw routes are buffered HTTP behind the same guards as contracts, never an asset bypass.
 * Contract choices: rawRoute values share `routes` with route values; request.url is a URL,
 * headers have Node's IncomingHttpHeaders shape, and a /* suffix captures the decoded-once remainder
 * in params['*'] (an exact path has {}). Reserved-path overlap includes broad prefixes covering
 * /auth/ or the configured socket, not just exact spelling. No image/* response is gzipped.
 * Handler headers cannot override type, nosniff, framing or the default CSP; a CSP retaining the
 * baseline and adding sandbox is accepted. Cache defaults to no-store; immutable is opt-in.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { endpoint } from "../src/contract.ts";
import { object, string } from "../src/schema.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { addKey } from "../src/server/keys.ts";
import { Log, scoped } from "../src/server/log.ts";
import { rawRoute, route, serveWeb } from "../src/server/web.ts";
import type { Caller, WebOptions } from "../src/server/web.ts";
import { identityProvider } from "../src/test/oidc.ts";

type RawRequest = {
  url: URL;
  params: Record<string, string>;
  body: Buffer | undefined;
  headers: IncomingHttpHeaders;
};

type RawReply = {
  status: number;
  type: string;
  body: Buffer | string;
  cache?: "immutable" | "no-store";
  headers?: Record<string, string>;
};

type Call = { request: RawRequest; caller: Caller };

type Fixture = {
  home: string;
  url: string;
  token: string;
  cookie: string;
  calls: Call[];
  log: Log;
};

const baseline =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function withServer(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    path?: string;
    method?: "GET" | "POST";
    person?: boolean;
    bodyLimit?: number;
    globalLimit?: number;
    reply?: RawReply;
    routes?: WebOptions["routes"];
  } = {}
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "slopkit-raw-"));
  const provider = await identityProvider("owner");
  let server: Awaited<ReturnType<typeof serveWeb>> | undefined;

  try {
    await writeFile(join(home, "index.html"), "asset shell");
    await writeFile(join(home, "picture.png"), "asset bytes, not the raw handler");
    const token: string = await addKey(home, "robot");

    const config = parseWebConfig(
      {
        port: 0,
        oidc: { issuer: provider.issuer, clientId: "test" },
        allow: ["sub:owner", "key:robot"],
      },
      []
    );

    const calls: Call[] = [];
    const log = new Log(home, "test", { echo: false });
    server = await serveWeb({
      home,
      config,
      env: {},
      log: scoped(log, "web"),
      assets: home,
      manifest: {},
      cookie: "raw_session",
      ...(options.globalLimit === undefined ? {} : { bodyLimit: options.globalLimit }),
      routes: options.routes ?? [
        rawRoute({
          method: options.method ?? "GET",
          path: options.path ?? "/picture.png",
          person: options.person ?? false,
          ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
          handle: (request: RawRequest, caller: Caller) => {
            calls.push({ request, caller });

            return (
              options.reply ?? { status: 200, type: "image/png", body: Buffer.from([0, 255, 1]) }
            );
          },
        }),
      ],
      socket: { path: "/live", open: () => () => {} },
    });
    let response = await fetch(new URL("/auth/login", server.url), { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    expect(response.status).toBe(302);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^raw_session=./);
    await run({ home, url: server.url, token, cookie, calls, log });
  } finally {
    await server?.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
}

async function failure(response: Response, status: number, kind: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ kind });
}

// Multiple CSP fields intersect; fetch joins them with commas. Within one policy the first directive wins.
function policies(response: Response): Map<string, string>[] {
  return (response.headers.get("content-security-policy") ?? "").split(",").map((policy) => {
    const directives = new Map<string, string>();

    for (const part of policy.split(";")) {
      const [name = "", ...values] = part.trim().split(/\s+/);

      if (!directives.has(name)) {
        directives.set(name, values.join(" "));
      }
    }

    return directives;
  });
}

function secure(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const headers = policies(response);

  for (const part of baseline.split(";")) {
    const [name = "", ...values] = part.trim().split(/\s+/);
    expect(headers.some((policy) => policy.get(name) === values.join(" "))).toBe(true);
  }
}

test("an anonymous raw GET is signed-out, not an unguarded asset", () =>
  withServer(async ({ url, calls }) => {
    await failure(await fetch(new URL("/picture.png", url)), 401, "signed-out");
    expect(calls).toStrictEqual([]);
  }));

test("raw routes reject a foreign Host before the handler even with a valid bearer", () =>
  withServer(async ({ url, token, calls }) => {
    // Node fetch rewrites Host to the URL's authority, so use the native HTTP client for this guard.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        new URL("/picture.png", url),
        { headers: { host: "foreign.invalid", authorization: `Bearer ${token}` } },
        (response) => {
          response.resume();
          response.once("error", reject);
          response.once("end", () => resolve(response.statusCode));
        }
      );

      request.once("error", reject);
      request.end();
    });

    expect(status).toBe(421);
    expect(calls).toStrictEqual([]);
  }));

test("a raw route refuses a bad bearer instead of falling back to a valid cookie", () =>
  withServer(async ({ url, cookie, calls }) => {
    await failure(
      await fetch(new URL("/picture.png", url), {
        headers: { cookie, authorization: "Bearer bad" },
      }),
      403,
      "forbidden"
    );
    expect(calls).toStrictEqual([]);
  }));

test("a cookie raw POST needs the app's Origin; same-Origin POST still works", () =>
  withServer(
    async ({ url, cookie, calls }) => {
      for (const extra of [{}, { origin: "https://foreign.invalid" }]) {
        await failure(
          await fetch(new URL("/picture.png", url), {
            method: "POST",
            headers: { cookie, ...extra },
            body: "bytes",
          }),
          403,
          "forbidden"
        );
      }

      expect(calls).toStrictEqual([]);

      const response = await fetch(new URL("/picture.png", url), {
        method: "POST",
        headers: { cookie, origin: new URL(url).origin },
        body: "bytes",
      });

      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.caller).toMatchObject({ person: true, login: "oidc" });
    },
    { method: "POST" }
  ));

test("a raw person route refuses a key beside a cookie but accepts the person's cookie alone", () =>
  withServer(
    async ({ url, token, cookie, calls }) => {
      await failure(
        await fetch(new URL("/picture.png", url), {
          headers: { cookie, authorization: `Bearer ${token}` },
        }),
        403,
        "forbidden"
      );
      expect(calls).toStrictEqual([]);
      const response = await fetch(new URL("/picture.png", url), { headers: { cookie } });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.caller.person).toBe(true);
    },
    { person: true }
  ));

test("a raw GET wins over an existing asset, preserves bytes and exposes URL, headers and key caller", () =>
  withServer(async ({ url, token, cookie, calls }) => {
    const response = await fetch(new URL("/picture.png?download=1", url), {
      headers: { authorization: `Bearer ${token}`, cookie, "x-probe": "present" },
    });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(Buffer.from([0, 255, 1]));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    secure(response);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBeInstanceOf(URL);
    expect(calls[0]?.request.url.pathname).toBe("/picture.png");
    expect(calls[0]?.request.url.searchParams.get("download")).toBe("1");
    expect(calls[0]?.request.params).toStrictEqual({});
    expect(calls[0]?.request.body).toBeUndefined();
    expect(calls[0]?.request.headers["x-probe"]).toBe("present");
    expect(calls[0]?.caller).toMatchObject({
      identities: ["key:robot"],
      person: false,
      login: "key",
    });
  }));

test("raw POST accepts binary non-UTF8 bytes without JSON decoding and a verified key needs no Origin", () =>
  withServer(
    async ({ url, token, calls }) => {
      const bytes = Buffer.from([0, 255, 254, 123, 0]);

      const response = await fetch(new URL("/picture.png", url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: bytes,
      });

      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.request.body).toStrictEqual(bytes);
      expect(Buffer.isBuffer(calls[0]?.request.body)).toBe(true);
    },
    { method: "POST" }
  ));

test("a raw body exactly at its byte cap works, one byte over is invalid before the handler", () =>
  withServer(
    async ({ url, token, calls }) => {
      const headers = { authorization: `Bearer ${token}` };

      const accepted = await fetch(new URL("/picture.png", url), {
        method: "POST",
        headers,
        body: Buffer.from([0, 255, 2, 3, 4]),
      });

      expect(accepted.status).toBe(200);
      await accepted.arrayBuffer();
      expect(calls).toHaveLength(1);
      calls.length = 0;
      await failure(
        await fetch(new URL("/picture.png", url), {
          method: "POST",
          headers,
          body: Buffer.from([0, 255, 2, 3, 4, 5]),
        }),
        400,
        "invalid"
      );
      expect(calls).toStrictEqual([]);
    },
    { method: "POST", bodyLimit: 5 }
  ));

test("a chunked raw upload is bounded by received bytes, not by a missing Content-Length", () =>
  withServer(
    async ({ url, token, calls }) => {
      const answer = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            new URL("/picture.png", url),
            { method: "POST", headers: { authorization: `Bearer ${token}` } },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.once("error", reject);
              response.once("end", () =>
                resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() })
              );
            }
          );

          request.once("error", reject);
          request.write(Buffer.from([0, 1, 2]));
          request.end(Buffer.from([3, 4, 5]));
        }
      );

      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ kind: "invalid" });
      expect(calls).toStrictEqual([]);
    },
    { method: "POST", bodyLimit: 5 }
  ));

test("the default raw body cap is 64 KiB, measured in bytes before the handler", () =>
  withServer(
    async ({ url, token, calls }) => {
      const headers = { authorization: `Bearer ${token}` };

      const accepted = await fetch(new URL("/picture.png", url), {
        method: "POST",
        headers,
        body: Buffer.alloc(65_536, 255),
      });

      expect(accepted.status).toBe(200);
      await accepted.arrayBuffer();
      expect(calls[0]?.request.body).toHaveLength(65_536);
      calls.length = 0;
      await failure(
        await fetch(new URL("/picture.png", url), {
          method: "POST",
          headers,
          body: Buffer.alloc(65_537, 255),
        }),
        400,
        "invalid"
      );
      expect(calls).toStrictEqual([]);
    },
    { method: "POST" }
  ));

test("raw response status, string body and immutable cache are sent as declared", () =>
  withServer(
    async ({ url, cookie }) => {
      const response = await fetch(new URL("/picture.png", url), { headers: { cookie } });
      expect(response.status).toBe(201);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("x-resource")).toBe("created");
      expect(await response.text()).toBe("created bytes");
      secure(response);
    },
    {
      reply: {
        status: 201,
        type: "text/plain; charset=utf-8",
        body: "created bytes",
        cache: "immutable",
        headers: { "x-resource": "created" },
      },
    }
  ));

test.each(["content-security-policy", "Content-Security-Policy"])(
  "handler %s cannot drop default-src or replace the other security/type headers",
  (name) =>
    withServer(
      async ({ url, cookie }) => {
        const response = await fetch(new URL("/picture.png", url), { headers: { cookie } });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        secure(response);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("x-resource")).toBe("kept");
      },
      {
        reply: {
          status: 200,
          type: "image/png",
          body: Buffer.from([0, 255]),
          headers: {
            [name]: "img-src *; script-src * 'unsafe-inline'",
            "X-Content-Type-Options": "off",
            "X-Frame-Options": "ALLOWALL",
            "Referrer-Policy": "unsafe-url",
            "Content-Type": "text/html",
            "x-resource": "kept",
          },
        },
      }
    )
);

test("a handler can tighten the default CSP by adding sandbox without dropping any baseline directive", () =>
  withServer(
    async ({ url, cookie }) => {
      const response = await fetch(new URL("/picture.png", url), { headers: { cookie } });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      secure(response);
      expect(policies(response).some((policy) => policy.get("sandbox") === "")).toBe(true);
    },
    {
      reply: {
        status: 200,
        type: "image/png",
        body: "bytes",
        headers: { "content-security-policy": `${baseline}; sandbox` },
      },
    }
  ));

test.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/svg+xml"])(
  "an image response (%s) is never gzipped even above the compression threshold",
  (type) =>
    withServer(
      async ({ url, cookie }) => {
        const response = await fetch(new URL("/picture.png", url), {
          headers: { cookie, "accept-encoding": "gzip" },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("content-type")).toBe(type);
        expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(Buffer.alloc(4096, 65));
      },
      { reply: { status: 200, type, body: Buffer.alloc(4096, 65) } }
    )
);

test("prefix params capture nested suffixes decoded once, while sibling paths never match", () =>
  withServer(
    async ({ url, cookie, calls }) => {
      const headers = { cookie };
      let response = await fetch(new URL("/files/a%20b/nested%252F.png?q=1", url), { headers });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(calls[0]?.request.params).toStrictEqual({ "*": "a b/nested%2F.png" });
      response = await fetch(new URL("/files/", url), { headers });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(calls[1]?.request.params).toStrictEqual({ "*": "" });
      calls.length = 0;
      response = await fetch(new URL("/files-other/no", url), { headers });
      expect(await response.text()).toBe("asset shell");
      expect(calls).toStrictEqual([]);
    },
    { path: "/files/*" }
  ));

test("an exact raw path does not match children or a different HTTP method", () =>
  withServer(async ({ url, cookie, calls }) => {
    const child = await fetch(new URL("/picture.png/child", url), { headers: { cookie } });
    await child.text();

    const post = await fetch(new URL("/picture.png", url), {
      method: "POST",
      headers: { cookie, origin: new URL(url).origin },
      body: "bytes",
    });

    expect(post.status).not.toBe(200);
    await post.text();
    expect(calls).toStrictEqual([]);
  }));

test.each([
  "/auth/*",
  "/auth/login",
  "/auth/callback",
  "/auth/logout",
  "/auth/nested/*",
  "/live",
  "/live/*",
  "/*",
])("a raw route overlapping reserved path %s is refused at server start", async (path) => {
  const home = await mkdtemp(join(tmpdir(), "slopkit-reserved-"));
  const provider = await identityProvider("owner");

  const config = parseWebConfig(
    { port: 0, oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:owner"] },
    []
  );

  let server: Awaited<ReturnType<typeof serveWeb>> | undefined;

  try {
    await expect(
      Promise.resolve().then(async () => {
        server = await serveWeb({
          home,
          config,
          env: {},
          log: () => {},
          assets: home,
          cookie: "reserved_session",
          manifest: {},
          routes: [
            rawRoute({
              method: "GET",
              path,
              handle: () => ({ status: 200, type: "text/plain", body: "must not serve" }),
            }),
          ],
          socket: { path: "/live", open: () => () => {} },
        });
      })
    ).rejects.toThrow(/.+/);
  } finally {
    await server?.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("raw requests use the normal request log with caller, request id, status and no token", () =>
  withServer(async ({ url, token, log }) => {
    const response = await fetch(new URL("/picture.png", url), {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await log.flushed();

    const text = (
      await Promise.all(
        (await readdir(log.directory)).map((name) => readFile(join(log.directory, name), "utf-8"))
      )
    ).join("");

    const lines: unknown[] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toContainEqual(
      expect.objectContaining({
        body: "request",
        attributes: expect.objectContaining({
          path: "/picture.png",
          method: "GET",
          caller: "key:robot",
          request: expect.any(String),
          person: false,
          status: 200,
          ms: expect.any(Number),
        }),
      })
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[1]);
  }));

test("contract routes can lower or raise their own byte cap without changing the global default", async () => {
  const input = object({ value: string() });
  const calls: string[] = [];

  const make = (path: string, bodyLimit?: number) => {
    const contract = endpoint("POST", path, input, input);

    const handle = (value: { value: string }) => {
      calls.push(path);

      return value;
    };

    return bodyLimit === undefined
      ? route(contract, handle)
      : route(contract, handle, { bodyLimit });
  };

  await withServer(
    async ({ url, cookie }) => {
      const headers = { cookie, origin: new URL(url).origin, "content-type": "application/json" };
      const raw = await fetch(new URL("/bytes", url), { headers: { cookie } });
      expect(raw.status).toBe(200);
      expect(await raw.text()).toBe("raw alongside contracts");

      const cases = [
        { path: "/api/small", body: '{"value":"éé"}', over: '{"value":"ééa"}', bytes: 16 },
        {
          path: "/api/default",
          body: `{"value":"${"x".repeat(12)}"}`,
          over: `{"value":"${"x".repeat(13)}"}`,
          bytes: 24,
        },
        {
          path: "/api/large",
          body: `{"value":"${"x".repeat(52)}"}`,
          over: `{"value":"${"x".repeat(53)}"}`,
          bytes: 64,
        },
      ];

      for (const each of cases) {
        expect(Buffer.byteLength(each.body)).toBe(each.bytes);
        expect(Buffer.byteLength(each.over)).toBe(each.bytes + 1);

        const accepted = await fetch(new URL(each.path, url), {
          method: "POST",
          headers,
          body: each.body,
        });

        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toStrictEqual(JSON.parse(each.body));
        expect(calls).toStrictEqual([each.path]);
        calls.length = 0;
        await failure(
          await fetch(new URL(each.path, url), { method: "POST", headers, body: each.over }),
          400,
          "invalid"
        );
        expect(calls).toStrictEqual([]);
      }
    },
    {
      globalLimit: 24,
      routes: [
        rawRoute({
          method: "GET",
          path: "/bytes",
          handle: () => ({ status: 200, type: "text/plain", body: "raw alongside contracts" }),
        }),
        make("/api/small", 16),
        make("/api/default"),
        make("/api/large", 64),
      ],
    }
  );
});

test("contract routes without an override keep the 64-KiB default", async () => {
  const input = object({ value: string() });
  const calls: string[] = [];
  const contract = endpoint("POST", "/api/default", input, input);
  await withServer(
    async ({ url, cookie }) => {
      const headers = { cookie, origin: new URL(url).origin };
      const body = `{"value":"${"x".repeat(65_524)}"}`;
      expect(Buffer.byteLength(body)).toBe(65_536);
      const response = await fetch(new URL(contract.path, url), { method: "POST", headers, body });
      expect(response.status).toBe(200);
      await response.json();
      expect(calls).toStrictEqual([contract.path]);
      calls.length = 0;
      await failure(
        await fetch(new URL(contract.path, url), { method: "POST", headers, body: `${body} ` }),
        400,
        "invalid"
      );
      expect(calls).toStrictEqual([]);
    },
    {
      routes: [
        route(contract, (value) => {
          calls.push(contract.path);

          return value;
        }),
      ],
    }
  );
});
