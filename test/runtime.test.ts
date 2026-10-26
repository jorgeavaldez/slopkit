import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";

import { string } from "../src/schema.ts";
import type { Infer } from "../src/schema.ts";
import type { Model, Pending } from "../src/sync.ts";
import { indexedReplica } from "../src/web/replica.ts";
import { createRuntime } from "../src/web/runtime.ts";
import type { RuntimeEnv } from "../src/web/runtime.ts";
import { api, empty, engine, fixture, pending, serverSchema, tables } from "./sync-fixture.ts";
import type { Command, Outcome, Patch, Tables } from "./sync-fixture.ts";

const scopeOf = (identities: readonly string[]) =>
  createHash("sha256").update(identities.toSorted().join("\n")).digest("base64url").slice(0, 22);

type RuntimeModel = Model<Tables, Infer<typeof serverSchema>, Command, Outcome>;

function socketText(data: RawData): string {
  return Array.isArray(data)
    ? Buffer.concat(data).toString()
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString();
}

class Scheduler {
  now = 1000;
  private next = 0;
  private readonly tasks = new Map<number, { at: number; every: number; run: () => void }>();
  schedule(run: () => void, ms: number, every = 0): () => void {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + ms, every, run });

    return () => {
      this.tasks.delete(id);
    };
  }
  timeout = (run: () => void, ms: number) => this.schedule(run, ms);
  interval = (run: () => void, ms: number) => this.schedule(run, ms, ms);
  advance(ms: number): void {
    const end = this.now + ms;

    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, t]) => t.at <= end)
        .toSorted((a, b) => a[1].at - b[1].at)[0];

      if (!next) {
        break;
      }

      const [id, task] = next;
      this.now = task.at;

      if (task.every) {
        task.at += task.every;
      } else {
        this.tasks.delete(id);
      }

      task.run();
    }

    this.now = end;
  }
  count() {
    return this.tasks.size;
  }
}

class DocumentPort {
  cookie = "";
  visibilityState: DocumentVisibilityState = "visible";
  readonly listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners.delete(listener);
  }
  visible(state: DocumentVisibilityState) {
    this.visibilityState = state;

    for (const listener of this.listeners) {
      listener();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });

  return { promise, resolve };
}

type Captured = { path: string; body: unknown; url: string };

