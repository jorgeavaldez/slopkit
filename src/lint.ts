import type { DummyRuleMap } from "oxlint";

/**
 * The lint standard shared by the kit and its apps, on top of ultracite's oxlint presets (`core`, `vitest`,
 * `anti-slop`). Everything in the presets holds except the house choices here, each with its reason, and `strict` is
 * kept above them. An app's `oxlint.config.ts` extends the presets at the ultracite version it pins, spreads `house`
 * and `strict` into its rules and `tests` into an override for its test files, refuses `noMocks` there, and adds its
 * own boundaries. It also turns on tsc's `noImplicitReturns`, which stands in for `typescript/consistent-return`.
 */

/** Style the family writes the other way from the presets. */
export const house = {
  // Order carries meaning: lifecycle order in state tables, wire order in schemas, declarations in reading order.
  "sort-keys": "off",
  "sort-vars": "off",
  // Named functions are declarations (hoisted, named in stack traces); small helpers are arrows.
  "func-style": "off",
  // Types are `type` aliases throughout: unions and shapes alike.
  "typescript/consistent-type-definitions": "off",
  // Counters and revisions step by one; `revision++` says so.
  "no-plusplus": "off",
  // A two-level ternary picks one of three values in one expression; the formatter lays it out.
  "no-nested-ternary": "off",
  // `const x = value.x` reads as plainly as destructuring one field, and keeps the source in view.
  "prefer-destructuring": "off",
  // Patterns are short and read by position (`match[1]`); naming each group adds noise.
  "prefer-named-capture-group": "off",
  // Patterns are ASCII; the `u` flag changes escaping rules for nothing.
  "require-unicode-regexp": "off",
  // Named imports from node: modules, never default namespace objects.
  "unicorn/import-style": "off",
  // `(await port.load()).replica` reads one field of one result; a binding per read adds nothing.
  "unicorn/no-await-expression-member": "off",
  // IndexedDB requests take exactly one handler each, by assignment.
  "unicorn/prefer-add-event-listener": "off",
  // `return send(...)` ends a void handler early, on purpose.
  "typescript/no-confusing-void-expression": "off",
  // Returning a held promise keeps its identity (shared loads, deferreds).
  "typescript/promise-function-async": "off",
  // A runner chains each effect to exactly one message.
  "promise/prefer-await-to-then": "off",
  // Node, IndexedDB and fs.watch speak callbacks; adapters take them as they come.
  "promise/prefer-await-to-callbacks": "off",
  // Adapters wrap callback APIs: IndexedDB, http, fs.watch.
  "promise/avoid-new": "off",
  // A reducer is one exhaustive switch by design.
  complexity: "off",
  // switch-exhaustiveness-check proves every case is handled; a `default` would hide a new one from it.
  "default-case": "off",
  // tsc's noImplicitReturns checks this and knows an exhaustive switch returns; this rule doesn't.
  "typescript/consistent-return": "off",
  // A module is one public entry point; a pair of classes that make each other belongs together.
  "max-classes-per-file": "off",
  // exactOptionalPropertyTypes needs absent fields omitted.
  "anti-slop/no-conditional-empty-object-spread": "off",
  // `() => undefined` is a typed value (`T | undefined`), not noise.
  "unicorn/no-useless-undefined": "off",
} satisfies DummyRuleMap;

/** Strictness kept on top of the presets. */
export const strict = {
  "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
  "typescript/no-explicit-any": "error",
  "typescript/no-non-null-assertion": "error",
  "import/no-cycle": "error",
} satisfies DummyRuleMap;

/** For test files: cases assert whole histories and run their steps in order on purpose. */
export const tests = {
  // A case asserts a whole history, every step of it.
  "vitest/max-expects": "off",
  // A file is one subject; a describe around it all says nothing more.
  "vitest/require-top-level-describe": "off",
  // `test` throughout; `it` reads no better.
  "vitest/consistent-test-it": "off",
  // `expect(await x)` shows the value that was awaited, in order with the steps around it.
  "vitest/prefer-expect-resolves": "off",
  // toBe(false) is stricter than toBeFalsy().
  "vitest/prefer-to-be-falsy": "off",
  "vitest/prefer-to-be-truthy": "off",
  // Its fix imports vitest's `pending` over a fixture's.
  "vitest/prefer-importing-vitest-globals": "off",
  // Steps run in order on purpose: each waits for the last.
  "no-await-in-loop": "off",
  // A port stand-in is async to match the real port's type, whether or not it awaits.
  "require-await": "off",
  // `Promise<void> | void` types a cleanup that may or may not be async.
  "typescript/no-invalid-void-type": "off",
} satisfies DummyRuleMap;

/** Tests drive real stores and loopback services through public seams (`RULES.md`): vitest's mocking is refused. */
export const noMocks = {
  name: "vitest",
  importNames: ["vi", "vitest"],
  message:
    "Tests drive real stores and loopback services through public seams; no mocks, spies, or stubs.",
};
