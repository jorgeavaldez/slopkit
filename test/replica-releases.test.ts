import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";

import { Replaced } from "../src/client.ts";
import { copy, row, values } from "../src/conformance/fixtures.ts";
import type { PatchRows, Row, Tables } from "../src/conformance/fixtures.ts";
import { boolean, literal, nullable, number, object, string } from "../src/schema.ts";
import type { Schema } from "../src/schema.ts";
import { table } from "../src/sync.ts";
import { indexedReplica } from "../src/web/replica.ts";

// Two releases with different row schemas open on one device: a tab may write over a copy it can't read only while it
// is the very copy that tab loaded and set aside. Once another release's tab writes its own copy, that release owns
// it on this device, at any revision, and the first tab stops writing until it reloads.
const older = object(
  { id: string(), value: number(), deleted: boolean(), revision: number() },
  { strict: true }
);

const newer = object(
  { id: string(), value: number({ min: 0 }), deleted: boolean(), revision: number() },
  { strict: true }
);

function opener(factory: IDBFactory, connections: Set<IDBDatabase>) {
  return (schema: Schema<Row>) =>
    indexedReplica({
      factory,
      name: "two-releases",
      version: 1,
      tables: [
        table<Tables, PatchRows, Row>({
          name: "rows",
          schema,
          rows: (patch) => patch.rows,
          key: (value) => value.id,
          gone: (value) => value.deleted,
          get: (tables) => tables.rows,
          set: (_tables, rows) => ({ rows }),
        }),
      ],
      empty: { rows: new Map<string, Row>() },
      server: object({ build: string() }),
      pending: object({
        client: string(),
        id: number(),
        dataset: nullable(string()),
        command: object({}),
        at: number(),
        state: object({ kind: literal("queued") }),
      }),
      interfere: (_what, transaction) => {
        connections.add(transaction.db);
      },
    });
}

const commit = (revision: number, value: number) => ({
  replica: copy(revision, [row("kept", value, revision)]),
  reset: true,
  base: 0,
  replaces: "dataset-a",
  ops: [],
});

test.each([8, 9, 10])(
  "an older release's tab can't overwrite the newer release's copy at %i",
  async (at) => {
    const connections = new Set<IDBDatabase>();
    const open = opener(new IDBFactory(), connections);

    try {
      const old = open(older);
      await old.load();
      await old.commit(commit(7, 70));
      const current = open(newer);
      await current.load();
      await current.commit(commit(9, 90));
      await expect(old.commit(commit(at, 91))).rejects.toThrow(Replaced);
      const disk = (await open(newer).load()).replica;
      expect(disk.revision).toBe(9);
      expect(values(disk)).toStrictEqual([["kept", 90, 9]]);
    } finally {
      for (const connection of connections) {
        connection.close();
      }
    }
  }
);

test("a release rewrites, at the same revision, the copy it loaded and couldn't read", async () => {
  const connections = new Set<IDBDatabase>();
  const open = opener(new IDBFactory(), connections);

  try {
    const old = open(older);
    await old.load();
    await old.commit(commit(9, 90));
    const current = open(newer);
    expect((await current.load()).replica.revision).toBe(0);
    await expect(current.commit(commit(9, 91))).resolves.toStrictEqual({
      dataset: "dataset-a",
      revision: 9,
    });
    expect(values((await open(newer).load()).replica)).toStrictEqual([["kept", 91, 9]]);
  } finally {
    for (const connection of connections) {
      connection.close();
    }
  }
});
