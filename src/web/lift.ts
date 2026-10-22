/**
 * Keeping a device's copy across a release that changes its tables (`indexedReplica`'s `lifts`), apart from the
 * replica so an app that never passes it ships none of it: without it, a copy under other row shapes starts over.
 *
 * - A table whose row shape is unchanged is kept as it is, one whose shape changed goes through its lift, a table that
 *   is new starts empty. A changed table with no lift, a row that still doesn't read, or a table this release doesn't
 *   have starts the copy over.
 * - The lifted copy is rewritten under this release's shapes in one transaction, only while the disk still holds the
 *   copy it came from; it keeps its dataset and revision (taps made on it carry it) but no server facts, and is marked
 *   lifted: it loads owing a real reset, so the first contact replaces it whole.
 */
import type { History, Lens } from "../sync.ts";
import { committed, request } from "./idb.ts";

type Entry = { key: string | number; row: unknown };

/** A lift per table: an earlier release's row, as this one reads it (a field it added, given). */
type Lifts = Readonly<Record<string, (row: unknown) => unknown>>;

/** What the replica found on the disk, and what it gives a lift to write with: the kit's own wiring. */
export type Earlier<T> = {
  /** The row shapes that wrote the copy. */
  written: string;
  dataset: string;
  revision: number;
  /** Each table's stored rows, in `tables`' order. */
  stored: readonly (readonly Entry[])[];
  /** The partial history the copy kept, when it reads. */
  history: History | undefined;
  tables: readonly Pick<Lens<T, never>, "name" | "shape" | "restore" | "snapshot">[];
  empty: T;
  /** This release's row shapes, complete and partial. */
  shapes: { complete: string; partial: string };
  database: IDBDatabase;
  /** Inside the write: refuses if the database was forgotten since the page loaded. */
  guard: (transaction: IDBTransaction) => Promise<void>;
  interfere?: (what: "commit", transaction: IDBTransaction) => void;
};

/** A copy lifted and rewritten; `lost` when the disk moved on first (another tab), so the load reads again. */
export type Lifted<T> = { tables: T; history: History } | "lost" | undefined;

const COMPLETE: History = { kind: "complete" };

/**
 * The copy as this release reads it: each table whose shape changed through its lift, the others as they are, a table
 * that is new empty. Undefined when any table can't be read.
 */
function read<T>(lifts: Lifts, earlier: Earlier<T>): { tables: T; partial: boolean } | undefined {
  const { written, stored, tables } = earlier;
  const partial = written.endsWith("\npartial");
  const before = new Set((partial ? written.slice(0, -"\npartial".length) : written).split("\n"));
  const prefixes = tables.map((lens) => `${JSON.stringify(lens.name)}:`);

  // A table this release doesn't have: a newer release's copy, or a table renamed. Neither is this one's to lift.
  if ([...before].some((line) => !prefixes.some((prefix) => line.startsWith(prefix)))) {
    return undefined;
  }

  let restored: T | undefined = earlier.empty;

  for (const [index, lens] of tables.entries()) {
    const rows = stored[index] ?? [];
    const prefix = prefixes[index] ?? "";
    const each = lifts[lens.name];
    let rowsRead: readonly Entry[];

    if (before.has(lens.shape)) {
      rowsRead = rows;
    } else if (![...before].some((line) => line.startsWith(prefix))) {
      rowsRead = [];
    } else if (each === undefined) {
      return undefined;
    } else {
      try {
        rowsRead = rows.map((entry) => ({ key: entry.key, row: each(entry.row) }));
      } catch {
        return undefined;
      }
    }

    restored = restored === undefined ? undefined : lens.restore(restored, rowsRead);
  }

  return restored === undefined ? undefined : { tables: restored, partial };
}

/**
 * Write a lifted copy in place of the one it came from, in one transaction, if the disk still holds that one: its
 * dataset and revision, marked lifted, under this release's shapes. False when the disk moved on or refused.
 */
async function rewrite<T>(earlier: Earlier<T>, tables: T, history: History): Promise<boolean> {
  const names = earlier.tables.map((lens) => lens.name);
  const transaction = earlier.database.transaction([...names, "meta"], "readwrite");
  const done = committed(transaction);
  const meta = transaction.objectStore("meta");

  try {
    await earlier.guard(transaction);
    const point = await request<unknown>(meta.get("checkpoint"));

    const still =
      typeof point === "object" &&
      point !== null &&
      Reflect.get(point, "dataset") === earlier.dataset &&
      Reflect.get(point, "revision") === earlier.revision &&
      Reflect.get(point, "shapes") === earlier.written;

    if (!still) {
      transaction.abort();
      await done.catch(() => undefined);

      return false;
    }

    for (const name of names) {
      transaction.objectStore(name).clear();
    }

    for (const lens of earlier.tables) {
      for (const op of lens.snapshot(tables)) {
        if (!("drop" in op)) {
          transaction.objectStore(op.table).put(op.row, op.key);
        }
      }
    }

    meta.put(
      {
        dataset: earlier.dataset,
        revision: earlier.revision,
        server: null,
        lifted: true,
        ...(history.kind === "partial"
          ? { history, shapes: earlier.shapes.partial }
          : { shapes: earlier.shapes.complete }),
      },
      "checkpoint"
    );
    earlier.interfere?.("commit", transaction);
    await done;

    return true;
  } catch {
    await done.catch(() => undefined);

    return false;
  }
}

/**
 * Lifts an earlier release's copy: made by `lifting`, handed to `indexedReplica` as `lifts`. A class with a private
 * field, so nothing else passes for one: only it rewrites the copy and marks it lifted.
 */
export class Lifting {
  readonly #lifts: Lifts;

  constructor(lifts: Lifts) {
    this.#lifts = lifts;
  }

  async lift<T>(earlier: Earlier<T>): Promise<Lifted<T>> {
    const up = read(this.#lifts, earlier);

    if (up === undefined || (up.partial && earlier.history === undefined)) {
      return undefined;
    }

    const history = up.partial ? (earlier.history ?? COMPLETE) : COMPLETE;

    return (await rewrite(earlier, up.tables, history)) ? { tables: up.tables, history } : "lost";
  }
}

/**
 * By table, an earlier release's row as this one reads it. A lift may be handed any other release's row, a newer
 * one's too (a rollback): it parses the shapes it knows strictly and throws on others, which starts the copy over.
 * `lifting({})` keeps a copy across a release that only adds tables.
 */
export function lifting(lifts: Lifts): Lifting {
  return new Lifting(lifts);
}
