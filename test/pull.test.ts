import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import { pullConformance } from "../src/conformance/pull.ts";
import type { PullFixture, PullLimits, PullRow } from "../src/conformance/pull.ts";
import { encodeUrl, endpoint } from "../src/contract.ts";
import {
  array,
  boolean,
  check,
  nullable,
  number,
  object,
  optional,
  string,
} from "../src/schema.ts";
import { Ledger } from "../src/server/ledger.ts";
import { createPull } from "../src/server/pull.ts";

// A small app on the kit, as one would write it: notes paged newest first by (score, id), settings sent whole, a
// command ledger, and its pull endpoint's contract. The harness drives its real pull, encoded and decoded as the
// endpoint would, over a SQLite file it reopens per dataset.

const item = object(
  {
    id: string(),
    score: number({ integer: true }),
    revision: number({ integer: true, min: 0 }),
    deleted: boolean(),
  },
  { strict: true }
);

const pullRoute = endpoint(
  "GET",
  "/api/pull",
  object(
    {
      client: string(),
      dataset: nullable(string()),
      since: number({ integer: true, min: 0 }),
      verify: boolean(),
      page: optional(nullable(string())),
    },
    { strict: true }
  ),
  object(
    {
      dataset: string(),
      revision: number({ integer: true, min: 0 }),
      reset: boolean(),
      notes: array(item),
      settings: array(item),
      commands: array(
        object(
          {
            id: number({ integer: true, min: 1 }),
            revision: number({ integer: true }),
            note: string(),
          },
          { strict: true }
        )
      ),
      page: optional(
        object(
          {
            from: nullable(string()),
            next: nullable(string()),
            through: nullable(string()),
            held: number({ integer: true, min: 0 }),
            total: number({ integer: true, min: 0 }),
          },
          { strict: true }
        )
      ),
    },
    { strict: true }
  )
);

const PRINCIPAL = "person";

const SCHEMA = `
  create table meta(dataset text not null, revision integer not null);
  create table notes(id text primary key, score integer not null, revision integer not null,
    deleted integer not null default 0);
  create index notes_order on notes(score, id);
  create trigger notes_kept before delete on notes begin select raise(abort, 'tombstone it'); end;
  create table settings(id text primary key, score integer not null, revision integer not null,
    deleted integer not null default 0);
  create table commands(
    principal text not null check (length(principal) > 0),
    client text not null, id integer not null check (id > 0),
    name text not null, args text not null,
    state text not null check (state in ('accepted', 'done', 'retired')),
    outcome text check ((state = 'done') = (outcome is not null)),
    revision integer check ((state = 'accepted') = (revision is null)),
    created_at text not null,
    primary key (principal, client, id));
`;

type Note = { id: string; score: number; revision: number; deleted: boolean };

const read = (row: Record<string, SQLOutputValue>): Note => ({
  id: String(row.id),
  score: Number(row.score),
  revision: Number(row.revision),
  deleted: row.deleted === 1,
});

const wireRow = (each: Note): PullRow => ({
  id: each.id,
  value: each.score,
  revision: each.revision,
  deleted: each.deleted,
});

