import { expect, test } from "vitest";

import { createSync, table } from "../sync.ts";
import type { Key } from "../sync.ts";
import { row, rowSchema } from "./fixtures.ts";
import type { Command, Outcome, PatchRows, Row, Server, Tables } from "./fixtures.ts";

/** Real Map with read instrumentation: no timer noise and no substitute for the production table implementation. */
class MeasuredMap extends Map<Key, Row> {
  visits = 0;
  private *measure<T>(items: MapIterator<T>): MapIterator<T> {
    for (const item of items) {
      this.visits++;
      yield item;
    }
  }
  override entries(): MapIterator<[Key, Row]> {
    return this.measure(super.entries());
  }
  override keys(): MapIterator<Key> {
    return this.measure(super.keys());
  }
  override values(): MapIterator<Row> {
    return this.measure(super.values());
  }
  override [Symbol.iterator](): MapIterator<[Key, Row]> {
    return this.measure(super[Symbol.iterator]());
  }
  override get(key: Key): Row | undefined {
    this.visits++;

    return super.get(key);
  }
  override forEach(
    callback: (value: Row, key: Key, map: Map<Key, Row>) => void,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Map's receiver is arbitrary, forwarded unchanged
    thisArg?: unknown
  ): void {
    for (const [key, value] of super.entries()) {
      this.visits++;
      callback.call(thisArg, value, key, this);
    }
  }
}

test("budget: merging a two-row chunk does not grow with the existing 1k or 100k rows", () => {
  const costs = [1000, 100_000].map((size) => {
    const rows = new MeasuredMap(
      Array.from({ length: size }, (_, index) => [String(index), row(String(index), index, 1)])
    );

    const before: Tables = { rows };

    const lens = table<Tables, PatchRows, Row>({
      name: "rows",
      schema: rowSchema,
      rows: (patch) => patch.rows,
      key: (item) => item.id,
      get: (tables) => tables.rows,
      set: (_tables, next) => ({ rows: next }),
    });

    const engine = createSync<Tables, PatchRows, Server, Command, Outcome>({
      tables: [lens],
      empty: { rows: new Map() },
      onlineOnly: () => false,
      refused: (_command, reason) => ({ kind: "failed", reason }),
    });

    const replica = {
      dataset: "dataset-a",
      revision: 1,
      tables: before,
      server: { build: "fixture-v1" },
      history: {
        kind: "partial",
        next: "older",
        through: "0",
        held: size,
        total: size + 2,
      } as const,
    };

    const [model] = engine.update(engine.initial("page-a", 0), {
      type: "loaded",
      replica,
      commands: [],
      unreadable: 0,
      now: 0,
    });

    const reply = {
      dataset: "dataset-a",
      revision: 2,
      reset: false,
      rows: { rows: [row("new-a", -1, 2), row("new-b", -2, 2)] },
      server: { build: "fixture-v1" },
      page: { from: "older", next: null, through: null, held: size + 2, total: size + 2 },
    };

    rows.visits = 0;

    const [after] = engine.update(model, {
      type: "pulled",
      since: 1,
      patch: reply,
      receipts: [],
      now: 1,
    });

    const cost = rows.visits;
    expect(after.replica.tables.rows.size).toBe(size + 2);
    expect(after.replica.tables.rows.get("new-a")).toStrictEqual(row("new-a", -1, 2));
    expect(after.replica.tables.rows.get("new-b")).toStrictEqual(row("new-b", -2, 2));
    expect(before.rows.has("new-a")).toBe(false);
    expect(before.rows.get("0")).toStrictEqual(row("0", 0, 1));

    return cost;
  });

  expect(costs[1]).toBe(costs[0]);
});
