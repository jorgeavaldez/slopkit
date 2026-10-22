/**
 * The sync contract's endpoints, built from an app's own schemas: pull (what changed since a revision, paged), push
 * (commands, each acting once), telemetry (the page's counts and timings, for the server's log) and the socket's poke.
 * The page, the server and the engine share these shapes, so an app declares only its rows, what its server says of
 * itself, its commands and their outcomes.
 */
import { endpoint } from "./contract.ts";
import type { Endpoint } from "./contract.ts";
import {
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  record,
  scalar,
  string,
  variant,
} from "./schema.ts";
import type { Schema } from "./schema.ts";
import { PUSH_MAX } from "./sync.ts";
import type { Page, Pending, Receipt } from "./sync.ts";

/** The answers the kit's server gives a command itself (`slopkit/server/sync`): an app's outcomes must admit them. */
export type KitOutcome =
  | { kind: "failed"; reason: "conflict" | "forbidden"; message: string }
  | { kind: "retired" };

/** A reply's own fields: no row list may take one of their names. */
const RESERVED = new Set([
  "dataset",
  "revision",
  "reset",
  "commands",
  "server",
  "checksum",
  "page",
]);

/** Each row key's list, as a pull reply carries them. */
export type Rows<R> = { [K in keyof R]: R[K][] };

export type PullRequest = {
  client: string;
  dataset: string | null;
  since: number;
  verify?: boolean;
  page?: string | null;
  commands?: { client: string; id: number }[];
};

export type PullReply<R, S, O> = Rows<R> & {
  dataset: string;
  revision: number;
  reset: boolean;
  commands: Receipt<O>[];
  server: S;
  checksum?: string;
  page?: Page;
};

export type PushRequest<C> = {
  client: string;
  dataset: string | null;
  since: number;
  commands: { id: number; command: C }[];
};

export type PushReply<O> = { results: Receipt<O>[]; revision: number };

export type TelemetryEvent = {
  name: string;
  at: string;
  attributes?: Record<string, string | number | boolean | null>;
};

export type TelemetryRequest = { client: string; events: TelemetryEvent[] };

/** What the socket sends: the server's revision, when it moves and as a heartbeat. */
export type Poke = { type: "poke"; revision: number };

export type SyncApi<R, S, C, O> = {
  /** The row keys, in the order the fingerprint and the checksum digest them. */
  rows: readonly (keyof R & string)[];
  /** What the server says of itself, read with every pull. */
  server: Schema<S>;
  pull: Endpoint<PullRequest, PullReply<R, S, O>>;
  push: Endpoint<PushRequest<C>, PushReply<O>>;
  telemetry: Endpoint<TelemetryRequest, { ok: true }>;
  socket: { path: string; message: Schema<Poke> };
  /** A command as a device's outbox keeps it, checked when read back. */
  pending: Schema<Pending<C, O>>;
};

const revision = number({ integer: true, min: 0 });
const client = string({ pattern: /^[A-Za-z0-9_-]{8,64}$/ });
const commandId = number({ integer: true, min: 1 });
const cursor = string({ min: 1, max: 1000 });

const iso = string({
  pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
});

export function syncApi<R extends Record<string, { id: string | number }>, S, C, O>(definition: {
  rows: { [K in keyof R]: Schema<R[K]> };
  server: Schema<S>;
  command: Schema<C>;
  outcome: Schema<O>;
  /** A store's dataset id; default text of 1 to 200 characters. */
  dataset?: Schema<string>;
  /** A page's `through`, as the app formats an order group; default text of at most 64 characters. */
  through?: Schema<string>;
}): SyncApi<R, S, C, O> {
  const keys = Object.keys(definition.rows);
  const taken = keys.find((key) => RESERVED.has(key));

  if (taken !== undefined) {
    throw new Error(`syncApi: a row key can't be a reply's own field: ${taken}`);
  }

  const dataset = definition.dataset ?? string({ min: 1, max: 200 });

  const receipt = object(
    { id: commandId, outcome: definition.outcome, revision, client: optional(client) },
    { strict: true }
  );

  const page = object(
    {
      from: nullable(cursor),
      next: nullable(cursor),
      through: nullable(definition.through ?? string({ max: 64 })),
      held: number({ integer: true, min: 0 }),
      total: number({ integer: true, min: 0 }),
    },
    { strict: true }
  );

  const lists = Object.fromEntries(
    Object.entries<Schema<unknown>>(definition.rows).map(([key, row]) => [key, array(row)])
  );

  const reply = object(
    {
      dataset,
      revision,
      reset: boolean(),
      ...lists,
      commands: array(receipt),
      server: definition.server,
      checksum: optional(string({ pattern: /^[0-9a-f]{64}$/ })),
      page: optional(page),
    },
    { strict: true }
  );

  const pull = endpoint(
    "GET",
    "/api/pull",
    object(
      {
        client,
        dataset: nullable(dataset),
        since: revision,
        verify: optional(boolean()),
        page: optional(nullable(cursor)),
        commands: optional(
          array(object({ client, id: commandId }, { strict: true }), { max: PUSH_MAX })
        ),
      },
      { strict: true }
    ),
    {
      expected: reply.expected,
      shape: reply.shape,
      // SAFETY: `reply` is the strict object of exactly PullReply's fields: the fixed ones above and one array of
      // each row schema under its key; the spread of `lists` is what TypeScript can't follow.
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      parse: (value, path) => reply.parse(value, path) as PullReply<R, S, O>,
    }
  );

  const push = endpoint(
    "POST",
    "/api/push",
    object(
      {
        client,
        dataset: nullable(dataset),
        since: revision,
        commands: array(object({ id: commandId, command: definition.command }, { strict: true }), {
          max: PUSH_MAX,
        }),
      },
      { strict: true }
    ),
    object({ results: array(receipt), revision }, { strict: true })
  );

  const telemetry = endpoint(
    "POST",
    "/api/telemetry",
    object(
      {
        client,
        events: array(
          object(
            {
              name: string({ pattern: /^[a-z][a-z0-9.-]{0,63}$/ }),
              at: iso,
              attributes: optional(record(scalar())),
            },
            { strict: true }
          ),
          { max: 100 }
        ),
      },
      { strict: true }
    ),
    object({ ok: literal(true) }, { strict: true })
  );

  const message = variant("type", {
    poke: object({ type: literal("poke"), revision }, { strict: true }),
  });

  const pending = object(
    {
      client,
      id: commandId,
      dataset: nullable(dataset),
      since: optional(revision),
      command: definition.command,
      at: number(),
      state: variant("kind", {
        saving: object({ kind: literal("saving") }, { strict: true }),
        queued: object({ kind: literal("queued") }, { strict: true }),
        sending: object({ kind: literal("sending") }, { strict: true }),
        unknown: object(
          { kind: literal("unknown"), failure: string(), parked: optional(literal(true)) },
          { strict: true }
        ),
        done: object(
          { kind: literal("done"), outcome: definition.outcome, revision },
          { strict: true }
        ),
      }),
    },
    { strict: true }
  );

  return {
    rows: keys,
    server: definition.server,
    pull,
    push,
    telemetry,
    socket: { path: "/api/socket", message },
    pending,
  };
}
