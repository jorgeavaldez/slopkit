import { describe, expect, test } from "vitest";

import { MEANINGS, states } from "../src/states.ts";
import type { Table } from "../src/states.ts";
import { bounded, lines, screenProblems, tableProblems } from "../src/test/states.ts";

type Link = { kind: "ok" } | { kind: "expired"; since: string } | { kind: "missing" };

type Action = "relink";

const kit = states<Action>({ order: MEANINGS });

const good: Table<Link, Action> = {
  ok: {
    meaning: "ok",
    where: "log",
    claim: false,
    why: "Nothing to do",
    text: () => "linked",
    action: null,
  },
  expired: {
    meaning: "you",
    where: "main",
    claim: true,
    why: "Data stops updating until relinked",
    text: (state) => `expired ${state.since}`,
    action: "relink",
  },
  missing: {
    meaning: "gone",
    where: "badge",
    claim: false,
    why: "Removed at the provider",
    text: () => "removed",
    action: null,
  },
};

const samples = {
  ok: [{ kind: "ok" }],
  expired: [{ kind: "expired", since: "2026-10-01" }],
  missing: [{ kind: "missing" }],
} as const;

describe("state table checks", () => {
  test("a sound table over samples of every kind has no problems", () => {
    const link = kit.subject("link", good);
    expect(tableProblems(link, samples)).toStrictEqual([]);
    expect(lines(link, samples).map((line) => line.text)).toStrictEqual([
      "linked",
      "expired 2026-10-01",
      "removed",
    ]);
  });

  test("a broken value, an empty text and two meanings reading alike are each reported", () => {
    const link = kit.subject<Link>("link", {
      ...good,
      ok: { ...good.ok, text: () => "removed" },
      // A text that reads past its value (the date has no time part): it renders "undefined".
      expired: { ...good.expired, text: (state) => `expired ${String(state.since.split("T")[1])}` },
    });

    expect(tableProblems(link, samples)).toStrictEqual([
      'link.expired: "expired undefined" shows a broken value',
      'link: ok and missing both read "removed" but mean ok/null and gone/null',
    ]);

    const blank = kit.subject<Link>("link", {
      ...good,
      missing: { ...good.missing, text: () => " " },
    });

    expect(tableProblems(blank, samples)).toStrictEqual(["link.missing: no text"]);
  });

  test("a screen that hides a part or claims ok over a problem is reported", () => {
    const link = kit.subject("link", good);

    const parts = [
      link.line({ kind: "ok" }),
      link.line({ kind: "missing" }),
      link.line({ kind: "expired", since: "2026-10-01" }),
    ];

    expect(screenProblems(kit.compose(parts, "all linked"), parts, MEANINGS)).toStrictEqual([]);
    const fewer = kit.compose(parts.slice(0, 2), "all linked");
    expect(screenProblems(fewer, parts, MEANINGS)).toStrictEqual([
      'the headline "removed" is behind a more severe part',
      'the claim "expired 2026-10-01" isn\'t kept whole',
      '"expired 2026-10-01" (you) is dropped',
    ]);
    const green = kit.compose(parts.slice(0, 1), "all linked");
    expect(screenProblems(green, parts, MEANINGS)).toStrictEqual([
      "ok is true with 2 parts not ok",
      "the headline says ok while a part isn't",
      'the headline "all linked" is no part\'s text',
      'the claim "expired 2026-10-01" isn\'t kept whole',
      '"removed" (gone) is dropped',
      '"expired 2026-10-01" (you) is dropped',
    ]);
  });

  test("bounded combinations take evenly spaced picks of the product and stop at the limit", () => {
    // The product in order, the first list varying fastest.
    expect(
      bounded<number | string>(
        [
          [1, 2],
          ["a", "b", "c"],
        ],
        10
      )
    ).toStrictEqual([
      [1, "a"],
      [2, "a"],
      [1, "b"],
      [2, "b"],
      [1, "c"],
      [2, "c"],
    ]);
    expect(
      bounded<number | string>(
        [
          [1, 2],
          ["a", "b", "c"],
        ],
        3
      )
    ).toStrictEqual([
      [1, "a"],
      [1, "b"],
      [1, "c"],
    ]);
    expect(bounded<number>([[1, 2], []], 5)).toStrictEqual([]);
  });
});
