/**
 * The packed-consumer gate: what an app installs is what was proven. It packs the built kit, installs the tarball in a
 * scratch app outside this repo (so nothing resolves from here: an undeclared dependency or a file missing from the
 * package fails), then, from that installed copy, checks the exports map names exactly the modules shipped, imports
 * every entry by its public name, type-checks every entry as a TypeScript app resolves it (nodenext and bundler,
 * declarations included), runs the shipped conformance suite, and bundles the browser runtime against its gzip budget.
 *
 * `node scripts/pack-check.ts [tarball]`: without one it packs `dist/` (build first). CI publishes the tarball this
 * passed, never a fresh pack.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

/**
 * The kit's client core (`DEPS.md`), minified and gzipped together: it grows only with a new entry or guarantee, by its
 * measured size. `cron` is browser-safe but outside the core.
 */
const BROWSER_BUDGET_GZIP_BYTES = 10_730;

const BROWSER = [
  "schema",
  "contract",
  "sync",
  "client",
  "machine",
  "money",
  "digest",
  "states",
  "web/replica",
];

const root = resolve(import.meta.dirname, "..");
const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

function devVersion(name: string): string {
  if (typeof manifest !== "object" || manifest === null || !("devDependencies" in manifest)) {
    throw new Error("package.json has no devDependencies");
  }

  const versions = manifest.devDependencies;

  const version: unknown =
    typeof versions === "object" && versions !== null
      ? Object.entries(versions).find(([key]) => key === name)?.[1]
      : undefined;

  if (typeof version !== "string") {
    throw new TypeError(`package.json has no ${name}`);
  }

  return version;
}

/** The entries `package.json` exports, by subpath (`server/web`), leaving out `./package.json`. */
function exported(path: string): string[] {
  const installedManifest: unknown = JSON.parse(readFileSync(path, "utf-8"));

  if (
    typeof installedManifest !== "object" ||
    installedManifest === null ||
    !("exports" in installedManifest) ||
    typeof installedManifest.exports !== "object" ||
    installedManifest.exports === null
  ) {
    throw new Error("the package exports nothing");
  }

  return Object.keys(installedManifest.exports)
    .filter((key) => key !== "./package.json")
    .map((key) => key.slice(2));
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

const scratch = await mkdtemp(join(tmpdir(), "slopkit-pack-"));

try {
  let tarball = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);

  if (tarball === undefined) {
    execFileSync("npm", ["pack", "--silent", "--pack-destination", scratch], { cwd: root });
    const name = readdirSync(scratch).find((each) => each.endsWith(".tgz"));

    if (name === undefined) {
      throw new Error("npm pack wrote no tarball");
    }

    tarball = join(scratch, name);
  }

  const app = join(scratch, "app");
  execFileSync("mkdir", ["-p", app]);
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "pack-check",
      private: true,
      type: "module",
      dependencies: { slopkit: `file:${tarball}` },
      devDependencies: {
        "@types/node": devVersion("@types/node"),
        "fake-indexeddb": devVersion("fake-indexeddb"),
        typescript: devVersion("typescript"),
        vitest: devVersion("vitest"),
      },
    })
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], app);

  const installed = join(app, "node_modules", "slopkit");
  const shipped: string[] = [];

  const walk = (directory: string) => {
    for (const each of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, each.name);

      if (each.isDirectory()) {
        walk(path);
      } else if (each.name.endsWith(".js") && !each.name.endsWith(".test.js")) {
        shipped.push(relative(join(installed, "dist"), path).replace(/\.js$/, ""));
      }
    }
  };

  walk(join(installed, "dist"));

  // The public surface is the exports map, written by hand: every module shipped is in it, and it names nothing else.
  const entries = exported(join(installed, "package.json"));
  const unlisted = shipped.filter((each) => !entries.includes(each));
  const missing = entries.filter((each) => !shipped.includes(each));

  if (unlisted.length > 0 || missing.length > 0) {
    throw new Error(
      `exports and dist/ disagree: shipped but not exported ${unlisted.join(", ") || "none"}; exported but not shipped ${missing.join(", ") || "none"}`
    );
  }

  // Every entry by its public name, as an app imports it.
  await writeFile(
    join(app, "entries.js"),
    entries.map((entry) => `await import("slopkit/${entry}");`).join("\n")
  );
  run(process.execPath, ["entries.js"], app);
  console.log(`pack-check · ${entries.length} entries import by name`);

  // Their types, as a TypeScript app resolves them under Node's rules and a bundler's, declarations checked too.
  await writeFile(
    join(app, "types.ts"),
    entries.map((entry, at) => `export * as e${at} from "slopkit/${entry}";`).join("\n")
  );

  for (const resolution of ["nodenext", "bundler"]) {
    const module = resolution === "nodenext" ? "nodenext" : "esnext";
    run(
      "npm",
      [
        "exec",
        "--no",
        "--",
        "tsc",
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--target",
        "es2024",
        "--module",
        module,
        "--moduleResolution",
        resolution,
        "--types",
        "node",
        "types.ts",
      ],
      app
    );
  }

  console.log("pack-check · entry types resolve under nodenext and bundler");

  // The conformance suite as shipped, against the installed copy.
  await writeFile(
    join(app, "vitest.config.js"),
    `export default { test: { include: ["node_modules/slopkit/dist/conformance/*.test.js"], exclude: [], testTimeout: 20000 } };`
  );
  run("npm", ["exec", "--no", "--", "vitest", "--run"], app);

  const bundle = await build({
    stdin: {
      contents: BROWSER.map((entry) => `export * from "slopkit/${entry}";`).join("\n"),
      resolveDir: app,
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    write: false,
  });

  const gzip = gzipSync(bundle.outputFiles[0]?.contents ?? new Uint8Array()).length;
  console.log(
    `pack-check · browser runtime ${gzip} bytes gzip (budget ${BROWSER_BUDGET_GZIP_BYTES})`
  );

  if (gzip > BROWSER_BUDGET_GZIP_BYTES) {
    throw new Error(
      `the browser runtime is ${gzip} bytes gzipped, over its ${BROWSER_BUDGET_GZIP_BYTES} budget`
    );
  }

  console.log("pack-check · PASS");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
