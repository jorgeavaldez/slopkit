# slopkit

opinionated libraries for fast, local-first personal software.
**proper slop deserves a decent bowl and a spoon.**

## what

a toolkit for writing software as a state machine: models, messages, effects. every state has a decided display or it
doesn't compile, errors say who acts and whether a call may have acted, and the server and page share one contract.
includes sync, an indexeddb replica, a command ledger, durable jobs, oidc auth, sealed credentials, a guarded web
server and logs, plus a conformance suite your app runs against the version it installs. outside systems are adapters,
so tests run the real code headless, without mocks. [`DEPS.md`](DEPS.md) has the dependencies, the recommended
pairings and the kit's own budget.

## usage

node 24+ (`node:sqlite`), esm only.

```sh
npm i slopkit
npm i -D vitest fake-indexeddb oxlint ultracite  # tests and lint
```

```ts
import { call, endpoint } from "slopkit/contract";
import { replay, unreachable, type Update } from "slopkit/machine";
import { object, string } from "slopkit/schema";
import { MEANINGS, states } from "slopkit/states";
import { underWay } from "slopkit/sync";
import { route, serveWeb } from "slopkit/server/web";

// one contract, checked on both ends
const save = endpoint("POST", "/api/notes", object({ text: string() }), object({ id: string() }));

// a note is in exactly one state. after a lost reply it may have saved, so that gets its own state
type Note =
  | { kind: "draft" }
  | { kind: "saving"; text: string }
  | { kind: "saved"; id: string }
  | { kind: "unsure"; text: string };

type Msg = { kind: "submit"; text: string } | { kind: "answered"; id: string } | { kind: "lost" };
type Effect = { kind: "send"; text: string };

// update is pure. effects are values; the runtime runs them and answers with messages
const update: Update<Note, Msg, Effect> = (note, msg) => {
  switch (msg.kind) {
    case "submit":
      return [{ kind: "saving", text: msg.text }, [{ kind: "send", text: msg.text }]];
    case "answered":
      return [{ kind: "saved", id: msg.id }, []];
    case "lost":
      return note.kind === "saving" ? [{ kind: "unsure", text: note.text }, []] : [note, []];
    default:
      return unreachable(msg);
  }
};

// a display for every state; leave one out and it doesn't compile
const ui = states<"check">({ order: MEANINGS });
const view = ui.subject<Note>("note", {
  draft: { meaning: "none", where: "main", claim: false, why: "unsent", text: () => "draft", action: null },
  saving: { meaning: "working", where: "main", claim: false, why: "sent", text: () => "saving", action: null,
    owes: () => ({ sync: true }) }, // a working state names its work, checked to be under way
  saved: { meaning: "ok", where: "main", claim: false, why: "kept", text: () => "saved", action: null },
  unsure: { meaning: "you", where: "main", claim: true, why: "may have saved", text: () => "saved?", action: "check" },
});

// what the engine runs is `underWay` (slopkit/sync), the rule the check holds working lines to: a command queued
// offline or in backoff waits, it doesn't send, so place it apart from one going out
const sending = underWay(sync, { command: { client, id } }, now); // working only while true

// tests replay messages through update
const { model, effects } = replay(update, { kind: "draft" }, [
  { kind: "submit", text: "hi" },
  { kind: "lost" },
]);
view.line(model).text; // "saved?", drawn ⚠ with a check action
effects; // [{ kind: "send", text: "hi" }], one send

// the page's own state (route, filters, applied forms) lives in the model too, so every view a replay reaches is checked
const { problems } = replayProblems(update, { kind: "draft" }, messages, { view: (note) => view.line(note), order: MEANINGS });

// the app's real page, headless, over its own server in this process, signed in by the test login
const page = await openPage({ server, page: () => import("../src/web/main.tsx"), at: "2026-01-01T12:00:00Z", path: "/?note=a" });
await page.press(/save/); // by accessible name; settles, then checks the view
await page.reload(); // same device: IndexedDB, localStorage, sessionStorage and the address kept
const laptop = page.device();
await page.reload({ device: "new" }); // another device, its storage empty; `reload({ device: laptop })` goes back
await page.signIn({ as: "other" }); // another person on the same device: they never see the owner's copy

// the page calls it, and the server answers after checking the login, the request and the reply
const sent = await call(save, { text: "hi" }); // { ok: true, value: { id } } or a typed failure
await serveWeb({
  home, config, env: process.env, log, // your data dir, loadWebConfig result and scoped Log
  assets: "dist/web", manifest: { name: "notes" }, cookie: "notes_session",
  routes: [route(save, ({ text }) => ({ id: notes.add(text) }))],
});
```

