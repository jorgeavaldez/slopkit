/** States: expectations from the contract in states.ts. */
import { describe, expect, test } from "vitest";

import { Line, Screen, states, retryDelay } from "../states.ts";
import type { Meaning, Table, Display } from "../states.ts";

const order: Meaning[] = [
  "you",
  "ours",
  "gone",
  "off",
  "stale",
  "partial",
  "retrying",
  "working",
  "none",
  "ok",
];

type State =
  | { kind: "good" }
  | { kind: "partial"; n: number }
  | { kind: "repair" }
  | { kind: "waiting" };

type Action = "repair";

const table: Table<State, Action> = {
  good: {
    meaning: "ok",
    where: "log",
    claim: false,
    why: "No obligation remains",
    text: () => "complete",
    action: null,
  },
  partial: {
    meaning: "partial",
    where: "main",
    claim: true,
    why: "Totals cover only these rows",
    text: (s) => `${s.n} days only`,
    action: null,
  },
  repair: {
    meaning: "you",
    where: "main",
    claim: false,
    why: "Needs the person",
    text: () => "sign in again",
    action: "repair",
  },
  waiting: {
    meaning: "working",
    where: "badge",
    claim: false,
    why: "Tap waits, numbers unchanged",
    text: () => "keeping the tap",
    action: null,
    owes: null,
  },
};

const kit = () => states<Action>({ order });

// The only justified @ts comments: negative API conformance is itself the requirement.
// Kept in an uncalled function so rejected examples never execute.
function typeContract(line: Line<Action>, screen: Screen<Action>) {
  // @ts-expect-error every state needs a display
  const missing: Table<State, Action> = {
    good: table.good,
    partial: table.partial,
    repair: table.repair,
  };

  // @ts-expect-error non-ok can't be hidden in the log
  const hidden: Display<{ kind: "x" }, Action> = {
    meaning: "you",
    where: "log",
    claim: false,
    why: "x",
    text: () => "x",
    action: "repair",
  };

  // @ts-expect-error partial must be a main claim
  const partial: Display<{ kind: "x" }, Action> = {
    meaning: "partial",
    where: "badge",
    claim: false,
    why: "x",
    text: () => "x",
    action: null,
  };

  // @ts-expect-error stale must be a claim
  const stale: Display<{ kind: "x" }, Action> = {
    meaning: "stale",
    where: "main",
    claim: false,
    why: "x",
    text: () => "x",
    action: null,
  };

  // @ts-expect-error rationale is required
  const reason: Display<{ kind: "x" }, Action> = {
    meaning: "ok",
    where: "log",
    claim: false,
    text: () => "x",
    action: null,
  };

  // @ts-expect-error constructor belongs to the kit
  void new Line(line);
  // @ts-expect-error constructor belongs to the kit
  void new Screen(screen);

  // @ts-expect-error structural literals cannot forge a trusted line
  const forgedLine: Line<Action> = {
    subject: "bank",
    kind: "ok",
    meaning: "ok",
    where: "main",
    claim: false,
    glyph: "●",
    tone: "ok",
    text: "synced",
    action: null,
  };

  // @ts-expect-error spreading a line cannot forge another trusted line
  const changedLine: Line<Action> = { ...line, text: "all done", claim: false }; // oxlint-disable-line typescript/no-misused-spread -- Deliberately rejected forgery, not application code.

  // @ts-expect-error structural literals cannot bypass compose
  const forgedScreen: Screen<Action> = {
    ok: true,
    headline: screen.headline,
    parts: [],
    claims: [],
    more: [],
    badge: undefined,
  };

  // @ts-expect-error spreading a screen cannot drop its claims
  const changedScreen: Screen<Action> = { ...screen, ok: true, claims: [] }; // oxlint-disable-line typescript/no-misused-spread -- Deliberately rejected forgery, not application code.
  const subject = kit().subject<State>("bank", table);
  // @ts-expect-error a subject's states are closed
  subject.line({ kind: "new-state" });

  const source = kit().source<State, "LOGIN" | "DOWN", "fetch" | "exchange">({
    name: "provider",
    states: table,
    codes: { LOGIN: "you", DOWN: "retrying" },
    calls: { fetch: "read", exchange: "once" },
  });

  // @ts-expect-error a source's calls are closed
  source.fault("invented", { kind: "lost", reason: "timeout" });
  kit().source<State, "LOGIN" | "DOWN", "fetch">({
    name: "provider",
    states: table,
    // @ts-expect-error documented codes must all be mapped
    codes: { LOGIN: "you" },
    calls: { fetch: "read" },
  });
  void [
    missing,
    hidden,
    partial,
    stale,
    reason,
    forgedLine,
    changedLine,
    forgedScreen,
    changedScreen,
    source,
  ];
}

void typeContract;

