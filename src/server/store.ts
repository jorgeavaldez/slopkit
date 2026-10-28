/**
 * The replicated store's core: a home's SQLite file (Node's built-in SQLite, WAL), owned by the one server under the
 * home's lock, that a replica pulls from. An app's store extends `SyncStore` (or holds one) and adds its own tables and
 * queries; the mechanics every replicated store needs are here.
 *
 * - **Nothing opens a store it can't read.** A store from a newer release, or older than the schema this release
 *   starts from, is refused before anything is written to it.
 * - **Migrations are append only** and each runs in its own transaction, foreign keys checked at its end; a store with
 *   data is first copied whole (`<path>.schema-<n>.bak`, the oldest kept), so a rollback can put it back.
 * - **Every write is stamped:** the rows a transaction writes to a replicated table carry the revision `stamp()` made
 *   in it (a trigger refuses any other), and nothing replicated is deleted (tombstones). Each revision is logged, so a
 *   page holding one this history never had (a restore's lost future) is told apart from one that is behind.
 * - **A restore is told apart:** the newest revision served is kept beside the store (`<path>.head`), written before
 *   the reply carrying it leaves; a store that opens behind it went back, and takes a new dataset.
 * - **Retention never deletes a key:** receipts retire, old revisions are forgotten (a page holding one starts over),
 *   finished jobs beyond the newest are pruned.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { check, number, object, string } from "../schema.ts";
import { Jobs } from "./jobs.ts";
import { Ledger } from "./ledger.ts";

/**
 * The core tables every replicated store has, before the app's own: `meta`, the command ledger's `commands`
 * (`slopkit/server/ledger`), `jobs` (`slopkit/server/jobs`) and the `revisions` log. Never edited once shipped.
 */
export const CORE_TABLES = `create table meta(key text primary key, value text not null);
   create table commands(
     principal text not null check (length(principal) > 0),
     client text not null, id integer not null check (id > 0),
     name text not null, args text not null,
     state text not null check (state in ('accepted', 'done', 'retired')),
     outcome text check ((state = 'done') = (outcome is not null)),
     revision integer check ((state = 'accepted') = (revision is null)),
     created_at text not null,
     primary key (principal, client, id)) strict;
   create index commands_revision on commands(principal, client, revision);
   create trigger commands_never_deleted before delete on commands
     begin select raise(abort, 'a command key is kept forever: retire it'); end;
   create table jobs(
     id integer primary key,
     kind text not null check (length(kind) > 0),
     key text not null,
     state text not null check (state in ('due', 'running', 'done', 'failed')),
     due_at text not null, deadline_at text not null,
     attempts integer not null default 0 check (attempts >= 0),
     note text,
     result text check ((state = 'done') = (result is not null)),
     who text check ((state = 'failed') = (who is not null) and (who is null or who in ('you', 'us', 'gone'))),
     reason text check ((state = 'failed') = (reason is not null)),
     asked_by text not null default '[]',
     created_at text not null, updated_at text not null);
   create unique index jobs_open on jobs(kind, key) where state in ('due', 'running');
   create table revisions(revision integer primary key, at text not null) strict;
   insert into meta(key, value) values ('revision', '1'), ('history_floor', '1'),
     ('dataset', lower(hex(randomblob(12))));`;

/** A replicated table's triggers, by name after the table's. */
const TRIGGERS = ["stamped_insert", "stamped_update", "never_deleted"] as const;

/**
 * A replicated table's triggers: every write carries the revision stamped in its own transaction; no delete. Trigger
 * names are the database's and a rename keeps them on the renamed table, so they're dropped first: a table that took
 * a replicated table's name gets them, never silently none.
 */
function stamped(table: string): string {
  const revision = "(select cast(value as integer) from meta where key = 'revision')";
  const stamping = "(select cast(value as integer) from meta where key = 'stamping')";

  return [
    ...TRIGGERS.map((trigger) => `drop trigger if exists ${table}_${trigger};`),
    ...["insert", "update"].map(
      (event) => `create trigger ${table}_stamped_${event} before ${event} on ${table}
     when new.revision is not ${revision} or ${revision} is not ${stamping}
     begin select raise(abort, 'a replicated row must carry a revision stamped in its own transaction'); end;`
    ),
    `create trigger ${table}_never_deleted before delete on ${table}
     begin select raise(abort, 'a replicated row is never deleted: tombstone it'); end;`,
  ].join("\n");
}

