import { forceCloseDatabase } from "fake-indexeddb";
import { expect, test } from "vitest";

import { copy, database, row, values } from "../src/conformance/fixtures.ts";

// iOS Safari (17.4+) and any browser whose user clears site data close a live connection abnormally: the `close`
// event fires and every later transaction on that handle throws. Liveness: once storage works again, a commit lands.
test("a connection the browser closed is reopened, so later commits land", async () => {
  let handle: IDBDatabase | undefined;

  const stored = database({
    interfere: (what, transaction) => {
      if (what === "commit") {
        handle = transaction.db;
      }
    },
  });

  const { port } = stored;
  await port.load();
  await port.commit({
    replica: copy(1, [row("a", 100, 1)]),
    reset: true,
    base: 0,
    replaces: null,
    ops: [],
  });

  if (handle === undefined) {
    throw new Error("no handle");
  }

  // The package types the argument as the class, not a connection; the call is the documented one.
  // oxlint-disable-next-line anti-slop/no-reflect-apply -- fake-indexeddb's declared parameter type is wrong
  Reflect.apply(forceCloseDatabase, undefined, [handle]);

  const next = {
    replica: copy(2, [row("a", 100, 1), row("b", 200, 2)]),
    reset: true,
    base: 1,
    replaces: "dataset-a",
    ops: [],
  };

  // The engine retries a failed commit later; give it a few tries, as its backoff would.
  let landed = false;

  for (let tries = 0; tries < 3 && !landed; tries++) {
    landed = await port.commit(next).then(
      () => true,
      () => false
    );
  }

  expect(landed).toBe(true);
  const reopened = database({ factory: stored.factory, name: stored.name });
  expect(values((await reopened.port.load()).replica)).toStrictEqual([
    ["a", 100, 1],
    ["b", 200, 2],
  ]);
});
