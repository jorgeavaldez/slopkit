import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { IDBFactory } from "fake-indexeddb";
import { expect, onTestFinished, test } from "vitest";

import { syncApi } from "../src/api.ts";
import { Replaced } from "../src/client.ts";
import { array, boolean, nullable, number, object, string } from "../src/schema.ts";
import type { Infer, Schema } from "../src/schema.ts";
import { createSync, table } from "../src/sync.ts";
import type { Key, Pending, Replica } from "../src/sync.ts";
import { lifting } from "../src/web/lift.ts";
import { indexedReplica } from "../src/web/replica.ts";
import { createRuntime } from "../src/web/runtime.ts";
import type { RuntimeEnv } from "../src/web/runtime.ts";
import { command, outcome, pending, serverSchema } from "./sync-fixture.ts";
import type { Command, Outcome } from "./sync-fixture.ts";

const fields = {
  id: string(),
  value: number({ integer: true }),
  deleted: boolean(),
  revision: number({ integer: true, min: 0 }),
};

const olderRow = object(fields, { strict: true });
const currentRow = object({ ...fields, labels: array(string()) }, { strict: true });

type OlderRow = Infer<typeof olderRow>;

type Row = Infer<typeof currentRow>;

type Server = Infer<typeof serverSchema>;

type Tables<R> = { rows: ReadonlyMap<Key, R>; notes: ReadonlyMap<Key, R> };

type Patch<R> = { rows: R[]; notes: R[] };

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- lifts are the boundary from a previous release's stored row to this release's row
type Lift = (row: unknown) => unknown;

const waiting: [Pending<Command, Outcome>, Pending<Command, Outcome>, Pending<Command, Outcome>] = [
  {
    client: "page_before",
    id: 1,
    dataset: "dataset-a",
    since: 5,
    command: { name: "put", id: "a", value: 25 },
    at: 1,
    state: { kind: "queued" },
  },
  {
    client: "page_before",
    id: 2,
    dataset: "dataset-a",
    since: 7,
    command: { name: "put", id: "b", value: 35 },
    at: 2,
    state: { kind: "queued" },
  },
  {
    client: "page_before",
    id: 3,
    dataset: "dataset-a",
    since: 6,
    command: { name: "remote", id: "c", value: 45 },
    at: 3,
    state: { kind: "unknown", failure: "reply lost", parked: true },
  },
];

const oldRows: OlderRow[] = [
  { id: "a", value: 10, revision: 6, deleted: false },
  { id: "b", value: 20, revision: 7, deleted: false },
];

const oldNotes: OlderRow[] = [{ id: "n", value: 30, revision: 7, deleted: false }];

const liftedRows: Row[] = [
  { id: "a", value: 10, revision: 6, deleted: false, labels: [] },
  { id: "b", value: 20, revision: 7, deleted: false, labels: [] },
];

const liftedNotes: Row[] = [{ id: "n", value: 30, revision: 7, deleted: false, labels: ["note"] }];

const lifts: Record<"rows" | "notes", Lift> = {
  rows: (raw) => ({ ...olderRow.parse(raw), labels: [] }),
  notes: (raw) => ({ ...olderRow.parse(raw), labels: ["note"] }),
};

function fixture() {
  const factory = new IDBFactory();
  const connections = new Set<IDBDatabase>();

  const close = () => {
    for (const connection of connections) {
      connection.close();
    }
  };

  onTestFinished(close);

  function open<R extends OlderRow>(
    schema: Schema<R>,
    options: { version?: number; names?: ("rows" | "notes")[]; lifts?: Partial<typeof lifts> } = {}
  ) {
    const empty: Tables<R> = { rows: new Map(), notes: new Map() };

    const tables = (options.names ?? ["rows", "notes"]).map((name) =>
      table<Tables<R>, Patch<R>, R>({
        name,
        schema,
        rows: (patch) => patch[name],
        key: (row) => row.id,
        gone: (row) => row.deleted,
        get: (all) => all[name],
        set: (all, rows) => ({ ...all, [name]: rows }),
      })
    );

    const settings = {
      factory,
      name: "replica-upgrade",
      version: options.version ?? 1,
      tables,
      empty,
      server: serverSchema,
      pending,
      ...(options.lifts === undefined ? {} : { lifts: lifting(options.lifts) }),
      interfere: (_what: "commit" | "keep" | "drop", transaction: IDBTransaction) => {
        connections.add(transaction.db);
      },
    };

    const port = indexedReplica<Tables<R>, Patch<R>, Server, Command, Outcome>(settings);

    return { port, tables, empty };
  }

  return { factory, open, close };
}

