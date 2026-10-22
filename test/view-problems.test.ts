/** Contract choices: visit Map keys as well as values; shared/cyclic objects are checked once.
 * Sync debt counts only when the engine would start it; already in-flight work always counts.
 * A due idle push is work only with a command that is not done.
 */
import { expect, test } from "vitest";

import { MEANINGS, states } from "../src/states.ts";
import type { Line, Owed } from "../src/states.ts";
import { SOCKET_DEADLINE_MS } from "../src/sync.ts";
import type { Model, Pending } from "../src/sync.ts";
import { viewProblems } from "../src/test/states.ts";
import type { World } from "../src/test/states.ts";
import { engine } from "./sync-fixture.ts";
import type { Command, Outcome, Tables } from "./sync-fixture.ts";

const now = Date.parse("2026-10-21T16:00:00Z");
const ui = states<never>({ order: MEANINGS });

type M = Model<Tables, { version: string }, Command, Outcome>;

const world = (model?: M): World => ({ now, jobs: [], ...(model === undefined ? {} : { model }) });

function quiet(): M {
  const model = engine.initial("page", now);

  return {
    ...model,
    boot: { kind: "ready" },
    connection: { kind: "live" },
    // Quiet as the engine leaves a page: the socket just heard, the session's self-check done.
    socket: { open: true, heardAt: now },
    verify: { kind: "done", match: true },
    replica: { ...model.replica, dataset: "fixture", revision: 5 },
    saved: { ...model.saved, dataset: "fixture", revision: 5, writing: 0 },
    target: 5,
    pull: { kind: "idle", nextAt: now + 1000, failures: 0 },
    push: { kind: "idle", nextAt: now + 1000, failures: 0 },
  };
}

function line(text: string, owed: Owed | null = null, subject = "parcel:P1") {
  return ui
    .subject<{ kind: "checking" }>(subject, {
      checking: {
        meaning: "working",
        where: "main",
        claim: false,
        why: "Check underway",
        text: () => text,
        action: null,
        owes: owed === null ? null : () => owed,
      },
    })
    .line({ kind: "checking" });
}

type Shown = Parameters<typeof viewProblems>[0];

function check(shown: Shown, w?: World): string[] {
  return viewProblems(shown, { order: MEANINGS, ...(w === undefined ? {} : { world: w }) });
}

const jobDebt: Owed = { job: { kind: "check", key: "P1" } };
const commandDebt: Owed = { command: { client: "earlier-page", id: 7 } };

const badJob =
  'parcel:P1.checking says "checking…" (working) but owes job check:P1, which isn\'t under way';

const badCommand =
  'parcel:P1.checking says "checking…" (working) but owes command earlier-page:7, which isn\'t under way';

const badSync =
  'parcel:P1.checking says "checking…" (working) but owes sync, which isn\'t under way';

test("walks nested objects, arrays, Map keys/values and Sets, safely across cycles and shared values", () => {
  const a = line("", null, "empty");
  const b = line("undefined value", null, "broken");
  const c = line("checking…", jobDebt);

  type Reached = {
    nested: { map: Map<Line<never>, Set<Line<never>>> }[];
    self?: Reached;
    again?: Line<never>;
  };

  const root: Reached = {
    nested: [{ map: new Map([[b, new Set([a, c])]]) }],
  };

  root.self = root;
  root.again = c;
  const problems = check(root, world());
  expect(problems).toHaveLength(3);
  expect(problems.some((p) => p.includes("empty") && /text|empty|blank/.test(p))).toBe(true);
  expect(problems.some((p) => p.includes("broken") && p.includes("undefined"))).toBe(true);
  expect(problems).toContain(badJob);
  expect(check([null, undefined, 1, "plain text", false, new Date(now)])).toStrictEqual([]);
});

test.each(["", "  \n\t"])("rejects blank line text %j", (text) => {
  expect(check(line(text))).toHaveLength(1);
});

test.each(["undefined", "null", "NaN", "[object Object]", "Invalid Date"])(
  "rejects the existing broken-value pattern: %s",
  (text) => {
    expect(check(line(`value: ${text}`))).toHaveLength(1);
  }
);

test("good lines, external working states and work without a world remain legal", () => {
  expect(check({ nested: [line("in transit"), line("checking…", jobDebt)] })).toStrictEqual([]);
  expect(check(line("in transit"), world())).toStrictEqual([]);
});

