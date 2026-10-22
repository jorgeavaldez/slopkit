/**
 * The page's ports for the sync engine (`slopkit/client`), and nothing that decides: IndexedDB for the replica and the
 * outbox, fetch for pull and push through the app's sync contract (`slopkit/api`), Web Crypto for the fingerprint, the
 * poke socket with its backoff, a 1 s tick, visibility, lasting storage and telemetry. The engine is the same one a
 * headless simulation runs; every browser global is a port (`env`), so this runs headless too.
 *
 * - **The socket only pokes:** what it hears is checked and becomes `heard`; it reconnects with backoff, and a page
 *   pulls whatever the socket says.
 * - **Telemetry is bounded:** the newest 100 events wait for a flush (every 30 s and when the page hides); a flush the
 *   network lost puts back the newest 50.
 * - **Updated under the page:** a reconciled pull from another server version reloads the page, once.
 */
import type { PullReply, SyncApi } from "../api.ts";
import { createClient } from "../client.ts";
import { call } from "../contract.ts";
import { digest } from "../digest.ts";
import { check } from "../schema.ts";
import type { Schema } from "../schema.ts";
import type { createSync, Lens, Model, Pending } from "../sync.ts";
import { indexedReplica } from "./replica.ts";

type Attributes = Record<string, string | number | boolean | null>;

/** What the runtime needs of a WebSocket: it sets the handlers; a message carries `data`. */
export type SocketLike = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close: () => void;
};

/** The browser's WebSocket as a `SocketLike`. */
function webSocket(url: string): SocketLike {
  const socket = new WebSocket(url);

  const like: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    close: () => socket.close(),
  };

  socket.addEventListener("open", () => like.onopen?.());
  socket.addEventListener("message", (event) => like.onmessage?.({ data: event.data }));
  socket.addEventListener("close", () => like.onclose?.());

  return like;
}

/** The browser, as ports: each defaults to the page's own global. */
export type RuntimeEnv = {
  indexedDB: IDBFactory;
  fetch: typeof fetch;
  socket: (url: string) => SocketLike;
  location: { protocol: string; host: string; reload: () => void };
  document: {
    readonly visibilityState: string;
    addEventListener: (type: "visibilitychange", listener: () => void) => void;
    removeEventListener: (type: "visibilitychange", listener: () => void) => void;
  };
  /** `navigator.storage.persist`: whether the browser grants this copy lasting storage. */
  persist: () => Promise<boolean>;
  now: () => number;
  /** `performance.now`: for durations. */
  monotonic: () => number;
  /** Run once after `ms`; the returned function cancels it. */
  setTimeout: (run: () => void, ms: number) => () => void;
  /** Run every `ms`; the returned function stops it. */
  setInterval: (run: () => void, ms: number) => () => void;
  random: (count: number) => Uint8Array;
};

