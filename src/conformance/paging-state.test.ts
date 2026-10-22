import { expect, test } from "vitest";

import { MEANINGS, states } from "../states.ts";
import type { Table } from "../states.ts";
import * as syncExports from "../sync.ts";
import { STORAGE_DEADLINE_MS } from "../sync.ts";
import { copy } from "./fixtures.ts";
import { all, complete, loaded, newest, partialCopy } from "./paging-fixtures.ts";
import type { M } from "./paging-fixtures.ts";

// Before these public APIs exist the runtime cases reject their absence. Once exported, the actual return unions
// govern these tables and compile-time rejections, not the fallback vocabulary.
type ExpectedHistoryState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "complete" }
  | { kind: "partial"; through: string | null; held: number; total: number };

type ExpectedDurabilityState =
  | { kind: "loading" }
  | { kind: "unsaved" }
  | { kind: "lost"; reason: string }
  | { kind: "failing"; reason: string }
  | { kind: "replaced" }
  | { kind: "unreadable"; count: number }
  | { kind: "ok" };

type HistoryState = typeof syncExports extends {
  deriveHistoryState: (model: M) => infer S extends { kind: string };
}
  ? S
  : ExpectedHistoryState;

type DurabilityState = typeof syncExports extends {
  deriveDurabilityState: (model: M) => infer S extends { kind: string };
}
  ? S
  : ExpectedDurabilityState;

const working = {
  meaning: "working",
  where: "main",
  claim: false,
  why: "the copy is loading",
  text: () => "loading copy",
  action: null,
  owes: () => ({ sync: true as const }),
} as const;

const warning = {
  meaning: "ours",
  where: "main",
  claim: true,
  why: "the durable copy needs attention",
  text: () => "copy needs attention",
  action: null,
} as const;

const historyTable: Table<HistoryState, never> = {
  loading: working,
  none: {
    meaning: "none",
    where: "main",
    claim: false,
    why: "no server copy is held",
    text: () => "no copy yet",
    action: null,
  },
  complete: {
    meaning: "ok",
    where: "panel",
    claim: false,
    why: "every server row is held",
    text: () => "complete history",
    action: null,
  },
  partial: {
    meaning: "partial",
    where: "main",
    claim: true,
    why: "the numbers cover only a fully loaded range",
    text: (state) =>
      state.through === null
        ? `loading history · ${state.held} of ${state.total}`
        : `history from ${state.through}, loading older · ${state.held} of ${state.total}`,
    action: null,
  },
};

const durabilityTable: Table<DurabilityState, never> = {
  loading: working,
  unsaved: { ...warning, text: () => "not saved yet" },
  lost: { ...warning, text: (state) => `not saved: ${state.reason}` },
  failing: { ...warning, text: (state) => `storage failing: ${state.reason}` },
  replaced: { ...warning, text: () => "reload this copy" },
  unreadable: { ...warning, text: (state) => `${state.count} unreadable commands kept` },
  ok: {
    meaning: "ok",
    where: "panel",
    claim: false,
    why: "the observed copy is kept",
    text: () => "saved",
    action: null,
  },
};

function typeContract(): void {
  const { partial, ...withoutPartial } = historyTable;
  // @ts-expect-error the public history union requires partial to be placed
  const incomplete: Table<HistoryState, never> = withoutPartial;
  const { lost, ...withoutLost } = durabilityTable;
  // @ts-expect-error the independent durability union requires lost to be placed
  const missingStorage: Table<DurabilityState, never> = withoutLost;
  void partial;
  void lost;
  void incomplete;
  void missingStorage;
}

void typeContract;

function api() {
  const exported: {
    createSync: typeof syncExports.createSync;
    deriveHistoryState?: (model: M) => HistoryState;
    deriveDurabilityState?: (model: M) => DurabilityState;
  } = syncExports;

  return exported;
}

function deriveHistory(model: M): HistoryState {
  const derive = api().deriveHistoryState;
  expect(derive, "sync exports deriveHistoryState(model)").toBeTypeOf("function");

  if (derive === undefined) {
    throw new Error("missing deriveHistoryState");
  }

  return derive(model);
}