test("valid screens keep claims whole and check their nested lines", () => {
  const claim = ui
    .subject<{ kind: "short" }>("history", {
      short: {
        meaning: "partial",
        where: "main",
        claim: true,
        why: "Only newest rows held",
        text: () => "two days only",
        action: null,
      },
    })
    .line({ kind: "short" });

  const working = line("checking…", jobDebt);
  expect(check({ screen: ui.compose([claim, working], "ready") }, world())).toStrictEqual([badJob]);
});

test.each(["ok", "headline", "claims", "drop", "severity"])(
  "checks the screen contract: %s",
  (fault) => {
    const claim = ui
      .subject<{ kind: "short" }>("history", {
        short: {
          meaning: "partial",
          where: "main",
          claim: true,
          why: "Only newest rows held",
          text: () => "two days only",
          action: null,
        },
      })
      .line({ kind: "short" });

    const working = line("in transit");
    const screen = ui.compose([claim, working], "ready");

    // Deliberate corrupted reached values: retain the real Screen's nominal identity.
    if (fault === "ok") {
      Object.defineProperty(screen, "ok", { value: true });
    }

    if (fault === "headline") {
      Object.defineProperty(screen, "headline", {
        value: { ...screen.headline, meaning: "ok", text: "ready" },
      });
    }

    if (fault === "claims") {
      Object.defineProperty(screen, "claims", { value: [] });
    }

    if (fault === "drop") {
      Object.defineProperty(screen, "more", { value: [] });
    }

    if (fault === "severity") {
      Object.defineProperty(screen, "headline", {
        value: { ...screen.headline, meaning: working.meaning, text: working.text },
      });
    }

    expect(check(new Set([screen])).length).toBeGreaterThan(0);
  }
);

test.each([
  ["due", -1, true],
  ["due", 0, true],
  ["due", 1, false],
  ["running", 86_400_000, true],
  ["done", -1, false],
  ["failed", -1, false],
] as const)("owed job %s at offset %i is under way: %s", (state, offset, real) => {
  const jobs: World["jobs"] = [
    { kind: "check", key: "P1", state, dueAt: new Date(now + offset).toISOString() },
  ];

  expect(check(line("checking…", jobDebt), { now, jobs })).toStrictEqual(real ? [] : [badJob]);
});

// The poke delay: the server finished the job, and the page can't have heard yet.
const ended = (state: "done" | "failed", ago: number): NonNullable<World["jobs"]> => [
  {
    kind: "check",
    key: "P1",
    state,
    dueAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - ago).toISOString(),
  },
];

test.each(["done", "failed"] as const)(
  "a job %s within the socket's deadline is still under way until the page could have heard",
  (state) => {
    expect(check(line("checking…", jobDebt), { now, jobs: ended(state, 1000) })).toStrictEqual([]);
    expect(
      check(line("checking…", jobDebt), { now, jobs: ended(state, SOCKET_DEADLINE_MS - 1) })
    ).toStrictEqual([]);
    expect(
      check(line("checking…", jobDebt), { now, jobs: ended(state, SOCKET_DEADLINE_MS) })
    ).toStrictEqual([badJob]);
  }
);

test("a job that ended before the page's copy last caught up isn't under way, unless a pull is", () => {
  const caughtUp: M = { ...quiet(), reconciledAt: now - 500 };
  const jobs = ended("done", 1000);
  expect(check(line("checking…", jobDebt), { now, jobs, model: caughtUp })).toStrictEqual([badJob]);

  const before: M = { ...quiet(), reconciledAt: now - 2000 };
  expect(check(line("checking…", jobDebt), { now, jobs, model: before })).toStrictEqual([]);

  const pulling: M = { ...caughtUp, pull: { kind: "pulling", since: 5, failures: 0 } };
  expect(check(line("checking…", jobDebt), { now, jobs, model: pulling })).toStrictEqual([]);
});

test("missing jobs and different kind/key never satisfy the debt", () => {
  for (const jobs of [
    [],
    [{ kind: "other", key: "P1", state: "running" as const, dueAt: new Date(now).toISOString() }],
    [{ kind: "check", key: "P2", state: "running" as const, dueAt: new Date(now).toISOString() }],
  ]) {
    expect(check(line("checking…", jobDebt), { now, jobs })).toStrictEqual([badJob]);
  }
});

