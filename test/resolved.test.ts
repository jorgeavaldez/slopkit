import { expect, test } from "vitest";

import type { Command, Outcome, PatchRows, Server, Tables } from "../src/conformance/fixtures.ts";
import { createSync, DONE_KEEP_MS } from "../src/sync.ts";

// An unresolved outcome never fades with time: it stays drawn and kept until it resolves or the person dismisses it
// (an install's result must not fade while the install is still running).
test("a done command the app calls unresolved never fades; a dismiss drops it from the page and the outbox", () => {
  const unresolved = new Set<number>([1]);

  const engine = createSync<Tables, PatchRows, Server, Command, Outcome>({
    tables: [],
    empty: { rows: new Map() },
    onlineOnly: () => false,
    refused: (_command, reason) => ({ kind: "failed", reason }),
    resolved: (pending) => !unresolved.has(pending.id),
  });

  const [model] = engine.update(engine.initial("client-a", 0), {
    type: "loaded",
    replica: { dataset: "d", revision: 5, tables: { rows: new Map() }, server: null },
    commands: [1, 2].map((id) => ({
      client: "client-old",
      id,
      dataset: "d",
      command: { name: "put" as const, value: id },
      at: 0,
      state: { kind: "done", outcome: { kind: "unknown", reason: "lost" }, revision: 1 },
    })),
    unreadable: 0,
    now: 0,
  });

  const [later, effects] = engine.update(model, { type: "tick", now: DONE_KEEP_MS * 10 });
  expect(later.commands.map((each) => each.id)).toStrictEqual([1]);
  expect(effects).toContainEqual({ kind: "drop", keys: [{ client: "client-old", id: 2 }] });

  const [dismissed, dropped] = engine.update(later, {
    type: "dismiss",
    client: "client-old",
    id: 1,
    now: DONE_KEEP_MS * 10 + 1,
  });

  expect(dismissed.commands).toStrictEqual([]);
  expect(dropped).toContainEqual({ kind: "drop", keys: [{ client: "client-old", id: 1 }] });
});
