import { expect, test } from "vitest";

import { copy, database, values } from "../src/conformance/fixtures.ts";
import {
  all,
  history,
  lastPage,
  oldest,
  partialCopy,
  secondPage,
} from "../src/conformance/paging-fixtures.ts";

// A tab whose earlier page never landed (its write failed, or another tab rewrote the disk at a shallower cursor) moves
// on from a cursor the disk doesn't have. Its page can't make the disk claim the rows in between.
test("a page from a cursor the disk doesn't hold never lands coverage without its rows", async () => {
  const first = database();
  const second = database({ factory: first.factory, name: first.name });
  await Promise.all([first.port.load(), second.port.load()]);
  await first.port.commit({
    replica: partialCopy(),
    reset: true,
    base: 10,
    replaces: "dataset-a",
    from: null,
    ops: [],
  });
  await second.port.commit({
    replica: partialCopy(10, all, lastPage),
    reset: false,
    base: 10,
    replaces: "dataset-a",
    from: secondPage.next,
    ops: oldest.map((item) => ({ table: "rows", key: item.id, row: item })),
  });

  const disk = (await database({ factory: first.factory, name: first.name }).port.load()).replica;
  const claim = history(disk);
  const held = new Map(values(disk).map((each) => [each[0], each]));

  const covered = values(copy(10, all)).filter(
    ([, value]) =>
      claim?.kind === "complete" ||
      (claim?.kind === "partial" &&
        claim.through !== null &&
        Number(value) >= Number(claim.through))
  );

  expect(claim).toBeDefined();

  // Every row the disk claims is there, and every row it holds is the server's.
  for (const each of covered) {
    expect(held.get(each[0])).toStrictEqual(each);
  }

  for (const each of held.values()) {
    expect(values(copy(10, all))).toContainEqual(each);
  }
});
