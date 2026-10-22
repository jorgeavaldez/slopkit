/**
 * The sync engine's runner: it holds the model, runs every effect through the ports, and turns each one's completion
 * into exactly one message, a failure included (a rejected port call is a failure message, never a lost one). The
 * browser and the headless simulation run this same code; only the ports differ.
 *
 * Ports: storage (the replica and the outbox, transactional), network (pull and push), the fingerprint, the clock, and
 * the app's own hooks (`answered`, for example opening or closing a provider's window, and `telemetry`).
 */
import type { Result } from "./contract.ts";
import { runtime } from "./machine.ts";
import type {
  Commit,
  createSync,
  Effect,
  Model,
  Msg,
  OutboxFull,
  Patch,
  Pending,
  Receipt,
  Replica,
} from "./sync.ts";

/** The disk was forgotten or moved to another dataset under this page (another tab): its writes stop, and it reloads. */
export class Replaced extends Error {
  constructor() {
    super("this device's copy was forgotten or replaced in another tab");
  }
}

export type StoragePort<T, S, C, O> = {
  /**
   * The replica and the outbox; `unreadable` counts kept commands this version can't read (left on disk); `restart`
   * when the copy owes a real reset before it is trusted (one lifted from an earlier release's row shapes).
   */
  load: () => Promise<{
    replica: Replica<T, S>;
    commands: Pending<C, O>[];
    unreadable: number;
    restart?: "paged";
  }>;
  /**
   * Commit a patch, decided against the disk inside its transaction; returns what the disk now holds, and `whole:
   * false` when it took the patch as a delta under its own history (so it lacks rows of this page's copy).
   */
  commit: (commit: Commit<T, S>) => Promise<{ dataset: string; revision: number; whole?: boolean }>;
  /**
   * Write one command (an intent, or its outcome) under its key. A key the outbox doesn't hold yet is admitted only
   * while it holds fewer than `max` commands (default `OUTBOX_MAX`), decided inside the write's own transaction so
   * every tab shares the bound; otherwise nothing is written and the store's counts come back. A kept key always
   * updates, and nothing kept is ever dropped for room.
   */
  // oxlint-disable-next-line typescript/no-invalid-void-type -- an adapter that always admits answers like any write
  keep: (pending: Pending<C, O>, max?: number) => Promise<void | OutboxFull>;
  drop: (keys: { client: string; id: number }[]) => Promise<void>;
  /**
   * Journal a push before it is sent: these kept commands move to `sending`, all in one write (a key not kept is left
   * alone). A command loaded so is uncertain, since that attempt may have acted.
   */
  mark: (keys: { client: string; id: number }[]) => Promise<void>;
};

export type NetworkPort<P, S, C, O> = {
  pull: (request: {
    client: string;
    dataset: string | null;
    since: number;
    verify: boolean;
    /**
     * The older page wanted: null for none (a paged reset is understood), the copy's `next` while partial. Absent asks
     * for an old server's whole reply.
     */
    page?: string | null;
    /** Commands waiting on an outcome or on their effects, any page's: their receipts come with the rows they name. */
    commands?: { client: string; id: number }[];
  }) => Promise<Result<{ patch: Patch<P, S>; receipts: Receipt<O>[] }>>;
  push: (request: {
    client: string;
    dataset: string | null;
    /** The revision of the copy these commands were tapped against (0 before any). */
    since: number;
    commands: { id: number; command: C }[];
  }) => Promise<Result<{ receipts: Receipt<O>[]; revision: number }>>;
};

