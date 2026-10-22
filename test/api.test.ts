import { expect, test } from "vitest";

import { syncApi } from "../src/api.ts";
import { literal, string } from "../src/schema.ts";
import { PUSH_MAX } from "../src/sync.ts";
import { api, command, outcome, row, serverSchema } from "./sync-fixture.ts";

const pull = { client: "page_0001", dataset: null, since: 0 };
const receipt = { id: 1, outcome: { kind: "ok", resource: "a" }, revision: 1 };

const reply = {
  dataset: "d",
  revision: 1,
  reset: true,
  history: [],
  settings: [],
  commands: [receipt],
  server: { version: "v1" },
};

const push = { ...pull, commands: [{ id: 1, command: { name: "put", id: "a", value: 2 } }] };

const telemetry = {
  client: "page_0001",
  events: [
    {
      name: "page.painted",
      at: "2026-10-22T12:00:00.000Z",
      attributes: { ms: 1, nullable: null, bool: true, text: "a" },
    },
  ],
};

test("sync endpoints have the shared methods and paths", () => {
  expect([
    api.pull.method,
    api.pull.path,
    api.push.method,
    api.push.path,
    api.telemetry.method,
    api.telemetry.path,
    api.socket.path,
  ]).toStrictEqual([
    "GET",
    "/api/pull",
    "POST",
    "/api/push",
    "POST",
    "/api/telemetry",
    "/api/socket",
  ]);
  expect(api.pull.request.parse(pull)).toStrictEqual(pull);
  expect(api.push.request.parse(push)).toStrictEqual(push);
  expect(api.pull.response.parse(reply)).toStrictEqual(reply);
  expect(api.push.response.parse({ results: [receipt], revision: 1 })).toStrictEqual({
    results: [receipt],
    revision: 1,
  });
  expect(api.telemetry.request.parse(telemetry)).toStrictEqual(telemetry);
  expect(api.telemetry.response.parse({ ok: true })).toStrictEqual({ ok: true });
  expect(api.socket.message.parse({ type: "poke", revision: 1 })).toStrictEqual({
    type: "poke",
    revision: 1,
  });
});

test.each(["dataset", "revision", "reset", "commands", "server", "checksum", "page"])(
  "reserved row key %s is refused at construction",
  (key) => {
    expect(() => syncApi({ rows: { [key]: row }, server: serverSchema, command, outcome })).toThrow(
      Error
    );
  }
);

test.each(["short", "a".repeat(65), "illegal!", "abcdefgh\n", 123])(
  "client is strict and bounded: %j",
  (client) => {
    expect(() => api.pull.request.parse({ ...pull, client })).toThrow(Error);
    expect(() => api.push.request.parse({ ...push, client })).toThrow(Error);
    expect(() => api.telemetry.request.parse({ ...telemetry, client })).toThrow(Error);
  }
);

test("boundary client lengths, null dataset, cursor and command refs are admitted", () => {
  for (const client of ["A_-01234", "a".repeat(64)]) {
    expect(() =>
      api.pull.request.parse({
        ...pull,
        client,
        page: null,
        commands: [{ client, id: 1 }],
        verify: true,
      })
    ).not.toThrow(Error);
  }

  expect(() =>
    api.pull.request.parse({ ...pull, dataset: "d".repeat(200), page: "c".repeat(1000) })
  ).not.toThrow(Error);
});

test.each([
  { since: -1 },
  { since: 0.5 },
  { since: Number.MAX_SAFE_INTEGER + 1 },
  { since: "1" },
  { dataset: "" },
  { dataset: "a".repeat(201) },
  { page: "" },
  { page: "a".repeat(1001) },
  { verify: 1 },
  { commands: [{ client: "page_0001", id: 0 }] },
  { commands: [{ client: "page_0001", id: 1, extra: true }] },
  { commands: Array.from({ length: PUSH_MAX + 1 }, () => ({ client: "page_0001", id: 1 })) },
  { extra: true },
])("pull refuses %j without coercion", (changed) => {
  expect(() => api.pull.request.parse({ ...pull, ...changed })).toThrow(Error);
});

test("push command count is bounded and command envelopes are strict", () => {
  expect(() =>
    api.push.request.parse({
      ...push,
      commands: Array.from({ length: PUSH_MAX }, () => push.commands[0]),
    })
  ).not.toThrow(Error);

  for (const commands of [
    Array.from({ length: PUSH_MAX + 1 }, () => push.commands[0]),
    [{ id: 0, command: push.commands[0]?.command }],
    [{ ...push.commands[0], extra: true }],
    [{ id: 1, command: { name: "put", id: "a", value: "2" } }],
  ]) {
    expect(() => api.push.request.parse({ ...push, commands })).toThrow(Error);
  }
});

