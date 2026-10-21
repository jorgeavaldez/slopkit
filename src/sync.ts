/**
 * The client half of sync, pure: a replica of the server's tables, the commands this browser sent, and the link to the
 * server, as one state machine `update(model, msg) → [model, effects]`. It reads no clock, storage or network: ports do
 * that and answer with messages (`client.ts` runs it), so the same rules run, and are checked, in model replays, in the
 * headless simulation over real stores and in the browser alike.
 *
 * Invariants it owns:
 * - **The replica only moves forward.** A delta applies only to the same dataset with `since ≤ copy.revision ≤
 *   reply.revision`; only a reset replaces the copy (a late one is dropped), and a reply it can't follow asks for a
 *   real reset instead of leaving a gap. The disk commit is decided again against what the disk holds, inside its own
 *   transaction (`commitPlan`), so another tab or a failed write can't make the disk go back or skip a patch.
 * - **A copy never claims more history than it holds.** It is complete or partial (`History`): every row it holds is
 *   the server's row at its revision, and a partial copy holds every row at or above its cursor, so every row at or
 *   above `through`. The first reply draws the newest rows at once; the cursor moves only when a reply answers the
 *   copy's own `next`, a reply without a page never changes it, and a row merged below `through` never deepens it.
 *   The disk takes a page's history only from the cursor it moved from, in the transaction that writes its rows.
 * - **A partial copy owes its next page**, back to back, until it is complete; a reply that doesn't move it on counts
 *   as a failed pull, for backoff. An old server's reply to a partial copy asks for its whole copy instead.
 * - **Only a complete copy is checked.** No fingerprint is asked for or compared while the copy is partial.
 * - **A chunk costs its own size.** Merging a reply doesn't copy the tables it lands in (`Layered`).
 * - **Observed is not saved.** `saved` is what the disk is known to hold; a failed commit is retried whole until the
 *   disk catches up (a later page the disk takes as a delta under its own history doesn't), and until then the page
 *   says so.
 * - **A pull is owed while the server is ahead.** `target` is the newest revision the server is known to have (pokes,
 *   which also beat every 20 s, push replies, receipts); while the replica is behind it a pull is in flight or
 *   scheduled, whatever the socket says. Liveness, the known head and the last reconciliation are separate facts.
 * - **A command id is never reused.** Each page load is a new client with its own numbers; commands loaded from an
 *   earlier page keep theirs.
 * - **Nothing is sent before it is kept.** An intent the device can't keep fails at once, visibly, and is never sent.
 *   A push is journalled before it goes: its commands are kept as `sending` (one write per push), so a page that dies
 *   mid-push leaves them uncertain on disk, and none goes unless that write lands.
 * - **Every command reaches an outcome, and is settled only once the replica holds its effects** (a receipt names the
 *   revision that made it visible; on a partial copy, only a pull reply that carried the receipt, with the rows it
 *   names, settles it); until then a pull is owed, and names the commands it waits on, any page's.
 * - **Every waiting state ends.** Pulling, pushing, retrying and saving have deadlines or backoff; storage that is slow
 *   to load or keep is said (the page goes on from the server meanwhile), and its late answer still counts: a slow
 *   write is not a failed one.
 * - **An intent belongs to the dataset it was made against**: the server refuses it against a replacement.
 * - **A refusal proves only that attempt didn't act.** Only the kit's own error body is final; anything else may have
 *   acted and leaves the command unknown, kept so. A command an attempt of which may have acted never becomes a final
 *   failure: a refusal naming it parks it (never sent again, still named in pulls, done when a receipt comes). A schema
 *   refusal naming one command of a push is that command's alone; the rest return to what they were and go again.
 * - **A push fits the server's bounds**: at most `pushMax` commands and `pushBytes` bytes, oldest first, stopping at
 *   the first command that doesn't fit. One too large even alone is answered at the tap and never kept; one already
 *   kept is refused (or parked) and passed over, so it never strands the rest.
 * - **The outbox is bounded across tabs.** The store admits a new command inside its own write transaction, from its
 *   own count; one it has no room for is answered and never retained. Kept commands always update and are never
 *   dropped for room.
 */
import type { Failure } from "./contract.ts";
import { unreachable } from "./machine.ts";
import { check } from "./schema.ts";
import type { Schema } from "./schema.ts";

export type Key = string | number;

/** One row's change, as the disk stores it: a value under its key, or the key gone. */
export type Op =
  | { table: string; key: Key; row: unknown }
  | { table: string; key: Key; drop: true };

/**
 * A replicated table: how its rows arrive in a patch, how they are keyed, which are tombstones, where they live in
 * the app's typed tables `T`, and the schema rows read back from disk must fit. Built with `table()`.
 */
export type Lens<T, P> = {
  readonly name: string;
  /** The table's name and its row schema's full shape: a stored copy is read only under the shape that wrote it. */
  readonly shape: string;
  /** This table's rows in a patch, as disk operations. */
  ops: (rows: P) => Op[];
  /** This table's rows in a patch, applied to typed tables (from empty for a reset). */
  apply: (tables: T, rows: P, reset: boolean) => T;
  /** Everything this table holds, as disk operations: a whole-replica write. */
  snapshot: (tables: T) => Op[];
  /** Rows read back from disk, checked: the tables with them, or undefined if any doesn't fit. */
  restore: (tables: T, values: readonly { key: Key; row: unknown }[]) => T | undefined;
};

/** A key a chunk removed, in a table's layer of changes. */
const GONE = Symbol("gone");

/**
 * A table's rows after a chunk, without copying the rows it already had: the chunk's changes are a layer over them, so
 * merging a chunk costs its own size, not the table's. Layers merge when a newer one is as big as the one below it, and
 * fold into a plain map once the top one holds half as many keys as it, so lookups pass a logarithmic number of layers
 * and a changed row is copied a logarithmic number of times. Immutable: a published value never changes.
 */
class Layered<K, V> implements ReadonlyMap<K, V> {
  readonly size: number;
  readonly base: ReadonlyMap<K, V>;
  /** Newest first. */
  readonly layers: readonly ReadonlyMap<K, V | typeof GONE>[];

  constructor(
    base: ReadonlyMap<K, V>,
    layers: readonly ReadonlyMap<K, V | typeof GONE>[],
    size: number
  ) {
    this.base = base;
    this.layers = layers;
    this.size = size;
  }

  private find(key: K): V | typeof GONE | undefined {
    for (const each of this.layers) {
      if (each.has(key)) {
        return each.get(key);
      }
    }

    return this.base.get(key);
  }

  get(key: K): V | undefined {
    const value = this.find(key);

    return value === GONE ? undefined : value;
  }

