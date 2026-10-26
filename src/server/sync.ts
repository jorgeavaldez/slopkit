/**
 * The server's half of sync, over a replicated store (`slopkit/server/store`) and the app's sync contract
 * (`slopkit/api`): pull and push handlers, their routes with telemetry, the poke socket, and `serveSync`, which serves
 * them all on the kit's web server. An app supplies its tables, its commands and what its server says of itself.
 *
 * - **A push acts only on the history it was tapped against:** one naming another dataset, or a revision this store
 *   doesn't know, runs none of its commands.
 * - **Authorization before the ledger, every time,** replays included; then each command runs once through the ledger,
 *   in order, and its receipt carries the revision where its effects are.
 * - **Served before replied:** the store records each reply's revision (`served`) before the reply leaves.
 * - **The socket only hints:** a poke carries the store's revision when it moves and as a heartbeat; the page pulls
 *   whatever it hears.
 * - **Telemetry is written, never trusted:** the page's events go to the log under the caller's identity.
 */
import type {
  KitOutcome,
  PullReply,
  PullRequest,
  PushReply,
  PushRequest,
  SyncApi,
} from "../api.ts";
import { digest } from "../digest.ts";
import { check } from "../schema.ts";
import type { Receipt } from "../sync.ts";
import type { CommandKey, Ledger } from "./ledger.ts";
import type { Attributes, Logger } from "./log.ts";
import { createPull } from "./pull.ts";
import type { PullLimits, PullOptions } from "./pull.ts";
import type { SyncStore } from "./store.ts";
import { Refusal, route, serveWeb, whoOf } from "./web.ts";
import type { Caller, RawRoute, Route, Socket, WebOptions } from "./web.ts";

export type { KitOutcome } from "../api.ts";

/** The kit's own refusal messages, said the same in every app. */
export const KIT_ANSWERS = {
  replaced: "the server's data was replaced since this was tapped; tap again",
  history: "this page's copy is from another history of the server's data; it starts over",
  forbidden: (name: string) => `only a person's login can ${name}`,
  reused: (id: number) => `command ${id} was already used for another command`,
};

/**
 * The kit's own answers must come through the app's outcome schema, which checks every reply, or they'd never reach a
 * page: refused when the routes are made. The type check (`Admits`) can't see a schema's bounds; this can.
 */
function admitted<R, S, C, O>(api: SyncApi<R, S, C, O>): void {
  const answers: KitOutcome[] = [
    { kind: "failed", reason: "conflict", message: KIT_ANSWERS.replaced },
    { kind: "failed", reason: "conflict", message: KIT_ANSWERS.history },
    { kind: "failed", reason: "conflict", message: KIT_ANSWERS.reused(Number.MAX_SAFE_INTEGER) },
    { kind: "failed", reason: "forbidden", message: KIT_ANSWERS.forbidden("command") },
    { kind: "retired" },
  ];

  const outcome = api.push.response;

  for (const answer of answers) {
    const parsed = check(outcome, {
      results: [{ id: 1, outcome: answer, revision: 0 }],
      revision: 0,
    });

    if (!parsed.ok) {
      throw new Error(`the outcome schema refuses the kit's own answer: ${parsed.error.message}`);
    }
  }
}

/**
 * Nothing when the api's outcome union admits the kit's own answers, else `never`: where the handlers meet the api,
 * an outcome schema that would refuse them doesn't compile.
 */
type Admits<O> = KitOutcome extends O ? unknown : never;

/** How a command acts: only in the store, inside its claim's transaction, or elsewhere after it. */
export type Act<K> = { local: () => K } | { local: () => K | undefined; remote: () => Promise<K> };

/** One command a push ran: its key, the command, what the ledger kept, and whether it acted just now. */
export type Ran<C, K> = { key: CommandKey; command: C; kept: K; fresh: boolean };

/** Who asks, as the handlers read it: a `Caller`, or anything carrying its identities and whether a person. */
export type Who = { identities: readonly string[]; person: boolean };

/** What `serveSync` and the routes need of the handlers. */
export type Sync<R, S, C, O, V extends Who = Caller> = {
  pull: (request: PullRequest, caller: V) => Promise<PullReply<R, S, O>>;
  push: (request: PushRequest<C>, caller: V) => Promise<PushReply<O>>;
  revision: () => number;
  subscribe: (listener: () => void) => () => void;
};

