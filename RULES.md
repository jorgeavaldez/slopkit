# Rules for apps on slopkit

Rules version: 1

The standard every app built on `slopkit` meets, and the kit itself. The aim is speed and correctness,
solved once in the kit so every app built on it starts with these problems solved. Each rule is a property of the
finished app; where it isn't obvious, it names the failure it prevents. The version changes when what a rule requires
changes; this file ships in the package, so an app's rules are those of the kit version it installs.

A rule applies when an app has what it governs: a durable local copy (§5, §6), commands with outside effects (§5),
outside providers (§4), money or dates (§5). A small app meets only what it has, and the kit makes the heavy parts
cheap (§10).

## 1. Tests check invariants and behaviour, not code

- Tests check invariants and what can be observed: what the person sees (view data), effects and durable data, never
  internal state or how the code computes its answer.
- Expected results are independent of the implementation: a simple reference model, hand-written expected rows, or
  the spec; never the engine's own checksum, "done" label or output. Reusing the implementation's calculations
  reproduces its mistakes, and testable code isn't correct code.
- Two kinds of invariant: safety (nothing goes backwards, nothing happens twice, nothing is lost) and liveness (once
  dependencies recover, every action reaches an outcome and every copy converges). Prevents stuck-forever states that
  never "break" anything.
- Every guard is pinned: bypassing it makes a named test fail. A fixed bug has a test that fails without the fix.
- Tests are deterministic: seeded, with no sleeps. A flake is a bug.

## 2. Honest states, enforced at the commit point

Invalid states can't be represented, no state can be shown as another, and every failure the world can produce can.
Any system can fail.

- Illegal combinations and transitions are ruled out, and every state the world can produce is representable: unknown
  outcome, stale copy, not saved yet, degraded storage, needs recovery. Success or a final failure is never
  manufactured to get rid of an unknown. Prevents false "done" and silent loss.
- A class of bug is made impossible where it can be, not only tested for.
- Each invariant has one authoritative enforcer at the commit point (a type, a DB constraint or trigger, a
  transaction, the kit's command record), named with the test that fails without it. It rejects bad data before any
  cursor or checkpoint moves; earlier rejections are fine while the commit point still holds. "Everyone remembers to
  check" isn't enforcement. Boundaries prevent; production probes only detect.
- Outside input is hostile: whole provider pages, schemas and wire messages are validated before anything commits.
  Fixtures include bad shapes (a schema accepting "ok" with no result, a loosely typed column taking 0.5 as an integer
  amount). Input that only breaks our assumptions is rejected at the boundary, not given a new on-screen state.
- Effect configuration fails closed: a missing credential or setting stops the effect visibly; it never runs half
  configured.
- Every pending obligation (a sync due, an unknown outcome, a link waiting) has a deadline, and passing it is a visible
  state. Prevents work that silently never happens.

## 3. Every state has a decided display

What the screen can say is decided for every state, as a pure function of the app's model.

- **State catalog.** Each subject a person relies on (the local copy, the connection, each command, each outside
  source or account connection, each background job, the server) has a closed union of states, taken from our
  machines, the provider's documented lifecycle and time (fresh, stale, expired). Separate dimensions (source and
  history, operation, replica, freshness, presentation, identity and version, install) stay orthogonal tagged states
  with composition rules, not one giant enum. Prevents a concurrent fact being lost to another.
- **Every state's display is decided, with its reason.** A typed table `satisfies Record<State["kind"], Display>` maps
  each state to where it is drawn (`main`: it changes what the person should believe about the numbers or needs them
  to act; `badge`; `panel`; `log`), why, tone, glyph, text and action. A new state doesn't compile until it is placed.
  Two states share a display only when the statement is true for both and implies the same safe action. A hidden state
  has a reason, and hiding it changes no claim or action.
- **Never claim more than is true.** Order by placement, then severity, with each app setting its own severity order
  by consequence. Facts that change what the numbers mean (incomplete, possibly wrong, not saved, stale) sit next to
  the numbers and are never folded into a count behind another headline; a headline may lead with an action (sign in
  again) but can't hide them. "Synced" or ✓ only when every part is ok. A command accepted isn't done; a receipt isn't
  the current outcome; an unresolved external outcome stays visible until it resolves or moves to a durable recovery
  record.
- **Empty names its cause:** loading, never synced, still fetching at the provider, partial history, filtered out, or
  truly none. **Freshness names its clock:** when we asked, and when the source last updated, if it says.
- **Errors carry two independent facts.** Who acts: `retrying` (transient; shown with the next try), `you` (sign in
  again, consent; shown with the action), `us` (bad shape, broken invariant, our bug; logged for the maintainer),
  `gone` (removed, revoked; data kept read-only). And effect certainty (§5): a read is safe to retry; a non-idempotent
  effect whose response was lost is queried or reconciled, never re-executed because the error looked transient. An
  unknown code is `us`: never ok, never retried forever in silence.