// A real HTTP fault gateway. All normal traffic is forwarded to serveSync; status failures and held replies
// are observable network inputs, not a fake implementation of the contract or the sync engine.
async function harness(
  options: {
    persist?: () => Promise<boolean>;
    cookie?: string;
    offline?: boolean;
    person?: boolean;
    factory?: IDBFactory;
    name?: string;
    painted?: (model: RuntimeModel) => Record<string, string | number | boolean | null> | undefined;
    answered?: (pending: Pending<Command, Outcome>) => void;
    pushTimeoutMs?: number;
  } = {}
) {
  const f = await fixture();
  const scheduler = new Scheduler();
  const pageDocument = new DocumentPort();
  let offline = options.offline ?? false;

  const identityHeaders: Record<string, string> =
    options.person === true ? { cookie: await f.login(), origin: f.server.url } : f.headers;

  const captures: Captured[] = [];
  let telemetryStatus = 200;
  let telemetryGate: ReturnType<typeof deferred<void>> | undefined;
  let pullsHeld = false;
  const heldPulls: (() => void)[] = [];
  let pushHeld = false;
  const heldResponses = new Set<ServerResponse>();
  let onTelemetry: (() => void) | undefined;
  let onTelemetrySent: (() => void) | undefined;

  // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- the test HTTP server owns this async handler; its rejections are test failures, never swallowed
  const proxy = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const chunks: string[] = [];
    request.setEncoding("utf-8");

    for await (const chunk of request) {
      chunks.push(string().parse(chunk));
    }

    const text = chunks.join("");

    const body: unknown =
      request.method === "GET"
        ? JSON.parse(url.searchParams.get("q") ?? "null")
        : JSON.parse(text || "null");

    captures.push({
      path: url.pathname,
      body,
      url: `http://${request.headers.host}${request.url}`,
    });

    if (url.pathname === "/api/telemetry") {
      onTelemetry?.();
      const status = telemetryStatus;
      const gate = telemetryGate;

      if (gate) {
        await gate.promise;
      }

      if (status === 0) {
        response.destroy();

        return;
      }

      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            kind: status === 503 ? "unavailable" : "invalid",
            message: "gateway refusal",
          })
        );

        return;
      }
    }

    if (url.pathname === "/api/push" && pushHeld) {
      heldResponses.add(response);
      response.on("close", () => {
        heldResponses.delete(response);
      });

      return;
    }

    if (url.pathname === "/api/pull" && pullsHeld) {
      await new Promise<void>((_resolve) => {
        heldPulls.push(_resolve);
      });
    }

    const upstream = await fetch(`${f.server.url}${request.url}`, {
      method: request.method ?? "GET",
      headers: { ...identityHeaders, "content-type": "application/json" },
      ...(text ? { body: text } : {}),
    });

    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "set-cookie": upstream.headers.getSetCookie(),
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));

    if (url.pathname === "/api/telemetry") {
      onTelemetrySent?.();
      onTelemetrySent = undefined;
    }
  });

  const channels = new WebSocketServer({ noServer: true });
  const downstreams: WebSocket[] = [];
  const upstreams: WebSocket[] = [];
  let refuseSocket = false;
  proxy.on("upgrade", (request, socket, head) => {
    if (refuseSocket) {
      socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");

      return;
    }

    channels.handleUpgrade(request, socket, head, (downstream) => {
      downstreams.push(downstream);

      const upstream = new WebSocket(`${f.server.url.replace("http:", "ws:")}${api.socket.path}`, {
        headers: f.headers,
      });

      upstreams.push(upstream);
      upstream.on("message", (data) => {
        if (downstream.readyState === WebSocket.OPEN) {
          downstream.send(socketText(data));
        }
      });
      upstream.on("error", () => {});
      downstream.on("error", () => {});
      downstream.on("close", () => upstream.close());
      upstream.on("close", () => downstream.close());
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a pipe path or TCP address here; this is the loopback-address I/O boundary
  if (address === null || typeof address === "string") {
    throw new Error("missing loopback address");
  }

  const host = `127.0.0.1:${address.port}`;
  const factory = options.factory ?? new IDBFactory();
  const name = options.name ?? "runtime-fixture";
  pageDocument.cookie =
    options.cookie ??
    `${name}_who=${scopeOf([options.person === true ? "sub:someone" : "key:fixture"])}`;
  const received = new WeakSet<WebSocket>();
  const sockets: WebSocket[] = [];
  const socketUrls: string[] = [];
  const fetches: { url: string; signal: AbortSignal | null | undefined }[] = [];
  let persistCalls = 0;
  let reloads = 0;
  let entropy = 0;

  const env: RuntimeEnv = {
    indexedDB: factory,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches.push({
        url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        signal: init?.signal,
      });

      if (offline) {
        throw new TypeError("the device is offline");
      }

      const response = await fetch(input, init);

      for (const cookie of response.headers.getSetCookie()) {
        if (cookie.startsWith(`${name}_who=`)) {
          pageDocument.cookie = cookie.split(";")[0] ?? "";
        }
      }

      return response;
    },
    socket: (url: string) => {
      socketUrls.push(url);
      const socket = new WebSocket(url, { headers: f.headers });
      socket.on("error", () => {});
      sockets.push(socket);

      const port: ReturnType<RuntimeEnv["socket"]> = {
        onopen: null,
        onmessage: null,
        onclose: null,
        close: () => socket.close(),
      };

      socket.on("open", () => {
        port.onopen?.();
      });
      socket.on("close", () => {
        port.onclose?.();
      });
      socket.on("message", (data) => {
        received.add(socket);
        port.onmessage?.({
          data: socketText(data),
        });
      });

      return port;
    },
    location: {
      protocol: "http:",
      host,
      reload: () => {
        reloads++;
      },
    },
    document: pageDocument,
    persist: () => {
      persistCalls++;

      return options.persist ? options.persist() : Promise.resolve(true);
    },
    now: () => 1_700_000_000_000 + scheduler.now,
    monotonic: () => scheduler.now,
    setTimeout: scheduler.timeout,
    setInterval: scheduler.interval,
    random: (count: number) => {
      entropy++;

      return new Uint8Array(count).fill(entropy);
    },
  };

  const runtime = createRuntime({
    name,
    api,
    sync: engine,
    replica: { version: 1, tables, empty },
    env,
    ...(options.painted ? { painted: options.painted } : {}),
    ...(options.answered ? { answered: options.answered } : {}),
    ...(options.pushTimeoutMs === undefined ? {} : { pushTimeoutMs: options.pushTimeoutMs }),
  });

  return {
    ...f,
    runtime,
    scheduler,
    document: pageDocument,
    factory,
    name,
    captures,
    sockets,
    socketUrls,
    fetches,
    host,
    env,
    setOffline: (value: boolean) => {
      offline = value;
    },
    rejectSockets: (refuse: boolean) => {
      refuseSocket = refuse;
    },
    serverSocket: () => {
      const channel = downstreams.at(-1);

      if (!channel) {
        throw new Error("no server socket");
      }

      return channel;
    },
    persistCalls: () => persistCalls,
    reloads: () => reloads,
    telemetry: () => captures.flatMap((c) => (c.path === "/api/telemetry" ? [c.body] : [])),
    nextTelemetry: () =>
      new Promise<void>((_resolve) => {
        onTelemetrySent = _resolve;
      }),
    failTelemetry: (status: number) => {
      telemetryStatus = status;
    },
    gateTelemetry: () => {
      telemetryGate = deferred<void>();
      const entered = deferred<void>();
      onTelemetry = () => entered.resolve();

      return {
        entered: entered.promise,
        release: () => {
          telemetryGate?.resolve();
          telemetryGate = undefined;
          onTelemetry = undefined;
        },
      };
    },
    holdPulls: () => {
      pullsHeld = true;
    },
    releasePulls: () => {
      pullsHeld = false;

      for (const _resolve of heldPulls.splice(0)) {
        _resolve();
      }
    },
    holdPush: () => {
      pushHeld = true;
    },
    lastSocket: () => {
      const socket = sockets.at(-1);

      if (!socket) {
        throw new Error("fixture socket missing");
      }

      return socket;
    },
    readySocket: async () => {
      const socket = sockets.at(-1);

      if (socket?.readyState === WebSocket.CONNECTING) {
        await once(socket, "open");
      }

      if (socket && !received.has(socket)) {
        await once(socket, "message");
      }
    },
    close: async () => {
      runtime.stop();
      pullsHeld = false;

      for (const _resolve of heldPulls.splice(0)) {
        _resolve();
      }

      telemetryGate?.resolve();

      for (const response of heldResponses) {
        response.destroy();
      }

      await Promise.all(
        sockets.map(async (s) => {
          if (s.readyState !== WebSocket.CLOSED) {
            const closed = new Promise<void>((_resolve) => {
              s.once("close", () => _resolve());
            });

            s.close();
            await closed;
          }
        })
      );
      await Promise.all(
        upstreams.map(async (s) => {
          if (s.readyState !== WebSocket.CLOSED) {
            const closed = new Promise<void>((_resolve) => {
              s.once("close", () => _resolve());
            });

            s.close();
            await closed;
          }
        })
      );
      await new Promise<void>((_resolve) => {
        channels.close(() => _resolve());
      });
      proxy.closeAllConnections();
      await new Promise<void>((_resolve, reject) => {
        proxy.close((error) => {
          if (error) {
            reject(error);
          } else {
            _resolve();
          }
        });
      });
      await f.close();
    },
  };
}

function events(
  batches: unknown[]
): { name: string; at: string; attributes?: Record<string, string | number | boolean | null> }[] {
  return batches.flatMap((body) => {
    const parsed = api.telemetry.request.parse(body);

    return parsed.events;
  });
}

test("runtime owns an independent 18-byte base64url client, requests persist at creation, and does not await persistence", async () => {
  const grant = deferred<boolean>();
  const h = await harness({ persist: () => grant.promise });

  try {
    expect(h.persistCalls()).toBe(1);
    expect(h.runtime.client).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(h.runtime.client).toBe("AQEBAQEBAQEBAQEBAQEBAQEB");
    h.runtime.start();
    await h.runtime.settle();
    expect(h.runtime.model().boot.kind).toBe("ready");
    expect(h.persistCalls()).toBe(1);
    grant.resolve(true);
    await grant.promise;
    await h.runtime.flush();
    expect(events(h.telemetry()).filter((e) => e.name === "storage.persist")).toStrictEqual([
      {
        name: "storage.persist",
        at: new Date(1_700_000_001_000).toISOString(),
        attributes: { granted: true },
      },
    ]);
  } finally {
    await h.close();
  }
});

test("runtime maps HTTP replies, push receipts and answered hook through the real client, keeping data across reopen", async () => {
  const answered: Pending<Command, Outcome>[] = [];
  const factory = new IDBFactory();

  const h = await harness({
    factory,
    name: "shared",
    answered: (p) => {
      answered.push(p);
    },
  });

  try {
    h.store.put("seed", 1);
    h.store.put("setting", 7, "settings");
    h.runtime.start();
    await h.runtime.settle();
    await h.readySocket();
    expect(
      [...h.runtime.model().replica.tables.history.values()].map((r) => [r.id, r.value])
    ).toStrictEqual([["seed", 1]]);
    expect(
      [...h.runtime.model().replica.tables.settings.values()].map((r) => [r.id, r.value])
    ).toStrictEqual([["setting", 7]]);
    h.runtime.command({ name: "put", id: "made", value: 9 });
    await h.runtime.settle();
    expect(h.actions).toStrictEqual(["made"]);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.state).toMatchObject({
      kind: "done",
      outcome: { kind: "ok", resource: "made" },
    });
    expect(h.runtime.model().commands[0]?.state).toMatchObject({
      kind: "done",
      outcome: { kind: "ok", resource: "made" },
    });

    const port = indexedReplica<Tables, Patch, Infer<typeof serverSchema>, Command, Outcome>({
      factory,
      name: "shared",
      version: 1,
      tables,
      empty,
      pending,
      server: serverSchema,
    });

    const disk = await port.load();
    expect(
      [...disk.replica.tables.history.values()]
        .map((r) => [r.id, r.value])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toStrictEqual([
      ["made", 9],
      ["seed", 1],
    ]);
    expect(disk.commands).toHaveLength(1);
    h.runtime.dismiss({ client: h.runtime.client, id: 1 });
    await h.runtime.settle();
    expect((await port.load()).commands).toStrictEqual([]);
    void h.runtime.forget();
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
    expect(h.fetches.every((r) => r.url.startsWith(`http://${h.host}/api/`))).toBe(true);
    expect(h.socketUrls[0]).toBe(`ws://${h.host}/api/socket`);
  } finally {
    await h.close();
  }
});

test("client ids are never reused by a second runtime, even sharing the same stored replica", async () => {
  const h = await harness();

  try {
    let randomCalls = 0;

    const other = createRuntime({
      name: h.name,
      api,
      sync: engine,
      replica: { version: 1, tables, empty, pending },
      env: {
        indexedDB: h.factory,
        random: (count: number) => {
          randomCalls++;
          expect(count).toBe(18);

          return new Uint8Array(count).fill(2);
        },
        persist: () => Promise.resolve(false),
        location: { protocol: "http:", host: h.host, reload: () => {} },
        document: h.document,
        now: () => 0,
        monotonic: () => 0,
        setTimeout: h.scheduler.timeout,
        setInterval: h.scheduler.interval,
      },
    });

    expect(other.client).toBe("AgICAgICAgICAgICAgICAgIC");
    expect(other.client).not.toBe(h.runtime.client);
    expect(randomCalls).toBe(1);
    other.stop();
  } finally {
    await h.close();
  }
});

test("missing API row lens is refused at creation, before loading or contacting the server", async () => {
  const h = await harness();

  try {
    const settings = tables[0];

    if (!settings) {
      throw new Error("fixture missing settings lens");
    }

    expect(() =>
      createRuntime({
        name: "missing",
        api,
        sync: engine,
        replica: { version: 1, tables: [settings], empty, pending },
        env: h.env,
      })
    ).toThrow(/history|lens|table/i);
  } finally {
    await h.close();
  }
});

test("fingerprint uses API row order, not replica lens order, and excludes tombstones", async () => {
  const h = await harness();

  try {
    h.store.put("h", 3);
    h.store.put("s", 8, "settings");
    h.store.put("gone", 0);
    h.store.transaction(() => {
      const revision = h.store.stamp();
      h.store.db.prepare("update history set deleted=1,revision=? where id='gone'").run(revision);
    });
    h.runtime.start();
    await h.runtime.settle();

    const port = indexedReplica<Tables, Patch, Infer<typeof serverSchema>, Command, Outcome>({
      factory: h.factory,
      name: h.name,
      version: 1,
      tables,
      empty,
      pending,
      server: serverSchema,
    });

    const held = await port.load();
    expect(held.replica.tables.history.has("gone")).toBe(false);

    // Canonical row arrays are independently assembled in API order, hashed by Node's crypto, not slopkit/digest.
    const expected = createHash("sha256")
      .update(JSON.stringify([h.store.rows("history"), h.store.rows("settings")]))
      .digest("hex");

    const checked = await h.sync.pull(
      {
        client: h.runtime.client,
        dataset: h.store.dataset(),
        since: h.store.revision(),
        verify: true,
      },
      { identities: ["key:fixture"], person: false, login: "key", request: "fixture" }
    );

    expect(checked.checksum).toBe(expected);
    expect(h.runtime.model().verify).toStrictEqual({ kind: "done", match: true });
  } finally {
    await h.close();
  }
});

test("pulls omit false verify, but keep the engine's paging cursor and awaited command refs", async () => {
  const h = await harness();

  try {
    for (let i = 1; i <= 5; i++) {
      h.store.put(String(i), i);
    }

    h.runtime.start();
    await h.runtime.settle();

    const pulls = h.captures
      .filter((c) => c.path === "/api/pull")
      .map((c) => api.pull.request.parse(c.body));

    expect(pulls[0]).toStrictEqual({
      as: scopeOf(["key:fixture"]),
      client: h.runtime.client,
      dataset: null,
      since: 0,
      verify: true,
      page: null,
      commands: [],
    });
    expect(pulls.some((p) => p.page !== undefined && p.page !== null)).toBe(true);
    expect(pulls.every((p) => p.verify === undefined || p.verify)).toBe(true);
    expect(
      [...h.runtime.model().replica.tables.history.keys()].toSorted((a, b) =>
        String(a).localeCompare(String(b))
      )
    ).toStrictEqual(["1", "2", "3", "4", "5"]);
  } finally {
    await h.close();
  }
});

test("push uses its configured timeout against an actual held HTTP reply", async () => {
  const h = await harness({ pushTimeoutMs: 5 });

  try {
    h.runtime.start();
    await h.runtime.settle();
    h.holdPush();
    h.runtime.command({ name: "put", id: "timeout", value: 1 });
    await h.runtime.settle();
    expect(h.runtime.model().commands[0]?.state.kind).toBe("unknown");
    expect(h.actions).toStrictEqual([]);
    const sent = h.fetches.find((r) => r.url.endsWith("/api/push"));
    expect(sent?.signal?.aborted).toBe(true);
  } finally {
    await h.close();
  }
});

test("tick and visibility dispatch while started, stop removes timers/listeners and prevents autonomous work", async () => {
  const h = await harness();

  try {
    let renders = 0;

    const unsubscribe = h.runtime.subscribe(() => {
      renders++;
    });

    h.runtime.start();
    await h.runtime.settle();
    await h.readySocket();
    h.scheduler.advance(1000);
    await h.runtime.settle();
    expect(h.runtime.model().now).toBe(1_700_000_002_000);
    h.document.visible("hidden");
    await h.runtime.settle();
    expect(h.runtime.model().visible).toBe(false);
    h.document.visible("visible");
    await h.runtime.settle();
    expect(h.runtime.model().visible).toBe(true);
    unsubscribe();
    h.runtime.stop();
    await h.runtime.settle();
    const stopped = renders;
    const requests = h.captures.length;
    expect(h.scheduler.count()).toBe(0);
    expect(h.document.listeners.size).toBe(0);
    h.scheduler.advance(120_000);
    h.document.visible("hidden");
    await h.runtime.settle();
    expect(h.captures).toHaveLength(requests);
    expect(renders).toBe(stopped);
  } finally {
    await h.close();
  }
});

test("telemetry keeps newest 100, flushes in one call, drops empty flush and uses page time", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.runtime.flush();
    h.captures.splice(0);

    for (let i = 0; i < 110; i++) {
      h.runtime.record("fixture.event", { i });
    }

    await h.runtime.flush();
    const batches = h.telemetry();
    expect(batches).toHaveLength(1);
    expect(events(batches).map((e) => e.attributes?.i)).toStrictEqual(
      Array.from({ length: 100 }, (_, i) => i + 10)
    );
    expect(events(batches).every((e) => e.at === "2023-11-14T22:13:21.000Z")).toBe(true);
    await h.runtime.flush();
    expect(h.telemetry()).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("telemetry flushes every 30 seconds and immediately on hidden", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.runtime.flush();
    h.captures.splice(0);
    h.runtime.record("thirty.seconds");
    h.scheduler.advance(29_999);
    await h.runtime.settle();
    expect(h.telemetry()).toStrictEqual([]);
    const timed = h.nextTelemetry();
    h.scheduler.advance(1);
    await timed;
    expect(events(h.telemetry()).some((e) => e.name === "thirty.seconds")).toBe(true);
    h.runtime.record("on.hidden");
    const hidden = h.nextTelemetry();
    h.document.visible("hidden");
    await hidden;
    expect(events(h.telemetry()).some((e) => e.name === "on.hidden")).toBe(true);
  } finally {
    await h.close();
  }
});

test.each([0, 503])(
  "telemetry failure %i restores newest 50 of failed batch before events recorded during send",
  async (status) => {
    const h = await harness();

    try {
      h.runtime.start();
      await h.runtime.settle();
      await h.runtime.flush();
      h.captures.splice(0);

      for (let i = 0; i < 80; i++) {
        h.runtime.record("fixture.event", { i });
      }

      h.failTelemetry(status);
      const gate = h.gateTelemetry();
      const flushing = h.runtime.flush();
      await gate.entered;
      h.runtime.record("fixture.event", { i: 80 });
      h.runtime.record("fixture.event", { i: 81 });
      gate.release();
      await flushing;
      h.failTelemetry(200);
      await h.runtime.flush();
      expect(events(h.telemetry().slice(1)).map((e) => e.attributes?.i)).toStrictEqual(
        Array.from({ length: 52 }, (_, i) => i + 30)
      );
    } finally {
      await h.close();
    }
  }
);

test("final telemetry refusal drops its batch rather than retrying it", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.runtime.flush();
    h.captures.splice(0);
    h.runtime.record("refused.batch");
    h.failTelemetry(400);
    await h.runtime.flush();
    h.failTelemetry(200);
    await h.runtime.flush();
    expect(h.telemetry()).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("a later reconciled server version reloads exactly once, not the first or unchanged version", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    expect(h.reloads()).toBe(0);
    h.scheduler.advance(4000);
    await h.runtime.settle();
    expect(h.reloads()).toBe(0);
    await h.readySocket();
    const socket = h.sockets.at(-1);

    if (!socket) {
      throw new Error("missing socket");
    }

    const second = once(socket, "message");
    h.setVersion("v2");
    h.store.put("changed", 2);
    h.sync.changed();
    await second;
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
    const third = once(socket, "message");
    h.setVersion("v3");
    h.store.put("changed", 3);
    h.sync.changed();
    await third;
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
  } finally {
    await h.close();
  }
});

