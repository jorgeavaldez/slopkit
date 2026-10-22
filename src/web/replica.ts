/**
 * The sync engine's storage port over IndexedDB: the replica (one store per table, out-of-line keys, and a checkpoint)
 * and the outbox (one record per command, keyed by client and number), in one database shared by every tab.
 *
 * - A commit is decided inside its own read-write transaction from the checkpoint the disk holds (`commitPlan`): a
 *   stale tab can't make the disk go back, and a patch whose base the disk never reached is written as the whole
 *   replica instead, so the checkpoint never covers rows the disk doesn't have.
 * - Every write checks the database's generation, read at load: after a forget in another tab this page's writes
 *   fail as `Replaced` instead of bringing the forgotten copy back.
 * - The outbox is written per command, never replaced whole, so tabs can't overwrite each other's intents. A new
 *   command is admitted inside its own write's transaction, from the store's count, so every tab shares one bound;
 *   a kept one always updates, and nothing kept is dropped for room.
 * - Rows are read back only under the row shapes that wrote them (each table's name and schema `shape`, kept with the
 *   checkpoint): any change to a table or its schema starts the rows over, with no number to bump by hand. The next
 *   commit then writes the whole replica, so the disk is repaired, not just the memory. Rows that don't parse are
 *   treated the same.
 * - A partial copy (a first copy still paging in) keeps its history in the checkpoint, written in the same transaction
 *   as its rows, and marks its row shapes as partial: a release from before paging reads it as another release's copy,
 *   so it never takes part of a history for all of it. A delta takes the patch's history only when the disk is at the
 *   cursor the patch moved from, and a complete copy at a revision is never narrowed to a partial one. The server's facts are not rows: facts an older page kept that no longer fit load as null and
 *   never cost the copy; facts that change at the same revision are written too.
 * - An upgrade keeps the outbox and the generation (an intent on disk is never erased; one this version can't read
 *   stays on disk and is counted) and the copy where it can: a table whose row shape is unchanged is kept as it is, one
 *   whose shape changed goes through the app's lift (`lifts`), a table that is new starts empty. The copy is rewritten
 *   under this release's shapes in one transaction, kept only if every table then reads, keeps its dataset and
 *   revision (taps made on it carry it) but no server facts, and is marked lifted: it loads owing a real reset, so the
 *   first contact replaces it whole; offline it shows what it had. A changed table with no lift, a row that still
 *   doesn't read, or a table this release doesn't have starts the copy over.
 * - A newer version opening in another tab closes this page's connection; its writes then fail as `Replaced`.
 *
 * `factory` is the browser's `indexedDB`, or any implementation of the same API (the headless simulation passes an
 * in-memory one). `interfere` is for tests: it sees each write transaction before it commits and may abort it.
 */
import { Replaced } from "../client.ts";
import type { StoragePort } from "../client.ts";
import { check, literal, nullable, number, object, string } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { commitPlan, OUTBOX_MAX } from "../sync.ts";
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
  /** Lifted from an earlier release's row shapes: owes a real reset before it's trusted; gone with a whole write. */
  lifted?: true;
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

