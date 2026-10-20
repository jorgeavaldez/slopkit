import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";

import { boolean, literal, nullable, number, object, string } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { table } from "../sync.ts";
import { indexedReplica } from "../web/replica.ts";
import { copy, row, values } from "./fixtures.ts";
import type { Row, Tables, PatchRows } from "./fixtures.ts";

const commit = (revision: number, value: number) => ({
  replica: copy(revision, [row("kept", value, revision)]),
  reset: true,
  base: 0,
  replaces: "dataset-a",
  ops: [],
});

test("a still-open old schema cannot regress a newer schema's durable revision", async () => {
  const factory = new IDBFactory();

  const oldSchema = object(
    { id: string(), value: number(), deleted: boolean(), revision: number() },
    { strict: true }
  );

  const newSchema = object(
    { id: string(), value: number({ min: 0 }), deleted: boolean(), revision: number() },
    { strict: true }
  );

  const connections = new Set<IDBDatabase>();

  const make = (schema: Schema<Row>) =>
    indexedReplica({
      factory,
      name: "overlapping-row-schemas",
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

  try {
    const older = make(oldSchema);
    await older.load();
    await older.commit(commit(7, 70));
    const newer = make(newSchema);
    await newer.load();
    await newer.commit(commit(9, 90));
    // Either reject the old writer or skip its stale commit; neither may replace the durable revision-9 copy.
    await older.commit(commit(8, 80)).catch(() => undefined);
    const disk = (await newer.load()).replica;
    expect(disk.dataset).toBe("dataset-a");
    expect(disk.revision).toBe(9);
    expect(values(disk)).toStrictEqual([["kept", 90, 9]]);
  } finally {
    for (const connection of connections) {
      connection.close();
    }
  }
});