/** A row read from SQLite, as `createPull` hands it to `read`. */
type HistoryOptions<R> = PullOptions<
  R,
  Record<string, readonly unknown[]>,
  never,
  never,
  never
>["paged"];

/**
 * Whose commands these are: every person is the one owner (single user by design), so a person is one principal
 * whichever login they came through; each service or key is its own.
 */
export function principalOf(caller: Who): string {
  if (caller.person) {
    return "person";
  }

  return caller.identities.toSorted().join(" ") || "service";
}

export function syncHandlers<
  R extends Record<string, { id: string | number }>,
  S,
  C extends { name: string },
  O,
  K extends { kind: string },
  H extends keyof R & string,
  V extends Who = Caller,
>(options: {
  api: SyncApi<R, S, C, O>;
  store: SyncStore;
  ledger: Ledger<K>;
  log: Logger;
  /** What the server says of itself, with every pull. */
  server: (caller: V) => S;
  /** The history: the table paged newest first (`slopkit/server/pull`), and its row key in the api. */
  history: HistoryOptions<R[H]> & { row: H };
  /**
   * The other row keys' rows changed after `since`, or every live row for 0, as this caller may read them (a table
   * only people see is empty for a service).
   */
  unpaged: (since: number, caller: V) => { [Key in Exclude<keyof R, H>]: R[Key][] };
  /**
   * Every live row of every table this caller may read (what its complete copy holds), for a verifying pull's
   * checksum: the same rows `unpaged(0, caller)` gives.
   */
  everything: (caller: V) => { [Key in keyof R]: readonly R[Key][] };
  /** The history rows (by key) a receipt names: they come in the reply that carries it. */
  names: (kept: K) => readonly (string | number)[];
  limits: PullLimits;
  act: (command: C, caller: V, key: CommandKey) => Act<K>;
  /** A kept receipt as callers see it (a link as its row now); `(kept) => kept` when they are the same. */
  outcome: (kept: K) => O;
  /** Commands only a person's login may run. */
  personOnly?: (command: C) => boolean;
  principal?: (caller: V) => string;
  /** After a push's commands ran, before its reply: what each did. */
  pushed?: (ran: Ran<C, K>[], caller: V) => void;
}): Sync<R, S, C, O | KitOutcome, V> & { changed: () => void } {
  const { api, store, ledger, log } = options;
  const listeners = new Set<() => void>();
  const principal = options.principal ?? principalOf;

  const { outcome } = options;

  type Answer = O | KitOutcome;

  const changed = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  type Pulled = { client: string; id: number; receipt: K; revision: number };

  async function pull(request: PullRequest, caller: V): Promise<PullReply<R, S, Answer>> {
    if (caller.person && request.dataset === store.dataset() && store.wentBack(request.since)) {
      log("warn", "a page holds more than the store: it was restored or went back; a new dataset", {
        seen: request.since,
        revision: store.revision(),
      });
    }

    const server = options.server(caller);
    const who = principal(caller);
    const { row, ...paged } = options.history;

    const pulls = createPull({
      db: store.db,
      dataset: () => store.dataset(),
      revision: () => store.revision(),
      known: (since) => store.known(since),
      paged,
      unpaged: (since) => options.unpaged(since, caller),
      receipts: {
        read: (ask): Pulled[] =>
          ask.commands === undefined
            ? ledger
                .receipts(who, request.client, ask.since)
                .map((each) => ({ ...each, client: request.client }))
            : ledger.receiptsOf(who, ask.commands),
        names: (each: Pulled) => options.names(each.receipt),
      },
      limits: options.limits,
      respond: (pulled) => {
        const receipts: Receipt<Answer>[] = pulled.receipts.map((each) => ({
          id: each.id,
          outcome: outcome(each.receipt),
          revision: each.revision,
          ...(each.client === request.client ? {} : { client: each.client }),
        }));

        const rows = { ...pulled.unpaged, [row]: pulled.rows };

        // SAFETY: the history's rows under its key and the other keys' from `unpaged` are every row key of R, each
        // its rows; the reply's own fields follow.
        // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        return {
          ...rows,
          dataset: pulled.dataset,
          revision: pulled.revision,
          reset: pulled.reset,
          commands: receipts,
          server,
          ...(pulled.page === undefined ? {} : { page: pulled.page }),
        } as PullReply<R, S, Answer>;
      },
    });

    const { reply } = pulls.pull(request, caller);
    const partial = reply.page !== undefined && reply.page.next !== null;
    const all = request.verify === true && !partial ? options.everything(caller) : undefined;

    store.served(reply.revision);

    if (all === undefined) {
      return reply;
    }

    return { ...reply, checksum: await digest(api.rows.map((key) => all[key])) };
  }

  async function command(
    key: CommandKey,
    each: C,
    caller: V
  ): Promise<{ outcome: Answer; ran?: Ran<C, K> } | undefined> {
    if (!caller.person && options.personOnly?.(each) === true) {
      return {
        outcome: {
          kind: "failed",
          reason: "forbidden",
          message: KIT_ANSWERS.forbidden(each.name),
        },
      };
    }

    const act = options.act(each, caller, key);

    const ran = await ledger.run(
      key,
      { name: each.name, args: JSON.stringify(each) },
      {
        local: act.local,
        remote:
          "remote" in act
            ? act.remote
            : () => Promise.reject(new Error(`${each.name} acts only in the store`)),
      }
    );

    if (ran.kind === "elsewhere") {
      return undefined;
    }

    if (ran.kind === "retired") {
      return { outcome: { kind: "retired" } };
    }

    if (ran.kind === "conflict") {
      return {
        outcome: {
          kind: "failed",
          reason: "conflict",
          message: KIT_ANSWERS.reused(key.id),
        },
      };
    }

    if (ran.fresh) {
      const { kind } = ran.receipt;
      const attributes: Attributes = { client: key.client, id: key.id };
      log(kind === "failed" ? "warn" : "info", `command ${each.name} ${kind}`, attributes);
    }

    return {
      outcome: outcome(ran.receipt),
      ran: { key, command: each, kept: ran.receipt, fresh: ran.fresh },
    };
  }

  async function push(request: PushRequest<C>, caller: V): Promise<PushReply<Answer>> {
    const refuse = (message: string): PushReply<Answer> => {
      const revision = store.revision();
      store.served(revision);

      return {
        results: request.commands.map(({ id }) => ({
          id,
          outcome: { kind: "failed", reason: "conflict", message },
          revision,
        })),
        revision,
      };
    };

    // Tapped against another store (this one was replaced or restored since): nothing runs.
    if (request.dataset !== null && request.dataset !== store.dataset()) {
      return refuse(KIT_ANSWERS.replaced);
    }

    // A page holding a revision this history never had, or no longer remembers: its taps may have run in a history
    // that is gone, so none runs here, and its next pull starts it over.
    if (!store.known(request.since)) {
      return refuse(KIT_ANSWERS.history);
    }

    const results: Receipt<Answer>[] = [];
    const ran: Ran<C, K>[] = [];

    for (const { id, command: each } of request.commands) {
      const key: CommandKey = { principal: principal(caller), client: request.client, id };
      // oxlint-disable-next-line no-await-in-loop -- a push's commands act in the order they were tapped
      const done = await command(key, each, caller);

      if (done === undefined) {
        continue;
      }

      if (done.ran !== undefined) {
        ran.push(done.ran);
      }

      // Where its effects are visible: the receipt's own revision (a replay too), else the store's now.
      results.push({
        id,
        outcome: done.outcome,
        revision: ledger.revisionOf(key) ?? store.revision(),
      });
    }

    // The revision the reply carries is served before anything else can move it (`pushed` may write).
    const revision = store.revision();
    store.served(revision);
    changed();
    options.pushed?.(ran, caller);

    return { results, revision };
  }

  return {
    pull,
    push,
    revision: () => store.revision(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    changed,
  };
}

