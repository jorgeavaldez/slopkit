import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";

import { Replaced } from "../client.ts";
import { copy, database, pending, row, values } from "./fixtures.ts";

describe("independent replica port conformance", () => {
  test("the supplied factory is the storage boundary, with no ambient browser IndexedDB required", async () => {
    const first = database({ factory: new IDBFactory(), name: "same-name" });
    const second = database({ factory: new IDBFactory(), name: "same-name" });
    await first.port.load();
    await first.port.commit({
      replica: copy(1, [row("private-to-first", 125, 1)]),
      reset: true,
      base: 0,
      replaces: "dataset-a",
      ops: [],
    });
    const independent = await second.port.load();
    expect(independent.replica.dataset).toBeNull();
    expect(values(independent.replica)).toStrictEqual([]);
    expect(values((await first.port.load()).replica)).toStrictEqual([["private-to-first", 125, 1]]);
  });

  test("an aborted delta cannot be hidden by a later checkpoint", async () => {
    let abort = false;

    const stored = database({
      interfere: (what, transaction) => {
        if (what === "commit" && abort) {
          abort = false;
          transaction.abort();
        }
      },
    });

    const { port } = stored;
    await port.load();
    await port.commit({
      replica: copy(1, [row("base", 125, 1)]),
      reset: true,
      base: 0,
      replaces: "dataset-a",
      ops: [],
    });
    abort = true;
    await expect(
      port.commit({
        replica: copy(2, [row("base", 125, 1), row("middle", 250, 2)]),
        reset: false,
        base: 1,
        replaces: "dataset-a",
        ops: [{ table: "rows", key: "middle", row: row("middle", 250, 2) }],
      })
    ).rejects.toThrow(/IndexedDB/);
    expect((await port.load()).replica.revision).toBe(1);
    expect(values((await port.load()).replica)).toStrictEqual([["base", 125, 1]]);
    await port.commit({
      replica: copy(3, [row("base", 125, 1), row("middle", 250, 2), row("last", 375, 3)]),
      reset: false,
      base: 2,
      replaces: "dataset-a",
      ops: [{ table: "rows", key: "last", row: row("last", 375, 3) }],
    });
    const reopened = database({ factory: stored.factory, name: stored.name });
    // The actual durable readback, not the supplied in-memory replica or commitPlan's answer, is the oracle target.
    const readback = await reopened.port.load();
    expect(readback.replica.revision).toBe(3);
    expect(values(readback.replica)).toStrictEqual([
      ["base", 125, 1],
      ["last", 375, 3],
      ["middle", 250, 2],
    ]);
  });

  test("a stale tab cannot replace newer durable data with its older reset", async () => {
    const first = database();
    const second = database({ factory: first.factory, name: first.name });
    await Promise.all([first.port.load(), second.port.load()]);
    await first.port.commit({
      replica: copy(3, [row("new", 300, 3)]),
      reset: true,
      base: 0,
      replaces: "dataset-a",
      ops: [],
    });
    expect(
      await second.port.commit({
        replica: copy(2, [row("old", 200, 2)]),
        reset: true,
        base: 0,
        replaces: "dataset-a",
        ops: [],
      })
    ).toStrictEqual({ dataset: "dataset-a", revision: 3 });
    const reload = database({ factory: first.factory, name: first.name });
    expect((await reload.port.load()).replica.revision).toBe(3);
    expect(values((await reload.port.load()).replica)).toStrictEqual([["new", 300, 3]]);
  });

  test("a later whole snapshot propagates updates and tombstones exactly", async () => {
    const { port } = database();
    await port.load();
    await port.commit({
      replica: copy(1, [row("keep", 100, 1), row("remove", 200, 1)]),
      reset: true,
      base: 0,
      replaces: "dataset-a",
      ops: [],
    });
    await port.commit({
      replica: copy(2, [row("keep", 900, 2)]),
      reset: false,
      base: 1,
      replaces: "dataset-a",
      ops: [
        { table: "rows", key: "keep", row: row("keep", 900, 2) },
        { table: "rows", key: "remove", drop: true },
      ],
    });
    expect(values((await port.load()).replica)).toStrictEqual([["keep", 900, 2]]);
    await port.commit({
      replica: copy(3, [row("replacement", 700, 3)]),
      reset: true,
      base: 2,
      replaces: "dataset-a",
      ops: [],
    });
    expect(values((await port.load()).replica)).toStrictEqual([["replacement", 700, 3]]);
  });

  test("two tabs' intents do not overwrite one another, and dropping one cannot remove the other", async () => {
    const first = database();
    const second = database({ factory: first.factory, name: first.name });
    await Promise.all([first.port.load(), second.port.load()]);
    await Promise.all([
      first.port.keep(pending("page-a", 1, 125)),
      second.port.keep(pending("page-b", 1, 250)),
    ]);

    const before = (await first.port.load()).commands
      .map((value) => [value.client, value.id, value.command.value])
      .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));

    expect(before).toStrictEqual([
      ["page-a", 1, 125],
      ["page-b", 1, 250],
    ]);
    await first.port.drop([{ client: "page-a", id: 1 }]);
    expect(
      (await second.port.load()).commands.map((value) => [
        value.client,
        value.id,
        value.command.value,
      ])
    ).toStrictEqual([["page-b", 1, 250]]);
  });

  test("forget fences every stale writer, including outbox deletion, while a new page can proceed", async () => {
    const owner = database();
    const stale = database({ factory: owner.factory, name: owner.name });
    await Promise.all([owner.port.load(), stale.port.load()]);
    await stale.port.keep(pending("old-page", 1));
    await owner.port.forget();
    const fresh = database({ factory: owner.factory, name: owner.name });
    expect((await fresh.port.load()).commands).toStrictEqual([]);
    await fresh.port.keep(pending("new-page", 1, 800));
    await expect(stale.port.keep(pending("old-page", 2))).rejects.toBeInstanceOf(Replaced);
    await expect(stale.port.drop([{ client: "new-page", id: 1 }])).rejects.toBeInstanceOf(Replaced);
    await expect(
      stale.port.commit({
        replica: copy(99, [row("resurrected", 999, 99)]),
        reset: true,
        base: 0,
        replaces: "dataset-a",
        ops: [],
      })
    ).rejects.toBeInstanceOf(Replaced);
    const readback = await fresh.port.load();
    expect(values(readback.replica)).toStrictEqual([]);
    expect(
      readback.commands.map((value) => [value.client, value.id, value.command.value])
    ).toStrictEqual([["new-page", 1, 800]]);
  });

  test("an interrupted command cannot silently disappear when the storage schema upgrades", async () => {
    let connection: IDBDatabase | undefined;

    const first = database({
      interfere: (_what, transaction) => {
        connection = transaction.db;
      },
    });

    await first.port.load();
    await first.port.keep({
      ...pending("page-before-upgrade", 1, 125),
      state: { kind: "unknown", failure: "reply lost after acceptance" },
    });

    if (connection === undefined) {
      throw new Error("write did not expose its database handle");
    }

    // The old renderer exits, so the upgrade is not artificially blocked by this test.
    connection.close();
    const upgraded = database({ factory: first.factory, name: first.name, version: 2 });
    // The row/outbox schemas are unchanged: this is a compatible upgrade, not permission to erase unknown work.
    const loaded = await upgraded.port.load();
    expect(loaded.commands).toMatchObject([
      {
        client: "page-before-upgrade",
        id: 1,
        command: { name: "put", value: 125 },
        state: { kind: "unknown" },
      },
    ]);
  });
});
