# Conformance suite

The kit's contract as executable checks. The expected results come from the contract, never from what the code
currently answers, and the suite ships with the package so every app runs it against the kit version it installs.

Run it here with `npm exec --no -- vitest --run src/conformance`; an app runs the built copy from its installed package
(see the README). Run the type check too: `states.test.ts` holds compile-time rejections (below).

## Method

- Tests call only public APIs: `Ledger`, `Jobs`, `createSync` and `createClient`, `table`, `indexedReplica`, `states`.
- Assertions are literal expected rows, exact effect and identity counts, durable readbacks and observable command
  answers. Tests don't use `commitPlan`, the production `digest`, production invariant predicates or any app's helpers
  to compute an expected answer. The fixture fingerprint only lets the protocol's verification handshake finish; it is
  not an oracle.
- The production client executor runs unchanged. The network peer supplies controlled inputs and results, not a
  replacement client.
- SQLite is real and reopens an on-disk file. IndexedDB uses separate `fake-indexeddb` factories and the production
  adapter; these headless checks don't replace adapter checks in native browsers.
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

Compile-time cases live in the uncalled `typeContract` function: each `@ts-expect-error` marks a program the types
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
