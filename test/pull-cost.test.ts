import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

import { expect, test } from "vitest";

import { createPull } from "../src/server/pull.ts";
import type { Pulled } from "../src/server/pull.ts";

// What one paged pull costs the server, counted rather than timed: how often the whole reply is encoded, how often a
// row is read, and how many statements run. A page that shrinks to its byte cap must not rebuild the reply per guess.

type Note = { id: string; score: number; revision: number };

const ROWS = 2000;
const LIMITS = { firstRows: 2000, pageRows: 2000, maxRows: 5000, maxBytes: 40_000 };

/** The real database, with every statement it prepares counted when it runs. */
class Counted extends DatabaseSync {
  runs = 0;

  override prepare(sql: string): StatementSync {
    const statement = super.prepare(sql);

    // Each run counted, then the statement's own method; the statement is the real one.
    for (const name of ["all", "get"] as const) {
      const run = statement[name].bind(statement);

      Object.defineProperty(statement, name, {
        value: (...args: SQLInputValue[]) => {
          this.runs++;

          return run(...args);
        },
      });
    }

    return statement;
  }
}

function store() {
  const db = new Counted(":memory:");
  db.exec(`create table notes(id text primary key, score integer not null, revision integer not null,
    deleted integer not null default 0);
    create index notes_order on notes(score, id);`);
  const insert = db.prepare("insert into notes(id, score, revision) values (?, ?, 1)");

  db.exec("begin");

  // Three rows per score, so pages end inside order groups and coverage has to look past them.
  for (let at = 0; at < ROWS * 2; at++) {
    insert.run(`note-${String(at).padStart(5, "0")}`, Math.floor(at / 3));
  }

  db.exec("commit");

  return db;
}

function app(reshape = false) {
  const db = store();
  const reads = new Map<string, number>();
  let builds = 0;

  const pull = createPull({
    db,
    dataset: () => "dataset",
    revision: () => 1,
    paged: {
      table: "notes",
      order: ["score", "id"],
      version: 1,
      live: "deleted = 0",
      read: (row: Record<string, SQLOutputValue>): Note => {
        const id = String(row.id);
        reads.set(id, (reads.get(id) ?? 0) + 1);

        return { id, score: Number(row.score), revision: Number(row.revision) };
      },
      through: (values) => String(values[0]),
    },
    unpaged: () => ({}),
    receipts: { read: () => [], names: () => [] },
    limits: LIMITS,
    respond: (pulled: Pulled<Note, Record<string, never>, never>) => {
      if (pulled.rows.length > 0) {
        builds++;
      }

      return {
        dataset: pulled.dataset,
        revision: pulled.revision,
        reset: pulled.reset,
        // A reply that doesn't carry its rows as they were read: their own encodings don't add up to it.
        notes: reshape
          ? pulled.rows.map((each) => [each.id, each.score, each.revision])
          : pulled.rows,
        page: pulled.page,
      };
    },
  });

  return {
    pull: (page: string | null, since: number) =>
      pull.pull({ dataset: since === 0 ? null : "dataset", since, page }, null),
    cost: () => {
      const cost = {
        builds,
        statements: db.runs,
        reads: [...reads.values()].reduce((sum, each) => sum + each, 0),
        reread: [...reads.values()].some((each) => each > 1),
      };

      builds = 0;
      db.runs = 0;
      reads.clear();

      return cost;
    },
  };
}

test("a page shrunk to its byte cap is encoded whole once, each row read once, with its counts run once", () => {
  const server = app();
  server.cost();

  const first = server.pull(null, 0);
  const firstCost = server.cost();
  const next = first.pulled.page?.next ?? null;
  const older = server.pull(next, 1);
  const olderCost = server.cost();

  for (const [reply, cost] of [
    [first, firstCost],
    [older, olderCost],
  ] as const) {
    expect(reply.bytes).toBe(Buffer.byteLength(JSON.stringify(reply.reply)));
    expect(reply.bytes).toBeLessThanOrEqual(LIMITS.maxBytes);
    // The cap binds: the page shrank below what it fetched.
    expect(reply.pulled.rows.length).toBeLessThan(LIMITS.firstRows);
    expect(cost.builds).toBe(1);
    expect(cost.reread).toBe(false);
    expect(cost.reads).toBeLessThanOrEqual(LIMITS.pageRows + 1);
  }

  // Reset: the newest page and the count of every row. Older page: the delta, the page, every row's count, the rows
  // at or above the cursor, and the group above the cursor (the delta alone ends inside the cursor's group). Every
  // other candidate's groups are read from the rows it fetched.
  expect(first.pulled.page?.through).not.toBeNull();
  expect([firstCost.statements, olderCost.statements]).toStrictEqual([2, 5]);
  expect(next).not.toBeNull();
  expect(first.pulled.page?.total).toBe(ROWS * 2);
  expect(first.pulled.page?.held).toBe(first.pulled.rows.length);
  expect(older.pulled.page?.held).toBe(first.pulled.rows.length + older.pulled.rows.length);
});

test("a reply that reshapes its rows is still within its caps, chosen by building it whole", () => {
  const plain = app();
  const reshaped = app(true);
  const reply = reshaped.pull(null, 0);

  expect(reply.bytes).toBeLessThanOrEqual(LIMITS.maxBytes);
  expect(reshaped.cost().builds).toBeGreaterThan(1);
  // Arrays encode smaller than objects: more rows fit than in the plain reply.
  expect(reply.pulled.rows.length).toBeGreaterThan(plain.pull(null, 0).pulled.rows.length);
});