test("painted waits for the hook's first eligible model and records monotonic duration once", async () => {
  let eligible = false;
  const h = await harness({ painted: () => (eligible ? { rows: 7 } : undefined) });

  try {
    h.runtime.start();
    await h.runtime.settle();
    h.scheduler.advance(250);
    eligible = true;
    h.scheduler.advance(750);
    await h.runtime.settle();
    h.scheduler.advance(1000);
    await h.runtime.settle();
    await h.runtime.flush();
    expect(events(h.telemetry()).filter((e) => e.name === "page.painted")).toStrictEqual([
      { name: "page.painted", at: "2023-11-14T22:13:22.000Z", attributes: { ms: 1000, rows: 7 } },
    ]);
  } finally {
    await h.close();
  }
});

test("the socket drops malformed/invalid messages and only a valid poke changes the target", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.readySocket();
    const socket = h.lastSocket();
    const channel = h.serverSocket();
    h.holdPulls();
    const before = h.runtime.model().target;

    for (const text of [
      "not JSON",
      JSON.stringify({ type: "poke", revision: -1 }),
      JSON.stringify({ type: "poke", revision: 9999, injected: true }),
      JSON.stringify({ type: "other", revision: 9999 }),
    ]) {
      const delivered = once(socket, "message");
      channel.send(text);
      await delivered;
    }

    expect(h.runtime.model().target).toBe(before);
    expect(h.runtime.model().socket.open).toBe(true);
    h.store.put("poked", 7);
    const valid = once(socket, "message");
    channel.send(JSON.stringify({ type: "poke", revision: h.store.revision() }));
    await valid;
    expect(h.runtime.model().target).toBe(h.store.revision());
    h.releasePulls();
    await h.runtime.settle();
    expect(h.runtime.model().replica.tables.history.get("poked")?.value).toBe(7);
  } finally {
    await h.close();
  }
});

