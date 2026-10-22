import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, sep } from "node:path";

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { array, number, object, optional, string } from "../src/schema.ts";
import { identityProvider } from "../src/test/oidc.ts";
import {
  cleanup,
  directory,
  installed,
  launch,
  pack,
  VERSION_ONE,
  VERSION_TWO,
} from "./cli-fixture.ts";
import type { Exit } from "./cli-fixture.ts";

const HOST = "app.example.test";
const TEAM = "https://team.example";
const AUDIENCE = "expected-audience";
const LOGIN = `${TEAM}/cdn-cgi/access/login/${HOST}?kid=${AUDIENCE}`;
const closes: (() => Promise<void>)[] = [];
let template: Awaited<ReturnType<typeof installed>>;

beforeAll(async () => {
  const release = await pack(await directory(), VERSION_ONE);
  template = await installed(release, "http://127.0.0.1:1");
});

afterEach(async () => {
  for (const close of closes.splice(0).toReversed()) {
    await close();
  }
});

afterAll(async () => {
  await cleanup();
});

function webSettings() {
  return {
    port: 0,
    bind: "127.0.0.1",
    host: HOST,
    access: { teamDomain: TEAM, audience: AUDIENCE },
    allow: ["sub:owner"],
  };
}

async function app() {
  const base = await directory();
  const home = join(base, "home");
  const root = join(base, "package");
  const bin = join(base, "notebook");
  // Each case gets its own installed package and home without repeating npm's installation.
  await cp(template.root, root, { recursive: true });
  await symlink(join(root, "bin.js"), bin);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, "web.json"), JSON.stringify(webSettings()));
  const env = { ...template.env, NOTEBOOK_HOME: home };

  const command = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    launch(bin, args, { ...env, ...extra });

  return {
    home,
    root,
    command,
    run: (args: string[]) => command(args).finished,
    start: () => command(["serve"]),
  };
}

type App = Awaited<ReturnType<typeof app>>;

async function start(h: App) {
  const child = h.start();
  closes.push(async () => {
    await child.stop();
  });
  const line = await child.line(/^notebook ready · /);
  const url = line.split(" · ")[1];

  if (url === undefined || url === "") {
    throw new Error(`missing ready URL: ${line}`);
  }

  return { child, url };
}

async function door(status = 302, location = LOGIN, body = "door") {
  const requests: { method: string; path: string; cookie?: string; authorization?: string }[] = [];

  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }),
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
    });
    response.writeHead(request.url === "/" ? status : 200, {
      location,
      "content-type": "application/json",
    });
    response.end(body);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decode Node's TCP address at the loopback boundary
  if (address === null || typeof address === "string") {
    throw new Error("missing door address");
  }

  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  return { url: `http://127.0.0.1:${address.port}/`, requests };
}

function lines(result: Exit) {
  return result.out.trim().split("\n");
}

function failure(check: string, reason = /.+/) {
  const out: unknown = expect.stringMatching(
    new RegExp(`^fail ${check}: .*(?:${reason.source})`, "im")
  );

  return { code: 1, out };
}

const serving = object({ version: string(), pid: number(), url: optional(string()), at: string() });

async function servingRecord(home: string) {
  const path = join(home, "serving.json");
  const published = Promise.withResolvers<void>();

  const watcher = watch(home, (_event, filename) => {
    if (filename === "serving.json" && existsSync(path)) {
      published.resolve();
    }
  });

  watcher.on("error", published.reject);
  const timeout = AbortSignal.timeout(1000);
  const expired = () => published.reject(new Error("serving.json was not published after ready"));
  timeout.addEventListener("abort", expired, { once: true });

  try {
    if (!existsSync(path)) {
      await published.promise;
    }

    return serving.parse(JSON.parse(await readFile(path, "utf-8")));
  } finally {
    timeout.removeEventListener("abort", expired);
    watcher.close();
  }
}

async function homeContents(home: string, serverLogs = false) {
  const found = await readdir(home, { recursive: true, withFileTypes: true });

  const entries = found.filter(
    (entry) =>
      !serverLogs || relative(home, join(entry.parentPath, entry.name)).split(sep)[0] !== "logs"
  );

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();

  return {
    directories: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted(),
    files: await Promise.all(files.map(async (path) => ({ path, bytes: await readFile(path) }))),
  };
}