test("a finished earlier job does not mask the matching open job", () => {
  const jobs: World["jobs"] = [
    { kind: "check", key: "P1", state: "done", dueAt: new Date(now - 1000).toISOString() },
    { kind: "check", key: "P1", state: "due", dueAt: new Date(now).toISOString() },
  ];

  expect(check(line("checking…", jobDebt), { now, jobs })).toStrictEqual([]);
});

test("job deadlines compare instants rather than ISO string order", () => {
  expect(
    check(line("checking…", jobDebt), {
      now,
      jobs: [{ kind: "check", key: "P1", state: "due", dueAt: "2026-10-21T12:00:00-04:00" }],
    })
  ).toStrictEqual([]);
});

function pending(state: Pending<Command, Outcome>["state"]): Pending<Command, Outcome> {
  return {
    client: "earlier-page",
    id: 7,
    dataset: "fixture",
    command: { name: "put", id: "x", value: 1 },
    at: now,
    state,
  };
}

const done = (revision: number): Pending<Command, Outcome>["state"] => ({
  kind: "done",
  revision,
  outcome: { kind: "ok", resource: "x" },
});

test.each<Pending<Command, Outcome>["state"]>([{ kind: "saving" }, { kind: "sending" }])(
  "a command being saved or sent is under way: %j",
  (state) => {
    expect(
      check(
        line("checking…", commandDebt),
        world({
          ...quiet(),
          visible: false,
          connection: { kind: "offline", failure: "network down" },
          commands: [pending(state)],
        })
      )
    ).toStrictEqual([]);
  }
);

const unsent: Pending<Command, Outcome>["state"][] = [
  { kind: "queued" },
  { kind: "unknown", failure: "lost" },
];

test.each(unsent)(
  "an unsent command %j needs a due push and a live or stale connection",
  (state) => {
    const model: M = {
      ...quiet(),
      commands: [pending(state)],
      push: { kind: "idle", nextAt: now, failures: 0 },
    };

    for (const connection of [{ kind: "live" as const }, { kind: "stale" as const }]) {
      expect(check(line("checking…", commandDebt), world({ ...model, connection }))).toStrictEqual(
        []
      );
      expect(
        check(line("checking…", commandDebt), world({ ...model, connection, visible: false }))
      ).toStrictEqual([]);
      expect(
        check(
          line("checking…", commandDebt),
          world({ ...model, connection, push: { kind: "idle", nextAt: now + 1, failures: 1 } })
        )
      ).toStrictEqual([badCommand]);
    }

    for (const connection of [
      { kind: "offline" as const, failure: "network down" },
      { kind: "starting" as const },
      { kind: "signed-out" as const },
      { kind: "incompatible" as const, failure: "upgrade required" },
    ]) {
      expect(check(line("checking…", commandDebt), world({ ...model, connection }))).toStrictEqual([
        badCommand,
      ]);
    }
  }
);

test.each(unsent)("an unsent command %j counts while its push is in flight", (state) => {
  const model: M = {
    ...quiet(),
    visible: false,
    connection: { kind: "offline", failure: "network down" },
    commands: [pending(state)],
    push: { kind: "pushing", client: "earlier-page", ids: [7], was: [state], failures: 0 },
  };

  expect(check(line("checking…", commandDebt), world(model))).toStrictEqual([]);
});

test.each([0, 4, 5])("done command at revision %i is settled", (revision) => {
  expect(
    check(
      line("checking…", commandDebt),
      world({ ...quiet(), commands: [pending(done(revision))] })
    )
  ).toStrictEqual([badCommand]);
});

test("a partial copy settles a done command only when its receipt was carried", () => {
  const model = quiet();
  model.replica.history = { kind: "partial", next: "older", through: "today", held: 2, total: 10 };
  model.commands = [pending(done(5))];
  expect(check(line("checking…", commandDebt), world(model))).toStrictEqual([]);
  expect(
    check(line("checking…", commandDebt), world({ ...model, carried: new Set(["earlier-page:7"]) }))
  ).toStrictEqual([badCommand]);
});

test("a missing model/command or a different command identity is not under way", () => {
  const drawn = line("checking…", commandDebt);
  expect(check(drawn, world())).toStrictEqual([badCommand]);
  expect(check(drawn, world(quiet()))).toStrictEqual([badCommand]);

  for (const other of [
    { ...pending({ kind: "queued" }), client: "another" },
    { ...pending({ kind: "queued" }), id: 8 },
  ]) {
    expect(check(drawn, world({ ...quiet(), commands: [other] }))).toStrictEqual([badCommand]);
  }
});

