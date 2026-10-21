import { expect, test } from "vitest";

import { createClient } from "../src/client.ts";
import { database, patch, pending, rowsLens } from "../src/conformance/fixtures.ts";
import type { Command, Outcome, PatchRows, Server, Tables } from "../src/conformance/fixtures.ts";
import { createSync, POLL_MS } from "../src/sync.ts";

// A pull names at most a push's worth of the commands it waits on. Over successive pulls it must name every one, or
// a parked command past the first `pushMax` (only a pull can settle it) waits forever.
test("successive pulls reach every waiting command, not only the oldest pushMax", async () => {
  const disk = database();
  await disk.port.load();

  for (const id of [1, 2, 3]) {
    await disk.port.keep({
      ...pending("page", id, id),
      since: 1,
      state: { kind: "unknown", failure: "refused by name", parked: true },
    });
  }

  const engine = createSync<Tables, PatchRows, Server, Command, Outcome>({
    tables: [rowsLens],
    empty: { rows: new Map() },
    onlineOnly: () => false,
    refused: (_command, reason) => ({ kind: "failed", reason }),
    pushMax: 1,
  });

  const named: number[][] = [];
  let now = 0;

  const app = createClient({
    sync: engine,
    client: "new",
    ports: {
      storage: disk.port,
      now: () => now,
      fingerprint: async () => "fixture-fingerprint",
      network: {
        pull: async (input) => {
          named.push((input.commands ?? []).map((each) => each.id));

          // Only the third acted: its receipt comes when a pull names it.
          return {
            ok: true,
            value: {
              patch: patch(2, [], true),
              receipts: (input.commands ?? [])
                .filter((each) => each.id === 3)
                .map((each) => ({
                  client: each.client,
                  id: each.id,
                  outcome: { kind: "ok" as const, resource: "r3" },
                  revision: 2,
                })),
            },
          };
        },
        push: async () => {
          throw new Error("a parked command is never sent");
        },
      },
    },
  });

  app.start();
  await app.settle();

  for (let at = 1; at <= 6; at++) {
    now = at * POLL_MS;
    app.dispatch({ type: "tick", now });
    await app.settle();
  }

  expect(named.every((each) => each.length <= 1)).toBe(true);
  expect(new Set(named.flat())).toStrictEqual(new Set([1, 2, 3]));
  expect(app.model().commands.find((each) => each.id === 3)?.state).toStrictEqual({
    kind: "done",
    outcome: { kind: "ok", resource: "r3" },
    revision: 2,
  });
  expect(app.faults).toStrictEqual([]);
});
