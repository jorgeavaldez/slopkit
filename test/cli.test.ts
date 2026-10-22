import { existsSync, watch } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import {
  array,
  literal,
  number,
  object,
  optional,
  record as dictionary,
  scalar,
  string,
} from "../src/schema.ts";
import {
  askUpdate,
  beginUpdate,
  newerEdge,
  recoverUpdate,
  rolledBackTo,
  runCli,
  running,
  settleAskedUpdates,
  UPDATE_KIND,
  updateRecords,
  updating,
} from "../src/server/cli.ts";
import type { UpdateResult } from "../src/server/cli.ts";
import type { Job } from "../src/server/jobs.ts";
import { SyncStore } from "../src/server/store.ts";
import {
  cleanup,
  directory,
  installed,
  installGate,
  launch,
  mirror,
  NAME,
  pack,
  VERSION_MIGRATED,
  VERSION_ONE,
  VERSION_TWO,
} from "./cli-fixture.ts";
import type { Release } from "./cli-fixture.ts";

let releases: Map<string, Release>;
let releaseServer: Awaited<ReturnType<typeof mirror>>;
let first: Release;
let fixtureHome: string;
const homes: string[] = [];
const stores: SyncStore[] = [];

beforeAll(async () => {
  fixtureHome = await directory();
  first = await pack(fixtureHome, VERSION_ONE);
  const second = await pack(fixtureHome, VERSION_TWO);
  const migrated = await pack(fixtureHome, VERSION_MIGRATED, 2);
  const broken = await pack(fixtureHome, "1.2.0", 1, "throw");
  const degraded = await pack(fixtureHome, "1.3.0", 1, "degraded");
  releases = new Map([
    ["v1.0.0", first],
    ["v1.1.0", second],
    ["v2.0.0", migrated],
    ["v1.2.0", broken],
    ["v1.3.0", degraded],
    ["edge", second],
  ]);
  releaseServer = await mirror(releases);
}, 60_000);

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

afterAll(async () => {
  await releaseServer?.close();
  await cleanup();
});

const record = async (home: string, file: string) =>
  dictionary(scalar()).parse(JSON.parse(await readFile(join(home, "releases", file), "utf-8")));

async function notes(home: string) {
  const db = new DatabaseSync(join(home, "notebook.sqlite"), { readOnly: true });

  try {
    return structuredClone(db.prepare("select id,value from notes order by id").all());
  } finally {
    db.close();
  }
}

async function dataset(home: string) {
  const db = new DatabaseSync(join(home, "notebook.sqlite"), { readOnly: true });

  try {
    return db.prepare("select value from meta where key='dataset'").get()?.value;
  } finally {
    db.close();
  }
}

function readyUrl(line: string) {
  const url = line.split(" · ")[1];

  if (url === undefined || url === "") {
    throw new Error(`ready line has no URL: ${line}`);
  }

  return url;
}

async function config(
  home: string,
  value: { proof?: string; manualReady?: boolean; withoutUrl?: boolean; release?: string }
) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "config.json"), JSON.stringify(value));
}

