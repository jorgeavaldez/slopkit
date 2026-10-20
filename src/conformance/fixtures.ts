import { randomUUID } from "node:crypto";

import { IDBFactory } from "fake-indexeddb";

import type { NetworkPort } from "../client.ts";
import {
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  variant,
} from "../schema.ts";
import type { Infer, Schema } from "../schema.ts";
import { createSync, table } from "../sync.ts";
import type { Key, Pending, Replica } from "../sync.ts";
import { indexedReplica } from "../web/replica.ts";

const rowSchema = object(
  {
    id: string(),
    value: number({ integer: true }),
    deleted: boolean(),
    revision: number({ integer: true, min: 0 }),
  },
  { strict: true }
);

export type Row = Infer<typeof rowSchema>;

export type Tables = { rows: ReadonlyMap<Key, Row> };

export type PatchRows = { rows: Row[] };

const serverSchema = object({ build: string() }, { strict: true });

export type Server = Infer<typeof serverSchema>;

const commandSchema = object(
  { name: literal("put"), value: number({ integer: true }) },
  { strict: true }
);

export type Command = Infer<typeof commandSchema>;

export const outcomeSchema = variant("kind", {
  ok: object({ kind: literal("ok"), resource: string() }, { strict: true }),
  failed: object({ kind: literal("failed"), reason: string() }, { strict: true }),
  unknown: object({ kind: literal("unknown"), reason: string() }, { strict: true }),
});

export type Outcome = Infer<typeof outcomeSchema>;

const pendingSchema = object({
  client: string(),
  id: number({ integer: true, min: 1 }),
  dataset: nullable(string()),
  since: optional(number({ integer: true, min: 0 })),
  command: commandSchema,
  at: number(),
  state: variant("kind", {
    saving: object({ kind: literal("saving") }),
    queued: object({ kind: literal("queued") }),
    sending: object({ kind: literal("sending") }),
    unknown: object({ kind: literal("unknown"), failure: string() }),
    done: object({
      kind: literal("done"),
      outcome: outcomeSchema,
      revision: number({ integer: true, min: 0 }),
    }),
  }),
});

const empty: Tables = { rows: new Map() };

const rowsLens = table<Tables, PatchRows, Row>({
  name: "rows",
  schema: rowSchema,
  rows: (patch) => patch.rows,
  key: (row) => row.id,
  gone: (row) => row.deleted,
  get: (tables) => tables.rows,
  set: (_tables, rows) => ({ rows }),
});

export const sync = createSync<Tables, PatchRows, Server, Command, Outcome>({
  tables: [rowsLens],
  empty,
  onlineOnly: () => false,
  refused: (_command, reason) => ({ kind: "failed", reason }),
});

export type Network = NetworkPort<PatchRows, Server, Command, Outcome>;

export type Copy = Replica<Tables, Server>;

export const row = (id: string, value: number, revision: number, deleted = false): Row => ({
  id,
  value,
  revision,
  deleted,
});

export const copy = (revision: number, rows: Row[], dataset = "dataset-a"): Copy => ({
  dataset,
  revision,
  server: { build: "fixture-v1" },
  tables: { rows: new Map(rows.map((value) => [value.id, value])) },
});

export const patch = (revision: number, rows: Row[], reset = false, dataset = "dataset-a") => ({
  dataset,
  revision,
  reset,
  rows: { rows },
  server: { build: "fixture-v1" },
  // This fixture checksum only completes the verification exchange. Assertions below use independent literal rows,
  // never this value or the production digest as the correctness oracle.
  checksum: "fixture-fingerprint",
});

export const pending = (client: string, id: number, value = 1): Pending<Command, Outcome> => ({
  client,
  id,
  dataset: "dataset-a",
  command: { name: "put", value },
  at: 0,
  state: { kind: "queued" },
});

export function deferred<T>() {
  let complete: ((value: T | PromiseLike<T>) => void) | undefined;

  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });

  return {
    promise,
    resolve: (value: T) => {
      if (complete === undefined) {
        throw new Error("no resolver");
      }

      complete(value);
    },
  };
}

export function database(
  options: {
    factory?: IDBFactory;
    name?: string;
    version?: number;
    interfere?: (what: "commit" | "keep" | "drop", transaction: IDBTransaction) => void;
    /** The server facts' schema, when a later version reads them differently. */
    server?: Schema<Server>;
  } = {}
) {
  const factory = options.factory ?? new IDBFactory();
  const name = options.name ?? `conformance-${randomUUID()}`;

  const port = indexedReplica<Tables, PatchRows, Server, Command, Outcome>({
    factory,
    name,
    version: options.version ?? 1,
    tables: [rowsLens],
    empty,
    server: options.server ?? serverSchema,
    pending: pendingSchema,
    ...(options.interfere === undefined ? {} : { interfere: options.interfere }),
  });

  return { factory, name, port };
}

/** Deliberately ordinary literal values, independent of merge/commitPlan/checksum. */
export const values = (replica: Copy) =>
  [...replica.tables.rows.values()]
    .map((value) => [value.id, value.value, value.revision])
    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