function copy<R extends OlderRow>(rows: R[], notes: R[], revision = 7): Replica<Tables<R>, Server> {
  const keys = (items: R[]) => new Map(items.map((row) => [row.id, row]));

  return {
    dataset: "dataset-a",
    revision,
    server: { version: "1.0.0" },
    tables: { rows: keys(rows), notes: keys(notes) },
  };
}

function reset<T, S>(replica: Replica<T, S>) {
  return { replica, reset: true, base: 0, replaces: null, ops: [] };
}

async function seed(
  current: ReturnType<ReturnType<typeof fixture>["open"]>,
  replica: Replica<Tables<OlderRow>, Server> = copy(oldRows, oldNotes)
) {
  await current.port.load();
  await current.port.commit(reset(replica));

  for (const intent of waiting) {
    await current.port.keep(intent);
  }
}

function expectRows<R>(replica: Replica<Tables<R>, Server>, rows: R[], notes: R[]) {
  expect([...replica.tables.rows.values()]).toStrictEqual(rows);
  expect([...replica.tables.notes.values()]).toStrictEqual(notes);
}

test("an offline upgrade lifts every table, keeps its revision, and durably owes a reset", async () => {
  const f = fixture();
  const stale = f.open(olderRow);
  await stale.port.load();
  await stale.port.forget();
  const before = f.open(olderRow);
  await seed(before);
  const after = f.open(currentRow, { lifts });
  const loaded = await after.port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, liftedRows, liftedNotes);
  expect(loaded.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(loaded).toMatchObject({ restart: "paged" });

  // Another open has no lifts: both the rows and their current shapes must already be on disk.
  const reopened = await f.open(currentRow).port.load();
  expectRows(reopened.replica, liftedRows, liftedNotes);
  expect(reopened.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(reopened).toMatchObject({ restart: "paged" });
  expect(reopened.commands).toStrictEqual(waiting);

  // An upgrade does not move the forget fence in either direction.
  await expect(stale.port.keep({ ...waiting[0], id: 4 })).rejects.toBeInstanceOf(Replaced);
  await expect(before.port.keep({ ...waiting[0], id: 4 })).resolves.toBeUndefined();
});

test.each(["rows", "notes"] as const)(
  "an unreadable lifted row in %s discards the entire copy, not just that table",
  async (name) => {
    const f = fixture();
    await seed(f.open(olderRow));

    const invalid: Lift = (raw) => {
      const row = olderRow.parse(raw);

      return row.id === "b" || row.id === "n" ? { ...row, labels: [42] } : { ...row, labels: [] };
    };

    const loaded = await f.open(currentRow, { lifts: { ...lifts, [name]: invalid } }).port.load();
    expect(loaded.commands).toStrictEqual(waiting);
    expectRows(loaded.replica, [], []);
    expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
    const unchanged = await f.open(olderRow).port.load();
    expectRows(unchanged.replica, oldRows, oldNotes);
    const reopened = await f.open(currentRow).port.load();
    expectRows(reopened.replica, [], []);
    expect(reopened.commands).toStrictEqual(waiting);
  }
);

test("a changed table without a lift cannot leave a different table lifted", async () => {
  const f = fixture();
  await seed(f.open(olderRow));
  const loaded = await f.open(currentRow, { lifts: { rows: lifts.rows } }).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, [], []);
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
});

test("lifting a partial copy keeps its revision, rows and partial coverage while owing a reset", async () => {
  const f = fixture();

  const history = {
    kind: "partial",
    next: "older:a:10",
    through: "10",
    held: 2,
    total: 9,
  } as const;

  await seed(f.open(olderRow), { ...copy(oldRows, oldNotes), history });
  const loaded = await f.open(currentRow, { lifts }).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, liftedRows, liftedNotes);
  expect(loaded.replica).toMatchObject({
    dataset: "dataset-a",
    revision: 7,
    server: null,
    history,
  });
  expect(loaded).toMatchObject({ restart: "paged" });
  const reopened = await f.open(currentRow).port.load();
  expectRows(reopened.replica, liftedRows, liftedNotes);
  expect(reopened.replica).toMatchObject({ revision: 7, history });
  expect(reopened).toMatchObject({ restart: "paged" });
  expect(reopened.commands).toStrictEqual(waiting);
});