const closed = (socket: WebSocket) =>
  new Promise<void>((_resolve) => {
    socket.once("close", () => _resolve());
  });

test("reconnects back off across unopened tries, cap at 30 seconds, and reset after opening", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.readySocket();
    const first = h.lastSocket();
    const closeFirst = closed(first);
    h.serverSocket().close();
    await closeFirst;
    expect(h.runtime.model().socket.open).toBe(false);
    h.rejectSockets(true);
    let attempts = h.sockets.length;
    h.scheduler.advance(999);
    expect(h.sockets).toHaveLength(attempts);
    h.scheduler.advance(1);
    expect(h.sockets).toHaveLength(++attempts);
    await closed(h.lastSocket());

    for (const delay of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      h.scheduler.advance(delay - 1);
      expect(h.sockets).toHaveLength(attempts);
      h.scheduler.advance(1);
      expect(h.sockets).toHaveLength(++attempts);
      await closed(h.lastSocket());
    }

    h.rejectSockets(false);
    h.scheduler.advance(30_000);
    await h.readySocket();
    const opened = h.lastSocket();
    const closeOpened = closed(opened);
    h.serverSocket().close();
    await closeOpened;
    attempts = h.sockets.length;
    h.scheduler.advance(999);
    expect(h.sockets).toHaveLength(attempts);
    h.scheduler.advance(1);
    expect(h.sockets).toHaveLength(attempts + 1);
    await h.readySocket();
    h.runtime.stop();
    const stopped = h.sockets.length;
    h.scheduler.advance(120_000);
    expect(h.sockets).toHaveLength(stopped);
  } finally {
    await h.close();
  }
});

