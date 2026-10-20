/** Discarding a row copy must not erase the only history evidence kept beside a legacy intent. */
import { expect, test } from "vitest";

import { createClient } from "../client.ts";
import { copy, database, patch, pending, row, sync } from "./fixtures.ts";

async function oldDisk(kind: "shapeless-checkpoint" | "unreadable-rows") {
  const stored = database();
  await stored.port.load();
  await stored.port.commit({
    replica: copy(17, [row("old", 125, 17)]),
    reset: true,
    base: 0,
    replaces: "dataset-a",
    ops: [],
  });
  // Use the adapter's actual opaque outbox key, then retain an older release's value shape (no since).
  await stored.port.keep(pending("legacy-page", 1, 125));
  const opening = stored.factory.open(stored.name);

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("open failed"));
  });

  try {
    const tx = db.transaction(["meta", "rows", "outbox"], "readwrite");

    if (kind === "shapeless-checkpoint") {
      // A checkpoint without row shapes. Old row shape also predates required deleted.
      tx.objectStore("meta").put(
        { dataset: "dataset-a", revision: 17, server: { build: "fixture-v1" } },
        "checkpoint"
      );
      tx.objectStore("rows").put({ id: "old", value: 125, revision: 17 }, "old");
    } else {
      // Keep the real, matching fingerprint/checkpoint intact; only a stored row is unreadable.
      tx.objectStore("rows").put(
        { id: "old", value: "not-an-integer", deleted: false, revision: 17 },
        "old"
      );
    }

    let count = 0;
    const next = tx.objectStore("outbox").openCursor();
    next.onsuccess = () => {
      const cursor = next.result;

      if (!cursor) {
        return;
      }

      const value: unknown = cursor.value;

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a raw disk record, checked only enough to drop one field
      if (typeof value !== "object" || value === null) {
        tx.abort();

        return;
      }

      Reflect.deleteProperty(value, "since");
      cursor.update(value);
      count++;
      cursor.continue();
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("legacy disk fixture failed"));
      tx.onabort = () => reject(tx.error ?? new Error("legacy disk fixture aborted"));
    });
    expect(count).toBe(1);
  } finally {
    db.close();
  }

  return database({ factory: stored.factory, name: stored.name });
}

// Guard: indexedReplica.load captures the positive DISK checkpoint revision BEFORE either discard path.
// Engine loaded fallback may see revision zero, but must not replace the adapter's captured command scope.
test.each(["shapeless-checkpoint", "unreadable-rows"] as const)(
  "%s discards the copy, not legacy command history: disk 17 still pushes 17 after reset 29",
  async (kind) => {
    const stored = await oldDisk(kind);

    const pulls: number[] = [];
    const pushes: number[] = [];

    const loaded: {
      dataset: string | null;
      revision: number;
      rows: number;
      since: number | undefined;
    }[] = [];

    const runtime = createClient({
      sync,
      client: "reloaded-page",
      ports: {
        storage: {
          ...stored.port,
          load: async () => {
            const snapshot = await stored.port.load();
            loaded.push({
              dataset: snapshot.replica.dataset,
              revision: snapshot.replica.revision,
              rows: snapshot.replica.tables.rows.size,
              since: snapshot.commands[0]?.since,
            });

            return snapshot;
          },
        },
        network: {
          pull: async (request) => {
            pulls.push(request.since);

            return { ok: true, value: { patch: patch(29, [], true), receipts: [] } };
          },
          push: async (request) => {
            pushes.push(request.since);

            return { ok: false, failure: { kind: "offline", message: "fixture reply lost" } };
          },
        },
        now: () => 0,
        fingerprint: async () => "fixture-fingerprint",
      },
    });

    runtime.start();
    await runtime.settle();
    expect(runtime.faults).toStrictEqual([]);
    expect(
      loaded.map(({ dataset, revision, rows }) => ({ dataset, revision, rows }))
    ).toStrictEqual([{ dataset: null, revision: 0, rows: 0 }]);
    expect(pulls[0]).toBe(0);
    expect(runtime.model().replica.revision).toBe(29);
    expect(pushes).toStrictEqual([17]);
    expect(loaded[0]?.since).toBe(17);
  }
);
