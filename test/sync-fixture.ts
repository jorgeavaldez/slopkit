import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLOutputValue } from "node:sqlite";

import { syncApi } from "../src/api.ts";
import {
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  variant,
} from "../src/schema.ts";
import type { Infer } from "../src/schema.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { addKey } from "../src/server/keys.ts";
import type { CommandKey } from "../src/server/ledger.ts";
import type { Attributes, Logger } from "../src/server/log.ts";
import { SyncStore } from "../src/server/store.ts";
import { serveSync, syncHandlers } from "../src/server/sync.ts";
import type { Caller, Route, RawRoute } from "../src/server/web.ts";
import { createSync, table } from "../src/sync.ts";
import type { Key } from "../src/sync.ts";
import { identityProvider } from "../src/test/oidc.ts";

export const row = object(
  {
    id: string(),
    value: number({ integer: true }),
    deleted: boolean(),
    revision: number({ integer: true, min: 0 }),
  },
  { strict: true }
);

type Row = Infer<typeof row>;

export const command = object(
  {
    name: literal("put", "person", "remote", "fail"),
    id: string(),
    value: number({ integer: true }),
  },
  { strict: true }
);

export type Command = Infer<typeof command>;

export const outcome = variant("kind", {
  ok: object({ kind: literal("ok"), resource: string() }, { strict: true }),
  failed: object(
    {
      kind: literal("failed"),
      reason: literal("conflict", "forbidden", "fixture"),
      message: string(),
    },
    { strict: true }
  ),
  retired: object({ kind: literal("retired") }, { strict: true }),
});

export type Outcome = Infer<typeof outcome>;

export const serverSchema = object({ version: string() }, { strict: true });

export const api = syncApi({
  rows: { history: row, settings: row },
  server: serverSchema,
  command,
  outcome,
});

export const pending = object({
  client: string(),
  id: number({ integer: true, min: 1 }),
  dataset: nullable(string()),
  since: optional(number({ integer: true, min: 0 })),
  command,
  at: number(),
  state: variant("kind", {
    saving: object({ kind: literal("saving") }),
    queued: object({ kind: literal("queued") }),
    sending: object({ kind: literal("sending") }),
    unknown: object({
      kind: literal("unknown"),
      failure: string(),
      parked: optional(literal(true)),
    }),
    done: object({ kind: literal("done"), outcome, revision: number({ integer: true, min: 0 }) }),
  }),
});

export type Tables = { history: ReadonlyMap<Key, Row>; settings: ReadonlyMap<Key, Row> };

export type Patch = { history: Row[]; settings: Row[] };

export const empty: Tables = { history: new Map(), settings: new Map() };

const historyLens = table<Tables, Patch, Row>({
  name: "history",
  schema: row,
  rows: (p) => p.history,
  key: (r) => r.id,
  gone: (r) => r.deleted,
  get: (t) => t.history,
  set: (t, history) => ({ ...t, history }),
});

const settingsLens = table<Tables, Patch, Row>({
  name: "settings",
  schema: row,
  rows: (p) => p.settings,
  key: (r) => r.id,
  gone: (r) => r.deleted,
  get: (t) => t.settings,
  set: (t, settings) => ({ ...t, settings }),
});

// Deliberately opposite the API's order: a fingerprint is not the replica options' order.
export const tables = [settingsLens, historyLens];

export const engine = createSync<Tables, Patch, Infer<typeof serverSchema>, Command, Outcome>({
  tables,
  empty,
  onlineOnly: () => false,
  resolved: () => false,
  refused: (_c, message) => ({ kind: "failed", reason: "fixture", message }),
});

export const SCHEMA = {
  base: `create table history(id text primary key, value integer not null, deleted integer not null default 0, revision integer not null) strict;
    create table settings(id text primary key, value integer not null, deleted integer not null default 0, revision integer not null) strict;`,
  replicated: ["history", "settings"],
  baseVersion: 1,
  migrations: new Array<string>(),
  indexes: "create index if not exists history_order on history(value, id);",
};

function readRow(raw: Record<string, SQLOutputValue>): Row {
  return row.parse({ ...raw, deleted: raw.deleted === 1 });
}

