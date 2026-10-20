/**
 * A simulated network with its own clock, for headless end-to-end runs: every request and every reply is delivered
 * after a random delay, or dropped, or duplicated, as `faults` says, all drawn from a seed when the request is sent.
 * Deliveries due together start together and overlap in the server, as concurrent HTTP handlers do; nothing waits for
 * one to finish before starting the next. Time is an input (`advance`), never a timer.
 */

/* oxlint-disable no-bitwise -- mulberry32 is 32-bit integer arithmetic */
/** A seeded PRNG (mulberry32): the same seed replays the same choices. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
/* oxlint-enable no-bitwise */

export type Faults = { drop: number; duplicate: number; maxDelay: number };

export class Network {
  now: number;
  readonly random: () => number;
  faults: Faults = { drop: 0, duplicate: 0, maxDelay: 2000 };
  private queue: { at: number; order: number; run: () => Promise<void> }[] = [];
  private order = 0;
  private readonly running = new Set<Promise<void>>();
  /** Errors thrown by deliveries: a bug in the harness or the server, for the test to fail on. */
  readonly errors: unknown[] = [];

  constructor(seed: number, now = 0) {
    this.random = seeded(seed);
    this.now = now;
  }

  chance(probability: number): boolean {
    return this.random() < probability;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items[Math.floor(this.random() * items.length)];
  }

  private delay(): number {
    return Math.floor(this.random() * this.faults.maxDelay);
  }

  /** Run `work` later (or twice, or never), as the network decides now. */
  later(work: () => Promise<void>): void {
    if (this.chance(this.faults.drop)) {
      return;
    }

    const copies = this.chance(this.faults.duplicate) ? 2 : 1;

    for (let copy = 0; copy < copies; copy++) {
      this.queue.push({ at: this.now + this.delay(), order: this.order++, run: work });
    }
  }

  /**
   * A request and its reply: `serve` runs at the server when the request arrives (once per copy), its answer goes
   * back by `reply`; a request or reply the network loses becomes `lost` once `timeout` passes, as a client's
   * deadline would. The caller gets exactly one answer, whatever happened.
   */
  request<T>(
    serve: () => Promise<T>,
    timeout: number
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    return new Promise((resolve) => {
      let answered = false;

      const settle = (result: { ok: true; value: T } | { ok: false }) => {
        if (answered) {
          return;
        }

        answered = true;
        resolve(result);
      };

      const sentAt = this.now;
      this.queue.push({
        at: sentAt + timeout,
        order: this.order++,
        run: () => Promise.resolve(settle({ ok: false })),
      });
      this.later(async () => {
        const value = await serve();
        this.later(() => Promise.resolve(settle({ ok: true, value })));
      });
    });
  }

  /** Move the clock by `ms`: every delivery due starts in time order, and all of them run to completion together. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;

    for (;;) {
      const due = this.queue
        .filter((each) => each.at <= until)
        .toSorted((a, b) => a.at - b.at || a.order - b.order);

      if (due.length === 0) {
        if (this.running.size === 0) {
          break;
        }

        // oxlint-disable-next-line no-await-in-loop -- each round waits for the deliveries the last one started
        await Promise.all(this.running);
        continue;
      }

      const started = new Set(due);
      this.queue = this.queue.filter((each) => !started.has(each));

      for (const each of due) {
        this.now = Math.max(this.now, each.at);

        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection is whatever was thrown
        const job = each.run().catch((error: unknown) => {
          this.errors.push(error);
        });

        this.running.add(job);
        void job.finally(() => {
          this.running.delete(job);
        });
      }

      // Let the started deliveries reach their first await together before any later one starts.
      // oxlint-disable-next-line no-await-in-loop -- the rounds are sequential by design
      await Promise.resolve();
    }

    this.now = until;
  }

  get idle(): boolean {
    return this.queue.length === 0 && this.running.size === 0;
  }
}
