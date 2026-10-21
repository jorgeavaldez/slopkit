import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, test } from "vitest";

import { createClient } from "../client.ts";
import { call, endpoint } from "../contract.ts";
import { array, literal, nullable, number, object, string } from "../schema.ts";
import { parseWebConfig } from "../server/config.ts";
import { Ledger } from "../server/ledger.ts";
import { Refusal, route, serveWeb } from "../server/web.ts";
import { POLL_MS } from "../sync.ts";
import type { Pending } from "../sync.ts";
import { identityProvider } from "../test/oidc.ts";
import {
  database,
  deferred,
  outcomeSchema,
  patch,
  pending,
  row,
  sync,
  values,
} from "./fixtures.ts";
import type { Command, Network, Outcome } from "./fixtures.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close();
  }
});

const pushInput = object(
  {
    client: string(),
    dataset: nullable(string()),
    since: number(),
    commands: array(
      object({
        id: number(),
        command: object(
          { name: literal("put"), value: number({ integer: true, min: 0 }) },
          { strict: true }
        ),
      })
    ),
  },
  { strict: true }
);

const pushOutput = object({
  receipts: array(object({ id: number(), outcome: outcomeSchema, revision: number() })),
  revision: number(),
});

const pushEndpoint = endpoint("POST", "/api/push", pushInput, pushOutput);
const echo = endpoint("POST", "/api/echo", object({ text: string() }), object({ text: string() }));

