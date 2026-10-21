import { expect, test } from "vitest";

import { createClient } from "../src/client.ts";
import { database, deferred, patch, sync } from "../src/conformance/fixtures.ts";
import type { Network, Outcome } from "../src/conformance/fixtures.ts";
import type { Failure } from "../src/contract.ts";
import { POLL_MS } from "../src/sync.ts";
import type { Receipt } from "../src/sync.ts";

// A push in flight is journalled before it is sent: a page that dies mid-push leaves the command uncertain on disk, so
// a refusal after the reload (which proves only that attempt didn't act) can never record a false final failure.

/** How the server answers now: a refusal for every push, and whether pulls carry the receipts it holds. */
type Answers = { refusal: Failure | undefined; reveal: boolean };

/** A server's ledger: what acted, and its receipts, answered in pulls once revealed. */
function peer() {
  const acted = new Map<string, Receipt<Outcome>>();

  const state: Answers = {
    refusal: undefined,
    reveal: false,
  };

  const network: Network = {
    pull: async (input) => ({
      ok: true,
      value: {
        patch: patch(1 + acted.size, [], true),
        receipts: state.reveal
          ? (input.commands ?? []).flatMap((each) => {
              const receipt = acted.get(`${each.client}:${each.id}`);

              return receipt === undefined ? [] : [{ ...receipt, client: each.client }];
            })
          : [],
      },
    }),
    push: async (input) => {
      if (state.refusal !== undefined) {
        return { ok: false, failure: state.refusal };
      }

      const receipts = input.commands.map((each) => {
        const receipt = {
          id: each.id,
          outcome: { kind: "ok" as const, resource: `r${each.id}` },
          revision: 2,
        };

        acted.set(`${input.client}:${each.id}`, receipt);

        return receipt;
      });

      return { ok: true, value: { receipts, revision: 2 } };
    },
  };

  return { network, state, acted };
}

const refusals = {
  forbidden: { kind: "forbidden", message: "not allowed now", refused: true },
  conflict: { kind: "conflict", message: "not now", refused: true },
  schema: {
    kind: "invalid",
    message: "request.commands[0].command.value: out of range",
    refused: true,
    path: "request.commands[0].command.value",
  },
} satisfies Record<string, Failure>;

test.each(["forbidden", "conflict", "schema"] as const)(
  "a command whose page died mid-push is uncertain after reload; a %s refusal can't make it final",
  async (kind) => {
    const server = peer();
    const disk = database();
    const sent = deferred<void>();
    const onDisk: unknown[] = [];

    const first = createClient({
      sync,
      client: "page",
      ports: {
        storage: disk.port,
        now: () => 0,
        fingerprint: async () => "fixture-fingerprint",
        network: {
          ...server.network,
          push: async (input) => {
            // What the disk holds as the request leaves: the page may die from here on.
            onDisk.push((await disk.port.load()).commands[0]?.state);
            await server.network.push(input);
            sent.resolve();

            // The page is gone: no reply or error is ever observed.
            return await new Promise(() => {});
          },
        },
      },
    });

    first.start();
    await first.settle();
    first.command({ name: "put", value: 10 });
    await sent.promise;
    expect(server.acted.size).toBe(1);
    expect(onDisk).toStrictEqual([{ kind: "sending" }]);
    expect((await disk.port.load()).commands[0]?.state).toStrictEqual({ kind: "sending" });

    server.state.refusal = refusals[kind];
    const reopened = database({ factory: disk.factory, name: disk.name });
    const answers: unknown[] = [];
    let now = 0;

    const second = createClient({
      sync,
      client: "reopened",
      ports: {
        storage: reopened.port,
        now: () => now,
        fingerprint: async () => "fixture-fingerprint",
        network: server.network,
        answered: (each) => {
          answers.push(each.state);
        },
      },
    });

    second.start();
    await second.settle();

    for (const at of [1, 2, 3]) {
      now = at * POLL_MS * 4;
      second.dispatch({ type: "tick", now });
      await second.settle();
    }

    expect(second.model().commands[0]?.state.kind).toBe("unknown");
    expect((await reopened.port.load()).commands[0]?.state.kind).not.toBe("done");
    expect(answers).toStrictEqual([]);

    // The receipt the first attempt left settles it, with its real outcome.
    server.state.reveal = true;
    now += POLL_MS * 8;
    second.dispatch({ type: "tick", now });
    await second.settle();

    const done = { kind: "done", outcome: { kind: "ok", resource: "r1" }, revision: 2 };
    expect(second.model().commands[0]?.state).toStrictEqual(done);
    expect((await reopened.port.load()).commands[0]?.state).toStrictEqual(done);
    expect(server.acted.size).toBe(1);
    expect(second.faults).toStrictEqual([]);
  }
);
