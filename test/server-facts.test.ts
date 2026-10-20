import { expect, test } from "vitest";

import { copy, database, row, values } from "../src/conformance/fixtures.ts";
import { object, string } from "../src/schema.ts";

// A later version reads the server's facts with a stricter shape (a new required field). The facts are not rows: every
// pull brings them again. A copy an older page saved keeps its rows and waits for the next pull for its facts, instead
// of loading as an empty copy.
test("server facts an older page kept that no longer fit cost the facts, never the copy", async () => {
  const older = database();
  await older.port.load();
  await older.port.commit({
    replica: copy(3, [row("a", 100, 1), row("b", 200, 3)]),
    reset: true,
    base: 0,
    replaces: null,
    ops: [],
  });

  const newer = database({
    factory: older.factory,
    name: older.name,
    server: object({ build: string(), lastUpdate: string() }, { strict: true }),
  });

  const loaded = await newer.port.load();
  expect(loaded.replica.dataset).toBe("dataset-a");
  expect(loaded.replica.revision).toBe(3);
  expect(values(loaded.replica)).toStrictEqual([
    ["a", 100, 1],
    ["b", 200, 3],
  ]);
  expect(loaded.replica.server).toBeNull();
});
