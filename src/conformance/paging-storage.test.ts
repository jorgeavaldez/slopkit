import { describe, expect, test } from "vitest";

import { createClient, Replaced } from "../client.ts";
import { POLL_MS } from "../sync.ts";
import type { Commit } from "../sync.ts";
import {
  copy,
  database,
  deferred,
  patch,
  pendingSchema,
  rowsLens,
  serverSchema,
  sync,
  values,
} from "./fixtures.ts";
import type { Command, Copy, Network, Outcome, PatchRows, Server, Tables } from "./fixtures.ts";
import { indexedReplica as legacyReplica } from "./legacy/replica-012.ts";
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
} from "./paging-fixtures.ts";

function commit(
  replica: Copy,
  from: string | null,
  rows: typeof newest = [],
  reset = false
): Commit<Tables, Server> & { from: string | null } {
  return {
    replica,
    from,
    reset,
    base: replica.revision,
    replaces: "dataset-a",
    ops: rows.map((item) => ({ table: "rows", key: item.id, row: item })),
  };
}

const legacyRowsLens = {
  ...rowsLens,
  shape:
    '"rows":object(strict,{"id":string(0,100000),"value":number(true,-1.7976931348623157e+308,1.7976931348623157e+308),"deleted":boolean,"revision":number(true,0,1.7976931348623157e+308)})',
};

function oldPort(stored: ReturnType<typeof database>) {
  return legacyReplica<Tables, PatchRows, Server, Command, Outcome>({
    factory: stored.factory,
    name: stored.name,
    version: 1,
    tables: [legacyRowsLens],
    empty: { rows: new Map() },
    server: serverSchema,
    pending: pendingSchema,
  });
}

function runtime(
  stored: ReturnType<typeof database>,
  network: Network,
  name = "page-a",
  clock?: { now: number }
) {
  return createClient({
    sync,
    client: name,
    ports: {
      storage: stored.port,
      network,
      now: () => clock?.now ?? 0,
      fingerprint: async () => "fixture-fingerprint",
    },
  });
}

const failedPush: Network["push"] = async () => ({
  ok: false,
  failure: { kind: "offline", message: "no commands in this history" },
});

const unavailable: Awaited<ReturnType<Network["pull"]>> = {
  ok: false,
  failure: { kind: "offline", message: "download paused" },
};

