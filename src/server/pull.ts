/**
 * The server half of pull, over SQLite: the app's history table read newest first in pages by a keyset order, its
 * other tables whole, and the receipts of the caller's commands with the rows they name, assembled in one read
 * transaction at one revision and bounded in rows and encoded bytes. `sync` is the client half.
 *
 * Invariants it owns:
 * - **One revision.** The delta, the page, the counts, the coverage boundary and the receipts' rows are read in one
 *   transaction (`pull` is synchronous and opens its own unless the caller has one open), so every row in a reply is
 *   the store's row at the reply's revision.
 * - **Keyset cursors.** A cursor is the page's last row by its order values and unique key, with the dataset and the
 *   order's `version`: never an offset, and never looked up from that row again, so an anchor edited or tombstoned
 *   since skips nothing. A cursor of another dataset or order version, or one that doesn't parse, gets a paged reset.
 * - **Truthful coverage.** `held` counts the live rows at or above the cursor and `total` every live row. `through` is
 *   the lowest order group held whole: a page ending inside a tie leaves that group out until it lands whole, and it
 *   is null while no group is whole.
 * - **Every paging-aware reply is bounded** by `limits`: the history's rows, the other tables' and the receipts' rows
 *   together within `maxRows`, the reply as `respond` builds it within `maxBytes` encoded. A delta (with its receipts'
 *   rows and the other tables) that can't fit by itself is answered as a paged reset; otherwise the older page shrinks
 *   to the rows and bytes it leaves, and with no room at all the cursor stays where it was. A reset carries one row of history at least, then as many receipts as fit, then more rows; one
 *   that can't fit even so (the other tables alone are over the caps) is never sent: `pull` throws, a server fault
 *   the page sees as unavailable and retries.
 * - **A reply costs about one encoding.** Each candidate is measured, not built: the reply as `respond` makes it with no
 *   rows, plus each row's own encoding (every row read and encoded once) and a comma between rows; counts run once per
 *   reply, and a candidate's coverage is read from the rows it fetched. The chosen reply is built once, and checked: one
 *   whose bytes aren't its rows' (a `respond` that reshapes rows) is chosen again by building each candidate whole.
 * - **Receipts carry their rows.** A row a receipt names is in the reply that carries the receipt, even below the page,
 *   so a command settles only on a copy that holds its effects. A paging client names the commands it waits on (any of
 *   its pages', at most a push's worth); a receipt left out for room is asked for again by its next pull.
 * - **Old clients keep the old protocol.** A request without `page` gets the whole reply as before: everything on a
 *   reset, the changes otherwise, without page metadata and unbounded.
 *
 * The history table has a `revision` column (the revision that last wrote the row), keeps tombstones (`live` tells
 * them apart), and has an index on its order columns, which are never null. The order is descending in every column;
 * its last column is the unique key that receipts name.
 *
 * A fingerprint for `verify` (asked only by a complete copy) is the app's: read what it covers in the same transaction,
 * by opening one around `pull`, and keep its few bytes in mind under `maxBytes`, which measures `respond`'s reply.
 */
import { Buffer } from "node:buffer";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { Page } from "../sync.ts";

/** The caps of a paging-aware reply: rows of the first and later pages, and the whole reply in rows and bytes. */
export type PullLimits = { firstRows: number; pageRows: number; maxRows: number; maxBytes: number };

/** A command by the page that sent it and its number. */
export type CommandRef = { client: string; id: number };

/**
 * What `pull` reads of a request: the copy's dataset and revision, the older page it wants, and the commands it still
 * waits on (any of its pages', at most a push's worth).
 */
export type PullAsk = {
  dataset: string | null;
  since: number;
  page?: string | null;
  commands?: readonly CommandRef[];
};

/** A reply before the app shapes it: the history's rows, the other tables, the receipts and the page. */
export type Pulled<R, U, Rc> = {
  dataset: string;
  revision: number;
  /** Everything (of the history, from its newest page), not changes: the copy starts over. */
  reset: boolean;
  /** The history table's rows: the page newest first, then the changes and the receipts' rows. */
  rows: R[];
  unpaged: U;
  receipts: Rc[];
  /** Absent for a request without `page`. */
  page?: Page;
};

type Row = Record<string, SQLOutputValue>;

const marks = (columns: readonly string[]) => columns.map(() => "?").join(", ");

const sizeOf = (tables: Record<string, readonly unknown[]>) =>
  Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);

const tally = (row: Row | undefined) => Number(row?.n ?? 0);

