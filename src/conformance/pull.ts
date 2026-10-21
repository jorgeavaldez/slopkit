import { Buffer } from "node:buffer";

import { describe, expect, test } from "vitest";

/** Synthetic rows an application's adapter maps to its own paged and unpaged tables. Order is (value, id), descending. */
export type PullRow = { id: string; value: number; revision: number; deleted: boolean };

export type PullWrite = {
  rows: Omit<PullRow, "revision">[];
  unpaged?: Omit<PullRow, "revision">[];
  receipt?: { client: string; id: number; resource: string };
};

export type PullRequest = {
  client: string;
  dataset: string | null;
  since: number;
  verify: boolean;
  page?: string | null;
};

export type PullPage = {
  from: string | null;
  next: string | null;
  through: string | null;
  held: number;
  total: number;
};

export type PullReply = {
  patch: {
    dataset: string;
    revision: number;
    reset: boolean;
    rows: { rows: PullRow[]; unpaged: PullRow[] };
    page?: PullPage;
  };
  receipts: { id: number; revision: number; outcome: { resource: string } }[];
  /** Exact encoded response size, before normalization by the application's adapter. */
  bytes: number;
};

export type PullLimits = { firstRows: number; pageRows: number; maxRows: number; maxBytes: number };

export type PullFixture = {
  pull: (request: PullRequest) => Promise<PullReply>;
  /** One committed transaction, including any receipt. The adapter stamps the returned revision on all written rows. */
  write: (changes: PullWrite) => Promise<{ dataset: string; revision: number }>;
  /** A new dataset, with no rows, receipts or usable cursors from the previous dataset. */
  replace: () => Promise<void>;
  close: () => Promise<void>;
};

export type PullConformance = {
  name: string;
  create: (limits: PullLimits) => Promise<PullFixture>;
};

const limits: PullLimits = { firstRows: 2, pageRows: 3, maxRows: 16, maxBytes: 8192 };

const request = (
  dataset: string | null = null,
  since = 0,
  page: string | null = null
): PullRequest => ({ client: "pull-contract", dataset, since, page, verify: false });

const item = (id: string, value: number, deleted = false) => ({ id, value, deleted });

const seed = Array.from({ length: 11 }, (_, index) =>
  item(`row-${String(index).padStart(2, "0")}`, Math.floor(index / 2))
);

const sorted = (rows: Iterable<PullRow>) =>
  [...rows]
    .filter((row) => !row.deleted)
    .toSorted((a, b) => b.value - a.value || b.id.localeCompare(a.id));

/** Independent rows-per-revision reference, deliberately not a sync engine or a cursor decoder. */
class Rows {
  readonly snapshots = new Map<number, Map<string, PullRow>>();
  write(revision: number, changes: PullWrite["rows"]): void {
    const next = new Map([...this.snapshots.values()].at(-1));

    for (const row of changes) {
      if (row.deleted) {
        next.delete(row.id);
      } else {
        next.set(row.id, { ...row, revision });
      }
    }

    this.snapshots.set(revision, next);
  }
  at(revision: number): Map<string, PullRow> {
    const value = this.snapshots.get(revision);

    if (value === undefined) {
      throw new Error(`missing reference revision ${revision}`);
    }

    return value;
  }
}

function bounded(reply: PullReply, caps = limits): void {
  expect(reply.patch.rows.rows.length + reply.patch.rows.unpaged.length).toBeLessThanOrEqual(
    caps.maxRows
  );
  expect(reply.bytes).toBeLessThanOrEqual(caps.maxBytes);
  expect(reply.bytes).toBeGreaterThan(0);
}

function pageOf(reply: PullReply): PullPage {
  expect(reply.patch.page, "paging-aware replies carry page metadata").toBeDefined();

  if (reply.patch.page === undefined) {
    throw new Error("missing page metadata");
  }

  return reply.patch.page;
}

