import { expect, test } from "vitest";

import { sync } from "../src/conformance/fixtures.ts";

// A keep that failed says the device can't save; a later keep or drop that works ends it (the replica's own writes
// never failed). Liveness: a failure no write repeats doesn't stand forever.
test("a later keep that works ends a keep failure; a replica write failure isn't ended by it", () => {
  const [ready] = sync.update(sync.initial("client-a", 0), {
    type: "loaded",
    replica: { dataset: null, revision: 0, tables: { rows: new Map() }, server: null },
    commands: [],
    unreadable: 0,
    now: 0,
  });

  const [tapped] = sync.update(ready, {
    type: "command",
    command: { name: "put", value: 1 },
    now: 1,
  });

  const [failed] = sync.update(tapped, {
    type: "keepFailed",
    client: "client-a",
    id: 1,
    reason: "quota",
    now: 2,
  });

  expect(failed.storage).toStrictEqual({ kind: "failed", reason: "quota" });

  const [again] = sync.update(failed, {
    type: "command",
    command: { name: "put", value: 2 },
    now: 3,
  });

  const [kept] = sync.update(again, { type: "kept", client: "client-a", id: 2, now: 4 });
  expect(kept.storage).toStrictEqual({ kind: "ok" });
  const [dropped] = sync.update(failed, { type: "dropped", failure: null, now: 5 });
  expect(dropped.storage).toStrictEqual({ kind: "ok" });

  const [replicaFailed] = sync.update(ready, {
    type: "commitFailed",
    reason: "disk",
    replaced: false,
    now: 6,
  });

  const [stillFailed] = sync.update(replicaFailed, { type: "dropped", failure: null, now: 7 });
  expect(stillFailed.storage).toStrictEqual({ kind: "failed", reason: "disk" });
});
