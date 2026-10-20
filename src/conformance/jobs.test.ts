/** Jobs: the documented table and API on real SQLite; an observer connection proves claim-before-effect durability. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, test } from "vitest";

import { Jobs, jobState } from "../server/jobs.ts";

const closing: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).toReversed()) {
    await close();
  }
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "jobs-oracle-"));
  closing.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "jobs.sqlite");
  let now = Date.parse("2026-10-20T12:00:00Z");

  function connect() {
    const db = new DatabaseSync(path);
    closing.push(() => {
      if (db.isOpen) {
        db.close();
      }
    });
    db.exec(`create table if not exists jobs(
      id integer primary key, kind text not null check(length(kind)>0), key text not null,
      state text not null check(state in ('due','running','done','failed')),
      due_at text not null, deadline_at text not null, attempts integer not null default 0 check(attempts>=0),
      note text, result text check((state='done')=(result is not null)),
      who text check((state='failed')=(who is not null) and (who is null or who in ('you','us','gone'))),
      reason text check((state='failed')=(reason is not null)), asked_by text not null default '[]',
      created_at text not null, updated_at text not null);
      create unique index if not exists jobs_open on jobs(kind,key) where state in ('due','running');`);

    const jobs = new Jobs<string>({
      db,
      now: () => now,
      encode: JSON.stringify,
      decode: JSON.parse,
      transaction: <T>(body: () => T): T => {
        if (db.isTransaction) {
          return body();
        }

        db.exec("begin immediate");

        try {
          const answer = body();
          db.exec("commit");

          return answer;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      },
    });

    return { db, jobs };
  }

  return {
    connect,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// Guard: partial unique open index + join append + due-only CAS + committed claim.
test("two owners join one open job, claim once before effect, keep all requesters in order", async () => {
  const f = await fixture();
  const a = f.connect();
  const b = f.connect();
  const deadline = f.at() + 1000;

  const first = a.jobs.ask("update", "edge", {
    deadlineAt: deadline,
    by: { client: "a", id: 1 },
    note: "asked",
  });

  expect(first.joined).toBe(false);
  expect(
    b.jobs.ask("update", "edge", { deadlineAt: deadline, by: { client: "b", id: 1 } })
  ).toStrictEqual({ id: first.id, joined: true });
  expect(a.jobs.start(first.id, "installing edge")).toMatchObject({
    state: "running",
    attempts: 1,
    note: "installing edge",
    by: [
      { client: "a", id: 1 },
      { client: "b", id: 1 },
    ],
  });
  // A separate connection reads the committed claim before any caller would run its effect.
  expect({
    ...b.db.prepare("select state,attempts,note from jobs where id=?").get(first.id),
  }).toStrictEqual({
    state: "running",
    attempts: 1,
    note: "installing edge",
  });
  expect(b.jobs.start(first.id, "second effect")).toBeUndefined();
  expect(b.jobs.ask("update", "edge", { deadlineAt: deadline, by: "third" }).joined).toBe(true);
  a.jobs.finish(first.id, { done: "installed" });
  expect(b.jobs.get(first.id)).toMatchObject({
    result: "installed",
    by: [{ client: "a", id: 1 }, { client: "b", id: 1 }, "third"],
  });
  expect(a.jobs.ask("update", "edge", { deadlineAt: deadline }).id).not.toBe(first.id);
});

// Guard: finished immutability on every mutator, not just finish.
test("a finished job is immutable under retry/start/finish/interruption, while new work remains possible", async () => {
  const f = await fixture();
  const { jobs } = f.connect();
  const { id } = jobs.ask("exchange", "one", { deadlineAt: f.at() + 100 });
  jobs.finish(id, { failed: { who: "you", reason: "recover key" } });
  const saved = jobs.get(id);
  expect(saved).toMatchObject({ state: "failed", result: null, who: "you", reason: "recover key" });
  expect(() => jobs.finish(id, { done: "fabricated" })).toThrow("is not open");
  expect(jobs.start(id, "forbidden")).toBeUndefined();

  try {
    jobs.retry(id, { at: f.at(), note: "forbidden" });
  } catch {
    /* throwing or no-op; never mutate */
  }

  expect(jobs.interrupt(() => ({ done: "fabricated" }))).toBe(0);
  expect(jobs.get(id)).toStrictEqual(saved);
});