/** The largest whole number from `low` to `high` that `fits`, or undefined (`fits` holds for every one below it). */
function largest(low: number, high: number, fits: (at: number) => boolean): number | undefined {
  let found: number | undefined;
  let from = low;
  let to = high;

  while (from <= to) {
    const at = Math.floor((from + to) / 2);

    if (fits(at)) {
      found = at;
      from = at + 1;
    } else {
      to = at - 1;
    }
  }

  return found;
}

/** A row's values in these order columns, which are never null: what a cursor holds. */
const values = (row: Row, columns: readonly string[]): (string | number)[] =>
  columns.map((column) => {
    const value = row[column];

    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError(`pull: order column ${column} must be text or a number`);
    }

    return value;
  });

export type PullOptions<R, U extends Record<string, readonly unknown[]>, Rc, Caller, Res> = {
  db: DatabaseSync;
  dataset: () => string;
  revision: () => number;
  /** Whether a delta can follow from `since` (a revision this history still has). Default: any up to the head. */
  known?: (since: number) => boolean;
  /** The history: the table paged newest first. */
  paged: {
    table: string;
    /** Order columns, newest first, all descending; the last one is the row's unique key. */
    order: readonly string[];
    /** Changes whenever the order does, so no cursor of another order is honoured. */
    version: string | number;
    /** SQL condition true for a row that isn't a tombstone. */
    live: string;
    /** A table row, as the reply carries it. */
    read: (row: Row) => R;
    /** A fully covered order group's values (the order without its key, or the key alone), as the app shows them. */
    through: (values: readonly SQLOutputValue[]) => string;
  };
  /** The other tables' rows changed after `since`, or every live row for 0: always whole on a reset. */
  unpaged: (since: number) => U;
  /** The caller's receipts stamped after `since`, and the history rows (by key) each one names. */
  /**
   * The receipts a reply carries, and the history rows (by key) each one names. With `commands` (a paging client's),
   * those commands' receipts, scoped to the caller's principal; without, the caller's client's receipts stamped after
   * `since`, as before.
   */
  receipts: {
    read: (
      ask: { since: number; commands?: readonly CommandRef[] },
      caller: Caller
    ) => readonly Rc[];
    names: (receipt: Rc) => readonly (string | number)[];
  };
  limits: PullLimits;
  /** The reply the endpoint answers: the bounds measure its JSON. */
  respond: (pulled: Pulled<R, U, Rc>) => Res;
};