test("sync with no model, a quiet model, or only future retries is not underway", () => {
  for (const w of [
    world(),
    world(quiet()),
    world({ ...quiet(), target: 4 }),
    world({ ...quiet(), commands: [pending({ kind: "queued" })] }),
    world({ ...quiet(), push: { kind: "idle", nextAt: now, failures: 0 } }),
    world({
      ...quiet(),
      push: { kind: "idle", nextAt: now, failures: 0 },
      commands: [pending(done(6))],
    }),
  ]) {
    expect(check(line("checking…", { sync: true }), w)).toStrictEqual([badSync]);
  }
});

const inFlightSync = [
  ["booting", (m: M): M => ({ ...m, boot: { kind: "loading", since: now } })],
  ["pulling", (m: M): M => ({ ...m, pull: { kind: "pulling", since: 5, failures: 0 } })],
  [
    "pushing",
    (m: M): M => ({
      ...m,
      push: { kind: "pushing", client: "page", ids: [1], was: [{ kind: "queued" }], failures: 0 },
    }),
  ],
  ["writing", (m: M): M => ({ ...m, saved: { ...m.saved, writing: 1 } })],
] as const;

const owedPulls = [
  ["target ahead", (m: M): M => ({ ...m, target: 6 })],
  [
    "next history page",
    (m: M): M => ({
      ...m,
      replica: {
        ...m.replica,
        history: { kind: "partial", next: "older", through: "today", held: 2, total: 10 },
      },
    }),
  ],
  // A poll: due with the socket gone quiet (a live socket's pokes stand in for polling).
  [
    "poll due",
    (m: M): M => ({
      ...m,
      connection: { kind: "stale" },
      pull: { kind: "idle", nextAt: now, failures: 0 },
    }),
  ],
  [
    "poll overdue",
    (m: M): M => ({
      ...m,
      connection: { kind: "stale" },
      pull: { kind: "idle", nextAt: now - 1, failures: 0 },
    }),
  ],
] as const;

test("a pull due on a live socket with nothing owed isn't under way: the engine waits for its pokes", () => {
  const model: M = { ...quiet(), pull: { kind: "idle", nextAt: now - 1, failures: 0 } };
  expect(check(line("checking…", { sync: true }), world(model))).toStrictEqual([badSync]);
});

const awaitingPull: Pending<Command, Outcome>["state"][] = [
  done(6),
  { kind: "unknown", failure: "refused", parked: true },
];

test.each(awaitingPull)(
  "an answered or parked command %j is not under way without a pull owed",
  (state) => {
    expect(
      check(line("checking…", commandDebt), world({ ...quiet(), commands: [pending(state)] }))
    ).toStrictEqual([badCommand]);
  }
);

test.each(owedPulls)("an answered or parked command needs %s to be allowed", (_name, change) => {
  for (const state of awaitingPull) {
    const model = { ...change(quiet()), commands: [pending(state)] };
    expect(check(line("checking…", commandDebt), world(model))).toStrictEqual([]);

    for (const blocked of [
      { ...model, visible: false },
      { ...model, connection: { kind: "signed-out" as const } },
      { ...model, connection: { kind: "incompatible" as const, failure: "upgrade required" } },
    ]) {
      expect(check(line("checking…", commandDebt), world(blocked))).toStrictEqual([badCommand]);
    }
  }
});

test.each(awaitingPull)(
  "an answered or parked command %j counts while a pull is in flight",
  (state) => {
    const model: M = {
      ...quiet(),
      visible: false,
      connection: { kind: "signed-out" },
      commands: [pending(state)],
      pull: { kind: "pulling", since: 5, failures: 0 },
    };

    expect(check(line("checking…", commandDebt), world(model))).toStrictEqual([]);
  }
);

test("a settled command never counts even while a pull is in flight", () => {
  const model: M = {
    ...quiet(),
    commands: [pending(done(5))],
    pull: { kind: "pulling", since: 5, failures: 0 },
  };

  expect(check(line("checking…", commandDebt), world(model))).toStrictEqual([badCommand]);
});