function browser(): RuntimeEnv {
  return {
    indexedDB: globalThis.indexedDB,
    fetch: (input, init) => globalThis.fetch(input, init),
    socket: webSocket,
    location: globalThis.location,
    document: globalThis.document,
    persist: async () => (await globalThis.navigator.storage?.persist?.()) ?? false,
    now: () => Date.now(),
    monotonic: () => performance.now(),
    setTimeout: (run, ms) => {
      const handle = globalThis.setTimeout(run, ms);

      return () => globalThis.clearTimeout(handle);
    },
    setInterval: (run, ms) => {
      const handle = globalThis.setInterval(run, ms);

      return () => globalThis.clearInterval(handle);
    },
    random: (count) => crypto.getRandomValues(new Uint8Array(count)),
  };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** The longest the socket waits before trying again, and the base it doubles from. */
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MS = 1000;
const EVENTS_KEPT = 100;
const EVENTS_PUT_BACK = 50;
const FLUSH_MS = 30_000;
const TICK_MS = 1000;

export function createRuntime<
  T,
  R extends Record<string, { id: string | number }>,
  S extends { version: string },
  C,
  O,
>(options: {
  /** The IndexedDB database's name. */
  name: string;
  sync: ReturnType<typeof createSync<T, PullReply<R, S, O>, S, C, O>>;
  api: SyncApi<R, S, C, O>;
  replica: {
    version: number;
    tables: readonly Lens<T, PullReply<R, S, O>>[];
    empty: T;
    /** The outbox's command schema; default the api's. */
    pending?: Schema<Pending<C, O>>;
    legacy?: { store: string; convert: (value: unknown) => Pending<C, O> | undefined };
    /** By table: an earlier release's row as this one reads it, so an upgrade keeps the offline copy (`web/replica`). */
    lifts?: Readonly<Record<string, (row: unknown) => unknown>>;
  };
  /** How long a push may take before it counts as lost (default 30 s). */
  pushTimeoutMs?: number;
  /** The app's hook when a command is answered (to open or close a provider's window, say). */
  answered?: (pending: Pending<C, O>) => void;
  /** The attributes of the first model that counts as painted, else undefined. Default: once the copy loaded. */
  painted?: (model: Model<T, S, C, O>) => Attributes | undefined;
  env?: Partial<RuntimeEnv>;
}) {
  const env: RuntimeEnv = { ...browser(), ...options.env };
  const { api } = options;
  const created = env.monotonic();
  const client = base64url(env.random(18));
  const origin = `${env.location.protocol}//${env.location.host}`;

  const lenses = api.rows.map((key) => {
    const lens = options.replica.tables.find((each) => each.name === key);

    if (lens === undefined) {
      throw new Error(`createRuntime: no table for the row key ${key}`);
    }

    return lens;
  });

  const storage = indexedReplica({
    factory: env.indexedDB,
    name: options.name,
    version: options.replica.version,
    tables: options.replica.tables,
    empty: options.replica.empty,
    server: api.server,
    pending: options.replica.pending ?? api.pending,
    ...(options.replica.legacy === undefined ? {} : { legacy: options.replica.legacy }),
    ...(options.replica.lifts === undefined ? {} : { lifts: options.replica.lifts }),
  });

  const events: { name: string; at: string; attributes?: Attributes }[] = [];

  function record(name: string, attributes?: Attributes): void {
    events.push({
      name,
      at: new Date(env.now()).toISOString(),
      ...(attributes === undefined ? {} : { attributes }),
    });

    if (events.length > EVENTS_KEPT) {
      events.splice(0, events.length - EVENTS_KEPT);
    }
  }

  async function flush(): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const batch = events.splice(0);

    const sent = await call(
      api.telemetry,
      { client, events: batch },
      { fetch: env.fetch, base: origin }
    );

    // Kept for the next try unless the server took them or refused them for good.
    if (!sent.ok && (sent.failure.kind === "offline" || sent.failure.kind === "unavailable")) {
      events.unshift(...batch.slice(-EVENTS_PUT_BACK));
      // Still the newest 100 at most: one call carries them all.
      events.splice(0, Math.max(0, events.length - EVENTS_KEPT));
    }
  }

  /**
   * Whether the browser grants this copy lasting storage, asked once at creation. The copy never waits for it: a
   * browser that asks the person may not have answered by the time the copy loads.
   */
  const persisted: Promise<boolean> = (async () => {
    let granted = false;

    try {
      granted = await env.persist();
    } catch {
      // Not granted: the copy may be cleared, and the page says so.
    }

    record("storage.persist", { granted });

    return granted;
  })();

  const listeners = new Set<(model: Model<T, S, C, O>) => void>();
  /** Stopped for good: nothing more leaves the page. */
  let stopped = false;
  /** The version this page first reconciled with: another means the server was updated under it. */
  let pulledVersion: string | undefined;
  let reloaded = false;
  let painted = false;

  const engine = createClient({
    sync: options.sync,
    client,
    ports: {
      storage: {
        ...storage,
        load: async () => {
          const loaded = await storage.load();
          // Its answer if it came while the copy loaded, else no grant yet.
          const persistent = await Promise.race([persisted, Promise.resolve(false)]);

          return { ...loaded, persistent };
        },
      },
      network: {
        pull: async (request) => {
          // Stopped: nothing more leaves the page, whatever was under way when it stopped.
          if (stopped) {
            return { ok: false, failure: { kind: "offline", message: "the runtime stopped" } };
          }

          const result = await call(
            api.pull,
            {
              client: request.client,
              dataset: request.dataset,
              since: request.since,
              ...(request.verify ? { verify: true } : {}),
              // Pages (and the commands it waits on) only when the engine asks for them, else an old server's whole copy.
              ...(request.page === undefined
                ? {}
                : { page: request.page, commands: request.commands ?? [] }),
            },
            { fetch: env.fetch, base: origin }
          );

          if (!result.ok) {
            return result;
          }

          const reply = result.value;

          return {
            ok: true,
            value: {
              patch: {
                dataset: reply.dataset,
                revision: reply.revision,
                reset: reply.reset,
                rows: reply,
                server: reply.server,
                ...(reply.checksum === undefined ? {} : { checksum: reply.checksum }),
                ...(reply.page === undefined ? {} : { page: reply.page }),
              },
              receipts: reply.commands,
            },
          };
        },
        push: async (request) => {
          if (stopped) {
            return { ok: false, failure: { kind: "offline", message: "the runtime stopped" } };
          }

          const result = await call(api.push, request, {
            fetch: env.fetch,
            base: origin,
            timeoutMs: options.pushTimeoutMs ?? 30_000,
          });

          return result.ok
            ? {
                ok: true,
                value: { receipts: result.value.results, revision: result.value.revision },
              }
            : result;
        },
      },
      fingerprint: (replica) =>
        digest(
          lenses.map((lens) =>
            lens.snapshot(replica.tables).flatMap((op) =>
              // SAFETY: a table's rows are contract rows, each with its `id` (R's rows extend { id }).
              // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
              "row" in op ? [op.row as { id: string | number }] : []
            )
          )
        ),
      now: env.now,
      ...(options.answered === undefined ? {} : { answered: options.answered }),
      telemetry: record,
    },
    render: (next) => {
      for (const listener of listeners) {
        listener(next);
      }

      if (!painted) {
        const attributes = options.painted
          ? options.painted(next)
          : next.boot.kind === "loading"
            ? undefined
            : {};

        if (attributes !== undefined) {
          painted = true;
          record("page.painted", { ...attributes, ms: Math.round(env.monotonic() - created) });
        }
      }

      const version = next.reconciledAt === null ? undefined : next.replica.server?.version;

      if (version === undefined) {
        return;
      }

      // The server was updated under this page: load its client (the service worker fetches the shell first).
      if (pulledVersion !== undefined && pulledVersion !== version && !reloaded) {
        reloaded = true;
        env.location.reload();
      }

      pulledVersion ??= version;
    },
  });

  /** Forgets under way: `settle` waits for them too. */
  const pending = new Set<Promise<void>>();
  let started = false;
  let socket: SocketLike | undefined;
  let retry: (() => void) | undefined;
  const intervals: (() => void)[] = [];

  const visibility = () => {
    const visible = env.document.visibilityState === "visible";
    engine.dispatch({ type: "visible", visible, now: env.now() });

    if (!visible) {
      void flush().catch(() => undefined);
    }
  };

  /** The socket: a hint channel, reopened with backoff after consecutive tries that never opened. */
  function connect(attempt: number): void {
    if (stopped) {
      return;
    }

    const protocol = env.location.protocol === "https:" ? "wss" : "ws";
    const opening = env.socket(`${protocol}://${env.location.host}${api.socket.path}`);
    socket = opening;
    let opened = false;

    opening.onopen = () => {
      opened = true;
      engine.dispatch({ type: "socket", open: true, now: env.now() });
    };

    opening.onmessage = (event) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      const message = check(api.socket.message, parsed);

      if (message.ok) {
        engine.dispatch({ type: "heard", revision: message.value.revision, now: env.now() });
      }
    };

    opening.onclose = () => {
      if (socket !== opening) {
        return;
      }

      socket = undefined;
      engine.dispatch({ type: "socket", open: false, now: env.now() });

      if (stopped) {
        return;
      }

      const next = opened ? 0 : attempt + 1;

      retry = env.setTimeout(
        () => {
          retry = undefined;
          connect(next);
        },
        Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** Math.min(next, 5))
      );
    };
  }

  return {
    client,
    model: engine.model,
    subscribe: (listener: (model: Model<T, S, C, O>) => void): (() => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    /** Load the copy (it paints first; the engine pulls once loaded), open the socket, start the clocks. */
    start: (): void => {
      if (started) {
        return;
      }

      started = true;
      engine.start();
      connect(0);
      intervals.push(
        env.setInterval(() => engine.dispatch({ type: "tick", now: env.now() }), TICK_MS),
        env.setInterval(() => {
          void flush().catch(() => undefined);
        }, FLUSH_MS)
      );
      env.document.addEventListener("visibilitychange", visibility);
    },
    /** Close the socket for good, clear every timer and listener: nothing dispatches on its own after it. */
    stop: (): void => {
      stopped = true;

      for (const cancel of intervals.splice(0)) {
        cancel();
      }

      retry?.();
      retry = undefined;

      env.document.removeEventListener("visibilitychange", visibility);
      const open = socket;
      socket = undefined;
      open?.close();
    },
    command: (command: C): void => engine.command(command),
    /** The person is done with a finished command: it leaves the page and this device's outbox. */
    dismiss: (command: { client: string; id: number }): void =>
      engine.dispatch({ type: "dismiss", client: command.client, id: command.id, now: env.now() }),
    /** Drop this device's copy (the server keeps everything) and start over. */
    forget: (): Promise<void> => {
      const forgetting = storage.forget().then(() => env.location.reload());
      pending.add(forgetting);
      void forgetting
        .finally(() => {
          pending.delete(forgetting);
        })
        .catch(() => undefined);

      return forgetting;
    },
    record,
    flush,
    /** Resolves once no effect is running and no forget is under way. */
    settle: async (): Promise<void> => {
      await engine.settle();
      await Promise.allSettled(pending);
    },
  };
}
