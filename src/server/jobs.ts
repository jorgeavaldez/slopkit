/**
 * Jobs: work the server owes on its own, with no tap waiting on it in the same call (an install that stops the
 * server, an exchange whose reply may be lost, a follow-up). A job is a durable row with a closed state union, so no
 * owed work silently stops.
 *
 * - **One open job per (kind, key).** Asking again joins it, and every requester is kept in order (`by`).
 * - **Claimed before it acts.** `start` turns a due job running, counts the attempt and keeps a note, and commits
 *   before it returns: it refuses to run inside a caller's open transaction, which could still roll the claim back
 *   after the effect began.
 * - **A stop is never left running.** At startup `interrupt` hands every running job to the app's recovery rule:
 *   due again, done (a reconciliation read showed it landed) or failed, by who acts.
 * - **Finished is final.** A done or failed job never changes again.
 * - **Every open job has a deadline**; past it, `jobState` says `overdue`, a state the app must place.
 * - **Bounded:** `prune` keeps the newest finished jobs of each kind; open jobs are never pruned.
 *
 * The table (in an app migration, never edited once shipped):
 *
 *   create table jobs(
 *     id integer primary key,
 *     kind text not null check (length(kind) > 0),
 *     key text not null,
 *     state text not null check (state in ('due', 'running', 'done', 'failed')),
 *     due_at text not null, deadline_at text not null,
 *     attempts integer not null default 0 check (attempts >= 0),
 *     note text,
 *     result text check ((state = 'done') = (result is not null)),
 *     who text check ((state = 'failed') = (who is not null) and (who is null or who in ('you', 'us', 'gone'))),
 *     reason text check ((state = 'failed') = (reason is not null)),
 *     asked_by text not null default '[]',
 *     created_at text not null, updated_at text not null);
 *   create unique index jobs_open on jobs(kind, key) where state in ('due', 'running');
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type JobWho = "you" | "us" | "gone";

export type Job<R> = {
  id: number;
  kind: string;
  key: string;
  state: "due" | "running" | "done" | "failed";
  dueAt: string;
  deadlineAt: string;
  attempts: number;
  note: string | null;
  result: R | null;
  who: JobWho | null;
  reason: string | null;
  /** Every requester that asked or joined, in order. */
  by: unknown[];
  createdAt: string;
  updatedAt: string;
};

export type JobEnd<R> = { done: R } | { failed: { who: JobWho; reason: string } };

/** What a job means now: a closed union an app places in its display table. */
export type JobState =
  | { kind: "due" }
  | { kind: "running" }
  | { kind: "overdue" }
  | { kind: "done" }
  | { kind: "failed"; who: JobWho };

/** An open job past its deadline is overdue; a finished one never is. */
export function jobState(job: Job<unknown>, now: number): JobState {
  if (job.state === "done") {
    return { kind: "done" };
  }

  if (job.state === "failed") {
    return { kind: "failed", who: job.who ?? "us" };
  }

  if (now > Date.parse(job.deadlineAt)) {
    return { kind: "overdue" };
  }

  return { kind: job.state };
}

/** A text column; anything else is corruption. */
function text(value: SQLInputValue | undefined, column: string): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this is where a row's SQL values are parsed
  if (typeof value !== "string") {
    throw new TypeError(`Corrupt row in jobs.${column}`);
  }

  return value;
}

const maybe = (value: SQLInputValue | undefined, column: string): string | null =>
  value === null ? null : text(value, column);

/** The requesters list, kept as JSON text. */
function requesters(value: SQLInputValue | undefined): unknown[] {
  const by: unknown = JSON.parse(text(value, "asked_by"));

  if (!Array.isArray(by)) {
    throw new TypeError("Corrupt row in jobs.asked_by");
  }

  return by;
}

const WHO: ReadonlySet<string> = new Set<JobWho>(["you", "us", "gone"]);

const STATES: ReadonlySet<string> = new Set<Job<unknown>["state"]>([
  "due",
  "running",
  "done",
  "failed",
]);

const isWho = (value: string): value is JobWho => WHO.has(value);
const isState = (value: string): value is Job<unknown>["state"] => STATES.has(value);