/**
 * The sync contract's routes: pull, push and telemetry. Each telemetry event is one `page` log line at `info`, its
 * attributes the event's own with the kit's (`client`, `at`, `person`) set last, so a page can't claim another sender.
 */
/** A copy is only ever synced under its own person's login: another's is refused before anything acts. */
function theirs(request: { as?: string }, caller: Caller): void {
  if (request.as !== undefined && request.as !== whoOf(caller.identities)) {
    throw new Refusal("signed-out", "this page's copy is another person's; sign in as them");
  }
}

export function syncRoutes<R, S, C, O>(
  api: SyncApi<R, S, C, O>,
  handlers: Pick<Sync<R, S, C, NoInfer<O> | KitOutcome>, "pull" | "push"> & {
    page: Logger;
  } & Admits<NoInfer<O>>
): Route[] {
  admitted(api);

  return [
    route<PullRequest, PullReply<R, S, O | KitOutcome>>(api.pull, (request, caller) => {
      theirs(request, caller);

      return handlers.pull(request, caller);
    }),
    route<PushRequest<C>, PushReply<O | KitOutcome>>(api.push, (request, caller) => {
      theirs(request, caller);

      return handlers.push(request, caller);
    }),
    route(api.telemetry, (request, caller) => {
      for (const event of request.events) {
        handlers.page("info", event.name, {
          ...event.attributes,
          client: request.client,
          at: event.at,
          person: caller.person,
        });
      }

      return { ok: true as const };
    }),
  ];
}

