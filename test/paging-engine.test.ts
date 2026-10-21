import { expect, test } from "vitest";

import { copy, patch, row, sync, values } from "../src/conformance/fixtures.ts";
import type { Command, Outcome } from "../src/conformance/fixtures.ts";
import {
  all,
  complete,
  deliver,
  firstPage,
  history,
  loaded,
  middle,
  newest,
  paged,
  partialCopy,
  secondPage,
} from "../src/conformance/paging-fixtures.ts";
import { settled } from "../src/sync.ts";
import type { Pending } from "../src/sync.ts";

// An old server after a rollback, with no write since: its delta to a partial copy has the copy's revision, no rows and
// no page. It is still an old server, so the copy asks for its whole copy at once instead of retrying the page.
test("an old server's empty delta to a partial copy asks for the whole copy at once", () => {
  const [model, effects] = deliver(loaded(partialCopy()), patch(10, []), 10);
  const pulls = effects.filter((effect) => effect.kind === "pull");
  expect(model.restart).toBe("whole");
  expect(pulls).toHaveLength(1);
  expect(pulls[0]).toMatchObject({ since: 0 });
  expect(Object.hasOwn(pulls[0] ?? {}, "page")).toBe(false);
  expect(history(model.replica)).toStrictEqual(partialCopy().history);
});

// A complete copy polled by a paging server that has nothing new: nothing to write.
test("an idle complete copy writes nothing on an equal-revision paged reply", () => {
  const before = loaded({ ...copy(10, all), history: complete });
  const nothing = { from: null, next: null, through: null, held: 6, total: 6 };
  const [after, effects] = deliver(before, paged(10, [], nothing));
  expect(effects.filter((effect) => effect.kind === "commit")).toStrictEqual([]);
  expect(after.replica).toBe(before.replica);
});

// The server resets a partial copy (its delta outgrew the reply) at a newer revision whose newest page is unchanged:
// the copy moved on, so the next page follows at once, not after a backoff.
test("a reset at a newer revision with the same first page is progress, not a stuck pull", () => {
  const [model, effects] = deliver(
    loaded(partialCopy()),
    paged(12, newest, { ...firstPage, total: 6 }, true),
    10
  );

  expect(model.replica.revision).toBe(12);
  expect(model.pull).toMatchObject({ kind: "pulling", failures: 0 });
  expect(effects.filter((effect) => effect.kind === "pull")).toMatchObject([
    { since: 12, page: firstPage.next },
  ]);
});

// A command an earlier page sent, whose receipt comes back on a push replay while the copy is partial and lacks the row
// the command wrote: revision alone doesn't settle it. The next pull names it, and the reply that carries its row does.
test("on a partial copy a command settles only once a pull reply carrying its rows is applied", () => {
  const earlier: Pending<Command, Outcome> = {
    client: "previous-page",
    id: 1,
    dataset: "dataset-a",
    since: 4,
    command: { name: "put", value: 10 },
    at: 0,
    state: { kind: "unknown", failure: "page closed before acknowledgement" },
  };

  let [model] = sync.update(sync.initial("new-page", 0), {
    type: "loaded",
    replica: { ...copy(0, []), dataset: null },
    commands: [earlier],
    unreadable: 0,
    now: 0,
  });

  [model] = deliver(model, paged(10, newest, firstPage, true), 0);
  const receipt = { id: 1, revision: 5, outcome: { kind: "ok", resource: "a" } } as const;
  let effects;

  [model, effects] = sync.update(model, {
    type: "pushed",
    client: "previous-page",
    ids: [1],
    receipts: [receipt],
    revision: 10,
    now: 2,
  });

  const command = () => {
    const found = model.commands.find((each) => each.client === "previous-page");

    if (found === undefined) {
      throw new Error("missing command");
    }

    return found;
  };

  expect(command().state.kind).toBe("done");
  expect(settled(model, command())).toBe(false);
  // The page pull already in flight lands without the row: still not settled, and the next pull names the command.
  [model, effects] = deliver(model, paged(10, middle, secondPage));
  expect(settled(model, command())).toBe(false);
  const pulls = effects.filter((effect) => effect.kind === "pull");
  expect(pulls).toMatchObject([{ commands: [{ client: "previous-page", id: 1 }] }]);

  [model] = sync.update(model, {
    type: "pulled",
    since: 10,
    patch: paged(10, [row("a", 10, 5)], { ...secondPage, from: "unrelated" }),
    receipts: [{ ...receipt, client: "previous-page" }],
    now: 10,
  });

  expect(settled(model, command())).toBe(true);
  expect(values(model.replica)).toContainEqual(["a", 10, 5]);
});
