import { describe, expect, test } from "vitest";

import { createClient } from "../client.ts";
import { POLL_MS, STORAGE_DEADLINE_MS } from "../sync.ts";
import type { Pending, Receipt } from "../sync.ts";
import { database, deferred, patch, row, sync, values } from "./fixtures.ts";
import type { Command, Copy, Network, Outcome } from "./fixtures.ts";

/** A controlled network peer, not another implementation of the client. Its literal rows/results are fixed by each
 * scenario. Network completions are barriers, while storage and client execution are the real production code. */
function peer() {
  let revision = 1;
  let dataset = "dataset-a";
  let rows = [row("seed", 100, 1)];
  const receipts = new Map<string, Receipt<Outcome>>();
  let effects = 0;
  const sent: { client: string; id: number; value: number; dataset: string }[] = [];
  const pulls: { client: string; since: number }[] = [];
  let loseNextPush = false;
  let invalidNextPush = false;
  let rejectPull = false;
  let unavailable = false;

  const network: Network = {
    pull: async (request) => {
      pulls.push({ client: request.client, since: request.since });

      if (rejectPull) {
        rejectPull = false;

        return { ok: false, failure: { kind: "unavailable", message: "one failed read" } };
      }

      const reset = request.dataset !== dataset || request.since === 0;

      return {
        ok: true,
        value: {
          patch: patch(
            revision,
            // A copy: a patch already sent keeps the rows it had.
            reset ? [...rows] : rows.filter((value) => value.revision > request.since),
            reset,
            dataset
          ),
          receipts: [...receipts.entries()].flatMap(([key, value]) =>
            key.startsWith(`${request.client}/`) && value.revision > request.since ? [value] : []
          ),
        },
      };
    },
    push: async (request) => {
      if (unavailable) {
        return { ok: false, failure: { kind: "offline", message: "disconnected before delivery" } };
      }

      const answers: Receipt<Outcome>[] = [];

      for (const item of request.commands) {
        sent.push({ client: request.client, id: item.id, value: item.command.value, dataset });
        const key = `${request.client}/${item.id}`;
        let receipt = receipts.get(key);

        if (receipt === undefined) {
          effects++;
          revision++;
          const resource = `item-${effects}`;
          rows.push(row(resource, item.command.value, revision));
          receipt = { id: item.id, outcome: { kind: "ok", resource }, revision };
          receipts.set(key, receipt);
        }

        answers.push(receipt);
      }

      if (loseNextPush) {
        loseNextPush = false;

        return { ok: false, failure: { kind: "offline", message: "reply lost after execution" } };
      }

      if (invalidNextPush) {
        invalidNextPush = false;

        return {
          ok: false,
          failure: { kind: "invalid", message: "unreadable reply after execution" },
        };
      }

      return { ok: true, value: { receipts: answers, revision } };
    },
  };

  return {
    network,
    pulls,
    sent,
    effects: () => effects,
    loseReply: () => {
      loseNextPush = true;
    },
    invalidReply: () => {
      invalidNextPush = true;
    },
    failPull: () => {
      rejectPull = true;
    },
    disconnected: (value: boolean) => {
      unavailable = value;
    },
    publish: (nextRevision: number, nextRows: ReturnType<typeof row>[]) => {
      revision = nextRevision;
      rows = nextRows;
    },
    replaceDataset: () => {
      dataset = "dataset-b";
      revision = 1;
      rows = [row("replacement-seed", 700, 1)];
      receipts.clear();
    },
  };
}

function client(
  stored: ReturnType<typeof database>,
  network: Network,
  name: string,
  clock: { now: number },
  extra: {
    keep?: (pending: Pending<Command, Outcome>) => Promise<void>;
    drop?: (keys: { client: string; id: number }[]) => Promise<void>;
  } = {}
) {
  const answered: Pending<Command, Outcome>[] = [];

  const runtime = createClient({
    sync,
    client: name,
    ports: {
      storage: { ...stored.port, ...extra },
      network,
      now: () => clock.now,
      fingerprint: async (_replica: Copy) => "fixture-fingerprint",
      answered: (answer) => {
        answered.push(answer);
      },
    },
  });

  return { runtime, answered };
}