test.each([302, 303])(
  "a live home with a matching %s door reports five ordered successes without writing to the home",
  async (status) => {
    const h = await app();
    const live = await start(h);
    const d = await door(status);
    await servingRecord(h.home);
    const before = await homeContents(h.home, true);
    const result = await h.run(["probe", "--expect", VERSION_ONE, "--door", d.url]);
    expect(result.code).toBe(0);
    expect(lines(result)).toHaveLength(5);

    for (const [index, check] of ["serving", "version", "login", "refused", "door"].entries()) {
      expect(lines(result)[index]).toMatch(new RegExp(`^ok ${check}: .+`));
    }

    expect(await homeContents(h.home, true)).toStrictEqual(before);
    expect(await servingRecord(h.home)).toMatchObject({
      version: VERSION_ONE,
      pid: live.child.child.pid,
      url: live.url,
    });
    expect(Number.isNaN(Date.parse((await servingRecord(h.home)).at))).toBe(false);
    expect(d.requests).toStrictEqual([{ method: "GET", path: "/" }]);

    const requests = array(
      object({
        method: string(),
        path: string(),
        host: string(),
        accept: optional(string()),
        cookie: optional(string()),
        authorization: optional(string()),
      })
    ).parse(await (await fetch(new URL("/requests", live.url))).json());

    expect(requests).toStrictEqual([
      {
        method: "GET",
        path: "/api/",
        host: new URL(live.url).host,
        accept: "application/json",
      },
      { method: "GET", path: "/api/", host: HOST, accept: "application/json" },
    ]);
  }
);

test("serve publishes its record before ready and removes it on a clean stop", async () => {
  const h = await app();
  await writeFile(join(h.home, "config.json"), JSON.stringify({ manualReady: true }));
  const child = h.start();
  closes.push(async () => {
    await child.stop();
  });
  const waiting = await child.line(/^fixture waiting · /);
  expect(existsSync(join(h.home, "serving.json"))).toBe(false);
  const url = waiting.split(" · ")[1];

  if (url === undefined || url === "") {
    throw new Error("missing waiting URL");
  }

  await fetch(new URL("/gate", url), { method: "POST" });
  await child.line(/^notebook ready · /);
  expect(
    serving.parse(JSON.parse(await readFile(join(h.home, "serving.json"), "utf-8")))
  ).toMatchObject({
    version: VERSION_ONE,
    pid: child.child.pid,
    url,
  });
  expect((await child.stop()).code).toBe(0);
  expect(existsSync(join(h.home, "serving.json"))).toBe(false);
  expect(await h.run(["probe"])).toMatchObject(failure("serving"));
});

test("a killed server leaves a record but its probe fails serving", async () => {
  const h = await app();
  const live = await start(h);
  const record = await servingRecord(h.home);
  await live.child.stop("SIGKILL");
  expect(JSON.parse(await readFile(join(h.home, "serving.json"), "utf-8"))).toStrictEqual(record);
  expect(await h.run(["probe"])).toMatchObject(failure("serving"));
});

test("a live pid in a record does not replace the home's server lock", async () => {
  const h = await app();
  await writeFile(
    join(h.home, "serving.json"),
    JSON.stringify({ version: VERSION_ONE, pid: process.pid, at: new Date().toISOString() })
  );
  const before = await homeContents(h.home);
  expect(await h.run(["probe"])).toMatchObject(failure("serving"));
  expect(await homeContents(h.home)).toStrictEqual(before);
});

test("a held home without a serving record fails serving", async () => {
  const h = await app();
  await start(h);
  await servingRecord(h.home);
  await rm(join(h.home, "serving.json"));
  expect(await h.run(["probe"])).toMatchObject(failure("serving"));
});