export type JobsOptions<R> = {
  db: DatabaseSync;
  /** The store's transaction: nested calls join the outer one. */
  transaction: <T>(body: () => T) => T;
  encode: (result: R) => string;
  /** Decodes a stored result; throws on a corrupt one. */
  decode: (text: string) => R;
  now?: () => number;
};

export class Jobs<R> {
  private readonly options: JobsOptions<R>;
  private readonly now: () => number;

  constructor(options: JobsOptions<R>) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private read(row: Record<string, SQLInputValue> | undefined): Job<R> | undefined {
    if (row === undefined) {
      return undefined;
    }

    const state = text(row.state, "state");

    if (!isState(state)) {
      throw new Error("Corrupt row in jobs.state");
    }

    const who = maybe(row.who, "who");

    if (who !== null && !isWho(who)) {
      throw new Error("Corrupt row in jobs.who");
    }

    const result = maybe(row.result, "result");

    return {
      id: Number(row.id),
      kind: text(row.kind, "kind"),
      key: text(row.key, "key"),
      state,
      dueAt: text(row.due_at, "due_at"),
      deadlineAt: text(row.deadline_at, "deadline_at"),
      attempts: Number(row.attempts),
      note: maybe(row.note, "note"),
      result: result === null ? null : this.options.decode(result),
      who,
      reason: maybe(row.reason, "reason"),
      by: requesters(row.asked_by),
      createdAt: text(row.created_at, "created_at"),
      updatedAt: text(row.updated_at, "updated_at"),
    };
  }