  // Rows are never undefined.
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  // The base's keys in place, then new keys in the order they first came.
  *entries(): MapIterator<[K, V]> {
    for (const key of this.base.keys()) {
      const value = this.get(key);

      if (value !== undefined) {
        yield [key, value];
      }
    }

    const seen = new Set<K>();

    for (let at = this.layers.length - 1; at >= 0; at--) {
      for (const key of this.layers[at]?.keys() ?? []) {
        const value = this.get(key);

        if (!seen.has(key) && !this.base.has(key) && value !== undefined) {
          seen.add(key);
          yield [key, value];
        }
      }
    }
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Map's receiver is whatever the caller passes
  forEach(each: (value: V, key: K, map: ReadonlyMap<K, V>) => void, receiver?: unknown): void {
    for (const [key, value] of this.entries()) {
      each.call(receiver, value, key, this);
    }
  }
}

/** `rows` with `changes` over it, as a new value; `rows` is left as it was. */
function overlay<K, V>(
  rows: ReadonlyMap<K, V>,
  changes: Map<K, V | typeof GONE>
): ReadonlyMap<K, V> {
  let size = rows.size;

  for (const [key, value] of changes) {
    size += (value === GONE ? 0 : 1) - (rows.has(key) ? 1 : 0);
  }

  const base = rows instanceof Layered ? rows.base : rows;
  const below = rows instanceof Layered ? [...rows.layers] : [];
  let top: ReadonlyMap<K, V | typeof GONE> = changes;

  while (below[0] !== undefined && below[0].size <= top.size) {
    top = new Map([...(below.shift() ?? []), ...top]);
  }

  const layered = new Layered(base, [top, ...below], size);

  return top.size * 2 < base.size ? layered : new Map(layered);
}

export function table<T, P, R>(def: {
  name: string;
  schema: Schema<R>;
  rows: (patch: P) => readonly R[];
  key: (row: R) => Key;
  gone?: (row: R) => boolean;
  get: (tables: T) => ReadonlyMap<Key, R>;
  set: (tables: T, rows: ReadonlyMap<Key, R>) => T;
}): Lens<T, P> {
  const gone = (row: R) => def.gone?.(row) === true;

  return {
    name: def.name,
    shape: `${JSON.stringify(def.name)}:${def.schema.shape}`,
    ops: (rows) =>
      def
        .rows(rows)
        .map((row) =>
          gone(row)
            ? { table: def.name, key: def.key(row), drop: true }
            : { table: def.name, key: def.key(row), row }
        ),
    apply: (tables, rows, reset) => {
      const changed = def.rows(rows);

      if (changed.length === 0 && !reset) {
        return tables;
      }

      const changes = new Map<Key, R | typeof GONE>();

      for (const row of changed) {
        changes.set(def.key(row), gone(row) ? GONE : row);
      }

      return def.set(tables, overlay(reset ? new Map<Key, R>() : def.get(tables), changes));
    },
    snapshot: (tables) =>
      [...def.get(tables).entries()].map(([key, row]) => ({ table: def.name, key, row })),
    restore: (tables, values) => {
      const next = new Map<Key, R>();

      for (const value of values) {
        const parsed = check(def.schema, value.row);

        if (!parsed.ok || def.key(parsed.value) !== value.key) {
          return undefined;
        }

        next.set(value.key, parsed.value);
      }

      return def.set(tables, next);
    },
  };
}

/**
 * How much of the server's history a copy holds. Complete: every row. Partial: every row at or above the keyset cursor
 * `next` (the server's opaque cursor of the next older page), so every row at or above `through` (the fully covered
 * boundary, as the app formats it; null while no order group is whole); `held` of `total` is progress, not a claim.
 */
export type History =
  | { kind: "complete" }
  | { kind: "partial"; next: string; through: string | null; held: number; total: number };

/**
 * A paged reply's place in the history: `from` is the cursor it answered (null on a reset's first page), `next` the
 * next older one (null once complete), `through`, `held` and `total` as in `History`, at the reply's revision.
 */
export type Page = {
  from: string | null;
  next: string | null;
  through: string | null;
  held: number;
  total: number;
};

export type Replica<T, S> = {
  dataset: string | null;
  revision: number;
  tables: T;
  /** What the server says about itself, read with every pull. */
  server: S | null;
  /** How much of the history it holds; absent (a copy from before paging) is complete. */
  history?: History;
};

/** A pull reply as sync sees it: rows changed since the pull's `since`, or everything (`reset`). */
export type Patch<P, S> = {
  dataset: string;
  revision: number;
  reset: boolean;
  rows: P;
  server: S;
  checksum?: string;
  /** A paging server's place in the history: absent from an old server, whose reset is the whole copy. */
  page?: Page;
};

const COMPLETE: History = { kind: "complete" };

const historyOf = (replica: Replica<unknown, unknown>): History => replica.history ?? COMPLETE;

/** The history a page leaves: complete without one (an old server's whole copy) or once no older page is left. */
const covered = (page: Page | undefined): History =>
  page === undefined || page.next === null
    ? COMPLETE
    : {
        kind: "partial",
        next: page.next,
        through: page.through,
        held: page.held,
        total: page.total,
      };

/**
 * A command's outcome as the server recorded it, and the revision at which its effects are visible. `client` names an
 * earlier page's command (absent: the pull's or push's own client).
 */
export type Receipt<O> = { id: number; outcome: O; revision: number; client?: string };

export type CommandState<O> =
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "sending" }
  /**
   * An attempt's outcome was lost: it may have acted. `parked`: the server refused it by name since, which proves only
   * that attempt didn't act, so it is never sent again and waits on a pull to bring the receipt an earlier one left; it
   * needs the person's attention meanwhile.
   */
  | { kind: "unknown"; failure: string; parked?: true }
  | { kind: "done"; outcome: O; revision: number };

export type Pending<C, O> = {
  client: string;
  id: number;
  /** The server's dataset when it was tapped (null before the page ever heard of one). */
  dataset: string | null;
  /**
   * The revision of the copy it was tapped against (0 before any): the push carries it, so a server can refuse an
   * intent made against a history it no longer has, even once the page has moved to the current one. Absent on a
   * command an older release kept: it takes the revision of the copy loaded with it.
   */
  since?: number;
  command: C;
  at: number;
  state: CommandState<O>;
};

export type Connection =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "stale" }
  | { kind: "offline"; failure: string }
  | { kind: "signed-out" }
  | { kind: "incompatible"; failure: string };

/**
 * The outbox's room, as a closed subject for the app's state table: full when it holds `max` commands. `waiting`
 * (unsent or unknown) needs a connection; `finished` (done, kept until dismissed) needs the person to dismiss them.
 */
export type OutboxState =
  | { kind: "ok" }
  | { kind: "full"; waiting: number; finished: number; max: number };

/** The store's answer to a new command it had no room for: its own counts, across every tab. */
export type OutboxFull = Extract<OutboxState, { kind: "full" }>;

/** This device's copy: fine, failing (writes are retried), or forgotten under this page by another tab. */
export type Storage = { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "replaced" };

export type Model<T, S, C, O> = {
  client: string;
  nextId: number;
  boot: { kind: "loading"; since: number } | { kind: "ready" };
  storage: Storage;
  replica: Replica<T, S>;
  /** What the disk is known to hold, and the whole-replica write owed while it is behind. */
  saved: {
    dataset: string | null;
    revision: number;
    /** Since when the page has shown more than the disk holds (null while the disk has it all): slow is said. */
    behindSince: number | null;
    writing: number;
    failures: number;
    nextAt: number;
    /**
     * A write failed and only a whole one (or one the disk took whole) repairs it: a later page landing as a delta
     * doesn't, since the disk still lacks the failed page's rows.
     */
    owed: boolean;
  };
  target: number;
  /**
   * A reset this copy asks for: `paged` after a reply it couldn't apply (another dataset without a reset, a gap),
   * `whole` (no `page`, as an old server understands) after an old server answered a partial copy.
   */
  restart: "paged" | "whole" | null;
  /** When a pull last succeeded: freshness, apart from the socket's liveness. */
  reconciledAt: number | null;
  connection: Connection;
  socket: { open: boolean; heardAt: number };
  pull:
    | { kind: "idle"; nextAt: number; failures: number }
    | { kind: "pulling"; since: number; failures: number };
  push:
    | { kind: "idle"; nextAt: number; failures: number }
    | {
        kind: "pushing";
        client: string;
        ids: readonly number[];
        /** Each command's state before this attempt, by position in `ids`: what a refusal restores. */
        was: readonly CommandState<O>[];
        failures: number;
      };
  commands: readonly Pending<C, O>[];
  /**
   * The most commands the outbox admits, and the store's counts when it last refused one for room (it is shared with
   * other tabs, whose commands this page doesn't hold); cleared once one is admitted or this page drops some.
   */
  outbox: { max: number; full: OutboxFull | null };
  /** Where the next pull's list of waiting commands starts, when more wait than one pull names. */
  asking: number;
  /** Commands (`client:id`) whose receipt came in a pull reply this copy applied, so with the rows it names. */
  carried: ReadonlySet<string>;
  /** Commands an earlier page kept that this version can't read: left on disk, and said. */
  unreadable: number;
  visible: boolean;
  /**
   * Self-check, once a session: right after load, the replica's fingerprint is compared with the server's at the same
   * revision, so it checks what the disk held. A mismatch starts over, at most twice.
   */
  verify:
    | { kind: "pending"; tries: number }
    | { kind: "requested"; tries: number }
    | { kind: "done"; match: boolean };
  now: number;
};

