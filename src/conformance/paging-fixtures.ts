import { expect } from "vitest";

import { check, literal, nullable, number, object, optional, string, variant } from "../schema.ts";
import type { Effect, Model, Patch, Replica } from "../sync.ts";
import { copy, patch, row, sync } from "./fixtures.ts";
import type { Command, Outcome, PatchRows, Row, Server, Tables } from "./fixtures.ts";

/** Wire and checkpoint vocabulary shared by the conformance inputs. */
export type Page = {
  from: string | null;
  next: string | null;
  through: string | null;
  held: number;
  total: number;
};

export type History =
  | { kind: "complete" }
  | { kind: "partial"; next: string; through: string | null; held: number; total: number };

export type PagedCopy = Replica<Tables, Server> & { history: History };

export type PagedPatch = Patch<PatchRows, Server> & { page: Page };

export type M = Model<Tables, Server, Command, Outcome>;

export type E = Effect<Tables, Server, Command, Outcome>;

export const complete = { kind: "complete" } as const;
export const newest = [row("f", 60, 10), row("e", 50, 10)];
export const middle = [row("d", 40, 10), row("c", 30, 10)];
export const oldest = [row("b", 20, 10), row("a", 10, 10)];
export const all = [...newest, ...middle, ...oldest];
export const firstPage: Page = { from: null, next: "older:e:50", through: "50", held: 2, total: 6 };

export const secondPage: Page = {
  from: "older:e:50",
  next: "older:c:30",
  through: "30",
  held: 4,
  total: 6,
};

export const lastPage: Page = { from: "older:c:30", next: null, through: null, held: 6, total: 6 };

export function paged(
  revision: number,
  rows: Row[],
  page: Page,
  reset = false,
  dataset = "dataset-a"
): PagedPatch {
  return { ...patch(revision, rows, reset, dataset), page };
}

export function partialCopy(revision = 10, rows = newest, page = firstPage): PagedCopy {
  if (page.next === null) {
    return { ...copy(revision, rows), history: complete };
  }

  return {
    ...copy(revision, rows),
    history: {
      kind: "partial",
      next: page.next,
      through: page.through,
      held: page.held,
      total: page.total,
    },
  };
}

const historySchema = variant("kind", {
  complete: object({ kind: literal("complete") }),
  partial: object({
    kind: literal("partial"),
    next: string(),
    through: nullable(string()),
    held: number({ integer: true, min: 0 }),
    total: number({ integer: true, min: 0 }),
  }),
});

export function history(replica: Replica<Tables, Server>): History | undefined {
  if (!("history" in replica)) {
    return undefined;
  }

  const parsed = check(historySchema, replica.history);

  if (!parsed.ok) {
    throw new Error("invalid history shape");
  }

  return parsed.value;
}

export function requestedPage(request: {
  client: string;
  since: number;
}): string | null | undefined {
  const parsed = check(optional(nullable(string())), "page" in request ? request.page : undefined);

  if (!parsed.ok) {
    throw new Error("invalid request page");
  }

  return parsed.value;
}

const emptyCopy: PagedCopy = { ...copy(0, []), history: complete };

export function loaded(replica: Replica<Tables, Server> = emptyCopy): M {
  return sync.update(sync.initial("page-a", 0), {
    type: "loaded",
    replica,
    commands: [],
    unreadable: 0,
    now: 0,
  })[0];
}

export function deliver(
  model: M,
  reply: PagedPatch | Patch<PatchRows, Server>,
  since = model.replica.revision
): readonly [M, readonly E[]] {
  return sync.update(model, {
    type: "pulled",
    since,
    patch: reply,
    receipts: [],
    now: model.now + 1,
  });
}

/** A tiny independent history: only the authoritative rows, indexed by revision. No client merge or digest. */
export class Reference {
  private readonly revisions = new Map<number, ReadonlyMap<string, Row>>();
  constructor(revision: number, rows: readonly Row[]) {
    this.revisions.set(
      revision,
      new Map(rows.flatMap((item) => (item.deleted ? [] : [[item.id, item]])))
    );
  }
  write(revision: number, changes: readonly Row[]): void {
    const previous = [...this.revisions.values()].at(-1);
    const next = new Map(previous);

    for (const item of changes) {
      if (item.deleted) {
        next.delete(item.id);
      } else {
        next.set(item.id, item);
      }
    }

    this.revisions.set(revision, next);
  }
  at(revision: number): ReadonlyMap<string, Row> {
    const rows = this.revisions.get(revision);

    if (rows === undefined) {
      throw new Error(`no reference revision ${revision}`);
    }

    return rows;
  }
}

/** Every held row must be current; the declared covered range must be fully present. */
export function assertCopy(model: M, reference: Reference): void {
  const expected = reference.at(model.replica.revision);

  for (const [id, item] of model.replica.tables.rows) {
    expect(item, `held row ${id} at ${model.replica.revision}`).toStrictEqual(
      expected.get(String(id))
    );
  }

  const claim = history(model.replica);
  expect(claim).toBeDefined();

  if (claim === undefined) {
    throw new Error("missing history");
  }

  const kind = claim.kind;
  const through = claim.kind === "partial" ? claim.through : null;

  const covered = [...expected.values()].filter(
    (item) => kind === "complete" || (through !== null && item.value >= Number(through))
  );

  for (const item of covered) {
    expect(model.replica.tables.rows.get(item.id)).toStrictEqual(item);
  }

  if (kind === "complete") {
    expect(model.replica.tables.rows.size).toBe(expected.size);
  } else {
    expect(kind).toBe("partial");
    expect(claim.held).toBeGreaterThanOrEqual(covered.length);
    expect(claim.held).toBeLessThanOrEqual(expected.size);
    expect(claim.total).toBe(expected.size);
  }
}
