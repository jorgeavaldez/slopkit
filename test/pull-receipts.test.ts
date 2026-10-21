import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "vitest";

import { check, object, string } from "../src/schema.ts";
import { Ledger } from "../src/server/ledger.ts";
import { createPull } from "../src/server/pull.ts";
import type { PullLimits } from "../src/server/pull.ts";

const SCHEMA = `
  create table meta(dataset text not null, revision integer not null);
  create table notes(id text primary key, score integer not null, revision integer not null,
    deleted integer not null default 0);
  create table settings(id text primary key, body text not null, revision integer not null);
  create table commands(principal text not null, client text not null, id integer not null, name text not null,
    args text not null, state text not null, outcome text, revision integer, created_at text not null,
    primary key (principal, client, id));`;

type Note = { id: string; score: number };

function app(limits: PullLimits) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("insert into meta values (?, 0)").run(randomUUID());
  const head = () => db.prepare("select dataset, revision from meta").get();
  let writing: number | undefined;

  const transaction = <T>(body: () => T): T => {
    if (db.isTransaction) {
      return body();
    }

    db.exec("begin immediate");

    try {
      const out = body();
      db.exec("commit");

      return out;
    } catch (error) {
      db.exec("rollback");
      throw error;
    } finally {
      writing = undefined;
    }
  };

  const stamp = () => {
    if (writing === undefined) {
      db.prepare("update meta set revision = revision + 1").run();
      writing = Number(head()?.revision);
    }

    return writing;
  };

  const ledger = new Ledger<{ note: string }>({
    db,
    transaction,
    stamp,
    encode: (receipt) => JSON.stringify(receipt),
    decode: (text) => {
      const parsed = check(object({ note: string() }), JSON.parse(text));

      if (!parsed.ok) {
        throw new Error(parsed.error.message);
      }

      return parsed.value;
    },
  });

  const put = (rows: [string, number][]) => {
    const at = stamp();

    for (const [id, score] of rows) {
      db.prepare(
        "insert into notes values (?, ?, ?, 0) on conflict(id) do update set score = excluded.score, revision = excluded.revision"
      ).run(id, score, at);
    }
  };

  const write = async (client: string, id: number, note: [string, number]) => {
    await ledger.run(
      { principal: "person", client, id },
      { name: "write", args: "{}" },
      {
        local: () => {
          put([note]);

          return { note: note[0] };
        },
        remote: async () => {
          throw new Error("local only");
        },
      }
    );
  };

  const pull = createPull({
    db,
    dataset: () => String(head()?.dataset),
    revision: () => Number(head()?.revision),
    paged: {
      table: "notes",
      order: ["score", "id"],
      version: 1,
      live: "deleted = 0",
      read: (row): Note => ({ id: String(row.id), score: Number(row.score) }),
      through: (values) => String(values[0]),
    },
    unpaged: (since) => ({
      settings: db
        .prepare("select id, body from settings where revision > ?")
        .all(since)
        .map((row) => String(row.body)),
    }),
    receipts: {
      read: (ask, client: string) =>
        ask.commands === undefined
          ? ledger.receipts("person", client, ask.since).map((each) => ({ ...each, client }))
          : ledger.receiptsOf("person", ask.commands),
      names: (each) => [each.receipt.note],
    },
    limits,
    respond: (pulled) => pulled,
  });

  return { db, transaction, put, write, pull, ledger };
}

// A device that sent 300 commands over time, then reset (a schema change, a mismatch, an oversized delta): the reply
// still fits both caps, and each receipt it carries has its row.
test("a reset with many receipts stays within both caps and carries each receipt's row", async () => {
  const limits = { firstRows: 5, pageRows: 10, maxRows: 50, maxBytes: 20_000 };
  const store = app(limits);

  for (let at = 1; at <= 300; at++) {
    await store.write("dev", at, [`n${at}`, at]);
  }

  const { bytes, pulled } = store.pull.pull({ dataset: null, since: 0, page: null }, "dev");
  expect(pulled.rows.length + pulled.unpaged.settings.length).toBeLessThanOrEqual(limits.maxRows);
  expect(bytes).toBeLessThanOrEqual(limits.maxBytes);
  expect(pulled.page?.held).toBeGreaterThan(0);
  expect(pulled.receipts.length).toBeGreaterThan(0);

  for (const receipt of pulled.receipts) {
    expect(pulled.rows.map((row) => row.id)).toContain(receipt.receipt.note);
  }
});

test("receipts and their rows under a tight byte cap still fit", async () => {
  const store = app({ firstRows: 2, pageRows: 3, maxRows: 16, maxBytes: 1000 });

  for (let at = 1; at <= 20; at++) {
    await store.write("dev", at, [`n${at}`, at]);
  }

  const { bytes, pulled } = store.pull.pull({ dataset: null, since: 0, page: null }, "dev");
  expect(pulled.rows.length).toBeLessThanOrEqual(16);
  expect(bytes).toBeLessThanOrEqual(1000);
  expect(pulled.receipts.length).toBeGreaterThan(0);
});

// The page names what it waits on, its earlier pages' commands included: those receipts, with their rows, and no others.
test("a request naming commands gets exactly those receipts, from any of the person's pages", async () => {
  const store = app({ firstRows: 2, pageRows: 3, maxRows: 16, maxBytes: 8192 });
  await store.write("earlier-page", 1, ["old-effect", -50]);
  await store.write("this-page", 1, ["new-effect", -60]);
  await store.write("this-page", 2, ["other", 70]);
  // Another person's command under the same page name and number is never theirs to read.
  await store.ledger.run(
    { principal: "someone-else", client: "earlier-page", id: 2 },
    { name: "write", args: "{}" },
    { local: () => ({ note: "theirs" }), remote: async () => ({ note: "theirs" }) }
  );

  const { pulled } = store.pull.pull(
    {
      dataset: null,
      since: 0,
      page: null,
      commands: [
        { client: "earlier-page", id: 1 },
        { client: "earlier-page", id: 2 },
        { client: "this-page", id: 1 },
      ],
    },
    "this-page"
  );

  expect(pulled.receipts.map((each) => [each.client, each.id])).toStrictEqual([
    ["earlier-page", 1],
    ["this-page", 1],
  ]);
  expect(pulled.rows.map((row) => row.id)).toStrictEqual(
    expect.arrayContaining(["old-effect", "new-effect"])
  );
});

// What no reply can hold within the caps (the other tables alone are over them) is refused, never sent over the cap.
test("a minimum reply over the caps is refused, not sent", () => {
  const store = app({ firstRows: 2, pageRows: 3, maxRows: 16, maxBytes: 500 });
  store.transaction(() => {
    store.put([["n1", 1]]);
    store.db.prepare("insert into settings values ('big', ?, 1)").run("x".repeat(1000));
  });
  expect(() => store.pull.pull({ dataset: null, since: 0, page: null }, "dev")).toThrow(
    /can't fit/
  );
});
