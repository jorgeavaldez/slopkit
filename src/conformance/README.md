# Conformance suite

The kit's contract as executable checks. The expected results come from the contract, never from what the code
currently answers, and the suite ships with the package so an app can run it against the kit version it installs.

Run it here with `npm exec --no -- vitest --run src/conformance`; an app runs the built copy from its installed package
(see the README). Run the type check too: `states.test.ts` and `push-refusal.test.ts` hold compile-time rejections.

## Method

- Tests call only public APIs: `Ledger`, `Jobs`, `createSync` and `createClient`, `table`, `indexedReplica`, `states`.
- Assertions are literal expected rows, exact effect and identity counts, durable readbacks and observable command
  answers. Tests don't use `commitPlan`, the production `digest`, production invariant predicates or any app's helpers
  to compute an expected answer. The fixture fingerprint only lets the protocol's verification handshake finish; it is
  not an oracle.
- The production client executor runs unchanged. The network peer supplies controlled inputs and results, not a
  replacement client.
- SQLite is real and reopens an on-disk file. IndexedDB uses `fake-indexeddb` and the production adapter, with shared
  factories for overlapping tabs and separate factories for isolated devices. HTTP boundaries use real loopback
  servers. These headless checks don't replace adapter checks in native browsers.
- Barriers control completion order. No sleeps and no mocked timers; a provider result that never returns holds no
  timer or process.
- Expected results are the contract's: a failing case is a defect in the code, and an expected result changes only
  when its contract does.

## Requirements

### Ledger (`ledger.test.ts`, `ledger-retire.test.ts`)

1. Overlapping copies of the same intent create one external effect and return the same receipt.
2. Reusing an identity with a different command kind or different arguments conflicts before any further effect.
3. A second ledger handle can't execute work another handle accepted.
4. Receipt reads are scoped to principal and client. Application authorization is tested in each app's router.
5. A failed receipt commit rolls back the local business effect and the acceptance, so a later retry can succeed once.
6. Reopening after an external effect was accepted but before its result shows an unknown outcome and never repeats
   the effect automatically.
7. Retirement drops an old result only: the key, name, arguments and revision stay, a replay of a retired key never
   acts, and accepted work overlapping retention keeps its claim and its eventual result.

### Jobs (`jobs.test.ts`)

