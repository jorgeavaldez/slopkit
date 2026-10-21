import { describe, expect, test } from "vitest";

import { createClient } from "../client.ts";
import { Network as SeededNetwork } from "../test/network.ts";
import { copy, database, deferred, patch, row, sync, values } from "./fixtures.ts";
import type { Network } from "./fixtures.ts";
import {
  all,
  assertCopy,
  complete,
  firstPage,
  history,
  lastPage,
  middle,
  newest,
  paged,
  Reference,
  requestedPage,
  secondPage,
} from "./paging-fixtures.ts";
import type { M } from "./paging-fixtures.ts";

// Named histories replay fixed server answers through the actual executor and seeded overlapping transport.
const histories = [
  { name: "lost-first-copy", seed: 73, drop: 0.2, duplicate: 0.3 },
  { name: "overlapping-retries", seed: 991, drop: 0.1, duplicate: 0.7 },
];

describe("paged first copy over the seeded network", () => {
  test.each(histories)(
    "1, 2, 5, 12: $name converges across dropped and duplicate requests and a reload",
    async (scenario) => {
      const transport = new SeededNetwork(scenario.seed);
      transport.faults = { drop: scenario.drop, duplicate: scenario.duplicate, maxDelay: 200 };
      const stored = database();
      const reloadStep = 50 + Math.floor(transport.random() * 650);
      const reference = new Reference(10, all);

      const changes = [
        row("f", 65, 11),
        row("a", 5, 11),
        row("new", 70, 11),
        row("b", 20, 11, true),
      ];

      reference.write(11, changes);
      const snapshots: M[] = [];
      const writes = new Set<Promise<unknown>>();
      const requests: Parameters<Network["pull"]>[0][] = [];

      const network: Network = {
        pull: async (request) => {
          requests.push(request);

          const response = await transport.request(async () => {
            const cursor = requestedPage(request);

            const reply =
              request.since === 0
                ? paged(10, newest, firstPage, true)
                : cursor === firstPage.next
                  ? paged(11, [...changes, ...middle], { ...secondPage, held: 5, total: 6 })
                  : cursor === secondPage.next
                    ? paged(11, [row("a", 5, 11)], { ...lastPage, held: 6, total: 6 })
                    : patch(11, request.since === 10 ? changes : []);

            return { patch: reply, receipts: [] };
          }, 1000);

          return response.ok
            ? { ok: true, value: response.value }
            : { ok: false, failure: { kind: "offline", message: "seeded delivery lost" } };
        },
        push: async () => ({ ok: false, failure: { kind: "offline", message: "no commands" } }),
      };

      function page(name: string) {
        const booted = deferred<void>();
        const original = stored.port.commit;

        const app = createClient({
          sync,
          client: name,
          render: (model) => {
            snapshots.push(model);

            if (model.boot.kind === "ready") {
              booted.resolve();
            }
          },
          ports: {
            storage: {
              ...stored.port,
              commit: (value) => {
                const work = original(value);
                writes.add(work);
                void work
                  .finally(() => {
                    writes.delete(work);
                  })
                  .catch(() => undefined);

                return work;
              },
            },
            network,
            now: () => transport.now,
            fingerprint: async () => "fixture-fingerprint",
          },
        });

        return { app, booted };
      }

      let { app, booted } = page("page-a");
      app.start();
      await booted.promise;
      const abandoned: (typeof app)[] = [];

      for (let step = 0; step < 3500; step++) {
        if (step === 750) {
          transport.faults = { drop: 0, duplicate: 0, maxDelay: 10 };
        }

        if (step === reloadStep) {
          abandoned.push(app);
          // The old page is no longer visible; already-sent answers may still land.
          app.dispatch({ type: "visible", visible: false, now: transport.now });
          ({ app, booted } = page("page-b"));
          app.start();
          await booted.promise;
        }

        app.dispatch({ type: "tick", now: transport.now });
        await transport.advance(20);
        await Promise.allSettled(writes);
      }

      // No more ticks: finish any already-started request and commit, not a wall-clock delay.
      await transport.advance(2000);
      await Promise.allSettled(writes);
      await Promise.all([app, ...abandoned].map((client) => client.settle()));
      expect(transport.errors).toStrictEqual([]);

      for (const model of snapshots) {
        if (model.replica.dataset !== null && model.replica.revision > 0) {
          assertCopy(model, reference);
        }
      }

      expect(values(app.model().replica)).toStrictEqual(
        values(
          copy(11, [
            ...newest.filter((item) => item.id !== "f"),
            row("f", 65, 11),
            ...middle,
            row("a", 5, 11),
            row("new", 70, 11),
          ])
        )
      );
      expect(history(app.model().replica)).toStrictEqual(complete);
      expect(history((await stored.port.load()).replica)).toStrictEqual(complete);
      expect(requests.some((request) => requestedPage(request) === firstPage.next)).toBe(true);
      expect(app.faults).toStrictEqual([]);
    }
  );
});
