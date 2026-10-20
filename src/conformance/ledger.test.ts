import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { Ledger } from "../server/ledger.ts";
import type { LedgerOptions } from "../server/ledger.ts";
import { deferred, outcomeSchema } from "./fixtures.ts";
import type { Outcome } from "./fixtures.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close();
  }
});

// The ledger's documented adapter contract, plus an independent business table. No production Store/migrations,
// sync reducer, expected-output generator or checksum is used to determine the expected effects.
function open(path: string, encode: (value: Outcome) => string = JSON.stringify) {
  const db = new DatabaseSync(path);
  db.exec(`create table if not exists commands(
    principal text not null, client text not null, id integer not null,
    name text not null, args text not null, state text not null check(state in ('accepted','done')),
    outcome text check((state='done')=(outcome is not null)),
    revision integer check((state='done')=(revision is not null)), created_at text not null,
    primary key(principal,client,id));
    create table if not exists clock(n integer not null);
    insert into clock select 0 where not exists(select 1 from clock);
    create table if not exists business(id text primary key, amount integer not null);`);
  let inside = false;

  const transaction: LedgerOptions<Outcome>["transaction"] = (body) => {
    if (inside) {
      return body();
    }

    db.exec("begin immediate");
    inside = true;

    try {
      const result = body();
      db.exec("commit");

      return result;
    } catch (error) {
      db.exec("rollback");
      throw error;
    } finally {
      inside = false;
    }
  };

  const ledger = new Ledger<Outcome>({
    db,
    transaction,
    encode,
    decode: (text) => outcomeSchema.parse(JSON.parse(text)),
    stamp: () => {
      db.exec("update clock set n=n+1");

      return Number(db.prepare("select n from clock").get()?.n);
    },
  });

  cleanups.push(() => {
    if (db.isOpen) {
      db.close();
    }
  });

  return { db, ledger };
}

const key = { principal: "person:owner", client: "device-one", id: 1 };
const command = { name: "pay", args: '{"cents":125}' };
const result: Outcome = { kind: "ok", resource: "payment-001" };

async function file() {
  const home = await mkdtemp(join(tmpdir(), "ledger-conformance-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));

  return join(home, "ledger.sqlite");
}

describe("independent ledger conformance", () => {
  test("overlapping identical deliveries share one effect; conflicting arguments cannot join it", async () => {
    const { ledger } = open(":memory:");
    const finish = deferred<Outcome>();
    let effects = 0;

    const act = {
      local: () => undefined,
      remote: () => {
        effects++;

        return finish.promise;
      },
    };

    const first = ledger.run(key, command, act);
    const duplicate = ledger.run(key, command, act);
    expect(await ledger.run(key, { ...command, args: '{"cents":999}' }, act)).toStrictEqual({
      kind: "conflict",
    });
    expect(effects).toBe(1);
    finish.resolve(result);
    expect(await first).toStrictEqual({ kind: "done", receipt: result, fresh: true });
    expect(await duplicate).toStrictEqual({ kind: "done", receipt: result, fresh: false });
    expect(await ledger.run(key, command, act)).toStrictEqual({
      kind: "done",
      receipt: result,
      fresh: false,
    });
    expect(effects).toBe(1);
  });

  test("the identity binds command kind as well as its arguments", async () => {
    const { ledger } = open(":memory:");
    let effects = 0;

    const act = {
      local: () => {
        effects++;

        return result;
      },
      remote: async () => result,
    };

    await ledger.run(key, { name: "pay", args: "{}" }, act);
    const changedKind = await ledger.run(key, { name: "delete-account", args: "{}" }, act);
    expect(changedKind).toStrictEqual({ kind: "conflict" });
    expect(effects).toBe(1);
  });

  test("a second ledger handle cannot execute a claim owned by the first", async () => {
    const path = await file();
    const first = open(path);
    const second = open(path);
    const finish = deferred<Outcome>();
    let effects = 0;

    const act = {
      local: () => undefined,
      remote: () => {
        effects++;

        return finish.promise;
      },
    };

    const active = first.ledger.run(key, command, act);
    expect(await second.ledger.run(key, command, act)).toStrictEqual({ kind: "elsewhere" });
    expect(effects).toBe(1);
    finish.resolve(result);
    await active;
    expect(await second.ledger.run(key, command, act)).toStrictEqual({
      kind: "done",
      receipt: result,
      fresh: false,
    });
    expect(effects).toBe(1);
  });

  test("receipt visibility is principal-scoped, not possession of a client/id", async () => {
    const { ledger } = open(":memory:");
    await ledger.run(key, command, { local: () => result, remote: async () => result });
    expect(ledger.receipts("service:reader", key.client, 0)).toStrictEqual([]);
    expect(ledger.receipts(key.principal, "another-device", 0)).toStrictEqual([]);
    const owner = ledger.receipts(key.principal, key.client, 0);
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ id: 1, receipt: { kind: "ok", resource: "payment-001" } });
    expect(owner[0]?.revision).toBeGreaterThan(0);
  });

  test("a local effect and its receipt roll back together if recording the receipt fails", async () => {
    let reject = true;

    const { db, ledger } = open(":memory:", (receipt) => {
      if (reject) {
        throw new Error("injected receipt encoding failure");
      }

      return JSON.stringify(receipt);
    });

    const act = {
      local: () => {
        db.prepare("insert into business values (?,?)").run("payment-001", 125);

        return result;
      },
      remote: async () => result,
    };

    await expect(ledger.run(key, command, act)).rejects.toThrow(
      "injected receipt encoding failure"
    );
    expect(db.prepare("select id,amount from business").all()).toStrictEqual([]);
    expect(ledger.receipts(key.principal, key.client, 0)).toStrictEqual([]);
    reject = false;
    expect(await ledger.run(key, command, act)).toStrictEqual({
      kind: "done",
      receipt: result,
      fresh: true,
    });
    expect(
      db
        .prepare("select id,amount from business")
        .all()
        .map((row) => ({ ...row }))
    ).toStrictEqual([{ id: "payment-001", amount: 125 }]);
  });

  test("reopen after acceptance without a result exposes uncertainty, never repeats the external effect", async () => {
    const path = await file();
    const first = open(path);
    let effects = 0;
    // The provider has acted; its answer is permanently lost with this process. There is intentionally no timer.
    void first.ledger.run(key, command, {
      local: () => undefined,
      remote: () => {
        effects++;

        return new Promise<Outcome>(() => {});
      },
    });
    expect(effects).toBe(1);
    first.db.close();
    const recovered = open(path);

    const unknown: Outcome = {
      kind: "unknown",
      reason: "provider may have acted before the process stopped",
    };

    expect(recovered.ledger.interrupt(() => unknown)).toBe(1);
    expect(recovered.ledger.interrupt(() => unknown)).toBe(0);

    const replay = await recovered.ledger.run(key, command, {
      local: () => undefined,
      remote: async () => {
        effects++;

        return result;
      },
    });

    expect(replay).toStrictEqual({ kind: "done", receipt: unknown, fresh: false });
    expect(effects).toBe(1);
    expect(recovered.ledger.receipts(key.principal, key.client, 0)).toMatchObject([
      { id: 1, receipt: unknown },
    ]);
  });
});