/** An app's store schema: its own tables at `baseVersion`, and the migrations since, one version each. */
export type StoreSchema = {
  /** The app's tables as a new store starts them (the core tables come first, made by the kit). */
  base: string;
  /**
   * Tables a replica holds: stamped and never deleted, by trigger. The kit makes the triggers for each, whether the
   * base or a migration makes the table, and again on a table a migration rebuilds.
   */
  replicated: readonly string[];
  baseVersion: number;
  /** Each moves the schema one version up from `baseVersion`; never edit a shipped one, append. */
  migrations: readonly string[];
  /** Indexes that only speed reads, made at every open: no row's meaning depends on one. */
  indexes?: string;
};

/** The store schema a release writes: what `version --json` reports and a rollback compares. */
export function schemaVersion(schema: StoreSchema): number {
  return schema.baseVersion + schema.migrations.length;
}

const DAY = 86_400_000;

/** What `<path>.head` holds: the newest revision of a dataset that left the server. */
const HEAD = object({ dataset: string(), revision: number() });

/** Retention reads no receipt or result: these stand in for an app's own codecs. */
const OPAQUE = {
  encode: (value: unknown) => JSON.stringify(value),
  decode: (text: string): unknown => text,
};

/** A safe name for a table: it is spliced into the trigger SQL. */
const TABLE = /^[a-z_][a-z0-9_]*$/;

export type StoreOptions = {
  /** The app's name, as a refusal says it ("update <name>"). */
  name: string;
  schema: StoreSchema;
  now?: () => number;
};

export class SyncStore {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly now: () => number;
  /**
   * Set when the store opened older than what it had already served (restored from a backup), or a caller proved it
   * went back: the dataset and revision it had served, and its revision then. It took a new dataset, so every replica
   * starts over and no intent made against the lost history runs here.
   */
  restored: { dataset: string; served: number; revision: number } | undefined;
  private readonly head: string;
  private servedHead: { dataset: string; revision: number } | undefined;
  private depth = 0;

  constructor(path: string, options: StoreOptions) {
    const { schema } = options;

    for (const table of schema.replicated) {
      if (!TABLE.test(table)) {
        throw new Error(`not a table name: ${table}`);
      }
    }

    this.path = path;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);

    const version = this.userVersion();
    const latest = schemaVersion(schema);
    // A file at version 0 is new only while it holds nothing: one with tables is from before any release could say.
    const empty = this.db.prepare("select count(*) as n from sqlite_master").get()?.n === 0;

    const refused =
      version > latest
        ? `The store is from a newer version (schema ${version}); update ${options.name}`
        : (version > 0 || !empty) && version < schema.baseVersion
          ? `The store is at schema ${version}, from before ${schema.baseVersion}, the schema this release starts from: it can't be opened`
          : undefined;

    if (refused !== undefined) {
      this.db.close();
      throw new Error(refused);
    }

