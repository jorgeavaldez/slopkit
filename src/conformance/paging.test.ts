import { describe, expect, test } from "vitest";

import { POLL_MS, settled } from "../sync.ts";
import { copy, patch, pending, row, sync, values } from "./fixtures.ts";
import {
  all,
  assertCopy,
  complete,
  deliver,
  firstPage,
  history,
  lastPage,
  loaded,
  middle,
  newest,
  oldest,
  paged,
  partialCopy,
  Reference,
  secondPage,
} from "./paging-fixtures.ts";

describe("paged first copy", () => {
  test("1, 2, 5: edited and tombstoned anchors, changes on both sides, duplicates and late pages converge", () => {
    const reference = new Reference(10, all);
    let model = loaded();
    [model] = deliver(model, paged(10, newest, firstPage, true), 0);
    assertCopy(model, reference);

    const changes = [
      row("f", 65, 11),
      row("e", 15, 11),
      row("z", 70, 11),
      row("a", 5, 11),
      row("b", 20, 11, true),
    ];

    reference.write(11, changes);
    const page = { ...secondPage, held: 4, total: 6 };
    const reply = paged(11, [...changes, ...middle], page);
    [model] = deliver(model, reply, 10);
    assertCopy(model, reference);
    [model] = deliver(model, reply, 10);
    assertCopy(model, reference);
    expect(history(model.replica)).toMatchObject({ next: secondPage.next, through: "30" });
    const deletion = row("c", 30, 12, true);
    reference.write(12, [deletion]);
    [model] = deliver(
      model,
      paged(12, [deletion], {
        ...page,
        from: secondPage.next,
        next: secondPage.next,
        held: 3,
        total: 5,
      }),
      11
    );
    assertCopy(model, reference);
    [model] = deliver(model, reply, 10);
    assertCopy(model, reference);
    expect(model.replica.tables.rows.has("c")).toBe(false);
    [model] = deliver(
      model,
      paged(12, [row("e", 15, 11), row("a", 5, 11)], { ...lastPage, held: 5, total: 5 }),
      12
    );
    assertCopy(model, reference);
    expect(history(model.replica)).toStrictEqual(complete);
    expect(values(model.replica)).toStrictEqual([
      ["a", 5, 11],
      ["d", 40, 10],
      ["e", 15, 11],
      ["f", 65, 11],
      ["z", 70, 11],
    ]);
  });

  test("2: equal-revision pages merge; an unexpected from applies current rows but cannot advance the cursor", () => {
    let model = loaded(partialCopy());
    [model] = deliver(model, paged(10, middle, { ...secondPage, from: "another-cursor" }));
    expect(values(model.replica)).toHaveLength(4);
    expect(history(model.replica)).toStrictEqual(partialCopy().history);
    [model] = deliver(model, paged(10, middle, secondPage));
    expect(history(model.replica)).toStrictEqual(partialCopy(10, [], secondPage).history);
    [model] = deliver(model, paged(10, oldest, lastPage));
    assertCopy(model, new Reference(10, all));
  });

  test("3: a dataset reset starts its own history and refuses old-dataset intents", () => {
    let model = loaded(partialCopy());
    model = {
      ...model,
      commands: [
        {
          ...pending("page-a", 1),
          dataset: "dataset-a",
          state: { kind: "unknown", failure: "lost" },
        },
      ],
    };
    const replacement = [row("new-dataset", 900, 1)];
    [model] = deliver(
      model,
      paged(
        1,
        replacement,
        { from: null, next: "b:900", through: "900", held: 1, total: 2 },
        true,
        "dataset-b"
      )
    );
    expect(values(model.replica)).toStrictEqual([["new-dataset", 900, 1]]);
    expect(history(model.replica)).toMatchObject({ kind: "partial", next: "b:900" });
    expect(model.commands[0]?.state).toMatchObject({ kind: "done", outcome: { kind: "failed" } });
  });

  test("4: after a verify mismatch an in-flight delta cannot become a copy with a gap", () => {
    const wholeCopy = { ...copy(10, all), history: complete };
    let model = loaded(wholeCopy);
    [model] = sync.update(model, {
      type: "checked",
      dataset: "dataset-a",
      revision: 10,
      match: false,
      now: 1,
    });
    expect(model.replica.revision).toBe(0);
    const [after, effects] = deliver(model, patch(11, [row("new", 80, 11)]), 10);
    expect(after.replica.revision).toBe(0);
    expect(values(after.replica)).toStrictEqual([]);
    // The outstanding reset is sufficient; no second concurrent pull is required.
    expect(
      (after.pull.kind === "pulling" && after.pull.since === 0) ||
        effects.some((effect) => effect.kind === "pull" && effect.since === 0)
    ).toBe(true);
  });

  test("4: a same-dataset gap and a non-reset foreign dataset are dropped until a real reset", () => {
    for (const reply of [
      patch(12, [row("gap", 1, 12)]),
      patch(1, [row("foreign", 2, 1)], false, "dataset-b"),
    ]) {
      const model = loaded(partialCopy());
      const [after] = deliver(model, reply, 11);
      expect(values(after.replica)).toStrictEqual(values(model.replica));
      expect(after.replica.dataset).toBe("dataset-a");
      expect(after.replica.revision).toBe(10);
    }
  });

  test("6: one round trip exposes newest rows and the exact partial-history claim", () => {
    const [model] = deliver(loaded(), paged(10, newest, firstPage, true), 0);
    expect(values(model.replica)).toStrictEqual([
      ["e", 50, 10],
      ["f", 60, 10],
    ]);
    expect(history(model.replica)).toStrictEqual(partialCopy().history);
  });

  test("7: partial history owes back-to-back pulls carrying next, no-progress backs off and eventually resumes", () => {
    let [model, effects] = deliver(loaded(), paged(10, newest, firstPage, true), 0);
    expect(effects.filter((effect) => effect.kind === "pull")).toMatchObject([
      { since: 10, page: firstPage.next, verify: false },
    ]);
    [model, effects] = deliver(model, paged(10, newest, firstPage, true), 10);
    expect(effects.filter((effect) => effect.kind === "pull")).toStrictEqual([]);
    expect(model.pull).toMatchObject({ kind: "idle", failures: 1 });
    [model, effects] = sync.update(model, { type: "tick", now: model.now + POLL_MS - 1 });
    expect(effects.filter((effect) => effect.kind === "pull")).toStrictEqual([]);
    [model, effects] = sync.update(model, { type: "tick", now: model.now + 1 });
    expect(effects.filter((effect) => effect.kind === "pull")).toMatchObject([
      { page: firstPage.next },
    ]);
    [model, effects] = deliver(model, paged(10, newest, firstPage, true), 10);
    expect(effects.filter((effect) => effect.kind === "pull")).toStrictEqual([]);
    expect(model.pull).toMatchObject({
      kind: "idle",
      failures: 2,
      nextAt: model.now + 2 * POLL_MS,
    });
    [model, effects] = sync.update(model, { type: "tick", now: model.now + 2 * POLL_MS });
    expect(effects.filter((effect) => effect.kind === "pull")).toMatchObject([
      { page: firstPage.next },
    ]);
    [model, effects] = deliver(model, paged(10, middle, secondPage));
    expect(effects.filter((effect) => effect.kind === "pull")).toMatchObject([
      { page: secondPage.next },
    ]);
    [model] = deliver(model, paged(10, oldest, lastPage));
    expect(history(model.replica)).toStrictEqual(complete);
    assertCopy(model, new Reference(10, all));
  });

  test("8: verification is postponed on partial history, then requested when complete", () => {
    const [, firstEffects] = deliver(loaded(), paged(10, newest, firstPage, true), 0);
    expect(firstEffects.filter((effect) => effect.kind === "check")).toStrictEqual([]);

    const [model, effects] = sync.update(sync.initial("page-a", 0), {
      type: "loaded",
      replica: partialCopy(),
      commands: [],
      unreadable: 0,
      now: 0,
    });

    expect(effects.filter((effect) => effect.kind === "pull")).toMatchObject([
      { verify: false, page: firstPage.next },
    ]);
    const [middleModel, during] = deliver(model, paged(10, middle, secondPage));
    expect(during.filter((effect) => effect.kind === "check")).toStrictEqual([]);
    const [, finished] = deliver(middleModel, paged(10, oldest, lastPage));
    expect(
      finished.some(
        (effect) => effect.kind === "check" || (effect.kind === "pull" && effect.verify)
      )
    ).toBe(true);
  });

  test("9: an old server cannot certify partial history; the recovery request omits page and asks since zero", () => {
    const [model, effects] = deliver(loaded(partialCopy()), patch(11, [row("f", 61, 11)]), 10);
    expect(history(model.replica)).toStrictEqual(partialCopy().history);
    const pulls = effects.filter((effect) => effect.kind === "pull");
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ since: 0 });
    expect(Object.hasOwn(pulls[0] ?? {}, "page")).toBe(false);

    const [whole] = deliver(
      model,
      patch(11, [row("f", 61, 11), ...all.filter((item) => item.id !== "f")], true),
      0
    );

    expect(history(whole.replica)).toStrictEqual(complete);
    expect(whole.replica.tables.rows.size).toBe(6);
  });

  test("10: a delta below through never deepens the coverage claim", () => {
    const [model] = deliver(
      loaded(partialCopy()),
      paged(11, [row("a", 5, 11)], { ...firstPage, from: "unrelated", held: 2, total: 6 })
    );

    expect(model.replica.tables.rows.get("a")).toStrictEqual(row("a", 5, 11));
    expect(history(model.replica)).toStrictEqual(partialCopy().history);
  });

  test("11: a paged reset that settles a command holds the row named by its receipt", () => {
    const model = { ...loaded(), commands: [pending("page-a", 1)] };
    const effectRow = row("effect-below-page", 1, 10);

    const [after] = sync.update(model, {
      type: "pulled",
      since: 0,
      patch: paged(10, [...newest, effectRow], { ...firstPage, total: 7 }, true),
      receipts: [{ id: 1, revision: 10, outcome: { kind: "ok", resource: effectRow.id } }],
      now: 1,
    });

    const command = after.commands[0];
    expect(command).toBeDefined();

    if (command === undefined) {
      throw new Error("missing command");
    }

    expect(settled(after, command)).toBe(true);
    expect(after.replica.tables.rows.get(effectRow.id)).toStrictEqual(effectRow);
    expect(history(after.replica)).toStrictEqual({ ...partialCopy().history, total: 7 });
  });

  test("compatibility: a whole legacy reply is a complete copy and late replies stay harmless", () => {
    let model = loaded();
    [model] = deliver(model, patch(10, all, true), 0);
    expect(values(model.replica)).toStrictEqual(values(copy(10, all)));
    [model] = deliver(model, patch(9, [row("f", 999, 9)], true), 0);
    expect(values(model.replica)).toStrictEqual(values(copy(10, all)));
  });
});