export type Msg<T, P, S, C, O> =
  | {
      type: "loaded";
      replica: Replica<T, S>;
      commands: Pending<C, O>[];
      unreadable: number;
      now: number;
    }
  | { type: "loadFailed"; reason: string; now: number }
  | { type: "pulled"; since: number; patch: Patch<P, S>; receipts: Receipt<O>[]; now: number }
  | { type: "pullFailed"; failure: Failure; now: number }
  | {
      type: "pushed";
      client: string;
      ids: number[];
      receipts: Receipt<O>[];
      revision: number;
      now: number;
    }
  | { type: "pushFailed"; client: string; ids: number[]; failure: Failure; now: number }
  /** A push's in-flight mark couldn't be kept, so it was never sent. */
  | {
      type: "unsent";
      client: string;
      ids: number[];
      reason: string;
      replaced: boolean;
      now: number;
    }
  /**
   * The disk holds the replica at `revision` (perhaps newer than asked, from another tab); `whole: false` when it took
   * the patch as a delta under its own, other history.
   */
  | { type: "committed"; dataset: string; revision: number; whole?: boolean; now: number }
  | { type: "commitFailed"; reason: string; replaced: boolean; now: number }
  | { type: "kept"; client: string; id: number; now: number }
  | { type: "keepFailed"; client: string; id: number; reason: string; now: number }
  /** The outbox had no room for a new command: it was not kept. */
  | ({ type: "full"; client: string; id: number; now: number } & Omit<OutboxFull, "kind">)
  /** Finished commands left the outbox (`failure` if not: they fade again on the next load). */
  | { type: "dropped"; failure: string | null; now: number }
  | { type: "socket"; open: boolean; now: number }
  | { type: "heard"; revision: number; now: number }
  | { type: "tick"; now: number }
  | { type: "visible"; visible: boolean; now: number }
  | { type: "command"; command: C; now: number }
  /** The person is done with a finished command: it leaves the page and the outbox. Anything not done stays. */
  | { type: "dismiss"; client: string; id: number; now: number }
  | { type: "checked"; dataset: string | null; revision: number; match: boolean; now: number };

/** A disk commit: the patch as operations, and the whole replica for when the disk can't take it as a delta. */
export type Commit<T, S> = {
  replica: Replica<T, S>;
  ops: Op[];
  /** The patch replaces everything (or this is a whole-replica write). */
  reset: boolean;
  /** The revision the patch starts from: the disk takes it as a delta only if it is at least there. */
  base: number;
  /** The cursor the copy held before this patch: the disk adopts the patch's history only from that same cursor. */
  from?: string | null;
  /** The dataset this page last knew the disk to hold: the only one it may replace with another. */
  replaces: string | null;
};

export type Effect<T, S, C, O> =
  | { kind: "load" }
  | {
      kind: "pull";
      client: string;
      dataset: string | null;
      since: number;
      verify: boolean;
      /** The older page wanted (null: none, but a paged reset is understood); absent asks an old server's whole reply. */
      page?: string | null;
      /** Commands still waiting on an outcome or on their effects, any page's: their receipts come with their rows. */
      commands: { client: string; id: number }[];
    }
  | {
      kind: "push";
      client: string;
      dataset: string | null;
      /**
       * The revision of the copy these commands were tapped against (they share it): the server refuses intents made
       * against a history it doesn't have.
       */
      since: number;
      commands: { id: number; command: C }[];
    }
  | ({ kind: "commit" } & Commit<T, S>)
  /** Keep a command: a new one only while the outbox holds fewer than `max` (decided by the store). */
  | { kind: "keep"; pending: Pending<C, O>; max: number }
  | { kind: "drop"; keys: { client: string; id: number }[] }
  | { kind: "check"; replica: Replica<T, S>; checksum: string }
  /** A command reached its outcome (for the app: open a window, close one). */
  | { kind: "answered"; pending: Pending<C, O> }
  | {
      kind: "telemetry";
      name: string;
      attributes: Record<string, string | number | boolean | null>;
    };

/** What an app tells sync about itself. */
export type Spec<T, P, S, C, O> = {
  tables: readonly Lens<T, P>[];
  empty: T;
  /** Commands that need the server now: refused at once while it can't be reached, never queued. */
  onlineOnly: (command: C) => boolean;
  /** An ask that a waiting one stands for (a sync not yet sent covers the next tap too). */
  joins?: (waiting: C, next: C) => boolean;
  /** The server has work in flight for this page (an open link, a running job): poll while so. */
  outstanding?: (replica: Replica<T, S>) => boolean;
  /** The outcome of a command that failed on the page and was never sent. */
  refused: (command: C, message: string) => O;
  /**
   * Whether a done command is resolved for the person: only a resolved one fades, `DONE_KEEP_MS` after it settles. An
   * unresolved one (an outcome not known, an effect still finishing elsewhere) stays drawn and kept, across reloads,
   * until it resolves or the person dismisses it. Default: every outcome is resolved.
   */
  resolved?: (pending: Pending<C, O>, model: Model<T, S, C, O>) => boolean;
  /** The most commands one push carries: the push endpoint's own bound. Default `PUSH_MAX`. */
  pushMax?: number;
  /**
   * The most UTF-8 bytes of one push request, encoded whole: the push endpoint's body limit (`serveWeb.bodyLimit`)
   * must be at least this. Default `PUSH_BYTES`.
   */
  pushBytes?: number;
  /** The most commands the device's outbox admits, shared by every tab. Default `OUTBOX_MAX`. */
  outboxMax?: number;
};

/** The socket must be heard this often (the server pokes every 20 s); quieter, the page polls. */
export const SOCKET_DEADLINE_MS = 45_000;

/** Polling while the socket can't be trusted or work is in flight, and the first retry after a failure. */
export const POLL_MS = 4000;
const BACKOFF_MAX_MS = 30_000;

/** Storage gets this long to load, or to keep an intent, before the page goes on without it. */
export const STORAGE_DEADLINE_MS = 3000;

/** Commands per push unless the spec says otherwise; the rest wait for the next push. */
export const PUSH_MAX = 50;

/** UTF-8 bytes of one push request unless the spec says otherwise (48 KiB). */
export const PUSH_BYTES = 49_152;

/** Commands the outbox admits unless the spec says otherwise; updates to kept ones always are. */
export const OUTBOX_MAX = 500;

/** Settled commands stay drawn this long. */
export const DONE_KEEP_MS = 60_000;

/** A string's length in UTF-8 bytes, as it goes on the wire. */
function utf8(text: string): number {
  let bytes = 0;

  // By code point: a surrogate pair is one character of four bytes, a lone surrogate encodes as three.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }

  return bytes;
}

/** A push's bytes as `call` encodes it: this envelope, each command's bytes, and a comma between commands. */
const envelope = (client: string, dataset: string | null, since: number) =>
  utf8(JSON.stringify({ client, dataset, since, commands: [] }));

const bytesOf = (pending: { id: number; command: unknown }) =>
  utf8(JSON.stringify({ id: pending.id, command: pending.command }));

/**
 * Where the outbox stands: full once it holds `max` commands, by this page's count or, failing that, by the store's
 * last refusal (other tabs' commands count too). Unreadable kept commands take room as well.
 */
export function deriveOutboxState<T, S, C, O>(model: Model<T, S, C, O>): OutboxState {
  const finished = model.commands.filter((each) => each.state.kind === "done").length;
  const waiting = model.commands.length - finished + model.unreadable;

  if (waiting + finished >= model.outbox.max) {
    return { kind: "full", waiting, finished, max: model.outbox.max };
  }

  return model.outbox.full ?? { kind: "ok" };
}