export type Ports<T, P, S, C, O> = {
  storage: StoragePort<T, S, C, O>;
  network: NetworkPort<P, S, C, O>;
  /** The fingerprint of a replica's tables, as the server computes it. */
  fingerprint: (replica: Replica<T, S>) => Promise<string>;
  now: () => number;
  answered?: (pending: Pending<C, O>) => void;
  telemetry?: (name: string, attributes: Record<string, string | number | boolean | null>) => void;
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createClient<T, P, S, C, O>(options: {
  sync: ReturnType<typeof createSync<T, P, S, C, O>>;
  ports: Ports<T, P, S, C, O>;
  client: string;
  render?: (model: Model<T, S, C, O>) => void;
}) {
  const { sync, ports } = options;

  type M = Msg<T, P, S, C, O>;

  /** Effects running now: a test waits for none before judging a quiet state. */
  const running = new Set<Promise<void>>();
  /** A port rejected where it must not (a bug in an adapter): kept for tests to fail on. */
  const faults: string[] = [];

  function track(work: Promise<M>, dispatch: (msg: M) => void): void {
    const job = work.then(dispatch, (error: unknown) => {
      // A port rejected where it must answer: kept for tests, and reported wherever the app sends telemetry.
      faults.push(reason(error));
      ports.telemetry?.("client.fault", { reason: reason(error) });
    });

    running.add(job);
    void job.finally(() => {
      running.delete(job);
    });
  }

  function run(effect: Effect<T, S, C, O>, dispatch: (msg: M) => void): void {
    const now = ports.now;

    switch (effect.kind) {
      case "load": {
        return track(
          ports.storage.load().then(
            (loaded): M => ({ type: "loaded", ...loaded, now: now() }),
            (error: unknown): M => ({ type: "loadFailed", reason: reason(error), now: now() })
          ),
          dispatch
        );
      }

      case "pull": {
        const since = effect.since;

        return track(
          ports.network
            .pull({
              client: effect.client,
              dataset: effect.dataset,
              since,
              verify: effect.verify,
              // An old server's whole copy is asked as an old client asks it: with neither.
              ...(effect.page === undefined
                ? {}
                : { page: effect.page, commands: effect.commands }),
            })
            .then(
              (result): M =>
                result.ok
                  ? { type: "pulled", since, ...result.value, now: now() }
                  : { type: "pullFailed", failure: result.failure, now: now() },
              (error: unknown): M => ({
                type: "pullFailed",
                failure: { kind: "offline", message: reason(error) },
                now: now(),
              })
            ),
          dispatch
        );
      }

      case "push": {
        const ids = effect.commands.map((each) => each.id);
        const client = effect.client;

        const send = () =>
          ports.network
            .push({
              client,
              dataset: effect.dataset,
              since: effect.since,
              commands: effect.commands,
            })
            .then(
              (result): M =>
                result.ok
                  ? { type: "pushed", client, ids, ...result.value, now: now() }
                  : { type: "pushFailed", client, ids, failure: result.failure, now: now() },
              (error: unknown): M => ({
                type: "pushFailed",
                client,
                ids,
                failure: { kind: "offline", message: reason(error) },
                now: now(),
              })
            );

        // Journalled before it is sent: a page that dies mid-push leaves these commands uncertain on disk.
        return track(
          ports.storage.mark(ids.map((id) => ({ client, id }))).then(send, (error: unknown): M => ({
            type: "unsent",
            client,
            ids,
            reason: reason(error),
            replaced: error instanceof Replaced,
            now: now(),
          })),
          dispatch
        );
      }

      case "commit": {
        return track(
          ports.storage.commit(effect).then(
            (stored): M => ({ type: "committed", ...stored, now: now() }),
            (error: unknown): M => ({
              type: "commitFailed",
              reason: reason(error),
              replaced: error instanceof Replaced,
              now: now(),
            })
          ),
          dispatch
        );
      }

      case "keep": {
        const { client, id } = effect.pending;

        return track(
          ports.storage.keep(effect.pending, effect.max).then(
            (kept): M =>
              kept === undefined
                ? { type: "kept", client, id, now: now() }
                : {
                    type: "full",
                    client,
                    id,
                    waiting: kept.waiting,
                    finished: kept.finished,
                    max: kept.max,
                    now: now(),
                  },
            (error: unknown): M => ({
              type: "keepFailed",
              client,
              id,
              reason: reason(error),
              now: now(),
            })
          ),
          dispatch
        );
      }

      case "drop": {
        return track(
          ports.storage.drop(effect.keys).then(
            (): M => ({ type: "dropped", failure: null, now: now() }),
            (error: unknown): M => ({
              type: "dropped",
              failure: error instanceof Replaced ? "replaced" : reason(error),
              now: now(),
            })
          ),
          dispatch
        );
      }

      case "check": {
        const { dataset, revision } = effect.replica;

        return track(
          ports.fingerprint(effect.replica).then((local): M => ({
            type: "checked",
            dataset,
            revision,
            match: local === effect.checksum,
            now: now(),
          })),
          dispatch
        );
      }

      case "answered": {
        return ports.answered?.(effect.pending);
      }

      case "telemetry": {
        return ports.telemetry?.(effect.name, effect.attributes);
      }
    }
  }

  const machine = runtime({
    model: sync.initial(options.client, ports.now()),
    update: sync.update,
    run,
    render:
      options.render ??
      (() => {
        // No view: a headless run reads the model directly.
      }),
  });

  return {
    dispatch: machine.dispatch,
    model: machine.model,
    /** Load the replica from storage: the first thing a page does. */
    start: () => run({ kind: "load" }, machine.dispatch),
    command: (command: C) => machine.dispatch({ type: "command", command, now: ports.now() }),
    /** Resolves once no effect is running (more may start from what these dispatch; call until quiet). */
    settle: async (): Promise<void> => {
      while (running.size > 0) {
        // oxlint-disable-next-line no-await-in-loop -- effects that finish may start more; wait until none are left
        await Promise.all(running);
      }
    },
    faults,
  };
}
