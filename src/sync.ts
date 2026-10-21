/**
 * The client half of sync, pure: a replica of the server's tables, the commands this browser sent, and the link to the
 * server, as one state machine `update(model, msg) → [model, effects]`. It reads no clock, storage or network: ports do
 * that and answer with messages (`client.ts` runs it), so the same rules run, and are checked, in model replays, in the
 * headless simulation over real stores and in the browser alike.
 *
 * Invariants it owns:
 * - **The replica only moves forward.** A pull applies only if newer (or a reset for another dataset). The disk commit
 *   is decided again against what the disk holds, inside its own transaction (`commitPlan`), so another tab or a
 *   failed write can't make the disk go back or skip a patch.
 * - **Observed is not saved.** `saved` is what the disk is known to hold; a failed commit is retried whole until the
 *   disk catches up, and until then the page says so.
 * - **A pull is owed while the server is ahead.** `target` is the newest revision the server is known to have (pokes,
 *   which also beat every 20 s, push replies, receipts); while the replica is behind it a pull is in flight or
 *   scheduled, whatever the socket says. Liveness, the known head and the last reconciliation are separate facts.
 * - **A command id is never reused.** Each page load is a new client with its own numbers; commands loaded from an
 *   earlier page keep theirs.
 * - **Nothing is sent before it is kept.** An intent the device can't keep fails at once, visibly, and is never sent.
 * - **Every command reaches an outcome, and is settled only once the replica holds its effects** (a receipt names the
 *   revision that made it visible); until then a pull is owed.
 * - **Every waiting state ends.** Pulling, pushing, retrying and saving have deadlines or backoff; storage that is slow
 *   to load or keep is said (the page goes on from the server meanwhile), and its late answer still counts: a slow
 *   write is not a failed one.
 * - **An intent belongs to the dataset it was made against**: the server refuses it against a replacement.
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

      const next = new Map(reset ? [] : def.get(tables));

      for (const row of changed) {
        if (gone(row)) {
          next.delete(def.key(row));
        } else {
          next.set(def.key(row), row);
        }
      }

      return def.set(tables, next);
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

export type Replica<T, S> = {
  dataset: string | null;
  revision: number;
  tables: T;
  /** What the server says about itself, read with every pull. */
  server: S | null;
};

/** A pull reply as sync sees it: rows changed since the pull's `since`, or everything (`reset`). */
export type Patch<P, S> = {
  dataset: string;
  revision: number;
  reset: boolean;
  rows: P;
  server: S;
  checksum?: string;
};

/** A command's outcome as the server recorded it, and the revision at which its effects are visible. */
export type Receipt<O> = { id: number; outcome: O; revision: number };

export type CommandState<O> =
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "sending" }
  | { kind: "unknown"; failure: string }
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
  };
  target: number;
  /** When a pull last succeeded: freshness, apart from the socket's liveness. */
  reconciledAt: number | null;
  connection: Connection;
  socket: { open: boolean; heardAt: number };
  pull:
    | { kind: "idle"; nextAt: number; failures: number }
    | { kind: "pulling"; since: number; failures: number };
  push:
    | { kind: "idle"; nextAt: number; failures: number }
    | { kind: "pushing"; client: string; ids: readonly number[]; failures: number };
  commands: readonly Pending<C, O>[];
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
  /** The disk holds the replica at `revision` (perhaps newer than asked, from another tab). */
  | { type: "committed"; dataset: string; revision: number; now: number }
  | { type: "commitFailed"; reason: string; replaced: boolean; now: number }
  | { type: "kept"; client: string; id: number; now: number }
  | { type: "keepFailed"; client: string; id: number; reason: string; now: number }
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
  /** The dataset this page last knew the disk to hold: the only one it may replace with another. */
  replaces: string | null;
};

export type Effect<T, S, C, O> =
  | { kind: "load" }
  | { kind: "pull"; client: string; dataset: string | null; since: number; verify: boolean }
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
  | { kind: "keep"; pending: Pending<C, O> }
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

/** Settled commands stay drawn this long. */
export const DONE_KEEP_MS = 60_000;

/** Whether the server can be asked now. */
export function reachable(connection: Connection): boolean {
  return connection.kind === "live" || connection.kind === "stale";
}

/** Whether the replica holds this command's effects. */
export function settled<T, S, C, O>(model: Model<T, S, C, O>, pending: Pending<C, O>): boolean {
  return pending.state.kind === "done" && model.replica.revision >= pending.state.revision;
}

/** Whether what the page shows is also on the disk. */
export function saved<T, S, C, O>(model: Model<T, S, C, O>): boolean {
  return (
    model.saved.dataset === model.replica.dataset && model.saved.revision >= model.replica.revision
  );
}

/**
 * What a commit does to the disk, decided inside the disk's own transaction from what it holds: nothing when the disk
 * already has this or newer (another tab got there), the patch alone when the disk is at least at its base, else the
 * whole replica, so a skipped or failed patch is never covered by a later checkpoint. A page may replace the disk's
 * dataset only with one it moved to from that very dataset (`replaces`): a tab still on a dataset the server has since
 * replaced is `stale` and never writes it back.
 */