// Guard: startup recovery enumerates all running jobs exactly once; retry counts claims, not asks.
test("reopen at claim/effect boundary resolves all three recovery outcomes and completes a retried job", async () => {
  const f = await fixture();
  const old = f.connect();

  const ids = ["retry", "landed", "lost"].map(
    (key) => old.jobs.ask("exchange", key, { deadlineAt: f.at() + 1000 }).id
  );

  for (const id of ids) {
    old.jobs.start(id, "provider may have acted");
  }

  old.db.close();
  const { jobs } = f.connect();
  expect(
    jobs.interrupt((job) =>
      job.key === "retry"
        ? { due: f.at() + 100 }
        : job.key === "landed"
          ? { done: "key sealed" }
          : { failed: { who: "you", reason: "recover key" } }
    )
  ).toBe(3);
  expect(jobs.interrupt(() => ({ done: "wrong" }))).toBe(0);
  expect(jobs.open().map((job) => job.key)).toStrictEqual(["retry"]);
  expect(jobs.due("exchange")).toStrictEqual([]);
  f.advance(100);
  const retry = jobs.due("exchange")[0];
  expect(retry?.note).toBe("provider may have acted");

  if (!retry) {
    throw new Error("retry not recovered");
  }

  expect(jobs.start(retry.id, "second attempt")).toMatchObject({ attempts: 2 });
  jobs.retry(retry.id, { at: f.at() + 50, note: "passing outage" });
  expect(jobs.due("exchange")).toStrictEqual([]);
  f.advance(50);
  expect(jobs.due("exchange").map((job) => job.id)).toStrictEqual([retry.id]);
  jobs.start(retry.id, "third attempt");
  jobs.finish(retry.id, { done: "key sealed" });
  expect(jobs.get(retry.id)).toMatchObject({ attempts: 3, result: "key sealed" });
  expect(jobs.open()).toStrictEqual([]);
});

// Guard: deadlines apply to both open states; finished jobs never become overdue; no accidental timer-duration comparison.
test("closed state catalog: due, running, overdue, done, and each failed actor, across clock jumps", async () => {
  const f = await fixture();
  const { jobs } = f.connect();
  const deadline = f.at() + 100;
  const { id } = jobs.ask("update", "edge", { deadlineAt: deadline });

  const get = () => {
    const value = jobs.get(id);

    if (!value) {
      throw new Error("missing");
    }

    return value;
  };

  expect(jobState(get(), deadline)).toStrictEqual({ kind: "due" });
  expect(jobState(get(), deadline + 1)).toStrictEqual({ kind: "overdue" });
  jobs.start(id, "installing");
  expect(jobState(get(), deadline - 100_000)).toStrictEqual({ kind: "running" });
  expect(jobState(get(), deadline + 1)).toStrictEqual({ kind: "overdue" });
  jobs.finish(id, { done: "installed" });
  expect(jobState(get(), deadline + 1)).toStrictEqual({ kind: "done" });

  for (const who of ["you", "us", "gone"] as const) {
    const failed = jobs.ask("exchange", who, { deadlineAt: deadline }).id;
    jobs.finish(failed, { failed: { who, reason: "documented failure" } });
    const value = jobs.get(failed);

    if (!value) {
      throw new Error("missing");
    }

    expect(jobState(value, deadline + 1)).toStrictEqual({ kind: "failed", who });
  }
});

// Guard: per-kind newest-finished retention, never open; latest uses id rather than mutable timestamps.
test("bounded finished retention never erases open work of either kind", async () => {
  const f = await fixture();
  const { jobs } = f.connect();

  for (const kind of ["update", "exchange"]) {
    for (let n = 0; n < 4; n++) {
      const { id } = jobs.ask(kind, String(n), { deadlineAt: f.at() + 1 });
      jobs.finish(id, n % 2 ? { failed: { who: "us", reason: "bad shape" } } : { done: "ok" });
    }

    jobs.ask(kind, "due", { deadlineAt: f.at() });
    const active = jobs.ask(kind, "running", { deadlineAt: f.at() }).id;
    jobs.start(active, "active");
    expect(jobs.latest(kind, "finished")?.key).toBe("3");
    expect(jobs.latest(kind, "done")?.key).toBe("2");
  }

  expect(jobs.prune(2)).toBe(4);
  expect(jobs.open().map((job) => [job.kind, job.key])).toStrictEqual([
    ["update", "due"],
    ["update", "running"],
    ["exchange", "due"],
    ["exchange", "running"],
  ]);
  expect(jobs.prune(0)).toBe(4);
  expect(jobs.open()).toHaveLength(4);
});

// Guard: ask joins caller transaction atomically; start refuses it so no effect can escape an uncommitted claim.
test("ask may join an outer transaction but start must refuse to return an uncommitted claim", async () => {
  const f = await fixture();
  const { jobs, db } = f.connect();
  db.exec("begin immediate");
  const abandoned = jobs.ask("update", "edge", { deadlineAt: f.at() + 1000 }).id;
  expect(() => jobs.start(abandoned, "must not act")).toThrow(
    "A job is claimed in its own transaction, committed before it acts"
  );
  db.exec("rollback");
  expect(jobs.get(abandoned)).toBeUndefined();
  const kept = jobs.ask("update", "edge", { deadlineAt: f.at() + 1000 }).id;
  expect(jobs.start(kept, "committed")).toMatchObject({ state: "running", attempts: 1 });
});
