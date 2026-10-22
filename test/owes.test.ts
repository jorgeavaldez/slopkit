import { expect, test } from "vitest";

import { MEANINGS, states } from "../src/states.ts";
import type { Display, Owed, Table } from "../src/states.ts";

type State = { kind: "waiting"; key: string } | { kind: "transit" } | { kind: "ready" };

const ui = states<never>({ order: MEANINGS });

const table: Table<State, never> = {
  waiting: {
    meaning: "working",
    where: "main",
    claim: false,
    why: "The server is checking this item",
    text: () => "checking…",
    action: null,
    owes: (state: Extract<State, { kind: "waiting" }>) => ({
      job: { kind: "check", key: state.key },
    }),
  },
  transit: {
    meaning: "working",
    where: "main",
    claim: false,
    why: "The carrier has the parcel; no app work is owed",
    text: () => "in transit",
    action: null,
    owes: null,
  },
  ready: {
    meaning: "ok",
    where: "log",
    claim: false,
    why: "Nothing remains",
    text: () => "ready",
    action: null,
  },
};

// Negative examples never execute. The type, not runtime validation, refuses these displays.
function typeContract() {
  type D = Display<{ kind: "x" }, never>;

  const base = {
    where: "main",
    claim: false,
    why: "Visible",
    text: () => "visible",
    action: null,
  } as const;

  // @ts-expect-error a working display needs owes, or explicitly null
  const absent: D = { ...base, meaning: "working" };
  // @ts-expect-error ok cannot owe work, including null
  const ok: D = { ...base, meaning: "ok", owes: null };
  // @ts-expect-error partial is not working
  const partial: D = { ...base, meaning: "partial", claim: true, owes: null };
  // @ts-expect-error stale cannot owe work
  const stale: D = { ...base, meaning: "stale", claim: true, owes: null };
  // @ts-expect-error off cannot owe work
  const off: D = { ...base, meaning: "off", owes: null };
  // @ts-expect-error none cannot owe work
  const none: D = { ...base, meaning: "none", owes: null };
  // @ts-expect-error retrying cannot owe work
  const retrying: D = { ...base, meaning: "retrying", owes: null };
  // @ts-expect-error you cannot owe work
  const you: D = { ...base, meaning: "you", owes: null };
  // @ts-expect-error ours cannot owe work
  const ours: D = { ...base, meaning: "ours", owes: null };
  // @ts-expect-error gone cannot owe work
  const gone: D = { ...base, meaning: "gone", owes: null };
  // @ts-expect-error owed jobs need their key
  const job: Owed = { job: { kind: "check" } };
  // @ts-expect-error command ids are numeric
  const command: Owed = { command: { client: "page", id: "1" } };
  // @ts-expect-error sync means true, never false
  const sync: Owed = { sync: false };

  void [absent, ok, partial, stale, off, none, retrying, you, ours, gone, job, command, sync];
}

void typeContract;

test("Line.owed is selected from the particular state and null for every other meaning", () => {
  const subject = ui.subject<State>("parcel", table);
  expect(subject.line({ kind: "waiting", key: "P1189" }).owed).toStrictEqual({
    job: { kind: "check", key: "P1189" },
  });
  expect(subject.line({ kind: "waiting", key: "P2" }).owed).toStrictEqual({
    job: { kind: "check", key: "P2" },
  });
  expect(subject.line({ kind: "transit" }).owed).toBeNull();
  expect(subject.line({ kind: "ready" }).owed).toBeNull();
});

test.each<Owed>([{ command: { client: "earlier-page", id: 7 } }, { sync: true }])(
  "Line carries owed %j unchanged",
  (owed) => {
    const subject = ui.subject<{ kind: "waiting" }>("copy", {
      waiting: {
        meaning: "working",
        where: "main",
        claim: false,
        why: "Keeping the copy",
        text: () => "working",
        action: null,
        owes: () => owed,
      },
    });

    expect(subject.line({ kind: "waiting" }).owed).toStrictEqual(owed);
  }
);

test("every non-working meaning has null owed", () => {
  for (const meaning of MEANINGS.filter((each) => each !== "working")) {
    const subject = ui.subject<{ kind: "x" }>("item", {
      x:
        meaning === "ok"
          ? {
              meaning,
              where: "main",
              claim: false,
              why: "State is visible",
              text: () => "visible",
              action: null,
            }
          : {
              meaning,
              where: "main",
              claim: true,
              why: "State is visible",
              text: () => "visible",
              action: null,
            },
    });

    expect(subject.line({ kind: "x" }).owed).toBeNull();
  }
});