class Store extends SyncStore {
  constructor(path: string) {
    super(path, { name: "notes", schema: SCHEMA });
  }
  rows(tableName: "history" | "settings", since = 0): Row[] {
    return this.db
      .prepare(
        `select * from ${tableName} where ${since === 0 ? "deleted = 0" : "revision > ?"} order by id`
      )
      .all(...(since === 0 ? [] : [since]))
      .map(readRow);
  }
  put(id: string, value: number, tableName: "history" | "settings" = "history"): void {
    this.transaction(() => {
      const revision = this.stamp();
      this.db
        .prepare(
          `insert into ${tableName}(id,value,deleted,revision) values (?,?,0,?) on conflict(id) do update set value=excluded.value, revision=excluded.revision`
        )
        .run(id, value, revision);
    });
  }
}

export const CLIENT = "page_0001";

export const PERSON: Caller = {
  identities: ["sub:someone"],
  person: true,
  login: "oidc",
  request: "person-request",
};

export const AGENT: Caller = {
  identities: ["key:fixture"],
  person: false,
  login: "key",
  request: "key-request",
};

type LogLine = { severity: string; body: string; attributes?: Attributes };

export async function fixture(
  options: {
    manifest?: { name?: string; theme_color?: string };
    routes?: (Route | RawRoute)[];
  } = {}
) {
  const home = await mkdtemp(join(tmpdir(), "slopkit-sync-"));
  const store = new Store(join(home, "notes.sqlite"));
  const lines: LogLine[] = [];

  const page: Logger = (severity, body, attributes) => {
    lines.push({ severity, body, ...(attributes === undefined ? {} : { attributes }) });
  };

  const ledger = store.createLedger<Outcome>({
    encode: JSON.stringify,
    decode: (text: string) => outcome.parse(JSON.parse(text)),
  });

  let version = "v1";
  const actions: string[] = [];
  const pushed: { key: CommandKey; command: Command; kept: Outcome; fresh: boolean }[][] = [];

  const handlerOptions = {
    api,
    store,
    ledger,
    log: page,
    server: (_caller: Caller) => ({ version }),
    history: {
      row: "history" as const,
      table: "history",
      order: ["value", "id"],
      version: 1,
      live: "deleted = 0",
      read: readRow,
      through: (values: readonly SQLOutputValue[]) => String(values[0]),
    },
    unpaged: (since: number) => ({ settings: store.rows("settings", since) }),
    everything: () => ({ history: store.rows("history"), settings: store.rows("settings") }),
    outcome: (kept: Outcome) => kept,
    names: (kept: Outcome) => (kept.kind === "ok" ? [kept.resource] : []),
    limits: { firstRows: 2, pageRows: 2, maxRows: 6, maxBytes: 16_000 },
    personOnly: (c: Command) => c.name === "person",
    act: (c: Command, _caller: Caller, _key: CommandKey) => {
      if (c.name === "remote") {
        return {
          local: () => undefined,
          remote: (): Promise<Outcome> => {
            actions.push(c.id);
            store.put(c.id, c.value);

            return Promise.resolve({ kind: "ok", resource: c.id });
          },
        };
      }

      return {
        local: (): Outcome => {
          actions.push(c.id);

          if (c.name === "fail") {
            return { kind: "failed", reason: "fixture", message: "fixture refused" };
          }

          store.put(c.id, c.value);

          return { kind: "ok", resource: c.id };
        },
      };
    },
    pushed: (ran: { key: CommandKey; command: Command; kept: Outcome; fresh: boolean }[]) =>
      pushed.push(ran),
  };

  const sync = syncHandlers(handlerOptions);
  const provider = await identityProvider("someone");
  await writeFile(join(home, "index.html"), "<!doctype html><title>notes</title>");
  const token = await addKey(home, "fixture");

  const config = parseWebConfig(
    {
      port: 0,
      oidc: { issuer: provider.issuer, clientId: "test" },
      allow: ["sub:someone", "key:fixture"],
    },
    []
  );

  const served = await serveSync({
    name: "notes",
    api,
    home,
    config,
    env: {},
    log: page,
    page,
    assets: home,
    sync,
    ...options,
  });

  const server = { ...served, url: new URL(served.url).origin };
  const headers = { authorization: `Bearer ${token}` };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this fault-boundary helper deliberately sends malformed wire input for request-schema tests
  const request = (path: string, body?: unknown, custom = headers) =>
    fetch(new URL(path, server.url), {
      headers: { ...custom, "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });

  return {
    home,
    config,
    store,
    ledger,
    lines,
    actions,
    pushed,
    sync,
    handlerOptions,
    server,
    headers,
    request,
    setVersion: (next: string) => {
      version = next;
    },
    login: async () => {
      let response = await fetch(new URL("/auth/login", server.url), { redirect: "manual" });
      response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
      response = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });

      return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    },
    close: async () => {
      await server.close();
      await provider.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
