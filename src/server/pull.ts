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

    /**
     * A reply: `size` rows of `page` (fetched with one row more, to know if older ones are left), the first `count` of
     * `kept` receipts with the rows they name, and `extra` history rows beside them; once each, as the store holds
     * them now. Says whether it fits the caps, and how many rows it carries.
     */
    const reply = (
      fixed: { reset: boolean; from: string | null; unpaged: U; at?: Row },
      page: Row[],
      kept: readonly Rc[],
      extra: Row[]
    ) => {
      const named = kept.map((each) =>
        options.receipts.names(each).flatMap((name) => sql.named.all(name))
      );

      return (size: number, count = kept.length) => {
        const rows = new Map<SQLOutputValue | undefined, Row>();

        for (const row of [...page.slice(0, size), ...extra, ...named.slice(0, count).flat()]) {
          rows.set(row[key], rows.get(row[key]) ?? row);
        }

        const made = answer({
          ...base,
          ...fixed,
          rows: [...rows.values()].map(paged.read),
          receipts: kept.slice(0, count),
          page: place(dataset, fixed.from, page[size - 1] ?? fixed.at, page.length > size),
        });

        const carried = rows.size + sizeOf(fixed.unpaged);

        return { made, carried, fits: carried <= limits.maxRows && made.bytes <= limits.maxBytes };
      };
    };

    if (!reset) {
      const unpaged = options.unpaged(since);
      const room = cursor === null ? 0 : limits.pageRows;
      const page = cursor === null ? [] : sql.older.all(...cursor, room + 1);

      // The cursor as the row it stands for: a reply with no older row leaves the copy there.
      const at =
        cursor === null
          ? {}
          : {
              at: Object.fromEntries(order.map((column, index) => [column, cursor[index] ?? null])),
            };

      const build = reply(
        { reset: false, from: request.page, unpaged, ...at },
        page,
        receipts(since),
        sql.changes.all(since)
      );

      const alone = build(0);

      // Only a delta (with its receipts' rows and the other tables) that can't fit by itself starts the copy over; the
      // older page takes the rows and bytes it leaves.
      if (alone.fits) {
        const most = Math.min(room, page.length, limits.maxRows - alone.carried);

        return build(largest(1, most, (size) => build(size).fits) ?? 0).made;
      }
    }

    // Everything, from the newest page: one row of it at least, then as many receipts (with their rows) as fit, then
    // as many more of the first rows. A receipt left out is asked for again by the next pull.
    const kept = receipts(0);
    const page = sql.top.all(limits.firstRows + 1);
    const least = Math.min(1, page.length);
    const build = reply({ reset: true, from: null, unpaged: options.unpaged(0) }, page, kept, []);
    const count = largest(0, kept.length, (at) => build(least, at).fits);

    if (count === undefined) {
      throw new Error(
        `pull: the reply can't fit its caps (${limits.maxRows} rows, ${limits.maxBytes} bytes), even with one row of history`
      );
    }

    const most = Math.min(limits.firstRows, page.length);

    return build(largest(least, most, (at) => build(at, count).fits) ?? least, count).made;
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