test("adding a table keeps liftable old rows and opens the new table empty", async () => {
  const f = fixture();
  await seed(f.open(olderRow, { names: ["rows"] }), copy(oldRows, []));
  f.close();
  const identity: Lift = (raw) => olderRow.parse(raw);

  const options = { version: 2, lifts: { rows: identity } };
  const loaded = await f.open(olderRow, options).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, oldRows, []);
  expect(loaded.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(loaded).toMatchObject({ restart: "paged" });
  const reopened = await f.open(olderRow, { version: 2, lifts: {} }).port.load();
  expectRows(reopened.replica, oldRows, []);
  expect(reopened.replica).toMatchObject({ dataset: "dataset-a", revision: 7 });
  expect(reopened).toMatchObject({ restart: "paged" });
  expect(reopened.commands).toStrictEqual(waiting);
});

test("adding a table with lifts but none for it keeps the existing rows and opens the new table empty", async () => {
  const f = fixture();
  await seed(f.open(olderRow, { names: ["rows"] }), copy(oldRows, []));
  f.close();
  const loaded = await f.open(olderRow, { version: 2, lifts: {} }).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, oldRows, []);
  expect(loaded.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(loaded).toMatchObject({ restart: "paged" });
  const reopened = await f.open(olderRow, { version: 2, lifts: {} }).port.load();
  expectRows(reopened.replica, oldRows, []);
  expect(reopened.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(reopened).toMatchObject({ restart: "paged" });
  expect(reopened.commands).toStrictEqual(waiting);
});

test("adding a table without lifts starts the copy over and keeps waiting commands", async () => {
  const f = fixture();
  await seed(f.open(olderRow, { names: ["rows"] }), copy(oldRows, []));
  f.close();
  const loaded = await f.open(olderRow, { version: 2 }).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, [], []);
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
  expect(loaded.restart).toBeUndefined();
});

test("without lifts a changed row shape starts over and keeps waiting commands at their own revisions", async () => {
  const f = fixture();
  await seed(f.open(olderRow));
  const loaded = await f.open(currentRow).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, [], []);
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
});

test("an older reader starts over on a newer release's rows and keeps its outbox", async () => {
  const f = fixture();
  const newer = f.open(currentRow);
  await newer.port.load();
  await newer.port.commit(reset(copy(liftedRows, liftedNotes)));

  for (const intent of waiting) {
    await newer.port.keep(intent);
  }

  const loaded = await f.open(olderRow).port.load();
  expect(loaded.commands).toStrictEqual(waiting);
  expectRows(loaded.replica, [], []);
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
});

async function network(options: { revision?: number; rows?: Row[]; notes?: Row[] } = {}) {
  const pulls: { since: number; dataset: string | null }[] = [];
  const pushes: { since: number; commands: { id: number }[] }[] = [];
  let online = false;
  const revision = options.revision ?? 9;

  const rows: Row[] = options.rows ?? [
    { id: "b", value: 200, revision, deleted: false, labels: ["server"] },
    { id: "c", value: 300, revision, deleted: false, labels: ["new"] },
  ];

  const notes: Row[] = options.notes ?? [
    { id: "m", value: 400, revision, deleted: false, labels: ["server-note"] },
  ];

  // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- the loopback HTTP server owns this asynchronous request handler
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    let since: number | undefined;

    if (url.pathname === "/api/pull") {
      const pull = object({ since: number(), dataset: nullable(string()) }).parse(
        JSON.parse(url.searchParams.get("q") ?? "null")
      );

      pulls.push(pull);
      since = pull.since;
    }

    if (url.pathname === "/api/push") {
      const chunks: string[] = [];
      request.setEncoding("utf-8");

      for await (const chunk of request) {
        chunks.push(string().parse(chunk));
      }

      pushes.push(
        object({ since: number(), commands: array(object({ id: number() })) }).parse(
          JSON.parse(chunks.join(""))
        )
      );
    }

    response.writeHead(online && url.pathname === "/api/pull" ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        online && url.pathname === "/api/pull"
          ? {
              dataset: "dataset-a",
              revision,
              reset: since === 0,
              rows: since === revision ? [] : rows,
              notes: since === revision ? [] : notes,
              server: { version: "2.0.0" },
              checksum: createHash("sha256")
                .update(JSON.stringify([rows, notes]))
                .digest("hex"),
              commands: [],
            }
          : { kind: "unavailable", message: "connection unavailable" }
      )
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's listen address is a TCP address or a pipe path at this I/O boundary
  if (address === null || typeof address === "string") {
    throw new Error("missing loopback address");
  }

  return {
    pulls,
    pushes,
    rows,
    notes,
    host: `127.0.0.1:${address.port}`,
    connect: () => {
      online = true;
    },
  };
}