/**
 * The poke socket: one poke with the revision on open, one for the changes within `gatherMs` (carrying the revision
 * when it is sent), and a beat every `beatMs`, so a lost poke is made up for and a quiet socket is a dead one.
 */
export function pokes<R, S, C, O>(
  api: SyncApi<R, S, C, O>,
  options: {
    revision: () => number;
    subscribe: (listener: () => void) => () => void;
    beatMs?: number;
    gatherMs?: number;
  }
): Socket {
  return {
    path: api.socket.path,
    open: (send) => {
      const poke = () => {
        send({ type: "poke", revision: options.revision() });
      };

      let pending: ReturnType<typeof setTimeout> | undefined;

      const unsubscribe = options.subscribe(() => {
        pending ??= setTimeout(() => {
          pending = undefined;
          poke();
        }, options.gatherMs ?? 50);
      });

      poke();
      const alive = setInterval(poke, options.beatMs ?? 20_000);

      return () => {
        unsubscribe();
        clearTimeout(pending);
        clearInterval(alive);
      };
    },
  };
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The install manifest's fields an app sets. */
export type Manifest = {
  id: string;
  name: string;
  short_name: string;
  description?: string;
  start_url: string;
  scope: string;
  display: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/**
 * An app's web server: `serveWeb` with the sync routes, the poke socket, the session cookie `<name>_session`, the
 * page's who cookie `<name>_who` and the install manifest made from the name (black, `/icon.svg`), each field
 * overridable. Extra routes are served beside them.
 */
/** What `serveSync` takes: `serveWeb`'s options, less what it makes from these. */
export type SyncServerOptions<R, S, C, O> = Omit<
  WebOptions,
  "routes" | "socket" | "cookie" | "who" | "manifest"
> & {
  name: string;
  api: SyncApi<R, S, C, O>;
  sync: Sync<R, S, C, O | KitOutcome>;
  /** Where the page's telemetry is written. */
  page: Logger;
  routes?: (Route | RawRoute)[];
  manifest?: Partial<Manifest>;
};

export async function serveSync<R, S, C, O>(
  options: SyncServerOptions<R, S, C, NoInfer<O>> & { api: SyncApi<R, S, C, O> } & Admits<
      NoInfer<O>
    >
): Promise<Awaited<ReturnType<typeof serveWeb>>> {
  const given: SyncServerOptions<R, S, C, O> = options;
  const { name, api, sync, page, routes = [], manifest = {}, ...web } = given;

  if (!NAME.test(name)) {
    throw new Error(`serveSync: not an app name: ${name}`);
  }

  return await serveWeb({
    ...web,
    cookie: `${name}_session`,
    who: `${name}_who`,
    manifest: {
      id: "/",
      name,
      short_name: name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      ...manifest,
    },
    routes: [
      ...syncRoutes<R, S, C, O | KitOutcome>(api, { pull: sync.pull, push: sync.push, page }),
      ...routes,
    ],
    socket: pokes(api, { revision: sync.revision, subscribe: sync.subscribe }),
  });
}