describe("paged checkpoints", () => {
  test("12: executor persists each page and a reload requests the stored cursor, not the first page", async () => {
    const stored = database();
    const firstRequests: Parameters<Network["pull"]>[0][] = [];

    const first = runtime(stored, {
      push: failedPush,
      pull: async (request) => {
        firstRequests.push(request);

        return firstRequests.length === 1
          ? { ok: true, value: { patch: paged(10, newest, firstPage, true), receipts: [] } }
          : unavailable;
      },
    });

    first.start();
    await first.settle();
    expect(first.faults).toStrictEqual([]);
    expect(firstRequests[0]).toMatchObject({ since: 0, page: null });
    const disk = await stored.port.load();
    expect(history(disk.replica)).toStrictEqual(partialCopy().history);
    expect(values(disk.replica)).toStrictEqual(values(copy(10, newest)));
    const reopened = database({ factory: stored.factory, name: stored.name });
    const requests: Parameters<Network["pull"]>[0][] = [];

    const second = runtime(
      reopened,
      {
        push: failedPush,
        pull: async (request) => {
          requests.push(request);
          const cursor = requestedPage(request);

          return {
            ok: true,
            value: {
              patch:
                cursor === firstPage.next
                  ? paged(10, middle, secondPage)
                  : cursor === secondPage.next
                    ? paged(10, oldest, lastPage)
                    : patch(10, [], false),
              receipts: [],
            },
          };
        },
      },
      "page-b"
    );

    second.start();
    await second.settle();
    expect(requests[0]).toMatchObject({ since: 10, page: firstPage.next, verify: false });
    // Two remaining pages, at most one separate verification pull.
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(values((await reopened.port.load()).replica)).toStrictEqual(values(copy(10, all)));
    expect(history((await reopened.port.load()).replica)).toStrictEqual(complete);
    expect(second.faults).toStrictEqual([]);
  });

  test("13: an already-open 0.1.2 tab is fenced by a newer partial checkpoint; reopening reads no partial rows", async () => {
    const stored = database();
    const old = oldPort(stored);
    await old.load();
    await old.commit(commit(copy(9, all), null, [], true));
    const current = database({ factory: stored.factory, name: stored.name });
    await current.port.load();
    await current.port.commit(commit(partialCopy(10), null, [], true));
    await expect(old.commit(commit(copy(11, all), null, [], true))).rejects.toBeInstanceOf(
      Replaced
    );
    const reloaded = oldPort(stored);
    const unread = await reloaded.load();
    expect(unread.replica.dataset).toBeNull();
    expect(values(unread.replica)).toStrictEqual([]);
    // This is the old release's legacy whole pull, not a paged response.
    const whole = patch(10, all, true);
    await reloaded.commit(commit(copy(whole.revision, whole.rows.rows), null, [], true));
    const modern = database({ factory: stored.factory, name: stored.name });
    const restored = await modern.port.load();
    expect(values(restored.replica)).toStrictEqual(values(copy(10, all)));
    expect(history(restored.replica)).toStrictEqual(complete);
  });

  test("13 compatibility control: the released adapter reads and writes whole checkpoints unchanged", async () => {
    const stored = database();
    const old = oldPort(stored);
    await old.load();
    await old.commit(commit(copy(10, all), null, [], true));
    const reopen = oldPort(stored);
    expect(values((await reopen.load()).replica)).toStrictEqual(values(copy(10, all)));
  });

  test("13 compatibility control: a new complete checkpoint stays readable by the released adapter", async () => {
    const stored = database();
    await stored.port.load();
    await stored.port.commit(commit(partialCopy(10, all, lastPage), null, [], true));
    const old = await oldPort(stored).load();
    expect(old.replica.dataset).toBe("dataset-a");
    expect(old.replica.revision).toBe(10);
    expect(values(old.replica)).toStrictEqual(values(copy(10, all)));
  });

  test("14: a native aborted same-revision page commit leaves a whole write owed and repairs the cursor", async () => {
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
    await stored.port.commit(commit(partialCopy(), null, [], true));
    let replies = 0;
    const clock = { now: 0 };

    const app = runtime(
      stored,
      {
        push: failedPush,
        pull: async () => {
          replies++;

          if (replies === 1) {
            abort = true;

            return { ok: true, value: { patch: paged(10, middle, secondPage), receipts: [] } };
          }

          return unavailable;
        },
      },
      "page-a",
      clock
    );

    app.start();
    await app.settle();
    expect(app.model().storage.kind).toBe("failed");
    expect(history((await stored.port.load()).replica)).toStrictEqual(partialCopy().history);
    clock.now = POLL_MS + 1;
    app.dispatch({ type: "tick", now: clock.now });
    await app.settle();
    const recovered = await stored.port.load();
    expect(values(recovered.replica)).toStrictEqual(values(copy(10, [...newest, ...middle])));
    expect(history(recovered.replica)).toStrictEqual(partialCopy(10, [], secondPage).history);
    expect(app.faults).toStrictEqual([]);
  });

  test("15: different cursors at one revision never advance disk coverage without its rows", async () => {
    const first = database();
    const second = database({ factory: first.factory, name: first.name });
    await Promise.all([first.port.load(), second.port.load()]);
    await first.port.commit(commit(partialCopy(), null, [], true));
    await second.port.commit(
      commit(partialCopy(10, [...newest, ...middle], secondPage), firstPage.next, middle)
    );
    const disk = await database({ factory: first.factory, name: first.name }).port.load();
    expect(values(disk.replica)).toStrictEqual(values(copy(10, [...newest, ...middle])));
    expect(history(disk.replica)).toStrictEqual(partialCopy(10, [], secondPage).history);
    // A stale page arriving after completion may not narrow durable coverage.
    await second.port.commit(commit(partialCopy(10, all, lastPage), secondPage.next, oldest));
    await first.port.commit(commit(partialCopy(), null, [], true));
    const finished = await database({ factory: first.factory, name: first.name }).port.load();
    expect(values(finished.replica)).toStrictEqual(values(copy(10, all)));
    expect(history(finished.replica)).toStrictEqual(complete);
  });

  test("15: two production clients at different cursors and revisions do not ping-pong whole writes", async () => {
    const stored = database();
    await stored.port.load();
    await stored.port.commit(commit(partialCopy(), null, [], true));
    const tab = database({ factory: stored.factory, name: stored.name });
    const enter = deferred<void>();
    const release = deferred<void>();
    let firstCalls = 0;
    let writes = 0;
    const original = stored.port.commit;
    stored.port.commit = async (value) => {
      writes++;

      if (writes > 8) {
        throw new Error("busy whole-write loop");
      }

      return await original(value);
    };

    const first = runtime(stored, {
      push: failedPush,
      pull: async () => {
        firstCalls++;

        if (firstCalls === 1) {
          enter.resolve();
          await release.promise;

          return { ok: true, value: { patch: paged(10, middle, secondPage), receipts: [] } };
        }

        if (firstCalls === 2) {
          return { ok: true, value: { patch: paged(11, oldest, lastPage), receipts: [] } };
        }

        return { ok: true, value: { patch: patch(11, []), receipts: [] } };
      },
    });

    first.start();
    await enter.promise;
    let secondCalls = 0;

    const second = runtime(
      tab,
      {
        push: failedPush,
        pull: async () => {
          secondCalls++;

          return {
            ok: true,
            value: {
              patch:
                secondCalls === 1
                  ? paged(11, [...middle, ...oldest], { ...lastPage, from: firstPage.next })
                  : patch(11, []),
              receipts: [],
            },
          };
        },
      },
      "page-b"
    );

    second.start();
    await second.settle();
    release.resolve();
    await first.settle();
    expect(writes).toBeLessThanOrEqual(3);

    for (const app of [first, second]) {
      expect(history(app.model().replica)).toStrictEqual(complete);
      expect(app.faults).toStrictEqual([]);
    }

    const disk = await database({ factory: stored.factory, name: stored.name }).port.load();
    expect(values(disk.replica)).toStrictEqual(values(copy(11, all)));
    expect(history(disk.replica)).toStrictEqual(complete);
  });
});
