/**
 * Checks an app's oracle runs on its state tables and screens (`slopkit/states`), for what the types can't rule out.
 * Each returns the problems found, empty when there are none, so a test asserts `toEqual([])` and reads every problem
 * at once. They check rules, never an app's expected texts: those stay the app's hand-written oracle.
 */
import type { Line, Screen, Subject } from "../states.ts";

/** At least one sample state of every kind, for the oracle and the gallery. */
export type Samples<S extends { kind: string }> = {
  readonly [K in S["kind"]]: readonly [Extract<S, { kind: K }>, ...Extract<S, { kind: K }>[]];
};

const BROKEN = /undefined|null|NaN|\[object |Invalid Date/;

/** Every sample drawn through its table, in table order. */
export function lines<S extends { kind: string }, A>(
  subject: Subject<S, A>,
  samples: Samples<S>
): Line<A>[] {
  return Object.values<readonly S[]>(samples).flatMap((each) =>
    each.map((state) => subject.line(state))
  );
}

/**
 * A table's problems over its samples: a kind with no sample, an empty why, a text that is empty or shows a broken
 * value, and two states that need different actions or mean different things yet read the same.
 */
export function tableProblems<S extends { kind: string }, A>(
  subject: Subject<S, A>,
  samples: Samples<S>
): string[] {
  const problems: string[] = [];

  for (const [kind, display] of Object.entries<{ why: string }>(subject.table)) {
    if (display.why.trim() === "") {
      problems.push(`${subject.name}.${kind}: no why`);
    }

    if (!Object.hasOwn(samples, kind)) {
      problems.push(`${subject.name}.${kind}: no sample`);
    }
  }

  const drawn = lines(subject, samples);

  for (const line of drawn) {
    if (line.text.trim() === "") {
      problems.push(`${subject.name}.${line.kind}: no text`);
    } else if (BROKEN.test(line.text)) {
      problems.push(`${subject.name}.${line.kind}: "${line.text}" shows a broken value`);
    }
  }

  for (const [at, a] of drawn.entries()) {
    for (const b of drawn.slice(at + 1)) {
      if (a.text === b.text && (a.meaning !== b.meaning || a.action !== b.action)) {
        problems.push(
          `${subject.name}: ${a.kind} and ${b.kind} both read "${a.text}" but mean ${a.meaning}/${String(a.action)} and ${b.meaning}/${String(b.action)}`
        );
      }
    }
  }

  return problems;
}

/**
 * A screen's problems against its parts, by the rules alone: ok only when every part is; the headline is a part that
 * isn't ok, none ahead of it by placement and the order; every claim kept, whole; nothing that isn't ok dropped.
 */
export function screenProblems<A>(
  screen: Screen<A>,
  parts: readonly Line<A>[],
  order: readonly string[]
): string[] {
  const problems: string[] = [];
  const bad = parts.filter((each) => each.meaning !== "ok");

  if (screen.ok !== (bad.length === 0)) {
    problems.push(`ok is ${screen.ok} with ${bad.length} parts not ok`);
  }

  if (bad.length === 0) {
    return problems;
  }

  if (screen.headline.meaning === "ok") {
    problems.push("the headline says ok while a part isn't");
  }

  const rank = (line: Line<A>) => (line.where === "main" ? 0 : 100) + order.indexOf(line.meaning);
  const best = Math.min(...bad.map(rank));
  const top = bad.find((each) => screen.headline.text.startsWith(each.text));

  if (top === undefined) {
    problems.push(`the headline "${screen.headline.text}" is no part's text`);
  } else if (rank(top) !== best) {
    problems.push(`the headline "${top.text}" is behind a more severe part`);
  }

  for (const claim of bad.filter((each) => each.claim)) {
    if (!screen.claims.includes(claim)) {
      problems.push(`the claim "${claim.text}" isn't kept whole`);
    }
  }

  const shown = new Set<Line<A>>([...screen.claims, ...screen.more]);

  if (top !== undefined) {
    shown.add(top);
  }

  for (const each of bad) {
    if (!shown.has(each)) {
      problems.push(`"${each.text}" (${each.meaning}) is dropped`);
    }
  }

  return problems;
}

/**
 * Up to `limit` combinations, one choice from each list: evenly spaced picks of the whole product in order, the first
 * list varying fastest (deterministic). Under a limit, not every value of every list need appear; put the dimension
 * that must vary most last, or pass a limit that covers it.
 */
export function bounded<T>(choices: readonly (readonly T[])[], limit: number): T[][] {
  const total = choices.reduce((product, each) => product * each.length, 1);

  if (total === 0) {
    return [];
  }

  const step = Math.max(1, Math.floor(total / limit));
  const out: T[][] = [];

  for (let index = 0; index < total && out.length < limit; index += step) {
    let rest = index;
    const pick: T[] = [];

    for (const each of choices) {
      const value = each[rest % each.length];

      if (value === undefined) {
        return out;
      }

      pick.push(value);
      rest = Math.floor(rest / each.length);
    }

    out.push(pick);
  }

  return out;
}
