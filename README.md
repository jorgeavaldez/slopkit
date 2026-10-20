# slopkit

opinionated standards and libraries for fast, local-first personal software.
proper slop deserves a decent bowl and a spoon.

## what

- software as a state machine: models, messages, effects. pure `update`, effects as plain values.
- exhaustive state catalogues: every state gets a decided display or it doesn't compile. errors say who acts and
  whether the call may have acted.
- shared contracts: the server and the page check the same schemas. the pure core runs in the browser and node.
- primitives for sync, replication (an indexeddb replica), a command ledger (acts at most once), durable jobs, auth
  (oidc, cloudflare access jwt), credentials and sealing, a guarded web server, logs, money, cron.
- everything outside is an adapter behind a port, so tests run the real code headless with no mocks and browser
  checks stay thin.
- a conformance suite that ships in the package, so your app runs the kit's guarantees against the version it
  installs. plus test helpers: a seeded network that drops, duplicates and reorders, an oidc stand-in, state table
  checks.
- [`RULES.md`](RULES.md): the standard an app on slopkit meets. [`DEPS.md`](DEPS.md): dependencies and budgets.

## usage

- `npm i slopkit`. node 24+ (`node:sqlite`), esm only.
- one entry per module (`slopkit/<module>`), so a page bundles only what it imports.
- conformance: add `node_modules/slopkit/dist/conformance/*.test.js` to your vitest `include` and set `exclude: []`
  (the default excludes `node_modules`). needs `vitest` and `fake-indexeddb`.
- lint: `slopkit/lint`'s `house` and `strict` go in your `oxlint.config.ts` rules over ultracite's presets, `tests` in
  your test-file override.

```ts
import { endpoint, call } from "slopkit/contract";
import { array, object, string } from "slopkit/schema";
import { replay, unreachable } from "slopkit/machine";
import { MEANINGS, states } from "slopkit/states";
import { route, serveWeb } from "slopkit/server/web";

// one contract, checked on both ends
const who = endpoint("GET", "/api/who", object({}), object({ identities: array(string()) }));

// the app is a state machine
type Model =
  | { kind: "loading" }
  | { kind: "ready"; identities: string[] }
  | { kind: "failed"; reason: string };
type Msg =
  { kind: "load" } | { kind: "loaded"; identities: string[] } | { kind: "failed"; reason: string };
type Effect = { kind: "ask-who" };

const update = (_model: Model, msg: Msg): readonly [Model, readonly Effect[]] => {
  switch (msg.kind) {
    case "load":
      return [{ kind: "loading" }, [{ kind: "ask-who" }]];
    case "loaded":
      return [{ kind: "ready", identities: msg.identities }, []];
    case "failed":
      return [{ kind: "failed", reason: msg.reason }, []];
    default:
      return unreachable(msg);
  }
};

// every state placed, or it doesn't compile
const app = states<"retry">({ order: MEANINGS });
const page = app.subject<Model>("page", {
  loading: {
    meaning: "working",
    where: "main",
    claim: false,
    why: "nothing yet",
    text: () => "loading",
    action: null,
  },
  ready: {
    meaning: "ok",
    where: "main",
    claim: false,
    why: "signed in",
    text: (m) => m.identities.join(", "),
    action: null,
  },
  failed: {
    meaning: "ours",
    where: "main",
    claim: false,
    why: "can't say who you are",
    text: (m) => m.reason,
    action: "retry",
  },
});

// tests replay messages against update: milliseconds, no mocks
const { model, effects } = replay(update, { kind: "loading" }, [
  { kind: "load" },
  { kind: "failed", reason: "offline" },
]);
page.line(model).text; // "offline", drawn ✕ with a retry
effects; // [{ kind: "ask-who" }]

// the page asks with the same contract
const result = await call(who, {}); // { ok: true, value } or { ok: false, failure: { kind: "signed-out" | "offline" | ... } }

// the server answers it: login, host, origin and csp guarded, request and reply checked
// (config from loadWebConfig, log from scoped(new Log(home, "myapp"), "web"))
await serveWeb({
  home,
  config,
  env: process.env,
  log,
  assets: "dist/web",
  manifest: { name: "myapp" },
  cookie: "myapp_session",
  routes: [route(who, (_request, caller) => ({ identities: caller.identities }))],
});
```

## why

- clankers have trouble preempting, representing, describing and testing for error states.
- my personal software is written on my phone, without the nice stuff a full dev environment has, like browser
  testing.
- i don't want to wait for ci (notoriously flaky in the case of github) to validate the software.
- i don't want tests that test the code as written.
- so apps start from definitions that are fully verifiable, headless, in seconds. tight feedback loop.
- most of my personal software shares the same deployment and development patterns, so they're helpers here, on
  standards: oidc, systemd credentials, sqlite, indexeddb, json lines.
- why is auth still an issue when oidc exists. secrets are solved at rest. logging doesn't have to be hard.
- small bundles, fast compiles. the client core is under 11 KB gzip. dependencies earn their keep: `jose` and `ws`,
  server only.

## development

you need [mise](https://mise.jdx.dev).

```sh
mise run check       # types, lint, tests, format, dead code
mise run build       # dist/
mise run pack:check  # packs, installs the tarball in a scratch app, runs the shipped conformance suite and budget
```

code standards are in [AGENTS.md](AGENTS.md). a new `v<version>` tag releases: ci builds, pack-checks and publishes
that tarball to npm and the github release.

## disclaimer

this is shaped around my way of working and my opinions. i'm not arguing they're good.
i'm having fun with it. i've found success with these patterns, i hope you will too.
no guarantees.

## contributing

this is my personal project. pull requests are welcome to try, but they probably won't be read or merged. there is no
issue tracker. ur welcome.

## license

MIT, see [LICENSE](LICENSE).
