/** Contract: owed work is under way exactly when the engine has it in flight or would start it now (a tick at `now`). */
import { expect, test } from "vitest";

import { pullUnderWay, pushUnderWay, settled, SOCKET_DEADLINE_MS, underWay } from "../src/sync.ts";
import type { Model, Msg } from "../src/sync.ts";
import { empty, engine } from "./sync-fixture.ts";
import type { Command, Outcome, Patch, Tables } from "./sync-fixture.ts";

type M = Model<Tables, { version: string }, Command, Outcome>;

type Message = Msg<Tables, Patch, { version: string }, Command, Outcome>;

const start = Date.parse("2026-10-22T16:00:00Z");
const CLIENT = "page_0001";
const put = (id: string): Command => ({ name: "put", id, value: 1 });

function never(): never {
  throw new Error("the journey lost its command");
}

/** Every model a journey reaches, from its first message on. */
function journey(messages: ((model: M) => Message)[]): M[] {
  // The session's self-check already done, so a pull is owed only by what the journey does.
  let model: M = { ...engine.initial(CLIENT, start), verify: { kind: "done", match: true } };
  const reached: M[] = [];

  for (const message of messages) {
    [model] = engine.update(model, message(model));
    reached.push(model);
  }

  return reached;
}

const loaded = (): Message => ({
  type: "loaded",
  replica: { dataset: "d", revision: 5, tables: empty, server: null },
  commands: [],
  unreadable: 0,
  now: start,
});

const pulled = (since: number, revision: number, now: number): Message => ({
  type: "pulled",
  since,
  patch: {
    dataset: "d",
    revision,
    reset: false,
    rows: { history: [], settings: [] },
    server: { version: "v1" },
  },
  receipts: [],
  now,
});

const offline = (now: number): Message => ({
  type: "pullFailed",
  failure: { kind: "offline", message: "network" },
  now,
});

const pullAt = (model: M): Message => ({
  type: "tick",
  now: model.pull.kind === "idle" ? Math.max(model.now, model.pull.nextAt) : model.now,
});

/** The pull in flight answered (`revision`), or failed offline; with none in flight, a moment passes. */
const answer =
  (revision: number | "offline") =>
  (model: M): Message =>
    model.pull.kind === "pulling"
      ? revision === "offline"
        ? offline(model.now + 1)
        : pulled(model.pull.since, revision, model.now + 1)
      : { type: "tick", now: model.now + 10 };

/**
 * A note tapped offline; the link back and the note sent; a 503 (the push may have acted) and its backoff, the link
 * back meanwhile; the retry answered; the link gone before the pull that brings its effects, then that pull; live
 * again, with nothing owed.
 */
const reached = journey([
  loaded,
  answer("offline"),
  () => ({ type: "command", command: put("a"), now: start + 20 }),
  (model) => ({ type: "kept", client: CLIENT, id: 1, now: model.now + 10 }),
  (model) => ({ type: "socket", open: true, now: model.now + 10 }),
  pullAt,
  answer(5),
  (model) => ({
    type: "pushFailed",
    client: CLIENT,
    ids: model.push.kind === "pushing" ? [...model.push.ids] : [],
    failure: { kind: "unavailable", message: "503" },
    now: model.now + 10,
  }),
  answer(5),
  pullAt,
  answer(5),
  (model) => ({ type: "tick", now: model.push.kind === "idle" ? model.push.nextAt : model.now }),
  (model) => ({
    type: "pushed",
    client: CLIENT,
    ids: model.push.kind === "pushing" ? [...model.push.ids] : [],
    receipts: [{ id: 1, outcome: { kind: "ok", resource: "a" }, revision: 7 }],
    revision: 7,
    now: model.now + 10,
  }),
  (model) => ({ type: "socket", open: false, now: model.now + 10 }),
  answer("offline"),
  pullAt,
  answer(7),
  // Live again with nothing owed: the socket's pokes stand in for polling until it goes quiet.
  (model) => ({ type: "socket", open: true, now: model.now + 10 }),
  (model) => ({ type: "heard", revision: 7, now: model.now + 10 }),
  answer(7),
]);

