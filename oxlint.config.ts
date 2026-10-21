import { builtinModules } from "node:module";

import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

import { noMocks, preset } from "./src/lint.ts";

/** Test code and test tools: shipped code never imports them. */
const TEST_CODE = {
  group: [
    "./test/**",
    "../test/**",
    "./conformance/**",
    "../conformance/**",
    "vitest",
    "vitest/**",
    "fake-indexeddb",
    "fake-indexeddb/**",
  ],
  message: "Shipped code never imports test code or test tools.",
};

/** Every Node built-in, with or without `node:`, and any subpath (`node:fs/promises`, `path/posix`). */
const NODE = `^(node:.*|(${builtinModules
  .filter((name) => !name.startsWith("node:") && !name.includes("/"))
  .join("|")})(/.*)?)$`;

/**
 * Ultracite's presets (core, vitest, anti-slop) with the family's shared choices (`src/lint.ts`, shipped as
 * `slopkit/lint`), two rules that would rename the kit's public API, and the kit's own boundaries.
 */
export default defineConfig({
  extends: [core, vitest, antiSlop, preset],
  ignorePatterns: core.ignorePatterns ?? [],
  rules: {
    // The error class names are public API (`Invalid`, `Replaced`, `Refusal`).
    "unicorn/custom-error-definition": "off",
    // `Schema.shape` and `Lens.shape` are public API.
    "anti-slop/no-shape-in-symbol-names": "off",
    "no-restricted-imports": ["error", { patterns: [TEST_CODE] }],
  },
  overrides: [
    {
      // Where untyped input becomes typed: schemas, config and session files, IndexedDB records, SQL rows, replies.
      files: [
        "src/schema.ts",
        "src/client.ts",
        "src/server/auth.ts",
        "src/server/config.ts",
        "src/server/ledger.ts",
        "src/server/pull.ts",
        "src/server/web.ts",
        "src/web/replica.ts",
        "scripts/pack-check.ts",
      ],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop/no-reflect-get": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
    {
      files: ["src/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                regex: NODE,
                message:
                  "Top-level modules are pure: they run in the browser and Node alike. Node code goes in src/server.",
              },
              { group: ["./server/**", "./web/**"], message: "Pure modules import no runtime." },
              TEST_CODE,
            ],
          },
        ],
      },
    },
    {
      files: ["src/web/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              { regex: NODE, message: "src/web runs in a browser: no Node modules." },
              { group: ["../server/**"], message: "The browser never imports the server." },
              TEST_CODE,
            ],
          },
        ],
      },
    },
    {
      files: ["src/server/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              { group: ["../web/**"], message: "The server never imports the browser runtime." },
              TEST_CODE,
            ],
          },
        ],
      },
    },
    {
      files: ["src/test/**", "src/conformance/**", "test/**", "scripts/**", "*.config.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [noMocks],
          },
        ],
      },
    },
  ],
});