the conformance suite runs in your app against the installed version (`vitest.config.ts`):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "node_modules/slopkit/dist/conformance/*.test.js"],
    exclude: [], // the default excludes node_modules
  },
});
```

agents call your app with a key (`addKey(home, name)` from `slopkit/server/keys`, allowed as `key:<name>` in
`web.allow`), never as the person. `agentAccess` checks that against your real server:

```ts
import { agentAccess, reads, refused } from "slopkit/test/agents";

await agentAccess({
  url: server.url,
  token: await addKey(home, "agent"),
  reads: [reads(list, {})],
  refused: [refused(push, request, { refusal: (reply) => reply.results.every(forbidden) })],
});
```

push handlers return per-command outcomes as ledger receipts. once any command in a request has acted, never throw
an `invalid`, `forbidden` or `conflict` refusal for the whole request: a refusal proves only that attempt did not act,
not that an earlier delivery did not. request schemas are checked before the handler runs.

a push is at most `PUSH_BYTES` (48 KiB) of UTF-8 json, within `serveWeb`'s default `bodyLimit` (64 KiB): never set
`bodyLimit` below the page's `pushBytes`. the outbox admits at most `OUTBOX_MAX` (500) commands across tabs: place
`deriveOutboxState(model)` in its own table (`waiting` needs a connection, `finished` needs dismissing), and a
command that is `unknown` and `parked` as needing attention. a `Failure` of kind `unreadable` is a reply the page
couldn't read: it may have acted.

### sync in pages

a device with no copy draws its newest rows after one round trip, whatever the history's size, then pulls older pages
back to back until it holds everything. the server half is `slopkit/server/pull`: one history table paged newest
first by a keyset order, the other tables whole, receipts with the rows they name, all in one read transaction and
within your caps.

```ts
import { createPull } from "slopkit/server/pull";

const pulls = createPull({
  db, dataset: () => store.dataset(), revision: () => store.revision(),
  // newest first by (date, id), descending; id is unique. bump version when the order changes
  paged: { table: "transactions", order: ["date", "id"], version: 1, live: "deleted = 0", read: toTransaction,
    through: ([date]) => String(date) },
  unpaged: (since) => ({ accounts: store.accounts(since) }), // whole on every reset
  // the commands the page names (any of its pages'), or an old page's own receipts since `since`
  receipts: { read: ({ since, commands }, viewer: Viewer) => commands === undefined
      ? ledger.receipts(viewer.principal, viewer.client, since).map((each) => ({ ...each, client: viewer.client }))
      : ledger.receiptsOf(viewer.principal, commands),
    names: (each) => [each.receipt.transaction] },
  limits: { firstRows: 200, pageRows: 2000, maxRows: 5000, maxBytes: 2_000_000 },
  // your endpoint's reply: the caps measure its json
  respond: ({ rows, unpaged, receipts, ...rest }) => ({ ...rest, transactions: rows, ...unpaged, commands: receipts }),
});

route(pull, (request, caller) => pulls.pull(request, viewerOf(request, caller)).reply);
```

the page's pull request carries `page` (the engine fills it in; a request without it gets the old whole reply), and
the copy's history is its own subject: place `deriveHistoryState(model)` (loading, none, partial, complete) and
`deriveDurabilityState(model)` (the storage states) in two tables and compose both. partial is a claim beside the
numbers, "history from <through>, loading older · held of total", and totals cover only `through` and above.
`pullConformance` runs the pull contract against your own pull:

```ts
import { pullConformance } from "slopkit/conformance/pull";

pullConformance({ name: "my app", create: async (limits) => fixtureOverMyRealStore(limits) });
```

### the app shell

the page's runtime, the server's sync, the store and the command line are the same in every app, so they live here.
an app declares its rows, commands and outcomes once:

```ts
import { syncApi } from "slopkit/api";

// pull, push, telemetry and the socket's poke, plus the outbox record. rows need an `id`
export const api = syncApi({ rows: { notes: note, tags: tag }, server, command, outcome });
```

the store is the kit's core (meta, revisions, the command ledger, jobs) plus your tables:

```ts
import { schemaVersion, SyncStore } from "slopkit/server/store";

const SCHEMA = { base: "create table notes(...) strict; ...", replicated: ["notes", "tags"], baseVersion: 1,
  migrations: [], indexes: "create index if not exists notes_order on notes(at, id, deleted);" };

class Store extends SyncStore {
  readonly ledger = this.createLedger<Kept>({ encode: JSON.stringify, decode: readKept });
  constructor(path: string) { super(path, { name: "notes", schema: SCHEMA }); }
}
```

the server answers pull and push over it, and serves them with the poke socket and telemetry:

```ts
import { serveSync, syncHandlers } from "slopkit/server/sync";

const sync = syncHandlers({ api, store, ledger: store.ledger, log, server: (caller) => facts(caller),
  history: { row: "notes", table: "notes", order: ["at", "id"], version: 1, live: "deleted = 0", read: toNote,
    through: ([at]) => String(at) },
  unpaged: (since) => ({ tags: store.tags(since) }), everything: () => store.everything(),
  names: (kept) => [kept.note], limits, act: (command) => ({ local: () => store.apply(command) }),
  outcome: (kept) => kept });