- **One visual vocabulary:** the kit's tones and one glyph per meaning, never shared (`states`' `LOOKS`: ● ok,
  ◐ working, ◑ partial, ◷ stale, ○ off, · none, ↻ retrying, ⚠ needs you, ✕ ours or stuck, ⊘ gone; an app may change
  a glyph, never to one another meaning has). Meaning is never carried by colour or hover alone; every control and status has an accessible name,
  and accessibility violations fail the build. No new colours, boxes or spinners.
- **Verified over the whole catalog.** Tests enumerate every state and bounded combinations through the real engine
  and `view`: placement holds, states needing different actions never render the same text, and no number is shown
  without its claim-critical facts. Every state can also be drawn on its own at phone size (a gallery of the catalog),
  so each display can be seen as rendered.

## 4. Outside services

Every outside system is a source of states and failures, the deployment path included (CDN, tunnel, an identity proxy:
buffered streams, a login page returned as 200 HTML, 403s, idle timeouts).

- Each provider response's semantic inputs (readiness, completeness, cursor scope, what empty means) are listed, and
  every field we ignore has a written reason. Prevents facts dropped before the view, such as a source shown "ok" while
  the provider is still preparing data because its readiness field was never read. Strict decoders cover only the
  fields we chose to read.
- The stand-in follows the provider's documentation, each behaviour citing its source, not what the app expects:
  readiness phases, status fields, every mapped error, rate limits, timeouts, pagination, partial data, how records
  change. The deployment path has a stand-in in the headless gate and a check on the real path. Prevents a test world
  that can't fail the way the real one does.
- A coverage table maps each documented provider state or error to an app state; a test fails when one has no mapping.
  A new enum value becomes a visible `us` state.
- Units and sign conventions are mapped once, at the boundary, with a test taken from the documentation (a provider may
  report outflows as positive).
- One-time provider values (exchanged tokens, cursors) are persisted before the next step that depends on them.
- Decoders are proven on real responses, from the provider's free test environment (a sandbox) where one exists.

## 5. Time, concurrency, effects and durability

- Valid states aren't enough; histories must be valid. Individually valid steps can still lose data through
  concurrency, retries or crashes, so each invariant is tested across its enforcer under those.
- Every operation overlaps with itself: several tabs, retries, duplicate delivery, late replies, scheduled versus
  manual sync, a restart midway, a crash at each commit point. Identity, authorization and atomicity hold through all
  of them.
- Stale writers are fenced: every write carries its scope and base revision, checked in the commit transaction; a
  checkpoint never advances across a gap.
- Each effect has a known kind: local transactional, safe to replay, or not idempotent. It is claimed before it acts,
  and no transaction is held across a network call. Each non-idempotent effect has a defined way to resolve an unknown
  outcome (idempotency key, reconciliation read, or a human path), or else "in progress" is journaled before the call.
  Unknown is shown, never blindly retried, and never stays unknown forever. A local journal can't make a provider call
  exactly-once.
- Each command has an offline policy: offline-safe, online-only, or coalescible. Clients send intents and the server
  decides; editable local data has an explicit conflict rule.
- **Durability is declared.** Each app states what each acknowledgement ("saved", "committed", "synced") survives:
  reload, process crash, OS crash, power loss, file restore, VM snapshot rollback, server loss; its storage assumptions
  (for example SQLite `synchronous`); and its recovery source. Tests prove the promised level, no more. A store can't
  vouch for itself after a restore: a sidecar high-water mark and client evidence detect rollback, and restores are
  tested from real backup files.
- Every durable thing carries a scope (user, dataset, a generation bumped on restore or reset, device); sign-out,
  forget, restore and schema changes move the scope. Ownership lives in keys (a child keyed by parent and id; upserts
  check the owner). Authorization runs on every path, cached replays included.
- Every stored and wire shape is versioned on both sides; an old client gets a typed "incompatible". Migrations,
  IndexedDB included, are append-only and tested on data written by the previous release; unreadable records are kept,
  not dropped. A release boot-checks on a copy of the real store, and the previous release stays available for
  rollback.
- **Retention never breaks a guarantee.** No deletes without tombstones. Every queue and table has a bound, and
  retirement is safe: replay floors let a delayed retry still find its receipt; a client older than the tombstone floor
  gets an explicit reset, not a silent resurrection; garbage collection provably can't erase unresolved work.
  Authoritative user data is never silently truncated. Bounds cover the outbox, receipts, tombstones, telemetry
  buffers, logs and phone storage quota.
- Money is integer minor units with safe-integer checks, never a float, with an explicit currency and rounding policy;
  no cross-currency totals. Time comes in kinds that never mix: instants (UTC, shown local), date-only civil dates
  (2026-10-20 is that date everywhere, never midnight UTC), zoned schedules (cron, deadlines; DST explicit) and
  monotonic durations (timeouts). Never an accidental device-local date.