test("a held home whose record names a dead pid fails serving", async () => {
  const h = await app();
  const live = await start(h);
  const record = await servingRecord(h.home);
  await live.child.stop("SIGKILL");
  await rm(join(h.home, "serving.json"));
  const replacement = await start(h);
  await servingRecord(h.home);
  await writeFile(join(h.home, "serving.json"), JSON.stringify(record));
  expect(await h.run(["probe"])).toMatchObject(failure("serving"));
  expect(replacement.child.child.pid).not.toBe(record.pid);
});

test("a different expected build fails version and names both versions", async () => {
  const h = await app();
  await start(h);
  const d = await door();
  const result = await h.run(["probe", "--expect", VERSION_TWO, "--door", d.url]);
  expect(result).toMatchObject(failure("version"));
  expect(result.out).toContain(VERSION_ONE);
  expect(result.out).toContain(VERSION_TWO);
});

test("replacing the installed package under a running server fails version and asks for a restart", async () => {
  const h = await app();
  await start(h);
  const path = join(h.root, "package.json");

  const original = object({
    name: string(),
    version: string(),
    type: string(),
    homepage: string(),
    bin: object({ notebook: string() }),
    files: array(string()),
    scripts: object({ postinstall: string() }),
  }).parse(JSON.parse(await readFile(path, "utf-8")));

  expect(original.version).toBe(VERSION_ONE);
  await writeFile(path, JSON.stringify({ ...original, version: VERSION_TWO }));
  const d = await door();
  const result = await h.run(["probe", "--door", d.url]);
  expect(result).toMatchObject(failure("version", /restart/i));
  expect(result.out).toContain(VERSION_ONE);
  expect(result.out).toContain(VERSION_TWO);
});

test.each(["127.0.0.1", "localhost", "[::1]"])(
  "an OIDC issuer on %s fails login",
  async (hostname) => {
    const provider = await identityProvider();
    closes.push(provider.close);
    const issuer = new URL(provider.issuer);
    issuer.hostname = hostname;
    issuer.protocol = hostname === "[::1]" ? "https:" : issuer.protocol;
    const h = await app();
    await writeFile(
      join(h.home, "web.json"),
      JSON.stringify({
        ...webSettings(),
        oidc: { issuer: issuer.href, clientId: "fixture" },
      })
    );
    await start(h);
    const d = await door();
    expect(await h.run(["probe", "--door", d.url])).toMatchObject(
      failure("login", /loopback|test|local|::1|127\.0\.0\.1/i)
    );
  }
);

test("an unusable web.json fails login instead of claiming there is no web", async () => {
  const h = await app();
  await start(h);
  await writeFile(join(h.home, "web.json"), "{ broken JSON");
  const d = await door();
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("login"));
});

test("a home without web reports no web and skips both network checks", async () => {
  const h = await app();
  await rm(join(h.home, "web.json"));
  await writeFile(join(h.home, "config.json"), JSON.stringify({ withoutUrl: true }));
  const child = h.start();
  closes.push(async () => {
    await child.stop();
  });
  await child.line(/^notebook ready$/);
  const d = await door(200);
  const result = await h.run(["probe", "--door", d.url]);
  expect(result.code).toBe(0);
  expect(lines(result)).toHaveLength(3);
  expect(lines(result)[0]).toMatch(/^ok serving: /);
  expect(lines(result)[1]).toMatch(/^ok version: /);
  expect(lines(result)[2]).toBe("ok login: no web");
  expect(d.requests).toStrictEqual([]);
  expect(await servingRecord(h.home)).not.toHaveProperty("url");
});

test("a host changed after start fails refused with 421", async () => {
  const h = await app();
  await start(h);
  await writeFile(
    join(h.home, "web.json"),
    JSON.stringify({ ...webSettings(), host: "changed.example.test" })
  );
  const d = await door();
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("refused", /421/));
});

test.each([
  { field: "apiStatus", status: 200 },
  { field: "apiStatus", status: 302 },
  { field: "publicApiStatus", status: 200 },
  { field: "publicApiStatus", status: 302 },
])("an unauthenticated $field response of $status fails refused", async ({ field, status }) => {
  const h = await app();
  await writeFile(join(h.home, "config.json"), JSON.stringify({ [field]: status }));
  await start(h);
  const d = await door();
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(
    failure("refused", new RegExp(String(status)))
  );
});