async function logRecords(home: string): Promise<{ body: string }[]> {
  const files = existsSync(join(home, "logs")) ? await readdir(join(home, "logs")) : [];

  const lines = await Promise.all(
    files
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (f) =>
        (await readFile(join(home, "logs", f), "utf-8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => object({ body: string() }).parse(JSON.parse(line)))
      )
  );

  return lines.flat();
}

async function app() {
  return await installed(first, releaseServer.url);
}

test("runCli exports the command runner and checking running never creates a lock file", async () => {
  expect(runCli).toBeTypeOf("function");
  const home = await directory();
  homes.push(home);
  expect(running(home)).toBe(false);
  expect(existsSync(join(home, "owner.sqlite"))).toBe(false);
});

test("version --json reports the installed release and schema, and custom commands get their args/home", async () => {
  const h = await app();
  const version = await h.run(["version", "--json"]);
  expect(version.code).toBe(0);
  expect(JSON.parse(version.out)).toStrictEqual({ version: VERSION_ONE, schema: 1 });
  const plain = await h.run(["version"]);
  expect(plain.code).toBe(0);
  expect(plain.out).toContain(VERSION_ONE);
  const custom = await h.run(["custom", "hello", "two words"]);
  expect(custom.code).toBe(7);
  expect(JSON.parse(await readFile(join(h.home, "custom.json"), "utf-8"))).toStrictEqual([
    "hello",
    "two words",
  ]);
});

test.each([
  { args: ["unknown"] },
  { args: ["update", "not-a-version"] },
  { args: ["update", "1.2.3", "extra"] },
  { args: ["rollback", "--bad"] },
  { args: ["version", "--bad"] },
])("invalid command $args prints usage and exits 2 without starting the app", async ({ args }) => {
  const h = await app();
  const result = await h.run(args);
  expect(result.code).toBe(2);
  expect(result.out + result.err).toMatch(/usage/i);
  expect(existsSync(join(h.home, "notebook.sqlite"))).toBe(false);
});

test("help documents the common and the app's own commands", async () => {
  const h = await app();
  const result = await h.run(["help"]);
  expect(result.code).toBe(0);

  for (const word of ["serve", "update", "rollback", "version", "custom", "fixture notes."]) {
    expect(result.out).toContain(word);
  }
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "%s closes the app, flushes its log and releases the home lock",
  async (signal) => {
    const h = await app();
    const server = h.start();

    try {
      await server.line(/^notebook ready · http:/);
      expect(running(h.home)).toBe(true);
      const result = await server.stop(signal);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(running(h.home)).toBe(false);
      expect((await stat(h.home)).mode % 0o1000).toBe(0o700);
      expect((await logRecords(h.home)).some((r) => r.body === "fixture stopped")).toBe(true);
    } finally {
      await server.stop();
    }
  }
);

test("OS death releases the exclusive lock; a second live serve and installs are refused", async () => {
  const h = await app();
  const one = h.start();

  try {
    await one.line(/^notebook ready/);
    const two = await h.run(["serve"]);
    expect(two.code).toBe(1);
    expect(two.out + two.err).toContain(`Another notebook server runs on ${h.home}`);

    for (const args of [["update"], ["rollback"], ["rollback", "--crashed"]]) {
      const refused = await h.run(args, { MONITOR_SERVICE_RESULT: "exit-code" });
      expect(refused.code).toBe(1);
    }

    await one.stop("SIGKILL");
    expect(running(h.home)).toBe(false);
    const restarted = h.start();

    try {
      await restarted.line(/^notebook ready/);
      expect(running(h.home)).toBe(true);
    } finally {
      expect((await restarted.stop()).code).toBe(0);
    }
  } finally {
    await one.stop();
  }
});

test("ready is withheld until serve resolves; a no-web app has no URL in its ready line", async () => {
  const h = await app();
  await config(h.home, { manualReady: true });
  const child = h.start();

  try {
    const waiting = await child.line(/^fixture waiting · /);
    expect(child.output()).not.toMatch(/^notebook ready/m);
    await fetch(new URL("/gate", readyUrl(waiting)), { method: "POST" });
    await child.line(/^notebook ready · http:/);
  } finally {
    await child.stop();
  }

  await config(h.home, { withoutUrl: true });
  const noWeb = h.start();

  try {
    expect(await noWeb.line(/^notebook ready$/)).toBe("notebook ready");
  } finally {
    await noWeb.stop();
  }
});

test("an unservable web.json is degraded, never ready", async () => {
  const h = await app();
  await mkdir(h.home, { mode: 0o700 });
  await writeFile(join(h.home, "web.json"), "{ broken JSON");
  const child = h.start();

  try {
    const line = await child.line(/^notebook degraded: web off: /);
    expect(line.length).toBeGreaterThan("notebook degraded: web off: ".length);
    expect(child.output()).not.toMatch(/^notebook ready/m);
  } finally {
    await child.stop();
  }
});

test.each(["1.2.0", "1.3.0"])(
  "a release that exits or reports degraded (%s) never replaces the installation",
  async (version) => {
    const h = await app();
    await h.run(["seed", "saved", "original"]);
    const before = await readFile(join(h.home, "notebook.sqlite"));
    const result = await h.run(["update", version]);
    expect(result.code).toBe(1);
    expect((await h.package()).version).toBe(VERSION_ONE);
    expect(await readFile(join(h.home, "notebook.sqlite"))).toStrictEqual(before);
    expect(existsSync(join(h.home, "releases", "installed.json"))).toBe(false);
  }
);

test("checkout update is refused instead of replacing a source tree", async () => {
  const h = await app();
  await writeFile(join(h.root, "tsconfig.build.json"), "{}");
  const offset = releaseServer.requests.length;
  const result = await h.run(["update"]);
  expect(result.code).toBe(1);
  expect(result.out + result.err).toMatch(/checkout|update it there/);
  expect((await h.package()).version).toBe(VERSION_ONE);
  expect(releaseServer.requests.slice(offset)).toStrictEqual([]);
});

test("update boot-checks a consistent WAL copy with copied config and restricted environment before global install", async () => {
  const h = await app();
  const proof = join(h.base, "proof.jsonl");
  await config(h.home, { proof });
  await writeFile(
    join(h.home, "web.json"),
    JSON.stringify({
      bind: "0.0.0.0",
      port: 9876,
      oidc: { issuer: "https://issuer.invalid", clientId: "fixture" },
      allow: ["sub:fixture"],
    })
  );
  const wal = launch(h.bin, ["hold-wal"], h.env);

  try {
    await wal.line(/^fixture WAL kept$/);
    expect(existsSync(join(h.home, "notebook.sqlite-wal"))).toBe(true);
    const offset = releaseServer.requests.length;
    const updated = await h.run(["update", VERSION_TWO]);
    expect(updated.code).toBe(0);
    expect(wal.child.exitCode).toBeNull();
    expect(wal.child.signalCode).toBeNull();
    expect(
      releaseServer.requests
        .slice(offset)
        .filter((r) => r.path === "/v1.1.0/notebook.tgz")
        .map((r) => r.method)
    ).toStrictEqual(["HEAD", "GET"]);

    const checks = (await readFile(proof, "utf-8"))
      .trim()
      .split("\n")
      .map((line) =>
        object({
          version: string(),
          home: string(),
          env: array(string()),
          rows: array(object({ id: string(), value: string() })),
          web: object({ bind: string(), port: number() }),
        }).parse(JSON.parse(line))
      );

    const checked = checks.find((c) => c.version === VERSION_TWO);
    expect(checked).toBeDefined();
    expect(checked?.home).not.toBe(h.home);
    expect(checked?.rows).toStrictEqual([{ id: "wal-only", value: "kept from WAL" }]);
    expect(checked?.env).toStrictEqual(["HOME", "NOTEBOOK_HOME", "PATH"]);
    expect(checked?.web.bind).toBe("127.0.0.1");
    expect(checked?.web.port).toBe(0);
    expect((await h.package()).version).toBe(VERSION_TWO);
    expect(await notes(h.home)).toStrictEqual([{ id: "wal-only", value: "kept from WAL" }]);
    expect(await record(h.home, "previous.json")).toStrictEqual({
      version: VERSION_ONE,
      schema: 1,
    });
    expect(await record(h.home, "current.json")).toStrictEqual({ version: VERSION_TWO, schema: 1 });

    for (const file of ["previous.tgz", "current.tgz"]) {
      expect((await stat(join(h.home, "releases", file))).size).toBeGreaterThan(0);
    }

    expect(await record(h.home, "installed.json")).toMatchObject({
      version: VERSION_TWO,
      via: "update",
    });
    expect((await record(h.home, "installed.json")).at).toBeTypeOf("string");
  } finally {
    const stopped = await wal.stop();
    expect(stopped.code).toBe(0);
    expect(stopped.signal).toBeNull();
  }
});

test("default update uses edge; an explicit non-crash install clears a stale rolled-back record", async () => {
  const h = await app();
  await mkdir(join(h.home, "releases"), { recursive: true });
  await writeFile(
    join(h.home, "releases", "rolled-back.json"),
    JSON.stringify({ from: "old", to: VERSION_ONE, at: "2026-10-22T00:00:00Z" })
  );
  const offset = releaseServer.requests.length;
  expect((await h.run(["update"])).code).toBe(0);
  expect(
    releaseServer.requests
      .slice(offset)
      .some((r) => r.path === "/edge/notebook.tgz" && r.method === "GET")
  ).toBe(true);
  expect(existsSync(join(h.home, "releases", "rolled-back.json"))).toBe(false);
});

test("a same-schema rollback swaps kept releases and records rollback", async () => {
  const h = await app();
  expect((await h.run(["update", VERSION_TWO])).code).toBe(0);
  const result = await h.run(["rollback"]);
  expect(result.code).toBe(0);
  expect((await h.package()).version).toBe(VERSION_ONE);
  expect(await record(h.home, "current.json")).toStrictEqual({ version: VERSION_ONE, schema: 1 });
  expect(await record(h.home, "previous.json")).toStrictEqual({ version: VERSION_TWO, schema: 1 });
  expect(await record(h.home, "installed.json")).toMatchObject({
    version: VERSION_ONE,
    via: "rollback",
  });
  expect(existsSync(join(h.home, "releases", "rolled-back.json"))).toBe(false);
});

test("rollback crossing a migration refuses without --with-store, then restores the named backup under a new dataset", async () => {
  const h = await app();
  expect((await h.run(["seed", "before", "original"])).code).toBe(0);
  const originalDataset = await dataset(h.home);
  expect((await h.run(["update", VERSION_MIGRATED])).code).toBe(0);
  const server = h.start();

  try {
    await server.line(/^notebook ready/);
  } finally {
    await server.stop();
  }

  expect((await h.run(["seed", "after", "after migration"])).code).toBe(0);
  const refused = await h.run(["rollback"]);
  expect(refused.code).toBe(1);
  expect(refused.out + refused.err).toContain("notebook.sqlite.schema-1.bak");
  expect((await h.package()).version).toBe(VERSION_MIGRATED);
  expect((await h.run(["rollback", "--with-store"])).code).toBe(0);
  expect((await h.package()).version).toBe(VERSION_ONE);
  expect(await notes(h.home)).toStrictEqual([{ id: "before", value: "original" }]);
  expect(await dataset(h.home)).not.toBe(originalDataset);
  expect(existsSync(join(h.home, "notebook.sqlite.schema-1.bak"))).toBe(false);

  const kept = (await readdir(h.home)).filter((file) =>
    file.startsWith("notebook.sqlite.rolled-back-")
  );

  expect(kept).toHaveLength(1);
  const old = new DatabaseSync(join(h.home, kept[0] ?? "missing"), { readOnly: true });

  try {
    expect(
      structuredClone(old.prepare("select id,value from notes order by id").all())
    ).toStrictEqual([
      { id: "after", value: "after migration" },
      { id: "before", value: "original" },
    ]);
  } finally {
    old.close();
  }
});

test("a restore used by --with-store is undone if installation fails", async () => {
  const h = await app();
  await h.run(["seed", "before", "original"]);
  await h.run(["update", VERSION_MIGRATED]);
  const server = h.start();

  try {
    await server.line(/^notebook ready/);
  } finally {
    await server.stop();
  }

  await h.run(["seed", "after", "current"]);
  const before = await readFile(join(h.home, "notebook.sqlite"));
  const backup = await readFile(join(h.home, "notebook.sqlite.schema-1.bak"));

  const blocked = [
    h.prefix,
    join(h.prefix, "lib"),
    join(h.prefix, "lib", "node_modules"),
    join(h.prefix, "bin"),
  ];

  try {
    for (const path of blocked) {
      await chmod(path, 0o500);
    }

    const result = await h.run(["rollback", "--with-store"]);
    expect(result.code).toBe(1);
    expect(await readFile(join(h.home, "notebook.sqlite"))).toStrictEqual(before);
    expect(await readFile(join(h.home, "notebook.sqlite.schema-1.bak"))).toStrictEqual(backup);
  } finally {
    for (const path of blocked) {
      await chmod(path, 0o755);
    }
  }
});

test.each([undefined, "success", "timeout", "resources", "start-limit-hit"])(
  "crash rollback declines non-crash result %s with one decision line in stdout and log",
  async (monitor) => {
    const h = await app();
    await h.run(["update", VERSION_TWO]);
    const before = (await logRecords(h.home)).length;
    const result = await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: monitor });
    expect(result.code).toBe(3);
    expect(result.out.trim().split("\n")).toHaveLength(1);
    expect((await logRecords(h.home)).length - before).toBe(1);
    expect((await h.package()).version).toBe(VERSION_TWO);
  }
);

