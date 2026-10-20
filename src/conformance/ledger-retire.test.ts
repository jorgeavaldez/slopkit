/** Ledger retention: the documented table, literally; no app store. */
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, test } from "vitest";

import { Ledger } from "../server/ledger.ts";
import { deferred } from "./fixtures.ts";

const closing: (() => void)[] = [];

afterEach(() => {
  for (const close of closing.splice(0)) {
    close();
  }
});

function setup() {
  const db = new DatabaseSync(":memory:");
  closing.push(() => db.close());
  db.exec(`create table commands(
    principal text not null check(length(principal)>0), client text not null,
    id integer not null check(id>0), name text not null, args text not null,
    state text not null check(state in ('accepted','done','retired')),
    outcome text check((state='done')=(outcome is not null)),
    revision integer check((state='accepted')=(revision is null)), created_at text not null,
    primary key(principal,client,id));
    create trigger commands_never_deleted before delete on commands begin
    select raise(abort,'a command key is kept forever: retire it'); end;`);
  let revision = 0;

  const ledger = new Ledger<string>({
    db,
    transaction: (body) => {
      if (db.isTransaction) {
        return body();
      }

      db.exec("begin immediate");

      try {
        const value = body();
        db.exec("commit");

        return value;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    stamp: () => ++revision,
    encode: JSON.stringify,
    decode: JSON.parse,
  });

  return { db, ledger };
}

const key = { principal: "person", client: "page-a", id: 1 };
const command = { name: "link", args: '{"bank":null}' };

// Guard: retire only done/strictly-before; retained key and identity check precede both effect paths.
test("retirement drops the old result, never its key, identity, revision or exclusion of effects", async () => {
  const { db, ledger } = setup();
  await ledger.run(key, command, { local: () => "session-1", remote: async () => "never" });
  db.exec("update commands set created_at='2020-01-01T00:00:00.000Z'");
  expect(ledger.retire("2020-01-01T00:00:00.000Z")).toBe(0);
  expect(ledger.retire("2020-01-01T00:00:00.001Z")).toBe(1);
  expect(ledger.retire("2099-01-01T00:00:00.000Z")).toBe(0);
  expect({
    ...db
      .prepare("select principal,client,id,name,args,state,outcome,revision from commands")
      .get(),
  }).toStrictEqual({
    ...key,
    ...command,
    state: "retired",
    outcome: null,
    revision: 1,
  });

  let local = 0;
  let remote = 0;

  const act = {
    local: () => {
      local++;

      return undefined;
    },
    remote: async () => {
      remote++;

      return "session-2";
    },
  };

  expect(await ledger.run(key, command, act)).toStrictEqual({ kind: "retired" });
  expect(await ledger.run(key, { ...command, args: "{}" }, act)).toStrictEqual({
    kind: "conflict",
  });
  expect(await ledger.run(key, { ...command, name: "sync" }, act)).toStrictEqual({
    kind: "conflict",
  });
  expect([local, remote]).toStrictEqual([0, 0]);
  expect(ledger.receipts("person", "page-a", 0)).toStrictEqual([]);
  expect(() => db.exec("delete from commands")).toThrow(/retire/);
});

// Guard: accepted work is not retention fodder; a late completion remains receipted exactly once.
test("retention overlapping an in-flight effect leaves the claim and its eventual result", async () => {
  const { ledger } = setup();
  const finish = deferred<string>();
  let effects = 0;

  const active = ledger.run(key, command, {
    local: () => undefined,
    remote: () => {
      effects++;

      return finish.promise;
    },
  });

  expect(ledger.retire("2099-01-01T00:00:00.000Z")).toBe(0);
  finish.resolve("session-1");
  await active;
  expect(ledger.retire("2099-01-01T00:00:00.000Z")).toBe(1);
  expect(
    await ledger.run(key, command, {
      local: () => {
        effects++;

        return "wrong";
      },
      remote: async () => "wrong",
    })
  ).toStrictEqual({ kind: "retired" });
  expect(effects).toBe(1);
});
