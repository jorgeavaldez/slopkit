import { expect, test } from "vitest";

import { row, rowSchema } from "../src/conformance/fixtures.ts";
import type { PatchRows, Row } from "../src/conformance/fixtures.ts";
import { table } from "../src/sync.ts";
import type { Key } from "../src/sync.ts";
import { seeded } from "../src/test/network.ts";

type Tables = { rows: ReadonlyMap<Key, Row> };

const lens = table<Tables, PatchRows, Row>({
  name: "rows",
  schema: rowSchema,
  rows: (patch) => patch.rows,
  key: (item) => item.id,
  gone: (item) => item.deleted,
  get: (tables) => tables.rows,
  set: (_tables, rows) => ({ rows }),
});

const sorted = (rows: Iterable<readonly [Key, Row]>) =>
  [...rows].toSorted(([a], [b]) => String(a).localeCompare(String(b)));

// Chunks of every size over a large table, against a plain map applied by hand: what the table reads back, its size and
// every value published before stay exact, whatever the chunks' sizes do to how they are kept.
test("chunk after chunk, a table reads back exactly the rows applied, and earlier values never change", () => {
  const random = seeded(7);
  const start = Array.from({ length: 600 }, (_, index) => row(`r${index}`, index, 1));
  let tables = lens.apply({ rows: new Map() }, { rows: start }, true);
  const expected = new Map<Key, Row>(start.map((item) => [item.id, item]));
  const published: { tables: Tables; rows: (readonly [Key, Row])[] }[] = [];

  for (let revision = 2; revision < 120; revision++) {
    const size = random() < 0.1 ? Math.floor(random() * 300) : 1 + Math.floor(random() * 8);

    const chunk = Array.from({ length: size }, () => {
      const id = `r${Math.floor(random() * 800)}`;

      return row(id, Math.floor(random() * 1000), revision, random() < 0.3);
    });

    tables = lens.apply(tables, { rows: chunk }, false);

    for (const item of chunk) {
      if (item.deleted) {
        expected.delete(item.id);
      } else {
        expected.set(item.id, item);
      }
    }

    expect(tables.rows.size).toBe(expected.size);
    expect(sorted(tables.rows)).toStrictEqual(sorted(expected));
    expect(sorted(tables.rows.entries())).toStrictEqual(sorted(expected.entries()));
    expect(new Set(tables.rows.keys())).toStrictEqual(new Set(expected.keys()));
    expect([...tables.rows.values()]).toHaveLength(expected.size);

    for (const item of chunk) {
      expect(tables.rows.get(item.id)).toStrictEqual(expected.get(item.id));
      expect(tables.rows.has(item.id)).toBe(expected.has(item.id));
    }

    if (revision % 37 === 0) {
      published.push({ tables, rows: sorted(expected) });
    }
  }

  for (const each of published) {
    expect(sorted(each.tables.rows)).toStrictEqual(each.rows);
  }
});

// A table read as a Map: `forEach` calls back with the receiver it is given, as Map's does.
test("forEach passes its receiver on", () => {
  const base = new Map(["a", "b", "c", "d"].map((id) => [id, row(id, 1, 1)]));
  const tables = lens.apply({ rows: base }, { rows: [row("e", 1, 2)] }, false);
  const context = { sum: 0 };

  // oxlint-disable-next-line unicorn/no-array-for-each, unicorn/no-array-method-this-argument -- a Map's forEach and its receiver are what is checked
  tables.rows.forEach(function add(this: typeof context, item) {
    this.sum += item.value;
  }, context);

  expect(context.sum).toBe(5);
});
