import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";

import { createClient } from "../client.ts";
import { literal, nullable, number, object, optional, string, variant } from "../schema.ts";
import * as syncApi from "../sync.ts";
import { createSync, POLL_MS } from "../sync.ts";
import type { Pending } from "../sync.ts";
import { indexedReplica } from "../web/replica.ts";
import { outcomeSchema } from "./fixtures.ts";
import type { Outcome } from "./fixtures.ts";

type Command = { text: string };

const pendingSchema = object({
  client: string(),
  id: number(),
  dataset: nullable(string()),
  since: optional(number()),
  command: object({ text: string() }),
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
    done: object({ kind: literal("done"), outcome: outcomeSchema, revision: number() }),
  }),
});

function engine(pushBytes?: number) {
  return createSync<
    Record<string, never>,
    Record<string, never>,
    Record<string, never>,
    Command,
    Outcome
  >({
    tables: [],
    empty: {},
    onlineOnly: () => false,
    refused: (_command, reason) => ({ kind: "failed", reason }),
    ...(pushBytes === undefined ? {} : { pushBytes }),
  });
}

function storage() {
  return indexedReplica({
    factory: new IDBFactory(),
    name: "bytes",
    version: 1,
    tables: [],
    empty: {},
    server: object({}),
    pending: pendingSchema,
  });
}

const queued = (id: number, text: string): Pending<Command, Outcome> => ({
  client: "earlier",
  id,
  dataset: "d",
  since: 1,
  command: { text },
  at: 0,
  state: { kind: "queued" },
});

async function run(commands: Pending<Command, Outcome>[], pushBytes?: number) {
  const disk = storage();
  await disk.load();

  for (const each of commands) {
    await disk.keep(each);
  }

  const requests: { bytes: number; ids: number[] }[] = [];
  const answered: Pending<Command, Outcome>[] = [];

  const client = createClient({
    sync: engine(pushBytes),
    client: "new",
    ports: {
      storage: disk,
      now: () => 0,
      fingerprint: async () => "fixture",
      answered: (each) => {
        answered.push(each);
      },
      network: {
        pull: async () => ({
          ok: true,
          value: {
            patch: {
              dataset: "d",
              revision: 1,
              reset: true,
              rows: {},
              server: {},
              checksum: "fixture",
            },
            receipts: [],
          },
        }),
        push: async (input) => {
          requests.push({
            bytes: new TextEncoder().encode(JSON.stringify(input)).byteLength,
            ids: input.commands.map((each) => each.id),
          });

          return {
            ok: true,
            value: {
              revision: 1,
              receipts: input.commands.map((each) => ({
                id: each.id,
                outcome: { kind: "ok" as const, resource: `r${each.id}` },
                revision: 1,
              })),
            },
          };
        },
      },
    },
  });

  client.start();
  await client.settle();

  return { client, disk, requests, answered };
}

test("the default push budget is 48 KiB of the whole encoded request, including multibyte commands", async () => {
  const app = await run([
    queued(1, "é".repeat(13_000)),
    queued(2, "€".repeat(9000)),
    queued(3, "x"),
  ]);

  expect(app.requests.map((each) => each.ids)).toStrictEqual([[1], [2, 3]]);
  expect(app.requests.every((each) => each.bytes <= 49_152)).toBe(true);
  expect(app.answered.map((each) => each.id)).toStrictEqual([1, 2, 3]);
  expect(app.client.faults).toStrictEqual([]);
  expect(syncApi.PUSH_BYTES).toBe(49_152);
});

test("packing stops at the first non-fitting command, rather than skipping it for a smaller later command", async () => {
  // Literal wire sizes: envelope 58, each encoded command 30 + its text bytes, separators 1.
  // First+second is over 300, but first+third fits. Oldest-first must not choose first+third.
  const app = await run(
    [queued(1, "é".repeat(50)), queued(2, "€".repeat(40)), queued(3, "x")],
    300
  );

  expect(app.requests.map((each) => each.ids)).toStrictEqual([[1], [2, 3]]);
  expect(app.requests.every((each) => each.bytes <= 300)).toBe(true);
  expect(app.answered.map((each) => each.id)).toStrictEqual([1, 2, 3]);
});

test.each([false, true])(
  "a kept oversize oldest command does not strand later work (uncertain: %s)",
  async (uncertain) => {
    const old = queued(1, "é".repeat(200));

    if (uncertain) {
      old.state = { kind: "unknown", failure: "an earlier reply was lost" };
    }

    const app = await run([old, queued(2, "small")], 300);
    expect(app.requests.map((each) => each.ids)).toStrictEqual([[2]]);
    const first = app.client.model().commands[0];
    expect(first?.state).toMatchObject(
      uncertain
        ? { kind: "unknown", parked: true }
        : { kind: "done", revision: 0, outcome: { kind: "failed" } }
    );
    expect(app.client.model().commands[1]?.state).toStrictEqual({
      kind: "done",
      outcome: { kind: "ok", resource: "r2" },
      revision: 1,
    });
    expect((await app.disk.load()).commands[0]?.state).toStrictEqual(first?.state);
    expect(app.client.faults).toStrictEqual([]);
    app.client.dispatch({ type: "tick", now: POLL_MS * 3 });
    await app.client.settle();
    expect(app.requests.map((each) => each.ids)).toStrictEqual([[2]]);
  }
);

test("a new oversize tap is answered without being retained or sent", async () => {
  const app = await run([], 300);
  app.client.command({ text: "é".repeat(200) });
  await app.client.settle();
  expect(app.requests).toStrictEqual([]);
  expect(app.client.model().commands).toStrictEqual([]);
  expect((await app.disk.load()).commands).toStrictEqual([]);
  expect(app.answered).toHaveLength(1);
  expect(app.answered[0]?.state).toMatchObject({
    kind: "done",
    revision: 0,
    outcome: { kind: "failed" },
  });
});

test("pushBytes must be a positive safe integer", () => {
  for (const bytes of [0, -1, 1.5, Number.NaN]) {
    expect(() => engine(bytes)).toThrow(/pushBytes must be a positive integer/);
  }
});
