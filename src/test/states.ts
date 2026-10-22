import type { Update } from "../machine.ts";
/**
 * Checks an app's tests run on its state tables, screens and every view they reach (`slopkit/states`), for what the
 * types can't rule out. Each returns the problems found, empty when there are none, so a test asserts `toEqual([])`
 * and reads every problem at once. They check rules, never an app's expected texts: those stay the app's own tests.
 */
import { isLine, isScreen } from "../states.ts";
import type { Line, Meaning, Owed, Screen, Subject } from "../states.ts";
import { pullUnderWay, SOCKET_DEADLINE_MS, underWay } from "../sync.ts";
import type { Model } from "../sync.ts";

/** At least one sample state of every kind, for the tests and the gallery. */
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

/** What is under way when a view is drawn: the server's jobs, the page's sync model, and the clock. */
export type World = {
  now: number;
  /** The server's jobs (`slopkit/server/jobs`); finished ones may be listed too. */
  jobs?: readonly {
    kind: string;
    key: string;
    state: "due" | "running" | "done" | "failed";
    dueAt: string;
    /** When it last changed (`Job.updatedAt`): a finished job's end. */
    updatedAt?: string;
    /**
     * A finished job's end as the page's copy holds it: the revision of the row that shows it. Until the copy is
     * there, a working line may still show the job (the poke is on its way, or a pull is bringing it).
     */
    revision?: number;
  }[];
  /** The page's sync model: its commands and its copy. */
  // oxlint-disable-next-line typescript/no-explicit-any -- any app's model: only the kit's own fields are read
  model?: Model<any, any, any, any>;
};

type Found = { lines: Line<unknown>[]; screens: Screen<unknown>[] };

/** Every Line and Screen inside a value: objects, arrays, Maps and Sets, each visited once. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- an app's view is any shape; only the kit's classes are read
function found(value: unknown): Found {
  const drawn: Line<unknown>[] = [];
  const screens: Screen<unknown>[] = [];
  const seen = new Set<object>();

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- walks any shape, keeping only the kit's classes
  const visit = (each: unknown): void => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- only objects can hold a Line or a Screen
    if (typeof each !== "object" || each === null || seen.has(each)) {
      return;
    }

    seen.add(each);

    if (isLine(each)) {
      drawn.push(each);

      return;
    }

    if (isScreen(each)) {
      screens.push(each);
    }

    const inner: Iterable<unknown> =
      each instanceof Map
        ? [...each.keys(), ...each.values()]
        : each instanceof Set || Array.isArray(each)
          ? each
          : Object.values(each);

    for (const item of inner) {
      visit(item);
    }
  };

  visit(value);

  return { lines: drawn, screens };
}

function owedName(owed: Owed): string {
  if ("job" in owed) {
    return `job ${owed.job.kind}:${owed.job.key}`;
  }

  return "command" in owed ? `command ${owed.command.client}:${owed.command.id}` : "sync";
}

/**
 * A finished job the page's copy doesn't hold yet (below its `revision`), while the page can't have heard of it: the
 * poke may still be coming (it hasn't heard that revision, and the job ended within the socket's deadline), or a pull
 * is under way to bring it. Without a revision, a finished job is never under way.
 */
function unheard(job: { updatedAt?: string; revision?: number }, world: World): boolean {
  const { model } = world;
  const end = job.updatedAt === undefined ? Number.NaN : Date.parse(job.updatedAt);
  const recent = world.now - end < SOCKET_DEADLINE_MS;

  if (job.revision === undefined) {
    return false;
  }

  if (model === undefined) {
    return recent;
  }

  return (
    model.replica.revision < job.revision &&
    ((recent && model.target < job.revision) || pullUnderWay(model, world.now))
  );
}

/**
 * A job running or due by now, or just finished and not yet heard of (`unheard`); the page's sync work as the engine
 * runs it (`slopkit/sync`'s `underWay`).
 */
function owedUnderWay(owed: Owed, world: World): boolean {
  if ("job" in owed) {
    return (world.jobs ?? []).some(
      (job) =>
        job.kind === owed.job.kind &&
        job.key === owed.job.key &&
        (job.state === "running" ||
          (job.state === "due" && Date.parse(job.dueAt) <= world.now) ||
          ((job.state === "done" || job.state === "failed") && unheard(job, world)))
    );
  }

  return world.model !== undefined && underWay(world.model, owed, world.now);
}

/**
 * A reached view's problems by the kit's rules: every line has text with no broken value; every screen keeps its parts
 * (`screenProblems`); and, given what is under way (`world`), every working line's owed work is: a job running or due
 * by now, or just finished and not yet in the page's copy (`World.jobs`' `revision`), or the page's sync work as
 * the engine runs it (`slopkit/sync`'s `underWay`, the rule an app places its working lines by). Takes any value an
 * app's view returns and finds the kit's lines and screens in it. Run it on every view a test reaches, not only on
 * samples.
 */
export function viewProblems(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an app's view is any shape; only the kit's classes are read
  shown: unknown,
  options: { order: readonly Meaning[]; world?: World }
): string[] {
  const problems: string[] = [];
  const { lines: drawn, screens } = found(shown);

  for (const line of drawn) {
    if (line.text.trim() === "") {
      problems.push(`${line.subject}.${line.kind}: no text`);
    } else if (BROKEN.test(line.text)) {
      problems.push(`${line.subject}.${line.kind}: "${line.text}" shows a broken value`);
    }

    const world = options.world;

    if (world !== undefined && line.owed !== null && !owedUnderWay(line.owed, world)) {
      problems.push(
        `${line.subject}.${line.kind} says "${line.text}" (working) but owes ${owedName(line.owed)}, which isn't under way`
      );
    }
  }

  for (const screen of screens) {
    problems.push(...screenProblems(screen, screen.parts, options.order));
  }

  return problems;
}

/** Where a replay ends (`replayProblems`): the last model, every effect, and each reached view's problems. */
export type ReplayChecked<M, E> = { model: M; effects: E[]; problems: string[] };

/**
 * Replay `messages` through `update` from `initial` and run `viewProblems` on the view of every model reached: the
 * initial one (step 0) and the one after each message (step n). `world` is drawn from each reached model (its sync
 * model, its clock, the jobs the test supplies), never a snapshot. Returns the last model, every effect, and the
 * problems, each naming its step.
 */
export function replayProblems<M, Msg, E>(
  update: Update<M, Msg, E>,
  initial: M,
  messages: readonly Msg[],
  options: {
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- an app's view is any shape; only the kit's classes are read
    view: (model: M) => unknown;
    order: readonly Meaning[];
    world?: (model: M, step: number) => World;
  }
): ReplayChecked<M, E> {
  const effects: E[] = [];
  const problems: string[] = [];
  let model = initial;

  const check = (step: number) => {
    const world = options.world?.(model, step);

    problems.push(
      ...viewProblems(options.view(model), {
        order: options.order,
        ...(world === undefined ? {} : { world }),
      }).map((problem) => `step ${step}: ${problem}`)
    );
  };

  check(0);

  for (const [index, msg] of messages.entries()) {
    const [next, produced] = update(model, msg);
    model = next;
    effects.push(...produced);
    check(index + 1);
  }

  return { model, effects, problems };
}
