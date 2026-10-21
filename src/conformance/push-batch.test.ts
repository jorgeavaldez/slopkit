/** A push carries at most `PUSH_MAX` commands, so a long outbox drains through a push endpoint bounded the same way. */

import { expect, test } from "vitest";

import { createClient } from "../client.ts";
import { createSync, PUSH_MAX } from "../sync.ts";
import { copy, database, patch, pending, sync } from "./fixtures.ts";

test("120 kept commands go out as pushes of 50, 50 and 20, each once, and all reach an outcome", async () => {
  const stored = database();
  await stored.port.load();
  await stored.port.commit({
    replica: copy(29, []),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  });

  for (let id = 1; id <= 120; id++) {
    await stored.port.keep({ ...pending("older-page", id, id), since: 29 });
  }

  const reopened = database({ factory: stored.factory, name: stored.name });
  const pushes: number[][] = [];

  const runtime = createClient({
    sync,
    client: "newer-page",
    ports: {
      storage: reopened.port,
      network: {
        pull: async () => ({ ok: true, value: { patch: patch(29, []), receipts: [] } }),
        push: async (request) => {
          pushes.push(request.commands.map((each) => each.id));

          // The server's contract: a push of more than 50 commands is refused before anything acts.
          if (request.commands.length > 50) {
            return { ok: false, failure: { kind: "invalid", message: "commands: at most 50" } };
          }

          return {
            ok: true,
            value: {
              receipts: request.commands.map((each) => ({
                id: each.id,
                outcome: { kind: "ok" as const, resource: `r${each.id}` },
                revision: 29,
              })),
              revision: 29,
            },
          };
        },
      },
      now: () => 0,
      fingerprint: async () => "fixture-fingerprint",
    },
  });

  runtime.start();
  await runtime.settle();

  expect(pushes.map((each) => each.length)).toStrictEqual([50, 50, 20]);
  expect(pushes.flat()).toStrictEqual(Array.from({ length: 120 }, (_, at) => at + 1));
  expect(
    runtime
      .model()
      .commands.filter((each) => each.state.kind === "done")
      .map((each) => each.id)
  ).toHaveLength(120);
  expect(runtime.faults).toStrictEqual([]);
  expect(PUSH_MAX).toBe(50);
});

test("a push bound that isn't a positive integer is refused when sync is made", () => {
  for (const pushMax of [0, -1, 1.5, Number.NaN]) {
    expect(() =>
      createSync({ tables: [], empty: {}, onlineOnly: () => false, refused: () => null, pushMax })
    ).toThrow(/pushMax must be a positive integer/);
  }
});