const duePushes = [
  [
    "push due",
    (m: M): M => ({
      ...m,
      commands: [pending({ kind: "queued" })],
      push: { kind: "idle", nextAt: now, failures: 0 },
    }),
  ],
  [
    "push overdue",
    (m: M): M => ({
      ...m,
      commands: [pending({ kind: "queued" })],
      push: { kind: "idle", nextAt: now - 1, failures: 0 },
    }),
  ],
] as const;

test.each([...inFlightSync, ...owedPulls, ...duePushes])(
  "sync is real while %s",
  (_name, change) => {
    expect(check(line("checking…", { sync: true }), world(change(quiet())))).toStrictEqual([]);
  }
);

test.each(owedPulls)(
  "%s is not under way while hidden, signed out or incompatible",
  (_name, change) => {
    const owed = change(quiet());

    for (const model of [
      { ...owed, visible: false },
      { ...owed, connection: { kind: "signed-out" as const } },
      { ...owed, connection: { kind: "incompatible" as const, failure: "upgrade required" } },
    ]) {
      expect(check(line("checking…", { sync: true }), world(model))).toStrictEqual([badSync]);
    }
  }
);

test.each(owedPulls)(
  "%s may start while visible with a starting, offline or stale connection",
  (_name, change) => {
    const owed = change(quiet());

    for (const connection of [
      { kind: "starting" as const },
      { kind: "offline" as const, failure: "network down" },
      { kind: "stale" as const },
    ]) {
      expect(
        check(line("checking…", { sync: true }), world({ ...owed, connection }))
      ).toStrictEqual([]);
    }
  }
);

test.each(duePushes)(
  "%s with an unsent command needs a live or stale connection",
  (_name, change) => {
    const owed = change(quiet());

    for (const connection of [
      { kind: "starting" as const },
      { kind: "offline" as const, failure: "network down" },
      { kind: "signed-out" as const },
      { kind: "incompatible" as const, failure: "upgrade required" },
    ]) {
      expect(
        check(line("checking…", { sync: true }), world({ ...owed, connection }))
      ).toStrictEqual([badSync]);
    }

    for (const connection of [{ kind: "live" as const }, { kind: "stale" as const }]) {
      expect(
        check(line("checking…", { sync: true }), world({ ...owed, connection }))
      ).toStrictEqual([]);
      expect(
        check(line("checking…", { sync: true }), world({ ...owed, connection, visible: false }))
      ).toStrictEqual([]);
    }
  }
);

test.each(inFlightSync)(
  "%s still counts when hidden, signed out or incompatible",
  (_name, change) => {
    const busy = change(quiet());

    for (const connection of [
      { kind: "signed-out" as const },
      { kind: "incompatible" as const, failure: "upgrade required" },
    ]) {
      expect(
        check(line("checking…", { sync: true }), world({ ...busy, connection, visible: false }))
      ).toStrictEqual([]);
    }
  }
);

const pullReasons: [string, (model: M) => M][] = [
  ["a target ahead", (model) => ({ ...model, target: 6 })],
  [
    "partial history",
    (model) => ({
      ...model,
      replica: {
        ...model.replica,
        history: { kind: "partial", next: "older", through: "today", held: 2, total: 10 },
      },
    }),
  ],
  ["a pending restart", (model) => ({ ...model, restart: "paged" })],
];

const pullRetries = [
  ["no failed attempt", 0, now + 1000, true],
  ["a failed attempt in backoff", 1, now + 1000, false],
  ["a retry due now", 1, now, true],
  ["an overdue retry", 2, now - 1, true],
] as const;

const pullCases = pullReasons.flatMap(([reason, change]) =>
  pullRetries.map(
    ([retry, failures, nextAt, underway]) =>
      [reason, retry, change, failures, nextAt, underway] as const
  )
);

test.each(pullCases)(
  "%s with %s only justifies sync and answered commands when the pull can start",
  (_reason, _retry, change, failures, nextAt, underway) => {
    const model: M = {
      ...change(quiet()),
      visible: true,
      connection: { kind: "offline", failure: "network down" },
      commands: [pending(done(6))],
      pull: { kind: "idle", nextAt, failures },
    };

    expect(check(line("checking…", { sync: true }), world(model))).toStrictEqual(
      underway ? [] : [badSync]
    );
    expect(check(line("checking…", commandDebt), world(model))).toStrictEqual(
      underway ? [] : [badCommand]
    );
  }
);
