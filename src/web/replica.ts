/**
 * The sync engine's storage port over IndexedDB: the replica (one store per table, out-of-line keys, and a checkpoint)
 * and the outbox (one record per command, keyed by client and number), in one database shared by every tab.
 *
 * - A commit is decided inside its own read-write transaction from the checkpoint the disk holds (`commitPlan`): a
 *   stale tab can't make the disk go back, and a patch whose base the disk never reached is written as the whole
 *   replica instead, so the checkpoint never covers rows the disk doesn't have.
 * - Every write checks the database's generation, read at load: after a forget in another tab this page's writes
 *   fail as `Replaced` instead of bringing the forgotten copy back.
 * - The outbox is written per command, never replaced whole, so tabs can't overwrite each other's intents.
 * - Rows are read back only under the row shapes that wrote them (each table's name and schema `shape`, kept with the
 *   checkpoint): any change to a table or its schema starts the rows over, with no number to bump by hand. The next
 *   commit then writes the whole replica, so the disk is repaired, not just the memory. Rows that don't parse are
 *   treated the same.
 * - A partial copy (a first copy still paging in) keeps its history in the checkpoint, written in the same transaction
 *   as its rows, and marks its row shapes as partial: a release from before paging reads it as another release's copy,
 *   so it never takes part of a history for all of it. A delta takes the patch's history only when the disk is at the
 *   cursor the patch moved from, and a complete copy at a revision is never narrowed to a partial one. The server's facts are not rows: facts an older page kept that no longer fit load as null and
 *   never cost the copy; facts that change at the same revision are written too.
 * - A version upgrade starts the replica over (it comes back from the server) but keeps the outbox and the generation:
 *   an intent on disk is never erased by an upgrade. One this version can't read stays on disk and is counted.
 * - A newer version opening in another tab closes this page's connection; its writes then fail as `Replaced`.
 *
 * `factory` is the browser's `indexedDB`, or any implementation of the same API (the headless simulation passes an
 * in-memory one). `interfere` is for tests: it sees each write transaction before it commits and may abort it.
 */
import { Replaced } from "../client.ts";
import type { StoragePort } from "../client.ts";
import { check, literal, nullable, number, object, string } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { commitPlan } from "../sync.ts";
import type { History, Lens, Op, Pending, Replica } from "../sync.ts";
import { committed, openDatabase, request } from "./idb.ts";

/** Which dataset a copy holds, at what revision (0 before any), and how much of its history. */
type Position = { dataset: string | null; revision: number; history: History };

type Checkpoint<S> = Omit<Position, "history"> & {
  /** Kept only while partial: a complete checkpoint reads as it did before paging. */
  history?: History;
  server: S | null;
  /**
   * The row shapes that wrote the rows (`Lens.shape`, every table): read back only under the same ones. A partial
   * copy's are marked, so a release that can't page doesn't read them.
   */
  shapes: string;
};

const COMPLETE: History = { kind: "complete" };

const count = () => number({ integer: true, min: 0 });

const partialSchema = object({
  kind: literal("partial"),
  next: string(),
  through: nullable(string()),
  held: count(),
  total: count(),
});

