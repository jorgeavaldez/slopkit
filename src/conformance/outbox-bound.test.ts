import { expect, test } from "vitest";

import { createClient } from "../client.ts";
import type { Pending } from "../sync.ts";
import * as syncApi from "../sync.ts";
import { createSync } from "../sync.ts";
import { database, deferred, pending, rowsLens } from "./fixtures.ts";
import type { Command, Network, Outcome, PatchRows, Server, Tables } from "./fixtures.ts";

function bounded(max = 3, joins = false) {
  return createSync<Tables, PatchRows, Server, Command, Outcome>({
    tables: [rowsLens],
    empty: { rows: new Map() },
    onlineOnly: () => false,
    refused: (_command, reason) => ({ kind: "failed", reason }),
    outboxMax: max,
    joins: (waiting, next) => joins && waiting.value === next.value,
  });
}

const offline: Network = {
  pull: async () => ({ ok: false, failure: { kind: "offline", message: "offline" } }),
  push: async () => {
    throw new Error("no offline intent may be sent");
  },
};

function client(stored: ReturnType<typeof database>, id: string, max = 3, joins = false) {
  const answers: Pending<Command, Outcome>[] = [];

  const runtime = createClient({
    sync: bounded(max, joins),
    client: id,
    ports: {
      storage: stored.port,
      network: offline,
      now: () => 0,
      fingerprint: async () => "",
      answered: (answer) => {
        answers.push(answer);
      },
    },
  });

  return { runtime, answers };
}

test("outbox has a shared default of 500 at the storage boundary", async () => {
  const stored = database();
  await stored.port.load();

  const results = await Promise.all(
    Array.from({ length: 501 }, (_, at) => stored.port.keep(pending("page", at + 1)))
  );

  expect(results.slice(0, 500)).toStrictEqual(Array.from({ length: 500 }, () => undefined));
  expect(results[500]).toStrictEqual({ kind: "full", waiting: 500, finished: 0, max: 500 });
  expect((await stored.port.load()).commands).toHaveLength(500);
  expect(syncApi.OUTBOX_MAX).toBe(500);
});

test("outboxMax must be a positive safe integer", () => {
  for (const max of [0, -1, 1.5, Number.NaN]) {
    expect(() => bounded(max)).toThrow(/outboxMax must be a positive integer/);
  }
});

test("keep admits and counts in one transaction, but always permits an existing key's outcome", async () => {
  const stored = database();
  await stored.port.load();
  const first = pending("page", 1);
  expect(await stored.port.keep(first, 1)).toBeUndefined();
  expect(await stored.port.keep(pending("page", 2), 1)).toStrictEqual({
    kind: "full",
    waiting: 1,
    finished: 0,
    max: 1,
  });
  expect(
    await stored.port.keep(
      { ...first, state: { kind: "done", outcome: { kind: "ok", resource: "r1" }, revision: 0 } },
      1
    )
  ).toBeUndefined();
  expect(await stored.port.keep(pending("page", 3), 1)).toStrictEqual({
    kind: "full",
    waiting: 0,
    finished: 1,
    max: 1,
  });
  expect((await stored.port.load()).commands).toHaveLength(1);
});

test("two offline clients share one transactional admission bound; every unadmitted tap is answered without a record", async () => {
  const a = database();
  const b = database({ factory: a.factory, name: a.name });

  const ca = client(a, "tab-a");
  const cb = client(b, "tab-b");

  ca.runtime.start();
  cb.runtime.start();
  await Promise.all([ca.runtime.settle(), cb.runtime.settle()]);

  // Neither page has heard of the other's taps. All six keeps overlap before either page gets an acknowledgement.
  for (const value of [1, 2, 3]) {
    ca.runtime.command({ name: "put", value });
    cb.runtime.command({ name: "put", value: value + 10 });
  }

  await Promise.all([ca.runtime.settle(), cb.runtime.settle()]);
  const disk = await a.port.load();
  const models = [...ca.runtime.model().commands, ...cb.runtime.model().commands];
  const refused = [...ca.answers, ...cb.answers];
  expect(disk.commands).toHaveLength(3);
  expect(models).toHaveLength(3);
  expect(new Set(disk.commands.map((each) => `${each.client}:${each.id}`)).size).toBe(3);
  expect(
    models
      .map((each) => `${each.client}:${each.id}`)
      .toSorted((left, right) => left.localeCompare(right))
  ).toStrictEqual(
    disk.commands
      .map((each) => `${each.client}:${each.id}`)
      .toSorted((left, right) => left.localeCompare(right))
  );
  expect(refused).toHaveLength(3);

  for (const answer of refused) {
    expect(answer.state).toMatchObject({
      kind: "done",
      revision: 0,
      outcome: { kind: "failed" },
    });

    if (answer.state.kind !== "done" || answer.state.outcome.kind !== "failed") {
      throw new Error("not a refused tap");
    }

    expect(answer.state.outcome.reason).toMatch(/outbox.*full/i);
    expect(models).not.toContainEqual(answer);
    expect(
      disk.commands.some((each) => each.client === answer.client && each.id === answer.id)
    ).toBe(false);
  }

  expect(ca.runtime.model().storage.kind).toBe("ok");
  expect(cb.runtime.model().storage.kind).toBe("ok");
  expect([...ca.runtime.faults, ...cb.runtime.faults]).toStrictEqual([]);
  const denied = ca.answers.length > 0 ? ca : cb;
  expect(syncApi.deriveOutboxState(denied.runtime.model())).toStrictEqual({
    kind: "full",
    waiting: 3,
    finished: 0,
    max: 3,
  });
});

