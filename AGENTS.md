# Working on slopkit

`slopkit` is the kit its apps build on. `RULES.md` is the standard it meets as much as the apps do, and
ships in the package. `README.md` covers the entries and their use, `DEPS.md` the dependencies and budgets.

## The kit's invariants

Each is enforced at one place, named here, and pinned by a test: the conformance suite (`src/conformance/README.md`)
or the kit's own tests in `test/`.

- Pure entries (`schema`, `contract`, `sync`, `client`, `machine`, `money`, `digest`, `cron`, `states`) import no
  Node built-in and no DOM (lint, `test/lint-boundaries.test.ts`).
- A command acts at most once for whoever sent it, forever (`server/ledger`): claimed in a committed transaction before
  it acts; authorization before any replay; receipts name resources by id and arrive in the pull with the revision that
  holds their effects. Retention never deletes a key: an old receipt retires and never acts.
- Work the server owes on its own is a job (`server/jobs`): one open per key, claimed and committed before it acts,
  resolved at the next start after a stop, final once finished, `overdue` past its deadline.
- A replica only moves forward, on disk too (`web/replica`): a commit is decided against the stored checkpoint inside
  its own transaction; a forget moves a generation every writer checks; the outbox is per command and survives
  upgrades. A cached copy is read only under the row shapes that wrote it (`Schema.shape`, kept with the checkpoint).
- Nothing is sent before it is kept; observed and saved revisions are separate; a pull is owed while the server is
  ahead, whatever the socket says; the push channel only pokes (`sync`). A push carries the revision each command was
  tapped against, so a server can refuse intents made on a history it no longer has.
- Every untrusted boundary is checked by a schema (`schema`); nothing is coerced. Money is safe-integer minor units.
- Replicated rows carry the current revision and are never deleted (tombstones), by trigger, not habit.
- What a screen says is decided by tables (`states`): a subject's states are a closed union and its table places
  every one, so an unplaced state doesn't compile. `Line` and `Screen` are made only by the kit; `compose` keeps every
  claim whole and says ok only when every part is. A source's failure codes map to who acts; an unknown code is `us`;
  a lost reply to a call that may have acted is `unknown`, reconciled, never re-run.
- A command that isn't resolved never fades (`Spec.resolved`): it stays drawn and kept across reloads until it resolves
  or the person dismisses it.

## Layout

- `src/*.ts`: pure entries. `src/web/`: browser. `src/server/`: Node. `src/test/`: the seeded network, the OIDC
  stand-in and state table checks, for apps' tests. `src/conformance/`: the conformance suite, shipped so each app
  runs it against the version it installs.
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