test("a serving URL that is no longer listening fails refused", async () => {
  const h = await app();
  await start(h);
  const record = await servingRecord(h.home);
  const closed = await door();
  await closes.pop()?.();
  await writeFile(join(h.home, "serving.json"), JSON.stringify({ ...record, url: closed.url }));
  const d = await door();
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("refused"));
});

test.each([
  {
    label: "another team",
    status: 302,
    location: `https://other.example/cdn-cgi/access/login/${HOST}?kid=${AUDIENCE}`,
    reason: /team|other\.example/i,
  },
  {
    label: "another audience",
    status: 302,
    location: `${TEAM}/cdn-cgi/access/login/${HOST}?kid=wrong-audience`,
    reason: /audience|kid/i,
  },
  {
    label: "another host",
    status: 302,
    location: `${TEAM}/cdn-cgi/access/login/other.example.test?kid=${AUDIENCE}`,
    reason: /host|other\.example\.test/i,
  },
  {
    label: "a missing audience",
    status: 302,
    location: `${TEAM}/cdn-cgi/access/login/${HOST}`,
    reason: /audience|kid/i,
  },
  { label: "the app's own refusal", status: 401, location: "", reason: /401|proxy|access/i },
  { label: "an unprotected host", status: 200, location: "", reason: /200|protect|login/i },
  { label: "an upstream failure", status: 503, location: "", reason: /503|unreachable/i },
])("a door answering with $label fails door", async ({ status, location, reason }) => {
  const h = await app();
  await start(h);
  const d = await door(status, location, JSON.stringify({ kind: "signed-out" }));
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("door", reason));
  expect(d.requests).toStrictEqual([{ method: "GET", path: "/" }]);
});

test("a closed door fails door without needing an identity", async () => {
  const h = await app();
  await start(h);
  const d = await door();
  await closes.pop()?.();
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("door"));
});

test("door redirects are inspected but never followed", async () => {
  const h = await app();
  await start(h);
  const target = await door(200);
  const d = await door(302, target.url);
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("door"));
  expect(d.requests).toStrictEqual([{ method: "GET", path: "/" }]);
  expect(target.requests).toStrictEqual([]);
});

test.each([
  { status: 401, location: "", message: /^ok door: / },
  {
    status: 302,
    location: LOGIN,
    message: new RegExp(`^ok door: behind ${TEAM}'s login, which web\\.json doesn't verify$`),
  },
])(
  "without access verification a door answering $status can pass",
  async ({ status, location, message }) => {
    const h = await app();
    await writeFile(
      join(h.home, "web.json"),
      JSON.stringify({
        port: 0,
        host: HOST,
        oidc: { issuer: "https://identity.example.test", clientId: "fixture" },
        allow: ["sub:owner"],
      })
    );
    await start(h);
    const d = await door(status, location, JSON.stringify({ kind: "signed-out" }));
    const result = await h.run(["probe", "--door", d.url]);
    expect(result.code).toBe(0);
    expect(lines(result)).toHaveLength(5);
    expect(lines(result)[4]).toMatch(message);
  }
);

test("a web home without a public host skips the door", async () => {
  const h = await app();
  await writeFile(
    join(h.home, "web.json"),
    JSON.stringify({
      port: 0,
      access: { teamDomain: TEAM, audience: AUDIENCE },
      allow: ["sub:owner"],
    })
  );
  await start(h);
  const d = await door(200);
  const result = await h.run(["probe", "--door", d.url]);
  expect(result.code).toBe(0);
  expect(lines(result)).toHaveLength(4);
  expect(lines(result)[3]).toMatch(/^ok refused: /);
  expect(d.requests).toStrictEqual([]);
});

test("a plain-http public host supplies its port to both the local check and default door", async () => {
  const h = await app();
  const d = await door(401, "", JSON.stringify({ kind: "signed-out" }));
  const port = Number(new URL(d.url).port);
  await writeFile(
    join(h.home, "web.json"),
    JSON.stringify({
      port,
      host: "http://127.0.0.1",
      oidc: { issuer: "https://identity.example.test", clientId: "fixture" },
      allow: ["sub:owner"],
    })
  );
  const live = await start(h);
  const result = await h.run(["probe"]);
  expect(result.code).toBe(0);
  expect(lines(result)).toHaveLength(5);
  expect(d.requests).toStrictEqual([{ method: "GET", path: "/" }]);

  const requests = array(object({ host: string() })).parse(
    await (await fetch(new URL("/requests", live.url))).json()
  );

  expect(requests).toStrictEqual([{ host: new URL(live.url).host }, { host: `127.0.0.1:${port}` }]);
});