export function commitPlan(
  stored: { dataset: string | null; revision: number },
  commit: {
    dataset: string | null;
    revision: number;
    reset: boolean;
    base: number;
    replaces: string | null;
  }
): "skip" | "delta" | "whole" | "stale" {
  const same = stored.dataset === commit.dataset;

  if (!same && stored.dataset !== null && stored.dataset !== commit.replaces) {
    return "stale";
  }

  if (same && stored.revision >= commit.revision) {
    return "skip";
  }

  if (!commit.reset && same && stored.revision >= commit.base) {
    return "delta";
  }

  return "whole";
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

    case "invalid": {
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

  if (!Number.isSafeInteger(pushMax) || pushMax < 1) {
    throw new Error(`sync: pushMax must be a positive integer, got ${pushMax}`);
  }

  type M = Model<T, S, C, O>;

  type E = Effect<T, S, C, O>;

  type Step = readonly [M, E[]];

  const emptyReplica = (): Replica<T, S> => ({
    dataset: null,
    revision: 0,
    tables: spec.empty,
    server: null,
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
      },
      target: 0,
      reconciledAt: null,
      connection: { kind: "starting" },
      socket: { open: false, heardAt: 0 },
      pull: { kind: "idle", nextAt: now, failures: 0 },
      push: { kind: "idle", nextAt: now, failures: 0 },
      commands: [],
      unreadable: 0,
      visible: true,
      verify: { kind: "pending", tries: 0 },
      now,
    };
  }

  /**
   * The one merge: a patch applied to a replica, with its disk operations, or undefined when it is older than the
   * replica (a late reply). A reset or another dataset replaces everything.
   */
  function merge(
    replica: Replica<T, S>,
    patch: Patch<P, S>
  ): { replica: Replica<T, S>; ops: Op[]; reset: boolean } | undefined {
    const reset = patch.reset || patch.dataset !== replica.dataset;

    if (!reset && patch.revision <= replica.revision) {
      // Nothing newer, but the server's own facts (version, settings) may have moved.
      if (
        patch.revision === replica.revision &&
        JSON.stringify(patch.server) !== JSON.stringify(replica.server)
      ) {
        return { replica: { ...replica, server: patch.server }, ops: [], reset: false };
      }

      return undefined;
    }

    // A reset older than what we hold of the same dataset is a late reply.
    if (reset && patch.dataset === replica.dataset && patch.revision < replica.revision) {
      return undefined;
    }

    let tables = reset ? spec.empty : replica.tables;
    const ops: Op[] = [];

    for (const lens of spec.tables) {
      tables = lens.apply(tables, patch.rows, reset);
      ops.push(...lens.ops(patch.rows));
    }

    return {
      replica: { dataset: patch.dataset, revision: patch.revision, server: patch.server, tables },
      ops,
      reset,
    };
  }

  const ready = (model: M): boolean => model.boot.kind === "ready";

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

      const verifying = next.verify.kind === "pending";

      if (((behind || verifying) && (failures === 0 || due)) || (polling && due)) {
        out.push({
          kind: "pull",
          client: next.client,
          dataset: next.replica.dataset,
          since: next.replica.revision,
          verify: verifying,
        });
        next = {
          ...next,
          pull: { kind: "pulling", since: next.replica.revision, failures },
          verify:
            next.verify.kind === "pending"
              ? { kind: "requested", tries: next.verify.tries }
              : next.verify,
        };
      }
    }

    if (next.push.kind === "idle" && now >= next.push.nextAt && reachable(next.connection)) {
      const first = next.commands.find(
        (each) => each.state.kind === "queued" || each.state.kind === "unknown"
      );

      if (first !== undefined) {
        // One push per client, dataset and tapped-against revision: the server judges each by what it was made on.
        // At most `pushMax`, oldest first; the rest go in the next push.
        const tapped = (each: Pending<C, O>) => each.since ?? next.replica.revision;

        const ids = new Set(
          next.commands
            .filter(
              (each) =>
                each.client === first.client &&
                each.dataset === first.dataset &&
                tapped(each) === tapped(first) &&
                (each.state.kind === "queued" || each.state.kind === "unknown")
            )
            .slice(0, pushMax)
            .map((each) => each.id)
        );

        const mine = (each: Pending<C, O>) => each.client === first.client && ids.has(each.id);
        out.push({
          kind: "push",
          client: first.client,
          dataset: first.dataset,
          since: tapped(first),
          commands: next.commands
            .filter(mine)
            .map((each) => ({ id: each.id, command: each.command })),
        });
        next = {
          ...next,
          push: {
            kind: "pushing",
            client: first.client,
            ids: [...ids],
            failures: next.push.failures,
          },
          commands: next.commands.map((each) =>
            mine(each) ? { ...each, state: { kind: "sending" } } : each
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
        { kind: "keep", pending: done },
        { kind: "answered", pending: done },
        { kind: "telemetry", name: "command.done", attributes: { ms: model.now - each.at } }
      );

      return done;
    });

    const target = Math.max(model.target, ...receipts.map((each) => each.revision));

    return [{ ...model, commands, target }, effects];
  }

  /** A command that failed on the page: done with that outcome, never sent, and its kept intent dropped. */
  function fail(pending: Pending<C, O>, message: string, now: number): Pending<C, O> {
    return {
      ...pending,
      at: now,
      state: { kind: "done", outcome: spec.refused(pending.command, message), revision: 0 },
    };
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
        const merged = merge(at.replica, msg.patch);
        const replica = merged?.replica ?? at.replica;
        const effects: E[] = [];

        let next: M = {
          ...at,
          replica,
          target:
            msg.patch.dataset === at.replica.dataset
              ? Math.max(at.target, msg.patch.revision)
              : msg.patch.revision,
          reconciledAt: now,
          connection:
            at.socket.open && now - at.socket.heardAt < SOCKET_DEADLINE_MS
              ? { kind: "live" }
              : { kind: "stale" },
          pull: { kind: "idle", nextAt: now + POLL_MS, failures: 0 },
        };

        if (merged !== undefined && next.storage.kind !== "replaced") {
          effects.push({
            kind: "commit",
            replica,
            ops: merged.ops,
            reset: merged.reset,
            base: msg.since,
            replaces: at.saved.dataset,
          });
          next = { ...next, saved: { ...next.saved, writing: next.saved.writing + 1 } };
        }

        if (at.verify.kind === "requested") {
          // The fingerprint describes the server at the reply's revision: comparable only if the replica is there.
          if (
            msg.patch.checksum !== undefined &&
            replica.revision === msg.patch.revision &&
            replica.dataset === msg.patch.dataset
          ) {
            effects.push({ kind: "check", replica, checksum: msg.patch.checksum });
          } else {
            next = { ...next, verify: { kind: "pending", tries: at.verify.tries } };
          }
        }

        const [answered, more] = answer(next, next.client, msg.receipts);

        // Intents tapped against a store the server no longer has never go to its replacement (the server refuses
        // them too). One that may already have run there says so.
        const replaced = answered.commands.map((each): Pending<C, O> => {
          if (
            each.state.kind === "done" ||
            each.dataset === null ||
            each.dataset === msg.patch.dataset
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

          more.push({ kind: "keep", pending: done }, { kind: "answered", pending: done });

          return done;
        });

        return [{ ...answered, commands: replaced }, [...effects, ...more]];
      }

      case "pullFailed": {
        const failures = (at.pull.kind === "pulling" ? at.pull.failures : 0) + 1;

        return [
          {
            ...at,
            connection: failedConnection(at.connection, msg.failure),
            pull: { kind: "idle", nextAt: now + backoff(failures), failures },
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

        // A command the reply has no receipt for is still acting elsewhere: asked again.
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
        // Refused before anything acted: final. Anything else may have acted (an unreadable reply included), so it is
        // unknown and asked again under the same key, which answers with the first outcome.
        const final = msg.failure.kind === "forbidden" || msg.failure.kind === "conflict";
        const ids = new Set(msg.ids);
        const effects: E[] = [];

        const commands = at.commands.map((each): Pending<C, O> => {
          if (each.client !== msg.client || !ids.has(each.id) || each.state.kind === "done") {
            return each;
          }

          if (!final) {
            return { ...each, state: { kind: "unknown", failure: msg.failure.message } };
          }

          const done = fail(each, msg.failure.message, now);
          effects.push({ kind: "keep", pending: done }, { kind: "answered", pending: done });

          return done;
        });

        const failures = (at.push.kind === "pushing" ? at.push.failures : 0) + 1;

        return [
          {
            ...at,
            commands,
            connection: failedConnection(at.connection, msg.failure),
            push: { kind: "idle", nextAt: now + backoff(failures), failures },
          },
          [
            ...effects,
            { kind: "telemetry", name: "push.failed", attributes: { kind: msg.failure.kind } },
          ],
        ];
      }

      case "committed": {
        const same = msg.dataset === at.saved.dataset;

        return [
          {
            ...at,
            storage: at.storage.kind === "replaced" ? at.storage : { kind: "ok" },
            saved: {
              dataset: msg.dataset,
              revision: same ? Math.max(at.saved.revision, msg.revision) : msg.revision,
              behindSince: at.saved.behindSince,
              writing: Math.max(0, at.saved.writing - 1),
              failures: 0,
              nextAt: now,
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
            },
          },
          [{ kind: "telemetry", name: "replica.save-failed", attributes: { reason: msg.reason } }],
        ];
      }

      case "kept": {
        const commands = at.commands.map((each): Pending<C, O> =>
          each.client === msg.client && each.id === msg.id && each.state.kind === "saving"
            ? { ...each, state: { kind: "queued" } }
            : each
        );

        return [{ ...at, commands, storage: working(at) }, []];
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
          return [{ ...at, storage: working(at) }, []];
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

        return [
          { ...numbered, commands: [...at.commands, pending] },
          [{ kind: "keep", pending: { ...pending, state: { kind: "queued" } } }],
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