/** What the engine does at `now`: a tick, then everything due starts. */
function starts(model: M, now: number) {
  const [, effects] = engine.update(model, { type: "tick", now });

  return {
    pull: model.pull.kind === "pulling" || effects.some((each) => each.kind === "pull"),
    push: model.push.kind === "pushing" || effects.some((each) => each.kind === "push"),
  };
}

/** The instants worth asking at: now, just before and at each retry, and well past the socket's deadline. */
function instants(model: M): number[] {
  const at = [model.now, model.now + SOCKET_DEADLINE_MS + 1];

  for (const each of [model.pull, model.push]) {
    if (each.kind === "idle" && each.nextAt > model.now) {
      at.push(each.nextAt - 1, each.nextAt);
    }
  }

  return at;
}

test("pull and push are under way exactly when the engine has one in flight or starts one now", () => {
  const told: { at: number; pull: boolean; push?: boolean }[] = [];
  const done: typeof told = [];

  for (const model of reached) {
    // A push only starts with something to send; with nothing waiting it is under way only in flight.
    const sends =
      model.push.kind === "pushing" ||
      model.commands.some((each) => each.state.kind === "queued" || each.state.kind === "unknown");

    for (const now of instants(model)) {
      const engineDoes = starts(model, now);
      const at = now - start;
      told.push({
        at,
        pull: pullUnderWay(model, now),
        ...(sends ? { push: pushUnderWay(model, now) } : {}),
      });
      done.push({ at, pull: engineDoes.pull, ...(sends ? { push: engineDoes.push } : {}) });
    }
  }

  expect(told.length).toBeGreaterThan(20);
  expect(told).toStrictEqual(done);
});

test("a command's work is under way exactly when the push or pull that settles it is", () => {
  const told: { at: number; kind: string; underWay: boolean }[] = [];
  const done: typeof told = [];

  for (const model of reached) {
    for (const now of instants(model)) {
      const engineDoes = starts(model, now);

      for (const each of model.commands) {
        const owed = { command: { client: each.client, id: each.id } };
        const { kind } = each.state;
        const sendable = kind === "queued" || (kind === "unknown" && each.state.parked !== true);
        const inHand = kind === "saving" || kind === "sending";
        const awaited = sendable ? engineDoes.push : engineDoes.pull;
        const at = now - start;
        told.push({ at, kind, underWay: underWay(model, owed, now) });
        done.push({ at, kind, underWay: !settled(model, each) && (inHand || awaited) });
      }
    }
  }

  expect(told.length).toBeGreaterThan(20);
  expect(told).toStrictEqual(done);
});

const stateOf = (model: M) => model.commands[0]?.state.kind;

test("the three states an app must place apart: tapped offline, after a 503, answered with the link gone", () => {
  const command = { command: { client: CLIENT, id: 1 } };

  const queuedOffline = reached.find(
    (model) => model.connection.kind === "offline" && stateOf(model) === "queued"
  );

  // Back online during the push's backoff: it waits for the retry.
  const backingOff = reached.find(
    (model) =>
      model.connection.kind === "live" &&
      model.push.kind === "idle" &&
      model.push.nextAt > model.now &&
      stateOf(model) === "unknown"
  );

  const answeredOffline = reached.find(
    (model) =>
      model.connection.kind === "offline" &&
      model.pull.kind === "idle" &&
      stateOf(model) === "done" &&
      !settled(model, model.commands[0] ?? never())
  );

  const found = { queuedOffline, backingOff, answeredOffline };

  expect(
    Object.fromEntries(
      Object.entries(found).map(([name, model]) => [
        name,
        model === undefined ? "not reached" : underWay(model, command, model.now),
      ])
    )
  ).toStrictEqual({ queuedOffline: false, backingOff: false, answeredOffline: false });

  const retry = backingOff?.push.kind === "idle" ? backingOff.push.nextAt : 0;
  expect(backingOff && underWay(backingOff, command, retry)).toBe(true);

  // Settled once the pull carried its revision: nothing is owed for it any more.
  const last = reached.at(-1);
  expect(last && settled(last, last.commands[0] ?? never())).toBe(true);
  expect(last && underWay(last, command, last.now)).toBe(false);
});

test("a command the page doesn't hold is never under way", () => {
  const model = reached[4];
  expect(model && underWay(model, { command: { client: "other", id: 9 } }, model.now)).toBe(false);
});