function claim(
  reply: PullReply,
  held: Map<string, PullRow>,
  reference: Rows,
  boundary?: PullRow
): void {
  const expected = reference.at(reply.patch.revision);

  for (const row of held.values()) {
    expect(row).toStrictEqual(expected.get(row.id));
  }

  const page = pageOf(reply);

  const covered = [...expected.values()].filter(
    (row) => page.next === null || (page.through !== null && row.value >= Number(page.through))
  );

  for (const row of covered) {
    expect(held.get(row.id)).toStrictEqual(row);
  }

  if (page.next === null) {
    expect(page.held).toBe(expected.size);
  } else if (boundary !== undefined) {
    const progress = sorted(expected.values()).filter(
      (row) => row.value > boundary.value || (row.value === boundary.value && row.id >= boundary.id)
    );

    expect(page.held).toBe(progress.length);

    const wholeTie = [...expected.values()]
      .filter((row) => row.value === boundary.value)
      .every((row) => progress.some((kept) => kept.id === row.id));

    const fullyCovered = wholeTie
      ? boundary.value
      : sorted(expected.values()).findLast((row) => row.value > boundary.value)?.value;

    expect(page.through).toBe(fullyCovered === undefined ? null : String(fullyCovered));
  }

  expect(page.total).toBe(expected.size);

  if (page.next === null) {
    expect(sorted(held.values())).toStrictEqual(sorted(expected.values()));
  }
}

function apply(reply: PullReply, held: Map<string, PullRow>): void {
  if (reply.patch.reset) {
    held.clear();
  }

  for (const row of reply.patch.rows.rows) {
    if (row.deleted) {
      held.delete(row.id);
    } else {
      held.set(row.id, row);
    }
  }
}

