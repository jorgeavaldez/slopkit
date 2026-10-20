/** Row shapes: structural comparisons and durable readbacks, not fingerprint calculations. */
import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";

import {
  array,
  boolean,
  literal,
  nil,
  nullable,
  number,
  object,
  optional,
  record,
  scalar,
  string,
  variant,
} from "../schema.ts";
import type { Schema } from "../schema.ts";
import { table } from "../sync.ts";
import { indexedReplica } from "../web/replica.ts";
import { copy, database, pending, row, values } from "./fixtures.ts";
import type { Row, Tables, PatchRows } from "./fixtures.ts";

const baseFields = {
  id: string(),
  value: number({ integer: true }),
  deleted: boolean(),
  revision: number({ integer: true, min: 0 }),
};

const rows = object(baseFields, { strict: true });

const shapes: [string, Schema<unknown>, Schema<unknown>][] = [
  ["field added", object({ a: string() }), object({ a: string(), b: optional(string()) })],
  ["field renamed", object({ a: string() }), object({ b: string() })],
  ["field type", object({ a: string() }), object({ a: number() })],
  ["string min", string(), string({ min: 1 })],
  ["string max", string(), string({ max: 7 })],
  ["pattern", string({ pattern: /a/i }), string({ pattern: /a/ })],
  ["integer", number(), number({ integer: true })],
  ["number min", number(), number({ min: 1 })],
  ["number max", number(), number({ max: 1 })],
  ["literal", literal("a"), literal("b")],
  ["literal type", literal(1), literal("1")],
  ["optional", string(), optional(string())],
  ["nullable", string(), nullable(string())],
  ["strict", object({ a: string() }), object({ a: string() }, { strict: true })],
  [
    "variant added",
    variant("k", { a: object({ k: literal("a") }) }),
    variant("k", { a: object({ k: literal("a") }), b: object({ k: literal("b") }) }),
  ],
  ["array item", array(string()), array(number())],
  ["array max", array(string()), array(string(), { max: 2 })],
  ["record value", record(string()), record(number())],
  ["boolean vs null", boolean(), nil()],
  ["scalar vs text", scalar(), string()],
];

// Guard: schema.shape describes all semantic inputs, not just the old human-readable expected string.
test.each(shapes)("shape distinguishes %s and is reproducible", (_name, before, after) => {
  expect(before.shape).toBeTypeOf("string");
  expect(before.shape.length).toBeGreaterThan(0);
  expect(before.shape).not.toBe(after.shape);
});

const nested = () =>
  object(
    {
      a: array(nullable(string({ pattern: /a/i, max: 4 }))),
      b: optional(number({ integer: true, min: 0 })),
    },
    { strict: true }
  );

test("independently constructed nested schemas have equal shapes", () => {
  expect(nested().shape).toBeTypeOf("string");
  expect(nested().shape).toBe(nested().shape);
});

function changed(factory: IDBFactory, name: string, schema = rows, tableName = "rows") {
  return indexedReplica({
    factory,
    name,
    version: tableName === "rows" ? 1 : 2,
    tables: [
      table<Tables, PatchRows, Row>({
        name: tableName,
        schema,
        rows: (p) => p.rows,
        key: (r) => r.id,
        gone: (r) => r.deleted,
        get: (t) => t.rows,
        set: (_t, next) => ({ rows: next }),
      }),
    ],
    empty: { rows: new Map<string, Row>() },
    server: object({ build: string() }, { strict: true }),
    pending: object({
      client: string(),
      id: number(),
      dataset: nullable(string()),
      command: object({ name: literal("put"), value: number() }),
      at: number(),
      state: object({ kind: literal("queued") }),
    }),
  });
}

// Guard: fingerprint mismatch clears ONLY rows/checkpoint/server; even readable old rows must not cross a schema change.
test.each(["schema", "table-name"])(
  "a %s change starts the rows over, preserves the outbox, and repairs disk on next commit",
  async (change) => {
    let oldConnection: IDBDatabase | undefined;

    const stored = database({
      interfere: (_what, tx) => {
        oldConnection = tx.db;
      },
    });

    await stored.port.load();
    await stored.port.keep(pending("old-page", 1, 125));
    await stored.port.commit({
      replica: copy(7, [row("kept", 125, 7)]),
      reset: true,
      base: 0,
      replaces: "dataset-a",
      ops: [],
    });

    const schema =
      change === "schema"
        ? object({ ...baseFields, value: number({ integer: true, min: 0 }) }, { strict: true })
        : rows;

    expect(schema.shape).toBeTypeOf("string");
    oldConnection?.close();

    const next = changed(
      stored.factory,
      stored.name,
      schema,
      change === "table-name" ? "renamed" : "rows"
    );

    const empty = await next.load();
    expect(empty.replica).toMatchObject({ dataset: null, revision: 0, server: null });
    expect(values(empty.replica)).toStrictEqual([]);
    expect(empty.commands).toMatchObject([{ client: "old-page", id: 1, command: { value: 125 } }]);
    await next.commit({
      replica: copy(7, [row("repaired", 250, 7)]),
      reset: true,
      base: 0,
      replaces: "dataset-a",
      ops: [],
    });

    const fresh = changed(
      stored.factory,
      stored.name,
      schema,
      change === "table-name" ? "renamed" : "rows"
    );

    expect(values((await fresh.load()).replica)).toStrictEqual([["repaired", 250, 7]]);
  }
);

