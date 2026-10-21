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
 *   together within `maxRows`, the reply as `respond` builds it within `maxBytes` encoded. A delta that doesn't fit in
 *   rows with a full page beside it, or doesn't fit in bytes, is answered as a paged reset; an older page shrinks to
 *   fit its bytes. The caps must hold the other tables, the receipts and one row of history.
 * - **Receipts carry their rows.** A row a receipt names is in the reply that carries the receipt, even below the page,
 *   so a command settles only on a copy that holds its effects.
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
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

import type { Page } from "../sync.ts";

/** The caps of a paging-aware reply: rows of the first and later pages, and the whole reply in rows and bytes. */
export type PullLimits = { firstRows: number; pageRows: number; maxRows: number; maxBytes: number };

/** What `pull` reads of a request: the copy's dataset and revision, and the older page it wants. */
export type PullAsk = { dataset: string | null; since: number; page?: string | null };

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

const count = (tables: Record<string, readonly unknown[]>) =>
  Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);

const tally = (row: Row | undefined) => Number(row?.n ?? 0);

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
  receipts: {
    read: (since: number, caller: Caller) => readonly Rc[];
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

  /** A cursor's order values, or undefined for one this history can't honour. */
  function decode(text: string, dataset: string): SQLInputValue[] | undefined {
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

  /** Where a page ending at `last` leaves the copy, at this revision. */
  function place(dataset: string, from: string | null, last: Row | undefined, more: boolean): Page {
    const total = tally(sql.total.get());

    if (last === undefined || !more) {
      return { from, next: null, through: null, held: total, total };
    }

    const at = values(last, group);
    const split = sql.split.get(...at, ...values(last, [key])) !== undefined;
    const above = split ? sql.above.get(...at) : undefined;

    return {
      from,
      next: encode(dataset, last),
      through: split
        ? above === undefined
          ? null
          : paged.through(Object.values(above))
        : paged.through(at),
      held: tally(sql.held.get(...values(last, order))),
      total,
    };
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

    /** The rows the receipts name, once each, as the store holds them now. */
    const named = (list: readonly Rc[]) => {
      const keys = new Set(list.flatMap((each) => options.receipts.names(each)));

      return [...keys].flatMap((each) => sql.named.all(each));
    };

    /**
     * The reply with `size` rows of `page` (fetched with one row more, to know if older ones are left), and `extra`
     * history rows beside them; the largest size from `least` up to `most` whose reply fits its bytes.
     */
    const fit = (
      fixed: { reset: boolean; from: string | null; unpaged: U; receipts: Rc[] },
      page: Row[],
      extra: Row[],
      least: number,
      most: number
    ) => {
      const build = (size: number) => {
        const rows = page.slice(0, size);
        const keys = new Set(rows.map((row) => row[key]));

        return answer({
          ...base,
          ...fixed,
          rows: [...rows, ...extra.filter((row) => !keys.has(row[key]))].map(paged.read),
          page: place(dataset, fixed.from, rows.at(-1), page.length > size),
        });
      };

      let low = least;
      let high = most;
      let best: ReturnType<typeof build> | undefined;

      while (low <= high) {
        const size = Math.floor((low + high) / 2);
        const made = build(size);

        if (made.bytes <= limits.maxBytes) {
          best = made;
          low = size + 1;
        } else {
          high = size - 1;
        }
      }

      return { best, build };
    };

    if (!reset) {
      const changed = sql.changes.all(since);
      const keys = new Set(changed.map((row) => row[key]));
      const unpaged = options.unpaged(since);
      const kept = [...receipts(since)];
      const extra = [...changed, ...named(kept).filter((row) => !keys.has(row[key]))];
      const room = cursor === null ? 0 : limits.pageRows;

      if (extra.length + count(unpaged) + room <= limits.maxRows) {
        const page = cursor === null ? [] : sql.older.all(...cursor, room + 1);
        const most = Math.min(room, page.length);

        const { best } = fit(
          { reset: false, from: request.page, unpaged, receipts: kept },
          page,
          extra,
          Math.min(1, most),
          most
        );

        if (best !== undefined) {
          return best;
        }
      }
    }

    // Everything, from the newest page: as many of the first rows as fit beside the other tables and the receipts.
    const unpaged = options.unpaged(0);
    const kept = [...receipts(0)];
    const extra = named(kept);
    const page = sql.top.all(limits.firstRows + 1);
    const room = limits.maxRows - count(unpaged) - extra.length;
    const most = Math.min(page.length, Math.max(1, Math.min(limits.firstRows, room)));
    const fixed = { reset: true, from: null, unpaged, receipts: kept };
    const { best, build } = fit(fixed, page, extra, Math.min(1, most), most);

    return best ?? build(Math.min(1, most));
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
      return assemble(request, (since) => options.receipts.read(since, caller));
    } finally {
      if (own) {
        db.exec("commit");
      }
    }
  }

  return { pull };
}
