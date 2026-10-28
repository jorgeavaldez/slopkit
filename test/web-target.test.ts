import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { endpoint } from "../src/contract.ts";
import { object, string } from "../src/schema.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { rawRoute, route, serveWeb } from "../src/server/web.ts";
import { identityProvider } from "../src/test/oidc.ts";

let home: string;
let provider: Awaited<ReturnType<typeof identityProvider>>;
let web: Awaited<ReturnType<typeof serveWeb>>;
let cookie: string;
const calls: string[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "slopkit-target-"));
  provider = await identityProvider("owner");
  await writeFile(join(home, "asset.txt"), "fixture asset");
  const read = endpoint("GET", "/api/read", object({}), object({ answer: string() }));

  web = await serveWeb({
    home,
    assets: home,
    env: {},
    manifest: {},
    cookie: "target",
    log: () => {},
    config: parseWebConfig(
      { port: 0, oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:owner"] },
      []
    ),
    routes: [
      route(read, () => {
        calls.push("route");

        return { answer: "fixture route" };
      }),
      rawRoute({
        method: "GET",
        path: "/raw/read",
        handle: () => {
          calls.push("raw");

          return { status: 200, type: "text/plain", body: "fixture raw" };
        },
      }),
    ],
    socket: {
      path: "/live",
      open: () => {
        calls.push("socket");

        return () => {};
      },
    },
  });
  let login = await fetch(new URL("/auth/login", web.url), { redirect: "manual" });
  login = await fetch(login.headers.get("location") ?? "", { redirect: "manual" });
  login = await fetch(login.headers.get("location") ?? "", { redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  if (!/^target=./.test(cookie)) {
    throw new Error("fixture login did not set its session cookie");
  }
});

afterAll(async () => {
  await web?.close();
  await provider?.close();
  await rm(home, { recursive: true, force: true });
});

/** Raw TCP preserves a request target fetch would normalize into another path. */
function requestTarget(target: string, signedIn: boolean, upgrade: boolean): Promise<number> {
  const url = new URL(web.url);

  return new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let answer = "";
    socket.once("error", reject);
    socket.on("data", (bytes) => {
      answer += bytes.toString("utf-8");

      if (answer.includes("\r\n\r\n")) {
        socket.destroy();
        const status = /^HTTP\/1\.1 (\d{3}) /.exec(answer)?.[1];

        if (status === undefined) {
          reject(new Error(`not an HTTP answer: ${answer}`));
        } else {
          resolve(Number(status));
        }
      }
    });
    socket.once("end", () => {
      if (!answer.includes("\r\n\r\n")) {
        reject(new Error(`incomplete HTTP answer: ${answer}`));
      }
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          `Host: ${url.host}`,
          ...(signedIn ? [`Cookie: ${cookie}`] : []),
          ...(upgrade
            ? [
                "Connection: Upgrade",
                "Upgrade: websocket",
                "Sec-WebSocket-Version: 13",
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                `Origin: ${url.origin}`,
              ]
            : ["Connection: close"]),
          "",
          "",
        ].join("\r\n")
      );
    });
  });
}

test.each([
  { kind: "route", path: "/api/read", upgrade: false, status: 200 },
  { kind: "raw", path: "/raw/read", upgrade: false, status: 200 },
  { kind: "asset", path: "/asset.txt", upgrade: false, status: 200 },
  { kind: "socket", path: "/live", upgrade: true, status: 101 },
])(
  "$kind accepts ordinary paths and queries but refuses non-origin-form targets before identity or dispatch",
  async ({ kind, path, upgrade, status }) => {
    for (const target of [`//anything${path}`, `//${path.slice(1)}`, `http://other${path}`]) {
      for (const signedIn of [false, true]) {
        calls.length = 0;
        expect(await requestTarget(target, signedIn, upgrade)).toBe(400);
        expect(calls).toStrictEqual([]);
      }
    }

    calls.length = 0;
    expect(await requestTarget(`${path}?next=//elsewhere/api/read`, true, upgrade)).toBe(status);
    expect(calls).toStrictEqual(kind === "asset" ? [] : [kind]);
  }
);