test("crash rollback declines missing previous metadata, non-update installs, proven versions and repeated targets", async () => {
  const h = await app();
  const crash = { MONITOR_SERVICE_RESULT: "exit-code" };
  expect((await h.run(["rollback", "--crashed"], crash)).code).toBe(3);
  await h.run(["update", VERSION_TWO]);
  const installedRecord = await record(h.home, "installed.json");
  await writeFile(
    join(h.home, "releases", "installed.json"),
    JSON.stringify({ version: VERSION_TWO, via: "rollback", at: "2026-10-22T00:00:00Z" })
  );
  expect((await h.run(["rollback", "--crashed"], crash)).code).toBe(3);
  await writeFile(join(h.home, "releases", "installed.json"), JSON.stringify(installedRecord));
  await writeFile(
    join(h.home, "releases", "proven.json"),
    JSON.stringify({ version: VERSION_TWO, at: "2026-10-22T00:00:00Z" })
  );
  expect((await h.run(["rollback", "--crashed"], crash)).code).toBe(3);
  await writeFile(
    join(h.home, "releases", "proven.json"),
    JSON.stringify({ version: "different", at: "2026-10-22T00:00:00Z" })
  );
  expect((await h.run(["rollback", "--crashed"], crash)).code).toBe(0);
  // Keep the real crash record and make the other eligibility checks pass, isolating the target guard.
  await writeFile(
    join(h.home, "releases", "installed.json"),
    JSON.stringify({ version: VERSION_ONE, via: "update", at: "2026-10-22T00:00:00Z" })
  );
  expect((await h.run(["rollback", "--crashed"], crash)).code).toBe(3);
});