function deriveDurability(model: M): DurabilityState {
  const derive = api().deriveDurabilityState;
  expect(derive, "sync exports deriveDurabilityState(model)").toBeTypeOf("function");

  if (derive === undefined) {
    throw new Error("missing deriveDurabilityState");
  }

  return derive(model);
}

test("6, 10: history is its own closed subject, including no fully covered order group yet", () => {
  const model = loaded(partialCopy());
  const state = deriveHistory(model);
  expect(state).toStrictEqual({ kind: "partial", through: "50", held: 2, total: 6 });
  const display = states<never>({ order: MEANINGS });
  const subject = display.subject<HistoryState>("history", historyTable);
  const line = subject.line(state);
  expect(line).toMatchObject({
    where: "main",
    claim: true,
    glyph: "◑",
    text: "history from 50, loading older · 2 of 6",
  });

  const unbounded = deriveHistory(
    loaded(partialCopy(10, newest, { from: null, next: "tie", through: null, held: 2, total: 6 }))
  );

  expect(subject.line(unbounded).text).toBe("loading history · 2 of 6");
  const whole = { ...copy(10, all), history: complete };
  expect(deriveHistory(loaded(whole))).toStrictEqual({ kind: "complete" });
  expect(deriveHistory({ ...model, boot: { kind: "loading", since: 0 } })).toStrictEqual({
    kind: "loading",
  });
  expect(deriveHistory({ ...model, replica: { ...whole, dataset: null } })).toStrictEqual({
    kind: "none",
  });
});

const trouble = (base: M): { model: M; state: ExpectedDurabilityState }[] => [
  { model: { ...base, storage: { kind: "replaced" } }, state: { kind: "replaced" } },
  {
    model: { ...base, storage: { kind: "failed", reason: "quota" } },
    state: { kind: "failing", reason: "quota" },
  },
  {
    model: {
      ...base,
      storage: { kind: "failed", reason: "quota" },
      saved: { ...base.saved, behindSince: 0 },
    },
    state: { kind: "lost", reason: "quota" },
  },
  {
    model: { ...base, now: STORAGE_DEADLINE_MS, saved: { ...base.saved, behindSince: 0 } },
    state: { kind: "unsaved" },
  },
  { model: { ...base, unreadable: 2 }, state: { kind: "unreadable", count: 2 } },
];

test("durability retains the storage catalog independently of completeness", () => {
  const whole = { ...copy(10, all), history: complete };
  const base = loaded(whole);

  for (const item of trouble(base)) {
    expect(deriveDurability(item.model)).toStrictEqual(item.state);
  }

  expect(deriveDurability({ ...base, boot: { kind: "loading", since: 0 } })).toStrictEqual({
    kind: "loading",
  });
  expect(deriveDurability(base)).toStrictEqual({ kind: "ok" });
});

test("partial history and every storage problem survive composition as independent claims", () => {
  const display = states<never>({ order: MEANINGS });
  const historySubject = display.subject<HistoryState>("history", historyTable);
  const durabilitySubject = display.subject<DurabilityState>("durability", durabilityTable);
  const base = loaded(partialCopy());

  for (const item of trouble(base)) {
    const historyState = deriveHistory(item.model);
    const durability = deriveDurability(item.model);
    expect(historyState).toStrictEqual({ kind: "partial", through: "50", held: 2, total: 6 });
    expect(durability).toStrictEqual(item.state);
    const historyLine = historySubject.line(historyState);
    const storageLine = durabilitySubject.line(durability);

    for (const parts of [
      [historyLine, storageLine],
      [storageLine, historyLine],
    ]) {
      const screen = display.compose(parts, "synced");
      expect(screen.ok).toBe(false);
      expect(screen.claims).toContain(historyLine);
      expect(screen.claims).toContain(storageLine);
      expect(screen.more).not.toContain(historyLine);
      expect(screen.more).not.toContain(storageLine);
    }
  }
});
