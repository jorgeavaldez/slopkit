import { expect, test } from "vitest";

import { MEANINGS, states } from "../src/states.ts";
import type { Model, Pending } from "../src/sync.ts";
import * as stateChecks from "../src/test/states.ts";
import type { World } from "../src/test/states.ts";
import { engine } from "./sync-fixture.ts";
import type { Command, Outcome, Tables } from "./sync-fixture.ts";

type Sync = Model<Tables, { version: string }, Command, Outcome>;

type PageModel = { mode: "ready" | "working" | "blank"; sync: Sync; now: number };

type Message = "keep" | "clear" | "finish";

type Result = { model: PageModel; effects: readonly string[]; problems: readonly string[] };

type Options = {
  view: (model: PageModel) => ReturnType<typeof view>;
  order: typeof MEANINGS;
  world?: (model: PageModel, step: number) => World;
};

type Replay = (
  transition: typeof update,
  initial: PageModel,
  messages: readonly Message[],
  options: Options
) => Result;

const checks: typeof stateChecks & { replayProblems?: Replay } = stateChecks;

const ui = states<never>({ order: MEANINGS });

const subject = ui.subject<{ kind: "ready" } | { kind: "working" } | { kind: "blank" }>("item", {
  ready: {
    meaning: "ok",
    where: "main",
    claim: false,
    why: "The item is ready",
    text: () => "ready",
    action: null,
  },
  working: {
    meaning: "working",
    where: "main",
    claim: false,
    why: "A saved command is waiting for its answer",
    text: () => "saving",
    action: null,
    owes: () => ({ command: { client: "earlier-page", id: 7 } }),
  },
  blank: {
    meaning: "ok",
    where: "main",
    claim: false,
    why: "The item's label is empty",
    text: () => "",
    action: null,
  },
});

const intent: Pending<Command, Outcome> = {
  client: "earlier-page",
  id: 7,
  dataset: "dataset-a",
  since: 5,
  command: { name: "put", id: "a", value: 1 },
  at: 100,
  state: { kind: "queued" },
};

function initial(): PageModel {
  const sync = engine.initial("current-page", 100);

  return {
    mode: "ready",
    now: 100,
    sync: {
      ...sync,
      boot: { kind: "ready" },
      replica: { ...sync.replica, dataset: "dataset-a", revision: 5 },
    },
  };
}

function update(model: PageModel, message: Message): readonly [PageModel, readonly string[]] {
  return [
    {
      ...model,
      mode: message === "finish" ? "ready" : "working",
      now: model.now + 1,
      sync: { ...model.sync, commands: message === "keep" ? [intent] : [] },
    },
    message === "keep" ? ["persist", "send"] : [message],
  ];
}

function view(model: PageModel) {
  return { nested: [subject.line({ kind: model.mode })] };
}

const world = (model: PageModel): World => ({ now: model.now, model: model.sync, jobs: [] });

function replay(model: PageModel, messages: readonly Message[], options: Partial<Options> = {}) {
  if (!checks.replayProblems) {
    throw new Error("replayProblems is not exported");
  }

  return checks.replayProblems(update, model, messages, { view, order: MEANINGS, ...options });
}

test("a clean replay returns the last model and every effect in message order", () => {
  const first = initial();
  const result = replay(first, ["keep", "finish"], { world });
  expect(result.problems).toStrictEqual([]);
  expect(result.effects).toStrictEqual(["persist", "send", "finish"]);
  expect(result.model).toStrictEqual({
    ...first,
    now: 102,
    sync: { ...first.sync, commands: [] },
  });
  expect(first.now).toBe(100);
  expect(first.sync.commands).toStrictEqual([]);
});

test("a transient working line without its command names the message step even when the last view is clean", () => {
  const result = replay(initial(), ["keep", "clear", "finish"], { world });
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toMatch(/step\s*[:#]?\s*2\b/i);
  expect(result.problems[0]).toContain("item.working");
  expect(result.problems[0]).toContain("earlier-page:7");
  expect(result.model.mode).toBe("ready");
  expect(result.effects).toStrictEqual(["persist", "send", "clear", "finish"]);
});

test("the same working line is valid when the reached model holds its command", () => {
  const result = replay(initial(), ["keep"], { world });
  expect(result.problems).toStrictEqual([]);
  expect(result.model.mode).toBe("working");
  expect(result.model.sync.commands).toStrictEqual([intent]);
});

test("the initial view is checked at step zero, even when the first message repairs it", () => {
  const result = replay({ ...initial(), mode: "blank" }, ["finish"]);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toMatch(/step\s*[:#]?\s*0\b/i);
  expect(result.problems[0]).toContain("item");
  expect(result.model.mode).toBe("ready");
});

test("the world is derived from the initial model and each reached model, including the last", () => {
  const first = initial();
  const reached: { model: PageModel; step: number }[] = [];

  const result = replay(first, ["keep", "clear", "finish"], {
    world: (model, step) => {
      reached.push({ model, step });

      return world(model);
    },
  });

  expect(
    reached.map(({ model, step }) => [step, model.now, model.sync.commands.length])
  ).toStrictEqual([
    [0, 100, 0],
    [1, 101, 1],
    [2, 102, 0],
    [3, 103, 0],
  ]);
  expect(reached[0]?.model).toBe(first);
  expect(reached[3]?.model).toBe(result.model);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toMatch(/step\s*[:#]?\s*2\b/i);
});

test("an initial problem does not hide a later problem or stop the replay", () => {
  const result = replay({ ...initial(), mode: "blank" }, ["keep", "clear", "finish"], { world });
  expect(result.problems).toHaveLength(2);
  expect(result.problems[0]).toMatch(/step\s*[:#]?\s*0\b/i);
  expect(result.problems[1]).toMatch(/step\s*[:#]?\s*2\b/i);
  expect(result.problems[1]).toContain("earlier-page:7");
  expect(result.effects).toStrictEqual(["persist", "send", "clear", "finish"]);
  expect(result.model.mode).toBe("ready");
});

test("an empty replay returns the initial model and no effects while still checking its view", () => {
  const first = initial();
  const result = replay(first, []);
  expect(result.model).toBe(first);
  expect(result.effects).toStrictEqual([]);
  expect(result.problems).toStrictEqual([]);
});