test.each(["exit-code", "signal", "core-dump", "watchdog"])(
  "an unproven update with crash result %s rolls back once and records what it replaced",
  async (monitor) => {
    const h = await app();
    await h.run(["update", VERSION_TWO]);
    const result = await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: monitor });
    expect(result.code).toBe(0);
    expect(result.out.trim().split("\n")).toHaveLength(1);
    expect((await h.package()).version).toBe(VERSION_ONE);
    expect(await record(h.home, "installed.json")).toMatchObject({
      version: VERSION_ONE,
      via: "crashed",
    });
    expect(await record(h.home, "rolled-back.json")).toMatchObject({
      from: VERSION_TWO,
      to: VERSION_ONE,
    });
    expect(rolledBackTo(h.home, VERSION_ONE)).toMatchObject({ from: VERSION_TWO });
    expect(rolledBackTo(h.home, VERSION_ONE)?.at).toBeTypeOf("string");
    expect((await record(h.home, "rolled-back.json")).at).toBeTypeOf("string");
    expect(rolledBackTo(h.home, VERSION_TWO)).toBeNull();
    expect((await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: monitor })).code).toBe(
      3
    );
  }
);

test("failure during a crash rollback removes its provisional rolled-back record", async () => {
  const h = await app();
  await h.run(["update", VERSION_TWO]);
  const blocked = [h.prefix, join(h.prefix, "lib", "node_modules"), join(h.prefix, "bin")];

  try {
    for (const path of blocked) {
      await chmod(path, 0o500);
    }

    expect(
      (await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: "exit-code" })).code
    ).toBe(1);
    expect(existsSync(join(h.home, "releases", "rolled-back.json"))).toBe(false);
  } finally {
    for (const path of blocked) {
      await chmod(path, 0o755);
    }
  }
});