test("stopping during the initial IndexedDB load leaves no fetch owed by its late completion", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    h.runtime.stop();
    await h.runtime.settle();
    expect(h.fetches).toStrictEqual([]);
    expect(h.scheduler.count()).toBe(0);
    expect(h.document.listeners.size).toBe(0);
  } finally {
    await h.close();
  }
});

test("a failed telemetry batch and concurrently recorded events still fit the newest-100 buffer", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.runtime.flush();
    h.captures.splice(0);

    for (let i = 0; i < 80; i++) {
      h.runtime.record("fixture.event", { i });
    }

    h.failTelemetry(503);
    const gate = h.gateTelemetry();
    const flushing = h.runtime.flush();
    await gate.entered;

    for (let i = 80; i < 150; i++) {
      h.runtime.record("fixture.event", { i });
    }

    gate.release();
    await flushing;
    h.failTelemetry(200);
    await h.runtime.flush();
    expect(h.telemetry()).toHaveLength(2);
    expect(events(h.telemetry().slice(1)).map((event) => event.attributes?.i)).toStrictEqual(
      Array.from({ length: 100 }, (_, i) => i + 50)
    );
  } finally {
    await h.close();
  }
});

const firstWho = scopeOf(["key:fixture"]);
const otherWho = scopeOf(["sub:someone"]);