await serveSync({ name: "notes", api, sync, home, config, env, log, page, assets: "dist/web" });
```

`unpaged` and `everything` get the caller too, so a table only people may read (`caller.person`) comes back empty to
a service login, in its pulls and its checksum alike.

your outcome union must admit the kit's own answers (`failed` with `conflict` or `forbidden`, and `retired`): if it
can't, `serveSync` doesn't compile. the page runs the same engine headless or in a browser:

```ts
import { createRuntime } from "slopkit/web/runtime";

const runtime = createRuntime({ name: "notes", sync, api, replica: { version: 1, tables, empty } });
runtime.subscribe((model) => draw(model));
runtime.start();
```

the copy and the outbox are the signed-in person's: `serveSync` names them to the page in the `notes_who` cookie, the
runtime opens their own copy before it paints (the device's first person keeps `notes`, anyone else `notes~<who>`),
and every pull and push says whose copy it is, refused under anyone else's login. so another person signing in on the
same phone never sees the copy, and nothing queued in it is sent as them; it waits for its own person. the person is
their login's subject (`sub:`), so an email change keeps their copy; moving between Access and the app's own login
starts a new one. `createRuntime`'s `name` must be `serveSync`'s, or the page never finds its cookie and stays signed
out. keep the page's own storage (drafts, settings) under `runtime.who` too.

a release that changes or adds tables starts the device's copy over unless the replica has `lifts`, which keeps
unchanged tables, lifts changed ones and opens new ones empty (the lift code ships only to apps that pass it):

```ts
import { lifting } from "slopkit/web/lift";

const replica = { version: 2, tables, empty, lifts: lifting({ notes: (row) => ({ ...oldNote.parse(row), pinned: false }) }) };
// lifting({}) keeps the copy across a release that only adds a table
```

and `main.ts` is the command line: `serve | update | rollback | probe | version`, one server per home, releases that
boot on a copy of the store before they replace the running one, automatic rollback of a crashing update, and `probe`,
the live server checked from its host with no identity (it serves, the version that passed, no test login, requests
without identity refused, the public door matching `web.json`):

```ts
import { runCli } from "slopkit/server/cli";

process.exitCode = await runCli(process.argv.slice(2), {
  name: "notes", root: new URL("../", import.meta.url), schema: schemaVersion(SCHEMA), serves: "your notes.",
  serve: async ({ home, version, log, web, env }) => {
    /* open the store, serveSync when web isn't off */
    // `start` starts the app's own work (schedules, jobs, listeners of its own; outside calls run as jobs, never
    // awaited here): a release's boot check on copies of the home never runs it.
    return { url, start: () => app.start(), close };
  },
});
```

the shared lint rules go on top of ultracite's presets (`oxlint.config.ts`):

```ts
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";
import { preset } from "slopkit/lint";

export default defineConfig({ extends: [core, vitest, antiSlop, preset] });
```

the page's bundle: a state's `why` is for whoever reads the table, never drawn, so the build drops the words (about
2 KB gzip on an app with 80 states); the page draws from its one model through `slopkit/machine` and the runtime's
`subscribe`, with preact alone (signals would add 2.6 KB gzip and nothing the model doesn't hold):

```ts
import { build } from "esbuild";
import { dropReasons } from "slopkit/build/reasons";

await build({ entryPoints: ["src/web/main.tsx"], bundle: true, minify: true, plugins: [dropReasons()] });

// src/web/main.tsx
const page = machine({ model: initial(runtime.model()), update, run, render: (model) => render(<App view={show(model)} send={send} />, root) });
runtime.subscribe((copy) => page.dispatch({ kind: "copy", copy }));
```

## why

clankers are bad at error states. i write software on my phone, with no browser to test in, and i don't want to wait
on flaky ci or on tests that test the code as written. so apps start from definitions that verify headless in seconds.
auth, secrets and logs are the same in every app (oidc, sealed credentials, json lines), so they live here once. small
bundles, fast compiles, few dependencies.

## development

you need [mise](https://mise.jdx.dev).

```sh
mise run check       # types, lint, tests, format, dead code
mise run build       # dist/
mise run pack:check  # packs, installs the tarball in a scratch app, runs the shipped conformance suite and budget
```

code standards are in [AGENTS.md](AGENTS.md). pushing a `v<version>` tag makes ci build and pack-check the tarball,
then publish it to the github release and npm.

## disclaimer

this is shaped around my way of working and my opinions. i'm not arguing they're good.
i'm having fun with it. i've found success with these patterns, i hope you will too.
no guarantees.

## contributing

this is my personal project. pull requests are welcome to try, but they probably won't be read or merged. there is no
issue tracker. ur welcome.

## license

MIT, see [LICENSE](LICENSE).