const commit = (replica: ReturnType<typeof copy>) => ({
  replica,
  reset: true,
  base: 0,
  replaces: "dataset-a",
  ops: [],
});

// Guard: equality is not a no-op for server facts; stale revisions still may not regress them.
test("same-revision facts are durable while an older tab writes nothing", async () => {
  const first = database();
  const second = database({ factory: first.factory, name: first.name });
  await Promise.all([first.port.load(), second.port.load()]);

  await first.port.commit(commit(copy(9, [row("kept", 125, 9)])));
  await second.port.commit(
    commit({ ...copy(9, [row("kept", 125, 9)]), server: { build: "new-server-facts" } })
  );
  await first.port.commit(commit({ ...copy(8, [row("old", 100, 8)]), server: { build: "stale" } }));
  const disk = (await database({ factory: first.factory, name: first.name }).port.load()).replica;
  expect(disk.server).toStrictEqual({ build: "new-server-facts" });
  expect(values(disk)).toStrictEqual([["kept", 125, 9]]);
});

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("request failed"));
  });
}

function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

// Guard: absent fingerprint is untrusted, even if every old row happens to parse.
test("a checkpoint without row shapes is reset, its readable outbox survives, and new commit repairs disk", async () => {
  const factory = new IDBFactory();
  const name = "legacy-checkpoint";
  const opening = factory.open(name, 1);
  opening.onupgradeneeded = () => {
    for (const store of ["meta", "outbox", "rows"]) {
      opening.result.createObjectStore(store);
    }
  };

  const db = await done(opening);
  const tx = db.transaction(["meta", "outbox", "rows"], "readwrite");
  // An older release's disk layout: meta/checkpoint holds {dataset,revision,server}; outbox keys are client/id.
  tx.objectStore("meta").put(
    { dataset: "dataset-a", revision: 7, server: { build: "fixture-v1" } },
    "checkpoint"
  );
  tx.objectStore("rows").put(row("old", 125, 7), "old");
  tx.objectStore("outbox").put(pending("old-page", 1, 125), "old-page/1");
  await completed(tx);
  db.close();
  const fresh = database({ factory, name });
  const loaded = await fresh.port.load();
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
  expect(values(loaded.replica)).toStrictEqual([]);
  expect(loaded.commands).toMatchObject([{ client: "old-page", id: 1, command: { value: 125 } }]);
  await fresh.port.commit({
    replica: copy(7, [row("repaired", 250, 7)]),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  });
  expect(values((await database({ factory, name }).port.load()).replica)).toStrictEqual([
    ["repaired", 250, 7],
  ]);
});

// Guard: unreadable load must not cause same-revision reset to be skipped; commit/abort remains atomic.
test("same-shape corrupt rows are repaired on disk at the SAME revision; abort does not acknowledge repair", async () => {
  let abort = false;
  const stored = database();
  await stored.port.load();
  await stored.port.commit({
    replica: copy(7, [row("kept", 125, 7)]),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  });
  const raw = await done(stored.factory.open(stored.name));
  const tx = raw.transaction("rows", "readwrite");
  tx.objectStore("rows").put(
    { id: "kept", value: "unreadable", deleted: false, revision: 7 },
    "kept"
  );
  await completed(tx);
  raw.close();

  const repaired = database({
    factory: stored.factory,
    name: stored.name,
    interfere: (what, transaction) => {
      if (what === "commit" && abort) {
        transaction.abort();
      }
    },
  });

  expect((await repaired.port.load()).replica.dataset).toBeNull();

  const replacement = {
    replica: copy(7, [row("kept", 125, 7)]),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  };

  abort = true;
  await expect(repaired.port.commit(replacement)).rejects.toThrow(/IndexedDB/);
  expect(
    (await database({ factory: stored.factory, name: stored.name }).port.load()).replica.dataset
  ).toBeNull();
  abort = false;
  await repaired.port.commit(replacement);
  expect(
    values((await database({ factory: stored.factory, name: stored.name }).port.load()).replica)
  ).toStrictEqual([["kept", 125, 7]]);
});

// Guard: server schema mismatch invalidates facts only; equal-revision new facts must then persist.
test("new server-fact schema keeps rows, and replacement facts repair the same durable checkpoint", async () => {
  const older = database();
  await older.port.load();
  await older.port.commit({
    replica: copy(7, [row("kept", 125, 7)]),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  });
  const schema = object({ build: string(), lastUpdate: string() }, { strict: true });
  const next = database({ factory: older.factory, name: older.name, server: schema });
  const loaded = await next.port.load();
  expect(values(loaded.replica)).toStrictEqual([["kept", 125, 7]]);
  expect(loaded.replica.server).toBeNull();
  const server = { build: "fixture-v2", lastUpdate: "installed" };
  await next.port.commit({
    replica: { ...copy(7, [row("kept", 125, 7)]), server },
    reset: true,
    base: 7,
    replaces: "dataset-a",
    ops: [],
  });
  expect(
    (await database({ factory: older.factory, name: older.name, server: schema }).port.load())
      .replica.server
  ).toStrictEqual(server);
});
