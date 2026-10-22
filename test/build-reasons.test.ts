/** Contract: a state table's reasons are for whoever reads the source; the page's bundle drops them, nothing else. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { expect, onTestFinished, test } from "vitest";

import { dropReasons } from "../src/build/reasons.ts";
import { check, object, string } from "../src/schema.ts";

const states = join(import.meta.dirname, "../src/states.ts");

/** Bundles `source` (as a file importing the kit's states) with the plugin, and returns the code. */
async function bundled(source: string, file = "view.ts"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "slopkit-reasons-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, file), source.replaceAll("slopkit/states", states));

  const result = await build({
    entryPoints: [join(home, file)],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [dropReasons()],
  });

  return result.outputFiles[0]?.text ?? "";
}

const table = `
import { MEANINGS, states } from "slopkit/states";

const ui = states({ order: MEANINGS });

export const note = ui.subject<{ kind: "saving" } | { kind: "saved" }>("note", {
  // a comment with a brace { and a "quote
  saving: {
    meaning: "working",
    where: "main",
    claim: false,
    why: "The note is on its way to the server",
    text: () => "saving {1}",
    action: null,
    owes: () => ({ sync: true }),
  },
  saved: { meaning: "ok", where: "main", claim: false, why: 'Kept by the server, it\\'s safe', text: () => \`saved \${"}"}\`, action: null },
});

export const line = note.line({ kind: "saved" }).text;

export const last = ui.subject<{ kind: "gone" }>("last", {
  gone: {
    meaning: "ok",
    where: "main",
    claim: false,
    text: () => "gone",
    action: null,
    why: "a reason written last, before the brace"
  },
});
`;

test("the reasons in a subject's table leave the bundle, and the table still builds and draws", async () => {
  const code = await bundled(table);
  expect(code).not.toContain("on its way to the server");
  expect(code).not.toContain("Kept by the server");
  expect(code).not.toContain("a reason written last");
  expect(code).toContain("saving {1}");

  const loaded: unknown = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  expect(check(object({ line: string() }), loaded)).toMatchObject({ value: { line: "saved }" } });
});

test("a why that isn't a state's reason stays: outside a subject's table, or not a plain string", async () => {
  const code = await bundled(`
import { MEANINGS, states } from "slopkit/states";

const ui = states({ order: MEANINGS });
const reason = "a reason kept by reference";
export const flight = { why: "cancelled by the airline", meaning: "not a table" };

export const note = ui.subject<{ kind: "saved" }>("note", {
  saved: { meaning: "ok", where: "main", claim: false, why: reason, text: () => "saved", action: null },
});

const shared = { saved: { meaning: "ok", where: "main", claim: false, why: "a table passed by name", text: () => "x", action: null } } as const;
export const other = ui.subject<{ kind: "saved" }>("other", shared);
export const why = note.line({ kind: "saved" }).text + flight.why + other.line({ kind: "saved" }).text;
`);

  expect(code).toContain("cancelled by the airline");
  expect(code).toContain("a reason kept by reference");
  expect(code).toContain("a table passed by name");
});

test("a table the plugin can't read to its end fails the build rather than guessing", async () => {
  await expect(
    bundled(`
import { MEANINGS, states } from "slopkit/states";
const ui = states({ order: MEANINGS });
export const note = ui.subject("note", { saved: { meaning: "ok", why: "unclosed", text: () => "x"
`)
  ).rejects.toThrow(/reasons/);
});
