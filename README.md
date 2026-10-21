# slopkit

opinionated standards and libraries for fast, local-first personal software.
**proper slop deserves a decent bowl and a spoon.**

## what

a toolkit for writing software as a state machine: models, messages, effects. every state has a decided display or it
doesn't compile, errors say who acts and whether a call may have acted, and the server and page share one contract.
includes sync, an indexeddb replica, a command ledger, durable jobs, oidc auth, sealed credentials, a guarded web
server and logs, plus a conformance suite your app runs against the version it installs. outside systems are adapters,
so tests run the real code headless, without mocks. [`RULES.md`](RULES.md) is the standard an app meets,
[`DEPS.md`](DEPS.md) the dependencies and budgets.

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
  saving: { meaning: "working", where: "main", claim: false, why: "sent", text: () => "saving", action: null },
  saved: { meaning: "ok", where: "main", claim: false, why: "kept", text: () => "saved", action: null },
  unsure: { meaning: "you", where: "main", claim: true, why: "may have saved", text: () => "saved?", action: "check" },
});

// tests replay messages through update
const { model, effects } = replay(update, { kind: "draft" }, [
  { kind: "submit", text: "hi" },
  { kind: "lost" },
]);
view.line(model).text; // "saved?", drawn ⚠ with a check action
effects; // [{ kind: "send", text: "hi" }], one send

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
numbers, "history from <through>, loading older · held of total", and totals cover only `through` and above. run the
pull contract against your own pull in your tests:

```ts
import { pullConformance } from "slopkit/conformance/pull";

pullConformance({ name: "my app", create: async (limits) => fixtureOverMyRealStore(limits) });
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
