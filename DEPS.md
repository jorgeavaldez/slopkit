# Dependencies and budgets

Blessed dependencies only, preferring none. A dependency earns its place by what it replaces in lines, its gzip cost in
the browser or its install cost, its own dependencies and its maintenance status.

## The kit's dependencies

- **Server, never shipped to the browser:** `jose` (JWT and JWKS verification: security code, where a tested,
  dependency-free library beats our own) and `ws` (the WebSocket server; browsers use their own). Node 24+ built-ins
  for the rest: `node:http`, `node:sqlite`, `node:crypto`, `node:zlib`.
- **Optional peers:** `vitest` and `fake-indexeddb`, used only by the shipped `conformance/*` entries in an app's tests;
  `esbuild`, whose plugin type `slopkit/build/reasons` names.
  `fake-indexeddb` is a spec implementation with no dependencies, so the real IndexedDB port runs headless.
- **Development:** TypeScript 7, esbuild, vitest, oxlint with tsgolint and ultracite's presets, oxfmt, knip.
  Dependabot moves the lint tools together.

Written in the kit instead: schemas (reconsider valibot past ~300 lines), the IndexedDB wrapper, cron, the log, the
seeded network's PRNG and scheduler.

## Defaults for apps

- **Browser:** `preact` (5.3 KB gzip). Nothing else: the page's state is one model through `update`
  (`slopkit/machine`), so `@preact/signals` (2.6 KB gzip more) holds nothing it doesn't.
- **Build:** esbuild, with `slopkit/build/reasons`'s `dropReasons()` (a state table's reasons stay out of the page).
- **Development:** oxlint on ultracite's presets (`core`, `vitest`, `anti-slop`) with the kit's `lint` rules; oxfmt;
  knip for unused files, exports and dependencies.
- **Not blessed:** zod and TypeBox in the browser (size); `idb` and workbox (a few dozen lines replace them); routers
  (the model holds the route); React and CSS frameworks; date libraries (`Intl` covers them); pino; Playwright (its own
  browser builds, not on every platform; binding checks drive the installed browser); Replicache (archived; its protocol is reimplemented); sqlite-wasm unless demonstrably better;
  fast-check unless shrinking proves needed.

## Budgets

- **Kit client core**, gated by `pack:check` on the packed package: `schema`, `contract`, `api`, `sync`, `client`,
  `machine`, `money`, `digest`, `states`, `web/replica` and `web/runtime`, minified and gzipped together, ≤ 17,266
  bytes (17,266 measured; the paged first copy added 1,470, refused pushes and the bounded outbox 1,755, the sync
  contract and the page's runtime 2,428, in place of each app's own, a working state's owed work 107, a lifted copy's
  mark and owed reset 468, and when sync work is under way, by the engine's own rule, 310).
  `cron` and `web/lift` (lifting an earlier release's copy, about 520 on top of the core) are browser-safe but outside
  the core; an app that ships one counts it in its own budget. The budget grows only with a new entry or guarantee, by
  its measured size.
- **Hello app** (preact, and `sync`, `client`, `web/replica`, `schema`, `contract`, `states`): ≤ 17 KB gzip
  JS, gated by the app template once it exists.
- **Every app**, by default: initial JS ≤ 25 KB gzip, CSS ≤ 4 KB gzip, service worker ≤ 2 KB gzip. An app may lower
  these, never raise them silently.