/** The command a push's schema path names (`request.commands[2].command.value` names 2), if it names one. */
function commandAt(path: string | undefined): number | undefined {
  const found = /^request\.commands\[(\d+)\](?:$|[.[])/.exec(path ?? "");

  return found?.[1] === undefined ? undefined : Number(found[1]);
}

/** Whether the server can be asked now. */
export function reachable(connection: Connection): boolean {
  return connection.kind === "live" || connection.kind === "stale";
}

/**
 * Whether the replica holds this command's effects: it is done, and the copy is at its revision and either complete or
 * holding the rows its receipt names (a pull reply carried them). One that failed on the page has none.
 */
export function settled<T, S, C, O>(model: Model<T, S, C, O>, pending: Pending<C, O>): boolean {
  return (
    pending.state.kind === "done" &&
    (pending.state.revision === 0 ||
      (model.replica.revision >= pending.state.revision &&
        (historyOf(model.replica).kind === "complete" ||
          model.carried.has(`${pending.client}:${pending.id}`))))
  );
}

/**
 * Whether what the page shows is also on the disk: by revision only, so tabs at different cursors never chase each
 * other's writes. A failed write is owed again even at the same revision (a page that failed to land).
 */
export function saved<T, S, C, O>(model: Model<T, S, C, O>): boolean {
  return (
    model.saved.dataset === model.replica.dataset &&
    model.saved.revision >= model.replica.revision &&
    !model.saved.owed
  );
}

/**
 * What a commit does to the disk, decided inside the disk's own transaction from what it holds: nothing when the disk
 * already has this or newer (another tab got there; a complete copy at the same revision is newer than any page), the
 * patch alone when the disk is at least at its base, else the whole replica, so a skipped or failed patch is never
 * covered by a later checkpoint. A delta keeps the disk's own history, and takes the patch's only when the disk is at
 * the cursor the patch moved from (`adopt`): coverage never lands without its rows. A page may replace the disk's
 * dataset only with one it moved to from that very dataset (`replaces`): a tab still on a dataset the server has since
 * replaced is `stale` and never writes it back.
 */
export function commitPlan(
  stored: { dataset: string | null; revision: number; history?: History },
  commit: {
    dataset: string | null;
    revision: number;
    reset: boolean;
    base: number;
    replaces: string | null;
    from?: string | null;
  }
): "skip" | "delta" | "adopt" | "whole" | "stale" {
  const same = stored.dataset === commit.dataset;
  const disk = stored.history ?? COMPLETE;

  if (!same && stored.dataset !== null && stored.dataset !== commit.replaces) {
    return "stale";
  }

  if (
    same &&
    (stored.revision > commit.revision ||
      (stored.revision === commit.revision && disk.kind === "complete"))
  ) {
    return "skip";
  }

  if (!commit.reset && same && stored.revision >= commit.base) {
    return disk.kind === "partial" && disk.next === commit.from ? "adopt" : "delta";
  }

  return "whole";
}

/** How much history the page holds, as a closed subject for the app's state table. */
export type HistoryState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "complete" }
  | { kind: "partial"; through: string | null; held: number; total: number };

/**
 * The copy's history: loading while storage loads, none without a dataset, else partial or complete. Partial is a claim
 * beside the numbers ("history from <through>, loading older · held of total"), and totals cover only `through` and
 * above. Complete says nothing about storage: that is `deriveDurabilityState`, its own subject.
 */
export function deriveHistoryState<T, S, C, O>(model: Model<T, S, C, O>): HistoryState {
  if (model.boot.kind === "loading") {
    return { kind: "loading" };
  }

  if (model.replica.dataset === null) {
    return { kind: "none" };
  }

  const history = historyOf(model.replica);

  return history.kind === "complete"
    ? history
    : { kind: "partial", through: history.through, held: history.held, total: history.total };
}

/** Whether the page's copy is kept on this device, as a closed subject apart from how much history it holds. */
export type DurabilityState =
  | { kind: "loading" }
  | { kind: "unsaved" }
  | { kind: "lost"; reason: string }
  | { kind: "failing"; reason: string }
  | { kind: "replaced" }
  | { kind: "unreadable"; count: number }
  | { kind: "ok" };

/**
 * The copy's durability at the model's clock: loading, replaced by another tab, a failing store (lost while the page
 * shows more than the disk holds), unsaved past the storage deadline, commands kept that this version can't read, or ok.
 */
export function deriveDurabilityState<T, S, C, O>(model: Model<T, S, C, O>): DurabilityState {
  const behind = model.saved.behindSince;

  if (model.boot.kind === "loading") {
    return { kind: "loading" };
  }

  if (model.storage.kind === "replaced") {
    return { kind: "replaced" };
  }

  if (model.storage.kind === "failed") {
    return { kind: behind === null ? "failing" : "lost", reason: model.storage.reason };
  }

  if (behind !== null && model.now - behind >= STORAGE_DEADLINE_MS) {
    return { kind: "unsaved" };
  }

  return model.unreadable > 0 ? { kind: "unreadable", count: model.unreadable } : { kind: "ok" };
}

/**
 * Storage after a write that worked: a failure that only a keep or a drop had (the replica's own writes aren't
 * failing) is over; a replaced copy stays replaced.
 */
function working<T, S, C, O>(model: Model<T, S, C, O>): Storage {
  return model.storage.kind === "failed" && model.saved.failures === 0
    ? { kind: "ok" }
    : model.storage;
}

const blocked = (connection: Connection) =>
  connection.kind === "signed-out" || connection.kind === "incompatible";

const backoff = (failures: number) =>
  Math.min(BACKOFF_MAX_MS, POLL_MS * 2 ** Math.max(0, failures - 1));

/** How a failed call changes the link: signed out and incompatible stop asking until the person acts. */
function failedConnection(connection: Connection, failure: Failure): Connection {
  switch (failure.kind) {
    case "signed-out": {
      return { kind: "signed-out" };
    }

    case "invalid":
    case "unreadable": {
      return { kind: "incompatible", failure: failure.message };
    }

    case "forbidden":
    case "conflict":
    case "upstream":
    case "unavailable":
    case "offline": {
      return blocked(connection) ? connection : { kind: "offline", failure: failure.message };
    }

    default: {
      return unreachable(failure.kind);
    }
  }
}

