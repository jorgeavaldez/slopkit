import { DatabaseSync } from "node:sqlite";

import { expect, test } from "vitest";

import { Ledger } from "../server/ledger.ts";
import type { LedgerOptions } from "../server/ledger.ts";
import { deferred, outcomeSchema } from "./fixtures.ts";
import type { Outcome } from "./fixtures.ts";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`create table commands(
    principal text not null, client text not null, id integer not null,
    name text not null, args text not null,
    state text not null check(state in ('accepted','done','retired')),
    outcome text check((state='done')=(outcome is not null)),
    revision integer check((state='accepted')=(revision is null)),
    created_at text not null, primary key(principal,client,id));`);

  const transaction: LedgerOptions<Outcome>["transaction"] = (body) => {
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
  };

  const ledger = new Ledger<Outcome>({
    db,
    transaction,
    stamp: () => 1,
    encode: JSON.stringify,
    decode: (text) => outcomeSchema.parse(JSON.parse(text)),
  });

  return { db, ledger };
}

const command = { name: "pay", args: '{"cents":125}' };

test("an outer rollback cannot make one command's external effect execute twice", async () => {
  const { db, ledger } = open();
  const key = { principal: "person:owner", client: "page", id: 1 };
  const receipt: Outcome = { kind: "ok", resource: "payment" };
  const finish = deferred<Outcome>();
  let effects = 0;

  const act = {
    local: () => undefined,
    remote: () => {
      effects++;

      return finish.promise;
    },
  };

  try {
    db.exec("begin immediate");
    // Rejecting an uncommitted caller transaction is valid. Executing after a durable claim is valid too.
    const first = ledger.run(key, command, act).catch(() => undefined);

    if (db.isTransaction) {
      db.exec("rollback");
    }

    finish.resolve(receipt);
    await first;
    expect(await ledger.run(key, command, act)).toMatchObject({ kind: "done", receipt });
    expect(effects, "the same accepted intent must not act twice").toBe(1);
    expect(ledger.receipts(key.principal, key.client, 0)).toMatchObject([{ id: 1, receipt }]);
  } finally {
    finish.resolve(receipt);

    if (db.isTransaction) {
      db.exec("rollback");
    }

    db.close();
  }
});

test("overlapping distinct principal/client tuples keep their own receipts", async () => {
  const { db, ledger } = open();
  const finish = deferred<Outcome>();
  const firstReceipt: Outcome = { kind: "ok", resource: "first-principal-payment" };
  const secondReceipt: Outcome = { kind: "ok", resource: "second-principal-payment" };
  const firstKey = { principal: "a\nb", client: "c", id: 1 };
  const secondKey = { principal: "a", client: "b\nc", id: 1 };
  let effects = 0;

  try {
    const first = ledger.run(firstKey, command, {
      local: () => undefined,
      remote: () => {
        effects++;

        return finish.promise;
      },
    });

    const second = ledger.run(secondKey, command, {
      local: () => undefined,
      remote: async () => {
        effects++;

        return secondReceipt;
      },
    });

    finish.resolve(firstReceipt);
    const results = await Promise.all([first, second]);
    expect(results).toStrictEqual([
      { kind: "done", receipt: firstReceipt, fresh: true },
      { kind: "done", receipt: secondReceipt, fresh: true },
    ]);
    expect(effects).toBe(2);
    expect(ledger.receipts(firstKey.principal, firstKey.client, 0)).toMatchObject([
      { id: 1, receipt: firstReceipt },
    ]);
    expect(ledger.receipts(secondKey.principal, secondKey.client, 0)).toMatchObject([
      { id: 1, receipt: secondReceipt },
    ]);
  } finally {
    finish.resolve(firstReceipt);
    db.close();
  }
});