function jobStore(path: string) {
  const store = new SyncStore(path, {
    name: NAME,
    schema: { base: "", replicated: [], baseVersion: 1, migrations: [], indexes: "" },
  });

  stores.push(store);

  return store.createJobs<UpdateResult>({
    encode: JSON.stringify,
    decode: (text) =>
      object({ release: optional(string()), from: optional(string()) }).parse(JSON.parse(text)),
  });
}

test("update jobs join, claim durably, finish in history and never overwrite an earlier requester", async () => {
  const home = await directory();
  const path = join(home, "jobs.sqlite");
  const jobs = jobStore(path);
  expect(UPDATE_KIND).toBe("update");
  expect(updating(jobs)).toBeNull();
  const by = { client: "page_0001", id: 1 };
  const one = askUpdate(jobs, "edge", VERSION_ONE, by, 0);
  const joined = askUpdate(jobs, "edge", VERSION_ONE, { client: "page_0002", id: 2 }, 0);
  expect(joined.id).toBe(one.id);
  expect(one.due).toBe(true);
  expect(updating(jobs)).toBe(one.id);
  const claimed = beginUpdate(jobs, VERSION_ONE);
  expect(claimed).toStrictEqual({ id: one.id, release: "edge", from: VERSION_ONE });
  const observer = new DatabaseSync(path, { readOnly: true });

  try {
    expect(
      structuredClone(observer.prepare("select kind,key,state from jobs").all())
    ).toStrictEqual([{ kind: "update", key: "install", state: "running" }]);
  } finally {
    observer.close();
  }

  const during = askUpdate(jobs, "edge", VERSION_ONE, { client: "page_0003", id: 3 }, 0);
  expect(during).toStrictEqual({ id: one.id, due: false });
  expect(beginUpdate(jobs, VERSION_ONE)).toBeUndefined();
  expect(jobs.get(one.id)?.by).toStrictEqual([
    by,
    { client: "page_0002", id: 2 },
    { client: "page_0003", id: 3 },
  ]);
  jobs.finish(one.id, { done: { release: "edge", from: VERSION_ONE } });
  expect(updating(jobs)).toBeNull();
  expect(updateRecords(jobs, 10)[0]?.at).toBeTypeOf("string");
  expect(updateRecords(jobs, 10)).toMatchObject([
    {
      job: one.id,
      release: "edge",
      from: VERSION_ONE,
      result: "installed",
      reason: null,
    },
  ]);
});

