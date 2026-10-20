import { describe, expect, test } from "vitest";

import { copy, patch, row, sync, values } from "./fixtures.ts";

function ready() {
  let model = sync.initial("page-a", 0);
  model = sync.update(model, {
    type: "loaded",
    replica: copy(0, [], "dataset-a"),
    commands: [],
    unreadable: 0,
    now: 0,
  })[0];
  model = sync.update(model, {
    type: "pulled",
    since: 0,
    patch: patch(1, [row("seed", 100, 1)], true),
    receipts: [],
    now: 0,
  })[0];
  model = sync.update(model, { type: "committed", dataset: "dataset-a", revision: 1, now: 0 })[0];
  model = sync.update(model, {
    type: "checked",
    dataset: "dataset-a",
    revision: 1,
    match: true,
    now: 0,
  })[0];

  return model;
}

describe("independent portable sync rules", () => {
  test("a late older patch/reset cannot resurrect a deleted row or undo newer values", () => {
    let model = ready();
    model = sync.update(model, {
      type: "pulled",
      since: 1,
      patch: patch(3, [row("seed", 100, 3, true), row("new", 300, 3)]),
      receipts: [],
      now: 1,
    })[0];
    model = sync.update(model, {
      type: "pulled",
      since: 1,
      patch: patch(2, [row("seed", 200, 2)], true),
      receipts: [],
      now: 2,
    })[0];
    expect(model.replica.revision).toBe(3);
    expect(values(model.replica)).toStrictEqual([["new", 300, 3]]);
  });

  test("an action emits a durable keep, and only its commit acknowledgement permits a push", () => {
    const [saving, beforeCommit] = sync.update(ready(), {
      type: "command",
      command: { name: "put", value: 125 },
      now: 1,
    });

    expect(beforeCommit.filter((effect) => effect.kind === "push")).toStrictEqual([]);
    expect(beforeCommit.filter((effect) => effect.kind === "keep")).toMatchObject([
      { pending: { client: "page-a", id: 1, command: { name: "put", value: 125 } } },
    ]);
    const [, afterCommit] = sync.update(saving, { type: "kept", client: "page-a", id: 1, now: 2 });
    expect(afterCommit.filter((effect) => effect.kind === "push")).toStrictEqual([
      {
        kind: "push",
        client: "page-a",
        dataset: "dataset-a",
        since: 1,
        commands: [{ id: 1, command: { name: "put", value: 125 } }],
      },
    ]);
  });

  test("an old successful fingerprint cannot certify a newer replica", () => {
    let model = sync.initial("page-a", 0);
    model = sync.update(model, {
      type: "loaded",
      replica: copy(0, []),
      commands: [],
      unreadable: 0,
      now: 0,
    })[0];

    const [one, firstEffects] = sync.update(model, {
      type: "pulled",
      since: 0,
      patch: patch(1, [row("seed", 100, 1)], true),
      receipts: [],
      now: 1,
    });

    expect(firstEffects.filter((effect) => effect.kind === "check")).toHaveLength(1);
    model = sync.update(one, { type: "heard", revision: 2, now: 2 })[0];

    const [two, nextEffects] = sync.update(model, {
      type: "pulled",
      since: 1,
      patch: patch(2, [row("new", 250, 2)]),
      receipts: [],
      now: 3,
    });

    expect(nextEffects.filter((effect) => effect.kind === "check")).toHaveLength(1);

    const [staleCheck] = sync.update(two, {
      type: "checked",
      dataset: "dataset-a",
      revision: 1,
      match: true,
      now: 4,
    });

    expect(values(staleCheck.replica)).toStrictEqual([
      ["new", 250, 2],
      ["seed", 100, 1],
    ]);
    expect(staleCheck.verify.kind).not.toBe("done");

    const [currentCheck] = sync.update(staleCheck, {
      type: "checked",
      dataset: "dataset-a",
      revision: 2,
      match: true,
      now: 5,
    });

    expect(currentCheck.verify).toStrictEqual({ kind: "done", match: true });
  });
});
