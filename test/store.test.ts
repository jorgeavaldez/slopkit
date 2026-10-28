import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, test } from "vitest";

import { CORE_TABLES, schemaVersion, SyncStore } from "../src/server/store.ts";
import { outcome, SCHEMA } from "./sync-fixture.ts";

const homes: string[] = [];
const stores: SyncStore[] = [];

const path = () => {
  const home = mkdtempSync(join(tmpdir(), "slopkit-store-"));
  homes.push(home);

  return join(home, "store.sqlite");
};

const open = (file: string, schema = SCHEMA) => {
  const store = new SyncStore(file, { name: "notes", schema });
  stores.push(store);

  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* A test already closed it to reopen. */
    }
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("new store has immutable core schema, initial metadata and durable SQLite settings, reopened", () => {
  const file = path();
  const store = open(file);
  expect(schemaVersion(SCHEMA)).toBe(1);
  expect(schemaVersion({ ...SCHEMA, baseVersion: 4, migrations: ["select 1", "select 2"] })).toBe(
    6
  );
  expect(CORE_TABLES).toBeTypeOf("string");
  expect(store.path).toBe(file);
  expect(store.revision()).toBe(1);
  expect(store.meta("history_floor")).toBe("1");
  expect(store.dataset()).toMatch(/^[0-9a-f]{24}$/);
  expect(structuredClone(store.db.prepare("pragma journal_mode").get())).toStrictEqual({
    journal_mode: "wal",
  });
  expect(structuredClone(store.db.prepare("pragma synchronous").get())).toStrictEqual({
    synchronous: 2,
  });
  expect(structuredClone(store.db.prepare("pragma foreign_keys").get())).toStrictEqual({
    foreign_keys: 1,
  });
  expect(
    store.db
      .prepare(
        "select name from sqlite_master where type='table' and name in ('meta','revisions','commands','jobs') order by name"
      )
      .all()
      .map((r: Record<string, SQLOutputValue>) => r.name)
  ).toStrictEqual(["commands", "jobs", "meta", "revisions"]);
  store.setMeta("fixture", "kept");
  const dataset = store.dataset();
  store.close();
  const reopened = open(file);
  expect(reopened.dataset()).toBe(dataset);
  expect(reopened.meta("fixture")).toBe("kept");
  expect(reopened.restored).toBeUndefined();
  expect(reopened.iso(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(Math.abs(reopened.now() - Date.now())).toBeLessThan(1000);
});

test.each([7, 0, 1])(
  "unsupported schema %i is refused without modifying the database",
  (version) => {
    const file = path();
    const db = new DatabaseSync(file);
    db.exec(
      `create table valuable(value text); insert into valuable values ('kept'); pragma user_version=${version}`
    );
    db.close();
    const before = readFileSync(file);
    const modified = statSync(file).mtimeMs;
    expect(() => open(file, { ...SCHEMA, baseVersion: 2 })).toThrow(
      version > 2
        ? "The store is from a newer version (schema 7); update notes"
        : `The store is at schema ${version}, from before 2, the schema this release starts from: it can't be opened`
    );
    expect(readFileSync(file)).toStrictEqual(before);
    expect(statSync(file).mtimeMs).toBe(modified);
    expect(existsSync(`${file}.schema-${version}.bak`)).toBe(false);
  }
);

test("new base is atomic even when its SQL fails", () => {
  const file = path();
  expect(() =>
    open(file, { ...SCHEMA, base: "create table half(id integer); this is not SQL;" })
  ).toThrow(Error);
  const db = new DatabaseSync(file);
  expect(structuredClone(db.prepare("pragma user_version").get())).toStrictEqual({
    user_version: 0,
  });
  expect(
    structuredClone(db.prepare("select name from sqlite_master where type='table'").all())
  ).toStrictEqual([]);
  db.close();
});

test("migration backs up whole data once, advances one version per transaction and rebuilds indexes", () => {
  const file = path();
  let store = open(file);
  store.setMeta("precious", "original");
  store.close();
  store = open(file, {
    ...SCHEMA,
    migrations: ["create table added(id integer);", "alter table added add column title text;"],
  });
  expect(structuredClone(store.db.prepare("pragma user_version").get())).toStrictEqual({
    user_version: 3,
  });
  const backup = `${file}.schema-1.bak`;
  expect(existsSync(backup)).toBe(true);
  const saved = readFileSync(backup);
  const old = new DatabaseSync(backup, { readOnly: true });
  expect(structuredClone(old.prepare("pragma user_version").get())).toStrictEqual({
    user_version: 1,
  });
  expect(
    structuredClone(old.prepare("select value from meta where key='precious'").get())
  ).toStrictEqual({
    value: "original",
  });
  old.close();
  store.db.exec("drop index history_order");
  store.close();
  store = open(file, {
    ...SCHEMA,
    migrations: ["create table added(id integer);", "alter table added add column title text;"],
  });
  expect(readFileSync(backup)).toStrictEqual(saved);
  expect(
    structuredClone(
      store.db
        .prepare("select name from sqlite_master where type='index' and name='history_order'")
        .get()
    )
  ).toStrictEqual({ name: "history_order" });
});

test("an existing backup is never overwritten", () => {
  const file = path();
  const store = open(file);
  store.close();
  writeFileSync(`${file}.schema-1.bak`, "oldest-copy");
  const migrated = open(file, { ...SCHEMA, migrations: ["create table added(id integer);"] });
  expect(structuredClone(migrated.db.prepare("pragma user_version").get())).toStrictEqual({
    user_version: 2,
  });
  expect(readFileSync(`${file}.schema-1.bak`, "utf-8")).toBe("oldest-copy");
});

test("failing later migration rolls itself back but keeps prior migration committed", () => {
  const file = path();
  open(file).close();
  expect(() =>
    open(file, {
      ...SCHEMA,
      migrations: [
        "create table first(id integer);",
        "create table half(id integer); insert into absent values(1);",
      ],
    })
  ).toThrow(Error);
  const db = new DatabaseSync(file);
  expect(structuredClone(db.prepare("pragma user_version").get())).toStrictEqual({
    user_version: 2,
  });
  expect(
    structuredClone(
      db
        .prepare("select name from sqlite_master where name in ('first','half') order by name")
        .all()
    )
  ).toStrictEqual([{ name: "first" }]);
  db.close();
});

test("foreign key check fails the migration even if it disabled immediate checks", () => {
  const file = path();
  open(file).close();
  expect(() =>
    open(file, {
      ...SCHEMA,
      migrations: [
        "create table parent(id integer primary key); create table child(id integer references parent(id)); insert into child values(77);",
      ],
    })
  ).toThrow(Error);
  const db = new DatabaseSync(file);
  expect(structuredClone(db.prepare("pragma user_version").get())).toStrictEqual({
    user_version: 1,
  });
  expect(
    structuredClone(db.prepare("select name from sqlite_master where name='child'").all())
  ).toStrictEqual([]);
  db.close();
});

test("stamp requires a transaction; commits strictly advance, log and clear stamping", () => {
  const store = open(path());
  expect(() => store.stamp()).toThrow(Error);
  const before = Date.now() * 1000;
  const first = store.transaction(() => store.stamp());
  expect(first).toBeGreaterThanOrEqual(before);
  expect(first).toBeLessThan((Date.now() + 1) * 1000 + 1000);
  const second = store.transaction(() => store.stamp());
  expect(second).toBeGreaterThan(first);
  expect(store.known(first)).toBe(true);
  expect(store.known(second)).toBe(true);
  expect(store.known(second + 1)).toBe(false);
  expect(store.known(0)).toBe(true);
  expect(store.meta("stamping")).toBeUndefined();
  expect(() =>
    store.db.prepare("insert into history values ('unowned',1,0,?)").run(second)
  ).toThrow(Error);
  store.setMeta("revision", String(Number.MAX_SAFE_INTEGER));
  expect(() => store.transaction(() => store.stamp())).toThrow(Error);
  expect(store.revision()).toBe(Number.MAX_SAFE_INTEGER);
});

test("stamp is max(head+1, wallclock microseconds plus submillisecond entropy)", () => {
  const store = open(path());
  const future = Date.now() * 1000 + 1_000_000_000;
  store.setMeta("revision", String(future));
  expect(store.transaction(() => store.stamp())).toBe(future + 1);
});

test("nested transactions join the outer one; failed outer rolls every row and stamp back", () => {
  const store = open(path());
  const initial = store.revision();
  expect(() =>
    store.transaction(() => {
      const revision = store.stamp();
      store.transaction(() =>
        store.db.prepare("insert into history values ('a',1,0,?)").run(revision)
      );
      throw new Error("rollback");
    })
  ).toThrow("rollback");
  expect(store.revision()).toBe(initial);
  expect(structuredClone(store.db.prepare("select * from history").all())).toStrictEqual([]);
  store.transaction(() => {
    const revision = store.stamp();
    store.transaction(() =>
      store.db.prepare("insert into history values ('a',1,0,?)").run(revision)
    );
  });
  expect(structuredClone(store.db.prepare("select id from history").all())).toStrictEqual([
    { id: "a" },
  ]);
});

test("replicated insert/update must carry this transaction's stamp; even a stamped delete aborts", () => {
  const store = open(path());

  for (const table of ["history", "settings"]) {
    expect(() => store.db.exec(`insert into ${table} values ('a',1,0,1)`)).toThrow(Error);
    store.transaction(() => {
      const r = store.stamp();
      expect(() =>
        store.db.prepare(`insert into ${table} values ('bad',1,0,?)`).run(r - 1)
      ).toThrow(Error);
      store.db.prepare(`insert into ${table} values ('a',1,0,?)`).run(r);
    });
    expect(() => store.db.exec(`update ${table} set value=2 where id='a'`)).toThrow(Error);
    store.transaction(() => {
      const r = store.stamp();
      store.db.prepare(`update ${table} set value=2,deleted=1,revision=? where id='a'`).run(r);
      expect(() => store.db.exec(`delete from ${table}`)).toThrow(Error);
    });
    expect(
      structuredClone(store.db.prepare(`select value,deleted from ${table}`).all())
    ).toStrictEqual([{ value: 2, deleted: 1 }]);
  }
});

const ROWS =
  "(id text primary key, value integer not null, deleted integer not null default 0, revision integer not null) strict";

/** How a write ends: "done", or which trigger refused it. */
function ending(write: () => void) {
  try {
    write();

    return "done";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return message.includes("stamped in its own transaction")
      ? "not stamped"
      : message.includes("never deleted")
        ? "never deleted"
        : message;
  }
}

/** How each kind of write to `table` ends. */
function writes(store: SyncStore, table: string) {
  return {
    unstamped: ending(() => store.db.exec(`insert into ${table} values ('a',1,0,1)`)),
    stamped: ending(() =>
      store.transaction(() => {
        store.db.prepare(`insert into ${table} values ('a',1,0,?)`).run(store.stamp());
      })
    ),
    update: ending(() => store.db.exec(`update ${table} set value=2 where id='a'`)),
    delete: ending(() => store.db.exec(`delete from ${table}`)),
  };
}

/** What the stamping triggers hold a replicated table to: only stamped writes, and no delete. */
const STAMPED = {
  unstamped: "not stamped",
  stamped: "done",
  update: "not stamped",
  delete: "never deleted",
};

test("a replicated table a migration adds is stamped, on a new store and on one migrating to it", () => {
  const added = {
    ...SCHEMA,
    replicated: [...SCHEMA.replicated, "added"],
    migrations: [`create table added${ROWS};`],
  };

  expect(writes(open(path(), added), "added")).toStrictEqual(STAMPED);

  const file = path();
  open(file).close();
  expect(writes(open(file, added), "added")).toStrictEqual(STAMPED);
});

test("a migration that rebuilds a replicated table leaves it stamped", () => {
  const file = path();
  open(file).close();

  const store = open(file, {
    ...SCHEMA,
    migrations: [
      `create table history_new${ROWS};
       insert into history_new select * from history;
       drop table history;
       alter table history_new rename to history;`,
    ],
  });

  expect(writes(store, "history")).toStrictEqual(STAMPED);
});

test("a table that takes a replicated table's name after it's renamed away is stamped, and so is the renamed one", () => {
  const file = path();
  open(file).close();

  const schema = {
    ...SCHEMA,
    replicated: [...SCHEMA.replicated, "archived"],
    migrations: [`alter table history rename to archived; create table history${ROWS};`],
  };

  const store = open(file, schema);
  expect(writes(store, "history")).toStrictEqual(STAMPED);
  expect(writes(store, "archived")).toStrictEqual(STAMPED);
  store.close();
  expect(writes(open(file, schema), "history")).toMatchObject({
    unstamped: "not stamped",
    delete: "never deleted",
  });
});

test("opening a stamped store doesn't wait on another connection's write", () => {
  const file = path();
  open(file).close();
  const writer = new DatabaseSync(file);

  try {
    writer.exec("begin immediate");
    expect(open(file).revision()).toBe(1);
  } finally {
    writer.exec("rollback");
    writer.close();
  }
});

test("a replicated table the schema never makes is refused at open, naming it", () => {
  const missing = {
    ...SCHEMA,
    replicated: [...SCHEMA.replicated, "missing"],
    migrations: ["select 1"],
  };

  expect(() => open(path(), missing)).toThrow(/missing/);

  const file = path();
  open(file).close();
  expect(() => open(file, missing)).toThrow(/missing/);
});

test("known includes the floor, head and logged revisions but not lost holes above the floor", () => {
  const store = open(path());
  const r = store.transaction(() => store.stamp());
  store.setMeta("history_floor", "100");
  expect([0, 1, 99, 100, r].map((n) => store.known(n))).toStrictEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(store.known(101)).toBe(false);
});

test("served head moves forward only and reopening a restored file changes its dataset", () => {
  const file = path();
  let store = open(file);
  const dataset = store.dataset();
  store.db.exec("pragma wal_checkpoint(truncate)");
  const backup = `${file}.copy`;
  copyFileSync(file, backup);
  const seen = store.transaction(() => store.stamp());
  store.served(seen);
  expect(JSON.parse(readFileSync(`${file}.head`, "utf-8"))).toStrictEqual({
    dataset,
    revision: seen,
  });
  const head = readFileSync(`${file}.head`);
  const modified = statSync(`${file}.head`).mtimeMs;
  store.served(1);
  store.served(seen);
  expect(readFileSync(`${file}.head`)).toStrictEqual(head);
  expect(statSync(`${file}.head`).mtimeMs).toBe(modified);
  store.close();
  copyFileSync(backup, file);
  store = open(file);
  expect(store.dataset()).not.toBe(dataset);
  expect(store.dataset()).toMatch(/^[0-9a-f]{24}$/);
  expect(store.restored).toStrictEqual({ dataset, served: seen, revision: 1 });
  store.close();
  expect(open(file).restored).toBeUndefined();
});

test("head for a different dataset is not rollback evidence; wentBack needs a future revision", () => {
  const file = path();
  let store = open(file);
  const dataset = store.dataset();
  store.close();
  writeFileSync(`${file}.head`, JSON.stringify({ dataset: "different", revision: 9999 }));
  store = open(file);
  expect(store.dataset()).toBe(dataset);
  expect(store.restored).toBeUndefined();
  expect(store.wentBack(1)).toBe(false);
  expect(store.dataset()).toBe(dataset);
  expect(store.wentBack(2)).toBe(true);
  expect(store.dataset()).not.toBe(dataset);
  expect(store.restored).toStrictEqual({ dataset, served: 2, revision: 1 });
});

test("retain keeps keys/head/floor, forgets old logged revisions and bounds finished jobs", async () => {
  const store = open(path());

  const codecs = {
    encode: JSON.stringify,
    decode: (text: string) => outcome.parse(JSON.parse(text)),
  };

  const a = store.createLedger(codecs);
  const b = store.createLedger(codecs);

  for (const [id, ledger] of [
    [1, a],
    [2, b],
  ] as const) {
    await ledger.run(
      { principal: "person", client: "page_0001", id },
      { name: "put", args: "{}" },
      {
        local: () => ({ kind: "ok" as const, resource: String(id) }),
        remote: async () => ({ kind: "retired" as const }),
      }
    );
  }

  const jobs = store.createJobs<string>({
    encode: JSON.stringify,
    decode: (text: string) => String(JSON.parse(text)),
  });

  for (const kind of ["one", "two"]) {
    for (let i = 0; i < 3; i++) {
      const { id } = jobs.ask(kind, String(i), { deadlineAt: Date.now() + 10_000 });
      jobs.start(id, "started");
      jobs.finish(id, { done: "kept" });
    }

    jobs.ask(kind, "open", { deadlineAt: Date.now() + 10_000 });
  }

  store.db.exec(
    "update commands set created_at='2000-01-01T00:00:00.000Z'; update revisions set at='2000-01-01T00:00:00.000Z';"
  );
  const head = store.revision();
  const forgotten = a.revisionOf({ principal: "person", client: "page_0001", id: 1 });

  if (forgotten === undefined) {
    throw new Error("fixture receipt has no revision");
  }

  expect(store.meta("history_floor")).toBe("1");
  expect(store.known(forgotten)).toBe(true);
  store.retain({ receiptsMs: 1, revisionsMs: 1, jobsKept: 1 });
  expect(store.meta("history_floor")).toBe("1");
  expect(store.known(forgotten)).toBe(false);
  expect(store.known(0)).toBe(true);
  expect(store.known(1)).toBe(true);
  expect(
    structuredClone(store.db.prepare("select id,state,outcome from commands order by id").all())
  ).toStrictEqual([
    { id: 1, state: "retired", outcome: null },
    { id: 2, state: "retired", outcome: null },
  ]);
  expect(
    await a.run(
      { principal: "person", client: "page_0001", id: 1 },
      { name: "put", args: "{}" },
      {
        local: () => {
          throw new Error("must not act");
        },
        remote: async () => {
          throw new Error("must not act");
        },
      }
    )
  ).toStrictEqual({ kind: "retired" });
  expect(() => store.db.exec("delete from commands")).toThrow(Error);
  expect(store.known(head)).toBe(true);
  expect(structuredClone(store.db.prepare("select revision from revisions").all())).toStrictEqual([
    { revision: head },
  ]);
  expect(
    structuredClone(
      store.db
        .prepare(
          "select kind,state,count(*) as n from jobs group by kind,state order by kind,state"
        )
        .all()
    )
  ).toStrictEqual([
    { kind: "one", state: "done", n: 1 },
    { kind: "one", state: "due", n: 1 },
    { kind: "two", state: "done", n: 1 },
    { kind: "two", state: "due", n: 1 },
  ]);
});
