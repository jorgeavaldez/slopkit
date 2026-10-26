import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { SQLOutputValue } from "node:sqlite";

import { expect, test } from "vitest";
import type { RawData } from "ws";
import { WebSocket } from "ws";

import type { KitOutcome as ApiKitOutcome } from "../src/api.ts";
import { syncApi } from "../src/api.ts";
import { call, encodeUrl } from "../src/contract.ts";
import type { Schema } from "../src/schema.ts";
import { array, literal, number, object, string, variant } from "../src/schema.ts";
import type { KitOutcome as ServerKitOutcome } from "../src/server/sync.ts";
import { KIT_ANSWERS, pokes, serveSync, syncHandlers, syncRoutes } from "../src/server/sync.ts";
import type { Caller } from "../src/server/web.ts";
import { api, AGENT, CLIENT, fixture, PERSON, row, command, serverSchema } from "./sync-fixture.ts";

const scopeOf = (identities: readonly string[]) =>
  createHash("sha256").update(identities.toSorted().join("\n")).digest("base64url").slice(0, 22);

function nextMessage(socket: WebSocket) {
  return new Promise<ReturnType<typeof api.socket.message.parse>>((resolve) => {
    socket.once("message", (data: RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString();

      resolve(api.socket.message.parse(JSON.parse(text)));
    });
  });
}

const put = (id: string, value = 1, name: "put" | "person" | "remote" | "fail" = "put") => ({
  name,
  id,
  value,
});

const ask = (dataset: string | null, since = 0, commands = [{ id: 1, command: put("a") }]) => ({
  client: CLIENT,
  dataset,
  since,
  commands,
});

const pull = (dataset: string | null, since = 0) => ({ client: CLIENT, dataset, since });

