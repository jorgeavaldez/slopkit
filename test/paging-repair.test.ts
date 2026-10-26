import { expect, test } from "vitest";

import { createClient } from "../src/client.ts";
import { copy, database, sync, values } from "../src/conformance/fixtures.ts";
import type { Network } from "../src/conformance/fixtures.ts";
import {
  all,
  complete,
  deliver,
  history,
  lastPage,
  loaded,
  middle,
  oldest,
  paged,
  partialCopy,
  secondPage,
} from "../src/conformance/paging-fixtures.ts";
import { deriveDurabilityState, saved } from "../src/sync.ts";

const offline = { ok: false, failure: { kind: "offline", message: "paused" } } as const;

/** A page between the second and the last, for a copy still partial after it. */
const olderPage = { from: "older:c:30", next: "older:b:20", through: "20", held: 5, total: 6 };

// A page whose write failed, then the next page landing at the same revision: the disk took that page as a delta from
// a cursor it doesn't hold, so it still lacks the failed page's rows. The page doesn't call that kept: it owes a whole
// write, says the copy isn't kept, and writes it.
test("a later page never cancels a failed page's repair", async () => {
  let abort = false;

  const stored = database({
    interfere: (what, transaction) => {
      if (what === "commit" && abort) {
        abort = false;
        transaction.abort();
      }
    },
  });

  await stored.port.load();
  let model = loaded(partialCopy());
  await stored.port.commit({
    replica: model.replica,
    reset: true,
    base: 0,
    replaces: null,
    from: null,
    ops: [],
  });

  let effects;
  [model, effects] = deliver(model, paged(10, middle, secondPage));
  const failing = effects.find((effect) => effect.kind === "commit");

  if (failing === undefined) {
    throw new Error("no commit");
  }

  abort = true;
  await expect(stored.port.commit(failing)).rejects.toThrow("IndexedDB transaction failed");
  [model] = sync.update(model, {
    type: "commitFailed",
    reason: "aborted",
    replaced: false,
    now: 2,
  });
  [model, effects] = deliver(model, paged(10, oldest.slice(0, 1), olderPage));
  const later = effects.find((effect) => effect.kind === "commit");

  if (later === undefined) {
    throw new Error("no commit");
  }

  const ack = await stored.port.commit(later);
  [model, effects] = sync.update(model, { type: "committed", ...ack, now: 4 });
  expect(saved(model)).toBe(false);
  expect(deriveDurabilityState(model).kind).not.toBe("ok");
  const repair = effects.find((effect) => effect.kind === "commit");
  expect(repair).toMatchObject({ reset: true });

  if (repair === undefined) {
    throw new Error("no repair");
  }

  const repaired = await stored.port.commit(repair);
  [model] = sync.update(model, { type: "committed", ...repaired, now: 5 });
  expect(saved(model)).toBe(true);
  expect(deriveDurabilityState(model)).toStrictEqual({ kind: "ok" });
  const disk = (await database({ factory: stored.factory, name: stored.name }).port.load()).replica;
  expect(values(disk)).toStrictEqual(values(copy(10, all.slice(0, 5))));
  expect(history(disk)).toStrictEqual(partialCopy(10, [], olderPage).history);
});

// A page whose write failed, then the last page landing at the same revision: the disk can't take it as a delta from a
// cursor it doesn't hold (it would still lack the failed page's rows). The page's copy is complete, so it lands whole,
// and only then is it kept.
test("a failed page's repair lands whole with the last page", async () => {
  let abort = false;

  const stored = database({
    interfere: (what, transaction) => {
      if (what === "commit" && abort) {
        abort = false;
        transaction.abort();
      }
    },
  });

  await stored.port.load();
  let model = loaded(partialCopy());
  await stored.port.commit({
    replica: model.replica,
    reset: true,
    base: 0,
    replaces: null,
    from: null,
    ops: [],
  });

  let effects;
  [model, effects] = deliver(model, paged(10, middle, secondPage));
  const failing = effects.find((effect) => effect.kind === "commit");

  if (failing === undefined) {
    throw new Error("no commit");
  }

  abort = true;
  await expect(stored.port.commit(failing)).rejects.toThrow("IndexedDB transaction failed");
  [model] = sync.update(model, {
    type: "commitFailed",
    reason: "aborted",
    replaced: false,
    now: 2,
  });
  [model, effects] = deliver(model, paged(10, oldest, lastPage));
  const later = effects.find((effect) => effect.kind === "commit");

  if (later === undefined) {
    throw new Error("no commit");
  }

  const ack = await stored.port.commit(later);
  [model] = sync.update(model, { type: "committed", ...ack, now: 4 });
  expect(saved(model)).toBe(true);
  expect(deriveDurabilityState(model)).toStrictEqual({ kind: "ok" });
  const disk = (await database({ factory: stored.factory, name: stored.name }).port.load()).replica;
  expect(values(disk)).toStrictEqual(values(copy(10, all)));
  expect(history(disk)).toStrictEqual(complete);
});

test("the production client repairs the failed page and the disk ends complete", async () => {
  let abort = false;

  const stored = database({
    interfere: (what, transaction) => {
      if (what === "commit" && abort) {
        abort = false;
        transaction.abort();
      }
    },
  });

  await stored.port.load();
  await stored.port.commit({
    replica: partialCopy(),
    from: null,
    reset: true,
    base: 10,
    replaces: "dataset-a",
    ops: [],
  });

  let replies = 0;

  const network: Network = {
    push: async () => offline,
    pull: async () => {
      replies++;

      if (replies === 1) {
        abort = true;

        return { ok: true, value: { patch: paged(10, middle, secondPage), receipts: [] } };
      }

      return replies === 2
        ? { ok: true, value: { patch: paged(10, oldest, lastPage), receipts: [] } }
        : offline;
    },
  };

  const app = createClient({
    sync,
    client: "page-a",
    ports: { storage: stored.port, network, now: () => 0, fingerprint: async () => "x" },
  });

  app.start();
  await app.settle();
  expect(app.faults).toStrictEqual([]);
  expect(history(app.model().replica)).toStrictEqual(complete);
  expect(saved(app.model())).toBe(true);
  const disk = (await database({ factory: stored.factory, name: stored.name }).port.load()).replica;
  expect(history(disk)).toStrictEqual(complete);
  expect(values(disk)).toStrictEqual(values(copy(10, all)));
});
