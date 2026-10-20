/**
 * The command ledger: a command acts at most once for whoever sent it, whatever the network, the tabs or the process
 * do. A command is known by its key (principal, client, number) and its arguments.
 *
 * - **Claimed before it acts.** One transaction finds the key or accepts it, and commits before `run` returns or acts
 *   elsewhere: `run` refuses to start inside a caller's open transaction, which could still roll the claim back after
 *   the effect began. A command that only writes to the store runs inside the claim's transaction, so its effect and
 *   its receipt commit together; one that acts elsewhere is accepted first and finished with its outcome after.
 * - **Concurrent copies wait.** A copy arriving while the first still acts in this process waits for its outcome; a
 *   copy after it gets the receipt; the key with other arguments is a conflict.
 * - **A stop is never a silent re-run.** At startup, commands accepted but never finished get a receipt saying so.
 * - **Receipts are stamped** with a revision like any replicated row, so a caller's pull confirms its commands in the
 *   same snapshot as their effects.
 * - **A key is kept forever.** Retention never deletes a command: `retire` drops an old receipt's outcome and keeps its
 *   key, name and arguments, so a replay of it answers `retired` and never acts again.
 *
 * Authorization is the caller's, before `run`: a key is no credential, and a receipt no way around it. Receipts should
 * name resources by id, never hold a copy of a row that can change.
 *
 * The table (in an app migration, never edited once shipped):
 *
 *   create table commands(
 *     principal text not null check (length(principal) > 0),
 *     client text not null, id integer not null check (id > 0),
 *     name text not null, args text not null,
 *     state text not null check (state in ('accepted', 'done', 'retired')),
 *     outcome text check ((state = 'done') = (outcome is not null)),
 *     revision integer check ((state = 'accepted') = (revision is null)),
 *     created_at text not null,
 *     primary key (principal, client, id));
 *   create trigger commands_never_deleted before delete on commands
 *     begin select raise(abort, 'a command key is kept forever: retire it'); end;
 */
import type { DatabaseSync } from "node:sqlite";

export type CommandKey = { principal: string; client: string; id: number };

/**
 * What `run` gives back: the receipt (`fresh` when it acted just now), a conflict, nothing while another holds it, or
 * that it was answered so long ago its outcome is no longer kept (it never acts again).
 */
export type Ran<Receipt> =
  | { kind: "done"; receipt: Receipt; fresh: boolean }
  | { kind: "conflict" }
  | { kind: "elsewhere" }
  | { kind: "retired" };

export type LedgerOptions<Receipt> = {
  db: DatabaseSync;
  /** The store's transaction: nested calls join the outer one. */
  transaction: <T>(body: () => T) => T;
  /** The next revision, inside the current transaction. */
  stamp: () => number;
  encode: (receipt: Receipt) => string;
  /** Decodes a stored receipt; throws on a corrupt one. */
  decode: (text: string) => Receipt;
  /**
   * The receipt for a command accepted but left without an outcome (its effect failed to record one, or a stop cut
   * it off): what the store now says happened, never a plain failure that invites a second act. Used at startup by
   * `interrupt` and whenever a later copy finds such a command; without it, the copy is told it still acts elsewhere.
   */
  recover?: (command: { name: string; args: string }) => Receipt;
};

export class Ledger<Receipt> {
  private readonly options: LedgerOptions<Receipt>;
  /** Commands acting in this process, by key: the command's name and arguments, and its outcome to come. */
  private readonly acting = new Map<
    string,
    { name: string; args: string; done: Promise<Receipt> }
  >();

  constructor(options: LedgerOptions<Receipt>) {
    this.options = options;
  }

  /**
   * Run a command once. `local` runs inside the claim's transaction: it returns the receipt of a command that only
   * writes to the store, or undefined for one that acts elsewhere, which `remote` then does (it must not throw: a
   * failure is a receipt too). Throws inside an open transaction: the claim must be durable before the effect starts.
   */
  async run(
    key: CommandKey,
    command: { name: string; args: string },
    act: { local: () => Receipt | undefined; remote: () => Promise<Receipt> }
  ): Promise<Ran<Receipt>> {
    if (this.options.db.isTransaction) {
      throw new Error("A command is claimed in its own transaction, committed before it acts");
    }

    // Every part of the key, unambiguously: no principal or client text can stand for another's.
    const name = JSON.stringify([key.principal, key.client, key.id]);
    const acting = this.acting.get(name);

    if (acting !== undefined) {
      return acting.name === command.name && acting.args === command.args
        ? { kind: "done", receipt: await acting.done, fresh: false }
        : { kind: "conflict" };
    }

    const claim = this.claim(key, command, act.local);

    if (claim.kind !== "new") {
      return claim;
    }

    if (claim.receipt !== undefined) {
      return { kind: "done", receipt: claim.receipt, fresh: true };
    }

    const done = act.remote().then((receipt) => {
      this.finish(key, receipt);

      return receipt;
    });

    this.acting.set(name, { name: command.name, args: command.args, done });

    try {
      return { kind: "done", receipt: await done, fresh: true };
    } finally {
      this.acting.delete(name);
    }
  }