export function createPull<R, U extends Record<string, readonly unknown[]>, Rc, Caller, Res>(
  options: PullOptions<R, U, Rc, Caller, Res>
) {
  const { db, limits, paged } = options;

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`pull: ${name} must be a positive integer, got ${value}`);
    }
  }

  if (limits.firstRows > limits.maxRows || limits.pageRows > limits.maxRows) {
    throw new Error("pull: a page must fit in maxRows");
  }

  const order = paged.order;
  const unique = order.at(-1);

  if (unique === undefined) {
    throw new Error("pull: the paged order needs at least its key column");
  }

  const key: string = unique;

  const group = order.length > 1 ? order.slice(0, -1) : order;
  const live = `from ${paged.table} where ${paged.live}`;
  const newest = `order by ${order.map((column) => `${column} desc`).join(", ")} limit ?`;

  const sql = {
    changes: db.prepare(`select * from ${paged.table} where revision > ?`),
    live: db.prepare(`select * ${live}`),
    top: db.prepare(`select * ${live} ${newest}`),
    older: db.prepare(`select * ${live} and (${order.join(", ")}) < (${marks(order)}) ${newest}`),
    total: db.prepare(`select count(*) as n ${live}`),
    held: db.prepare(`select count(*) as n ${live} and (${order.join(", ")}) >= (${marks(order)})`),
    split: db.prepare(
      `select 1 as n ${live} and (${group.join(", ")}) = (${marks(group)}) and ${key} < ? limit 1`
    ),
    above: db.prepare(
      `select ${group.join(", ")} ${live} and (${group.join(", ")}) > (${marks(group)}) order by ${group.map((column) => `${column} asc`).join(", ")} limit 1`
    ),
    named: db.prepare(`select * from ${paged.table} where ${key} = ?`),
  };

  const encode = (dataset: string, row: Row) =>
    JSON.stringify([dataset, paged.version, ...values(row, order)]);

  /** Whether a row is in the order group `at`. */
  const same = (row: Row, at: readonly (string | number)[]) =>
    values(row, group).every((value, index) => value === at[index]);

  /** A cursor's order values, or undefined for one this history can't honour. */
  function decode(text: string, dataset: string): (string | number)[] | undefined {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    if (
      !Array.isArray(parsed) ||
      parsed.length !== order.length + 2 ||
      parsed[0] !== dataset ||
      parsed[1] !== paged.version
    ) {
      return undefined;
    }

    const at: unknown[] = parsed.slice(2);

    return at.every(
      (value) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    )
      ? at.filter((value) => typeof value === "string" || typeof value === "number")
      : undefined;
  }

  function assemble(request: PullAsk, receipts: (since: number) => readonly Rc[]) {
    const dataset = options.dataset();
    const revision = options.revision();
    const { since } = request;
    const cursor = typeof request.page === "string" ? decode(request.page, dataset) : null;

    const reset =
      request.dataset !== dataset ||
      since <= 0 ||
      since > revision ||
      options.known?.(since) === false ||
      cursor === undefined;

    const answer = (pulled: Pulled<R, U, Rc>) => {
      const reply = options.respond(pulled);

      return { reply, bytes: Buffer.byteLength(JSON.stringify(reply)), pulled };
    };

    const base = { dataset, revision };

    // A client from before paging: the whole reply, as it always was.
    if (request.page === undefined) {
      const after = reset ? 0 : since;

      return answer({
        ...base,
        reset,
        rows: (after === 0 ? sql.live.all() : sql.changes.all(after)).map(paged.read),
        unpaged: options.unpaged(after),
        receipts: [...receipts(after)],
      });
    }

    // Counted once per reply: every candidate page is placed from these and from the rows it was read with.
    let total: number | undefined;
    const count = () => (total ??= tally(sql.total.get()));
    const above = new Map<string, (string | number)[] | null>();

    /** The lowest live order group above `at` (whole, so its values are the coverage boundary), once per group. */
    const higher = (at: (string | number)[]) => {
      const id = JSON.stringify(at);

      if (!above.has(id)) {
        const found = sql.above.get(...at);
        above.set(id, found === undefined ? null : values(found, group));
      }

      return above.get(id) ?? null;
    };

    /** Each row read and encoded once, by key: a row is the same everywhere in one reply (one transaction). */
    const encoded = new Map<SQLOutputValue | undefined, { value: R; bytes: number }>();

    const row = (each: Row) => {
      let found = encoded.get(each[key]);

      if (found === undefined) {
        const value = paged.read(each);
        found = { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
        encoded.set(each[key], found);
      }

      return found;
    };

    /**
     * A reply: `size` rows of `page` (fetched with one row more, to know if older ones are left, and live rows strictly
     * below the cursor `fixed.at`, or the newest ones), the first `count` of `kept` receipts with the rows they name,
     * and `extra` history rows beside them; once each, as the store holds them now. `held` counts the rows at or
     * above the cursor (none on a reset). `measure` says whether one fits the caps without building it: the reply as
     * `respond` makes it with no rows, plus each row's own encoded bytes and a comma between rows. `make` builds it.
     */
    const reply = (
      fixed: { reset: boolean; from: string | null; unpaged: U; at?: Row },
      page: Row[],
      kept: readonly Rc[],
      extra: Row[],
      held: () => number
    ) => {
      const named = kept.map((each) =>
        options.receipts.names(each).flatMap((name) => sql.named.all(name))
      );

      /**
       * Where a page of `size` rows leaves the copy: its last row (or the cursor), whether a live row of its group
       * lies below it (the next row fetched), the group above it (in the page, else one query), and `held`.
       */
      const place = (size: number): Page => {
        const last = page[size - 1] ?? fixed.at;
        const next = page[size];

        if (last === undefined || next === undefined) {
          return { from: fixed.from, next: null, through: null, held: count(), total: count() };
        }

        const at = values(last, group);
        let through: (string | number)[] | null = at;

        // A page ending inside a group leaves it out: the boundary is the lowest whole group above.
        if (same(next, at)) {
          const inPage = page.slice(0, Math.max(0, size - 1)).findLast((each) => !same(each, at));
          through = inPage === undefined ? higher(at) : values(inPage, group);
        }

        return {
          from: fixed.from,
          next: encode(dataset, last),
          through: through === null ? null : paged.through(through),
          held: held() + size,
          total: count(),
        };
      };

      const rows = (size: number, taken: number) => {
        const out = new Map<SQLOutputValue | undefined, Row>();

        for (const each of [...page.slice(0, size), ...extra, ...named.slice(0, taken).flat()]) {
          out.set(each[key], out.get(each[key]) ?? each);
        }

        return [...out.values()];
      };

      const pulled = (size: number, taken: number, carried: R[]): Pulled<R, U, Rc> => ({
        ...base,
        ...fixed,
        rows: carried,
        receipts: kept.slice(0, taken),
        page: place(size),
      });

      const fits = (carried: number, bytes: number) =>
        carried + sizeOf(fixed.unpaged) <= limits.maxRows && bytes <= limits.maxBytes;

      return {
        /** The rows fetched for the page, one more than it may carry when older ones are left. */
        fetched: page.length,
        receipts: kept.length,
        /** The reply's encoded bytes and whether it fits, from its rows' own encodings. */
        measure: (size: number, taken = kept.length) => {
          const carried = rows(size, taken);
          let bytes = answer(pulled(size, taken, [])).bytes + Math.max(0, carried.length - 1);

          for (const each of carried) {
            bytes += row(each).bytes;
          }

          return { bytes, fits: fits(carried.length, bytes) };
        },
        /** The reply itself, and whether it fits, encoded whole. */
        make: (size: number, taken = kept.length) => {
          const carried = rows(size, taken);

          const made = answer(
            pulled(
              size,
              taken,
              carried.map((each) => row(each).value)
            )
          );

          return { made, fits: fits(carried.length, made.bytes) };
        },
      };
    };

    type Built = ReturnType<typeof reply>;

    /** A delta's reply, and the newest page's: each read once, when first asked for. */
    let delta: Built | undefined;
    let fresh: Built | undefined;

    const forDelta = () => {
      if (delta === undefined) {
        const unpaged = options.unpaged(since);
        const room = cursor === null || cursor === undefined ? 0 : limits.pageRows;
        const page = room === 0 ? [] : sql.older.all(...(cursor ?? []), room + 1);
        let held: number | undefined;

        // The cursor as the row it stands for: a reply with no older row leaves the copy there.
        const at =
          cursor === null || cursor === undefined
            ? {}
            : {
                at: Object.fromEntries(
                  order.map((column, index) => [column, cursor[index] ?? null])
                ),
              };

        delta = reply(
          { reset: false, from: request.page ?? null, unpaged, ...at },
          page,
          receipts(since),
          sql.changes.all(since),
          // The live rows at or above the cursor: with the page's own rows, every row at or above its last.
          () => (held ??= cursor ? tally(sql.held.get(...cursor)) : 0)
        );
      }

      return delta;
    };

    const forReset = () => {
      fresh ??= reply(
        { reset: true, from: null, unpaged: options.unpaged(0) },
        sql.top.all(limits.firstRows + 1),
        receipts(0),
        [],
        () => 0
      );

      return fresh;
    };

    /**
     * The reply's shape by `fits`: a delta that fits by itself takes the older page's rows and bytes it leaves;
     * otherwise everything, from the newest page: one row of it at least, then as many receipts (with their rows) as
     * fit, then as many more of the first rows. A receipt left out is asked for again by the next pull.
     */
    const choose = (fits: (built: Built, size: number, taken?: number) => boolean) => {
      if (!reset) {
        const built = forDelta();

        // Only a delta (with its receipts' rows and the other tables) that can't fit by itself starts the copy over.
        if (fits(built, 0)) {
          const room = cursor === null ? 0 : limits.pageRows;
          const most = Math.min(room, built.fetched);

          return {
            built,
            size: largest(1, most, (size) => fits(built, size)) ?? 0,
            receipts: built.receipts,
          };
        }
      }

      const built = forReset();
      const least = Math.min(1, built.fetched);
      const kept = largest(0, built.receipts, (at) => fits(built, least, at));

      if (kept === undefined) {
        throw new Error(
          `pull: the reply can't fit its caps (${limits.maxRows} rows, ${limits.maxBytes} bytes), even with one row of history`
        );
      }

      const most = Math.min(limits.firstRows, built.fetched);

      return {
        built,
        size: largest(least, most, (at) => fits(built, at, kept)) ?? least,
        receipts: kept,
      };
    };

    // Measured from each row's own encoding, then built once. A reply whose encoding isn't its rows' (a `respond`
    // that reshapes rows) is chosen again by building each candidate whole.
    const measured = choose((built, size, taken) => built.measure(size, taken).fits);
    const made = measured.built.make(measured.size, measured.receipts);

    if (made.made.bytes === measured.built.measure(measured.size, measured.receipts).bytes) {
      return made.made;
    }

    const exact = choose((built, size, taken) => built.make(size, taken).fits);

    return exact.built.make(exact.size, exact.receipts).made;
  }

  /** The reply to one request, its encoded size, and what it carries before `respond` shaped it. */
  function pull(
    request: PullAsk,
    caller: Caller
  ): { reply: Res; bytes: number; pulled: Pulled<R, U, Rc> } {
    const own = !db.isTransaction;

    if (own) {
      db.exec("begin");
    }

    try {
      return assemble(request, (since) =>
        options.receipts.read(
          request.commands === undefined ? { since } : { since, commands: request.commands },
          caller
        )
      );
    } finally {
      if (own) {
        db.exec("commit");
      }
    }
  }

  return { pull };
}
