/**
 * What a screen may say, decided for every state. An app declares, for each subject a person relies on (this device's
 * copy, the connection, each command, each outside source and account connection, each background job, the server), a
 * closed union of its states and one table deciding every state's display; for each outside source, its documented
 * failures by who acts and each call's effect kind. The kit turns those into the only values a view can draw, so a
 * state nobody placed doesn't compile and a screen can't claim more than is true. Pure: no clock, no DOM.
 *
 * Enforcers, each with its conformance test (`conformance/states.test.ts`):
 * - `Table<S>` is a total record over `S["kind"]`: a new state doesn't compile until it is placed. A state that isn't
 *   ok is drawn on the main screen or as a badge, never only in a panel or the log; a `partial` or `stale` state is
 *   always a claim (types). A `why` is never empty (`subject` throws); `test/states` `tableProblems` checks texts.
 * - `Line` and `Screen` can be made only here (private constructors): a view typed with them draws no text a table
 *   didn't decide, and no summary that dropped a part.
 * - `compose`: the headline is the first part that isn't ok, by placement (main before badge), then the app's severity
 *   order, then the order given; its ok text only when every part is ok. Every claim (a fact that changes what the
 *   numbers mean: incomplete, possibly wrong, not saved, stale) is kept whole beside the numbers, never folded into the
 *   headline's count.
 * - `source`: every documented failure code maps to who acts (a total record over the documented codes); an unknown
 *   code is `us`. Effect certainty is a separate fact: a lost or unreadable reply to a call that may have acted is
 *   `unknown`, so it is reconciled, never re-executed as if it were transient.
 * - `vocabulary`: one glyph per meaning, never shared; the order names every meaning once, `ok` last.
 */

/** What a state means for the person: one glyph each. */
export type Meaning =
  | "ok"
  | "working"
  | "partial"
  | "stale"
  | "off"
  | "none"
  | "retrying"
  | "you"
  | "ours"
  | "gone";