  /** Ask for a job: joins the open one of (kind, key), appending `by`, or opens one due. May join a transaction. */
  ask(
    kind: string,
    key: string,
    options: { deadlineAt: number; dueAt?: number; by?: unknown; note?: string }
  ): { id: number; joined: boolean } {
    const { db, transaction } = this.options;

    return transaction(() => {
      const open = db
        .prepare(
          "select id, asked_by from jobs where kind = ? and key = ? and state in ('due', 'running')"
        )
        .get(kind, key);

      if (open !== undefined) {
        if (options.by !== undefined) {
          db.prepare("update jobs set asked_by = ?, updated_at = ? where id = ?").run(
            JSON.stringify([...requesters(open.asked_by), options.by]),
            this.stamp(),
            Number(open.id)
          );
        }

        return { id: Number(open.id), joined: true };
      }

      const at = this.stamp();

      const result = db
        .prepare(
          `insert into jobs(kind, key, state, due_at, deadline_at, note, asked_by, created_at, updated_at)
           values (?, ?, 'due', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          kind,
          key,
          new Date(options.dueAt ?? this.now()).toISOString(),
          new Date(options.deadlineAt).toISOString(),
          options.note ?? null,
          JSON.stringify(options.by === undefined ? [] : [options.by]),
          at,
          at
        );

      return { id: Number(result.lastInsertRowid), joined: false };
    });
  }

  /**
   * Claim: due → running, one more attempt, the note kept, committed before it returns. Undefined unless it was
   * due. Throws inside an open transaction: the claim must be durable before the effect starts.
   */
  start(id: number, note: string): Job<R> | undefined {
    const { db, transaction } = this.options;

    if (db.isTransaction) {
      throw new Error("A job is claimed in its own transaction, committed before it acts");
    }

    const changed = transaction(
      () =>
        db
          .prepare(
            "update jobs set state = 'running', attempts = attempts + 1, note = ?, updated_at = ? where id = ? and state = 'due'"
          )
          .run(note, this.stamp(), id).changes
    );

    return Number(changed) === 1 ? this.get(id) : undefined;
  }

  /** running → due again at `at` (a passing failure), the note kept. A job that isn't running is left as it is. */
  retry(id: number, options: { at: number; note: string }): void {
    const { db, transaction } = this.options;
    transaction(() =>
      db
        .prepare(
          "update jobs set state = 'due', due_at = ?, note = ?, updated_at = ? where id = ? and state = 'running'"
        )
        .run(new Date(options.at).toISOString(), options.note, this.stamp(), id)
    );
  }

  /** due or running → done or failed; throws on a finished (or missing) job. */
  finish(id: number, end: JobEnd<R>): void {
    const { db, transaction, encode } = this.options;
    transaction(() => {
      const done = "done" in end;

      const changed = db
        .prepare(
          `update jobs set state = ?, result = ?, who = ?, reason = ?, updated_at = ?
           where id = ? and state in ('due', 'running')`
        )
        .run(
          done ? "done" : "failed",
          done ? encode(end.done) : null,
          done ? null : end.failed.who,
          done ? null : end.failed.reason,
          this.stamp(),
          id
        ).changes;

      if (Number(changed) !== 1) {
        throw new Error(`Job ${id} is not open`);
      }
    });
  }

  /** At startup, before acting: every running job goes through `recover`. Returns how many. */
  interrupt(recover: (job: Job<R>) => { due: number } | JobEnd<R>): number {
    const { db, transaction } = this.options;

    return transaction(() => {
      const running = db
        .prepare("select * from jobs where state = 'running' order by id")
        .all()
        .map((row) => this.read(row))
        .filter((job) => job !== undefined);

      for (const job of running) {
        const next = recover(job);

        if ("due" in next) {
          db.prepare(
            "update jobs set state = 'due', due_at = ?, updated_at = ? where id = ? and state = 'running'"
          ).run(new Date(next.due).toISOString(), this.stamp(), job.id);
        } else {
          this.finish(job.id, next);
        }
      }

      return running.length;
    });
  }

  get(id: number): Job<R> | undefined {
    return this.read(this.options.db.prepare("select * from jobs where id = ?").get(id));
  }

  /** Due and running jobs, oldest first. */
  open(kind?: string): Job<R>[] {
    const { db } = this.options;

    const rows =
      kind === undefined
        ? db.prepare("select * from jobs where state in ('due', 'running') order by id").all()
        : db
            .prepare(
              "select * from jobs where kind = ? and state in ('due', 'running') order by id"
            )
            .all(kind);

    return rows.map((row) => this.read(row)).filter((job) => job !== undefined);
  }

  /** The newest job of a kind (by id), of any state or only finished ones. */
  latest(kind: string, state?: "done" | "failed" | "finished"): Job<R> | undefined {
    const { db } = this.options;

    const filter =
      state === undefined
        ? ""
        : state === "finished"
          ? " and state in ('done', 'failed')"
          : ` and state = '${state === "done" ? "done" : "failed"}'`;

    return this.read(
      db.prepare(`select * from jobs where kind = ?${filter} order by id desc limit 1`).get(kind)
    );
  }

  /** The newest finished jobs of a kind, newest first. */
  finished(kind: string, limit: number): Job<R>[] {
    return this.options.db
      .prepare(
        "select * from jobs where kind = ? and state in ('done', 'failed') order by id desc limit ?"
      )
      .all(kind, limit)
      .map((row) => this.read(row))
      .filter((job) => job !== undefined);
  }

  /** Due jobs of a kind whose time has come, oldest first. */
  due(kind: string, now: number = this.now()): Job<R>[] {
    return this.options.db
      .prepare("select * from jobs where kind = ? and state = 'due' order by id")
      .all(kind)
      .map((row) => this.read(row))
      .filter((job): job is Job<R> => job !== undefined && Date.parse(job.dueAt) <= now);
  }

  /** Open jobs past their deadline. */
  overdue(now: number = this.now()): Job<R>[] {
    return this.open().filter((job) => now > Date.parse(job.deadlineAt));
  }

  /** Finished jobs beyond the newest `keep` of each kind are deleted; open jobs never are. */
  prune(keep: number): number {
    const { db, transaction } = this.options;

    return transaction(() =>
      Number(
        db
          .prepare(
            `delete from jobs where state in ('done', 'failed') and id not in (
               select id from (select id, row_number() over (partition by kind order by id desc) as n
                 from jobs where state in ('done', 'failed')) where n <= ?)`
          )
          .run(keep).changes
      )
    );
  }
}