/** The replica tables a checkpoint's row shapes name (each line `"<name>":<shape>`). */
function tablesOf(point: unknown): Set<string> {
  const written: unknown =
    typeof point === "object" && point !== null ? Reflect.get(point, "shapes") : undefined;

  const found = new Set<string>();

  for (const line of typeof written === "string" ? written.split("\n") : []) {
    const name = /^("(?:[^"\\]|\\.)*"):/.exec(line)?.[1];

    if (name !== undefined) {
      found.add(String(JSON.parse(name)));
    }
  }

  return found;
}

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
  /**
   * By table: an earlier release's row, as this one reads it (a field it added, given). A table whose row shape
   * changed needs one, or the copy starts over; a table whose shape didn't is kept as it is. A lift may be handed any
   * other release's row, a newer one's too (a rollback): it parses the shapes it knows strictly and throws on others,
   * which starts the copy over.
   */
  lifts?: Readonly<Record<string, (row: unknown) => unknown>>;
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

    // A store missing, or one this release doesn't have (a table dropped without a bump): the upgrade runs while the
    // checkpoint still names a dropped table, so its rows are deleted, never moved into the outbox.
    const missing =
      [...names, "meta", "outbox"].some((name) => !probe.objectStoreNames.contains(name)) ||
      [...probe.objectStoreNames].some(
        (name) => !names.includes(name) && name !== "meta" && name !== "outbox"
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
          // Replica tables stay for the load to lift; one the copy held that this release dropped goes (the server has
          // it). Every other store an earlier version kept may hold work nobody else has, so its records move into the
          // outbox: converted by `legacy`, else kept as they were under their own key, counted unreadable. Nothing is
          // dropped unseen.
          const legacy = options.legacy;
          const own = new Set(["meta", "outbox"]);

          if (!database.objectStoreNames.contains("outbox")) {
            database.createObjectStore("outbox");
          }

          const kept = database.objectStoreNames.contains("meta");

          if (!kept) {
            database.createObjectStore("meta");
          }

          const outbox = upgrade.objectStore("outbox");

          // A snapshot: deleting a store changes the live list being walked.
          const existing = [...database.objectStoreNames];

          const walk = (replicated: ReadonlySet<string>) => {
            for (const name of existing) {
              if (own.has(name) || names.includes(name)) {
                continue;
              }

              if (replicated.has(name)) {
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
          };

          if (kept) {
            const point = upgrade.objectStore("meta").get("checkpoint");
            point.onsuccess = () => walk(tablesOf(point.result));
          } else {
            walk(new Set());
          }

          for (const name of names) {
            if (!database.objectStoreNames.contains(name)) {
              database.createObjectStore(name);
            }
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

  type Entry = { key: string | number; row: unknown };

  /**
   * A copy an earlier release wrote under other row shapes, as this release reads it: each table whose shape changed
   * through its lift, the others as they are, a table that is new empty. Undefined when any table can't be read.
   */
  const lift = (
    written: string,
    stored: readonly (readonly Entry[])[]
  ): { tables: T; partial: boolean } | undefined => {
    const partial = written.endsWith("\npartial");
    const before = new Set((partial ? written.slice(0, -"\npartial".length) : written).split("\n"));
    const prefixes = options.tables.map((lens) => `${JSON.stringify(lens.name)}:`);

    // A table this release doesn't have: a newer release's copy, or a table renamed. Neither is this one's to lift.
    if ([...before].some((line) => !prefixes.some((prefix) => line.startsWith(prefix)))) {
      return undefined;
    }

    let restored: T | undefined = options.empty;

    for (const [index, lens] of options.tables.entries()) {
      const rows = stored[index] ?? [];
      const prefix = prefixes[index] ?? "";
      const each = options.lifts?.[lens.name];
      let read: readonly Entry[];

      if (before.has(lens.shape)) {
        read = rows;
      } else if (![...before].some((line) => line.startsWith(prefix))) {
        read = [];
      } else if (each === undefined) {
        return undefined;
      } else {
        try {
          read = rows.map((entry) => ({ key: entry.key, row: each(entry.row) }));
        } catch {
          return undefined;
        }
      }

      restored = restored === undefined ? undefined : lens.restore(restored, read);
    }

    return restored === undefined ? undefined : { tables: restored, partial };
  };

  /**
   * Write a lifted copy in place of the one it came from, in one transaction, if the disk still holds that one: its
   * dataset and revision, marked lifted, under this release's shapes. False when the disk moved on or refused.
   */
  const rewrite = async (
    from: { dataset: string; revision: number; shapes: string },
    tables: T,
    history: History
  ): Promise<boolean> => {
    const database = await db();
    const transaction = database.transaction([...names, "meta"], "readwrite");
    const done = committed(transaction);
    const meta = transaction.objectStore("meta");

    try {
      await guard(transaction);
      const point = await request<unknown>(meta.get("checkpoint"));

      const still =
        typeof point === "object" &&
        point !== null &&
        Reflect.get(point, "dataset") === from.dataset &&
        Reflect.get(point, "revision") === from.revision &&
        Reflect.get(point, "shapes") === from.shapes;

      if (!still) {
        transaction.abort();
        await done.catch(() => undefined);

        return false;
      }

      for (const name of names) {
        transaction.objectStore(name).clear();
      }

      for (const lens of options.tables) {
        for (const op of lens.snapshot(tables)) {
          if (!("drop" in op)) {
            transaction.objectStore(op.table).put(op.row, op.key);
          }
        }
      }

      const checkpoint: Checkpoint<S> = {
        dataset: from.dataset,
        revision: from.revision,
        server: null,
        lifted: true,
        ...(history.kind === "partial" ? { history, shapes: partialShapes } : { shapes }),
      };

      meta.put(checkpoint, "checkpoint");
      options.interfere?.("commit", transaction);
      await done;

      return true;
    } catch {
      await done.catch(() => undefined);

      return false;
    }
  };

  /** A load that lost a lift to another tab reads again once: that tab's rewrite is readable now. */
  let again = false;

  const port: StoragePort<T, S, C, O> & { forget: () => Promise<void> } = {
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

      const written: unknown =
        typeof point === "object" && point !== null ? Reflect.get(point, "shapes") : undefined;

      const held: unknown =
        typeof point === "object" && point !== null ? Reflect.get(point, "dataset") : null;

      // Another release's copy, and this one can lift it: rewritten under this release's shapes, claiming no history.
      if (typeof written === "string" && !ours(written) && typeof held === "string") {
        const up = lift(written, tables);
        const partial = check(partialSchema, Reflect.get(point ?? {}, "history"));
        const history: History = up?.partial === true && partial.ok ? partial.value : COMPLETE;

        const revision = typeof disk === "number" ? disk : 0;

        const wrote =
          up !== undefined &&
          (!up.partial || partial.ok) &&
          (await rewrite({ dataset: held, revision, shapes: written }, up.tables, history));

        if (up !== undefined && !wrote && !again) {
          again = true;

          try {
            return await port.load();
          } finally {
            again = false;
          }
        }

        if (up !== undefined && wrote) {
          loaded = {
            dataset: held,
            revision,
            shapes: history.kind === "partial" ? partialShapes : shapes,
          };
          discarded = null;

          return {
            replica: { dataset: held, revision, tables: up.tables, server: null, history },
            commands,
            unreadable,
            restart: "paged",
          };
        }
      }

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

      const lifted =
        typeof point === "object" && point !== null && Reflect.get(point, "lifted") === true;

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
        ...(lifted ? { restart: "paged" as const } : {}),
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

        const liftedOnDisk =
          typeof point === "object" && point !== null && Reflect.get(point, "lifted") === true;

        // The reset a lifted copy owes (a pull since 0, at or past its revision) replaces it whole even when the
        // server hasn't moved: the disk claims the revision, not the rows. A repair write (base at the revision) can't.
        const plan =
          liftedOnDisk &&
          commit.reset &&
          commit.base === 0 &&
          held === commit.replica.dataset &&
          commit.replica.revision >= stored.revision
            ? "whole"
            : commitPlan(stored, {
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

        // A lifted copy stays marked until a whole write replaces it: a delta or new facts don't make it trusted.
        const lifted = plan !== "whole" && liftedOnDisk;

        // A lifted copy keeps no server facts either until the reset: they'd vouch for rows the server never sent.
        const checkpoint: Checkpoint<S> = {
          ...target,
          ...(lifted ? { server: null, lifted: true as const } : {}),
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

        // A delta under the disk's own history leaves out rows of this page's copy: said, so a failed write stays owed.
        return {
          dataset: now.dataset,
          revision: now.revision,
          ...(plan === "delta" && stored.history.kind === "partial" ? { whole: false } : {}),
        };
      } catch (error) {
        await done.catch(() => undefined);
        throw error;
      }
    },

    async keep(pending, max = OUTBOX_MAX) {
      const database = await db();
      const transaction = database.transaction(["meta", "outbox"], "readwrite");
      const done = committed(transaction);
      const outbox = transaction.objectStore("outbox");
      const key = [pending.client, pending.id];

      try {
        await guard(transaction);

        // Admission is decided here, from the store's own count, so every tab shares one bound. A kept key always
        // updates; records already past the bound (an older release, a larger one) stay, and keep new ones out.
        if (
          (await request<number>(outbox.count(key))) === 0 &&
          (await request<number>(outbox.count())) >= max
        ) {
          const kept = await request<unknown[]>(outbox.getAll());

          // Unreadable records take room too: counted as waiting, since what they hold is unknown.
          const finished = kept.filter((each) => {
            const parsed = check(options.pending, each);

            return parsed.ok && parsed.value.state.kind === "done";
          }).length;

          await done;

          return { kind: "full", waiting: kept.length - finished, finished, max };
        }

        outbox.put(pending, key);
        options.interfere?.("keep", transaction);
        await done;

        return undefined;
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

    async mark(keys) {
      const database = await db();
      const transaction = database.transaction(["meta", "outbox"], "readwrite");
      const done = committed(transaction);
      const outbox = transaction.objectStore("outbox");

      try {
        await guard(transaction);

        const kept = await Promise.all(
          keys.map((key) => request<unknown>(outbox.get([key.client, key.id])))
        );

        // A push's commands, in flight, in one write: only records kept already, so nothing is admitted here.
        for (const [at, record] of kept.entries()) {
          const key = keys[at];

          if (key !== undefined && typeof record === "object" && record !== null) {
            outbox.put({ ...record, state: { kind: "sending" } }, [key.client, key.id]);
          }
        }

        // An outbox write, as a keep is.
        options.interfere?.("keep", transaction);
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

  return port;
}