## 6. Verifiable end to end, fast, without a browser

Every app proves itself end to end, from UI interaction through the server with effects included, on a dev box or in
CI, without a full browser. Invariants hold the same in every environment, and verification is fast enough to speed
work up.

- The browser is an adapter. Decisions, effect orchestration (durable commits, recovery) and the pure `view(model)` run
  unchanged in every harness, over ports: storage, transport, clock, window (popups, visibility). No test-only copy of
  the runtime, and no interpreter that skips effects.
- Test doubles behave like the real thing (abort, crash, reopen, shared across tabs), never a plain in-memory map, and
  the same adapter suite runs against the real IndexedDB, fetch, WebSocket and service worker. The test world can
  produce every failure the app's states and coverage tables represent, in combination, with recovery challenged:
  overlap, interrupted commits, shared storage, identity changes, reconnects. More happy paths or seeds can't cover a missing failure dimension.
- Headless correctness doesn't prove the UI binding: a renderer can drop a recovery button or swap actions while
  `view()` passes. Thin rendering and binding checks prove each action in `view` reaches the right command and each
  warning is drawn, in each target browser (Safari and iOS PWA storage differ). A packed-consumer check proves the app
  runs the kit as shipped.
- Tiers: pure model tests in milliseconds; a seeded headless end-to-end gate in seconds; adapter and binding checks; a
  read-only check of the deployed app on synthetic data.
- Invariants mean the same everywhere; the workload differs. Production samples and probes; crash and fault tests run
  on isolated test data.

## 7. Speed

Performance is a requirement, aimed at the limits of every service and system involved.

- Limits are planned for and run with headroom: honour `Retry-After`, budget per scope (per item, per provider), never
  hit the wall to find it.
- Speed is measured against a computed floor (round trips, bytes, provider readiness), and the gap is known.
- Budgets are gates: time to first rows from the local copy, time to a first copy on a new device, pull bytes, request
  counts, longest main-thread task, bundle size. Deterministic measures (bytes, requests, round trips, long tasks) gate
  the headless suite; wall-clock budgets have a noise policy and are confirmed on the device.
- Show sooner: the local copy first; on a new device, pull newest first in pages with progress drawn; take a
  provider's partial set as soon as it's ready.
- Independent sources run in parallel with a bound, each with its own state; a slow one never holds up the others.
  Commits are batched per source update, page by page only when an update can outlast a timeout, with the partial
  state drawn. Every history is bounded (§5).

## 8. Measurement, logs and privacy

- Measured targets show at all times whether things get better or worse; the budgets (§7) gate the build.
- Every request, stream, job and effect logs its start, end and outcome with ids, and failures reach the maintainer
  before a user has to notice them.
- Logs and telemetry never carry secrets, tokens, link URLs or raw financial data; tests use synthetic data.

## 9. Architecture and design

- Data modelling, transports, scheduling, jobs, data handling and the frontend state machine are specified, modular
  and clean.
- **Local-first.** Data is cached locally and reconciled from the remote, so it is available at all times. Apps are
  small, fast, installable and offline-first where possible. Local-first is honest: freshness is separate from
  connection; the durable copy is separate from memory; a missing replica is never shown as an authoritative empty
  list; offline can't promise the latest server data; browser eviction is a state to show (request
  `navigator.storage.persist()`), not something an app can prevent.
- **Sign-out keeps data.** Signing out never deletes the local copy and draws "signed out, local copy kept"; signing
  back in doesn't need a full resync. A different user on the same device never sees the previous copy; removing it is
  an explicit "forget this device".
- **The server runs itself:** one compiled binary with one start command and one config, updating itself, doing its
  background work as durable jobs and syncing on a cron-style schedule.
- **Agent access.** An agent can run any query against an app's data through its API, and the API is built to extend.
- **Dependencies.** Few, from `DEPS.md`, so apps stay small. Few never means hand-rolled crypto, JWT, protocol parsers
  or weaker storage semantics: those use a vetted library (for example `jose`).
- **Defaults:** IndexedDB in the browser (SQLite in the browser only where demonstrably better); SQLite on the server;
  OIDC login, or Cloudflare Access's signed header where deployed; logins added in the UI.
- **Look.** Brutalist, mobile-first PWAs: dense, monospace, black and white, no shadows or rounded corners.
- Shipped source is generic: no hostnames, accounts or private data in code or docs; private data lives in the app's
  data directory and configuration.

## 10. The kit

- The kit owns the generic guarantees. Its helpers define sources, jobs and their states so each failure case is
  durable, expressible and shown, and invalid states are refused: a subject doesn't type-check without a display table
  placing every state of its union, nor a source without every documented failure code mapped to who acts; a job's
  states are a closed catalog.
- Apps build on the kit and never hand-roll a mechanism it provides (setup in `README.md`).
