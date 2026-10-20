/**
 * `since` belongs to the tap, never laundered by a newer pull or reset. Legacy entries without one take the revision
 * loaded with them, before any newer pull.
 */

import { expect, test } from "vitest";

import { createClient } from "../client.ts";
import { copy, database, deferred, patch, pending, sync } from "./fixtures.ts";
import type { Network } from "./fixtures.ts";

function client(
  stored: ReturnType<typeof database>,
  network: Network,
  name = "page-a",
  extra: Partial<Pick<ReturnType<typeof database>["port"], "keep" | "commit">> = {}
) {
  return createClient({
    sync,
    client: name,
    ports: {
      storage: { ...stored.port, ...extra },
      network,
      now: () => 0,
      fingerprint: async () => "fixture-fingerprint",
    },
  });
}

async function seed(stored: ReturnType<typeof database>, revision: number) {
  await stored.port.load();
  await stored.port.commit({
    replica: copy(revision, []),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  });
}

// Guard: capture replica revision synchronously at command creation, even before the first copy exists.
test("tap before the first pull keeps and sends since zero after the first copy arrives", async () => {
  const stored = database();
  const pulling = deferred<void>();
  const firstPull = deferred<Awaited<ReturnType<Network["pull"]>>>();
  const requests: number[] = [];

  const runtime = client(stored, {
    pull: async () => {
      pulling.resolve();

      return await firstPull.promise;
    },
    push: async (request) => {
      requests.push(request.since);

      return { ok: false, failure: { kind: "offline", message: "lost reply" } };
    },
  });

  runtime.start();
  await pulling.promise;
  runtime.command({ name: "put", value: 125 });
  firstPull.resolve({ ok: true, value: { patch: patch(17, [], true), receipts: [] } });
  await runtime.settle();
  expect(runtime.model().replica.revision).toBe(17);
  expect(requests).toStrictEqual([0]);
  expect((await stored.port.load()).commands).toMatchObject([
    { client: "page-a", id: 1, since: 0 },
  ]);
  expect(runtime.faults).toStrictEqual([]);
});

// Guard: a slow durable keep and concurrent copy advancement cannot replace the intent's original fence.
test("tap at 17 stays fenced at 17 while storage is slow and a pull advances the copy to 29", async () => {
  const stored = database();

  const entered = deferred<void>();
  const release = deferred<void>();
  const advanced = deferred<void>();

  const requests: number[] = [];
  let head = 17;

  const runtime = client(
    stored,
    {
      pull: async () => ({ ok: true, value: { patch: patch(head, [], true), receipts: [] } }),
      push: async (request) => {
        requests.push(request.since);

        return { ok: false, failure: { kind: "offline", message: "lost reply" } };
      },
    },
    "page-a",
    {
      keep: async (intent) => {
        entered.resolve();
        await release.promise;
        await stored.port.keep(intent);
      },
      commit: async (commit) => {
        const answer = await stored.port.commit(commit);

        if (commit.replica.revision === 29) {
          advanced.resolve();
        }

        return answer;
      },
    }
  );

  runtime.start();
  await runtime.settle();
  expect(runtime.model().replica.revision).toBe(17);
  runtime.command({ name: "put", value: 125 });
  await entered.promise;
  head = 29;
  runtime.dispatch({ type: "heard", revision: 29, now: 1 });
  await advanced.promise;
  expect(runtime.model().replica.revision).toBe(29);
  expect(requests).toStrictEqual([]);
  release.resolve();
  await runtime.settle();
  expect(requests).toStrictEqual([17]);
  expect((await stored.port.load()).commands).toMatchObject([{ since: 17 }]);
  expect(runtime.faults).toStrictEqual([]);
});

// Guard: the outbox schema preserves since across load/reload; the first successful pull cannot reauthorize it.
test("a reloaded outbox retains its own since through a newer reset", async () => {
  const stored = database();
  await seed(stored, 29);
  await stored.port.keep({ ...pending("older-page", 1, 125), since: 17 });
  const reopened = database({ factory: stored.factory, name: stored.name });
  const requests: number[] = [];
  expect((await reopened.port.load()).commands).toMatchObject([
    { client: "older-page", id: 1, since: 17 },
  ]);

  const runtime = client(
    reopened,
    {
      pull: async () => ({ ok: true, value: { patch: patch(41, [], true), receipts: [] } }),
      push: async (request) => {
        requests.push(request.since);

        return { ok: false, failure: { kind: "offline", message: "lost reply" } };
      },
    },
    "newer-page"
  );

  runtime.start();
  await runtime.settle();
  expect(runtime.model().replica.revision).toBe(41);
  expect(requests).toStrictEqual([17]);
  expect((await reopened.port.load()).commands).toMatchObject([{ since: 17 }]);
  expect(runtime.faults).toStrictEqual([]);
});

// Guard: normalize ABSENT since from the loaded checkpoint before a pull/reset can advance it; zero stays real.
test("a legacy record without since captures loaded revision 17 before a reset advances the copy to 29", async () => {
  const stored = database();
  await seed(stored, 17);
  await stored.port.keep(pending("legacy-page", 1, 125));
  const requests: number[] = [];
  const reopened = database({ factory: stored.factory, name: stored.name });

  const runtime = client(
    reopened,
    {
      pull: async () => ({ ok: true, value: { patch: patch(29, [], true), receipts: [] } }),
      push: async (request) => {
        requests.push(request.since);

        return { ok: false, failure: { kind: "offline", message: "lost reply" } };
      },
    },
    "newer-page"
  );

  runtime.start();
  await runtime.settle();
  expect(runtime.model().replica.revision).toBe(29);
  expect(requests).toStrictEqual([17]);
  expect(runtime.faults).toStrictEqual([]);
});

// Guard: batching partitions by (client,dataset,since), never makes older commands inherit a sibling's fence.
test("one push cannot mix taps from different revisions, including zero and legacy loaded scope", async () => {
  const stored = database();
  await seed(stored, 29);
  await stored.port.keep({ ...pending("original-page", 1, 125), since: 0 });
  await stored.port.keep({ ...pending("original-page", 2, 250), since: 17 });
  await stored.port.keep({ ...pending("original-page", 3, 375), since: 29 });
  await stored.port.keep(pending("original-page", 4, 500));
  const requests: { client: string; dataset: string | null; since: number; ids: number[] }[] = [];

  const runtime = client(
    stored,
    {
      pull: async () => ({ ok: true, value: { patch: patch(41, [], true), receipts: [] } }),
      push: async (request) => {
        requests.push({
          client: request.client,
          dataset: request.dataset,
          since: request.since,
          ids: request.commands.map((command) => command.id),
        });

        return {
          ok: true,
          value: {
            revision: 41,
            receipts: request.commands.map((command) => ({
              id: command.id,
              revision: 41,
              outcome: { kind: "failed", reason: "fixture refused" },
            })),
          },
        };
      },
    },
    "reloaded-page"
  );

  runtime.start();
  await runtime.settle();
  expect(requests.flatMap((request) => request.ids).toSorted((a, b) => a - b)).toStrictEqual([
    1, 2, 3, 4,
  ]);

  const expected = new Map([
    [1, 0],
    [2, 17],
    [3, 29],
    [4, 29],
  ]);

  for (const request of requests) {
    expect(request.client).toBe("original-page");
    expect(request.dataset).toBe("dataset-a");

    for (const id of request.ids) {
      expect(request.since, `command ${id} inherited another tap's fence`).toBe(expected.get(id));
    }
  }

  expect(runtime.faults).toStrictEqual([]);
});