1. One open job per kind and key; askers join it and every requester is kept in order.
2. A claim is committed before the effect starts, observable from another connection. `start` throws inside an
   already open transaction (it couldn't promise commit-before-effect); `ask` may join one.
3. A finished job never changes: retry, start, finish and interruption leave it as it is (each may throw or do nothing,
   never mutate), while new work for the same key is still possible.
4. Reopening at the claim/effect boundary resolves each recovery outcome (due again, done, failed), and a job due again
   completes.
5. The state catalog is closed: due, running, overdue, done, and failed by each actor. Overdue means strictly after the
   deadline, not at it.
6. Retention keeps the newest finished jobs of each kind and never removes open work.

### Replica storage (`replica.test.ts`, `replica-shape.test.ts`, `legacy-since-discard.test.ts`)

1. The provided factory is the only IndexedDB dependency; equal names in separate factories are separate stores.
2. Aborting revision 2 and then committing a revision-3 delta never creates a revision-3 checkpoint missing revision-2
   rows.
3. A stale tab's older reset can't move the shared durable dataset backwards.
4. Updates, removals and replacement snapshots reach exact durable rows on readback.
5. Per-command outbox writes can't overwrite another tab's intent or delete another client's intent with the same
   number.
6. Forget fences every stale writer, stale outbox deletion included; a page of the new generation continues.
7. A storage-version upgrade never discards a command, even one this version can't read.
8. A schema's `shape` tells apart every structural difference and is equal for schemas built alike. A change to a
   table's schema or name set starts the rows over and keeps the outbox.
9. A checkpoint written without row shapes (released before they existed) is reset, its readable outbox survives, and
   the next commit repairs the disk. Unreadable rows at the same shapes are repaired on disk at the same revision; an
   aborted repair is not acknowledged.
10. Server facts at the same revision are durable while an older tab writes nothing. Facts that no longer fit a newer
    schema cost the facts, never the rows.
11. A legacy command kept without `since` takes the disk's revision before any discard: with disk revision 17 and an
    unreadable or unshaped copy, the replica loads empty at 0, the command keeps `since` 17, and its push stays 17
    after a reset to 29.
12. A tab still open on another release's row shapes can't move the copy below a revision another release wrote, and
    can't overwrite a copy another release wrote since it loaded. A page may rewrite the copy it loaded and set aside at
    that copy's revision, never below it.

### Sync rules (`sync.test.ts`)

1. An older reset can't undo a newer update or bring back a tombstoned row.
2. An action produces a durable keep first; only its completion permits sending.
3. A fingerprint result for revision N can't certify revision N+1.

### Paged first copy (`paging.test.ts`, `paging-network.test.ts`, `paging-storage.test.ts`, `paging-state.test.ts`, `paging-budget.test.ts`)

The public paging vocabulary is:

- `sync.History` is `{ kind: "complete" } | { kind: "partial"; next: string; through: string | null;
  held: number; total: number }`; `Replica.history` keeps it. A whole reply or checkpoint from before paging means
  complete. An empty replica is complete at revision zero, not an authoritative empty server dataset.
- `sync.Page` is `{ from: string | null; next: string | null; through: string | null; held: number; total: number }`;
  `Patch.page?: Page` carries it. `from` is the cursor answered, null on a reset's first page; `next` is the next older
  cursor, null on completion. Cursors include the dataset, order version, order values and unique tie-breaker, never
  an offset or a lookup of an anchor's current row. `through` is the formatted **fully covered** order boundary, not
  the oldest row held. When a page splits a tie, it excludes that tie until the entire group lands; if no order group
  is fully covered yet, it is null. `held` is progress (paged rows at or above the keyset cursor), not the size of the
  fully covered range; `total` counts all live paged rows at the chunk's revision. Extra delta or receipt rows below
  the cursor do not deepen the claim.
- Pull effects and `client.NetworkPort.pull` requests carry `page?: string | null`. A new client normally sends null
  on its first/reset-or-delta request, then `history.next` while partial. Omission requests the transitional legacy
  whole protocol. `verify` is false while partial. `Commit.from?: string | null` carries the cursor a page moved from;
  the adapter checks it and the durable history in the same transaction as rows and checkpoint.
- `sync.HistoryState` is the closed union `loading`, `none`, `complete`, and
  `partial { through: string | null; held: number; total: number }` (each member has `kind`).
  `sync.deriveHistoryState(model)` returns loading while boot loads, none when ready without a dataset, otherwise
  partial or complete from the replica's history. Complete history never promises that storage is healthy.
- `sync.DurabilityState` is the independent closed union `loading`, `unsaved`, `lost { reason }`,
  `failing { reason }`, `replaced`, `unreadable { count }`, and `ok`.
  `sync.deriveDurabilityState(model)` uses the model's clock: boot loading first, then replaced, then a failed store
  (lost if an observed write is owed, failing otherwise), an overdue unsaved copy, unreadable commands, or ok.
  Fetching and waiting for a server are connection facts, not durability states.
- Each union is a separate subject the app places with `states.Table` and includes in composition. Neither one
  replaces the other: partial coverage and storage trouble remain drawn together in either composition order.
  Partial means `partial`, on `main`, as a claim: “history from <through>, loading older · held of total”; null means
  no fully covered history range yet. Totals and aggregates use the fully covered range, never incidental older rows.
  The state tests' tables and negative type cases consume the actual public derivers' return unions.

Requirements, with the numbered histories they cover:

1. After every applied chunk, every held row is the reference's row at that revision, and all rows in the claimed
   covered range are held. Edits, inserts and tombstones on both sides of the cursor, including an edited and then
   tombstoned anchor, preserve this invariant.
2. Equal-revision pages merge. A duplicate page cannot move the cursor twice. An unexpected `from` may merge current
   rows but cannot advance coverage; a reply older than the copy is dropped whole and cannot resurrect a row.
3. Only a reset replaces a dataset; its own history starts over. Commands from the old dataset are refused, including
   those whose earlier delivery is unknown.
4. A delta applies only with the same dataset and `since <= copy.revision <= reply.revision`. After a verification
   mismatch empties the copy, an in-flight delta cannot advance it across a gap; a real reset remains owed.
5. Named seeded histories with dropped, duplicate and delayed deliveries, recovery and reload converge to the exact
   reference rows and complete history. The production executor and real durable adapter run unchanged.
6. The first reply exposes newest rows and partial coverage immediately: one round trip, not a wait for completion.
7. Partial history itself owes another pull, back to back, carrying `next`. No-progress replies, repeated first-page
   resets included, back off; the obligation survives until complete.
8. No digest request or fingerprint comparison certifies partial history. Verification runs once complete.
9. A partial copy receiving an old server's non-reset reply without `page` preserves its history and asks for a whole
   reset (`since: 0`, no `page`). The resulting whole reset is complete.
10. An edited row below the coverage boundary never moves it merely because that row is held.
11. A command settled by a paged reset holds the row its receipt names, even below the page's boundary.
12. Each page's rows and history are durable together. A mid-download reload requests the stored cursor; two remaining
   pages cost two page requests, with at most one additional verification pull, not a restarted first copy.
13. Partial checkpoints use foreign row shapes for 0.1.2: an already-open old tab is fenced from overwriting a newer
   partial checkpoint; a reloaded old adapter loads no partial rows. That release may then fetch a legacy whole copy
   and replace the partial checkpoint. The new adapter reads that whole copy as complete, with every row present.
   `legacy/replica-012.ts` preserves the released adapter and commit decision, with import relocation and local legacy
   port/replica types only; the released row-shape string is pinned literally. Whole-copy read/write controls pass
   before and after paging, in both release directions.
14. A native failed page commit leaves a whole write owed even at the same revision. A retry repairs both rows and
   cursor, without acknowledging an aborted page.
15. Concurrent tabs at different cursors and revisions never persist coverage without its rows, regress a complete
   checkpoint to partial, or enter a busy whole-write loop. Both clients can finish, and durable rows remain exact.

Deterministic merge budget: processing a two-row chunk through `sync.update`, including emitted commit effects,
visits no more old rows at 100,000 rows than at 1,000 rows: no whole-table traversal/copy. Previously published table
values remain unchanged. This is the algorithmic gate, not a claim about phone wall-clock latency; device long-task
and packed browser-size budgets also apply.

### Server pull (`pull.ts`)

16. `slopkit/conformance/pull` exports `pullConformance(input: PullConformance): void`, registering black-box tests for
    an application's real pull function. `PullConformance` is `{ name: string; create(limits): Promise<PullFixture> }`.
    The fixture is new for each case and supplies only `pull`, transactional `write`, dataset `replace`, and `close`.
    `pull.ts` exports all input/result types. The application's adapter maps its paged table to synthetic `PullRow`
    (`id`, numeric `value`, `revision`, `deleted`), ordered by `(value, id)` descending, formats `through` as
    `String(value)`, maps an unpaged table and receipt resource ids, and reports the **actual encoded response bytes**
    before normalization. It must not page, merge, bound, or repair the response itself.

    The fixture's `write` stamps the returned revision on every changed row, in one committed transaction, and can
    record a receipt naming a resource in that same transaction. `replace` starts an empty new dataset. Real SQLite,
    the real application's pull and its actual decoding run behind this adapter; no in-memory pull implementation.
    The kit's own adapter uses `server/pull`, which ships the transactional SQLite chunk assembler.

    The cases require newest first, stable ties, exactly-once reachability without writes, current held rows and
    complete convergence with concurrent writes, edited/tombstoned anchors, truthful tied-order coverage (null when
    the first page contains no complete group), dataset-scoped cursors, unknown cursors resetting, and receipts carrying
    their resource rows even on resets. Every paging-aware reply fits both row and byte caps, including deltas,
    unpaged rows and receipt effects, tested together on a follow-up request. A delta that can't fit by itself becomes a
    bounded newest-first paged reset; an older page shrinks to the row and byte room the delta leaves, without
    restarting. Ordinary small deltas remain
    non-reset deltas for both paging-aware and legacy requests.

    **Compatibility exception:** a request **without** `page` receives today's whole legacy reply without page
    metadata, unbounded. Bounds apply to paging-aware requests, not this transitional path.

    Fixture caps are first page 2, later pages 3, reply at most 16 rows and 8192 encoded bytes. With no concurrent
    writes or byte pressure, N rows complete in `1 + ceil(max(0, N - firstRows) / pageRows)` requests (at least one),
    and the first reply's page is bounded independently of total history (1,000 rows in the budget case). Apps with
    growing page caps use the equivalent cumulative-cap formula in their own budget. Byte pressure is tested
    independently of row pressure, using additional fixtures with byte caps calibrated from actual encoded replies.
    The harness is shipped code, not a fake server; each app runs it on its own pull.

### Client executor (`client.test.ts`, `push-since.test.ts`, `push-batch.test.ts`)

1. Nothing reaches the network before the intent's transaction commits.
2. An aborted intent transaction produces a visible refusal and no effect.
3. A slow keep stays unresolved, with a visible slow-storage warning, and can't be sent before it commits. Once it
   commits, one logical operation completes and survives reload.
4. A reload between a local commit and its acknowledgement resumes the original identity. Late acknowledgements may
   cause duplicate delivery, never a second logical effect. Lost or unreadable acknowledgements stay recoverable under
   the original identity; an unreadable one is unknown, not a final failure.
5. A heartbeat can't cancel a failed catch-up obligation.
6. A later successful write repairs or keeps every row of an earlier failed delta.
7. A pending command from an old dataset never executes silently against its replacement.
8. `since` belongs to the tap: an intent tapped before any copy is sent with 0 even after copy 17 arrives; a tap at 17
   stays 17 through slow storage, a newer pull, reload and retry. A push never mixes clients, datasets or `since`
   values. A legacy outbox entry without `since` takes the revision loaded with it from disk, before any newer pull or
   reset.
9. A push carries at most `pushMax` commands (default `PUSH_MAX`, 50), oldest first: 120 kept commands go out as
   pushes of 50, 50 and 20, each command once, and every one reaches an outcome.

### Refused pushes and bounds (`push-refusal.test.ts`, `push-bytes.test.ts`, `outbox-bound.test.ts`)

The public vocabulary is:

- `contract.Failure.kind` includes `unreadable`: a successful JSON-typed reply is malformed JSON or fails its response
  schema. It may have acted. `server/web.Refusal` excludes `unreadable`; it is a client observation, never a server refusal.
  A failure may carry `refused?: true`, `path?: string`, and `retryAfterMs?: number`. `call` sets `refused` only for
  the kit's JSON `{ kind, message, path? }` error body whose kind matches its HTTP status; status alone never proves
  refusal. A schema 400's `path` is `Invalid.path` unchanged, e.g. `request.commands[1].command.value`, and `call`
  preserves it. Only a valid index in this push's `request.commands[i]` path names one command. A missing path, an
  envelope path or an index outside the batch is incompatible, not a per-command refusal.
- `CommandState`'s unknown member gains `parked?: true`: `{ kind: "unknown"; failure: string; parked?: true }`.
  Parked means needs attention, not a final outcome: kept across reloads, excluded from pushes, still named in pulls
  and answerable by a real receipt. An attempt with a lost outcome remains uncertain through retries and reloads;
  a later refusal cannot make it final. A known refusal restores each unaffected command's prior state.
- HTTP 408 and 429 are `unavailable`, with the parsed `Retry-After` in `retryAfterMs`; retries honour both backoff and
  that floor. HTTP 404, 405 and 413 are `invalid` without a command path (incompatible), logged. Proxy 403 and 409
  without a matching kit body keep their status classification but are not final. A successful JSON-typed reply with
  malformed or schema-bad JSON is `unreadable`, not a request refusal. A successful HTML login page and redirects mean
  `signed-out`: the identity proxy kept the request from the origin, and the remedy is signing in, not a reload.
- `sync.PUSH_BYTES` is 49,152 (48 KiB); `Spec.pushBytes` overrides it. Both it and `pushMax` are positive safe integers.
  The byte count is UTF-8 `JSON.stringify` of the **whole** push request that `call` sends, envelope included. An app
  gives its push server the same bound (`serveWeb.bodyLimit`), not a character limit. Oldest-first packing stops at
  the first command that cannot join this batch; it never fills the gap with a later smaller command. An intent too
  large even alone is answered at the tap without retention; an already-kept one is refused and kept if never
  uncertain, otherwise parked, and skipped so later commands can proceed.
- `sync.OUTBOX_MAX` is 500; `Spec.outboxMax` overrides it with a positive safe integer. The executor passes that bound
  to `StoragePort.keep(pending, max?)` (the omitted bound is `OUTBOX_MAX`). A successful write resolves `void`; a new
  key refused at capacity resolves `{ kind: "full"; waiting: number; finished: number; max: number }`. The IndexedDB
  transaction checks the stored count and writes together. An existing key may always update, even over capacity;
  unreadable stored keys still occupy capacity. Old records are never truncated. A full answer is not a storage
  failure: the executor answers a transient done `Pending` using `Spec.refused`, revision zero, with a message naming
  the full outbox, and removes that tap from the model without keeping it. `joins` runs before admission.
- `sync.OutboxState` is `{ kind: "ok" } | { kind: "full"; waiting: number; finished: number; max: number }`.
  `sync.deriveOutboxState(model)` is an independent subject for an app's state table. Waiting commands need a
  connection; finished commands need dismissal, not reconnection. Counts include the store's capacity-refusal
  snapshot when another tab filled it, not just this page's commands. A later admission still asks the transaction;
  an old full snapshot must not permanently forbid trying after another tab frees capacity.

Requirements:

1. A three-command batch with a schema-bad middle command acts zero times on the rejected request. Only that command
   gets the server's refusal, kept and answered; the other two are resent once, receive receipts and act once each.
   The rejection is logged. The 400 body carries the exact schema path before any handler effect.
2. A command that acted before a lost reply reconciles to its real receipt after a retry batch's 400 names a different
   command. A kit forbidden/conflict after prior uncertainty cannot manufacture a final outcome either.
3. An uncertain command named by a schema refusal parks durably, is never sent again (after reload too), stays named
   in pulls and becomes done with the actual receipt when that pull lands.
4. A strict envelope mismatch is incompatible, returns commands to their prior state and acts zero times. Reload with
   the matching contract completes them once under the original identities.
5. Only a matching kit error body can be final: proxy HTML, JSON without kind and a mismatched kind cannot settle a
   command. HTTP 408/429 wait until the provider's retry floor; HTTP 404/405/413 stop as incompatible with unknown
   intents and a log. Unreadable success is unknown and incompatible; reload obtains the original ledger receipt.
6. Multibyte commands fit the default 48-KiB request cap and a custom cap, preserving exact tap order. Packing cannot
   skip a non-fitting middle command to send a smaller later one.
7. A stored oversize oldest command, queued or uncertain, is refused or parked respectively; later work still sends.
   A new oversize tap has an answer but no model, disk or network record.
8. A UTF-8 character split between real HTTP body chunks reaches the handler intact. The byte cap refuses a body
   whose character count fits but byte count does not, before its handler runs.
9. Two offline executors sharing one IndexedDB admit no more than one shared maximum, despite overlapping keeps and
   stale page counts. Every other tap is answered, with no model or disk record and no storage-failure state.
10. A full outbox changes neither the model's retained commands nor durable records on another tap; an equivalent
    `joins` tap still coalesces first. A delayed load cannot admit beyond the already-full disk.
11. An over-capacity load keeps all old records. Receipts still update those records. New keys remain refused until
    dismissal takes the count below max; then admission resumes. The outbox subject distinguishes waiting-only and
    finished-only full states, and becomes ok when there is room.

Push handlers answer per-command outcomes as receipts: after any command in a request acted, they never throw a
final-kind refusal for the request. The ledger case sends a successful command followed by a conflicting identity,
receives both per-command receipts, and replays without repeating the first effect. Whole-request schema validation
runs before the handler, so a schema rejection with a command path proves no command acted in **that attempt**.

### Pure view

1. Elapsed keep time is shown as slow storage, not as a final "not sent".
2. An actual keep failure is shown as not sent, not merely as slow storage.

### States (`states.test.ts`)

Enforcers, and the mutations each case must catch:

- The total `Table` and placement union: omit a kind, hide a non-ok line, drop a partial or stale claim or a reason.
- Nominal `Line` and `Screen`: construct one, forge a structural literal, or spread-copy one and falsify it.
- `subject`: a whitespace-only reason is rejected before rendering; a table's text and action survive unchanged.
- Vocabulary: duplicate a glyph; omit, duplicate or reorder `ok`. A valid custom vocabulary is the positive control.
- `compose`: drop a part, put a badge before main, reverse severity or tie order, fold a whole claim into `more`, or
  make any non-ok combination green. A bounded matrix covers every pair of meanings.
- `source`: classify an unknown code as ok or retrying, confuse who acts with effect certainty, or replay a lost or
  malformed non-idempotent call. Prototype property names count as unknown codes.
- Retained inputs: mutating the caller's order, looks, table or parts after validation changes nothing.
- Retry delay: remove the doubling, the cap or the provider-hint floor.

Compile-time cases live in uncalled `typeContract` functions: each `@ts-expect-error` marks a program the types
must reject, and an unused one fails the type check, proving a guard is missing. This is the one allowed use of
`@ts-` comments.

Semantics: an empty `compose` is the all-ok empty product. The synthetic `LOST` and `MALFORMED` codes are not
documented provider codes. A lost read is retrying and safe; a malformed read is `us` and not retried automatically;
either failure of a `once` call leaves the effect unknown. Claims keep the order supplied; severity picks the headline
and badge, not which facts survive. A headline claim stays in `claims` and isn't also counted in `more`.

### Sessions (`test/auth-sessions.test.ts` and the auth tests beside it)

1. Concurrent first logins all stay valid, now and after a new `WebAuth` reads the files; overlapping login and logout
   never brings back a signed-out session or loses another one.
2. Malformed session JSON means no sessions: a new login succeeds and survives a reopen, and old tokens stay signed
   out. A real file I/O failure rejects the call and leaves the file intact; after repair, earlier sessions are
   readable again.

### Agent access (`agent-access.test.ts`, `slopkit/test/agents`)

Each app runs `agentAccess` against its real server, listing what its agents read and what only the person may do;
this case proves the check itself.

1. A key reads each listed read with no Origin and no login; the same read is signed-out without credentials and
   forbidden with an unknown key.
2. A key is refused each listed person's call: `forbidden`, or an answer the case judges a refusal (a sync push's
   forbidden receipts).
3. A person's route a key can call, or an agent's read a key can't, fails the check naming the call; a check listing
   no read or no refused call fails.

## Limits

These checks run headless. They make no claim about an app's DOM and bindings, real provider recovery, HTTP
authorization policy, browser eviction, packed-release upgrades or power loss; apps cover those. Nominal values can't
force a renderer to draw them or make `compose` know about a subject it wasn't given, so apps verify their complete
subject inventory and rendering bindings. Type assertions and `any` are outside the typed API's promise; runtime
mutable aliases are inside it. The mutation lists above are the targets each case must catch, not a record that a
mutation run happened.

Two releases with different row schemas open on one device: once one release's tab writes the copy under its own
shapes, it owns it, and a tab of the other release that hasn't reloaded since stops writing (`Replaced`) at any
revision. Which release then keeps the copy follows which one reloads into it; the kit has no release number to order
them by.
