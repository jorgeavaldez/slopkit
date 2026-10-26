# Working on slopkit

`slopkit` is the kit its apps build on. `RULES.md` is the standard it meets as much as the apps do, and
ships in the package. `README.md` covers the entries and their use, `DEPS.md` the dependencies and budgets.

## The kit's invariants

Each is enforced at one place, named here, and pinned by a test: the conformance suite (`src/conformance/README.md`)
or the kit's own tests in `test/`.

- Pure entries (`schema`, `contract`, `api`, `sync`, `client`, `machine`, `money`, `digest`, `cron`, `states`) import
  no Node built-in and no DOM (lint, `test/lint-boundaries.test.ts`).
- A command acts at most once for whoever sent it, forever (`server/ledger`): claimed in a committed transaction before
  it acts; authorization before any replay; receipts name resources by id and arrive in the pull with the revision that
  holds their effects. Retention never deletes a key: an old receipt retires and never acts. Push handlers return
  per-command receipts and never throw a final-kind refusal after any command in the request has acted; request
  schema validation runs before the handler.
- Work the server owes on its own is a job (`server/jobs`): one open per key, claimed and committed before it acts,
  resolved at the next start after a stop, final once finished, `overdue` past its deadline.
- A replica only moves forward, on disk too (`web/replica`): a commit is decided against the stored checkpoint inside
  its own transaction; a forget moves a generation every writer checks; the outbox is per command and survives
  upgrades. A cached copy is read only under the row shapes that wrote it (`Schema.shape`, kept with the checkpoint),
  or, with the app's `lifts` (`web/lift`), lifted from an earlier release's: unchanged tables kept, changed ones
  through their lift, new ones empty, rewritten whole and claiming no history (revision 0) until a reset replaces it;
  a copy with a table this release doesn't have, or any other shapes without `lifts`, starts over.
  A partial copy's history is kept with its rows, under row shapes marked partial so a release from before paging
  never reads it; a delta takes a page's history only at the cursor that page moved from.
- Nothing is sent before it is kept, and no push before it is kept as in flight; observed and saved revisions are
  separate; a pull is owed while the server is ahead, whatever the socket says; the push channel only pokes (`sync`).
  A push carries the revision each command was tapped against, so a server can refuse intents made on a history it no
  longer has. Successive pulls name every command still waiting, a push's worth at a time.
- A copy never claims more history than it holds (`sync`): complete, or partial with every row at or above its cursor
  and `through`. A delta applies only when `since ≤ copy.revision ≤ reply.revision` on the same dataset; only a reset
  replaces the copy; the cursor moves only on a reply to the copy's own `next`; a partial copy owes its next page, with
  backoff when a reply doesn't move it on, and is never checked against a fingerprint until complete. On a partial
  copy a command settles only once a pull reply carrying its receipt (and so its rows) is applied; a pull names the
  commands it waits on. A failed write stays owed until a write the disk takes whole repairs it.
- No paging-aware pull reply is unbounded (`server/pull`): one read transaction, keyset cursors scoped to the dataset
  and the order's version (never an offset or the anchor's current row), rows and encoded bytes within the app's caps,
  a delta that can't fit by itself answered as a paged reset (else the older page shrinks to the room it leaves),
  `through` only over whole order groups, and every row a receipt names in the reply that carries it. A reply that
  can't fit is refused, never sent over the caps. A request without `page` keeps the whole reply of before.
- A replicated store opens only what it can read (`server/store`): a store newer than the release, or older than its
  base schema, is refused before anything is written; a store with data is copied whole before a migration, each
  migration commits alone with its foreign keys checked; replicated rows carry the revision stamped in their own
  transaction and are never deleted (triggers); the newest revision served is kept beside the store before its reply
  leaves, so a restored store takes a new dataset.
- A push acts only on the history it was tapped against (`server/sync`): another dataset or an unknown revision runs
  none of its commands; authorization comes before the ledger on every command, replays included; served before
  replied. Its handlers' answers include the kit's own refusals, so an outcome schema that can't carry them doesn't
  compile where they meet the api.
- The page's runtime decides nothing (`web/runtime`): the socket only pokes and reconnects with capped backoff;
  telemetry is bounded and never trusted for who sent it (`server/sync` sets the sender).
- A device's copy and outbox are one person's (`web/runtime`, `server/web`, `server/sync`): the server names the
  person in the page's who cookie (`whoOf`, set at sign-in and on any answer to a login), the page opens that person's
  own copy before it paints, and checks the cookie before every pull and push and on every tick; every pull and push
  carries `as`, and `syncRoutes` refuses one for another person's copy before anything acts.
- Nothing replaces a release that hasn't started on the home's data (`server/cli`): an update installs aside and boots
  on copies of the store and settings first; each install keeps the one it replaced; a rollback never crosses a
  migration without the store copy from before it; an automatic rollback only undoes an update that never proved
  itself, never back and forth.
- Every untrusted boundary is checked by a schema (`schema`); nothing is coerced. Money is safe-integer minor units.
- Replicated rows carry the current revision and are never deleted (tombstones), by trigger, not habit.
- What a screen says is decided by tables (`states`): a subject's states are a closed union and its table places
  every one, so an unplaced state doesn't compile. `Line` and `Screen` are made only by the kit; `compose` keeps every
  claim whole and says ok only when every part is. A source's failure codes map to who acts; an unknown code is `us`;
  a lost reply to a call that may have acted is `unknown`, reconciled, never re-run.
- A command that isn't resolved never fades (`Spec.resolved`): it stays drawn and kept across reloads until it resolves
  or the person dismisses it.

## Layout

- `src/*.ts`: pure entries. `src/web/`: browser. `src/server/`: Node. `src/build/`: the page's build (Node, esbuild
  plugins). `src/test/`: the seeded network, the OIDC
  stand-in and state table checks, for apps' tests. `src/conformance/`: the conformance suite, shipped so each app
  runs it against the version it installs, with `pull.ts` (the server pull contract, run by each app on its own pull)
  and `legacy/` (released adapters, for cross-release checks).
- `test/`: the kit's own regression tests, not shipped.
- `scripts/pack-check.ts`: the packed-consumer check.

## Commands

- `mise run check`: types, lint, every test against the source, format, dead code (knip). Seconds.
- `mise run pack:check`: packs the kit, installs the tarball in a scratch app outside the repo, checks `exports` names
  exactly the modules shipped (the public surface is that hand-written list), imports and type-checks every entry by
  name, runs the shipped conformance suite from the installed copy, and checks the browser budget.
- A `v<version>` tag matching `package.json`'s version releases it: the GitHub release, then npm.

## Code standards

- Generic: no hosts, ids, accounts or devices. Anything one person's lives in an app's config and credentials.
- Every behaviour and guarantee is pinned by a test that fails without it; each guarantee the kit ships has its
  conformance cases.
- The conformance suite's expected results come from the contract, never from the code's current answer.
- No mocks: real stores, real entry points, loopback stand-ins, the seeded overlapping network.
- Lint is ultracite's presets plus `src/lint.ts`, the rules every app shares (`slopkit/lint`), and the
  kit's own boundaries in `oxlint.config.ts`. A rule is off only with its reason beside it; a one-site exception is an
  `oxlint-disable-next-line` with its reason, and a type assertion states its checked invariant in a `SAFETY:` line.