/** Registers black-box pull requirements against a fresh real application store for each case. */
export function pullConformance(input: PullConformance): void {
  const scenario = (name: string, run: (fixture: PullFixture) => Promise<void>) =>
    test(name, async () => {
      const fixture = await input.create(limits);

      try {
        await run(fixture);
      } finally {
        await fixture.close();
      }
    });

  describe(`${input.name}: paged pull contract`, () => {
    scenario(
      "16: newest first, ties stable, every row once; request count matches declared caps",
      async (app) => {
        const point = await app.write({ rows: seed });
        const reference = new Rows();
        reference.write(point.revision, seed);
        const held = new Map<string, PullRow>();
        const seen: string[] = [];
        let reply = await app.pull(request());
        let count = 0;
        let offset = 0;
        const expected = sorted(reference.at(point.revision).values());

        for (;;) {
          count++;
          bounded(reply);
          const page = pageOf(reply);
          const size = count === 1 ? limits.firstRows : limits.pageRows;
          expect(reply.patch.rows.rows).toStrictEqual(expected.slice(offset, offset + size));
          seen.push(...reply.patch.rows.rows.map((row) => row.id));
          offset += reply.patch.rows.rows.length;
          apply(reply, held);
          claim(reply, held, reference, expected[offset - 1]);

          if (page.next === null) {
            break;
          }

          expect(count).toBeLessThanOrEqual(
            1 + Math.ceil((seed.length - limits.firstRows) / limits.pageRows)
          );
          // oxlint-disable-next-line no-await-in-loop -- each request consumes the preceding opaque cursor
          reply = await app.pull(request(reply.patch.dataset, reply.patch.revision, page.next));
        }

        expect(seen).toStrictEqual(expected.map((row) => row.id));
        expect(new Set(seen).size).toBe(seed.length);
        expect(count).toBe(1 + Math.ceil((seed.length - limits.firstRows) / limits.pageRows));
      }
    );

    scenario(
      "16: edited and tombstoned anchors do not skip older rows; writes remain current in every chunk",
      async (app) => {
        const point = await app.write({ rows: seed });
        const reference = new Rows();
        reference.write(point.revision, seed);
        const held = new Map<string, PullRow>();
        let reply = await app.pull(request());
        bounded(reply);
        apply(reply, held);
        claim(
          reply,
          held,
          reference,
          sorted(reference.at(point.revision).values())[limits.firstRows - 1]
        );
        const anchor = reply.patch.rows.rows.at(-1);

        if (anchor === undefined) {
          throw new Error("no anchor");
        }

        const changes = [
          item(anchor.id, -10),
          item("insert-above", 100),
          item("insert-below", -20),
          item("row-00", -30),
          item("row-02", 1, true),
        ];

        let point2 = await app.write({ rows: changes });
        reference.write(point2.revision, changes);
        let pages = 0;
        let boundary = anchor;

        while (pageOf(reply).next !== null) {
          const previous = reply;
          // oxlint-disable-next-line no-await-in-loop -- concurrent writes are scheduled between successive chunk reads
          reply = await app.pull(
            request(previous.patch.dataset, previous.patch.revision, pageOf(previous).next)
          );
          bounded(reply);
          expect(pageOf(reply).from).toBe(pageOf(previous).next);

          const previousBoundary = boundary;

          const older = sorted(reference.at(point2.revision).values())
            .filter(
              (row) =>
                row.value < previousBoundary.value ||
                (row.value === previousBoundary.value && row.id < previousBoundary.id)
            )
            .slice(0, limits.pageRows);

          for (const row of older) {
            expect(reply.patch.rows.rows).toContainEqual(row);
          }

          boundary = older.at(-1) ?? boundary;
          apply(reply, held);
          claim(reply, held, reference, boundary);

          if (pages === 0) {
            const deletion = [item(anchor.id, -10, true)];
            // oxlint-disable-next-line no-await-in-loop -- delete the edited anchor while download is still partial
            point2 = await app.write({ rows: deletion });
            reference.write(point2.revision, deletion);
          }

          pages++;
          expect(pages).toBeLessThanOrEqual(12);
        }

        expect(sorted(held.values())).toStrictEqual(sorted(reference.at(point2.revision).values()));
      }
    );

    scenario("16: overlapping writes and pulls read one coherent revision", async (app) => {
      const point = await app.write({ rows: seed });
      const reference = new Rows();
      reference.write(point.revision, seed);
      const changes = [item("overlap-newest", 100), item("row-10", 5, true)];

      const [reply, written] = await Promise.all([
        app.pull(request()),
        app.write({ rows: changes }),
      ]);

      reference.write(written.revision, changes);
      bounded(reply);
      const expected = sorted(reference.at(reply.patch.revision).values());
      expect(reply.patch.rows.rows).toStrictEqual(expected.slice(0, limits.firstRows));
      const held = new Map<string, PullRow>();
      apply(reply, held);
      claim(reply, held, reference, expected[limits.firstRows - 1]);
    });

    scenario(
      "16: a boundary tie is not a covered date; null means no complete order group yet",
      async (app) => {
        const tied = Array.from({ length: 7 }, (_, index) => item(`tie-${index}`, 50));
        const point = await app.write({ rows: tied });
        const reference = new Rows();
        reference.write(point.revision, tied);
        let reply = await app.pull(request());
        const held = new Map<string, PullRow>();
        bounded(reply);
        apply(reply, held);
        claim(reply, held, reference, sorted(reference.at(point.revision).values())[1]);
        expect(pageOf(reply)).toMatchObject({ through: null, held: 2, total: 7 });
        reply = await app.pull(
          request(reply.patch.dataset, reply.patch.revision, pageOf(reply).next)
        );
        bounded(reply);
        apply(reply, held);
        claim(reply, held, reference, sorted(reference.at(point.revision).values())[4]);
        expect(pageOf(reply)).toMatchObject({ through: null, held: 5, total: 7 });
        reply = await app.pull(
          request(reply.patch.dataset, reply.patch.revision, pageOf(reply).next)
        );
        bounded(reply);
        apply(reply, held);
        claim(reply, held, reference);
        expect(pageOf(reply)).toMatchObject({ next: null, held: 7, total: 7 });
      }
    );

    scenario(
      "16: the byte cap alone also turns an oversized delta into a paged reset",
      async (app) => {
        const point = await app.write({ rows: seed });

        const changes = Array.from({ length: limits.maxRows - 1 }, (_, index) =>
          item(`bytes-${index}`, 100 + index)
        );

        await app.write({ rows: changes });

        const legacy: PullRequest = {
          client: "pull-contract",
          dataset: point.dataset,
          since: point.revision,
          verify: false,
        };

        const delta = await app.pull(legacy);
        const first = await app.pull(request());
        expect(delta.bytes).toBeGreaterThan(first.bytes);
        // Calibrate from the application's actual wire encoding, not oversized synthetic ids or normalized JSON.
        const caps = { ...limits, maxBytes: Math.floor((delta.bytes + first.bytes) / 2) };
        const boundedApp = await input.create(caps);

        try {
          const base = await boundedApp.write({ rows: seed });
          await boundedApp.write({ rows: changes });
          const reply = await boundedApp.pull(request(base.dataset, base.revision));
          bounded(reply, caps);
          expect(reply.patch.reset).toBe(true);
          expect(pageOf(reply)).toMatchObject({ from: null, held: limits.firstRows });
          expect(reply.patch.rows.rows.map((row) => row.id)).toStrictEqual([
            changes.at(-1)?.id,
            changes.at(-2)?.id,
          ]);
        } finally {
          await boundedApp.close();
        }
      }
    );

    scenario("16: oversized deltas reset to a bounded newest-first page", async (app) => {
      const point = await app.write({ rows: seed });

      const changes = Array.from({ length: limits.maxRows + 1 }, (_, index) =>
        item(`delta-${index}`, 100 + index)
      );

      const after = await app.write({ rows: changes });
      const reply = await app.pull(request(point.dataset, point.revision));
      bounded(reply);
      expect(reply.patch.reset).toBe(true);
      expect(reply.patch.revision).toBe(after.revision);
      expect(pageOf(reply)).toMatchObject({
        from: null,
        held: limits.firstRows,
        total: seed.length + changes.length,
      });
      expect(reply.patch.rows.rows.map((row) => row.id)).toStrictEqual(["delta-16", "delta-15"]);
    });

    scenario(
      "16: small steady-state deltas do not restart complete copies, for new and old clients",
      async (app) => {
        const point = await app.write({ rows: seed });
        const changes = [item("row-00", 20), item("row-02", 1, true), item("steady-new", 90)];
        const written = await app.write({ rows: changes });

        const expected = changes
          .map((row) => ({ ...row, revision: written.revision }))
          .toSorted((a, b) => a.id.localeCompare(b.id));

        const modern = await app.pull(request(point.dataset, point.revision));
        bounded(modern);
        expect(modern.patch.reset).toBe(false);
        expect(modern.patch.rows.rows.toSorted((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
          expected
        );

        const legacy = await app.pull({
          client: "pull-contract",
          dataset: point.dataset,
          since: point.revision,
          verify: false,
        });

        expect(legacy.patch.reset).toBe(false);
        expect(legacy.patch.page).toBeUndefined();
        expect(legacy.patch.rows.rows.toSorted((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
          expected
        );
      }
    );

    scenario(
      "16: the combined delta, older page and receipt effect obey the row cap",
      async (app) => {
        const rows = Array.from({ length: 20 }, (_, index) =>
          item(`combined-${String(index).padStart(2, "0")}`, index)
        );

        await app.write({ rows });
        const first = await app.pull(request());

        const changes = Array.from({ length: 13 }, (_, index) =>
          item(`above-${index}`, 100 + index)
        );

        await app.write({
          rows: changes,
          receipt: { client: "pull-contract", id: 1, resource: "combined-00" },
        });

        const reply = await app.pull(
          request(first.patch.dataset, first.patch.revision, pageOf(first).next)
        );

        // 13 delta rows and the receipt's resource fit (14 of 16): the older page shrinks to the 2 rows left, with no
        // restart. A full 3-row page would make 17.
        bounded(reply);
        expect(reply.patch.reset).toBe(false);
        expect(pageOf(reply).from).toBe(pageOf(first).next);
        expect(pageOf(reply).next).not.toBe(pageOf(first).next);
        const ids = reply.patch.rows.rows.map((row) => row.id);
        expect(ids).toStrictEqual(
          expect.arrayContaining([...changes.map((row) => row.id), "combined-00"])
        );
        const older = ids.filter((id) => id.startsWith("combined-") && id !== "combined-00");
        expect(older.length).toBeGreaterThan(0);
        expect(older).toStrictEqual(["combined-17", "combined-16"].slice(0, older.length));
        expect(reply.receipts).toHaveLength(1);
      }
    );

    scenario(
      "16: an older page also shrinks to fit its encoded byte cap without restarting",
      async (app) => {
        await app.write({ rows: seed });
        const first = await app.pull(request());

        const next = await app.pull(
          request(first.patch.dataset, first.patch.revision, pageOf(first).next)
        );

        expect(next.bytes).toBeGreaterThan(first.bytes);
        const caps = { ...limits, maxBytes: Math.floor((first.bytes + next.bytes) / 2) };
        const boundedApp = await input.create(caps);

        try {
          await boundedApp.write({ rows: seed });
          const start = await boundedApp.pull(request());
          bounded(start, caps);

          const reply = await boundedApp.pull(
            request(start.patch.dataset, start.patch.revision, pageOf(start).next)
          );

          bounded(reply, caps);
          expect(reply.patch.reset).toBe(false);
          expect(reply.patch.rows.rows.length).toBeGreaterThan(0);
          expect(reply.patch.rows.rows.length).toBeLessThan(limits.pageRows);
          expect(pageOf(reply).next).not.toBe(pageOf(start).next);
        } finally {
          await boundedApp.close();
        }
      }
    );

    scenario("16: unknown and previous-dataset cursors produce paged resets", async (app) => {
      await app.write({ rows: seed });
      const first = await app.pull(request());
      const cursor = pageOf(first).next;

      const unknown = await app.pull(
        request(first.patch.dataset, first.patch.revision, "not-a-cursor")
      );

      bounded(unknown);
      expect(unknown.patch.reset).toBe(true);
      expect(pageOf(unknown).from).toBeNull();
      await app.replace();
      const point = await app.write({ rows: seed.slice(0, 4) });
      const replaced = await app.pull(request(point.dataset, point.revision, cursor));
      bounded(replaced);
      expect(replaced.patch.reset).toBe(true);
      expect(pageOf(replaced).from).toBeNull();
      expect(replaced.patch.dataset).not.toBe(first.patch.dataset);
    });

    scenario(
      "16 compatibility: absence of page returns the whole legacy copy, even above the paging bound",
      async (app) => {
        const rows = Array.from({ length: limits.maxRows + 5 }, (_, index) =>
          item(`legacy-${index}`, index)
        );

        const point = await app.write({ rows });

        const legacy: PullRequest = {
          client: "legacy-client",
          dataset: null,
          since: 0,
          verify: false,
        };

        const reply = await app.pull(legacy);
        expect(reply.patch.reset).toBe(true);
        expect(sorted(reply.patch.rows.rows)).toStrictEqual(
          sorted(rows.map((row) => ({ ...row, revision: point.revision })))
        );
        expect(reply.patch.page).toBeUndefined();
      }
    );

    scenario(
      "16: receipts name rows actually carried by a reset, including effects below its page",
      async (app) => {
        await app.write({ rows: seed });

        const point = await app.write({
          rows: [item("receipt-effect", -100)],
          receipt: { client: "pull-contract", id: 1, resource: "receipt-effect" },
        });

        const reply = await app.pull(request());
        bounded(reply);
        expect(reply.receipts).toContainEqual({
          id: 1,
          revision: point.revision,
          outcome: { resource: "receipt-effect" },
        });
        expect(reply.patch.rows.rows).toContainEqual({
          ...item("receipt-effect", -100),
          revision: point.revision,
        });
        expect(pageOf(reply).held).toBe(limits.firstRows);
        expect(pageOf(reply).total).toBe(seed.length + 1);
      }
    );

    scenario(
      "budgets: first reply independent of total history; unpaged rows and receipt rows count toward caps",
      async (app) => {
        const rows = Array.from({ length: 1000 }, (_, index) => item(`large-${index}`, index));
        await app.write({ rows, unpaged: [item("settings", 1)] });
        const reply = await app.pull(request());
        bounded(reply);
        expect(reply.patch.rows.rows).toHaveLength(limits.firstRows);
        expect(reply.patch.rows.unpaged).toHaveLength(1);
        expect(pageOf(reply)).toMatchObject({ total: rows.length, held: limits.firstRows });
        expect(reply.patch.rows.rows.map((row) => row.id)).toStrictEqual([
          "large-999",
          "large-998",
        ]);
        // The encoded-size measurement is the application's actual JSON, not JSON of the normalized result.
        expect(reply.bytes).toBeGreaterThan(
          Buffer.byteLength(JSON.stringify(reply.patch.rows.rows))
        );
      }
    );
  });
}