test("a full outbox leaves model and disk unchanged; joins coalesces before admission", async () => {
  const stored = database();
  const app = client(stored, "page", 1, true);
  app.runtime.start();
  await app.runtime.settle();
  app.runtime.command({ name: "put", value: 1 });
  await app.runtime.settle();
  const before = (await stored.port.load()).commands;
  app.runtime.command({ name: "put", value: 1 });
  await app.runtime.settle();
  expect(app.answers).toStrictEqual([]);
  app.runtime.command({ name: "put", value: 2 });
  await app.runtime.settle();
  expect(app.runtime.model().commands).toHaveLength(1);
  expect((await stored.port.load()).commands).toStrictEqual(before);
  expect(app.answers).toHaveLength(1);
  expect(app.runtime.model().storage.kind).toBe("ok");
});

test("a late load plus concurrent keeps obeys the disk count, not the page's pre-load count", async () => {
  const stored = database();
  const old = client(stored, "old");
  old.runtime.start();
  await old.runtime.settle();

  for (const value of [1, 2, 3]) {
    old.runtime.command({ name: "put", value });
  }

  await old.runtime.settle();
  const loaded = deferred<Awaited<ReturnType<typeof stored.port.load>>>();
  const answers: Pending<Command, Outcome>[] = [];

  const late = createClient({
    sync: bounded(),
    client: "late",
    ports: {
      storage: { ...stored.port, load: () => loaded.promise },
      network: offline,
      now: () => 3001,
      fingerprint: async () => "",
      answered: (answer) => {
        answers.push(answer);
      },
    },
  });

  late.start();
  late.dispatch({ type: "tick", now: 6002 });
  late.command({ name: "put", value: 4 });
  loaded.resolve(await stored.port.load());
  await late.settle();
  expect((await stored.port.load()).commands.map((each) => each.command.value)).toStrictEqual([
    1, 2, 3,
  ]);
  expect(late.model().commands.map((each) => each.command.value)).toStrictEqual([1, 2, 3]);
  expect(answers).toHaveLength(1);
});

test("grandfathered records are never dropped; outcomes update at capacity and dismissal permits a new admission", async () => {
  const stored = database();
  const old = client(stored, "old", 4);
  old.runtime.start();
  await old.runtime.settle();

  for (const value of [1, 2, 3, 4]) {
    old.runtime.command({ name: "put", value });
  }

  await old.runtime.settle();
  const reopened = database({ factory: stored.factory, name: stored.name });
  const app = client(reopened, "new", 3);
  app.runtime.start();
  await app.runtime.settle();
  // A late receipt is an update of an existing key, even when the current bound is below the existing count.
  app.runtime.dispatch({
    type: "pushed",
    client: "old",
    ids: [1],
    revision: 0,
    receipts: [{ id: 1, outcome: { kind: "ok", resource: "r1" }, revision: 0 }],
    now: 0,
  });
  await app.runtime.settle();
  expect((await stored.port.load()).commands).toHaveLength(4);
  expect((await stored.port.load()).commands[0]?.state).toStrictEqual({
    kind: "done",
    outcome: { kind: "ok", resource: "r1" },
    revision: 0,
  });
  app.runtime.command({ name: "put", value: 5 });
  await app.runtime.settle();
  expect((await stored.port.load()).commands).toHaveLength(4);
  expect(syncApi.deriveOutboxState(app.runtime.model())).toStrictEqual({
    kind: "full",
    waiting: 3,
    finished: 1,
    max: 3,
  });
  // The count must be below max, not merely equal to max.
  app.runtime.dispatch({ type: "dismiss", client: "old", id: 1, now: 0 });
  await app.runtime.settle();
  app.runtime.command({ name: "put", value: 6 });
  await app.runtime.settle();
  expect((await stored.port.load()).commands).toHaveLength(3);
  app.runtime.dispatch({
    type: "pushed",
    client: "old",
    ids: [2],
    revision: 0,
    receipts: [{ id: 2, outcome: { kind: "ok", resource: "r2" }, revision: 0 }],
    now: 0,
  });
  await app.runtime.settle();
  app.runtime.dispatch({ type: "dismiss", client: "old", id: 2, now: 0 });
  await app.runtime.settle();
  app.runtime.command({ name: "put", value: 7 });
  await app.runtime.settle();
  expect(
    (await stored.port.load()).commands.map((each) => each.command.value).toSorted((a, b) => a - b)
  ).toStrictEqual([3, 4, 7]);
  expect(app.runtime.faults).toStrictEqual([]);
});

test("the outbox subject distinguishes waiting work from finished work needing dismissal", async () => {
  const stored = database();
  const app = client(stored, "page", 1);
  app.runtime.start();
  await app.runtime.settle();
  expect(syncApi.deriveOutboxState(app.runtime.model())).toStrictEqual({ kind: "ok" });
  app.runtime.command({ name: "put", value: 1 });
  await app.runtime.settle();
  expect(syncApi.deriveOutboxState(app.runtime.model())).toStrictEqual({
    kind: "full",
    waiting: 1,
    finished: 0,
    max: 1,
  });
  app.runtime.dispatch({
    type: "pushed",
    client: "page",
    ids: [1],
    revision: 0,
    receipts: [{ id: 1, outcome: { kind: "ok", resource: "r1" }, revision: 0 }],
    now: 0,
  });
  await app.runtime.settle();
  expect(syncApi.deriveOutboxState(app.runtime.model())).toStrictEqual({
    kind: "full",
    waiting: 0,
    finished: 1,
    max: 1,
  });
  app.runtime.dispatch({ type: "dismiss", client: "page", id: 1, now: 0 });
  await app.runtime.settle();
  expect(syncApi.deriveOutboxState(app.runtime.model())).toStrictEqual({ kind: "ok" });
});