export const MEANINGS: readonly Meaning[] = [
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

export type Tone = "ok" | "muted" | "warning";

export type Look = { readonly glyph: string; readonly tone: Tone };

/** The design language's glyphs and tones; an app may change any, never to a glyph another meaning has. */
export const LOOKS = {
  ok: { glyph: "●", tone: "ok" },
  working: { glyph: "◐", tone: "muted" },
  partial: { glyph: "◑", tone: "muted" },
  stale: { glyph: "◷", tone: "muted" },
  off: { glyph: "○", tone: "muted" },
  none: { glyph: "·", tone: "muted" },
  retrying: { glyph: "↻", tone: "muted" },
  you: { glyph: "⚠", tone: "warning" },
  ours: { glyph: "✕", tone: "warning" },
  gone: { glyph: "⊘", tone: "muted" },
} as const satisfies { readonly [M in Meaning]: Look };

/**
 * Where a state's own line is drawn. `main`: it changes what the person should believe about the numbers, or needs
 * them to act. `badge`: it needs attention, not the numbers: a mark on the key that opens its panel. `panel`: detail and
 * history. `log`: nothing to act on or misread.
 */
export type Place = "main" | "badge" | "panel" | "log";

type Placed =
  | { readonly meaning: "ok"; readonly where: Place; readonly claim: false }
  | { readonly meaning: "partial" | "stale"; readonly where: "main"; readonly claim: true }
  | {
      readonly meaning: Exclude<Meaning, "ok" | "partial" | "stale">;
      readonly where: "main";
      readonly claim: boolean;
    }
  | {
      readonly meaning: Exclude<Meaning, "ok" | "partial" | "stale">;
      readonly where: "badge";
      readonly claim: false;
    };

/** One state's display: what it means, where and why it is drawn, its words, and what the person can do. */
export type Display<S, A> = Placed & {
  /** Why it is drawn there, or not at all. Required. */
  readonly why: string;
  readonly text: (state: S) => string;
  readonly action: A | null;
};

/** Every state of a union, placed: a total record over its kinds. */
export type Table<S extends { kind: string }, A> = {
  readonly [K in S["kind"]]: Display<Extract<S, { kind: K }>, A>;
};

// Set by the classes' static blocks: nothing outside this module can make a Line or a Screen.
let makeLine: <A>(fields: LineFields<A>) => Line<A>;
let makeScreen: <A>(fields: ScreenFields<A>) => Screen<A>;

type LineFields<A> = {
  [
    K in "subject" | "kind" | "meaning" | "where" | "claim" | "glyph" | "tone" | "text" | "action"
  ]: Line<A>[K];
};

type ScreenFields<A> = {
  [K in "ok" | "headline" | "top" | "more" | "lead" | "claims" | "badge" | "parts"]: Screen<A>[K];
};

/** A drawn state: only a subject makes one, from its table. */
export class Line<A> {
  // A private field makes the type nominal: no object literal or spread of a Line is one.
  // oxlint-disable-next-line no-unused-private-class-members -- its presence is its use
  readonly #made = true;
  readonly subject: string;
  readonly kind: string;
  readonly meaning: Meaning;
  readonly where: Place;
  readonly claim: boolean;
  readonly glyph: string;
  readonly tone: Tone;
  readonly text: string;
  readonly action: A | null;
  private constructor(fields: LineFields<A>) {
    this.subject = fields.subject;
    this.kind = fields.kind;
    this.meaning = fields.meaning;
    this.where = fields.where;
    this.claim = fields.claim;
    this.glyph = fields.glyph;
    this.tone = fields.tone;
    this.text = fields.text;
    this.action = fields.action;
  }
  static {
    makeLine = (fields) => new Line(fields);
  }
}

/** A screen's summary of all its parts: only `compose` makes one. */
export class Screen<A> {
  // oxlint-disable-next-line no-unused-private-class-members -- nominal, as Line's
  readonly #made = true;
  /** Every part is ok. */
  readonly ok: boolean;
  /** The status line: the first part that isn't ok (by placement, severity, order), or the ok text; `more` counts the rest. */
  readonly headline: {
    readonly meaning: Meaning;
    readonly glyph: string;
    readonly tone: Tone;
    readonly text: string;
    readonly action: A | null;
  };
  /** The part the headline is, or undefined when every part is ok. */
  readonly top: Line<A> | undefined;
  /** Other parts that aren't ok and aren't claims, counted after the headline (`+N`). */
  readonly more: readonly Line<A>[];
  /**
   * For a screen that draws the claims beside its numbers: the first part that isn't ok and isn't a claim, to lead a
   * status line without repeating a claim (undefined when there is none; the status line then says nothing more).
   */
  readonly lead: Line<A> | undefined;
  /** Every part that isn't ok and changes what the numbers mean, whole, for beside the numbers. */
  readonly claims: readonly Line<A>[];
  /** The first badge part that isn't ok, and how many there are, for the key that opens their panel. */
  readonly badge: { readonly line: Line<A>; readonly count: number } | undefined;
  readonly parts: readonly Line<A>[];
  private constructor(fields: ScreenFields<A>) {
    this.ok = fields.ok;
    this.headline = fields.headline;
    this.top = fields.top;
    this.more = fields.more;
    this.lead = fields.lead;
    this.claims = fields.claims;
    this.badge = fields.badge;
    this.parts = fields.parts;
  }
  static {
    makeScreen = (fields) => new Screen(fields);
  }
}

/** A subject's states, decided: `line(state)` is the only way to draw one. */
export type Subject<S extends { kind: string }, A> = {
  readonly name: string;
  readonly table: Table<S, A>;
  /** The state drawn, for this subject or, with `instance`, one of its instances (its own id, e.g. `bank:<id>`). */
  line: (state: S, instance?: string) => Line<A>;
};

/** Who acts on a failure. */
export type Who = "retrying" | "you" | "us" | "gone";

/** A call's effect kind: safe to replay, or not idempotent. */
export type EffectKind = "read" | "once";

/** How a call failed, as the boundary saw it. */
export type Failure =
  /** The provider answered with an error: it didn't act. */
  | { readonly kind: "answered"; readonly code: string }
  /** No answer: a network failure, a timeout, a dropped connection, a gateway error with no provider body. */
  | { readonly kind: "lost"; readonly reason: string }
  /** An answer that doesn't fit the contract. */
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * A failure's two facts: who acts, and whether the call may have acted (`unknown`: reconcile, never re-execute).
 * `retry`: safe to call again later, on its own.
 */
export type Fault = {
  readonly who: Who;
  readonly effect: "none" | "unknown";
  readonly retry: boolean;
  /** The documented code, the kit's `LOST`/`MALFORMED`, or an unknown code as given. */
  readonly code: string;
  /** Whether `code` is one of the provider's documented codes. */
  readonly documented: boolean;
};

/** An outside source: its states, its documented failures by who acts, and each call it makes by effect kind. */
export type Source<
  S extends { kind: string },
  A,
  Code extends string,
  Call extends string,
> = Subject<S, A> & {
  readonly codes: { readonly [C in Code]: Who };
  readonly calls: { readonly [K in Call]: EffectKind };
  fault: (call: Call, failure: Failure) => Fault;
};

/** An app's visual vocabulary and severity order, and the helpers built on them. */
export type States<A> = {
  readonly looks: { readonly [M in Meaning]: Look };
  /** Most severe first: every meaning once, `ok` last. */
  readonly order: readonly Meaning[];
  subject: <S extends { kind: string }>(name: string, table: Table<S, A>) => Subject<S, A>;
  source: <S extends { kind: string }, Code extends string, Call extends string>(def: {
    name: string;
    states: Table<S, A>;
    codes: { readonly [C in Code]: Who };
    calls: { readonly [K in Call]: EffectKind };
  }) => Source<S, A, Code, Call>;
  /** Every part of a screen, composed; `ok` is the headline only when every part is ok. */
  compose: (parts: readonly Line<A>[], ok: string) => Screen<A>;
};

const LOST = "LOST";
const MALFORMED = "MALFORMED";

/**
 * An app's states: its severity order (by consequence, most severe first; every meaning once, `ok` last) and any glyphs
 * it changes. Throws on a bad order or a glyph shared by two meanings.
 */
export function states<A>(options: {
  order: readonly Meaning[];
  looks?: Partial<{ readonly [M in Meaning]: Look }>;
}): States<A> {
  const order = Object.freeze([...options.order]);

  if (
    order.length !== MEANINGS.length ||
    new Set(order).size !== MEANINGS.length ||
    !MEANINGS.every((each) => order.includes(each))
  ) {
    throw new Error(`states: the order must name every meaning once (${MEANINGS.join(", ")})`);
  }

  if (order.at(-1) !== "ok") {
    throw new Error("states: ok comes last in the order");
  }

  // Snapshots: a caller changing what it passed changes nothing here.
  const chosen = { ...LOOKS, ...options.looks };
  const own = (meaning: Meaning): Look => Object.freeze({ ...chosen[meaning] });

  const looks: { readonly [M in Meaning]: Look } = Object.freeze({
    ok: own("ok"),
    working: own("working"),
    partial: own("partial"),
    stale: own("stale"),
    off: own("off"),
    none: own("none"),
    retrying: own("retrying"),
    you: own("you"),
    ours: own("ours"),
    gone: own("gone"),
  });

  const glyphs = new Map<string, Meaning>();

  for (const meaning of MEANINGS) {
    const { glyph } = looks[meaning];
    const other = glyphs.get(glyph);

    if (glyph.trim() === "" || other !== undefined) {
      throw new Error(`states: ${meaning} needs its own glyph (${glyph} is ${other ?? "blank"})`);
    }

    glyphs.set(glyph, meaning);
  }

  const rank = new Map(order.map((meaning, at) => [meaning, at]));
  const severity = (line: Line<A>) => rank.get(line.meaning) ?? 0;
  const placement = (line: Line<A>) => (line.where === "main" ? 0 : 1);

  function subject<S extends { kind: string }>(name: string, given: Table<S, A>): Subject<S, A> {
    // SAFETY: a frozen copy of the table given, entry for entry, so it has the given table's type.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    const table = Object.freeze(
      Object.fromEntries(
        Object.entries<Display<never, A>>(given satisfies Record<string, Display<never, A>>).map(
          ([kind, display]) => {
            if (display.why.trim() === "") {
              throw new Error(`states: ${name}.${kind} needs a why`);
            }

            return [kind, Object.freeze({ ...display })];
          }
        )
      )
    ) as Table<S, A>;

    return {
      name,
      table,
      line(state, instance) {
        const kind: S["kind"] = state.kind;
        // SAFETY: the state's kind picked the entry, so the state is the one that entry draws.
        // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        const display = table[kind] as Display<S, A>;
        const text = display.text(state);
        const look = looks[display.meaning];

        return makeLine<A>({
          subject: instance ?? name,
          kind: state.kind,
          meaning: display.meaning,
          where: display.where,
          claim: display.claim,
          glyph: look.glyph,
          tone: look.tone,
          text,
          action: display.action,
        });
      },
    };
  }

  function source<S extends { kind: string }, Code extends string, Call extends string>(def: {
    name: string;
    states: Table<S, A>;
    codes: { readonly [C in Code]: Who };
    calls: { readonly [K in Call]: EffectKind };
  }): Source<S, A, Code, Call> {
    // Snapshots: a caller changing what it passed can't turn a call that may act into one that is retried.
    const codes = new Map<string, Who>(Object.entries<Who>(def.codes));
    const calls = Object.freeze({ ...def.calls });

    return {
      ...subject(def.name, def.states),
      codes: Object.freeze({ ...def.codes }),
      calls,
      fault(call, failure) {
        const effect: EffectKind = calls[call];

        switch (failure.kind) {
          case "answered": {
            const who = codes.get(failure.code);

            return {
              who: who ?? "us",
              effect: "none",
              retry: who === "retrying",
              code: failure.code,
              documented: who !== undefined,
            };
          }

          case "lost": {
            // No answer: a read may simply go again; a call that may have acted is reconciled, never repeated.
            return effect === "read"
              ? { who: "retrying", effect: "none", retry: true, code: LOST, documented: false }
              : { who: "retrying", effect: "unknown", retry: false, code: LOST, documented: false };
          }

          case "malformed": {
            return {
              who: "us",
              effect: effect === "read" ? "none" : "unknown",
              retry: false,
              code: MALFORMED,
              documented: false,
            };
          }
        }
      },
    };
  }

  function compose(parts: readonly Line<A>[], ok: string): Screen<A> {
    const bad = parts
      .flatMap((line, at) => (line.meaning === "ok" ? [] : [{ line, at }]))
      .toSorted(
        (a, b) =>
          placement(a.line) - placement(b.line) ||
          severity(a.line) - severity(b.line) ||
          a.at - b.at
      )
      .map(({ line }) => line);

    const top = bad[0];
    // Claims in the order given: the app decides how its numbers' caveats read.
    const claims = parts.filter((line) => line.meaning !== "ok" && line.claim);
    const more = bad.filter((line) => line !== top && !line.claim);
    const badges = bad.filter((line) => line.where === "badge");
    const first = badges[0];
    const look = looks.ok;

    return makeScreen<A>({
      ok: top === undefined,
      headline:
        top === undefined
          ? { meaning: "ok", glyph: look.glyph, tone: look.tone, text: ok, action: null }
          : {
              meaning: top.meaning,
              glyph: top.glyph,
              tone: top.tone,
              text: top.text,
              action: top.action,
            },
      top,
      more,
      lead: bad.find((line) => !line.claim),
      claims,
      badge: first === undefined ? undefined : { line: first, count: badges.length },
      parts: Object.freeze([...parts]),
    });
  }

  return { looks, order, subject, source, compose };
}

/** The wait before retry number `failures` (1 for the first): doubling from `firstMs` to `maxMs`, never under `hintMs`. */
export function retryDelay(
  failures: number,
  policy: { readonly firstMs: number; readonly maxMs: number },
  hintMs?: number | null
): number {
  const doubled = policy.firstMs * 2 ** Math.max(0, Math.floor(failures) - 1);

  return Math.max(Math.min(doubled, policy.maxMs), hintMs ?? 0);
}
