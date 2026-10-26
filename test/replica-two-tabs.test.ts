import { expect, test } from "vitest";

import { createClient } from "../src/client.ts";
import { copy, database, deferred, patch, sync, values } from "../src/conformance/fixtures.ts";
import type { Copy, Network, Row, Server, Tables } from "../src/conformance/fixtures.ts";
import {
  all,
  complete,
  firstPage,
  history,
  lastPage,
  middle,
  newest,
  oldest,
  paged,
  partialCopy,
  requestedPage,
  secondPage,
} from "../src/conformance/paging-fixtures.ts";
import { saved } from "../src/sync.ts";
import type { Commit } from "../src/sync.ts";

// A different page size puts this tab's cursor between the usual first and second pages.
const alternatePage = {
  from: null,
  next: "older:d:40",
  through: "40",
  held: 3,
  total: 6,
};

const alternateRows = all.filter((item) => item.value >= 40);
const afterAlternate = all.filter((item) => item.value < 40);

function commit(
  replica: Copy,
  from: string | null,
  rows: Row[] = [],
  reset = false,
  base = replica.revision
): Commit<Tables, Server> {
  return {
    replica,
    from,
    reset,
    base,
    replaces: "dataset-a",
    ops: rows.map((item) => ({ table: "rows", key: item.id, row: item })),
  };
}

async function freshCopy(stored: ReturnType<typeof database>) {
  return (await database({ factory: stored.factory, name: stored.name }).port.load()).replica;
}

test.each([10, 11])(
  "a diverged tab's final page at revision %i lands its whole copy on disk",
  async (revision) => {
    const first = database();
    const second = database({ factory: first.factory, name: first.name });
    await Promise.all([first.port.load(), second.port.load()]);
    await first.port.commit(commit(partialCopy(), null, [], true));

    // The other tab already holds f/e/d, but the shared disk only holds f/e. Its next page adds c,
    // not d: keeping that delta alone cannot make the disk claim the tab's cursor or completeness.
    await second.port.commit(
      commit(
        partialCopy(10, [...newest, ...middle], secondPage),
        alternatePage.next,
        middle.filter((item) => item.value < 40)
      )
    );
    await second.port.commit(
      commit(partialCopy(revision, all, lastPage), secondPage.next, oldest, false, 10)
    );
    const disk = await freshCopy(first);
    expect.soft(history(disk), "fresh disk history").toStrictEqual(complete);
    expect(values(disk), "fresh disk rows").toStrictEqual(values(copy(revision, all)));

    // An older tab's first page must not undo the completed disk, even at the same revision.
    await first.port.commit(commit(partialCopy(revision), null, [], true));
    const finished = await freshCopy(first);
    expect(history(finished)).toStrictEqual(complete);
    expect(values(finished)).toStrictEqual(values(copy(revision, all)));
  }
);

test("a complete tab's next delta repairs a page skipped behind a newer disk revision", async () => {
  const first = database();
  const second = database({ factory: first.factory, name: first.name });
  await Promise.all([first.port.load(), second.port.load()]);
  await first.port.commit(commit(partialCopy(11), null, [], true));

  // This tab finished at revision 10. Its final page is older than the disk, so none of the
  // middle/oldest rows can be assumed durable when its subsequent empty delta reaches revision 11.
  await second.port.commit(
    commit(partialCopy(10, all, lastPage), firstPage.next, [...middle, ...oldest])
  );
  await second.port.commit(commit(partialCopy(11, all, lastPage), null, [], false, 10));
  const disk = await freshCopy(first);
  expect.soft(history(disk), "fresh disk history").toStrictEqual(complete);
  expect(values(disk), "fresh disk rows").toStrictEqual(values(copy(11, all)));
});

const offline = { ok: false, failure: { kind: "offline", message: "no commands" } } as const;

test("two production clients with diverging page cursors save a complete shared disk without a write loop", async () => {
  const stored = database();
  const tab = database({ factory: stored.factory, name: stored.name });
  const firstWaiting = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondWaiting = deferred<void>();
  const releaseSecond = deferred<void>();
  const writes = { count: 0 };

  for (const port of [stored.port, tab.port]) {
    const original = port.commit;
    port.commit = async (value) => {
      writes.count++;

      if (writes.count > 12) {
        throw new Error("two tabs did not stop committing");
      }

      return await original(value);
    };
  }

  let firstCalls = 0;
  const firstRequests: (string | null | undefined)[] = [];

  const firstNetwork: Network = {
    push: async () => offline,
    pull: async (request) => {
      firstCalls++;
      firstRequests.push(requestedPage(request));

      if (firstCalls === 1) {
        return { ok: true, value: { patch: paged(10, newest, firstPage, true), receipts: [] } };
      }

      if (firstCalls === 2) {
        firstWaiting.resolve();
        await releaseFirst.promise;

        return { ok: true, value: { patch: paged(10, middle, secondPage), receipts: [] } };
      }

      if (firstCalls === 3) {
        return { ok: true, value: { patch: paged(12, oldest, lastPage), receipts: [] } };
      }

      return { ok: true, value: { patch: patch(12, []), receipts: [] } };
    },
  };

  let secondCalls = 0;
  const secondRequests: (string | null | undefined)[] = [];

  const secondNetwork: Network = {
    push: async () => offline,
    pull: async (request) => {
      secondCalls++;
      secondRequests.push(requestedPage(request));

      if (secondCalls === 1) {
        return {
          ok: true,
          value: { patch: paged(11, alternateRows, alternatePage, true), receipts: [] },
        };
      }

      if (secondCalls === 2) {
        secondWaiting.resolve();
        await releaseSecond.promise;

        return {
          ok: true,
          value: {
            patch: paged(11, afterAlternate, { ...lastPage, from: alternatePage.next }),
            receipts: [],
          },
        };
      }

      return { ok: true, value: { patch: patch(12, []), receipts: [] } };
    },
  };

  const first = createClient({
    sync,
    client: "page-a",
    ports: {
      storage: stored.port,
      network: firstNetwork,
      now: () => 0,
      fingerprint: async () => "fixture-fingerprint",
    },
  });

  const second = createClient({
    sync,
    client: "page-b",
    ports: {
      storage: tab.port,
      network: secondNetwork,
      now: () => 0,
      fingerprint: async () => "fixture-fingerprint",
    },
  });

  first.start();
  await firstWaiting.promise;
  second.start();
  await secondWaiting.promise;
  // The disk now has B's newer, differently sized first page. A's middle page is older and
  // A's final page comes from a cursor the disk never held. Then B's final page is older too.
  releaseFirst.resolve();
  await first.settle();
  releaseSecond.resolve();
  await second.settle();
  second.dispatch({ type: "heard", revision: 12, now: 1 });
  await second.settle();

  for (const app of [first, second]) {
    expect(app.faults).toStrictEqual([]);
    expect(history(app.model().replica)).toStrictEqual(complete);
    expect(values(app.model().replica)).toStrictEqual(values(copy(12, all)));
    expect(saved(app.model())).toBe(true);
  }

  expect(firstRequests.slice(0, 3)).toStrictEqual([null, firstPage.next, secondPage.next]);
  expect(secondRequests.slice(0, 2)).toStrictEqual([firstPage.next, alternatePage.next]);
  expect(writes.count).toBeLessThanOrEqual(12);
  const disk = await freshCopy(stored);
  expect.soft(history(disk), "fresh disk history").toStrictEqual(complete);
  expect(values(disk), "fresh disk rows").toStrictEqual(values(copy(12, all)));
});