async function start(app: ReturnType<typeof client>, stored: ReturnType<typeof database>) {
  app.runtime.start();
  await app.runtime.settle();
  expect(app.runtime.faults).toStrictEqual([]);
  expect((await stored.port.load()).replica.dataset).not.toBeNull();
}

describe("independent client executor conformance", () => {
  test("an intent cannot reach the network before its durable keep commits", async () => {
    const stored = database();
    const remote = peer();
    const clock = { now: 0 };
    const enter = deferred<void>();
    const release = deferred<void>();

    const app = client(stored, remote.network, "page-a", clock, {
      keep: async (intent) => {
        if (intent.state.kind !== "done") {
          enter.resolve();
          await release.promise;
        }

        await stored.port.keep(intent);
      },
    });

    await start(app, stored);
    app.runtime.command({ name: "put", value: 125 });
    await enter.promise;
    expect(remote.sent).toStrictEqual([]);
    expect((await stored.port.load()).commands).toStrictEqual([]);
    release.resolve();
    await app.runtime.settle();
    expect(remote.sent).toStrictEqual([
      { client: "page-a", id: 1, value: 125, dataset: "dataset-a" },
    ]);
    expect(remote.effects()).toBe(1);
    const disk = await stored.port.load();
    expect(values(disk.replica)).toStrictEqual([
      ["item-1", 125, 2],
      ["seed", 100, 1],
    ]);
    expect(app.answered.map((value) => value.state)).toStrictEqual([
      { kind: "done", outcome: { kind: "ok", resource: "item-1" }, revision: 2 },
    ]);
    expect(app.runtime.faults).toStrictEqual([]);
  });

  test("a native intent transaction abort produces a visible refusal and no external effect", async () => {
    const stored = database({
      interfere: (what, transaction) => {
        if (what === "keep") {
          transaction.abort();
        }
      },
    });

    const remote = peer();
    const app = client(stored, remote.network, "page-a", { now: 0 });
    await start(app, stored);
    app.runtime.command({ name: "put", value: 125 });
    await app.runtime.settle();
    expect(remote.sent).toStrictEqual([]);
    expect(remote.effects()).toBe(0);
    expect(app.answered).toHaveLength(1);
    expect(app.answered[0]?.state).toMatchObject({ kind: "done", outcome: { kind: "failed" } });
    expect(app.runtime.model().storage.kind).toBe("failed");
    expect((await stored.port.load()).commands).toStrictEqual([]);
  });

  test("a slow keep stays unresolved and unsent until commit, then completes once across reload", async () => {
    const stored = database();
    const remote = peer();
    const clock = { now: 0 };
    const enter = deferred<void>();
    const release = deferred<void>();

    const first = client(stored, remote.network, "page-a", clock, {
      keep: async (intent) => {
        if (intent.state.kind !== "done") {
          enter.resolve();
          await release.promise;
        }

        await stored.port.keep(intent);
      },
    });

    await start(first, stored);
    first.runtime.command({ name: "put", value: 125 });
    await enter.promise;
    clock.now = STORAGE_DEADLINE_MS + 1;
    first.runtime.dispatch({ type: "tick", now: clock.now });
    expect(first.answered).toStrictEqual([]);
    expect(first.runtime.model().commands[0]?.state.kind).toBe("saving");
    expect(remote.sent).toStrictEqual([]);
    expect((await stored.port.load()).commands).toStrictEqual([]);
    release.resolve();
    await first.runtime.settle();
    expect(remote.sent).toStrictEqual([
      { client: "page-a", id: 1, value: 125, dataset: "dataset-a" },
    ]);
    expect(first.answered).toMatchObject([
      {
        client: "page-a",
        id: 1,
        state: { kind: "done", outcome: { kind: "ok", resource: "item-1" } },
      },
    ]);
    const reopened = database({ factory: stored.factory, name: stored.name });
    const second = client(reopened, remote.network, "page-b", clock);
    await start(second, reopened);
    expect(remote.sent).toStrictEqual([
      { client: "page-a", id: 1, value: 125, dataset: "dataset-a" },
    ]);
    expect(remote.effects()).toBe(1);
    expect(values((await reopened.port.load()).replica)).toStrictEqual([
      ["item-1", 125, 2],
      ["seed", 100, 1],
    ]);
  });

  test("reload after a committed keep but before its acknowledgement preserves one logical operation", async () => {
    const stored = database();
    const remote = peer();
    const clock = { now: 0 };
    const committed = deferred<void>();
    const acknowledge = deferred<void>();

    const first = client(stored, remote.network, "page-a", clock, {
      keep: async (intent) => {
        await stored.port.keep(intent);

        if (intent.state.kind !== "done") {
          committed.resolve();
          await acknowledge.promise;
        }
      },
    });

    await start(first, stored);
    first.runtime.command({ name: "put", value: 125 });
    await committed.promise;
    clock.now = STORAGE_DEADLINE_MS + 1;
    first.runtime.dispatch({ type: "tick", now: clock.now });
    expect(first.answered).toStrictEqual([]);
    expect(remote.sent).toStrictEqual([]);
    const reopened = database({ factory: stored.factory, name: stored.name });
    const second = client(reopened, remote.network, "page-b", clock);
    await start(second, reopened);
    expect(remote.sent).toStrictEqual([
      { client: "page-a", id: 1, value: 125, dataset: "dataset-a" },
    ]);
    expect(remote.effects()).toBe(1);
    // If the old page also receives its late acknowledgement, duplicate delivery is legitimate; a new operation is not.
    acknowledge.resolve();
    await first.runtime.settle();
    expect(remote.sent).toStrictEqual([
      { client: "page-a", id: 1, value: 125, dataset: "dataset-a" },
      { client: "page-a", id: 1, value: 125, dataset: "dataset-a" },
    ]);
    expect(remote.effects()).toBe(1);
    expect(values((await reopened.port.load()).replica)).toStrictEqual([
      ["item-1", 125, 2],
      ["seed", 100, 1],
    ]);
    expect((await reopened.port.load()).commands).toMatchObject([
      {
        client: "page-a",
        id: 1,
        dataset: "dataset-a",
        state: { kind: "done", outcome: { kind: "ok", resource: "item-1" } },
      },
    ]);
  });

  test("lost acknowledgement is reconciled by the original identity across a new page", async () => {
    const stored = database();
    const remote = peer();
    const clock = { now: 0 };
    const first = client(stored, remote.network, "page-a", clock);
    await start(first, stored);
    remote.loseReply();
    first.runtime.command({ name: "put", value: 125 });
    await first.runtime.settle();
    expect(remote.effects()).toBe(1);
    const reopened = database({ factory: stored.factory, name: stored.name });
    const second = client(reopened, remote.network, "page-b", clock);
    await start(second, reopened);
    expect(remote.effects()).toBe(1);
    expect(remote.sent.every((value) => value.client === "page-a" && value.id === 1)).toBe(true);
    expect(values((await reopened.port.load()).replica)).toStrictEqual([
      ["item-1", 125, 2],
      ["seed", 100, 1],
    ]);
    expect(second.answered).toMatchObject([
      {
        client: "page-a",
        id: 1,
        state: { kind: "done", outcome: { kind: "ok", resource: "item-1" } },
      },
    ]);
    second.runtime.command({ name: "put", value: 250 });
    await second.runtime.settle();
    expect(remote.effects()).toBe(2);
    expect(remote.sent.at(-1)).toStrictEqual({
      client: "page-b",
      id: 1,
      value: 250,
      dataset: "dataset-a",
    });
  });

  test("an unreadable acknowledgement is unknown, not a fabricated final failure", async () => {
    const stored = database();
    const remote = peer();
    const app = client(stored, remote.network, "page-a", { now: 0 });
    await start(app, stored);
    remote.invalidReply();
    app.runtime.command({ name: "put", value: 125 });
    await app.runtime.settle();
    expect(remote.effects()).toBe(1);
    expect(app.answered).toStrictEqual([]);
    expect(app.runtime.model().commands[0]?.state.kind).toBe("unknown");
    const reopened = database({ factory: stored.factory, name: stored.name });
    expect((await reopened.port.load()).commands).toMatchObject([{ client: "page-a", id: 1 }]);
    const next = client(reopened, remote.network, "page-b", { now: 1 });
    await start(next, reopened);
    expect(remote.effects()).toBe(1);
    expect(next.answered).toMatchObject([
      {
        client: "page-a",
        id: 1,
        state: { kind: "done", outcome: { kind: "ok", resource: "item-1" } },
      },
    ]);
  });

  test("heartbeats do not cancel a failed catch-up obligation", async () => {
    const stored = database();
    const remote = peer();
    const clock = { now: 0 };
    const app = client(stored, remote.network, "page-a", clock);
    await start(app, stored);
    remote.publish(2, [row("seed", 100, 1), row("new", 250, 2)]);
    remote.failPull();
    app.runtime.dispatch({ type: "heard", revision: 2, now: clock.now });
    await app.runtime.settle();
    app.runtime.dispatch({ type: "heard", revision: 2, now: 1 });
    clock.now = POLL_MS + 1;
    app.runtime.dispatch({ type: "tick", now: clock.now });
    await app.runtime.settle();
    expect((await stored.port.load()).replica.revision).toBe(2);
    expect(values((await stored.port.load()).replica)).toStrictEqual([
      ["new", 250, 2],
      ["seed", 100, 1],
    ]);
    expect(app.runtime.model().target).toBe(2);
  });

  test("later successful persistence cannot hide an earlier aborted replica write", async () => {
    let abort = false;

    const stored = database({
      interfere: (what, transaction) => {
        if (what === "commit" && abort) {
          abort = false;
          transaction.abort();
        }
      },
    });

    const remote = peer();
    const clock = { now: 0 };
    const app = client(stored, remote.network, "page-a", clock);
    await start(app, stored);
    abort = true;
    remote.publish(2, [row("seed", 100, 1), row("middle", 250, 2)]);
    app.runtime.dispatch({ type: "heard", revision: 2, now: clock.now });
    await app.runtime.settle();
    expect((await stored.port.load()).replica.revision).toBe(1);
    expect(app.runtime.model().storage.kind).toBe("failed");
    remote.publish(3, [row("seed", 100, 1), row("middle", 250, 2), row("last", 375, 3)]);
    app.runtime.dispatch({ type: "heard", revision: 3, now: 1 });
    await app.runtime.settle();
    const reopened = database({ factory: stored.factory, name: stored.name });
    expect((await reopened.port.load()).replica.revision).toBe(3);
    expect(values((await reopened.port.load()).replica)).toStrictEqual([
      ["last", 375, 3],
      ["middle", 250, 2],
      ["seed", 100, 1],
    ]);
  });

  test("old dataset intents cannot silently execute in a replacement dataset", async () => {
    const stored = database();
    const remote = peer();
    const clock = { now: 0 };
    const old = client(stored, remote.network, "page-a", clock);
    await start(old, stored);
    remote.disconnected(true);
    old.runtime.command({ name: "put", value: 125 });
    await old.runtime.settle();
    expect(remote.effects()).toBe(0);
    remote.replaceDataset();
    remote.disconnected(false);
    const reopened = database({ factory: stored.factory, name: stored.name });
    const current = client(reopened, remote.network, "page-b", clock);
    await start(current, reopened);
    expect(remote.sent.filter((value) => value.dataset === "dataset-b")).toStrictEqual([]);
    expect(remote.effects()).toBe(0);
    expect(values((await reopened.port.load()).replica)).toStrictEqual([
      ["replacement-seed", 700, 1],
    ]);
  });
});