describe("states: independent conformance", () => {
  test("table lines keep the whole decided meaning, placement, words and action", () => {
    const subject = kit().subject<State>("bank", table);
    expect(subject.line({ kind: "partial", n: 30 }, "bank:one")).toMatchObject({
      subject: "bank:one",
      kind: "partial",
      meaning: "partial",
      where: "main",
      claim: true,
      glyph: "◑",
      tone: "muted",
      text: "30 days only",
      action: null,
    });
    expect(subject.line({ kind: "repair" })).toMatchObject({
      subject: "bank",
      kind: "repair",
      meaning: "you",
      glyph: "⚠",
      text: "sign in again",
      action: "repair",
    });
  });

  test.each(["", " ", "\n\t"])(
    "subject rejects an empty rationale %j at definition time",
    (why) => {
      expect(() =>
        kit().subject<State>("bank", { ...table, good: { ...table.good, why } })
      ).toThrow("states: bank.good needs a why");
    }
  );

  test("vocabulary has one literal glyph per meaning", () => {
    const app = kit();
    expect(order.map((m) => app.looks[m].glyph)).toStrictEqual([
      "⚠",
      "✕",
      "⊘",
      "○",
      "◷",
      "◑",
      "↻",
      "◐",
      "·",
      "●",
    ]);
    expect(() => states({ order, looks: { you: { glyph: "●", tone: "warning" } } })).toThrow(
      /needs its own glyph/
    );
    expect(states({ order, looks: { you: { glyph: "!", tone: "warning" } } }).looks.you.glyph).toBe(
      "!"
    );
  });

  test("order validation rejects omission, duplication, and ok before the end", () => {
    expect(() => states({ order: order.slice(1) })).toThrow(
      "the order must name every meaning once"
    );
    expect(() => states({ order: [...order, "you"] })).toThrow(
      "the order must name every meaning once"
    );
    expect(() => states({ order: ["ok", ...order.filter((m) => m !== "ok")] })).toThrow(
      "ok comes last in the order"
    );
    expect(kit().order).toStrictEqual(order);
  });

  test("compose keeps claims whole even when an action is headline; badges never outrank main", () => {
    const app = kit();
    const subject = app.subject<State>("bank", table);
    const partial = subject.line({ kind: "partial", n: 30 });
    const repair = subject.line({ kind: "repair" });
    const wait = subject.line({ kind: "waiting" });
    const screen = app.compose([wait, partial, repair], "synced");
    expect(screen.ok).toBe(false);
    expect(screen.headline).toMatchObject({
      meaning: "you",
      text: "sign in again",
      action: "repair",
    });
    expect(screen.claims).toStrictEqual([partial]);
    expect(screen.more).toStrictEqual([wait]);
    expect(screen.badge).toStrictEqual({ line: wait, count: 1 });
    expect(screen.parts).toStrictEqual([wait, partial, repair]);

    const badgeYou = app
      .subject<{ kind: "tap" }>("tap", {
        tap: {
          meaning: "you",
          where: "badge",
          claim: false,
          why: "Not about the ledger",
          text: () => "tap failed",
          action: "repair",
        },
      })
      .line({ kind: "tap" });

    expect(app.compose([badgeYou, partial], "synced").headline.text).toBe("30 days only");
  });

  test("compose uses app severity then stable supplied order; claims are not counted as hidden more", () => {
    const app = kit();
    const subject = app.subject<State>("bank", table);
    const p1 = subject.line({ kind: "partial", n: 30 }, "a");
    const p2 = subject.line({ kind: "partial", n: 7 }, "b");
    expect(app.compose([p2, p1], "synced").headline.text).toBe("7 days only");
    expect(app.compose([p2, p1], "synced").claims).toStrictEqual([p2, p1]);
    expect(app.compose([p2, p1], "synced").more).toStrictEqual([]);
    const app2 = states<Action>({ order: ["partial", ...order.filter((m) => m !== "partial")] });
    const s2 = app2.subject<State>("bank", table);
    expect(
      app2.compose([s2.line({ kind: "repair" }), s2.line({ kind: "partial", n: 30 })], "synced")
        .headline.meaning
    ).toBe("partial");
  });

  test("ok is permitted exactly when all supplied parts are ok (including the empty product)", () => {
    const app = kit();
    const subject = app.subject<State>("bank", table);
    const good = subject.line({ kind: "good" });

    for (const parts of [[], [good], [good, good]]) {
      expect(app.compose(parts, "synced")).toMatchObject({
        ok: true,
        headline: { meaning: "ok", glyph: "●", text: "synced", action: null },
        claims: [],
        more: [],
        badge: undefined,
      });
    }

    for (const kind of ["repair", "waiting"] as const) {
      const bad = subject.line({ kind });

      for (const parts of [[bad], [good, bad], [bad, good]]) {
        expect(app.compose(parts, "synced").ok).toBe(false);
      }
    }
  });

  test("bounded pair composition cannot drop one meaning or a claim", () => {
    const app = kit();

    const subjects = order.map((meaning) =>
      app
        .subject<{ kind: "x" }>(meaning, {
          x:
            meaning === "ok"
              ? {
                  meaning,
                  where: "log",
                  claim: false,
                  why: "Resolved",
                  text: () => meaning,
                  action: null,
                }
              : meaning === "partial" || meaning === "stale"
                ? {
                    meaning,
                    where: "main",
                    claim: true,
                    why: "Changes the numbers",
                    text: () => meaning,
                    action: null,
                  }
                : meaning === "working"
                  ? {
                      meaning,
                      where: "main",
                      claim: false,
                      why: "An obligation",
                      text: () => meaning,
                      action: null,
                      owes: null,
                    }
                  : {
                      meaning,
                      where: "main",
                      claim: false,
                      why: "An obligation",
                      text: () => meaning,
                      action: null,
                    },
        })
        .line({ kind: "x" })
    );

    for (let i = 0; i < subjects.length; i++) {
      for (let j = 0; j < subjects.length; j++) {
        const a = subjects[i];
        const b = subjects[j];

        if (!a || !b) {
          throw new Error("missing fixture");
        }

        const result = app.compose([a, b], "synced");
        expect(result.ok).toBe(i === 9 && j === 9);
        expect(result.headline.meaning).toBe(order[Math.min(i, j)]);
        expect(result.claims).toStrictEqual(
          [a, b].filter((x) => x.meaning === "partial" || x.meaning === "stale")
        );
        expect(result.parts).toStrictEqual([a, b]);
      }
    }
  });

  test("retained definition objects cannot mutate a validated line or erase claims", () => {
    const mutableOrder = [...order];
    const looks = { you: { glyph: "!", tone: "warning" as const } };
    const partial = { ...table.partial };
    const definitions = { ...table, partial };
    const app = states<Action>({ order: mutableOrder, looks });
    const subject = app.subject<State>("bank", definitions);
    const old = subject.line({ kind: "partial", n: 30 });
    const parts = [old];
    const screen = app.compose(parts, "synced");

    // Either reject the caller mutation or own a snapshot. Both preserve the contract.
    try {
      mutableOrder.reverse();
    } catch {
      /* frozen input */
    }

    try {
      looks.you.glyph = "●";
    } catch {
      /* frozen input */
    }

    try {
      partial.text = () => "complete";
    } catch {
      /* frozen input */
    }

    parts.length = 0;
    expect(app.order).toStrictEqual(order);
    expect(app.looks.you.glyph).toBe("!");
    expect(subject.line({ kind: "partial", n: 30 }).text).toBe("30 days only");
    expect(screen.parts).toStrictEqual([old]);
    expect(screen.claims).toStrictEqual([old]);
    expect(screen.ok).toBe(false);
  });

  test("source fault maps actor independently of effect certainty and retry safety", () => {
    const source = kit().source<State, "DOWN" | "LOGIN" | "BUG" | "REMOVED", "fetch" | "exchange">({
      name: "provider",
      states: table,
      codes: { DOWN: "retrying", LOGIN: "you", BUG: "us", REMOVED: "gone" },
      calls: { fetch: "read", exchange: "once" },
    });

    for (const call of ["fetch", "exchange"] as const) {
      for (const [code, who, retry] of [
        ["DOWN", "retrying", true],
        ["LOGIN", "you", false],
        ["BUG", "us", false],
        ["REMOVED", "gone", false],
      ] as const) {
        expect(source.fault(call, { kind: "answered", code })).toStrictEqual({
          who,
          effect: "none",
          retry,
          code,
          documented: true,
        });
      }
    }

    for (const code of ["NEW_CODE", "toString", "__proto__"]) {
      expect(source.fault("fetch", { kind: "answered", code })).toStrictEqual({
        who: "us",
        effect: "none",
        retry: false,
        code,
        documented: false,
      });
    }

    expect(source.fault("fetch", { kind: "lost", reason: "timeout" })).toStrictEqual({
      who: "retrying",
      effect: "none",
      retry: true,
      code: "LOST",
      documented: false,
    });
    expect(source.fault("exchange", { kind: "lost", reason: "timeout" })).toStrictEqual({
      who: "retrying",
      effect: "unknown",
      retry: false,
      code: "LOST",
      documented: false,
    });
    expect(source.fault("fetch", { kind: "malformed", reason: "HTML" })).toStrictEqual({
      who: "us",
      effect: "none",
      retry: false,
      code: "MALFORMED",
      documented: false,
    });
    expect(source.fault("exchange", { kind: "malformed", reason: "HTML" })).toStrictEqual({
      who: "us",
      effect: "unknown",
      retry: false,
      code: "MALFORMED",
      documented: false,
    });
  });

  test("retry delay doubles, caps, and never violates a provider hint", () => {
    expect([1, 2, 3, 10].map((n) => retryDelay(n, { firstMs: 1000, maxMs: 5000 }))).toStrictEqual([
      1000, 2000, 4000, 5000,
    ]);
    expect(retryDelay(1, { firstMs: 1000, maxMs: 5000 }, 60_000)).toBe(60_000);
    expect(retryDelay(3, { firstMs: 1000, maxMs: 5000 }, 10)).toBe(4000);
    expect(retryDelay(1, { firstMs: 1000, maxMs: 5000 }, null)).toBe(1000);
  });
});