function copyOnDisk(factory: IDBFactory, name: string) {
  return indexedReplica<Tables, Patch, Infer<typeof serverSchema>, Command, Outcome>({
    factory,
    name,
    version: 1,
    tables,
    empty,
    pending,
    server: serverSchema,
  });
}

async function legacyCopy(factory: IDBFactory, name: string) {
  const port = copyOnDisk(factory, name);
  await port.load();
  await port.commit({
    replica: {
      dataset: "legacy-data",
      revision: 7,
      server: { version: "v1" },
      tables: {
        history: new Map([
          [
            "first-person-only",
            { id: "first-person-only", value: 41, deleted: false, revision: 7 },
          ],
        ]),
        settings: new Map(),
      },
    },
    reset: true,
    base: 0,
    replaces: null,
    ops: [],
  });
  await port.keep({
    client: "legacy_page",
    id: 1,
    dataset: "legacy-data",
    since: 7,
    command: { name: "put", id: "legacy-intent", value: 4 },
    at: 1000,
    state: { kind: "queued" },
  });
}

function reopen(h: Awaited<ReturnType<typeof harness>>, pageDocument = h.document) {
  return createRuntime({
    name: h.name,
    api,
    sync: engine,
    replica: { version: 1, tables, empty },
    env: { ...h.env, document: pageDocument },
  });
}