/** Real HTTP schema boundary, real ledger and independent business table. Pulls read actual ledger receipts. */
async function server(bodyLimit?: number) {
  const home = await mkdtemp(join(tmpdir(), "push-contract-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  cleanups.push(() => db.close());
  db.exec(`create table commands(principal text, client text, id integer, name text, args text,
    state text, outcome text, revision integer, created_at text, primary key(principal,client,id));
    create table business(id text primary key, value integer, revision integer);
    create table clock(n integer); insert into clock values(1);`);
  const revision = () => Number(db.prepare("select n from clock").get()?.n);

  const ledger = new Ledger<Outcome>({
    db,
    transaction: (body) => {
      if (db.isTransaction) {
        return body();
      }

      db.exec("begin immediate");

      try {
        const result = body();
        db.exec("commit");

        return result;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    stamp: () => {
      db.exec("update clock set n=n+1");

      return revision();
    },
    encode: JSON.stringify,
    decode: (text) => outcomeSchema.parse(JSON.parse(text)),
  });

  const principal = "person:owner";

  const act = async (client: string, id: number, value: number) => {
    const key = { principal, client, id };

    const result = await ledger.run(
      key,
      { name: "put", args: JSON.stringify({ value }) },
      {
        local: () => {
          db.prepare("insert into business values(?,?,?)").run(`r${id}`, value, revision() + 1);

          return { kind: "ok", resource: `r${id}` };
        },
        remote: async () => ({ kind: "failed", reason: "not an external command" }),
      }
    );

    // Conflicts are per-command receipts, never a thrown refusal after earlier commands acted.
    return {
      id,
      outcome:
        result.kind === "done" ? result.receipt : { kind: "failed" as const, reason: result.kind },
      revision: ledger.revisionOf(key) ?? revision(),
    };
  };

  const provider = await identityProvider("owner");
  cleanups.push(provider.close);
  let refuse: "forbidden" | "conflict" | undefined;
  let echoCalls = 0;

  const web = await serveWeb({
    home,
    assets: home,
    env: {},
    manifest: {},
    cookie: "conformance",
    log: () => {},
    config: parseWebConfig(
      { port: 0, oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:owner"] },
      []
    ),
    ...(bodyLimit === undefined ? {} : { bodyLimit }),
    routes: [
      route(pushEndpoint, async (input) => {
        if (refuse !== undefined) {
          throw new Refusal(refuse, "not allowed now");
        }

        const receipts = [];

        for (const each of input.commands) {
          receipts.push(await act(input.client, each.id, each.command.value));
        }

        return { receipts, revision: revision() };
      }),
      route(echo, (input) => {
        echoCalls++;

        return input;
      }),
    ],
  });

  cleanups.push(web.close);
  let login = await fetch(new URL("auth/login", web.url), { redirect: "manual" });
  login = await fetch(login.headers.get("location") ?? "", { redirect: "manual" });
  login = await fetch(login.headers.get("location") ?? "", { redirect: "manual" });

  const headers = {
    cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    origin: new URL(web.url).origin,
  };

  const options = { base: web.url.replace(/\/$/, ""), headers };
  const pulls: { client: string; id: number }[][] = [];

  const network: Network = {
    push: (input) => call(pushEndpoint, input, options),
    pull: async (input) => {
      pulls.push(input.commands ?? []);

      const rows = db
        .prepare("select id,value,revision from business order by id")
        .all()
        .map((each) => row(String(each.id), Number(each.value), Number(each.revision)));

      return {
        ok: true,
        value: {
          patch: patch(revision(), rows, true),
          receipts: ledger.receiptsOf(principal, input.commands ?? []).map((each) => ({
            client: each.client,
            id: each.id,
            outcome: each.receipt,
            revision: each.revision,
          })),
        },
      };
    },
  };

  return {
    web,
    headers,
    options,
    network,
    pulls,
    act,
    echoCalls: () => echoCalls,
    refuse: (kind: "forbidden" | "conflict") => {
      refuse = kind;
    },
    effects: () =>
      db
        .prepare("select id,value,revision from business order by id")
        .all()
        .map((each) => [each.id, each.value, each.revision]),
  };
}

async function launch(
  network: Network,
  commands: Pending<Command, Outcome>[] = [],
  stored = database()
) {
  await stored.port.load();

  for (const each of commands) {
    await stored.port.keep(each);
  }

  const clock = { now: 0 };
  const answers: Pending<Command, Outcome>[] = [];
  const logs: string[] = [];

  const runtime = createClient({
    sync,
    client: "newer",
    ports: {
      storage: stored.port,
      network,
      now: () => clock.now,
      fingerprint: async () => "fixture-fingerprint",
      answered: (each) => {
        answers.push(each);
      },
      telemetry: (name) => {
        logs.push(name);
      },
    },
  });

  runtime.start();
  await runtime.settle();

  return { runtime, stored, clock, answers, logs };
}

const queued = (id: number, value: number) => ({ ...pending("page", id, value), since: 1 });

async function advance(app: Awaited<ReturnType<typeof launch>>, now: number) {
  app.clock.now = now;
  app.runtime.dispatch({ type: "tick", now });
  await app.runtime.settle();
}

// Rejected programs are kept uncalled: the type check must reject a server-made unreadable failure.
function typeContract() {
  // @ts-expect-error unreadable is a client observation, not a server Refusal
  return new Refusal("unreadable", "broken reply");
}

void typeContract;

test("a schema 400 carries the exact path, before any command acts", async () => {
  const peer = await server();

  const input = {
    client: "page",
    dataset: "dataset-a",
    since: 1,
    commands: [
      { id: 1, command: { name: "put" as const, value: 10 } },
      { id: 2, command: { name: "put" as const, value: -1 } },
    ],
  };

  const raw = await fetch(new URL("api/push", peer.web.url), {
    method: "POST",
    headers: { ...peer.headers, "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  expect(raw.status).toBe(400);
  expect(await raw.json()).toMatchObject({
    kind: "invalid",
    path: "request.commands[1].command.value",
  });
  const result = await call(pushEndpoint, input, peer.options);

  expect(peer.effects()).toStrictEqual([]);
  expect(result).toMatchObject({
    ok: false,
    failure: { kind: "invalid", refused: true, path: "request.commands[1].command.value" },
  });
});

test("a bad middle command alone is refused; both good commands are resent once and answered", async () => {
  const peer = await server();
  const sent: number[][] = [];

  const app = await launch(
    {
      ...peer.network,
      push: (input) => {
        sent.push(input.commands.map((each) => each.id));

        return peer.network.push(input);
      },
    },
    [queued(1, 10), queued(2, -1), queued(3, 30)]
  );

  await advance(app, POLL_MS);
  expect(sent).toStrictEqual([
    [1, 2, 3],
    [1, 3],
  ]);
  expect(peer.effects()).toStrictEqual([
    ["r1", 10, 2],
    ["r3", 30, 3],
  ]);
  expect(app.answers.map((each) => [each.id, each.state.kind])).toStrictEqual([
    [2, "done"],
    [1, "done"],
    [3, "done"],
  ]);
  expect(app.runtime.model().commands[1]?.state).toMatchObject({
    kind: "done",
    outcome: {
      kind: "failed",
      reason:
        "request.commands[1].command.value: expected an integer from 0 to 1.7976931348623157e+308, got -1",
    },
  });
  expect((await app.stored.port.load()).commands).toHaveLength(3);
  expect(app.logs).toContain("push.failed");
  expect(app.runtime.faults).toStrictEqual([]);
});

test("a lost earlier outcome survives a 400 naming a different command", async () => {
  const peer = await server();
  let lose = true;
  let reveal = false;
  const sent: number[][] = [];

  const app = await launch({
    ...peer.network,
    pull: async (input) => {
      const result = await peer.network.pull(input);

      return result.ok && !reveal ? { ok: true, value: { ...result.value, receipts: [] } } : result;
    },
    push: async (input) => {
      sent.push(input.commands.map((each) => each.id));
      const result = await peer.network.push(input);

      if (lose) {
        lose = false;

        return { ok: false, failure: { kind: "offline", message: "reply lost after act" } };
      }

      reveal = true;

      return result;
    },
  });

  app.runtime.command({ name: "put", value: 10 });
  await app.runtime.settle();
  app.runtime.command({ name: "put", value: -1 });
  await app.runtime.settle();
  await advance(app, POLL_MS);
  await advance(app, POLL_MS * 3);
  expect(peer.effects()).toStrictEqual([["r1", 10, 2]]);
  expect(sent.slice(0, 2)).toStrictEqual([[1], [1, 2]]);
  expect(app.runtime.model().commands.map((each) => [each.id, each.state])).toStrictEqual([
    [1, { kind: "done", outcome: { kind: "ok", resource: "r1" }, revision: 2 }],
    [
      2,
      {
        kind: "done",
        outcome: {
          kind: "failed",
          reason:
            "request.commands[1].command.value: expected an integer from 0 to 1.7976931348623157e+308, got -1",
        },
        revision: 0,
      },
    ],
  ]);
  expect(app.runtime.faults).toStrictEqual([]);
});

test("a named refusal parks an uncertain command durably, never resends it, and a named pull reconciles it", async () => {
  const peer = await server();
  // An older contract accepted this intent. Its reply was lost before the new contract tightened value's range.
  await peer.act("page", 1, -1);
  const sent: number[][] = [];

  const app = await launch(
    {
      ...peer.network,
      pull: async (input) => {
        const result = await peer.network.pull(input);

        return result.ok ? { ok: true, value: { ...result.value, receipts: [] } } : result;
      },
      push: (input) => {
        sent.push(input.commands.map((each) => each.id));

        return peer.network.push(input);
      },
    },
    [{ ...queued(1, -1), state: { kind: "unknown", failure: "reply lost" } }, queued(2, 20)]
  );

  await advance(app, POLL_MS * 3);
  expect(app.runtime.model().commands[0]?.state).toMatchObject({ kind: "unknown", parked: true });
  expect(sent).toStrictEqual([[1, 2], [2]]);
  expect((await app.stored.port.load()).commands[0]?.state).toMatchObject({
    kind: "unknown",
    parked: true,
  });

  let reveal = false;
  const reloadedPushes: number[][] = [];

  const reloaded = await launch(
    {
      ...peer.network,
      pull: async (input) => {
        const result = await peer.network.pull(input);

        return result.ok && !reveal
          ? { ok: true, value: { ...result.value, receipts: [] } }
          : result;
      },
      push: (input) => {
        reloadedPushes.push(input.commands.map((each) => each.id));

        return peer.network.push(input);
      },
    },
    [],
    database({ factory: app.stored.factory, name: app.stored.name })
  );

  expect(reloaded.runtime.model().commands[0]?.state).toMatchObject({
    kind: "unknown",
    parked: true,
  });
  expect(reloadedPushes).toStrictEqual([]);
  reveal = true;
  await advance(reloaded, POLL_MS);
  expect(reloaded.runtime.model().commands[0]?.state).toStrictEqual({
    kind: "done",
    outcome: { kind: "ok", resource: "r1" },
    revision: 2,
  });
  expect(reloadedPushes).toStrictEqual([]);
  expect(peer.pulls.flat()).toContainEqual({ client: "page", id: 1 });
  expect(peer.effects()).toStrictEqual([
    ["r1", -1, 2],
    ["r2", 20, 3],
  ]);
  expect(reloaded.runtime.faults).toStrictEqual([]);
});

test.each(["forbidden", "conflict"] as const)(
  "a matching kit %s is final for a never-uncertain command",
  async (kind) => {
    const peer = await server();
    peer.refuse(kind);

    const result = await call(
      pushEndpoint,
      {
        client: "page",
        dataset: "dataset-a",
        since: 1,
        commands: [{ id: 1, command: { name: "put", value: 10 } }],
      },
      peer.options
    );

    expect(result).toMatchObject({ ok: false, failure: { kind, refused: true } });
    const app = await launch(peer.network, [queued(1, 10)]);
    expect(app.answers.map((each) => each.state)).toStrictEqual([
      { kind: "done", revision: 0, outcome: { kind: "failed", reason: "not allowed now" } },
    ]);
    expect((await app.stored.port.load()).commands[0]?.state).toStrictEqual(app.answers[0]?.state);
    expect(peer.effects()).toStrictEqual([]);
  }
);

test.each(["forbidden", "conflict"] as const)(
  "a kit %s after a lost reply and reload cannot overwrite prior uncertainty",
  async (kind) => {
    const peer = await server();

    const first = await launch({
      ...peer.network,
      push: async (input) => {
        await peer.network.push(input);

        return { ok: false, failure: { kind: "offline", message: "reply lost after act" } };
      },
    });

    first.runtime.command({ name: "put", value: 10 });
    await first.runtime.settle();
    peer.refuse(kind);

    const app = await launch(
      {
        ...peer.network,
        pull: async (input) => {
          const result = await peer.network.pull(input);

          return result.ok ? { ok: true, value: { ...result.value, receipts: [] } } : result;
        },
      },
      [],
      database({ factory: first.stored.factory, name: first.stored.name })
    );

    expect(app.runtime.model().commands[0]?.state.kind).toBe("unknown");
    expect(app.answers).toStrictEqual([]);

    // Receipt reconciliation is allowed even while the write is forbidden.
    const reloaded = await launch(
      peer.network,
      [],
      database({ factory: app.stored.factory, name: app.stored.name })
    );

    expect(reloaded.runtime.model().commands[0]?.state).toMatchObject({
      kind: "done",
      outcome: { kind: "ok", resource: "r1" },
    });
    expect(peer.effects()).toStrictEqual([["r1", 10, 2]]);
  }
);

test("an envelope 400 restores queued intent and reload with a matching contract acts once", async () => {
  const peer = await server();

  const app = await launch(
    {
      ...peer.network,
      push: (input) => {
        const futureRequest = { ...input, future: true };

        return call(pushEndpoint, futureRequest, peer.options);
      },
    },
    [queued(1, 10), queued(2, 20)]
  );

  expect(app.runtime.model().connection.kind).toBe("incompatible");
  expect(app.runtime.model().commands.map((each) => each.state)).toStrictEqual([
    { kind: "queued" },
    { kind: "queued" },
  ]);
  expect(peer.effects()).toStrictEqual([]);
  expect(app.logs).toContain("push.failed");

  const reloaded = await launch(
    peer.network,
    [],
    database({ factory: app.stored.factory, name: app.stored.name })
  );

  expect(reloaded.answers.map((each) => each.id)).toStrictEqual([1, 2]);
  expect(peer.effects()).toStrictEqual([
    ["r1", 10, 2],
    ["r2", 20, 3],
  ]);
});

test("an unreadable 200 is unknown and incompatible; reload replays the original ledger receipt", async () => {
  const peer = await server();

  const incompatibleOutput = endpoint(
    "POST",
    "/api/push",
    pushInput,
    object({ future: literal(true) })
  );

  let failureKind = "";

  const app = await launch(
    {
      ...peer.network,
      push: async (input) => {
        const result = await call(incompatibleOutput, input, peer.options);

        if (result.ok) {
          throw new Error("the incompatible response schema accepted the reply");
        }

        failureKind = result.failure.kind;

        return result;
      },
    },
    [queued(1, 10)]
  );

  expect(failureKind).toBe("unreadable");
  expect(app.runtime.model().commands[0]?.state.kind).toBe("unknown");
  expect(app.runtime.model().connection.kind).toBe("incompatible");
  expect(app.answers).toStrictEqual([]);

  const reloaded = await launch(
    peer.network,
    [],
    database({ factory: app.stored.factory, name: app.stored.name })
  );

  expect(reloaded.runtime.model().commands[0]?.state).toStrictEqual({
    kind: "done",
    outcome: { kind: "ok", resource: "r1" },
    revision: 2,
  });
  expect(values(reloaded.runtime.model().replica)).toStrictEqual([["r1", 10, 2]]);
  expect(peer.effects()).toStrictEqual([["r1", 10, 2]]);
});

test("a handler returns a conflict receipt after an earlier command acted, and replay never repeats that effect", async () => {
  const peer = await server();
  await peer.act("page", 2, 20);

  const input = {
    client: "page",
    dataset: "dataset-a",
    since: 1,
    commands: [
      { id: 1, command: { name: "put" as const, value: 10 } },
      { id: 2, command: { name: "put" as const, value: 99 } },
    ],
  };

  const expected = {
    ok: true,
    value: {
      receipts: [
        { id: 1, outcome: { kind: "ok", resource: "r1" }, revision: 3 },
        { id: 2, outcome: { kind: "failed", reason: "conflict" }, revision: 2 },
      ],
      revision: 3,
    },
  };

  expect(await call(pushEndpoint, input, peer.options)).toStrictEqual(expected);
  expect(await call(pushEndpoint, input, peer.options)).toStrictEqual(expected);
  expect(peer.effects()).toStrictEqual([
    ["r1", 10, 3],
    ["r2", 20, 2],
  ]);
});

/** A loopback intermediary answers real fetches with status/body combinations, never a replacement fetch. */
async function intermediary(
  status: number,
  body: string,
  type = "application/json",
  retryAfter?: string
) {
  const web = createServer((_request, response) => {
    response.writeHead(status, {
      "content-type": type,
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    });
    response.end(body);
  });

  await new Promise<void>((resolve) => {
    web.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        web.closeAllConnections();
        web.close(() => resolve());
      })
  );
  const address = web.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- node's public address() union includes Unix sockets
  if (address === null || typeof address === "string") {
    throw new Error("no loopback address");
  }

  return { base: `http://127.0.0.1:${address.port}` };
}

test.each([
  { status: 403, body: "<html>proxy denied</html>", type: "text/html" },
  { status: 409, body: "<html>proxy denied</html>", type: "text/html" },
  { status: 403, body: '{"message":"proxy denied"}', type: "application/json" },
  { status: 409, body: '{"message":"proxy denied"}', type: "application/json" },
  { status: 403, body: '{"kind":"invalid","message":"mismatched kind"}', type: "application/json" },
  { status: 409, body: '{"kind":"invalid","message":"mismatched kind"}', type: "application/json" },
])(
  "HTTP $status without a matching kit kind is never final: $body",
  async ({ status, body, type }) => {
    const options = await intermediary(status, body, type);

    const result = await call(echo, { text: "probe" }, options);
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: status === 403 ? "forbidden" : "conflict" },
    });

    const app = await launch(
      {
        pull: async () => ({ ok: true, value: { patch: patch(1, [], true), receipts: [] } }),
        push: (input) => call(pushEndpoint, input, options),
      },
      [queued(1, 10)]
    );

    expect(app.runtime.model().commands[0]?.state.kind).toBe("unknown");
    expect(app.answers).toStrictEqual([]);
  }
);

test.each([408, 429])("HTTP %i retries no earlier than Retry-After", async (status) => {
  const options = await intermediary(status, '{"message":"busy"}', "application/json", "9");
  expect(await call(echo, { text: "probe" }, options)).toMatchObject({
    ok: false,
    failure: { kind: "unavailable", retryAfterMs: 9000 },
  });
  let attempts = 0;

  const app = await launch(
    {
      pull: async () => ({ ok: true, value: { patch: patch(1, [], true), receipts: [] } }),
      push: (input) => {
        attempts++;

        return call(pushEndpoint, input, options);
      },
    },
    [queued(1, 10)]
  );

  await advance(app, 8999);
  expect(attempts).toBe(1);
  await advance(app, 9000);
  expect(attempts).toBe(2);
  expect(app.runtime.model().commands[0]?.state.kind).toBe("unknown");
});

test.each([404, 405, 413])(
  "HTTP %i stops as incompatible, with intent unknown and logged",
  async (status) => {
    const options = await intermediary(status, '{"message":"wrong endpoint"}');

    const app = await launch(
      {
        pull: async () => ({ ok: true, value: { patch: patch(1, [], true), receipts: [] } }),
        push: (input) => call(pushEndpoint, input, options),
      },
      [queued(1, 10)]
    );

    expect(app.runtime.model().connection.kind).toBe("incompatible");
    expect(app.runtime.model().commands[0]?.state.kind).toBe("unknown");
    expect(app.logs).toContain("push.failed");
  }
);

test.each(["not JSON", '{"text":'])(
  "a JSON-typed successful reply that breaks JSON is unreadable: %s",
  async (body) => {
    const options = await intermediary(200, body);
    expect(await call(echo, { text: "x" }, options)).toMatchObject({
      ok: false,
      failure: { kind: "unreadable" },
    });
  }
);

test("a successful HTML login page is signed-out, not an unreadable origin reply", async () => {
  const options = await intermediary(200, "<html>sign in</html>", "text/html");
  expect(await call(echo, { text: "x" }, options)).toMatchObject({
    ok: false,
    failure: { kind: "signed-out" },
  });
});

test("split UTF-8 reaches the handler intact", async () => {
  const peer = await server(24);
  const bytes = Buffer.from(JSON.stringify({ text: "é€x" }));
  const split = bytes.indexOf(Buffer.from("€")) + 1;
  const consumed = deferred<void>();
  const requests = channel("http.server.request.start");

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnostics_channel publishes an untyped Node event
  const observe = (message: unknown) => {
    if (
      !(message instanceof Object) ||
      !("request" in message) ||
      !(message.request instanceof IncomingMessage)
    ) {
      throw new Error("http.server.request.start did not publish an IncomingMessage");
    }

    if (message.request.url === "/api/echo") {
      // Observe the real iterator's first read before releasing the next wire chunk. Pausing prevents this listener
      // from draining the body while authorization is still running. No delay or assumed TCP packet boundary.
      message.request.once("data", () => consumed.resolve());
      message.request.pause();
    }
  };

  requests.subscribe(observe);

  try {
    const response = new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const send = request(
          new URL("api/echo", peer.web.url),
          {
            method: "POST",
            headers: {
              ...peer.headers,
              "content-type": "application/json",
              "content-length": String(bytes.length),
            },
          },
          (reply) => {
            let body = "";
            reply.setEncoding("utf-8");
            reply.on("data", (chunk: string) => {
              body += chunk;
            });
            reply.on("end", () => resolve({ status: reply.statusCode, body }));
          }
        );

        send.on("error", reject);
        send.write(bytes.subarray(0, split));
        void consumed.promise.then(() => send.end(bytes.subarray(split)));
      }
    );

    expect(await response).toStrictEqual({ status: 200, body: '{"text":"é€x"}' });
  } finally {
    requests.unsubscribe(observe);
  }
});

test("the body cap measures UTF-8 bytes, not code units", async () => {
  const peer = await server(24);
  // 23 UTF-16 units, but 35 wire bytes: rejected before the handler runs.
  const over = await call(echo, { text: "é".repeat(12) }, peer.options);
  expect(peer.echoCalls()).toBe(0);
  expect(over).toMatchObject({ ok: false, failure: { kind: "invalid", refused: true } });
});
