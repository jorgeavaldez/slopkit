/** The import boundaries hold through the real lint config: each probe file is linted where a module would live. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { array, check, object, string } from "../src/schema.ts";

const root = resolve(import.meta.dirname, "..");

const LINT_REPORT = object({ diagnostics: array(object({ code: string() })) });

/** The rule codes oxlint reports for `source` placed in `directory` as a file ending in `suffix`. */
async function findings(directory: string, source: string, suffix = ".ts"): Promise<string[]> {
  const file = join(root, directory, `boundary-probe-${randomUUID()}${suffix}`);
  await writeFile(file, source);

  try {
    const run = spawnSync(
      process.execPath,
      [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", file],
      { cwd: root, encoding: "utf-8" }
    );

    const report = check(LINT_REPORT, JSON.parse(run.stdout));

    if (!report.ok) {
      throw new Error(`oxlint gave no report: ${run.stderr}`);
    }

    return report.value.diagnostics.map((each) => each.code);
  } finally {
    await rm(file, { force: true });
  }
}

/** The import-boundary findings oxlint reports for `source` placed in `directory`. */
async function refusals(directory: string, source: string): Promise<number> {
  return (await findings(directory, source)).filter((each) =>
    each.includes("no-restricted-imports")
  ).length;
}

test.each([
  ["src", 'import { readFile } from "node:fs/promises";\nexport const x = readFile;\n'],
  ["src", 'export { readFile } from "node:fs/promises";\n'],
  ["src", 'import { readFile } from "fs/promises";\nexport const x = readFile;\n'],
  ["src", 'export * from "path";\n'],
  ["src", 'import { WebAuth } from "./server/auth.ts";\nexport const x = WebAuth;\n'],
  ["src", 'import { Network } from "./test/network.ts";\nexport const x = Network;\n'],
  ["src", 'import "fake-indexeddb/auto";\n'],
  ["src/web", 'import { readFile } from "node:fs/promises";\nexport const x = readFile;\n'],
  ["src/web", 'import { WebAuth } from "../server/auth.ts";\nexport const x = WebAuth;\n'],
  [
    "src/server",
    'import { indexedReplica } from "../web/replica.ts";\nexport const x = indexedReplica;\n',
  ],
])("%s refuses %j", async (directory, source) => {
  expect(await refusals(directory, source)).toBe(1);
});

test.each([
  ["src", 'import { check } from "./schema.ts";\nexport const x = check;\n'],
  ["src/web", 'import { check } from "../schema.ts";\nexport const x = check;\n'],
  ["src/server", 'import { readFile } from "node:fs/promises";\nexport const x = readFile;\n'],
])("%s allows %j", async (directory, source) => {
  expect(await refusals(directory, source)).toBe(0);
});

// `preset` (`slopkit/lint`) reaches test files: mocks are refused and the test rules apply.
test("a test file refuses vi and keeps the test rules", async () => {
  const codes = await findings(
    "test",
    'import { expect, test, vi } from "vitest";\n\ntest("probe", () => {\n  expect(vi).toBeDefined();\n});\n',
    ".test.ts"
  );

  expect(codes.filter((each) => each.includes("no-restricted-imports"))).toHaveLength(1);
  expect(codes.filter((each) => each.includes("require-top-level-describe"))).toStrictEqual([]);
});