test.each([
  { extra: true },
  { commands: [{ ...receipt, extra: true }] },
  { commands: [{ ...receipt, id: 0 }] },
  { commands: [{ ...receipt, client: "bad" }] },
  { checksum: "0".repeat(63) },
  { checksum: "z".repeat(64) },
  { server: { version: "v1", extra: true } },
  { history: [{ id: "a", value: 2, deleted: false, revision: 1, extra: true }] },
])("pull reply refuses %j", (changed) => {
  expect(() => api.pull.response.parse({ ...reply, ...changed })).toThrow(Error);
});

test("page metadata is strict and through obeys the configured schema", () => {
  const page = { from: null, next: null, held: 0, total: 0, through: null };
  expect(() => api.pull.response.parse({ ...reply, checksum: "a".repeat(64), page })).not.toThrow(
    Error
  );
  expect(() =>
    api.pull.response.parse({ ...reply, page: { ...page, through: "a".repeat(65) } })
  ).toThrow(Error);
  expect(() => api.pull.response.parse({ ...reply, page: { ...page, extra: 1 } })).toThrow(Error);

  const custom = syncApi({
    rows: { history: row },
    server: serverSchema,
    command,
    outcome,
    dataset: literal("mine"),
    through: string({ pattern: /^day-/ }),
  });

  const customReply = {
    dataset: "mine",
    revision: 1,
    reset: true,
    history: [],
    commands: [],
    server: { version: "v1" },
  };

  expect(() =>
    custom.pull.response.parse({ ...customReply, page: { ...page, through: "day-22" } })
  ).not.toThrow(Error);
  expect(() =>
    custom.pull.response.parse({ ...customReply, page: { ...page, through: "wrong" } })
  ).toThrow(Error);
  expect(() => custom.pull.request.parse({ ...pull, dataset: "other" })).toThrow(Error);
});

test.each(["", "Page.painted", "a_", "a".repeat(65), "a\n"])(
  "telemetry name %j is refused",
  (name) => {
    expect(() =>
      api.telemetry.request.parse({ ...telemetry, events: [{ name, at: "2026-10-22T12:00:00Z" }] })
    ).toThrow(Error);
  }
);

test("telemetry timestamps, scalars, event limit, envelopes and responses are checked", () => {
  expect(() =>
    api.telemetry.request.parse({
      ...telemetry,
      events: Array.from({ length: 100 }, () => telemetry.events[0]),
    })
  ).not.toThrow(Error);

  for (const events of [
    Array.from({ length: 101 }, () => telemetry.events[0]),
    [{ name: "ok", at: "2026-10-22" }],
    [{ name: "ok", at: "not-a-date" }],
    [{ ...telemetry.events[0], extra: 1 }],
    [{ ...telemetry.events[0], attributes: { nested: {} } }],
    [{ ...telemetry.events[0], attributes: { array: [] } }],
  ]) {
    expect(() => api.telemetry.request.parse({ ...telemetry, events })).toThrow(Error);
  }

  expect(() => api.telemetry.request.parse({ ...telemetry, extra: true })).toThrow(Error);
  expect(() => api.telemetry.response.parse({ ok: true, extra: true })).toThrow(Error);
  expect(() => api.push.response.parse({ results: [receipt], revision: 1, extra: true })).toThrow(
    Error
  );
  expect(() => api.socket.message.parse({ type: "poke", revision: 1, extra: true })).toThrow(Error);
  expect(() => api.socket.message.parse({ type: "poke", revision: -1 })).toThrow(Error);
});

test("server schema is exposed unchanged and pending is the strict durable outbox union", () => {
  expect(api.server).toBe(serverSchema);

  const base = {
    client: "page_0001",
    id: 1,
    dataset: null,
    command: { name: "put", id: "a", value: 2 },
    at: 0,
  };

  for (const state of [
    { kind: "saving" },
    { kind: "queued" },
    { kind: "sending" },
    { kind: "unknown", failure: "lost", parked: true },
    { kind: "done", outcome: receipt.outcome, revision: 1 },
  ]) {
    expect(api.pending.parse({ ...base, state })).toStrictEqual({ ...base, state });
    expect(() => api.pending.parse({ ...base, state: { ...state, extra: true } })).toThrow(Error);
  }

  expect(() =>
    api.pending.parse({ ...base, since: 0, state: { kind: "unknown", failure: "lost" } })
  ).not.toThrow(Error);

  for (const changed of [
    { extra: 1 },
    { id: 0 },
    { since: -1 },
    { client: "bad" },
    { at: "0" },
    { state: { kind: "unknown" } },
    { state: { kind: "unknown", failure: "lost", parked: false } },
    { state: { kind: "done", revision: 1 } },
  ]) {
    expect(() => api.pending.parse({ ...base, state: { kind: "queued" }, ...changed })).toThrow(
      Error
    );
  }
});
