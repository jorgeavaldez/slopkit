import { randomUUID } from "node:crypto";

/** The IndexedDB layout follows the app's tables, and a tab on other row shapes can't write back a replaced dataset. */
import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";

import { Replaced } from "../src/client.ts";
import { boolean, literal, nullable, number, object, string } from "../src/schema.ts";
import { table } from "../src/sync.ts";
import type { Key } from "../src/sync.ts";
import { indexedReplica } from "../src/web/replica.ts";

const row = object(
  { id: string(), value: number({ integer: true }), deleted: boolean() },
  { strict: true }
);

type Row = { id: string; value: number; deleted: boolean };

type Tables = { rows: ReadonlyMap<Key, Row>; notes: ReadonlyMap<Key, Row> };

type Patch = { rows: Row[]; notes: Row[] };

const lens = (name: "rows" | "notes", schema = row) =>
  table<Tables, Patch, Row>({
    name,
    schema,
    rows: (patch) => patch[name],
    key: (each) => each.id,
    gone: (each) => each.deleted,
    get: (tables) => tables[name],
    set: (tables, rows) => ({ ...tables, [name]: rows }),
  });

const empty: Tables = { rows: new Map(), notes: new Map() };

const pending = object({
  client: string(),
  id: number({ integer: true, min: 1 }),
  dataset: nullable(string()),
  command: object({ name: literal("put") }),
  at: number(),
  state: object({ kind: literal("queued") }),
});

const port = (factory: IDBFactory, name: string, tables: ReturnType<typeof lens>[]) =>
  indexedReplica({
    factory,
    name,
    version: 1,
    tables,
    empty,
    server: object({ build: string() }),
    pending,
  });

const copy = (dataset: string, revision: number, value: number) => ({
  dataset,
  revision,
  server: { build: "b" },
  tables: { ...empty, rows: new Map([["a", { id: "a", value, deleted: false }]]) },
});

// Any change to a table's name set or row schema starts the rows over, and the outbox survives and stays readable, with
// no number to bump by hand: a release that adds a table keeps `version`.
test("a table added without a version bump starts the rows over and keeps the outbox", async () => {
  const factory = new IDBFactory();
  const name = `layout-${randomUUID()}`;
  const before = port(factory, name, [lens("rows")]);
  await before.load();
  await before.keep({
    client: "old-page",
    id: 1,
    dataset: "d1",
    command: { name: "put" },
    at: 1,
    state: { kind: "queued" },
  });
  await before.commit({ replica: copy("d1", 7, 1), reset: true, base: 0, replaces: null, ops: [] });
  const after = port(factory, name, [lens("rows"), lens("notes")]);
  const loaded = await after.load();
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0 });
  expect(loaded.commands).toMatchObject([{ client: "old-page", id: 1 }]);
});

// A replica only moves forward, on disk too: a page still open on the previous release (other row shapes, same object
// stores) must not write back a dataset the disk has replaced.
test("a tab on other row shapes never writes back a dataset the disk replaced", async () => {
  const factory = new IDBFactory();
  const name = `layout-${randomUUID()}`;
  const older = port(factory, name, [lens("rows")]);

  const newer = port(factory, name, [
    lens("rows", object({ id: string(), value: number(), deleted: boolean() }, { strict: true })),
  ]);

  await older.load();
  await older.commit({ replica: copy("d1", 7, 1), reset: true, base: 0, replaces: null, ops: [] });
  await newer.load();
  // The newer tab hears the server replaced its store: d2.
  await newer.commit({ replica: copy("d2", 3, 2), reset: true, base: 0, replaces: null, ops: [] });
  // The older tab, still on d1, commits a delta of the store that no longer exists.
  await expect(
    older.commit({
      replica: copy("d1", 8, 9),
      reset: false,
      base: 7,
      replaces: null,
      ops: [{ table: "rows", key: "a", row: { id: "a", value: 9, deleted: false } }],
    })
  ).rejects.toThrow(Replaced);
  const fresh = port(factory, name, [lens("rows")]);
  expect((await fresh.load()).replica.dataset).not.toBe("d1");
});