export function createSync<T, P, S, C, O>(spec: Spec<T, P, S, C, O>) {
  const pushMax = spec.pushMax ?? PUSH_MAX;

  const pushBytes = spec.pushBytes ?? PUSH_BYTES;
  const outboxMax = spec.outboxMax ?? OUTBOX_MAX;

  for (const [name, value] of [
    ["pushMax", pushMax],
    ["pushBytes", pushBytes],
    ["outboxMax", outboxMax],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`sync: ${name} must be a positive integer, got ${value}`);
    }
  }

  type M = Model<T, S, C, O>;

  type E = Effect<T, S, C, O>;

  type Step = readonly [M, E[]];

  const emptyReplica = (): Replica<T, S> => ({
    dataset: null,
    revision: 0,
    tables: spec.empty,
    server: null,
    history: COMPLETE,
  });

  function initial(client: string, now: number): M {
    return {
      client,
      nextId: 1,
      boot: { kind: "loading", since: now },
      storage: { kind: "ok" },
      replica: emptyReplica(),
      saved: {
        dataset: null,
        revision: 0,
        behindSince: null,
        writing: 0,
        failures: 0,
        nextAt: now,
        owed: false,
      },
      target: 0,
      restart: null,
      reconciledAt: null,
      connection: { kind: "starting" },
      socket: { open: false, heardAt: 0 },
      pull: { kind: "idle", nextAt: now, failures: 0 },
      push: { kind: "idle", nextAt: now, failures: 0 },
      commands: [],
      outbox: { max: outboxMax, full: null },
      asking: 0,
      carried: new Set(),
      unreadable: 0,
      visible: true,
      verify: { kind: "pending", tries: 0 },
      now,
    };
  }

  /**
   * The one merge: a patch applied to a replica, with its disk operations; undefined when it is older than the replica
   * (a late reply), `gap` when it can't follow from it. Only a reset (or the answer to `since` 0, which holds
   * everything) replaces the copy, with its own history. A delta applies only to the same dataset with
   * `since ≤ copy.revision ≤ reply.revision` (equal only with a page or new server facts); it moves the cursor only when
   * it answers the copy's own `next`, and a reply without a page never changes the history.
   */
  function merge(
    replica: Replica<T, S>,
    patch: Patch<P, S>,
    since: number
  ): { replica: Replica<T, S>; ops: Op[]; reset: boolean } | "gap" | undefined {
    const reset = patch.reset || since === 0;
    const page = patch.page;
    const was = historyOf(replica);
    let history = was;

    if (reset) {
      // A reset older than what we hold of the same dataset is a late reply.
      if (patch.dataset === replica.dataset && patch.revision < replica.revision) {
        return undefined;
      }

      history = covered(page);
    } else if (patch.dataset !== replica.dataset || since > replica.revision) {
      return "gap";
    } else if (
      patch.revision < replica.revision ||
      (patch.revision === replica.revision && (page === undefined || was.kind === "complete"))
    ) {
      // Nothing newer, but the server's own facts (version, settings) may have moved.
      return patch.revision === replica.revision &&
        JSON.stringify(patch.server) !== JSON.stringify(replica.server)
        ? { replica: { ...replica, server: patch.server }, ops: [], reset: false }
        : undefined;
    } else if (page !== undefined && was.kind === "partial" && page.from === was.next) {
      history = covered(page);
    }

    let tables = reset ? spec.empty : replica.tables;
    const ops: Op[] = [];

    for (const lens of spec.tables) {
      tables = lens.apply(tables, patch.rows, reset);
      ops.push(...lens.ops(patch.rows));
    }

    return {
      replica: {
        dataset: patch.dataset,
        revision: patch.revision,
        server: patch.server,
        tables,
        history,
      },
      ops,
      reset,
    };
  }

  const ready = (model: M): boolean => model.boot.kind === "ready";

  const keep = (pending: Pending<C, O>): E => ({ kind: "keep", pending, max: outboxMax });

  /** Waiting to be sent: queued, or unknown and not parked (asked again under its key). */
  const sendable = (each: Pending<C, O>) =>
    each.state.kind === "queued" || (each.state.kind === "unknown" && each.state.parked !== true);

  const tooLarge = (bytes: number) =>
    `this is too large to send: ${bytes} bytes, where a push holds at most ${pushBytes}`;

  /** A command that failed on the page: done with that outcome, never sent, and its kept intent dropped. */
  function fail(pending: Pending<C, O>, message: string, now: number): Pending<C, O> {
    return {
      ...pending,
      at: now,
      state: { kind: "done", outcome: spec.refused(pending.command, message), revision: 0 },
    };
  }

  /**
   * A command the server refused by name, or one too large to send: final if no attempt of it may have acted; else
   * parked, since a refusal proves only that attempt didn't act. Kept either way, and passed over by every push.
   */
  function refuse(
    pending: Pending<C, O>,
    doubt: boolean,
    message: string,
    now: number,
    effects: E[]
  ): Pending<C, O> {
    if (doubt) {
      const parked: Pending<C, O> = {
        ...pending,
        state: { kind: "unknown", failure: message, parked: true },
      };

      effects.push(keep(parked), {
        kind: "telemetry",
        name: "command.parked",
        attributes: { reason: message },
      });

      return parked;
    }

    const done = fail(pending, message, now);
    effects.push(keep(done), { kind: "answered", pending: done });

    return done;
  }

  /** Start what is due: the obligations are read off the model after every message, never remembered. */
  function schedule(model: M, effects: E[]): Step {
    let next = model;
    const out = [...effects];
    const now = next.now;

    if (ready(next) && next.pull.kind === "idle" && next.visible && !blocked(next.connection)) {
      const failures = next.pull.failures;
      const due = now >= next.pull.nextAt;
      const behind = next.replica.revision < next.target;

      const unsettled = next.commands.some(
        (each) => each.state.kind === "done" && !settled(next, each)
      );

      const polling =
        next.connection.kind !== "live" || unsettled || (spec.outstanding?.(next.replica) ?? false);

      const history = historyOf(next.replica);
      const whole = next.restart === "whole";
      // Only a complete copy is checked: a fingerprint of everything can't certify part of it.
      const verifying = next.verify.kind === "pending" && (history.kind === "complete" || whole);
      // A partial copy owes its next page, back to back, until it is complete.
      const owed = behind || verifying || history.kind === "partial" || next.restart !== null;
      const since = next.restart === null ? next.replica.revision : 0;

      if ((owed && (failures === 0 || due)) || (polling && due)) {
        const current = next;

        // Commands waiting on an outcome or on their effects, at most a push's worth: their receipts come back with
        // the rows they name. When more wait, each pull names the next ones round, so every one is asked about in
        // turn (a parked command has no other way to settle).
        const waiting = current.commands
          .filter(
            (each) =>
              each.state.kind === "sending" ||
              each.state.kind === "unknown" ||
              (each.state.kind === "done" && !settled(current, each))
          )
          .map((each) => ({ client: each.client, id: each.id }));

        const turn = waiting.length > pushMax ? current.asking % waiting.length : 0;
        const commands = [...waiting.slice(turn), ...waiting.slice(0, turn)].slice(0, pushMax);

        out.push({
          kind: "pull",
          client: next.client,
          dataset: next.replica.dataset,
          since,
          verify: verifying,
          ...(whole ? {} : { page: history.kind === "partial" && since > 0 ? history.next : null }),
          commands,
        });
        next = {
          ...next,
          asking: waiting.length > pushMax ? turn + pushMax : 0,
          pull: { kind: "pulling", since, failures },
          verify:
            verifying && next.verify.kind === "pending"
              ? { kind: "requested", tries: next.verify.tries }
              : next.verify,
        };
      }
    }

    if (next.push.kind === "idle" && now >= next.push.nextAt && reachable(next.connection)) {
      const tapped = (each: Pending<C, O>) => each.since ?? next.replica.revision;
      let first = next.commands.find(sendable);

      // A kept command too large to send even alone (an older release kept it, or the bound was lowered) is refused,
      // or parked if an attempt may have acted, and passed over: it never strands the commands behind it.
      while (first !== undefined) {
        const alone = envelope(first.client, first.dataset, tapped(first)) + bytesOf(first);

        if (alone <= pushBytes) {
          break;
        }

        const large = first;
        const told: E[] = [];
        const withdrawn = refuse(large, large.state.kind === "unknown", tooLarge(alone), now, told);
        out.push(...told);
        next = {
          ...next,
          commands: next.commands.map((each) => (each === large ? withdrawn : each)),
        };
        first = next.commands.find(sendable);
      }

      if (first !== undefined) {
        // One push per client, dataset and tapped-against revision: the server judges each by what it was made on.
        // Oldest first, at most `pushMax` commands and `pushBytes` bytes: it stops at the first command that doesn't
        // fit, never skipping ahead to a smaller one, and the rest go in the next push.
        const lead = first;
        const batch: Pending<C, O>[] = [];
        let bytes = envelope(lead.client, lead.dataset, tapped(lead));

        for (const each of next.commands) {
          if (
            each.client !== lead.client ||
            each.dataset !== lead.dataset ||
            tapped(each) !== tapped(lead) ||
            !sendable(each)
          ) {
            continue;
          }

          const size = bytesOf(each) + (batch.length > 0 ? 1 : 0);

          if (batch.length >= pushMax || bytes + size > pushBytes) {
            break;
          }

          bytes += size;
          batch.push(each);
        }

        const sent = new Set(batch);
        out.push({
          kind: "push",
          client: lead.client,
          dataset: lead.dataset,
          since: tapped(lead),
          commands: batch.map((each) => ({ id: each.id, command: each.command })),
        });
        next = {
          ...next,
          push: {
            kind: "pushing",
            client: lead.client,
            ids: batch.map((each) => each.id),
            was: batch.map((each) => each.state),
            failures: next.push.failures,
          },
          commands: next.commands.map((each) =>
            sent.has(each) ? { ...each, state: { kind: "sending" } } : each
          ),
        };
      }
    }

    // A disk behind the page with no write in flight is owed a write, whole, until it holds what the page shows:
    // after a failure, and after answers out of order (a newer write failed, then an older one succeeded).
    if (
      ready(next) &&
      next.storage.kind !== "replaced" &&
      next.saved.writing === 0 &&
      now >= next.saved.nextAt &&
      next.replica.dataset !== null &&
      !saved(next)
    ) {
      out.push({
        kind: "commit",
        replica: next.replica,
        ops: [],
        reset: true,
        base: next.replica.revision,
        replaces: next.saved.dataset,
      });
      next = { ...next, saved: { ...next.saved, writing: next.saved.writing + 1 } };
    }

    return [next, out];
  }

  /** Commands answered by receipts: done, kept so a reload still shows them, and told to the app. */
  function answer(
    model: M,
    client: string,
    receipts: readonly Receipt<O>[],
    only?: ReadonlySet<number>
  ): Step {
    const byId = new Map(receipts.map((each) => [each.id, each]));
    const effects: E[] = [];

    const commands = model.commands.map((each): Pending<C, O> => {
      if (each.client !== client || each.state.kind === "done") {
        return each;
      }

      if (only !== undefined && !only.has(each.id)) {
        return each;
      }

      const receipt = byId.get(each.id);

      if (receipt === undefined) {
        return each;
      }

      const done: Pending<C, O> = {
        ...each,
        at: model.now,
        state: { kind: "done", outcome: receipt.outcome, revision: receipt.revision },
      };

      effects.push(
        keep(done),
        { kind: "answered", pending: done },
        { kind: "telemetry", name: "command.done", attributes: { ms: model.now - each.at } }
      );

      return done;
    });

    const target = Math.max(model.target, ...receipts.map((each) => each.revision));

    return [{ ...model, commands, target }, effects];
  }

  /** Each command's state before the push in flight for `client`; unknown when this page can't tell. */
  function prior(model: M, client: string) {
    const pushing =
      model.push.kind === "pushing" && model.push.client === client ? model.push : null;

    return (each: Pending<C, O>): CommandState<O> =>
      pushing?.was[pushing.ids.indexOf(each.id)] ?? { kind: "unknown", failure: "sent before" };
  }

  function reduce(model: M, msg: Msg<T, P, S, C, O>): Step {
    const now = msg.now;
    const at: M = { ...model, now };

    switch (msg.type) {
      case "loaded": {
        // Commands of earlier pages: what may have been sent goes again under its own key.
        const known = new Set(at.commands.map((each) => `${each.client}:${each.id}`));

        const resumed = msg.commands
          .filter((each) => !known.has(`${each.client}:${each.id}`))
          .map((each): Pending<C, O> =>
            each.state.kind === "sending" || each.state.kind === "saving"
              ? { ...each, state: { kind: "unknown", failure: "the page closed while sending" } }
              : each
          )
          // A tap kept before taps recorded their copy's revision was made on the copy beside it on the disk (or
          // an older one of the same history): judged by that, never by whatever the page holds when it sends.
          .map((each): Pending<C, O> =>
            each.since === undefined ? { ...each, since: msg.replica.revision } : each
          );

        // Storage answered after its deadline: the page went on from the server, and the disk's taps still go.
        if (ready(at)) {
          return [
            {
              ...at,
              commands: [...resumed, ...at.commands],
              unreadable: msg.unreadable,
              storage:
                at.storage.kind === "failed" && at.saved.failures === 0
                  ? { kind: "ok" }
                  : at.storage,
            },
            [],
          ];
        }

        return [
          {
            ...at,
            boot: { kind: "ready" },
            replica: msg.replica,
            saved: { ...at.saved, dataset: msg.replica.dataset, revision: msg.replica.revision },
            target: Math.max(at.target, msg.replica.revision),
            commands: [...resumed, ...at.commands],
            unreadable: msg.unreadable,
          },
          [],
        ];
      }

      case "loadFailed": {
        if (ready(at)) {
          return [at, []];
        }

        return [
          { ...at, boot: { kind: "ready" }, storage: { kind: "failed", reason: msg.reason } },
          [{ kind: "telemetry", name: "storage.failed", attributes: { reason: msg.reason } }],
        ];
      }

      case "pulled": {
        const result = merge(at.replica, msg.patch, msg.since);
        const merged = result === "gap" ? undefined : result;
        const replica = merged?.replica ?? at.replica;
        const effects: E[] = [];
        const was = historyOf(at.replica);
        const history = historyOf(replica);
        const failures = at.pull.kind === "pulling" ? at.pull.failures : 0;

        // An old server answering a partial copy (with rows or without): only its whole copy completes it.
        const old =
          was.kind === "partial" &&
          msg.patch.page === undefined &&
          !msg.patch.reset &&
          msg.since > 0 &&
          result !== "gap";

        // A partial copy this reply didn't move on (the same page again, a repeated first page at the same revision, a
        // reply it couldn't take) is a pull that failed, for backoff: never a busy loop on a server that doesn't move.
        const stuck =
          was.kind === "partial" &&
          !old &&
          (merged === undefined ||
            (msg.patch.page !== undefined &&
              history.kind === "partial" &&
              history.next === was.next &&
              replica.dataset === at.replica.dataset &&
              !(merged.reset && replica.revision > at.replica.revision)));

        // Receipts that came with an applied reply came with the rows they name.
        const carried = new Set(merged?.reset === true ? [] : at.carried);

        if (merged !== undefined) {
          for (const each of msg.receipts) {
            if (each.revision <= replica.revision) {
              carried.add(`${each.client ?? at.client}:${each.id}`);
            }
          }
        }

        let next: M = {
          ...at,
          replica,
          carried,
          target:
            msg.patch.dataset === at.replica.dataset
              ? Math.max(at.target, msg.patch.revision)
              : msg.patch.revision,
          // A reply it couldn't follow asks a real reset; an old server's reply to a partial copy, its whole copy.
          restart:
            result === "gap"
              ? (at.restart ?? "paged")
              : merged?.reset === true
                ? null
                : old
                  ? "whole"
                  : at.restart,
          reconciledAt: now,
          connection:
            at.socket.open && now - at.socket.heardAt < SOCKET_DEADLINE_MS
              ? { kind: "live" }
              : { kind: "stale" },
          pull: stuck
            ? { kind: "idle", nextAt: now + backoff(failures + 1), failures: failures + 1 }
            : { kind: "idle", nextAt: now + POLL_MS, failures: 0 },
        };

        if (merged !== undefined && next.storage.kind !== "replaced") {
          effects.push({
            kind: "commit",
            replica,
            ops: merged.ops,
            reset: merged.reset,
            base: msg.since,
            replaces: at.saved.dataset,
            from: was.kind === "partial" ? was.next : null,
          });
          next = { ...next, saved: { ...next.saved, writing: next.saved.writing + 1 } };
        }

        if (at.verify.kind === "requested") {
          // The fingerprint describes the server at the reply's revision: comparable only if the replica is there, and
          // whole (a fingerprint of everything never certifies part of it).
          if (
            msg.patch.checksum !== undefined &&
            history.kind === "complete" &&
            replica.revision === msg.patch.revision &&
            replica.dataset === msg.patch.dataset
          ) {
            effects.push({ kind: "check", replica, checksum: msg.patch.checksum });
          } else {
            next = { ...next, verify: { kind: "pending", tries: at.verify.tries } };
          }
        }

        // Receipts by client: an earlier page's commands are answered too.
        let answered = next;
        const more: E[] = [];

        for (const client of new Set(msg.receipts.map((each) => each.client ?? at.client))) {
          const [after, told] = answer(
            answered,
            client,
            msg.receipts.filter((each) => (each.client ?? at.client) === client)
          );

          answered = after;
          more.push(...told);
        }

        // Intents tapped against a store the server no longer has never go to its replacement (the server refuses
        // them too). One that may already have run there says so.
        const replaced = answered.commands.map((each): Pending<C, O> => {
          if (
            each.state.kind === "done" ||
            each.dataset === null ||
            replica.dataset === null ||
            each.dataset === replica.dataset
          ) {
            return each;
          }

          const done = fail(
            each,
            each.state.kind === "unknown"
              ? "the server's data was replaced; whether this ran before is unknown"
              : "the server's data was replaced since this was tapped, so it wasn't sent",
            now
          );

          more.push(keep(done), { kind: "answered", pending: done });

          return done;
        });

        return [{ ...answered, commands: replaced }, [...effects, ...more]];
      }

      case "pullFailed": {
        const failures = (at.pull.kind === "pulling" ? at.pull.failures : 0) + 1;
        const wait = Math.max(backoff(failures), msg.failure.retryAfterMs ?? 0);

        return [
          {
            ...at,
            connection: failedConnection(at.connection, msg.failure),
            pull: { kind: "idle", nextAt: now + wait, failures },
            verify:
              at.verify.kind === "requested"
                ? { kind: "pending", tries: at.verify.tries }
                : at.verify,
          },
          [{ kind: "telemetry", name: "pull.failed", attributes: { kind: msg.failure.kind } }],
        ];
      }

      case "pushed": {
        const ids = new Set(msg.ids);
        const [answered, effects] = answer(at, msg.client, msg.receipts, ids);

        // A command the reply has no receipt for is still acting elsewhere: asked again. The disk holds its in-flight
        // mark, so a reload knows it too.
        const commands = answered.commands.map((each): Pending<C, O> =>
          each.client === msg.client && ids.has(each.id) && each.state.kind === "sending"
            ? { ...each, state: { kind: "unknown", failure: "the server is still on it" } }
            : each
        );

        const waiting = commands.some(
          (each) => each.client === msg.client && ids.has(each.id) && each.state.kind !== "done"
        );

        return [
          {
            ...answered,
            commands,
            target: Math.max(answered.target, msg.revision),
            push: { kind: "idle", nextAt: waiting ? now + POLL_MS : now, failures: 0 },
          },
          effects,
        ];
      }

      case "pushFailed": {
        const failure = msg.failure;
        const ids = new Set(msg.ids);
        const before = prior(at, msg.client);
        const effects: E[] = [];

        // The server's own refusal of a request it never ran (its schema is checked before the handler, and a handler
        // never refuses after anything acted): this attempt didn't act, though an earlier one may have.
        const refused =
          failure.refused === true &&
          (failure.kind === "invalid" ||
            failure.kind === "forbidden" ||
            failure.kind === "conflict");

        // A schema refusal naming one of this push's commands is that command's alone.
        const index = refused && failure.kind === "invalid" ? commandAt(failure.path) : undefined;
        const named = index === undefined ? undefined : msg.ids[index];

        const commands = at.commands.map((each): Pending<C, O> => {
          if (each.client !== msg.client || !ids.has(each.id) || each.state.kind !== "sending") {
            return each;
          }

          const was = before(each);
          // An attempt whose outcome was lost may have acted: no later refusal makes it final.
          const doubt = was.kind === "unknown";

          if (named !== undefined) {
            return each.id === named
              ? refuse(each, doubt, failure.message, now, effects)
              : { ...each, state: was };
          }

          // A kit forbidden or conflict: nothing in this attempt acted. Final only for a command no attempt of which
          // may have acted.
          if (refused && failure.kind !== "invalid") {
            return doubt
              ? { ...each, state: was }
              : refuse(each, false, failure.message, now, effects);
          }

          // An envelope refusal (a page and server of different releases): nothing acted, and the page stops. The disk
          // holds the in-flight mark: a command never uncertain is kept as it was again.
          if (refused) {
            const restored: Pending<C, O> = { ...each, state: was };

            if (!doubt) {
              effects.push(keep(restored));
            }

            return restored;
          }

          // Anything else may have acted (a lost reply, an unreadable one, a proxy's answer): asked again, same key.
          // The disk holds its in-flight mark.
          return { ...each, state: { kind: "unknown", failure: failure.message } };
        });

        const telemetry: E = {
          kind: "telemetry",
          name: "push.failed",
          attributes: {
            kind: failure.kind,
            refused: failure.refused === true,
            path: failure.path ?? null,
          },
        };

        const pushing = at.push.kind === "pushing" ? at.push.failures : 0;

        // One command refused by name: the rest go again at once, without it.
        if (named !== undefined) {
          return [
            { ...at, commands, push: { kind: "idle", nextAt: now, failures: pushing } },
            [...effects, telemetry],
          ];
        }

        const failures = pushing + 1;

        return [
          {
            ...at,
            commands,
            connection: failedConnection(at.connection, failure),
            push: {
              kind: "idle",
              nextAt: now + Math.max(backoff(failures), failure.retryAfterMs ?? 0),
              failures,
            },
          },
          [...effects, telemetry],
        ];
      }

      case "unsent": {
        // Never sent: each command is what it was before, and goes again once the disk keeps its mark.
        const ids = new Set(msg.ids);
        const before = prior(at, msg.client);
        const failures = (at.push.kind === "pushing" ? at.push.failures : 0) + 1;

        return [
          {
            ...at,
            commands: at.commands.map((each): Pending<C, O> =>
              each.client === msg.client && ids.has(each.id) && each.state.kind === "sending"
                ? { ...each, state: before(each) }
                : each
            ),
            storage: msg.replaced ? { kind: "replaced" } : { kind: "failed", reason: msg.reason },
            push: { kind: "idle", nextAt: now + backoff(failures), failures },
          },
          [{ kind: "telemetry", name: "push.unsent", attributes: { reason: msg.reason } }],
        ];
      }

      case "committed": {
        const same = msg.dataset === at.saved.dataset;
        // A delta the disk took under its own history doesn't repair a failed write: the whole one stays owed.
        const owed = at.saved.owed && msg.whole === false;

        return [
          {
            ...at,
            storage: at.storage.kind === "replaced" || owed ? at.storage : { kind: "ok" },
            saved: {
              dataset: msg.dataset,
              revision: same ? Math.max(at.saved.revision, msg.revision) : msg.revision,
              behindSince: at.saved.behindSince,
              writing: Math.max(0, at.saved.writing - 1),
              failures: 0,
              nextAt: now,
              owed,
            },
          },
          [],
        ];
      }

      case "commitFailed": {
        const failures = at.saved.failures + 1;

        return [
          {
            ...at,
            storage: msg.replaced ? { kind: "replaced" } : { kind: "failed", reason: msg.reason },
            saved: {
              ...at.saved,
              writing: Math.max(0, at.saved.writing - 1),
              failures,
              nextAt: now + backoff(failures),
              owed: true,
            },
          },
          [{ kind: "telemetry", name: "replica.save-failed", attributes: { reason: msg.reason } }],
        ];
      }

      case "kept": {
        let admitted = false;

        const commands = at.commands.map((each): Pending<C, O> => {
          if (each.client !== msg.client || each.id !== msg.id || each.state.kind !== "saving") {
            return each;
          }

          admitted = true;

          return { ...each, state: { kind: "queued" } };
        });

        return [
          {
            ...at,
            commands,
            storage: working(at),
            outbox: admitted ? { ...at.outbox, full: null } : at.outbox,
          },
          [],
        ];
      }

      case "full": {
        // Not a storage failure: the store answered, with no room. The tap is answered and not retained.
        const gone = at.commands.find(
          (each) => each.client === msg.client && each.id === msg.id && each.state.kind === "saving"
        );

        if (gone === undefined) {
          return [{ ...at, storage: working(at) }, []];
        }

        const refused = fail(gone, "this device's outbox is full, so it wasn't kept or sent", now);

        return [
          {
            ...at,
            commands: at.commands.filter((each) => each !== gone),
            storage: working(at),
            outbox: {
              ...at.outbox,
              full: { kind: "full", waiting: msg.waiting, finished: msg.finished, max: msg.max },
            },
          },
          [
            { kind: "answered", pending: refused },
            {
              kind: "telemetry",
              name: "commands.full",
              attributes: { waiting: msg.waiting, finished: msg.finished, max: msg.max },
            },
          ],
        ];
      }

      case "keepFailed": {
        const effects: E[] = [
          { kind: "telemetry", name: "commands.save-failed", attributes: { reason: msg.reason } },
        ];

        const commands = at.commands.map((each): Pending<C, O> => {
          if (each.client !== msg.client || each.id !== msg.id || each.state.kind !== "saving") {
            return each;
          }

          const done = fail(
            each,
            `this device couldn't keep it, so it wasn't sent: ${msg.reason}`,
            now
          );

          effects.push({ kind: "answered", pending: done });

          return done;
        });

        return [{ ...at, commands, storage: { kind: "failed", reason: msg.reason } }, effects];
      }

      case "dropped": {
        if (msg.failure === null) {
          return [{ ...at, storage: working(at), outbox: { ...at.outbox, full: null } }, []];
        }

        return [
          {
            ...at,
            storage:
              msg.failure === "replaced"
                ? { kind: "replaced" }
                : at.storage.kind === "ok"
                  ? { kind: "failed", reason: msg.failure }
                  : at.storage,
          },
          [],
        ];
      }

      case "socket": {
        return [
          {
            ...at,
            socket: { open: msg.open, heardAt: msg.open ? now : at.socket.heardAt },
            connection:
              !msg.open && at.connection.kind === "live" ? { kind: "stale" } : at.connection,
          },
          [],
        ];
      }

      case "heard": {
        // Liveness and the server's head only: a beat never stands for a pull that failed.
        return [
          {
            ...at,
            socket: { open: true, heardAt: now },
            target: Math.max(at.target, msg.revision),
            connection: at.connection.kind === "stale" ? { kind: "live" } : at.connection,
          },
          [],
        ];
      }

      case "visible": {
        // Back in front: catch up at once.
        return [
          {
            ...at,
            visible: msg.visible,
            pull:
              msg.visible && at.pull.kind === "idle"
                ? { ...at.pull, nextAt: Math.min(at.pull.nextAt, now) }
                : at.pull,
          },
          [],
        ];
      }

      case "tick": {
        let next = at;
        const effects: E[] = [];

        if (next.boot.kind === "loading" && now - next.boot.since >= STORAGE_DEADLINE_MS) {
          const reason = "this device's storage didn't answer";
          next = { ...next, boot: { kind: "ready" }, storage: { kind: "failed", reason } };
          effects.push({ kind: "telemetry", name: "storage.failed", attributes: { reason } });
        }

        // Settled, resolved commands fade after a while; nothing unsettled or unresolved ever does.
        const faded = next.commands.filter(
          (each) =>
            settled(next, each) &&
            now - each.at >= DONE_KEEP_MS &&
            (spec.resolved?.(each, next) ?? true)
        );

        if (faded.length > 0) {
          const gone = new Set(faded);
          next = { ...next, commands: next.commands.filter((each) => !gone.has(each)) };
          effects.push({
            kind: "drop",
            keys: faded.map((each) => ({ client: each.client, id: each.id })),
          });
        }

        if (next.connection.kind === "live" && now - next.socket.heardAt >= SOCKET_DEADLINE_MS) {
          next = { ...next, connection: { kind: "stale" } };
        }

        return [next, effects];
      }

      case "command": {
        const pending: Pending<C, O> = {
          client: at.client,
          id: at.nextId,
          dataset: at.replica.dataset,
          since: at.replica.revision,
          command: msg.command,
          at: now,
          state: { kind: "saving" },
        };

        const numbered = { ...at, nextId: at.nextId + 1 };

        if (spec.onlineOnly(msg.command) && !reachable(at.connection)) {
          const refused = fail(pending, "this needs the server, which can't be reached now", now);

          return [
            { ...numbered, commands: [...at.commands, refused] },
            [{ kind: "answered", pending: refused }],
          ];
        }

        const joined = at.commands.some(
          (each) =>
            (each.state.kind === "saving" || each.state.kind === "queued") &&
            (spec.joins?.(each.command, msg.command) ?? false)
        );

        if (joined) {
          return [at, []];
        }

        // A tap no push could carry is answered now, never kept.
        const alone = envelope(at.client, pending.dataset, at.replica.revision) + bytesOf(pending);

        if (alone > pushBytes) {
          return [numbered, [{ kind: "answered", pending: fail(pending, tooLarge(alone), now) }]];
        }

        // Admitted by the store, inside the keep's own transaction: a full outbox answers `full`, and the tap goes.
        return [
          { ...numbered, commands: [...at.commands, pending] },
          [keep({ ...pending, state: { kind: "queued" } })],
        ];
      }

      case "dismiss": {
        const gone = at.commands.find(
          (each) => each.client === msg.client && each.id === msg.id && each.state.kind === "done"
        );

        if (gone === undefined) {
          return [at, []];
        }

        return [
          { ...at, commands: at.commands.filter((each) => each !== gone) },
          [{ kind: "drop", keys: [{ client: gone.client, id: gone.id }] }],
        ];
      }

      case "checked": {
        if (at.verify.kind !== "requested") {
          return [at, []];
        }

        // A fingerprint of a replica this page no longer holds proves nothing about the one it holds: check again.
        if (msg.dataset !== at.replica.dataset || msg.revision !== at.replica.revision) {
          return [{ ...at, verify: { kind: "pending", tries: at.verify.tries } }, []];
        }

        if (msg.match) {
          return [
            { ...at, verify: { kind: "done", match: true } },
            [
              {
                kind: "telemetry",
                name: "replica.verified",
                attributes: { revision: msg.revision },
              },
            ],
          ];
        }

        const tries = at.verify.tries + 1;

        const report: E = {
          kind: "telemetry",
          name: "replica.mismatch",
          attributes: { revision: msg.revision, tries },
        };

        if (tries > 2) {
          return [{ ...at, verify: { kind: "done", match: false } }, [report]];
        }

        // Start over from the server: the replica is forgotten (the reset reply rewrites the disk); commands stay.
        return [{ ...at, replica: emptyReplica(), verify: { kind: "pending", tries } }, [report]];
      }

      default: {
        return unreachable(msg);
      }
    }
  }

  function update(model: M, msg: Msg<T, P, S, C, O>): readonly [M, readonly E[]] {
    const [next, effects] = reduce(model, msg);
    // Read off the model after every message, never remembered by a case: since when the disk is behind the page.
    const behind = next.replica.dataset !== null && !saved(next);
    const since = behind ? (next.saved.behindSince ?? next.now) : null;

    let marked =
      since === next.saved.behindSince
        ? next
        : { ...next, saved: { ...next.saved, behindSince: since } };

    // Commands that left the page leave what was carried for them.
    const kept = new Set(marked.commands.map((each) => `${each.client}:${each.id}`));
    const carried = [...marked.carried].filter((key) => kept.has(key));

    if (carried.length < marked.carried.size) {
      marked = { ...marked, carried: new Set(carried) };
    }

    // A command that resolves only now (its result came later than its receipt) is drawn its full time from now.
    const resolved = spec.resolved;

    if (resolved !== undefined) {
      const was = new Map(model.commands.map((each) => [each, resolved(each, model)]));
      let moved = false;

      const commands = marked.commands.map((each) => {
        if (each.state.kind !== "done" || was.get(each) !== false || !resolved(each, marked)) {
          return each;
        }

        moved = true;

        return { ...each, at: marked.now };
      });

      if (moved) {
        marked = { ...marked, commands };
      }
    }

    return schedule(marked, effects);
  }

  return { initial, update, merge };
}