test("real routes reject absent identity and malformed input before any command acts", async () => {
  const f = await fixture();

  try {
    expect((await fetch(new URL(encodeUrl(api.pull, pull(null)), f.server.url))).status).toBe(401);

    const response = await f.request("/api/push", {
      ...ask(f.store.dataset()),
      commands: [
        { id: 1, command: put("a") },
        { id: 2, command: { name: "put", value: "bad" } },
      ],
    });

    expect(response.status).toBe(400);
    expect(f.actions).toStrictEqual([]);
    expect(structuredClone(f.store.db.prepare("select * from commands").all())).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test("dataset and unknown history refusals are per-command conflicts and run none", async () => {
  const f = await fixture();

  try {
    const commands = [
      { id: 1, command: put("a") },
      { id: 2, command: put("b") },
    ];

    const replaced = await f.sync.push(ask("other", 0, commands), AGENT);
    expect(replaced.results).toStrictEqual(
      commands.map((c) => ({
        id: c.id,
        outcome: {
          kind: "failed",
          reason: "conflict",
          message: "the server's data was replaced since this was tapped; tap again",
        },
        revision: 1,
      }))
    );
    f.store.transaction(() => f.store.stamp());
    const unknown = await f.sync.push(ask(f.store.dataset(), 2, commands), AGENT);
    expect(unknown.results.map((r: { outcome: unknown }) => r.outcome)).toStrictEqual(
      commands.map(() => ({
        kind: "failed",
        reason: "conflict",
        message: "this page's copy is from another history of the server's data; it starts over",
      }))
    );
    expect(f.actions).toStrictEqual([]);
    expect(structuredClone(f.store.db.prepare("select * from commands").all())).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test("authorization precedes ledger claim and replay; permitted caller may later use an unclaimed key", async () => {
  const f = await fixture();

  try {
    const request = ask(f.store.dataset(), 0, [{ id: 1, command: put("secret", 2, "person") }]);
    const denied = await f.sync.push(request, AGENT);
    expect(denied.results).toStrictEqual([
      {
        id: 1,
        outcome: {
          kind: "failed",
          reason: "forbidden",
          message: "only a person's login can person",
        },
        revision: 1,
      },
    ]);
    expect(structuredClone(f.store.db.prepare("select * from commands").all())).toStrictEqual([]);
    const cookie = await f.login();
    expect(cookie).toMatch(/^notes_session=./);

    const sent = await call(api.push, request, {
      base: f.server.url,
      headers: { cookie, origin: f.server.url },
    });

    expect(sent.ok).toBe(true);
    const replay = await f.sync.push(request, { ...AGENT, identities: ["sub:someone"] });
    expect(replay.results[0]?.outcome).toStrictEqual({
      kind: "failed",
      reason: "forbidden",
      message: "only a person's login can person",
    });
    expect(f.actions).toStrictEqual(["secret"]);
  } finally {
    await f.close();
  }
});

test("ordered local and external commands use durable keys and replay the original revision", async () => {
  const f = await fixture();

  try {
    const dataset = f.store.dataset();

    const commands = [
      { id: 1, command: put("a") },
      { id: 2, command: put("b", 2, "remote") },
      { id: 3, command: put("c", 3, "fail") },
    ];

    const first = await f.sync.push(ask(dataset, 0, commands), AGENT);
    expect(f.actions).toStrictEqual(["a", "b", "c"]);
    expect(first.results.map((r: { outcome: unknown }) => r.outcome)).toStrictEqual([
      { kind: "ok", resource: "a" },
      { kind: "ok", resource: "b" },
      { kind: "failed", reason: "fixture", message: "fixture refused" },
    ]);

    const kept = f.store.db
      .prepare("select principal,client,id,args,revision from commands order by id")
      .all();

    expect(
      kept.map((r: Record<string, SQLOutputValue>) => ({
        ...r,
        revision: undefined,
      }))
    ).toStrictEqual(
      commands.map((c) => ({
        principal: "key:fixture",
        client: CLIENT,
        id: c.id,
        args: JSON.stringify(c.command),
        revision: undefined,
      }))
    );
    expect(first.results.map((r: { revision: number }) => r.revision)).toStrictEqual(
      kept.map((r: Record<string, SQLOutputValue>) => r.revision)
    );
    f.store.put("later", 8);
    const replay = await f.sync.push(ask(dataset, 0, commands), AGENT);
    expect(replay.results).toStrictEqual(first.results);
    expect(f.actions).toStrictEqual(["a", "b", "c"]);
    expect(
      f.lines.filter((l) => l.body.startsWith("command ")).map((l) => [l.severity, l.body])
    ).toStrictEqual([
      ["info", "command put ok"],
      ["info", "command remote ok"],
      ["warn", "command fail failed"],
    ]);
    expect(f.pushed[0]?.map((r) => r.fresh)).toStrictEqual([true, true, true]);
    expect(f.pushed[1]?.map((r) => r.fresh)).toStrictEqual([false, false, false]);

    const changed = await f.sync.push(
      ask(dataset, 0, [{ id: 1, command: put("different") }]),
      AGENT
    );

    expect(changed.results[0]?.outcome).toStrictEqual({
      kind: "failed",
      reason: "conflict",
      message: "command 1 was already used for another command",
    });
  } finally {
    await f.close();
  }
});

test("principal is person for all people, sorted identities joined by space otherwise, service when empty", async () => {
  const f = await fixture();

  try {
    const request = ask(f.store.dataset());
    await f.sync.push(request, PERSON);
    await f.sync.push(request, { ...PERSON, identities: ["sub:another"] });
    await f.sync.push(request, { ...AGENT, identities: ["z", "a"] });
    await f.sync.push(request, { ...AGENT, identities: ["a", "z"] });
    await f.sync.push(request, { ...AGENT, identities: [] });
    expect(
      structuredClone(f.store.db.prepare("select principal from commands order by principal").all())
    ).toStrictEqual([{ principal: "a z" }, { principal: "person" }, { principal: "service" }]);
    expect(f.actions).toStrictEqual(["a", "a", "a"]);
  } finally {
    await f.close();
  }
});

test("retired replies never act; accepted elsewhere is omitted rather than made a final refusal", async () => {
  const f = await fixture();

  try {
    const dataset = f.store.dataset();
    await f.sync.push(ask(dataset), AGENT);
    f.store.db.exec("update commands set created_at='2000-01-01T00:00:00.000Z'");
    f.store.retain({ receiptsMs: 1 });
    const retired = await f.sync.push(ask(dataset), AGENT);
    expect(retired.results[0]?.outcome).toStrictEqual({ kind: "retired" });
    expect(f.actions).toStrictEqual(["a"]);
    f.store.db
      .prepare(
        "insert into commands(principal,client,id,name,args,state,created_at) values (?,?,?,?,?,'accepted',?)"
      )
      .run(
        "key:fixture",
        CLIENT,
        2,
        "remote",
        JSON.stringify(put("other", 2, "remote")),
        new Date().toISOString()
      );

    const waiting = await f.sync.push(
      ask(dataset, 0, [{ id: 2, command: put("other", 2, "remote") }]),
      AGENT
    );

    expect(waiting.results).toStrictEqual([]);
    expect(f.actions).toStrictEqual(["a"]);
  } finally {
    await f.close();
  }
});

test("each response is served before it escapes; changed notifies after durable push", async () => {
  const f = await fixture();

  try {
    const evidence: unknown[] = [];

    const unsubscribe = f.sync.subscribe(() => {
      evidence.push(JSON.parse(readFileSync(`${f.store.path}.head`, "utf-8")));
    });

    const sent = await f.sync.push(ask(f.store.dataset()), AGENT);
    expect(evidence).toStrictEqual([{ dataset: f.store.dataset(), revision: sent.revision }]);
    const pulled = await f.sync.pull(pull(f.store.dataset()), AGENT);
    expect(JSON.parse(readFileSync(`${f.store.path}.head`, "utf-8"))).toStrictEqual({
      dataset: pulled.dataset,
      revision: pulled.revision,
    });
    unsubscribe();
    f.sync.changed();
    expect(evidence).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("only a person's future pull proves rollback and changes the dataset", async () => {
  const f = await fixture();

  try {
    const old = f.store.dataset();
    await f.sync.pull(pull(old, 100), AGENT);
    expect(f.store.dataset()).toBe(old);
    const reply = await f.sync.pull(pull(old, 100), PERSON);
    expect(reply.dataset).not.toBe(old);
    expect(reply.reset).toBe(true);
    expect(f.store.restored).toStrictEqual({ dataset: old, served: 100, revision: 1 });
    expect(
      f.lines.some((l) => l.severity === "warn" && l.body.toLowerCase().includes("restor"))
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("legacy pull is whole; paged pull carries named old receipts with their rows and scopes them to principal", async () => {
  const f = await fixture();

  try {
    const dataset = f.store.dataset();
    await f.sync.push(ask(dataset), AGENT);

    for (const [id, value] of [
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ] as const) {
      f.store.put(id, value);
    }

    f.store.put("setting", 1, "settings");
    const whole = await f.sync.pull(pull(null), AGENT);
    expect(whole.page).toBeUndefined();
    expect(whole.history.map((r: { id: string }) => r.id).toSorted()).toStrictEqual([
      "a",
      "b",
      "c",
      "d",
    ]);

    const paged = await f.sync.pull(
      { ...pull(null), page: null, commands: [{ client: CLIENT, id: 1 }] },
      AGENT
    );

    expect(paged.history.map((r: { id: string }) => r.id).toSorted()).toStrictEqual([
      "a",
      "c",
      "d",
    ]);
    expect(paged.settings.map((r: { id: string }) => r.id)).toStrictEqual(["setting"]);
    expect(paged.commands).toHaveLength(1);
    expect(paged.commands[0]?.client).toBeUndefined();

    const another = await f.sync.pull(
      {
        ...pull(dataset, f.store.revision()),
        client: "page_0002",
        page: null,
        commands: [{ client: CLIENT, id: 1 }],
      },
      AGENT
    );

    expect(another.commands[0]).toMatchObject({
      client: CLIENT,
      id: 1,
      outcome: { kind: "ok", resource: "a" },
    });

    const forbidden = await f.sync.pull(
      { ...pull(dataset), page: null, commands: [{ client: CLIENT, id: 1 }] },
      PERSON
    );

    expect(forbidden.commands).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test("verify checksum is the independent canonical SHA256 of live rows in API row order, only on complete replies", async () => {
  const f = await fixture();

  try {
    // SHA256('[[],[]]'), hand-computed independently of slopkit/digest.
    const emptyHash = "643d5437104296e21d906ecb15b2c96ad278f20cfc4af53b12bb6069bd853726";
    const ordinary = await f.sync.pull(pull(null), AGENT);
    expect(ordinary.checksum).toBeUndefined();
    const checked = await f.sync.pull({ ...pull(null), verify: true }, AGENT);
    expect(checked.checksum).toBe(emptyHash);

    for (const [id, value] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const) {
      f.store.put(id, value);
    }

    const partial = await f.sync.pull({ ...pull(null), page: null, verify: true }, AGENT);
    expect(partial.checksum).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("telemetry authority is the authenticated caller, not attributes supplied by the page", async () => {
  const f = await fixture();

  try {
    const input = {
      client: CLIENT,
      events: [
        {
          name: "fixture.event",
          at: "2026-10-22T12:00:00Z",
          attributes: { client: "forged", at: "forged", person: true, extra: 7 },
        },
      ],
    };

    const response = await f.request("/api/telemetry", input);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
    expect(f.lines.find((l) => l.body === "fixture.event")).toStrictEqual({
      severity: "info",
      body: "fixture.event",
      attributes: { client: CLIENT, at: "2026-10-22T12:00:00Z", person: false, extra: 7 },
    });
    const cookie = await f.login();

    const person = await call(
      api.telemetry,
      {
        ...input,
        events: [
          { name: "person.event", at: "2026-10-22T12:00:00Z", attributes: { person: false } },
        ],
      },
      { base: f.server.url, headers: { cookie, origin: f.server.url } }
    );

    expect(person.ok).toBe(true);
    expect(f.lines.find((l) => l.body === "person.event")?.attributes?.person).toBe(true);
  } finally {
    await f.close();
  }
});

test("real socket opens with current revision and gathers changes into the revision at send", async () => {
  const f = await fixture();

  const socket = new WebSocket(`${f.server.url.replace("http:", "ws:")}${api.socket.path}`, {
    headers: f.headers,
  });

  try {
    const first = await nextMessage(socket);
    expect(first).toStrictEqual({ type: "poke", revision: 1 });
    const next = nextMessage(socket);
    f.store.put("a", 1);
    f.sync.changed();
    f.store.put("b", 2);
    f.sync.changed();
    const nextPoke = await next;
    expect(nextPoke).toStrictEqual({
      type: "poke",
      revision: f.store.revision(),
    });
  } finally {
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await f.close();
  }
});

test("poke beat carries current revision and closing unsubscribes", async () => {
  let revision = 1;
  let listener: (() => void) | undefined;
  let removed = 0;

  const channel = pokes(api, {
    revision: () => revision,
    subscribe: (next: () => void) => {
      listener = next;

      return () => {
        removed++;
        listener = undefined;
      };
    },
    beatMs: 1,
    gatherMs: 50,
  });

  const messages: unknown[] = [];
  let resolve: (() => void) | undefined;

  const beat = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });

  const close = channel.open((message) => {
    messages.push(message);

    if (messages.length === 2) {
      resolve?.();
    }
  }, AGENT);

  expect(messages).toStrictEqual([{ type: "poke", revision: 1 }]);
  revision = 9;
  await beat;
  expect(messages).toStrictEqual([
    { type: "poke", revision: 1 },
    { type: "poke", revision: 9 },
  ]);
  listener?.();
  close();
  expect(removed).toBe(1);
  expect(listener).toBeUndefined();
});

test("serveSync validates name before serving, and builds the install manifest", async () => {
  const f = await fixture();

  try {
    const response = await f.request("/manifest.webmanifest");
    expect(response.status).toBe(200);

    const manifest = object({
      name: string(),
      short_name: string(),
      theme_color: string(),
      background_color: string(),
      icons: array(object({ src: string() })),
    }).parse(await response.json());

    expect(manifest.icons.some((icon) => icon.src === "/icon.svg")).toBe(true);
    expect(manifest).toMatchObject({
      name: "notes",
      short_name: "notes",
      theme_color: "#000000",
      background_color: "#000000",
    });

    for (const name of ["", "Upper", "a_", "a".repeat(33), "0starts"]) {
      await expect(
        serveSync({
          name,
          api,
          home: f.home,
          config: f.config,
          env: {},
          log: () => {},
          page: () => {},
          assets: f.home,
          sync: f.sync,
        })
      ).rejects.toThrow(Error);
    }
  } finally {
    await f.close();
  }
});

test("custom principal cannot make a replay bypass current authorization", async () => {
  const f = await fixture();

  try {
    const sync = syncHandlers({ ...f.handlerOptions, principal: () => "shared" });
    const request = ask(f.store.dataset(), 0, [{ id: 1, command: put("a", 1, "person") }]);
    await sync.push(request, PERSON);
    const denied = await sync.push(request, AGENT);
    expect(denied.results[0]?.outcome).toStrictEqual({
      kind: "failed",
      reason: "forbidden",
      message: "only a person's login can person",
    });
    expect(f.actions).toStrictEqual(["a"]);
  } finally {
    await f.close();
  }
});

test("outcome mapping hides kept-only fields in both push and pull", async () => {
  const f = await fixture();

  try {
    type Kept = { kind: "saved"; id: string; privateNote: string };

    const ledger = f.store.createLedger<Kept>({
      encode: JSON.stringify,
      decode: (text: string) =>
        object({ kind: literal("saved"), id: string(), privateNote: string() }).parse(
          JSON.parse(text)
        ),
    });

    const sync = syncHandlers({
      ...f.handlerOptions,
      ledger,
      act: (c: { id: string; value: number }) => ({
        local: (): Kept => {
          f.store.put(c.id, c.value);

          return { kind: "saved", id: c.id, privateNote: "server only" };
        },
      }),
      names: (kept: Kept) => [kept.id],
      outcome: (kept: Kept) => ({ kind: "ok" as const, resource: kept.id }),
      pushed: () => {},
    });

    const pushed = await sync.push(ask(f.store.dataset()), AGENT);
    expect(pushed.results[0]?.outcome).toStrictEqual({ kind: "ok", resource: "a" });
    const pulled = await sync.pull(pull(f.store.dataset()), AGENT);
    expect(pulled.commands[0]?.outcome).toStrictEqual({ kind: "ok", resource: "a" });
    expect(JSON.stringify({ pushed, pulled })).not.toContain("server only");
  } finally {
    await f.close();
  }
});

// Compile-time contract checks do not execute an invalid endpoint.
test("routes require the API to admit every kit-managed outcome", async () => {
  const f = await fixture();

  try {
    const incompatible = () => {
      const narrow = syncApi({
        rows: { history: row, settings: row },
        command,
        server: serverSchema,
        outcome: object({ kind: literal("ok") }),
      });

      const onlyOk = syncHandlers({
        ...f.handlerOptions,
        api: narrow,
        outcome: () => ({ kind: "ok" as const }),
      });

      // @ts-expect-error An API with only ok cannot encode kit conflict/forbidden/retired answers.
      syncRoutes(narrow, { ...onlyOk, page: () => {} });
      // @ts-expect-error serveSync enforces the same outcome compatibility as syncRoutes.
      void serveSync({
        name: "notes",
        api: narrow,
        home: f.home,
        config: f.config,
        env: {},
        log: () => {},
        page: () => {},
        assets: f.home,
        sync: onlyOk,
      });
    };

    expect(incompatible).toBeDefined();
    expect(
      syncRoutes(api, { ...f.sync, page: () => {} }).map((r: { path: string }) => r.path)
    ).toStrictEqual(["/api/pull", "/api/push", "/api/telemetry"]);
  } finally {
    await f.close();
  }
});

test("manifest fields override individually and extra raw routes share the server's authentication", async () => {
  const { rawRoute } = await import("../src/server/web.ts");

  const f = await fixture({
    manifest: { name: "Custom notes", theme_color: "#111111" },
    routes: [
      rawRoute({
        method: "GET",
        path: "/api/extra",
        handle: () => ({ status: 200, type: "text/plain", body: "extra" }),
      }),
    ],
  });

  try {
    const manifest = await f.request("/manifest.webmanifest");
    expect(await manifest.json()).toMatchObject({
      name: "Custom notes",
      short_name: "notes",
      theme_color: "#111111",
      background_color: "#000000",
    });
    const extra = await f.request("/api/extra");
    expect(extra.status).toBe(200);
    expect(await extra.text()).toBe("extra");
    expect((await fetch(new URL("/api/extra", f.server.url))).status).toBe(401);
  } finally {
    await f.close();
  }
});

test("a later person-only refusal cannot turn a mixed push into a final HTTP refusal after its first effect", async () => {
  const f = await fixture();

  try {
    const sent = await call(
      api.push,
      ask(f.store.dataset(), 0, [
        { id: 1, command: put("a") },
        { id: 2, command: put("protected", 2, "person") },
      ]),
      { base: f.server.url, headers: f.headers }
    );

    expect(sent.ok).toBe(true);

    if (!sent.ok) {
      throw new Error("mixed push refused at request level");
    }

    expect(
      sent.value.results.map((r: { outcome: { kind: string } }) => r.outcome.kind)
    ).toStrictEqual(["ok", "failed"]);
    expect(f.actions).toStrictEqual(["a"]);
  } finally {
    await f.close();
  }
});

test("an external command's claim is visible from a second on-disk connection before its effect", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture();

  try {
    const sync = syncHandlers({
      ...f.handlerOptions,
      act: (c: { id: string; value: number }) => ({
        local: () => undefined,
        remote: async () => {
          expect(f.store.db.isTransaction).toBe(false);
          const observer = new DatabaseSync(f.store.path, { readOnly: true });

          try {
            expect(
              structuredClone(observer.prepare("select state from commands where id=1").get())
            ).toStrictEqual({
              state: "accepted",
            });
          } finally {
            observer.close();
          }

          f.store.put(c.id, c.value);

          return { kind: "ok" as const, resource: c.id };
        },
      }),
    });

    const result = await sync.push(ask(f.store.dataset()), AGENT);
    expect(result.results[0]?.outcome).toStrictEqual({ kind: "ok", resource: "a" });
  } finally {
    await f.close();
  }
});

test("a head that cannot be persisted prevents the pull reply from escaping", async () => {
  const { mkdirSync } = await import("node:fs");
  const f = await fixture();

  try {
    mkdirSync(`${f.store.path}.head`);
    const reply = await call(api.pull, pull(null), { base: f.server.url, headers: f.headers });
    expect(reply.ok).toBe(false);

    if (reply.ok) {
      throw new Error("reply escaped before the served head was kept");
    }

    expect(reply.failure.kind).toBe("unavailable");
  } finally {
    await f.close();
  }
});

test("a stamped write in pushed cannot move the reply past the head that was served", async () => {
  const f = await fixture();
  const heads: number[] = [];

  try {
    const sync = syncHandlers({
      ...f.handlerOptions,
      pushed: () => {
        const head = object({ dataset: string(), revision: number() }).parse(
          JSON.parse(readFileSync(`${f.store.path}.head`, "utf-8"))
        );

        heads.push(head.revision);
        f.store.put("hook", 99);
      },
    });

    const reply = await sync.push(ask(f.store.dataset()), AGENT);

    const head = object({ dataset: string(), revision: number() }).parse(
      JSON.parse(readFileSync(`${f.store.path}.head`, "utf-8"))
    );

    expect(heads).toStrictEqual([reply.revision]);
    expect(head).toStrictEqual({ dataset: f.store.dataset(), revision: reply.revision });
    expect(f.store.revision()).toBeGreaterThan(reply.revision);
    expect(f.store.rows("history").map((value) => [value.id, value.value])).toStrictEqual([
      ["a", 1],
      ["hook", 99],
    ]);
  } finally {
    await f.close();
  }
});

test.each(["dataset", "history"] as const)(
  "a %s refusal serves the revision its push returns",
  async (refusal) => {
    const f = await fixture();

    try {
      f.store.put("seed", 1);
      const revision = f.store.revision();

      const reply = await f.sync.push(
        ask(
          refusal === "dataset" ? "another-dataset" : f.store.dataset(),
          refusal === "history" ? 2 : 0
        ),
        AGENT
      );

      expect(reply.revision).toBe(revision);
      expect(reply.results[0]?.outcome).toMatchObject({ kind: "failed", reason: "conflict" });
      expect(JSON.parse(readFileSync(`${f.store.path}.head`, "utf-8"))).toStrictEqual({
        dataset: f.store.dataset(),
        revision,
      });
      expect(f.actions).toStrictEqual([]);
    } finally {
      await f.close();
    }
  }
);

test("kit answers have one shared contract for every server-managed refusal", () => {
  expect(KIT_ANSWERS.replaced).toBe(
    "the server's data was replaced since this was tapped; tap again"
  );
  expect(KIT_ANSWERS.history).toBe(
    "this page's copy is from another history of the server's data; it starts over"
  );
  expect(KIT_ANSWERS.forbidden("person")).toBe("only a person's login can person");
  expect(KIT_ANSWERS.reused(7)).toBe("command 7 was already used for another command");

  const answer: ApiKitOutcome = { kind: "retired" };
  const reexported: ServerKitOutcome = answer;
  expect(reexported).toStrictEqual({ kind: "retired" });
});

function constrainedOutcome(
  message: Schema<string>,
  retired = object({ kind: literal("retired") }, { strict: true })
) {
  return variant("kind", {
    ok: object({ kind: literal("ok"), resource: string() }, { strict: true }),
    failed: object(
      { kind: literal("failed"), reason: literal("conflict", "forbidden", "fixture"), message },
      { strict: true }
    ),
    retired,
  });
}

test.each([
  { name: "short messages", message: string({ max: 20 }) },
  {
    name: "replaced dataset",
    message: string({ pattern: /^(?!the server's data was replaced)[\s\S]*$/ }),
  },
  {
    name: "unknown history",
    message: string({ pattern: /^(?!this page's copy is from another history)[\s\S]*$/ }),
  },
  {
    name: "person-only command",
    message: string({ pattern: /^(?!only a person's login can)[\s\S]*$/ }),
  },
  {
    name: "reused key",
    message: string({ pattern: /^(?!command [0-9]+ was already used)[\s\S]*$/ }),
  },
])("routes refuse at creation an outcome schema excluding $name", async ({ message }) => {
  const f = await fixture();

  try {
    const constrained = syncApi({
      rows: { history: row, settings: row },
      server: serverSchema,
      command,
      outcome: constrainedOutcome(message),
    });

    expect(() => syncRoutes(constrained, { ...f.sync, page: () => {} })).toThrow(Error);
  } finally {
    await f.close();
  }
});

test("serveSync refuses incompatible outcome bounds before serving another listener", async () => {
  const f = await fixture();
  let opened: { close: () => Promise<void> } | undefined;

  try {
    const constrained = syncApi({
      rows: { history: row, settings: row },
      server: serverSchema,
      command,
      outcome: constrainedOutcome(string({ max: 20 })),
    });

    const starting = serveSync({
      name: "notes",
      api: constrained,
      home: f.home,
      config: f.config,
      env: {},
      log: () => {},
      page: () => {},
      assets: f.home,
      sync: f.sync,
    }).then((server) => {
      opened = server;

      return server;
    });

    await expect(starting).rejects.toThrow(Error);
  } finally {
    await opened?.close();
    await f.close();
  }
});

test("routes also refuse a schema whose retired variant rejects the kit's retired answer", async () => {
  const f = await fixture();

  try {
    const excludesRetired = variant("kind", {
      ok: object({ kind: literal("ok"), resource: string() }, { strict: true }),
      failed: object(
        {
          kind: literal("failed"),
          reason: literal("conflict", "forbidden", "fixture"),
          message: string(),
        },
        { strict: true }
      ),
      retired: object({ kind: string({ pattern: /^not-retired$/ }) }, { strict: true }),
    });

    const constrained = syncApi({
      rows: { history: row, settings: row },
      server: serverSchema,
      command,
      outcome: excludesRetired,
    });

    expect(() => syncRoutes(constrained, { ...f.sync, page: () => {} })).toThrow(Error);
  } finally {
    await f.close();
  }
});

test("rows only a person may read stay out of a service's pull, deltas and checksum, by caller", async () => {
  const f = await fixture();

  try {
    const people = (caller: { person: boolean }, rows: ReturnType<typeof f.store.rows>) =>
      caller.person ? rows : [];

    const sync = syncHandlers({
      ...f.handlerOptions,
      unpaged: (since: number, caller: Caller) => ({
        settings: people(caller, f.store.rows("settings", since)),
      }),
      everything: (caller: Caller) => ({
        history: f.store.rows("history"),
        settings: people(caller, f.store.rows("settings")),
      }),
    });

    f.store.put("secret", 1, "settings");
    const dataset = f.store.dataset();

    expect((await sync.pull(pull(null), PERSON)).settings.map((r) => r.id)).toStrictEqual([
      "secret",
    ]);
    expect((await sync.pull(pull(null), AGENT)).settings).toStrictEqual([]);
    expect((await sync.pull({ ...pull(null), page: null }, AGENT)).settings).toStrictEqual([]);

    const since = f.store.revision();
    f.store.put("later", 2, "settings");
    expect((await sync.pull(pull(dataset, since), AGENT)).settings).toStrictEqual([]);
    expect(
      (await sync.pull({ ...pull(dataset, since), page: null }, AGENT)).settings
    ).toStrictEqual([]);
    expect((await sync.pull(pull(dataset, since), PERSON)).settings.map((r) => r.id)).toStrictEqual(
      ["later"]
    );

    // SHA256('[[],[]]'), hand-computed independently of slopkit/digest: what the service's copy holds.
    const emptyHash = "643d5437104296e21d906ecb15b2c96ad278f20cfc4af53b12bb6069bd853726";
    expect((await sync.pull({ ...pull(null), verify: true }, AGENT)).checksum).toBe(emptyHash);
    expect((await sync.pull({ ...pull(null), verify: true }, PERSON)).checksum).not.toBe(emptyHash);
  } finally {
    await f.close();
  }
});

test.each(["pull", "push"] as const)(
  "%s checks as before its handler and leaves effects, claims, and rows untouched",
  async (kind) => {
    const f = await fixture();
    let handled = 0;

    const server = await serveSync({
      name: "notes",
      api,
      home: f.home,
      config: f.config,
      env: {},
      log: () => {},
      page: () => {},
      assets: f.home,
      sync: {
        ...f.sync,
        pull: (request, caller) => {
          handled++;

          return f.sync.pull(request, caller);
        },
        push: (request, caller) => {
          handled++;

          return f.sync.push(request, caller);
        },
      },
    });

    const base = new URL(server.url).origin;

    try {
      f.store.put("private", 42);
      const cookie = await f.login();
      const input = kind === "pull" ? pull(null) : ask(f.store.dataset());

      // A forgotten marker (nobody) is not an absent marker (an older release).
      for (const as of ["", "another-person"]) {
        const response = await fetch(
          new URL(kind === "pull" ? encodeUrl(api.pull, { ...input, as }) : api.push.path, base),
          {
            ...(kind === "push" ? { method: "POST", body: JSON.stringify({ ...input, as }) } : {}),
            headers: { cookie, origin: base, "content-type": "application/json" },
          }
        );

        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ kind: "signed-out" });
        expect(
          response.headers
            .getSetCookie()
            .some((entry) => entry.startsWith(`notes_who=${scopeOf(["sub:someone"])}`))
        ).toBe(true);
      }

      expect(handled).toBe(0);
      expect(f.actions).toStrictEqual([]);
      expect(structuredClone(f.store.db.prepare("select * from commands").all())).toStrictEqual([]);
      expect(f.store.rows("history").map((item) => [item.id, item.value])).toStrictEqual([
        ["private", 42],
      ]);

      for (const as of [undefined, scopeOf(["sub:someone"])]) {
        const request = { ...input, ...(as === undefined ? {} : { as }) };

        const response = await fetch(
          new URL(kind === "pull" ? encodeUrl(api.pull, request) : api.push.path, base),
          {
            ...(kind === "push" ? { method: "POST", body: JSON.stringify(request) } : {}),
            headers: { cookie, origin: base, "content-type": "application/json" },
          }
        );

        expect(response.status).toBe(200);
      }

      expect(handled).toBe(2);
      expect(f.actions).toStrictEqual(kind === "push" ? ["a"] : []);

      // Keys opt out only by omitting as, never by forging it.
      const wrongKey = await fetch(
        new URL(encodeUrl(api.pull, { ...pull(null), as: "wrong" }), base),
        { headers: f.headers }
      );

      expect(wrongKey.status).toBe(401);
      expect(wrongKey.headers.getSetCookie()).toStrictEqual([]);
      const key = await call(api.pull, pull(null), { base, headers: f.headers });
      expect(key.ok).toBe(true);
    } finally {
      await server.close();
      await f.close();
    }
  }
);

test.each(["pull", "push"] as const)(
  "%s's optional as is a string of at most 64 characters",
  (kind) => {
    const input = kind === "pull" ? pull(null) : ask(null);
    const schema = kind === "pull" ? api.pull.request : api.push.request;

    for (const as of ["", "a".repeat(64)]) {
      expect(schema.parse({ ...input, as })).toMatchObject({ as });
    }

    expect(() => schema.parse({ ...input, as: "a".repeat(65) })).toThrow(Error);
    expect(() => schema.parse({ ...input, as: 12 })).toThrow(Error);
    expect(schema.parse(input)).not.toHaveProperty("as");
  }
);
