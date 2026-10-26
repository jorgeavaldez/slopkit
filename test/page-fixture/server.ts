import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SQLOutputValue } from "node:sqlite";

import { string } from "../../src/schema.ts";
import type { WebConfig } from "../../src/server/config.ts";
import type { Logger } from "../../src/server/log.ts";
import { serveSync, syncHandlers } from "../../src/server/sync.ts";
import { rawRoute } from "../../src/server/web.ts";
import type { Caller } from "../../src/server/web.ts";
import { api, outcome, readRow, Store } from "../sync-fixture.ts";
import type { Command, Outcome } from "../sync-fixture.ts";

export type ServerInput = { home: string; web: WebConfig; now: () => number; log: Logger };

export async function startServer({ home, web, now, log }: ServerInput) {
  const store = new Store(join(home, "page.sqlite"));
  store.put("seed", 42);
  store.put("owner-private", 11, "settings");
  store.put("other-private", 22, "settings");

  const jobs = store.createJobs<string>({
    encode: JSON.stringify,
    decode: (text) => string().parse(JSON.parse(text)),
  });

  const received: {
    command: Command;
    identities: string[];
    person: boolean;
    now: number;
    date: number;
  }[] = [];

  const pulls: { dataset: string | null; since: number }[] = [];
  const serverTimers: string[] = [];
  const replies: { identities: string[]; commands: { client?: string; id: number }[] }[] = [];

  const privateRows = (since: number, caller: Caller) =>
    store
      .rows("settings", since)
      .filter((row) => caller.identities.includes(`sub:${row.id.split("-")[0]}`));

  const ledger = store.createLedger<Outcome>({
    encode: JSON.stringify,
    decode: (text) => outcome.parse(JSON.parse(text)),
  });

  const sync = syncHandlers({
    api,
    store,
    ledger,
    log,
    server: (_caller: Caller) => ({ version: "v1" }),
    history: {
      row: "history",
      table: "history",
      order: ["value", "id"],
      version: 1,
      live: "deleted = 0",
      read: readRow,
      through: (values: readonly SQLOutputValue[]) => String(values[0]),
    },
    unpaged: (since: number, caller: Caller) => ({ settings: privateRows(since, caller) }),
    everything: (caller: Caller) => ({
      history: store.rows("history"),
      settings: privateRows(0, caller),
    }),
    outcome: (kept: Outcome) => kept,
    names: (kept: Outcome) => (kept.kind === "ok" ? [kept.resource] : []),
    limits: { firstRows: 2, pageRows: 2, maxRows: 6, maxBytes: 16_000 },
    act: (command: Command, caller: Caller) => ({
      local: (): Outcome => {
        received.push({
          command,
          identities: caller.identities,
          person: caller.person,
          now: now(),
          date: Date.now(),
        });
        store.put(command.id, command.value);

        if (command.id === "work" || command.id === "future") {
          jobs.ask("check", command.id, {
            dueAt: now() + (command.id === "future" ? 86_400_000 : 0),
            deadlineAt: now() + 172_800_000,
          });
        }

        return { kind: "ok", resource: command.id };
      },
    }),
  });

  const observed = {
    ...sync,
    pull: (request: Parameters<typeof sync.pull>[0], caller: Caller) => {
      pulls.push({ dataset: request.dataset, since: request.since });

      return sync.pull(request, caller).then((reply) => {
        replies.push({ identities: caller.identities, commands: reply.commands });

        return reply;
      });
    },
  };

  await writeFile(join(home, "index.html"), '<!doctype html><div id="app"></div>');

  const served = await serveSync({
    name: "page-fixture",
    api,
    home,
    config: web,
    env: {},
    log,
    page: log,
    assets: home,
    sync: observed,
    routes: [
      rawRoute({
        path: "/driver-cookie",
        method: "GET",
        handle: (request) => ({
          status: 200,
          type: "text/plain",
          body: "ok",
          headers: {
            "set-cookie":
              request.url.searchParams.get("kind") === "hidden"
                ? "fixture_hidden=yes; Path=/; HttpOnly; SameSite=Lax"
                : `fixture_readable=${request.url.searchParams.get("kind") === "clear" ? "" : "yes"}; Path=/; SameSite=Lax; Max-Age=${request.url.searchParams.get("kind") === "clear" ? 0 : 60}`,
          },
        }),
      }),
      rawRoute({
        path: "/identity",
        method: "GET",
        handle: (request, caller) => ({
          status: 200,
          type: "application/json",
          body: JSON.stringify({
            identities: caller.identities,
            sessionCookie: (request.headers.cookie ?? "").includes("page-fixture_session="),
            readableCookie: (request.headers.cookie ?? "").includes("fixture_readable=yes"),
            hiddenCookie: (request.headers.cookie ?? "").includes("fixture_hidden=yes"),
            person: caller.person,
            now: now(),
            date: Date.now(),
          }),
        }),
      }),
    ],
  });

  return {
    url: new URL(served.url).origin,
    close: async () => {
      await served.close();
      store.close();
    },
    due: () => {
      for (const job of jobs.due("check", now())) {
        if (jobs.start(job.id, "checking")) {
          store.put(job.key, 1);
          jobs.finish(job.id, { done: "checked" });
          sync.changed();
        }
      }
    },
    jobs: () => jobs.open(),
    store,
    received,
    pulls,
    replies,
    serverTimers,
    web,
    now,
    serverTimeout: (ms: number) =>
      setTimeout(() => {
        serverTimers.push(`timeout:${Date.now()}`);
      }, ms),
    serverInterval: (ms: number) =>
      setInterval(() => {
        serverTimers.push(`interval:${Date.now()}`);
      }, ms),
    ask: (key: string, dueAt: number) =>
      jobs.ask("check", key, { dueAt, deadlineAt: dueAt + 1000 }),
  };
}