    // FULL: a commit is on the disk before it is acknowledged.
    this.db.exec("pragma journal_mode = wal; pragma synchronous = full; pragma foreign_keys = on;");
    this.migrate(schema, version);
    this.head = `${path}.head`;
    this.restored = this.checkHead();
  }

  private userVersion(): number {
    return Number(this.db.prepare("pragma user_version").get()?.user_version ?? 0);
  }

  private migrate(schema: StoreSchema, version: number): void {
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(CORE_TABLES);
        this.db.exec(schema.base);
        this.stampTables(schema);
        this.db.exec(`pragma user_version = ${schema.baseVersion}`);
      });
    }

    const from = Math.max(version, schema.baseVersion);
    const latest = schemaVersion(schema);
    const backup = `${this.path}.schema-${from}.bak`;

    if (version > 0 && version < latest && !existsSync(backup)) {
      this.db.prepare("vacuum into ?").run(backup);
    }

    for (let next = from; next < latest; next++) {
      // A rebuild drops tables other tables reference; foreign keys are checked once it is done.
      this.db.exec("pragma foreign_keys = off");

      try {
        this.transaction(() => {
          this.db.exec(schema.migrations[next - schema.baseVersion] ?? "");
          // A table this migration made or rebuilt is stamped in the transaction that made it.
          this.stampTables(schema);
          this.db.exec(`pragma user_version = ${next + 1}`);
          const broken = this.db.prepare("pragma foreign_key_check").all();

          if (broken.length > 0) {
            throw new Error(`Migration ${next + 1} leaves ${broken.length} broken references`);
          }
        });
      } finally {
        this.db.exec("pragma foreign_keys = on");
      }
    }

    // Every replicated table exists by now. One an earlier release migrated may be unstamped: stamped here, writing
    // only then, so opening a store another process is writing to doesn't wait on it.
    const { missing, unstamped } = this.replicatedTables(schema);

    if (missing.length > 0) {
      throw new Error(`Replicated tables the schema never makes: ${missing.join(", ")}`);
    }

    if (unstamped.length > 0) {
      this.transaction(() => this.stampTables(schema));
    }

    if (schema.indexes !== undefined) {
      this.db.exec(schema.indexes);
    }
  }

  /** The replicated tables that don't exist yet, and those that exist without all their triggers. */
  private replicatedTables(schema: StoreSchema) {
    const exists = this.db.prepare("select 1 from sqlite_master where type = 'table' and name = ?");

    const triggers = this.db.prepare(
      "select count(*) as n from sqlite_master where type = 'trigger' and tbl_name = ? and name in (?, ?, ?)"
    );

    const missing: string[] = [];
    const unstamped: string[] = [];

    for (const table of schema.replicated) {
      if (exists.get(table) === undefined) {
        missing.push(table);
      } else if (
        triggers.get(table, ...TRIGGERS.map((trigger) => `${table}_${trigger}`))?.n !== 3
      ) {
        unstamped.push(table);
      }
    }

    return { missing, unstamped };
  }

  /** Stamp every replicated table that exists now and isn't yet. */
  private stampTables(schema: StoreSchema): void {
    for (const table of this.replicatedTables(schema).unstamped) {
      this.db.exec(stamped(table));
    }
  }

  /** The head beside the store: a store that opens behind what it served went back, and takes a new dataset. */
  private checkHead(): SyncStore["restored"] {
    let head: unknown;

    try {
      head = JSON.parse(readFileSync(this.head, "utf-8"));
    } catch {
      return undefined;
    }

    const read = check(HEAD, head);

    if (!read.ok) {
      return undefined;
    }

    const { dataset, revision: served } = read.value;

    if (dataset !== this.dataset() || this.revision() >= served) {
      return undefined;
    }

    const replaced = { dataset, served, revision: this.revision() };
    this.setMeta("dataset", randomBytes(12).toString("hex"));

    return replaced;
  }

  /** A caller proved this store went back: it holds `seen` of this very dataset, more than the store has. */
  wentBack(seen: number): boolean {
    if (seen <= this.revision()) {
      return false;
    }

    this.restored = { dataset: this.dataset(), served: seen, revision: this.revision() };
    this.setMeta("dataset", randomBytes(12).toString("hex"));

    return true;
  }

  /** Record that `revision` of this dataset left the server (a pull or push reply), before the reply does. */
  served(revision: number): void {
    const dataset = this.dataset();
    const last = this.servedHead;

    if (last !== undefined && last.dataset === dataset && last.revision >= revision) {
      return;
    }

    const temporary = `${this.head}.tmp`;
    const fd = openSync(temporary, "w", 0o600);

    try {
      const bytes = Buffer.from(JSON.stringify({ dataset, revision }), "utf-8");

      for (let at = 0; at < bytes.length;) {
        at += writeSync(fd, bytes, at, bytes.length - at);
      }

      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temporary, this.head);
    // The rename itself on the disk too.
    const dir = openSync(dirname(this.head), "r");

    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }

    this.servedHead = { dataset, revision };
  }

  close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  /** All of `body` or none of it. Nested calls join the outer transaction: a failure anywhere undoes all of it. */
  transaction<T>(body: () => T): T {
    if (this.depth > 0) {
      return body();
    }

    this.db.exec("begin immediate");
    this.depth++;

    try {
      const result = body();
      this.db.exec("delete from meta where key = 'stamping'");
      this.db.exec("commit");

      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    } finally {
      this.depth--;
    }
  }

  meta(key: string): string | undefined {
    const value = this.db.prepare("select value from meta where key = ?").get(key)?.value;

    return typeof value === "string" ? value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value"
      )
      .run(key, value);
  }

  /** This store's identity: a replica of another store starts over. */
  dataset(): string {
    let dataset = this.meta("dataset");

    if (dataset === undefined) {
      dataset = randomBytes(12).toString("hex");
      this.setMeta("dataset", dataset);
    }

    return dataset;
  }

  revision(): number {
    return Number(this.meta("revision") ?? 0);
  }

  /** The store's clock as stored: now, or `at` (milliseconds). */
  iso(at?: number): string {
    return new Date(at ?? this.now()).toISOString();
  }

  /**
   * Whether `revision` is one of this history: none (0), the head, at or before the floor (the revisions before they
   * were logged), or one this store stamped and still remembers. A page holding another came from a history this store
   * doesn't have (a restore's lost future), or is older than the log keeps: it starts over, and its taps don't run.
   */
  known(revision: number): boolean {
    if (revision === 0 || revision === this.revision()) {
      return true;
    }

    if (revision <= Number(this.meta("history_floor") ?? 0)) {
      return true;
    }

    return (
      this.db.prepare("select 1 from revisions where revision = ?").get(revision) !== undefined
    );
  }

  /**
   * The next revision, for rows written in the current transaction: past the last, and at least the clock in
   * microseconds (plus a random part below a millisecond), so two histories forked from one copy never stamp the same
   * number while the clock moves forward. Each is logged (`known`).
   */
  stamp(): number {
    if (!this.db.isTransaction) {
      throw new Error("A revision is stamped inside the transaction that writes its rows");
    }

    const next = Math.max(
      this.revision() + 1,
      this.now() * 1000 + Math.floor(Math.random() * 1000)
    );

    if (!Number.isSafeInteger(next)) {
      throw new TypeError(`Revision ${next} is past a safe integer`);
    }

    this.db.prepare("insert into revisions(revision, at) values (?, ?)").run(next, this.iso());
    this.setMeta("revision", String(next));
    this.setMeta("stamping", String(next));

    return next;
  }

  /** The command ledger (`slopkit/server/ledger`) on this store: its transaction and its stamp. */
  createLedger<K>(codec: {
    encode: (receipt: K) => string;
    decode: (text: string) => K;
    recover?: (command: { name: string; args: string }) => K;
  }): Ledger<K> {
    return new Ledger<K>({
      db: this.db,
      transaction: (body) => this.transaction(body),
      stamp: () => this.stamp(),
      encode: codec.encode,
      decode: codec.decode,
      ...(codec.recover === undefined ? {} : { recover: codec.recover }),
    });
  }

  /** Jobs (`slopkit/server/jobs`) on this store. */
  createJobs<R>(codec: { encode: (result: R) => string; decode: (text: string) => R }): Jobs<R> {
    return new Jobs<R>({
      db: this.db,
      transaction: (body) => this.transaction(body),
      encode: codec.encode,
      decode: codec.decode,
      now: this.now,
    });
  }

  /**
   * Retention, which never deletes a key: receipts accepted more than `receiptsMs` ago retire (their outcome dropped, never acting
   * again), logged revisions older than `revisionsMs` are forgotten except the head (a page holding one starts over),
   * and finished jobs beyond the newest `jobsKept` of each kind are pruned.
   */
  retain(options: { receiptsMs?: number; revisionsMs?: number; jobsKept?: number } = {}): void {
    const now = this.now();

    this.transaction(() => {
      this.createLedger(OPAQUE).retire(this.iso(now - (options.receiptsMs ?? 90 * DAY)));

      this.db
        .prepare("delete from revisions where at < ? and revision <> ?")
        .run(this.iso(now - (options.revisionsMs ?? 400 * DAY)), this.revision());
    });

    this.createJobs(OPAQUE).prune(options.jobsKept ?? 200);
  }
}