function open(path: string, limits: PullLimits) {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec(SCHEMA);
  db.prepare("insert into meta(dataset, revision) values (?, 0)").run(randomUUID());
  const head = () => db.prepare("select dataset, revision from meta").get();
  const dataset = () => String(head()?.dataset);
  const revision = () => Number(head()?.revision);
  /** The revision this transaction writes: one per transaction, however many rows. */
  let writing: number | undefined;

  const transaction = <T>(body: () => T): T => {
    if (db.isTransaction) {
      return body();
    }

    db.exec("begin immediate");

    try {
      const out = body();
      db.exec("commit");

      return out;
    } catch (error) {
      db.exec("rollback");
      throw error;
    } finally {
      writing = undefined;
    }
  };

  const stamp = () => {
    if (writing === undefined) {
      db.prepare("update meta set revision = revision + 1").run();
      writing = revision();
    }

    return writing;
  };

  const ledger = new Ledger<{ note: string }>({
    db,
    transaction,
    stamp,
    encode: (receipt) => JSON.stringify(receipt),
    decode: (text) => {
      const parsed = check(object({ note: string() }, { strict: true }), JSON.parse(text));

      if (!parsed.ok) {
        throw new Error(parsed.error.message);
      }

      return parsed.value;
    },
  });

  const store = (table: "notes" | "settings", rows: readonly Omit<PullRow, "revision">[]) => {
    const at = stamp();

    for (const each of rows) {
      db.prepare(
        `insert into ${table}(id, score, revision, deleted) values (?, ?, ?, ?)
         on conflict(id) do update set score = excluded.score, revision = excluded.revision, deleted = excluded.deleted`
      ).run(each.id, each.value, at, each.deleted ? 1 : 0);
    }
  };

  const assembler = createPull({
    db,
    dataset,
    revision,
    paged: {
      table: "notes",
      order: ["score", "id"],
      version: 1,
      live: "deleted = 0",
      read,
      through: (values) => String(values[0]),
    },
    unpaged: (since) => ({
      settings: db
        .prepare(`select * from settings where revision > ? and (? > 0 or deleted = 0)`)
        .all(since, since)
        .map(read),
    }),
    receipts: {
      read: (since, client: string) => ledger.receipts(PRINCIPAL, client, since),
      names: (each) => [each.receipt.note],
    },
    limits,
    respond: (pulled) => ({
      dataset: pulled.dataset,
      revision: pulled.revision,
      reset: pulled.reset,
      notes: pulled.rows,
      settings: pulled.unpaged.settings,
      commands: pulled.receipts.map((each) => ({
        id: each.id,
        revision: each.revision,
        note: each.receipt.note,
      })),
      ...(pulled.page === undefined ? {} : { page: pulled.page }),
    }),
  });

  return { db, dataset, transaction, stamp, ledger, store, assembler };
}

async function create(limits: PullLimits): Promise<PullFixture> {
  const home = mkdtempSync(join(tmpdir(), "slopkit-pull-"));
  let generation = 0;
  let app = open(join(home, `store-${generation}.db`), limits);

  return {
    pull: async (input) => {
      // The request as the page sends it, parsed as the route parses it.
      const query = new URL(encodeUrl(pullRoute, input), "http://app").searchParams.get("q") ?? "";
      const request = pullRoute.request.parse(JSON.parse(query), "request");

      const { reply } = app.assembler.pull(request, request.client);

      // On the wire as the server encodes it, and read back as the page reads it.
      const body = JSON.stringify(pullRoute.response.parse(reply, "reply"));
      const decoded = check(pullRoute.response, JSON.parse(body));

      if (!decoded.ok) {
        throw new Error(decoded.error.message);
      }

      const wire = decoded.value;

      return {
        patch: {
          dataset: wire.dataset,
          revision: wire.revision,
          reset: wire.reset,
          rows: { rows: wire.notes.map(wireRow), unpaged: wire.settings.map(wireRow) },
          ...(wire.page === undefined ? {} : { page: wire.page }),
        },
        receipts: wire.commands.map((each) => ({
          id: each.id,
          revision: each.revision,
          outcome: { resource: each.note },
        })),
        bytes: Buffer.byteLength(body),
      };
    },
    write: async (changes) => {
      const apply = () => {
        app.store("notes", changes.rows);
        app.store("settings", changes.unpaged ?? []);
      };

      const receipt = changes.receipt;

      if (receipt === undefined) {
        app.transaction(apply);
      } else {
        const ran = await app.ledger.run(
          { principal: PRINCIPAL, client: receipt.client, id: receipt.id },
          { name: "write", args: JSON.stringify(changes) },
          {
            local: () => {
              apply();

              return { note: receipt.resource };
            },
            remote: async () => {
              throw new Error("this command only writes to the store");
            },
          }
        );

        if (ran.kind !== "done") {
          throw new Error(`the write didn't run: ${ran.kind}`);
        }
      }

      const head = app.db.prepare("select dataset, revision from meta").get();

      return { dataset: String(head?.dataset), revision: Number(head?.revision) };
    },
    replace: async () => {
      app.db.close();
      generation++;
      app = open(join(home, `store-${generation}.db`), limits);
    },
    close: async () => {
      app.db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

pullConformance({ name: "server/pull over SQLite", create });