  private claim(
    key: CommandKey,
    command: { name: string; args: string },
    local: () => Receipt | undefined
  ): Ran<Receipt> | { kind: "new"; receipt: Receipt | undefined } {
    const { db, transaction, decode } = this.options;

    return transaction(() => {
      const row = db
        .prepare(
          "select name, args, state, outcome from commands where principal = ? and client = ? and id = ?"
        )
        .get(key.principal, key.client, key.id);

      if (row !== undefined) {
        if (row.name !== command.name || row.args !== command.args) {
          return { kind: "conflict" } as const;
        }

        if (row.state === "retired") {
          return { kind: "retired" } as const;
        }

        // Accepted and not acting in this process (the one server per store): its effect ended without recording an
        // outcome. It is recovered now, or reported as still acting when the store can't say.
        if (row.state === "accepted") {
          const recover = this.options.recover;

          if (recover === undefined) {
            return { kind: "elsewhere" } as const;
          }

          const receipt = recover(command);
          this.finish(key, receipt);

          return { kind: "done", receipt, fresh: false } as const;
        }

        if (typeof row.outcome !== "string") {
          throw new TypeError("Corrupt row in commands.outcome");
        }

        return { kind: "done", receipt: decode(row.outcome), fresh: false } as const;
      }

      db.prepare(
        "insert into commands(principal, client, id, name, args, state, created_at) values (?, ?, ?, ?, ?, 'accepted', ?)"
      ).run(
        key.principal,
        key.client,
        key.id,
        command.name,
        command.args,
        new Date().toISOString()
      );
      const receipt = local();

      if (receipt !== undefined) {
        this.finish(key, receipt);
      }

      return { kind: "new", receipt } as const;
    });
  }

  private finish(key: CommandKey, receipt: Receipt): void {
    const { db, transaction, stamp, encode } = this.options;
    transaction(() => {
      const changed = db
        .prepare(
          "update commands set state = 'done', outcome = ?, revision = ? where principal = ? and client = ? and id = ? and state = 'accepted'"
        )
        .run(encode(receipt), stamp(), key.principal, key.client, key.id).changes;

      if (Number(changed) !== 1) {
        throw new Error(`Command ${key.id} was not waiting for an outcome`);
      }
    });
  }

  /**
   * At startup, before serving: commands a stopped process accepted but never finished get a receipt. Their effect
   * elsewhere may or may not have happened, so the receipt should say what is known (`resolve` can look at what the
   * store holds now), never a plain failure that invites a second act.
   */
  interrupt(
    resolve: ((command: { name: string; args: string }) => Receipt) | undefined = this.options
      .recover
  ): number {
    if (resolve === undefined) {
      throw new Error("No way to recover an interrupted command");
    }

    const { db, transaction, stamp, encode } = this.options;

    return transaction(() => {
      const waiting = db
        .prepare("select principal, client, id, name, args from commands where state = 'accepted'")
        .all();

      if (waiting.length === 0) {
        return 0;
      }

      const revision = stamp();

      const finish = db.prepare(
        "update commands set state = 'done', outcome = ?, revision = ? where principal = ? and client = ? and id = ? and state = 'accepted'"
      );

      for (const row of waiting) {
        const command = { name: String(row.name), args: String(row.args) };
        const receipt = resolve(command);
        finish.run(encode(receipt), revision, row.principal ?? "", row.client ?? "", row.id ?? 0);
      }

      return waiting.length;
    });
  }

  /**
   * Retention: every command done before `before` (an ISO instant) keeps its key, name and arguments but drops its
   * outcome. Accepted commands are never retired; nothing is deleted. Returns how many.
   */
  retire(before: string): number {
    const { db, transaction } = this.options;

    return transaction(() =>
      Number(
        db
          .prepare(
            "update commands set state = 'retired', outcome = null where state = 'done' and created_at < ?"
          )
          .run(before).changes
      )
    );
  }

  /**
   * The revision a command's receipt was stamped at (where its effects are visible), or undefined while it has none
   * (unknown, still acting, or retired). A replay answers with it, not with the store's revision now.
   */
  revisionOf(key: CommandKey): number | undefined {
    const value = this.options.db
      .prepare(
        "select revision from commands where principal = ? and client = ? and id = ? and state = 'done'"
      )
      .get(key.principal, key.client, key.id)?.revision;

    return typeof value === "number" || typeof value === "bigint" ? Number(value) : undefined;
  }

  /** One principal's client's receipts stamped after `since`, for its pull. */
  receipts(
    principal: string,
    client: string,
    since: number
  ): { id: number; receipt: Receipt; revision: number }[] {
    const { db, decode } = this.options;

    return db
      .prepare(
        "select id, outcome, revision from commands where principal = ? and client = ? and state = 'done' and revision > ? order by id"
      )
      .all(principal, client, since)
      .map((row) => {
        if (typeof row.outcome !== "string") {
          throw new TypeError("Corrupt row in commands.outcome");
        }

        return { id: Number(row.id), receipt: decode(row.outcome), revision: Number(row.revision) };
      });
  }

  /** Commands accepted longer than `ms` ago and still unfinished: a stuck effect, for the invariant probe. */
  stuck(ms: number): number {
    const before = new Date(Date.now() - ms).toISOString();

    return Number(
      this.options.db
        .prepare("select count(*) as n from commands where state = 'accepted' and created_at < ?")
        .get(before)?.n
    );
  }
}