function runtimeOptions(f: ReturnType<typeof fixture>, host: string) {
  const { tables, empty } = f.open(currentRow);

  const api = syncApi({
    rows: { rows: currentRow, notes: currentRow },
    server: serverSchema,
    command,
    outcome,
  });

  const sync = createSync<Tables<Row>, Patch<Row>, Server, Command, Outcome>({
    tables,
    empty,
    onlineOnly: () => false,
    resolved: () => false,
    refused: (_command, message) => ({ kind: "failed", reason: "fixture", message }),
  });

  const env: RuntimeEnv = {
    indexedDB: f.factory,
    fetch,
    socket: () => ({ onopen: null, onmessage: null, onclose: null, close: () => {} }),
    location: { protocol: "http:", host, reload: () => {} },
    document: {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    persist: () => Promise.resolve(false),
    now: () => 1000,
    monotonic: () => 1000,
    setTimeout: () => () => {},
    setInterval: () => () => {},
    random: (count) => new Uint8Array(count).fill(1),
  };

  return {
    name: "replica-upgrade",
    sync,
    api,
    replica: { version: 1, tables, empty, pending, lifts: lifting(lifts) },
    env,
  };
}

test.each(["older rows", "reopened lifted rows"])(
  "the runtime opens %s offline, pulls since zero, and replaces the copy whole",
  async (storedRows) => {
    const f = fixture();
    const n = await network();

    await seed(f.open(olderRow));

    if (storedRows === "reopened lifted rows") {
      await f.open(currentRow, { lifts }).port.load();
    }

    const options = runtimeOptions(f, n.host);
    const { tables, empty } = options.replica;

    const offline = createRuntime(options);
    onTestFinished(() => offline.stop());
    offline.start();
    await offline.settle();
    expectRows(offline.model().replica, liftedRows, liftedNotes);
    expect(offline.model().replica).toMatchObject({
      dataset: "dataset-a",
      revision: 7,
      server: null,
    });
    expect(n.pulls[0]).toStrictEqual({ since: 0, dataset: "dataset-a" });
    offline.stop();
    n.connect();
    const online = createRuntime({ ...options, replica: { version: 1, tables, empty, pending } });
    onTestFinished(() => online.stop());
    const firstOnlinePull = n.pulls.length;
    const firstOnlinePush = n.pushes.length;
    online.start();
    await online.settle();
    expect(n.pulls[firstOnlinePull]).toStrictEqual({ since: 0, dataset: "dataset-a" });
    expectRows(online.model().replica, n.rows, n.notes);
    expect(online.model().replica).toMatchObject({ dataset: "dataset-a", revision: 9 });
    const sent = n.pushes.slice(firstOnlinePush);
    expect(sent.length).toBeGreaterThan(0);
    const tapped = new Map(waiting.map((intent) => [intent.id, intent.since]));

    for (const push of sent) {
      for (const intent of push.commands) {
        expect(push.since).toBe(tapped.get(intent.id));
      }
    }

    const stored = await f.open(currentRow).port.load();
    expectRows(stored.replica, n.rows, n.notes);
    expect(stored.replica.revision).toBe(9);
    expect(stored).not.toMatchObject({ restart: "paged" });
    expect(stored.commands.map((intent) => [intent.id, intent.since])).toStrictEqual([
      [1, 5],
      [2, 7],
      [3, 6],
    ]);
  }
);

test("a tap on a lifted copy keeps that copy's real revision as its history fence", async () => {
  const f = fixture();
  const n = await network();
  await seed(f.open(olderRow));
  const runtime = createRuntime(runtimeOptions(f, n.host));
  onTestFinished(() => runtime.stop());
  runtime.start();
  await runtime.settle();
  runtime.command({ name: "put", id: "new-tap", value: 99 });
  await runtime.settle();
  const stored = await f.open(currentRow).port.load();
  expect(stored.commands.find((intent) => intent.command.id === "new-tap")).toMatchObject({
    client: runtime.client,
    dataset: "dataset-a",
    since: 7,
    command: { name: "put", id: "new-tap", value: 99 },
  });
  expect(stored.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(stored).toMatchObject({ restart: "paged" });
});

test("a command kept without since takes the lifted revision on the second offline open and later reopens", async () => {
  const f = fixture();
  const n = await network();
  const before = f.open(olderRow);
  await before.port.load();
  await before.port.commit(reset(copy(oldRows, oldNotes)));
  const legacy = { ...waiting[0] };
  delete legacy.since;
  await before.port.keep(legacy);
  const lifted = await f.open(currentRow, { lifts }).port.load();
  expect(lifted.replica).toMatchObject({ dataset: "dataset-a", revision: 7 });
  expect(lifted).toMatchObject({ restart: "paged" });

  for (let opening = 0; opening < 2; opening++) {
    const runtime = createRuntime(runtimeOptions(f, n.host));
    onTestFinished(() => runtime.stop());
    runtime.start();
    await runtime.settle();
    expect(runtime.model().commands).toMatchObject([
      { client: "page_before", id: 1, dataset: "dataset-a", since: 7 },
    ]);
    runtime.stop();
  }

  expect(n.pushes).toStrictEqual([]);
  n.connect();
  const online = createRuntime(runtimeOptions(f, n.host));
  onTestFinished(() => online.stop());
  online.start();
  await online.settle();
  expect(online.model().replica.revision).toBe(9);
  expect(n.pushes.length).toBeGreaterThan(0);

  for (const push of n.pushes) {
    expect(push.since).toBe(7);
  }
});

test("a delta or changed server facts cannot clear the lifted copy's reset debt", async () => {
  const f = fixture();
  await seed(f.open(olderRow));
  const current = f.open(currentRow, { lifts });
  const loaded = await current.port.load();
  await current.port.commit({
    replica: { ...loaded.replica, server: { version: "2.0.0" } },
    reset: false,
    base: 7,
    replaces: null,
    ops: [],
  });
  const reopened = await f.open(currentRow).port.load();
  expectRows(reopened.replica, liftedRows, liftedNotes);
  expect(reopened.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(reopened).toMatchObject({ restart: "paged" });
  expect(reopened.commands).toStrictEqual(waiting);
});

test("two tabs opening the older copy together both retain its lifted rows offline", async () => {
  const f = fixture();
  await seed(f.open(olderRow));
  const first = f.open(currentRow, { lifts });
  const second = f.open(currentRow, { lifts });
  const opened = await Promise.all([first.port.load(), second.port.load()]);

  for (const loaded of opened) {
    expectRows(loaded.replica, liftedRows, liftedNotes);
  }

  for (const loaded of opened) {
    expect(loaded.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
    expect(loaded).toMatchObject({ restart: "paged" });
    expect(loaded.commands).toStrictEqual(waiting);
  }
});

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

test.each(["replica tables only", "a legacy store too"])(
  "dropping a replica table never moves its rows into unreadable commands: %s",
  async (contents) => {
    const f = fixture();
    const before = f.open(olderRow);
    await seed(before);
    expect((await before.port.load()).unreadable).toBe(0);
    f.close();
    const previous = await requested(f.factory.open("replica-upgrade"));
    let version = previous.version + 1;
    previous.close();
    const legacy = contents === "a legacy store too";

    if (legacy) {
      const opening = f.factory.open("replica-upgrade", version);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("drafts").put({ text: "earlier draft" }, "a");
      };

      const db = await requested(opening);
      db.close();
      version++;
    }

    const names: ("rows" | "notes")[] = ["rows"];
    const options = { version, names };
    const loaded = await f.open(olderRow, options).port.load();
    expect(loaded.unreadable).toBe(legacy ? 1 : 0);
    expect(loaded.commands).toStrictEqual(waiting);
    expectRows(loaded.replica, [], []);
    expect(loaded.replica).toMatchObject({ dataset: null, revision: 0, server: null });
    const reopened = await f.open(olderRow, options).port.load();
    expect(reopened.unreadable).toBe(legacy ? 1 : 0);
    expect(reopened.commands).toStrictEqual(waiting);
    const db = await requested(f.factory.open("replica-upgrade"));

    try {
      expect(db.objectStoreNames.contains("notes")).toBe(false);
      const records = await requested(db.transaction("outbox").objectStore("outbox").getAll());
      const stored = JSON.stringify(records);
      expect(stored).not.toContain('"id":"n"');

      expect(stored.includes("earlier draft")).toBe(legacy);
    } finally {
      db.close();
    }
  }
);

test("a reset at the lifted revision replaces the disk copy and the next online open pulls a delta", async () => {
  const f = fixture();

  const rows: Row[] = [
    { id: "a", value: 10, revision: 6, deleted: false, labels: ["server-a"] },
    { id: "b", value: 20, revision: 7, deleted: false, labels: ["server-b"] },
  ];

  const notes: Row[] = [
    { id: "n", value: 30, revision: 7, deleted: false, labels: ["server-note"] },
  ];

  const n = await network({ revision: 7, rows, notes });
  await seed(f.open(olderRow));
  const lifted = await f.open(currentRow, { lifts }).port.load();
  expectRows(lifted.replica, liftedRows, liftedNotes);
  expect(lifted.replica.revision).toBe(7);
  expect(lifted).toMatchObject({ restart: "paged" });
  n.connect();
  const first = createRuntime(runtimeOptions(f, n.host));
  onTestFinished(() => first.stop());
  first.start();
  await first.settle();
  expect(n.pulls[0]).toStrictEqual({ dataset: "dataset-a", since: 0 });
  expectRows(first.model().replica, rows, notes);
  expect(first.model().replica.revision).toBe(7);
  first.stop();
  const disk = await f.open(currentRow).port.load();
  expectRows(disk.replica, rows, notes);
  expect(disk.replica.revision).toBe(7);
  expect("restart" in disk ? disk.restart : undefined).toBeUndefined();
  const pullsBefore = n.pulls.length;
  const second = createRuntime(runtimeOptions(f, n.host));
  onTestFinished(() => second.stop());
  second.start();
  await second.settle();
  expect(n.pulls[pullsBefore]).toStrictEqual({ dataset: "dataset-a", since: 7 });
  expectRows(second.model().replica, rows, notes);
  const reopened = await f.open(currentRow).port.load();
  expectRows(reopened.replica, rows, notes);
  expect("restart" in reopened ? reopened.restart : undefined).toBeUndefined();
  expect(reopened.commands.map((intent) => [intent.id, intent.since])).toStrictEqual([
    [1, 5],
    [2, 7],
    [3, 6],
  ]);
});

test("dropping a replica table without a version bump cannot turn its rows into commands at a later bump", async () => {
  const f = fixture();
  await seed(f.open(olderRow));
  const names: ("rows" | "notes")[] = ["rows"];
  const withoutTable = f.open(olderRow, { names });
  const loaded = await withoutTable.port.load();
  expect(loaded.unreadable).toBe(0);
  expect(loaded.commands).toStrictEqual(waiting);
  expect(loaded.replica).toMatchObject({ dataset: null, revision: 0 });
  await withoutTable.port.keep(waiting[0]);
  f.close();
  const db = await requested(f.factory.open("replica-upgrade"));
  const version = db.version + 1;
  db.close();
  const later = await f.open(olderRow, { version, names }).port.load();
  expect(later.unreadable).toBe(0);
  expect(later.commands).toStrictEqual(waiting);
  const reopened = await f.open(olderRow, { version, names }).port.load();
  expect(reopened.unreadable).toBe(0);
  expect(reopened.commands).toStrictEqual(waiting);
});

test("a whole repair written from the lifted revision cannot settle its reset debt", async () => {
  const f = fixture();
  await seed(f.open(olderRow));
  const current = f.open(currentRow, { lifts });
  const lifted = await current.port.load();
  expect(lifted.replica.revision).toBe(7);
  expect(lifted).toMatchObject({ restart: "paged" });
  await current.port.commit({
    replica: { ...lifted.replica, server: { version: "2.0.0" } },
    reset: true,
    base: 7,
    replaces: "dataset-a",
    ops: [],
  });
  const reopened = await f.open(currentRow).port.load();
  expectRows(reopened.replica, liftedRows, liftedNotes);
  expect(reopened.replica).toMatchObject({ dataset: "dataset-a", revision: 7, server: null });
  expect(reopened).toMatchObject({ restart: "paged" });
  expect(reopened.commands).toStrictEqual(waiting);
});