test("recovery reconciles a changed version, fails an interrupted install, and settles due jobs that never started", async () => {
  const home = await directory();
  const jobs = jobStore(join(home, "jobs.sqlite"));
  const asked = askUpdate(jobs, "edge", VERSION_ONE, { client: "page_0001", id: 1 }, 0);
  beginUpdate(jobs, VERSION_ONE);
  const runningJob = jobs.get(asked.id);

  if (!runningJob) {
    throw new Error("fixture job missing");
  }

  expect(settleAskedUpdates(jobs)).toBe(0);
  expect(jobs.get(asked.id)?.state).toBe("running");
  expect(recoverUpdate(runningJob, VERSION_TWO)).toStrictEqual({
    done: { release: "edge", from: VERSION_ONE },
  });

  const failed = object({ failed: object({ who: literal("us"), reason: string() }) }).parse(
    recoverUpdate(runningJob, VERSION_ONE)
  );

  expect(failed.failed.reason).toMatch(/interrupted/i);
  jobs.interrupt((job: Job<UpdateResult>) => recoverUpdate(job, VERSION_TWO));
  const due = askUpdate(jobs, "1.2.0", VERSION_TWO, { client: "page_0001", id: 1 }, 0);
  expect(settleAskedUpdates(jobs)).toBe(1);
  expect(jobs.get(due.id)).toMatchObject({
    state: "failed",
    who: "us",
  });
  expect(jobs.get(due.id)?.reason).toMatch(/nothing changed/i);
  expect(settleAskedUpdates(jobs)).toBe(0);
  expect(updateRecords(jobs, 1)).toMatchObject([
    { job: due.id, release: "1.2.0", from: VERSION_TWO, result: "failed" },
  ]);
});