export function indexedReplica<T, P, S, C, O>(options: {
  factory: IDBFactory;
  name: string;
  /** The object stores' layout: bump when a table is added or renamed. Row shapes are checked on their own. */
  version: number;
  tables: readonly Lens<T, P>[];
  empty: T;
  server: Schema<S>;
  pending: Schema<Pending<C, O>>;
  interfere?: (what: "commit" | "keep" | "drop", transaction: IDBTransaction) => void;
  /**
   * An outbox an earlier release kept in another store: on upgrade each record is moved into the outbox, converted to
   * a command (or kept as it was, under its own key, to be counted unreadable). Never dropped.
   */
  legacy?: { store: string; convert: (value: unknown) => Pending<C, O> | undefined };
}): StoragePort<T, S, C, O> & { forget: () => Promise<void> } {
  const names = options.tables.map((lens) => lens.name);
  const shapes = options.tables.map((lens) => lens.shape).join("\n");
  /** A partial copy's row shapes: foreign to a release from before paging. */
  const partialShapes = `${shapes}\npartial`;
  const ours = (written: unknown) => written === shapes || written === partialShapes;
  /** The checkpoint a load found whose rows didn't parse: the next commit at it rewrites the whole replica. */
  let damaged: { dataset: string | null; revision: number } | undefined;
  /** The dataset of a copy this page loaded but couldn't read (other row shapes, rows that don't parse): its own to replace. */
  let discarded: string | null = null;
  /**
   * The checkpoint this page loaded, as written: a copy under other row shapes is this page's to replace only while it
   * is still that one. Once another release's tab writes its own, that release owns the copy on this device.
   */
  let loaded: { dataset: unknown; revision: unknown; shapes: unknown } | undefined;
  let opened: Promise<IDBDatabase> | undefined;
  /** The generation this page loaded; undefined until it has. */
  let generation: number | undefined;
  /** A newer version took the database over: this page must reload. */
  let superseded = false;

  /**
   * The version to open: `version`, or past what the browser has when that lacks a store these tables need (a table
   * added without a bump) or is already newer (another release's tab moved it): the layout follows the tables, so a
   * forgotten bump can't leave the copy unopenable.
   */
  const layout = async (): Promise<number> => {
    const probe = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = options.factory.open(options.name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error(`can't open ${options.name}`));
    });

    const missing = [...names, "meta", "outbox"].some(
      (name) => !probe.objectStoreNames.contains(name)
    );

    const current = probe.version;
    probe.close();

    if (current >= options.version && !missing) {
      return current;
    }

    return Math.max(current + (missing ? 1 : 0), options.version);
  };

  const open = () => {
    opened ??= layout()
      .then((version) =>
        openDatabase(options.factory, options.name, version, (database, _from, upgrade) => {
          // Replica tables start over (the server has them); every other store an earlier version kept may hold work
          // nobody else has, so its records move into the outbox: converted by `legacy`, else kept as they were under
          // their own key, counted unreadable. Nothing is dropped unseen.
          const legacy = options.legacy;
          const own = new Set(["meta", "outbox"]);

          if (!database.objectStoreNames.contains("outbox")) {
            database.createObjectStore("outbox");
          }

          if (database.objectStoreNames.contains("meta")) {
            upgrade.objectStore("meta").delete("checkpoint");
          } else {
            database.createObjectStore("meta");
          }

          const outbox = upgrade.objectStore("outbox");

          // A snapshot: deleting a store changes the live list being walked.
          const existing = [...database.objectStoreNames];

          for (const name of existing) {
            if (own.has(name)) {
              continue;
            }

            if (names.includes(name)) {
              database.deleteObjectStore(name);
              continue;
            }

            const cursor = upgrade.objectStore(name).openCursor();
            let at = 0;
            cursor.onsuccess = () => {
              const current = cursor.result;

              if (current === null) {
                database.deleteObjectStore(name);

                return;
              }

              const value: unknown = current.value;
              const command = legacy?.store === name ? legacy.convert(value) : undefined;

              if (command === undefined) {
                outbox.put(value, ["legacy", name, at++]);
              } else {
                outbox.put(command, [command.client, command.id]);
              }

              current.continue();
            };
          }

          for (const name of names) {
            database.createObjectStore(name);
          }
        })
      )
      .then((database) => {
        // The browser closed it under us (iOS Safari, cleared site data): the next call opens it again.
        database.onclose = () => {
          opened = undefined;
        };

        database.onversionchange = () => {
          superseded = true;
          database.close();
        };

        return database;
      });
    // A failed open may succeed later (a blocked upgrade): try again next time.
    opened.catch(() => (opened = undefined));

    return opened;
  };

  const db = async () => {
    if (superseded) {
      throw new Replaced();
    }

    return await open();
  };

  /** Inside a write transaction: refuse if the database was forgotten since this page loaded. */
  async function guard(transaction: IDBTransaction): Promise<void> {
    const stored = await request<unknown>(transaction.objectStore("meta").get("generation"));

    if ((typeof stored === "number" ? stored : 0) !== (generation ?? 0)) {
      transaction.abort();
      throw new Replaced();
    }
  }

  /** The checkpoint on disk as this version may trust it: one of other row shapes (or none) holds nothing. */
  const checkpointOf = (value: unknown): Position => {
    const none = { dataset: null, revision: 0, history: COMPLETE };

    if (typeof value !== "object" || value === null) {
      return none;
    }

    const dataset: unknown = Reflect.get(value, "dataset");
    const revision: unknown = Reflect.get(value, "revision");
    const written: unknown = Reflect.get(value, "shapes");
    const partial = check(partialSchema, Reflect.get(value, "history"));

    if (written !== shapes && (written !== partialShapes || !partial.ok)) {
      return none;
    }

    const at = {
      dataset: typeof dataset === "string" ? dataset : null,
      revision: typeof revision === "number" ? revision : 0,
      history: written === partialShapes && partial.ok ? partial.value : COMPLETE,
    };

    if (
      damaged !== undefined &&
      damaged.dataset === at.dataset &&
      damaged.revision === at.revision
    ) {
      return none;
    }

    return at;
  };

  return {
    async load() {
      const database = await db();
      const transaction = database.transaction([...names, "meta", "outbox"], "readonly");

      const entries = (name: string) =>
        Promise.all([
          request<IDBValidKey[]>(transaction.objectStore(name).getAllKeys()),
          request<unknown[]>(transaction.objectStore(name).getAll()),
        ]).then(([keys, rows]) =>
          keys.flatMap((key, at) =>
            typeof key === "string" || typeof key === "number" ? [{ key, row: rows[at] }] : []
          )
        );

      const [stored, point, outbox, ...tables] = await Promise.all([
        request<unknown>(transaction.objectStore("meta").get("generation")),
        request<unknown>(transaction.objectStore("meta").get("checkpoint")),
        request<unknown[]>(transaction.objectStore("outbox").getAll()),
        ...names.map(entries),
      ]);

      generation = typeof stored === "number" ? stored : 0;

      // A tap kept before taps recorded their copy's revision was made on the copy beside it on the disk: it takes
      // that checkpoint's revision now, before the rows can be discarded (other row shapes, rows that don't parse),
      // so a copy started over never makes it look like it was made on nothing.
      const disk: unknown =
        typeof point === "object" && point !== null ? Reflect.get(point, "revision") : 0;

      const commands = outbox.flatMap((each) => {
        const parsed = check(options.pending, each);

        if (!parsed.ok) {
          return [];
        }

        return [
          parsed.value.since === undefined && typeof disk === "number" && disk > 0
            ? { ...parsed.value, since: disk }
            : parsed.value,
        ];
      });

      const unreadable = outbox.length - commands.length;

      const empty: Replica<T, S> = {
        dataset: null,
        revision: 0,
        tables: options.empty,
        server: null,
        history: COMPLETE,
      };

      const at = checkpointOf(point);

      const raw: unknown =
        typeof point === "object" && point !== null ? Reflect.get(point, "dataset") : null;

      discarded = typeof raw === "string" && raw !== at.dataset ? raw : null;
      loaded =
        typeof point === "object" && point !== null
          ? {
              dataset: raw,
              revision: disk,
              shapes: Reflect.get(point, "shapes"),
            }
          : undefined;

      const server =
        typeof point === "object" && point !== null
          ? check(options.server, Reflect.get(point, "server"))
          : undefined;

      let restored: T | undefined = options.empty;

      for (const [index, lens] of options.tables.entries()) {
        restored = restored === undefined ? undefined : lens.restore(restored, tables[index] ?? []);
      }

      // Rows written under other shapes, or that no longer fit: start over rather than show wrong data, and let the
      // next commit rewrite the disk. The server's facts are not rows (every pull brings them again), so facts an
      // older page kept that no longer fit wait for the next pull instead of costing the copy.
      if (restored === undefined && at.dataset !== null) {
        damaged = at;
        discarded = at.dataset;
      }

      if (restored === undefined || at.dataset === null) {
        return { replica: empty, commands, unreadable };
      }

      return {
        replica: {
          dataset: at.dataset,
          revision: at.revision,
          tables: restored,
          server: server?.ok === true ? server.value : null,
          history: at.history,
        },
        commands,
        unreadable,
      };
    },

    async commit(commit) {
      const database = await db();
      const transaction = database.transaction([...names, "meta"], "readwrite");
      const done = committed(transaction);
      const meta = transaction.objectStore("meta");

      const target = {
        dataset: commit.replica.dataset,
        revision: commit.replica.revision,
        server: commit.replica.server,
      };

      try {
        await guard(transaction);
        const point = await request<unknown>(meta.get("checkpoint"));

        // The disk holds another dataset this page never saw (the server replaced the one it is on): refused,
        // whatever row shapes wrote it, so a tab of another release can't write a replaced dataset back.
        const held: unknown =
          typeof point === "object" && point !== null ? Reflect.get(point, "dataset") : null;

        if (
          typeof held === "string" &&
          held !== commit.replica.dataset &&
          held !== commit.replaces &&
          held !== discarded
        ) {
          transaction.abort();
          throw new Replaced();
        }

        const stored = checkpointOf(point);

        const plan = commitPlan(stored, {
          ...target,
          reset: commit.reset,
          base: commit.base,
          replaces: commit.replaces,
          ...(commit.from === undefined ? {} : { from: commit.from }),
        });

        // The disk holds a dataset this page never saw: the server replaced the one this page is on.
        if (plan === "stale") {
          transaction.abort();
          throw new Replaced();
        }

        const revision: unknown =
          typeof point === "object" && point !== null ? Reflect.get(point, "revision") : 0;

        const written: unknown =
          typeof point === "object" && point !== null ? Reflect.get(point, "shapes") : undefined;

        // Another release's tab wrote this dataset under its own row shapes since this page loaded: that release owns
        // the copy now, at any revision, and this page stops writing until it reloads.
        if (
          held === commit.replica.dataset &&
          !ours(written) &&
          (loaded === undefined ||
            loaded.dataset !== held ||
            loaded.revision !== revision ||
            loaded.shapes !== written)
        ) {
          transaction.abort();
          throw new Replaced();
        }

        // The copy this page loaded and couldn't read (other row shapes, rows that don't parse) still fences it: never
        // rewritten below its revision. The page catches up from the server and writes it then.
        if (
          plan === "whole" &&
          held === commit.replica.dataset &&
          typeof revision === "number" &&
          revision > commit.replica.revision
        ) {
          transaction.abort();
          throw new Error("this device holds a newer copy than this page");
        }

        const write = (ops: readonly Op[]) => {
          for (const op of ops) {
            if ("drop" in op) {
              transaction.objectStore(op.table).delete(op.key);
            } else {
              transaction.objectStore(op.table).put(op.row, op.key);
            }
          }
        };

        if (plan === "delta" || plan === "adopt") {
          write(commit.ops);
        }

        if (plan === "whole") {
          for (const name of names) {
            transaction.objectStore(name).clear();
          }

          for (const lens of options.tables) {
            write(lens.snapshot(commit.replica.tables));
          }
        }

        // At the same revision the rows are already there, but the server's facts may have moved: they are kept too.
        const facts = plan === "skip" && stored.revision === target.revision;

        // A delta keeps the disk's history; a whole write or a delta from the disk's own cursor takes the page's.
        const history =
          plan === "whole" || plan === "adopt"
            ? (commit.replica.history ?? COMPLETE)
            : stored.history;

        const checkpoint: Checkpoint<S> = {
          ...target,
          ...(history.kind === "partial" ? { history, shapes: partialShapes } : { shapes }),
        };

        if (plan !== "skip" || facts) {
          meta.put(checkpoint, "checkpoint");
        }

        options.interfere?.("commit", transaction);
        await done;

        if (plan === "whole") {
          damaged = undefined;
          discarded = null;
          loaded = undefined;
        }

        const now = plan === "skip" ? stored : checkpoint;

        if (now.dataset === null) {
          throw new Error("the replica has no dataset");
        }

        return { dataset: now.dataset, revision: now.revision };
      } catch (error) {
        await done.catch(() => undefined);
        throw error;
      }
    },

    async keep(pending) {
      const database = await db();
      const transaction = database.transaction(["meta", "outbox"], "readwrite");
      const done = committed(transaction);

      try {
        await guard(transaction);
        transaction.objectStore("outbox").put(pending, [pending.client, pending.id]);
        options.interfere?.("keep", transaction);
        await done;
      } catch (error) {
        await done.catch(() => undefined);
        throw error;
      }
    },

    async drop(keys) {
      const database = await db();
      const transaction = database.transaction(["meta", "outbox"], "readwrite");
      const done = committed(transaction);

      try {
        await guard(transaction);

        for (const key of keys) {
          transaction.objectStore("outbox").delete([key.client, key.id]);
        }

        options.interfere?.("drop", transaction);
        await done;
      } catch (error) {
        await done.catch(() => undefined);
        throw error;
      }
    },

    /** Drop this device's copy and its outbox, and move to a new generation so no open tab writes it back. */
    async forget() {
      const database = await db();
      const transaction = database.transaction([...names, "meta", "outbox"], "readwrite");
      const done = committed(transaction);
      const meta = transaction.objectStore("meta");
      const stored = await request<unknown>(meta.get("generation"));

      for (const name of [...names, "outbox"]) {
        transaction.objectStore(name).clear();
      }

      meta.delete("checkpoint");
      meta.put((typeof stored === "number" ? stored : 0) + 1, "generation");
      await done;
    },
  };
}