test("a plain-http port of zero uses the listening port for its public Host and default door", async () => {
  const h = await app();
  await writeFile(
    join(h.home, "web.json"),
    JSON.stringify({
      port: 0,
      host: "http://127.0.0.1",
      oidc: { issuer: "https://identity.example.test", clientId: "fixture" },
      allow: ["sub:owner"],
    })
  );
  await writeFile(join(h.home, "config.json"), JSON.stringify({ doorRefused: true }));
  const live = await start(h);
  const result = await h.run(["probe"]);
  expect(result.code).toBe(0);
  expect(lines(result)).toHaveLength(5);
  expect(lines(result)[4]).toMatch(/^ok door: /);
  const host = new URL(live.url).host;

  const requests = array(object({ host: string() })).parse(
    await (await fetch(new URL("/requests", live.url))).json()
  );

  expect(requests).toStrictEqual([{ host }, { host }]);
});

test.each([
  { bind: "127.0.0.2", address: "127.0.0.2", reported: "127.0.0.1" },
  { bind: "0.0.0.0", address: "127.0.0.1", reported: "127.0.0.2" },
  { bind: "::1", address: "::1", reported: "127.0.0.1" },
  { bind: "::", address: "::1", reported: "127.0.0.1" },
])(
  "refused connects to $address for bind $bind, keeping the recorded Host",
  async ({ bind, address, reported }) => {
    const h = await app();
    await writeFile(join(h.home, "web.json"), JSON.stringify({ ...webSettings(), bind }));
    await writeFile(join(h.home, "config.json"), JSON.stringify({ urlHost: reported }));
    const live = await start(h);
    const d = await door();
    const result = await h.run(["probe", "--door", d.url]);
    expect(result.code).toBe(0);
    expect(lines(result)[3]).toMatch(/^ok refused: /);
    const control = new URL(live.url);
    control.hostname = address.includes(":") ? `[${address}]` : address;
    control.pathname = "/requests";

    const requests = array(object({ host: string(), address: string() })).parse(
      await (await fetch(control)).json()
    );

    expect(requests).toStrictEqual([
      { host: new URL(live.url).host, address },
      { host: HOST, address },
    ]);
  }
);

test.each([
  { field: "apiBody", label: "bare 401", body: "Unauthorized" },
  { field: "publicApiBody", label: "bare 401", body: "Unauthorized" },
  { field: "apiBody", label: "another refusal", body: JSON.stringify({ kind: "basic-auth" }) },
  {
    field: "publicApiBody",
    label: "another refusal",
    body: JSON.stringify({ kind: "basic-auth" }),
  },
])("a $label from $field fails refused even with status 401", async ({ field, body }) => {
  const h = await app();
  await writeFile(join(h.home, "config.json"), JSON.stringify({ [field]: body }));
  await start(h);
  const d = await door();
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("refused"));
});

test.each([
  { label: "bare 401", body: "Unauthorized" },
  { label: "another refusal", body: JSON.stringify({ kind: "basic-auth" }) },
])("without access verification a door's $label fails door", async ({ body }) => {
  const h = await app();
  await writeFile(
    join(h.home, "web.json"),
    JSON.stringify({
      port: 0,
      host: HOST,
      oidc: { issuer: "https://identity.example.test", clientId: "fixture" },
      allow: ["sub:owner"],
    })
  );
  await start(h);
  const d = await door(401, "", body);
  expect(await h.run(["probe", "--door", d.url])).toMatchObject(failure("door"));
});