test("a page's update is claimed before closing, installed after stop and the same command starts again", async () => {
  const h = await app();
  await config(h.home, { release: VERSION_TWO });
  const server = h.start();

  try {
    const url = readyUrl(await server.line(/^notebook ready · /));
    const response = await fetch(new URL("/update", url), { method: "POST" });
    expect(response.status).toBe(200);
    // A second ready line is evidence of the installed command re-entering serve; the fixture also records its version.
    await server.line(/^fixture serving 1\.1\.0 · /);
    // A supervisor fallback may use a child; inspect the durable install/job rather than require a particular PID.
    expect(await record(h.home, "installed.json")).toMatchObject({
      version: VERSION_TWO,
      via: "update",
    });
    expect((await record(h.home, "installed.json")).at).toBeTypeOf("string");

    const events = (await readFile(join(h.home, "events.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) =>
        object({ event: string(), state: optional(string()) }).parse(JSON.parse(line))
      );

    expect(events.slice(0, 2)).toMatchObject([
      { event: "claim", state: "running" },
      { event: "close", state: "running" },
    ]);
    const db = new DatabaseSync(join(h.home, "notebook.sqlite"), { readOnly: true });

    try {
      expect(
        structuredClone(db.prepare("select state,result from jobs where kind='update'").all())
      ).toStrictEqual([
        { state: "done", result: JSON.stringify({ release: VERSION_TWO, from: VERSION_ONE }) },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
  }
});

test("newerEdge is only a hint and leaves stable releases untouched", async () => {
  const h = await app();
  const before = await h.package();
  expect(await newerEdge(new URL(`file://${h.root}/`), h.env)).toBeUndefined();
  expect(await h.package()).toStrictEqual(before);
});

test("a server that stays up for provenAfterMs proves its own version and prevents crash rollback", async () => {
  const h = await app();
  expect((await h.run(["update", VERSION_TWO])).code).toBe(0);
  const provenFile = join(h.home, "releases", "proven.json");
  let watcher: ReturnType<typeof watch> | undefined;

  const proven = new Promise<void>((resolve, reject) => {
    watcher = watch(join(h.home, "releases"), (_event, filename) => {
      if (String(filename) === "proven.json" && existsSync(provenFile)) {
        resolve();
      }
    });
    watcher.on("error", reject);
  });

  const server = h.start({ NOTEBOOK_PROVEN_MS: "5" });

  try {
    await server.line(/^notebook ready/);
    await proven;
    expect(await record(h.home, "proven.json")).toMatchObject({ version: VERSION_TWO });
    expect((await record(h.home, "proven.json")).at).toBeTypeOf("string");
  } finally {
    watcher?.close();
    await server.stop();
  }

  expect(
    (await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: "exit-code" })).code
  ).toBe(3);
});

test("without NAME_HOME the app uses only the isolated HOME's dot-directory", async () => {
  const h = await app();
  const defaultHome = join(h.user, ".notebook");
  const server = h.start({ NOTEBOOK_HOME: undefined });

  try {
    await server.line(/^notebook ready/);
    expect(existsSync(join(defaultHome, "notebook.sqlite"))).toBe(true);
    expect((await stat(defaultHome)).mode % 0o1000).toBe(0o700);
    expect(existsSync(h.home)).toBe(false);
  } finally {
    await server.stop();
  }
});

test("a missing release is refused at HEAD without downloading or touching the installed package", async () => {
  const h = await app();
  const offset = releaseServer.requests.length;
  const result = await h.run(["update", "9.9.9"]);
  expect(result.code).toBe(1);
  expect((await h.package()).version).toBe(VERSION_ONE);
  expect(releaseServer.requests.slice(offset)).toStrictEqual([
    { method: "HEAD", path: "/v9.9.9/notebook.tgz" },
  ]);
});

test("an otherwise eligible crash rollback declines when the supervisor result is absent", async () => {
  const h = await app();
  expect((await h.run(["update", VERSION_TWO])).code).toBe(0);
  const result = await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: undefined });
  expect(result.code).toBe(3);
  expect((await h.package()).version).toBe(VERSION_TWO);
  expect(existsSync(join(h.home, "releases", "rolled-back.json"))).toBe(false);
});

test("a hand install cannot be blamed for a crash even with a previous release kept", async () => {
  const h = await app();
  expect((await h.run(["update", VERSION_TWO])).code).toBe(0);
  await rm(join(h.home, "releases", "installed.json"));
  const result = await h.run(["rollback", "--crashed"], { MONITOR_SERVICE_RESULT: "exit-code" });
  expect(result.code).toBe(3);
  expect((await h.package()).version).toBe(VERSION_TWO);
  expect(existsSync(join(h.home, "releases", "rolled-back.json"))).toBe(false);
});

test("an update cannot replace a release when its rollback copy cannot be kept", async () => {
  const h = await app();
  await mkdir(h.home, { mode: 0o700 });
  await writeFile(join(h.home, "releases"), "a regular file, not a release directory");
  const result = await h.run(["update", VERSION_TWO]);
  expect(result.code).toBe(1);
  expect((await h.package()).version).toBe(VERSION_ONE);
  expect(await readFile(join(h.home, "releases"), "utf-8")).toBe(
    "a regular file, not a release directory"
  );
});

function finishedBeforeReady(child: ReturnType<typeof launch>) {
  return new Promise<Awaited<typeof child.finished>>((resolve, reject) => {
    child.child.stdout.on("data", () => {
      if (/^notebook ready/m.test(child.output())) {
        reject(new Error("a server became ready while a release was being replaced"));
      }
    });
    void child.finished.then(resolve, reject);
  });
}

test.each([
  {
    label: "update",
    args: ["update", VERSION_TWO],
    prepare: false,
    target: VERSION_TWO,
    monitor: undefined,
  },
  { label: "rollback", args: ["rollback"], prepare: true, target: VERSION_ONE, monitor: undefined },
  {
    label: "crash rollback",
    args: ["rollback", "--crashed"],
    prepare: true,
    target: VERSION_ONE,
    monitor: "exit-code",
  },
])(
  "$label excludes a competing serve throughout the real global installation",
  async ({ args, prepare, target, monitor }) => {
    const h = await app();

    if (prepare && (await h.run(["update", VERSION_TWO])).code !== 0) {
      throw new Error("fixture could not prepare a release to roll back");
    }

    const gate = await installGate();

    const replacing = launch(h.bin, args, {
      ...h.env,
      MONITOR_SERVICE_RESULT: monitor,
      NOTEBOOK_BLOCK_PREFIX: h.prefix,
      NOTEBOOK_INSTALL_BARRIER: gate.url,
      // Local tarball identities are generated paths; only this dependency-free fixture is installed here.
      npm_config_dangerously_allow_all_scripts: "true",
    });

    let challenger: ReturnType<typeof launch> | undefined;
    let installCode: number | null | undefined;

    try {
      const entered = await Promise.race([
        gate.entered,
        replacing.finished.then((result) => {
          throw new Error(
            `installer exited before its global replacement barrier: ${result.code}\n${result.out}\n${result.err}`
          );
        }),
      ]);

      expect(entered).toStrictEqual({ version: target, prefix: h.prefix });
      challenger = h.start();
      const refusal = await finishedBeforeReady(challenger);
      expect(refusal.code).toBe(1);
      expect(refusal.out + refusal.err).toContain(`Another notebook server runs on ${h.home}`);
    } finally {
      await challenger?.stop();
      gate.release();

      try {
        installCode = (await replacing.finished).code;
      } finally {
        await gate.close();
      }
    }

    expect(installCode).toBe(0);
    expect((await h.package()).version).toBe(target);
  }
);