test("the first person keeps the earlier release's copy and outbox; another sees neither, and forget is personal", async () => {
  const factory = new IDBFactory();
  await legacyCopy(factory, "legacy-phone");
  const h = await harness({ factory, name: "legacy-phone", offline: true });
  const others: ReturnType<typeof reopen>[] = [];

  try {
    h.runtime.start();
    await h.runtime.settle();
    expect(h.runtime.who).toBe(firstWho);
    expect([...h.runtime.model().replica.tables.history.keys()]).toStrictEqual([
      "first-person-only",
    ]);
    expect(h.runtime.model().commands.map((p) => p.command.id)).toStrictEqual(["legacy-intent"]);
    h.runtime.stop();
    h.document.cookie = `unrelated=x; ${h.name}_who=${otherWho}; tail=y`;
    const other = reopen(h);
    others.push(other);
    other.start();
    await other.settle();
    expect(other.who).toBe(otherWho);
    expect([...other.model().replica.tables.history.keys()]).toStrictEqual([]);
    expect(other.model().commands).toStrictEqual([]);
    other.command({ name: "put", id: "other-intent", value: 2 });
    await other.settle();
    expect(
      (await copyOnDisk(factory, `${h.name}~${otherWho}`).load()).commands.map((p) => p.command.id)
    ).toStrictEqual(["other-intent"]);
    await other.forget();
    other.stop();
    expect((await copyOnDisk(factory, `${h.name}~${otherWho}`).load()).commands).toStrictEqual([]);
    h.document.cookie = `${h.name}_who=${firstWho}`;
    const first = reopen(h);
    others.push(first);
    first.start();
    await first.settle();
    expect([...first.model().replica.tables.history.keys()]).toStrictEqual(["first-person-only"]);
    expect(first.model().commands.map((p) => p.command.id)).toStrictEqual(["legacy-intent"]);
    expect(
      (await copyOnDisk(factory, h.name).load()).commands.map((p) => p.command.id)
    ).toStrictEqual(["legacy-intent"]);
  } finally {
    for (const runtime of others) {
      runtime.stop();
    }

    await h.close();
  }
});

test("two people opening together cannot both claim the earlier release's database", async () => {
  const factory = new IDBFactory();
  await legacyCopy(factory, "claim-race");
  const h = await harness({ factory, name: "claim-race", offline: true });
  const pageDocument = new DocumentPort();
  pageDocument.cookie = `${h.name}_who=${otherWho}`;
  const other = reopen(h, pageDocument);

  try {
    h.runtime.start();
    other.start();
    await Promise.all([h.runtime.settle(), other.settle()]);

    const copies = [h.runtime, other].map((runtime) => [
      ...runtime.model().replica.tables.history.keys(),
    ]);

    expect(copies.filter((rows) => rows.includes("first-person-only"))).toHaveLength(1);
    expect(copies.filter((rows) => rows.length === 0)).toHaveLength(1);
    expect(
      [h.runtime, other].flatMap((runtime) => runtime.model().commands).map((p) => p.command.id)
    ).toStrictEqual(["legacy-intent"]);
  } finally {
    other.stop();
    await h.close();
  }
});

test("nobody keeps no rows or final commands, acts on nothing, and reloads once when the cookie names someone", async () => {
  const factory = new IDBFactory();
  await legacyCopy(factory, "nobody-phone");

  const h = await harness({
    factory,
    name: "nobody-phone",
    person: true,
    cookie: "nobody-phone_who_else=decoy",
    offline: true,
  });

  let first: ReturnType<typeof reopen> | undefined;

  try {
    h.store.put("server-only", 9);
    h.runtime.start();
    await h.runtime.settle();
    expect(h.runtime.who).toBe("");
    expect([...h.runtime.model().replica.tables.history.keys()]).toStrictEqual([]);
    expect(h.runtime.model().commands).toStrictEqual([]);
    h.runtime.command({ name: "put", id: "nobody-command", value: 2 });
    await h.runtime.settle();
    h.setOffline(false);
    h.scheduler.advance(120_000);
    await h.runtime.settle();
    expect(h.actions).toStrictEqual([]);
    expect(structuredClone(h.store.db.prepare("select * from commands").all())).toStrictEqual([]);
    expect(
      h.captures
        .filter((c) => c.path === "/api/push")
        .every((c) => api.push.request.parse(c.body).as === "")
    ).toBe(true);
    expect([...h.runtime.model().replica.tables.history.keys()]).toStrictEqual([]);
    const nobodyCopy = await copyOnDisk(factory, `${h.name}~`).load();

    expect([...nobodyCopy.replica.tables.history.keys()]).toStrictEqual([]);
    expect(nobodyCopy.commands.map((p) => p.command.id)).toStrictEqual(["nobody-command"]);
    expect(nobodyCopy.commands.every((p) => p.state.kind !== "done")).toBe(true);
    expect(
      h.captures.filter((c) => c.path === "/api/pull").map((c) => api.pull.request.parse(c.body).as)
    ).toStrictEqual([""]);
    expect(h.document.cookie).toBe(`${h.name}_who=${otherWho}`);
    expect(h.reloads()).toBe(1);
    h.scheduler.advance(3000);
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
    h.runtime.stop();
    // Nobody must not have claimed <name>; the first named person still gets the old copy, offline.
    h.setOffline(true);
    first = reopen(h);
    first.start();
    await first.settle();
    expect(first.who).toBe(otherWho);
    expect([...first.model().replica.tables.history.keys()]).toStrictEqual(["first-person-only"]);
    expect(
      (await copyOnDisk(factory, h.name).load()).commands.some(
        (p) => p.command.id === "legacy-intent"
      )
    ).toBe(true);
    expect(
      (await copyOnDisk(factory, `${h.name}~`).load()).commands.map((p) => p.command.id)
    ).toStrictEqual(["nobody-command"]);
  } finally {
    first?.stop();
    await h.close();
  }
});