test("removing web.json under a live web server fails login", async () => {
  const h = await app();
  await start(h);
  expect((await servingRecord(h.home)).url).toBeDefined();
  await rm(join(h.home, "web.json"));
  const d = await door();
  const result = await h.run(["probe", "--door", d.url]);
  expect(result).toMatchObject(failure("login", /web\.json.*gone/i));
  expect(result.out).not.toContain("ok login: no web");
});

test("the next serve removes a killed run's record before its own app is ready", async () => {
  const h = await app();
  const first = await start(h);
  const record = await servingRecord(h.home);
  await first.child.stop("SIGKILL");
  expect(JSON.parse(await readFile(join(h.home, "serving.json"), "utf-8"))).toStrictEqual(record);
  await writeFile(join(h.home, "config.json"), JSON.stringify({ manualReady: true }));
  const child = h.start();
  closes.push(async () => {
    await child.stop();
  });
  const waiting = await child.line(/^fixture waiting · /);
  const url = waiting.split(" · ")[1];

  if (url === undefined || url === "") {
    throw new Error("missing waiting URL");
  }

  try {
    expect(existsSync(join(h.home, "serving.json"))).toBe(false);
    expect(await h.run(["probe"])).toMatchObject(failure("serving"));
  } finally {
    await fetch(new URL("/gate", url), { method: "POST" });
    await child.line(/^notebook ready · /);
  }

  expect(
    serving.parse(JSON.parse(await readFile(join(h.home, "serving.json"), "utf-8")))
  ).toMatchObject({
    pid: child.child.pid,
    version: VERSION_ONE,
  });
});

test("a server starts every time while two probes repeatedly check the home's lock", async () => {
  const h = await app();
  await rm(join(h.home, "web.json"));
  await writeFile(join(h.home, "config.json"), JSON.stringify({ withoutUrl: true }));
  const warm = h.start();
  closes.push(async () => {
    await warm.stop();
  });
  await warm.line(/^notebook ready$/);
  expect((await warm.stop()).code).toBe(0);

  const probes = [
    h.command(["probe"], { NOTEBOOK_PROBE_LOOP: "1" }),
    h.command(["probe"], { NOTEBOOK_PROBE_LOOP: "1" }),
  ];

  for (const probe of probes) {
    closes.push(async () => {
      await probe.stop();
    });
  }

  await Promise.all(probes.map((probe) => probe.line(/^fixture probing$/)));

  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      for (const probe of probes) {
        expect(probe.child.exitCode).toBeNull();
      }

      const child = h.start();
      closes.push(async () => {
        await child.stop();
      });
      await child.line(/^notebook ready$/);
      expect((await child.stop()).code).toBe(0);
    }
  } finally {
    await Promise.all(probes.map((probe) => probe.stop()));
  }

  for (const probe of probes) {
    const checks = probe
      .output()
      .split("\n")
      .filter((line) => /^(ok|fail) serving: /.test(line));

    expect(checks.length).toBeGreaterThan(1);
  }
});

test("probe writes nothing while the server logs its refused requests", async () => {
  const h = await app();
  await writeFile(join(h.home, "config.json"), JSON.stringify({ logRequests: true }));
  const live = await start(h);
  await servingRecord(h.home);
  const before = await homeContents(h.home, true);
  const d = await door();
  const result = await h.run(["probe", "--door", d.url]);
  expect(result.code).toBe(0);
  expect(await homeContents(h.home, true)).toStrictEqual(before);
  await live.child.stop();
  const logs = await readdir(join(h.home, "logs"));

  const text = await Promise.all(
    logs
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(join(h.home, "logs", name), "utf-8"))
  );

  expect(text.join("\n")).toContain("fixture request refused");
});

test.each([
  { args: ["probe", "extra"] },
  { args: ["probe", "--unknown"] },
  { args: ["probe", "--expect"] },
  { args: ["probe", "--door"] },
  { args: ["probe", "--door", "not-a-url"] },
  { args: ["probe", "--door", "file:///tmp/door"] },
])("bad usage $args exits 2 without touching the home", async ({ args }) => {
  const h = await app();
  const before = await homeContents(h.home);
  const result = await h.run(args);
  expect(result.code).toBe(2);
  expect(result.out + result.err).toMatch(/usage/i);
  expect(await homeContents(h.home)).toStrictEqual(before);
});