test("a cookie change before a push sends nothing and never marks the durable intent sending", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    h.captures.splice(0);
    h.document.cookie = `${h.name}_who=${otherWho}`;
    h.runtime.command({ name: "put", id: "belongs-to-first", value: 8 });
    await h.runtime.settle();
    expect(
      h.captures.filter((c) => c.path === "/api/push" || c.path === "/api/pull")
    ).toStrictEqual([]);
    expect(h.actions).toStrictEqual([]);
    const kept = (await copyOnDisk(h.factory, h.name).load()).commands;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.state).toStrictEqual({ kind: "queued" });
    expect(h.reloads()).toBe(1);
    h.scheduler.advance(5000);
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
    expect((await copyOnDisk(h.factory, h.name).load()).commands).toStrictEqual(kept);
  } finally {
    await h.close();
  }
});

test("an idle tick notices another person's cookie and reloads once without another sync call", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.readySocket();
    const count = h.captures.length;
    h.document.cookie = `${h.name}_who=${otherWho}`;
    h.scheduler.advance(999);
    await h.runtime.settle();
    expect(h.reloads()).toBe(0);
    h.scheduler.advance(1);
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
    h.scheduler.advance(2000);
    await h.runtime.settle();
    expect(h.reloads()).toBe(1);
    expect(h.captures).toHaveLength(count);
  } finally {
    await h.close();
  }
});

test("a cookie change before a pull blocks it, even when a socket owes newer rows", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    await h.readySocket();
    const before = h.captures.filter((c) => c.path === "/api/pull").length;
    h.document.cookie = `${h.name}_who=${otherWho}`;
    const delivered = once(h.lastSocket(), "message");
    h.store.put("must-not-pull", 2);
    h.serverSocket().send(JSON.stringify({ type: "poke", revision: h.store.revision() }));
    await delivered;
    await h.runtime.settle();
    expect(h.captures.filter((c) => c.path === "/api/pull")).toHaveLength(before);
    expect(h.runtime.model().replica.tables.history.has("must-not-pull")).toBe(false);
    expect(h.reloads()).toBe(1);
  } finally {
    await h.close();
  }
});

test("a refused call that corrects the cookie reloads instead of showing the other caller's rows", async () => {
  const h = await harness({ person: true, cookie: `runtime-fixture_who=${firstWho}` });

  try {
    h.store.put("other-person-row", 7);
    h.runtime.start();
    await h.runtime.settle();
    expect(h.runtime.who).toBe(firstWho);
    expect(h.document.cookie).toBe(`${h.name}_who=${otherWho}`);
    expect(h.reloads()).toBe(1);
    expect([...h.runtime.model().replica.tables.history.keys()]).toStrictEqual([]);
    expect(
      h.captures.filter((c) => c.path === "/api/pull").map((c) => api.pull.request.parse(c.body).as)
    ).toStrictEqual([firstWho]);
  } finally {
    await h.close();
  }
});

test("every pull and push carries the copy's person, including later commands", async () => {
  const h = await harness();

  try {
    h.runtime.start();
    await h.runtime.settle();
    h.runtime.command({ name: "put", id: "scoped", value: 3 });
    await h.runtime.settle();

    const pulls = h.captures
      .filter((c) => c.path === "/api/pull")
      .map((c) => api.pull.request.parse(c.body));

    const pushes = h.captures
      .filter((c) => c.path === "/api/push")
      .map((c) => api.push.request.parse(c.body));

    expect(pulls.length).toBeGreaterThan(0);
    expect(pushes).toHaveLength(1);
    expect(pulls.every((request) => request.as === firstWho)).toBe(true);
    expect(pushes[0]?.as).toBe(firstWho);
    expect(h.actions).toStrictEqual(["scoped"]);
  } finally {
    await h.close();
  }
});
