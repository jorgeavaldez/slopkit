/**
 * An app's command line and its releases: `serve | update | rollback | probe | version`, the same for every app on the
 * kit.
 *
 * - **One server per home,** held by a lock the OS releases if the process dies. Ready means ready: the line a
 *   supervisor waits for comes only once the app serves, and a home whose `web.json` can't be served is degraded.
 * - **Nothing replaces a release that hasn't started on this home's data.** A release tarball from the package's
 *   GitHub releases (`edge` is the newest main; `<NAME>_RELEASES` names a mirror) is installed aside and started on a
 *   scratch home holding copies of the store, `config.json` and `web.json` (no credentials, none of the environment)
 *   until it says it is ready; only then does it replace the running one.
 * - **A rollback is always possible after an update:** each install keeps the release it replaced
 *   (`<home>/releases/previous.tgz`, the running one packed on the first) and itself, each with its version and store
 *   schema, so `rollback` reinstalls the previous one through the same checks and never crosses a migration silently.
 * - **Automatic rollback only blames an update:** `rollback --crashed` (a supervisor's crash hook) rolls back only a
 *   crash of a release an update installed that never stayed up an hour (`releases/proven.json`), never back and forth.
 * - **An update asked from a page is a durable job** in the store: claimed before the server stops, finished after
 *   the install, settled at the next start if a stop cut it short.
 *
 * A private repository's releases need a GitHub token: `GITHUB_TOKEN`, `GH_TOKEN`, or the GitHub CLI's login.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { array, check, literal, number, object, optional, record, string } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { loadWebConfig } from "./config.ts";
import type { WebConfig } from "./config.ts";
import { Jobs } from "./jobs.ts";
import type { Job, JobEnd } from "./jobs.ts";
import { Log, scoped } from "./log.ts";
import type { Logger } from "./log.ts";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const LOCK_WAIT_MS = 1000;

/** A release that has stayed up this long in one server on a home is proven: a crash loop after it isn't its update's. */
const PROVEN_AFTER_MS = 3_600_000;

/** The results systemd hands an `OnFailure=` unit (`MONITOR_SERVICE_RESULT`) when the service itself died. */
// Not `timeout`: for a simple service that is a stop (or an ExecStartPre) that hung, e.g. an operator's slow stop.
const CRASH_RESULTS = new Set(["exit-code", "signal", "core-dump", "watchdog"]);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** What a release says of itself: its version and the store schema it writes (`<name> version --json`). */
export type ReleaseInfo = { version: string; schema: number };

const releaseInfo = object(
  { version: string({ min: 1, max: 100 }), schema: number({ integer: true, min: 0 }) },
  { strict: true }
);

/** How a release came to be installed: an update, a rollback by hand, or an automatic rollback (`--crashed`). */
type Via = "update" | "rollback" | "crashed";

const installedRecord = object(
  {
    version: string({ min: 1, max: 100 }),
    via: literal("update", "rollback", "crashed"),
    at: string({ min: 1, max: 100 }),
  },
  { strict: true }
);

const provenRecord = object(
  { version: string({ min: 1, max: 100 }), at: string({ min: 1, max: 100 }) },
  { strict: true }
);

const rolledBackRecord = object(
  {
    from: string({ min: 1, max: 100 }),
    to: string({ min: 1, max: 100 }),
    at: string({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/ }),
    reason: string({ min: 1, max: 100 }),
  },
  { strict: true }
);

const manifestSchema = object({ version: string({ min: 1 }), homepage: optional(string()) });

/** A package's `bin`: one entry, or entries by name. */
const binSchema = object({ bin: optional(string()) });
const binsSchema = object({ bin: optional(record(string())) });

export type Installed = { ok: true } | { ok: false; reason: string; tail: string[] };

/** One app's package and the names it goes by. */
type Package = {
  name: string;
  /** The installed package's directory. */
  root: string;
  version: string;
  /** The store's file in a home. */
  store: string;
  env: Readonly<Record<string, string | undefined>>;
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `MY_APP` for `my-app`: an environment variable's prefix. */
const upper = (name: string) => name.toUpperCase().replaceAll("-", "_");

function readManifest(root: string): { version: string; homepage?: string } {
  return manifestSchema.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf-8")));
}

/** The package's entry point for `name`, from its `bin`. */
function entry(root: string, name: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const single = check(binSchema, parsed);

  if (single.ok && single.value.bin !== undefined) {
    return join(root, single.value.bin);
  }

  const bins = check(binsSchema, parsed);
  const bin = bins.ok ? bins.value.bin?.[name] : undefined;

  if (bin === undefined) {
    throw new Error(`${root}/package.json has no bin for ${name}`);
  }

  return join(root, bin);
}

/** A release name: `edge` or a version such as `1.2.0`. */
function parseRelease(text: string): string | undefined {
  const trimmed = text.trim().replace(/^v/, "");

  return trimmed === "edge" || /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(trimmed) ? trimmed : undefined;
}

/** The GitHub repository the package's homepage names, so a fork updates from itself. */
function repository(root: string): string {
  const { homepage } = readManifest(root);
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(homepage ?? "");

  if (match?.[1] === undefined) {
    throw new Error(`package.json homepage is not a GitHub repository: ${String(homepage)}`);
  }

  return match[1];
}

/** A GitHub token, if there is one: the environment's, else the GitHub CLI's. */
async function githubToken(env: Package["env"]): Promise<string | undefined> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;

  if (token !== undefined && token !== "") {
    return token;
  }

  return await new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error === null && stdout.trim() ? stdout.trim() : undefined)
    );
  });
}

async function github(
  env: Package["env"],
  path: string,
  accept = "application/vnd.github+json"
): Promise<Response> {
  const token = await githubToken(env);

  return await fetch(`https://api.github.com${path}`, {
    headers: { accept, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    redirect: "follow",
    signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
  });
}

/** Where a global install under `prefix` puts the package. */
function packageUnder(prefix: string, name: string): string {
  return process.platform === "win32"
    ? join(prefix, "node_modules", name)
    : join(prefix, "lib", "node_modules", name);
}

/** The npm prefix the running package was installed under, so an install replaces it. */
function installPrefix(root: string): string {
  const modules = dirname(root.replace(/[/\\]+$/, ""));

  if (basename(modules) !== "node_modules") {
    throw new Error(`${root} is not a global npm install; update it by hand`);
  }

  const above = dirname(modules);

  return process.platform !== "win32" && basename(above) === "lib" ? dirname(above) : above;
}

type UpdatePlan = { release: string; prefix: string; download: () => Promise<Buffer> };

/** Check an update can run before anything stops: an installed release, and a tarball that exists. */
async function planUpdate(app: Package, release: string): Promise<UpdatePlan> {
  if (existsSync(join(app.root, "tsconfig.build.json"))) {
    throw new Error(
      `${app.name} runs the checkout at ${app.root}; update it there (pull, then build)`
    );
  }

  const prefix = installPrefix(app.root);
  const tag = release === "edge" ? "edge" : `v${release}`;
  const mirror = app.env[`${upper(app.name)}_RELEASES`];

  if (mirror !== undefined && mirror !== "") {
    const url = `${mirror.replace(/\/+$/, "")}/${tag}/${app.name}.tgz`;
    const head = await fetch(url, { method: "HEAD" });

    if (!head.ok) {
      throw new Error(`No release ${release} at ${url} (HTTP ${head.status})`);
    }

    return {
      release,
      prefix,
      download: async () => Buffer.from(await (await fetch(url)).arrayBuffer()),
    };
  }

  const repo = repository(app.root);
  const response = await github(app.env, `/repos/${repo}/releases/tags/${tag}`);

  if (!response.ok) {
    throw new Error(`No release ${release} in ${repo} (GitHub answered ${response.status})`);
  }

  const assets = check(
    object({ assets: optional(array(object({ name: string(), url: string() }))) }),
    await response.json()
  );

  const url = assets.ok
    ? assets.value.assets?.find((each) => each.name === `${app.name}.tgz`)?.url
    : undefined;

  if (url === undefined) {
    throw new TypeError(`Release ${release} has no ${app.name}.tgz`);
  }

  return {
    release,
    prefix,
    download: async () => {
      const file = await github(app.env, new URL(url).pathname, "application/octet-stream");

      if (!file.ok) {
        throw new Error(`The download failed: GitHub answered ${file.status}`);
      }

      return Buffer.from(await file.arrayBuffer());
    },
  };
}

function npm(args: readonly string[], output: (line: string) => void): Promise<Installed> {
  const child =
    process.platform === "win32"
      ? spawn(`npm ${args.map((arg) => `"${arg}"`).join(" ")}`, { shell: true })
      : spawn("npm", args);

  const tail: string[] = [];

  const read = (chunk: Buffer) => {
    for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      output(line);
      tail.push(line);

      if (tail.length > 8) {
        tail.shift();
      }
    }
  };

  child.stdout.on("data", read);
  child.stderr.on("data", read);

  const timer = setTimeout(() => {
    child.kill();
  }, INSTALL_TIMEOUT_MS);

  return new Promise((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "npm could not run", tail: [...tail, error.message] });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, reason: `npm exited ${code ?? 1}`, tail });
    });
  });
}

/** What `version --json` printed; undefined for anything else. */
function releaseFrom(stdout: string): ReleaseInfo | undefined {
  try {
    const parsed = check(releaseInfo, JSON.parse(stdout));

    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/** Ask the package at `root` what it is; undefined for a release from before `version --json`. */
function askRelease(root: string, name: string): Promise<ReleaseInfo | undefined> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry(root, name), "version", "--json"],
      { timeout: CHECK_TIMEOUT_MS, env: { PATH: process.env.PATH } },
      (error, stdout) => {
        resolve(error === null ? releaseFrom(stdout) : undefined);
      }
    );
  });
}

/**
 * Start the package at `root` on a scratch home holding copies of `home`'s store (`vacuum into`, a consistent
 * snapshot, or `store` instead), `config.json` and `web.json` (the web bound to 127.0.0.1 on a free port), with no
 * credentials and none of the environment, until it says it is ready, then stop it. `<name> degraded` is a failure.
 */
async function bootCheck(
  app: Package,
  root: string,
  home: string | undefined,
  store?: string
): Promise<Installed> {
  const scratch = await mkdtemp(join(tmpdir(), `${app.name}-check-`));

  try {
    const source = store ?? (home === undefined ? undefined : join(home, app.store));

    if (source !== undefined && existsSync(source)) {
      const db = new DatabaseSync(source, { readOnly: true });

      try {
        db.prepare("vacuum into ?").run(join(scratch, app.store));
      } finally {
        db.close();
      }
    }

    if (home !== undefined) {
      if (existsSync(join(home, "config.json"))) {
        await copyFile(join(home, "config.json"), join(scratch, "config.json"));
      }

      if (existsSync(join(home, "web.json"))) {
        const raw = await readFile(join(home, "web.json"), "utf-8");
        let web: unknown;

        try {
          web = JSON.parse(raw);
        } catch {
          web = undefined;
        }

        await writeFile(
          join(scratch, "web.json"),
          typeof web === "object" && web !== null && !Array.isArray(web)
            ? JSON.stringify({ ...web, bind: "127.0.0.1", port: 0 })
            : raw,
          { mode: 0o600 }
        );
      }
    }

    const child = spawn(process.execPath, [entry(root, app.name), "serve"], {
      // Nothing of the real home, credentials or providers reaches the check.
      env: { PATH: process.env.PATH, HOME: scratch, [`${upper(app.name)}_HOME`]: scratch },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });

    let output = "";

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);

      const settle = (value: boolean) => {
        clearTimeout(timer);
        resolve(value);
      };

      const read = (chunk: Buffer) => {
        output += chunk.toString("utf-8");

        if (output.includes(`${app.name} ready`)) {
          settle(true);
        } else if (output.includes(`${app.name} degraded`)) {
          settle(false);
        }
      };

      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", (error) => {
        output += `\n${error.message}`;
        settle(false);
      });
      void closed.then(() => settle(false));
    });

    child.kill();
    let grace: ReturnType<typeof setTimeout> | undefined;

    const gone = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        grace = setTimeout(() => {
          resolve(false);
        }, 15_000);
      }),
    ]);

    clearTimeout(grace);

    if (!gone) {
      child.kill("SIGKILL");
    }

    if (ready) {
      return { ok: true };
    }

    return {
      ok: false,
      reason: output.includes(`${app.name} degraded`)
        ? "the new release can't serve this home's web.json"
        : "the new release did not start",
      tail: output
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "" && !/^\s+at /.test(line))
        .slice(-8),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Sync a directory, so the renames in it are on the disk. */
function syncDirectory(path: string): void {
  const dir = openSync(path, "r");

  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Write a small record whole and on the disk (a temporary file, synced, renamed over, the directory synced). */
function writeRecord(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const bytes = Buffer.from(JSON.stringify(value), "utf-8");
  const fd = openSync(temporary, "w", 0o600);

  try {
    for (let at = 0; at < bytes.length;) {
      at += writeSync(fd, bytes, at, bytes.length - at);
    }

    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

/** A record as its schema reads it; undefined when missing or unreadable. */
function readRecord<T>(path: string, schema: Schema<T>): T | undefined {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return undefined;
  }
}

/**
 * Record how the new release came to be installed (`installed.json`) and keep it as current. Any install but an
 * automatic rollback ends the record of the last one. Never fails an install: the previous release is already kept.
 */
async function keep(
  home: string,
  tarball: string,
  incoming: ReleaseInfo | undefined,
  via: Via,
  output: (line: string) => void
): Promise<void> {
  const releases = join(home, "releases");

  try {
    // First, as the crash rollback's guards read it: a release put back by hand is never rolled back "forward".
    if (incoming === undefined) {
      rmSync(join(releases, "installed.json"), { force: true });
    } else {
      writeRecord(join(releases, "installed.json"), {
        version: incoming.version,
        via,
        at: new Date().toISOString(),
      });
    }

    if (via !== "crashed") {
      rmSync(join(releases, "rolled-back.json"), { force: true });
    }
  } catch (error) {
    output(`couldn't record how the release was installed: ${reason(error)}`);
  }

  try {
    await copyFile(tarball, join(releases, "current.tgz.tmp"));
    await rename(join(releases, "current.tgz.tmp"), join(releases, "current.tgz"));

    if (incoming === undefined) {
      await rm(join(releases, "current.json"), { force: true });
    } else {
      writeRecord(join(releases, "current.json"), incoming);
    }
  } catch (error) {
    output(`couldn't keep the new release as current: ${reason(error)}`);
  }
}

/** Copy a file whole and on the disk: a temporary copy, synced, renamed over. */
async function copyDurably(from: string, to: string): Promise<void> {
  await copyFile(from, `${to}.tmp`);
  const fd = openSync(`${to}.tmp`, "r+");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(`${to}.tmp`, to);
}

/**
 * Keep the release about to be replaced as `releases/previous.*`, on the disk, before anything replaces it: staged as
 * `previous.next.*`, then moved over the old previous once the new release is installed. Throws if it can't be kept.
 */
async function stagePrevious(home: string, outgoing: { tarball: string; info: ReleaseInfo }) {
  const releases = join(home, "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await copyDurably(outgoing.tarball, join(releases, "previous.next.tgz"));
  writeRecord(join(releases, "previous.next.json"), outgoing.info);
}

/** The staged previous release takes the old one's place (the tarball and what it is, each renamed whole). */
function promotePrevious(home: string): void {
  const releases = join(home, "releases");
  renameSync(join(releases, "previous.next.tgz"), join(releases, "previous.tgz"));
  renameSync(join(releases, "previous.next.json"), join(releases, "previous.json"));
  syncDirectory(releases);
}

/** A staged previous release whose install didn't happen: the old one stays. */
function dropStaged(home: string): void {
  for (const file of ["previous.next.tgz", "previous.next.json", "previous.next.tgz.tmp"]) {
    rmSync(join(home, "releases", file), { force: true });
  }
}

/**
 * The release about to be replaced, for `releases/previous.*`: the one the last install kept as current, else the
 * running package packed from where it is installed. Undefined if neither can be had.
 */
async function replaced(
  app: Package,
  schema: number,
  home: string,
  scratch: string,
  output: (line: string) => void
): Promise<{ tarball: string; info: ReleaseInfo } | undefined> {
  const releases = join(home, "releases");
  const current = join(releases, "current.tgz");

  try {
    const info = readRecord(join(releases, "current.json"), releaseInfo);

    if (existsSync(current) && info !== undefined && info.version === app.version) {
      return { tarball: current, info };
    }

    const packed = join(scratch, "running");
    await mkdir(packed);
    const done = await npm(["pack", app.root, "--pack-destination", packed], () => undefined);

    if (!done.ok) {
      throw new Error(done.reason);
    }

    const file = (await readdir(packed)).find((name) => name.endsWith(".tgz"));

    if (file === undefined) {
      throw new Error("npm pack made no tarball");
    }

    return { tarball: join(packed, file), info: { version: app.version, schema } };
  } catch (error) {
    output(`couldn't keep the running release for a rollback: ${reason(error)}`);

    return undefined;
  }
}

/**
 * Install a planned release: aside first, started there on copies of `home`'s store and settings (or `store`), only
 * then over the running one; the release it replaces and itself are kept for a rollback.
 */
async function install(
  app: Package,
  schema: number,
  plan: UpdatePlan,
  output: (line: string) => void,
  home: string | undefined,
  options: { store?: string; via?: Via; beforeReplace?: () => void } = {}
): Promise<Installed> {
  const scratch = await mkdtemp(join(tmpdir(), `${app.name}-update-`));

  try {
    const tarball = join(scratch, `${app.name}.tgz`);

    try {
      await writeFile(tarball, await plan.download());
    } catch (error) {
      return { ok: false, reason: "the download failed", tail: [reason(error)] };
    }

    const flags = ["install", "-g", "--no-audit", "--no-fund", "--prefix"];
    const stage = join(scratch, "stage");
    output("installing it aside first, to check it starts");
    const staged = await npm([...flags, stage, tarball], output);

    if (!staged.ok) {
      return staged;
    }

    const checked = await bootCheck(app, packageUnder(stage, app.name), home, options.store);

    if (!checked.ok) {
      return checked;
    }

    const incoming = await askRelease(packageUnder(stage, app.name), app.name);

    if (home !== undefined) {
      // A rollback must stay possible: the running release is kept before anything replaces it, or nothing does.
      const outgoing = await replaced(app, schema, home, scratch, output);

      if (outgoing === undefined) {
        return {
          ok: false,
          reason: "the running release couldn't be kept for a rollback",
          tail: [],
        };
      }

      try {
        await stagePrevious(home, outgoing);
      } catch (error) {
        dropStaged(home);

        return {
          ok: false,
          reason: `the running release couldn't be kept for a rollback: ${reason(error)}`,
          tail: [],
        };
      }
    }

    try {
      options.beforeReplace?.();
    } catch (error) {
      if (home !== undefined) {
        dropStaged(home);
      }

      return { ok: false, reason: `the store couldn't be put back: ${reason(error)}`, tail: [] };
    }

    output("it starts; installing it");
    const installed = await npm([...flags, plan.prefix, tarball], output);

    if (home !== undefined) {
      if (installed.ok) {
        promotePrevious(home);
        await keep(home, tarball, incoming, options.via ?? "update", output);
      } else {
        dropStaged(home);
      }
    }

    return installed;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The store's schema now (`user_version`), or 0 with no store. */
function storeSchema(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }

  const db = new DatabaseSync(path, { readOnly: true });

  try {
    return Number(db.prepare("pragma user_version").get()?.user_version ?? 0);
  } finally {
    db.close();
  }
}

/** The release kept before the current one, and what it is (when it was kept with its `.json`). */
type Kept = { tarball: string; info: ReleaseInfo | undefined };

function keptPrevious(home: string): Kept {
  const tarball = join(home, "releases", "previous.tgz");

  if (!existsSync(tarball)) {
    throw new Error(
      "no earlier release is kept yet: each update from this version on keeps the one it replaces"
    );
  }

  return { tarball, info: readRecord(join(home, "releases", "previous.json"), releaseInfo) };
}

/** A plan that reinstalls the release kept before the current one. */
function rollbackPlan(app: Package, home: string): UpdatePlan {
  const { tarball } = keptPrevious(home);

  if (existsSync(join(app.root, "tsconfig.build.json"))) {
    throw new Error(`${app.name} runs the checkout at ${app.root}; roll it back there`);
  }

  return {
    release: "previous",
    prefix: installPrefix(app.root),
    download: () => readFile(tarball),
  };
}

/** Mark `version` proven on `home`: the server calls it once it has stayed up long enough. */
function markProven(home: string, version: string): void {
  writeRecord(join(home, "releases", "proven.json"), { version, at: new Date().toISOString() });
}

/** The automatic rollback that put `version` in place, if it is the one running: what it replaced and when. */
export function rolledBackTo(home: string, version: string): { from: string; at: string } | null {
  const found = readRecord(join(home, "releases", "rolled-back.json"), rolledBackRecord);

  return found !== undefined && found.to === version ? { from: found.from, at: found.at } : null;
}

/** Whether a server holds the home's lock, without creating the lock file. */
export function running(home: string): boolean {
  const path = join(home, "owner.sqlite");

  if (!existsSync(path)) {
    return false;
  }

  const owner = new DatabaseSync(path);

  try {
    owner.exec("BEGIN EXCLUSIVE");
    owner.exec("ROLLBACK");

    return false;
  } catch {
    return true;
  } finally {
    owner.close();
  }
}

/**
 * Take the home's lock (`owner.sqlite`, an exclusive transaction the OS releases if this process dies): undefined when
 * a server, or another update or rollback, holds it. Held, no server starts on the home while a release is replaced.
 */
function lock(home: string): DatabaseSync | undefined {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // A probe's look at the lock (`running`) holds it for an instant: waited out, never taken for a server.
  const owner = new DatabaseSync(join(home, "owner.sqlite"), { timeout: LOCK_WAIT_MS });

  try {
    owner.exec("BEGIN EXCLUSIVE");

    return owner;
  } catch {
    owner.close();

    return undefined;
  }
}

/** A store put back: the live one kept whole aside, the copy from before the migration (used up) in its place. */
type Swap = { path: string; aside: string; copy: string };

/**
 * Put `copy` in place of the live store, which is kept whole (its WAL folded in) as `<store>.rolled-back-<time>`. It
 * starts a new dataset: every page starts its copy over and no tap made since runs here. A failure puts back what moved.
 */
function swapStore(path: string, copy: string): Swap {
  const restoring = `${path}.restoring`;
  const aside = `${path}.rolled-back-${new Date().toISOString().replaceAll(":", "-")}`;

  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${restoring}${suffix}`, { force: true });
  }

  copyFileSync(copy, restoring);
  let moved = false;

  try {
    const restored = new DatabaseSync(restoring);

    try {
      restored
        .prepare("update meta set value = ? where key = 'dataset'")
        .run(randomBytes(12).toString("hex"));
    } finally {
      restored.close();
    }

    const live = new DatabaseSync(path);

    try {
      live.exec("pragma wal_checkpoint(truncate)");
    } finally {
      live.close();
    }

    renameSync(path, aside);
    moved = true;

    for (const suffix of ["-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }

    renameSync(restoring, path);
  } catch (error) {
    if (moved && !existsSync(path)) {
      renameSync(aside, path);
    }

    rmSync(restoring, { force: true });
    throw error;
  }

  syncDirectory(dirname(path));

  return { path, aside, copy };
}

/** Undo `swapStore` when the release it was for didn't install: the live store back, untouched; the copy is kept. */
function unswapStore(swap: Swap): void {
  rmSync(swap.path);

  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${swap.path}${suffix}`, { force: true });
  }

  renameSync(swap.aside, swap.path);
  syncDirectory(dirname(swap.path));
}

/**
 * Reinstall the kept release through `install` (its boot check on copies). With `copy` (crossing a migration) the
 * store is put back once that release passed its check and before it replaces the running one, and put back as it was
 * if the install then fails: whatever happens, the installed release and the store fit each other.
 */
async function reinstallPrevious(
  app: Package,
  schema: number,
  home: string,
  plan: UpdatePlan,
  copy: string | undefined,
  via: Via,
  output: (line: string) => void
): Promise<Installed> {
  let swap: Swap | undefined;
  let installed: Installed;

  try {
    installed = await install(app, schema, plan, output, home, {
      via,
      ...(copy === undefined
        ? {}
        : {
            store: copy,
            beforeReplace: () => {
              swap = swapStore(join(home, app.store), copy);
            },
          }),
    });
  } catch (error) {
    installed = { ok: false, reason: reason(error), tail: [] };
  }

  if (swap === undefined) {
    return installed;
  }

  if (!installed.ok) {
    unswapStore(swap);

    return installed;
  }

  // Used up: the next crossing of that migration keeps a fresh copy, so this older one never comes back again.
  try {
    rmSync(swap.copy, { force: true });
  } catch (error) {
    console.log(
      `couldn't remove ${basename(swap.copy)} after restoring it (remove it by hand): ${reason(error)}`
    );
  }

  console.log(
    `store restored from ${basename(swap.copy)}; the one it replaced is ${basename(swap.aside)}`
  );

  return installed;
}

/**
 * `rollback --crashed`, run by a supervisor once the server keeps crashing (systemd: `OnFailure=` with
 * `RestartMode=direct`, which hands it `MONITOR_SERVICE_RESULT`). It rolls back only what an update can be blamed for.
 * Exit 0 rolled back, 3 declined, 1 failed; anything but 0 leaves the installed release and the store as they were.
 */
async function runCrashed(app: Package, schema: number, home: string): Promise<number> {
  const log = new Log(home, app.name, { echo: false });
  const say = scoped(log, "rollback");

  // Every decision is one line on stdout (the supervisor's journal) and one in the home's log, with its reason.
  const end = async (code: number, line: string, attributes: Record<string, string> = {}) => {
    console.log(line);
    say(code === 0 ? "warn" : code === 1 ? "error" : "info", line, attributes);
    await log.flushed();

    return code;
  };

  const decline = (why: string) => end(3, `no automatic rollback: ${why}`);

  // The live server first: whatever the supervisor says, a running server is never rolled back under itself; and held,
  // none starts while the release is replaced.
  const owner = lock(home);

  if (owner === undefined) {
    return await end(1, `no automatic rollback: a server is running on ${home}`);
  }

  try {
    const result = app.env.MONITOR_SERVICE_RESULT;

    // Only the supervisor's word that the service itself died: a stop that hung, or no word at all, isn't a crash.
    if (result === undefined || !CRASH_RESULTS.has(result)) {
      return await decline(`not a crash: ${result ?? "no MONITOR_SERVICE_RESULT"}`);
    }

    const releases = join(home, "releases");

    if (!existsSync(join(releases, "previous.tgz"))) {
      return await decline("no earlier release is kept");
    }

    if (readRecord(join(releases, "proven.json"), provenRecord)?.version === app.version) {
      return await decline(
        `${app.version} is proven: it stayed up an hour here, so this isn't its update's doing`
      );
    }

    if (rolledBackTo(home, app.version) !== null) {
      return await decline(
        `${app.version} is itself the target of an automatic rollback: never back and forth`
      );
    }

    const installedBy = readRecord(join(releases, "installed.json"), installedRecord);

    if (installedBy?.version !== app.version || installedBy.via !== "update") {
      return await decline(
        `${app.version} wasn't installed by an update (${installedBy?.version === app.version ? `but by a ${installedBy.via}` : "no record of it"}): a crash rollback only goes back past an update`
      );
    }

    const target = readRecord(join(releases, "previous.json"), releaseInfo);

    if (target === undefined) {
      return await decline(
        "the previous release's metadata (releases/previous.json) is missing or unreadable"
      );
    }

    if (target.version === app.version) {
      return await decline(`the kept release is ${app.version} itself`);
    }

    const path = join(home, app.store);
    const crossing = target.schema < storeSchema(path);
    const copy = `${path}.schema-${target.schema}.bak`;

    if (crossing && !existsSync(copy)) {
      return await decline(
        `${target.version} writes store schema ${target.schema} and no ${basename(copy)} is kept`
      );
    }

    let plan: UpdatePlan;

    try {
      plan = rollbackPlan(app, home);
    } catch (error) {
      return await end(1, reason(error));
    }

    const marker = join(releases, "rolled-back.json");
    // Recorded before anything is replaced: whichever release ends up installed, the record says only what it is for.
    writeRecord(marker, {
      from: app.version,
      to: target.version,
      at: new Date().toISOString(),
      reason: result,
    });
    let installed: Installed;

    try {
      installed = await reinstallPrevious(
        app,
        schema,
        home,
        plan,
        crossing ? copy : undefined,
        "crashed",
        // Its progress goes to the log: the supervisor's journal gets the decision alone.
        (line) => say("info", line)
      );
    } catch (error) {
      // Only undoing a store swap after a failed install throws: the record stands, the log says what is left.
      return await end(
        1,
        `automatic rollback failed and the store couldn't be put back as it was: ${reason(error)}`
      );
    }

    if (!installed.ok) {
      rmSync(marker, { force: true });

      return await end(
        1,
        `automatic rollback failed: ${installed.reason}; the installed version is unchanged`,
        { tail: installed.tail.join("\n") }
      );
    }

    return await end(0, `rolled back automatically · ${app.version} → ${target.version}`, {
      from: app.version,
      to: target.version,
      reason: result,
      ...(crossing ? { store: basename(copy) } : {}),
    });
  } finally {
    owner.close();
  }
}

/** `update [edge | <version>]`: with the server stopped, replace the installed package with a release. */
async function runUpdate(
  app: Package,
  schema: number,
  args: readonly string[],
  home: string
): Promise<number> {
  const [text = "edge", ...rest] = args;
  const release = parseRelease(text);

  if (rest.length > 0 || release === undefined) {
    console.error(`Usage: ${app.name} update [edge | <version>]`);

    return 2;
  }

  // Held throughout: no server starts on the home while its release is replaced.
  const owner = lock(home);

  if (owner === undefined) {
    console.error(`A server runs on ${home}: use the page's update button, or stop it first.`);

    return 1;
  }

  try {
    const plan = await planUpdate(app, release);
    console.log(`Installing ${release} into ${plan.prefix}`);
    const installed = await install(app, schema, plan, (line) => console.log(line), home);

    if (!installed.ok) {
      console.error(`Update failed: ${installed.reason}; the installed version is unchanged.`);

      for (const line of installed.tail) {
        console.error(line);
      }

      return 1;
    }
  } catch (error) {
    console.error(reason(error));

    return 1;
  } finally {
    owner.close();
  }

  console.log(`updated · ${app.version} → ${readManifest(app.root).version}`);

  return 0;
}

/**
 * `rollback [--with-store | --crashed]`: with the server stopped, reinstall the release kept before the current one. A
 * release that writes an older store schema than the store has can't open it: refused, saying which copy of the store
 * from before the migration would come back. `--with-store` puts that copy in place too.
 */
async function runRollback(
  app: Package,
  schema: number,
  args: readonly string[],
  home: string
): Promise<number> {
  const [flag, ...rest] = args;

  if (rest.length > 0 || (flag !== undefined && flag !== "--with-store" && flag !== "--crashed")) {
    console.error(`Usage: ${app.name} rollback [--with-store | --crashed]`);

    return 2;
  }

  if (flag === "--crashed") {
    return await runCrashed(app, schema, home).catch((error: unknown) => {
      console.error(`automatic rollback failed: ${reason(error)}`);

      return 1;
    });
  }

  // Held throughout: no server starts on the home while its release is replaced.
  const owner = lock(home);

  if (owner === undefined) {
    console.error(`A server runs on ${home}: stop it first.`);

    return 1;
  }

  try {
    // Whether it can open this store comes first: a refusal changes nothing, wherever the app runs from.
    const kept = keptPrevious(home);
    const path = join(home, app.store);
    const now = storeSchema(path);
    const target = kept.info?.schema;
    const crossing = target === undefined || target < now;
    const copy = target === undefined ? undefined : `${path}.schema-${target}.bak`;

    if (crossing && flag !== "--with-store") {
      const what =
        target === undefined
          ? "the kept release doesn't say which store schema it writes"
          : `it writes store schema ${target} and the store is at ${now}`;

      const back =
        copy !== undefined && existsSync(copy)
          ? `\n\`${app.name} rollback --with-store\` puts back ${basename(copy)} (from ${statSync(copy).mtime.toISOString()}), the store from before that migration: everything since is set aside.`
          : `\nNo copy of the store from before that migration is kept here (${app.store}.schema-<n>.bak), so --with-store can't help.`;

      console.error(`Rollback refused: ${what}.${back}`);

      return 1;
    }

    if (crossing && (copy === undefined || !existsSync(copy))) {
      console.error(
        `Rollback refused: no ${copy === undefined ? `${app.store}.schema-<n>.bak` : basename(copy)} to restore with it.`
      );

      return 1;
    }

    const plan = rollbackPlan(app, home);
    console.log(`Reinstalling the previous release into ${plan.prefix}`);

    const installed = await reinstallPrevious(
      app,
      schema,
      home,
      plan,
      crossing ? copy : undefined,
      "rollback",
      (line) => console.log(line)
    );

    if (!installed.ok) {
      console.error(`Rollback failed: ${installed.reason}; the installed version is unchanged.`);

      for (const line of installed.tail) {
        console.error(line);
      }

      return 1;
    }
  } catch (error) {
    console.error(reason(error));

    return 1;
  } finally {
    owner.close();
  }

  console.log(`rolled back · ${app.version} → ${readManifest(app.root).version}`);

  return 0;
}

// The update job, asked from a page.

/** What an update job leaves when done: the release it installed and the version it replaced. */
export type UpdateResult = { release?: string; from?: string };

/** How one update job ended, as a server reports it. */
export type UpdateRecord = {
  job: number;
  release: string;
  from: string;
  result: "installed" | "failed";
  reason: string | null;
  at: string;
};

/** An update job (`slopkit/server/jobs`, kind `update`): one open at a time; every tap while it is open joins it. */
export const UPDATE_KIND = "update";
const UPDATE_KEY = "install";

/** An update still open this long after it was asked is overdue. */
const UPDATE_DEADLINE_MS = 15 * 60_000;
const NOTE = /^(?:update to|installing) (\S+) from (\S+)$/;

/** The release and the version it replaces, from an update job's result or note. */
type Noted = { release: string; from: string };

function noted(job: Job<UpdateResult>): Noted {
  const match = NOTE.exec(job.note ?? "");

  return {
    release: job.result?.release ?? match?.[1] ?? "edge",
    from: job.result?.from ?? match?.[2] ?? "unknown",
  };
}

/** An update job asked for, and whether it is still due to run. */
export type AskedUpdate = { id: number; due: boolean };

/** Ask for an update to `release` from `version` (joins one already open): the job's id, and whether still due. */
export function askUpdate(
  jobs: Jobs<UpdateResult>,
  release: string,
  version: string,
  by: { client: string; id: number },
  now: number = Date.now()
): AskedUpdate {
  const asked = jobs.ask(UPDATE_KIND, UPDATE_KEY, {
    deadlineAt: now + UPDATE_DEADLINE_MS,
    by,
    note: `update to ${release} from ${version}`,
  });

  return { id: asked.id, due: jobs.get(asked.id)?.state === "due" };
}

/** Claim the asked update before the server stops: running, "installing <release> from <version>", committed. */
export function beginUpdate(
  jobs: Jobs<UpdateResult>,
  version: string
): { id: number; release: string; from: string } | undefined {
  const due = jobs.open(UPDATE_KIND).find((job) => job.state === "due");

  if (due === undefined) {
    return undefined;
  }

  const { release } = noted(due);
  const started = jobs.start(due.id, `installing ${release} from ${version}`);

  return started === undefined ? undefined : { id: started.id, release, from: version };
}

/**
 * At start, before serving: how an update job a stop left running is settled. The install began: installed when this
 * is another version than the one it replaced (the reconciliation read), else failed as interrupted.
 */
export function recoverUpdate(job: Job<UpdateResult>, version: string): JobEnd<UpdateResult> {
  const { release, from } = noted(job);

  return from === version
    ? {
        failed: { who: "us", reason: "interrupted: the server stopped before the update finished" },
      }
    : { done: { release, from } };
}

/** At start, after running jobs are settled: an update still due failed, nothing changed. Returns how many. */
export function settleAskedUpdates(jobs: Jobs<UpdateResult>): number {
  let due = 0;

  for (const job of jobs.open(UPDATE_KIND)) {
    if (job.state === "due") {
      jobs.finish(job.id, {
        failed: {
          who: "us",
          reason: "the server restarted before the update began; nothing changed",
        },
      });
      due++;
    }
  }

  return due;
}

/** The newest `kept` finished updates, newest first. */
export function updateRecords(jobs: Jobs<UpdateResult>, kept: number): UpdateRecord[] {
  return jobs.finished(UPDATE_KIND, kept).map((job) => {
    const { release, from } = noted(job);

    return {
      job: job.id,
      release,
      from,
      result: job.state === "done" ? "installed" : "failed",
      reason: job.state === "done" ? null : (job.reason ?? "no reason given").slice(0, 2000),
      at: job.updatedAt,
    };
  });
}

/** The open update job's id, if one is asked or installing. */
export function updating(jobs: Jobs<UpdateResult>): number | null {
  return jobs.open(UPDATE_KIND)[0]?.id ?? null;
}

const updateResult = object({ release: optional(string()), from: optional(string()) });

/**
 * Record how the claimed update `id` ended, in the home's store, after the install and before the server starts again
 * (the server is stopped; its store is closed). A job already settled is left as it is.
 */
function finishUpdate(
  path: string,
  id: number,
  end: { installed: true } | { failed: string }
): void {
  const db = new DatabaseSync(path);

  try {
    const jobs = new Jobs<UpdateResult>({
      db,
      transaction: (body) => {
        db.exec("begin immediate");

        try {
          const result = body();
          db.exec("commit");

          return result;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      },
      encode: (value) => JSON.stringify(value),
      decode: (text) => updateResult.parse(JSON.parse(text)),
    });

    const job = jobs.get(id);

    if (job === undefined || (job.state !== "due" && job.state !== "running")) {
      return;
    }

    jobs.finish(
      id,
      "installed" in end
        ? { done: noted(job) }
        : { failed: { who: "us", reason: end.failed.slice(0, 2000) } }
    );
  } finally {
    db.close();
  }
}

/** The newer `edge` commit when this is an edge build behind it; a hint only, nothing installs it. */
export async function newerEdge(
  root: URL | string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<string | undefined> {
  const directory = typeof root === "string" ? root : fileURLToPath(root);
  const installed = /-edge\.\d+\.g([0-9a-f]+)$/.exec(readManifest(directory).version)?.[1];

  if (installed === undefined) {
    return undefined;
  }

  const response = await github(env, `/repos/${repository(directory)}/git/ref/tags/edge`);

  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the edge tag`);
  }

  const body = check(object({ object: object({ sha: string() }) }), await response.json());

  if (!body.ok) {
    throw new TypeError("GitHub's edge tag has no commit");
  }

  const { sha } = body.value.object;

  return sha.startsWith(installed) ? undefined : sha.slice(0, installed.length);
}

// The command line.

/** What an app's `serve` gets: its home, what it is, the log, the web settings, and a way to ask for an update. */
export type ServeContext = {
  home: string;
  version: string;
  log: Log;
  /** The server's own log lines (`server`). */
  say: Logger;
  /** `web.json`, or why the web is off. */
  web: WebConfig | { off: string };
  env: Readonly<Record<string, string | undefined>>;
  /** Stop the server for the update the app's store has asked (`askUpdate`), then start the same command again. */
  update: () => void;
};

/** What an app's `serve` hands back once it serves. */
export type Served = {
  /** Its web server's address, when it has one. */
  url?: string;
  close: () => Promise<void>;
  /** The asked update job, claimed running before anything stops (`beginUpdate`). */
  claim?: () => { id: number; release: string } | undefined;
};

export type CliOptions = {
  /** The binary's name: `<NAME>_HOME`, `~/.<name>`, `<name>.sqlite`, `<name>.tgz`. */
  name: string;
  /** The installed package's directory (`new URL("../", import.meta.url)`). */
  root: URL | string;
  /** The store schema this release writes (`schemaVersion`). */
  schema: number;
  /** What `serve` does, for the help: "<name> serve: Run the server on the home: <serves>". */
  serves: string;
  serve: (context: ServeContext) => Promise<Served>;
  /** The app's own commands, beside the kit's. */
  commands?: Record<
    string,
    { usage: string; help: string; run: (args: string[], home: string) => Promise<number> }
  >;
  env?: Readonly<Record<string, string | undefined>>;
  /** How long a server stays up before its release is proven here (default an hour). */
  provenAfterMs?: number;
};

/** Replace this process with the same command, after an update installed a new release; never returns. */
function reexecute(): Promise<never> {
  const argv = [...process.execArgv, ...process.argv.slice(1)];

  // The same pid, so a supervisor (systemd) sees one service throughout.
  if (process.platform !== "win32" && process.execve !== undefined) {
    process.execve(process.execPath, [process.execPath, ...argv]);
  }

  return new Promise<never>((_resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => process.exit(code ?? 1));
  });
}

async function serve(app: Package, options: CliOptions, home: string): Promise<number> {
  const owner = lock(home);

  if (owner === undefined) {
    console.error(`Another ${app.name} server runs on ${home}`);

    return 1;
  }

  // A record a killed run left behind says nothing of this one.
  rmSync(join(home, "serving.json"), { force: true });

  const log = new Log(home, app.name);
  const say = scoped(log, "server");
  const warnings: string[] = [];
  const web = await loadWebConfig(home, warnings);

  for (const warning of warnings) {
    say("warn", warning);
  }

  // A home with a web.json is served through it: without the web it is degraded, never ready.
  const degraded = "off" in web && existsSync(join(home, "web.json")) ? web.off : undefined;

  if ("off" in web) {
    say("warn", `web off: ${web.off}`);
  }

  // Listening for a stop before anything starts: a signal sent the moment the ready line is out is a stop, never a kill.
  let stop: ((why: { reason: string; update: boolean }) => void) | undefined;

  const stopped = new Promise<{ reason: string; update: boolean }>((resolve) => {
    stop = resolve;

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => resolve({ reason: signal, update: false }));
    }
  });

  const served = await options.serve({
    home,
    version: app.version,
    log,
    say,
    web,
    env: app.env,
    update: () => stop?.({ reason: "update", update: true }),
  });

  say("info", "started", { pid: process.pid, version: app.version, web: served.url ?? null });
  const serving = join(home, "serving.json");
  // The start is in the log before anything says it serves, so a probe right after ready finds the home at rest.
  await log.flushed();

  // Before the ready line, so whatever waits for it can probe at once.
  try {
    writeRecord(serving, {
      version: app.version,
      pid: process.pid,
      ...(served.url === undefined ? {} : { url: served.url }),
      at: new Date().toISOString(),
    });
  } catch (error) {
    say("warn", "couldn't record that it serves", { reason: reason(error) });
  }

  // The update check and a supervisor's readiness both wait for this line.
  console.log(
    degraded === undefined
      ? `${app.name} ready${served.url === undefined ? "" : ` · ${served.url}`}`
      : `${app.name} degraded: web off: ${degraded}`
  );

  // Up this long without a crash: a crash loop from here on isn't this version's update (`rollback --crashed`).
  const proving = setTimeout(() => {
    try {
      markProven(home, app.version);
      say("info", "this version is proven here", { version: app.version });
    } catch (error) {
      say("warn", "couldn't mark this version proven", { reason: reason(error) });
    }
  }, options.provenAfterMs ?? PROVEN_AFTER_MS);

  proving.unref();
  // The server runs until it is told to stop, even with the web off and nothing scheduled.
  const alive = setInterval(() => undefined, 2 ** 30);

  const { reason: why, update } = await stopped;

  clearInterval(alive);
  clearTimeout(proving);
  // The update is claimed (running, in the store) before anything stops: a stop from here on is settled at the next
  // start, by the version that starts.
  const job = update ? served.claim?.() : undefined;
  say("info", "stopping", {
    reason: why,
    ...(job === undefined ? {} : { job: job.id }),
  });
  await served.close();
  rmSync(serving, { force: true });

  if (job === undefined) {
    owner.close();
    await log.flushed();

    return update ? await reexecute() : 0;
  }

  // The server is closed, so npm may replace its files; whatever happens, the same command starts again, and how the
  // job ended waits for it in the store, so every page that asked hears it.
  let failed: string | null;

  try {
    const installed = await install(
      app,
      options.schema,
      await planUpdate(app, job.release),
      (line) => say("info", line),
      home
    );

    failed = installed.ok ? null : installed.reason;
    say(
      installed.ok ? "info" : "warn",
      installed.ok ? "update installed" : `update failed: ${installed.reason}`,
      { job: job.id, tail: installed.ok ? null : installed.tail.join("\n") }
    );
  } catch (error) {
    failed = reason(error);
    say("warn", `update failed: ${failed}`, { job: job.id });
  }

  try {
    finishUpdate(join(home, app.store), job.id, failed === null ? { installed: true } : { failed });
  } catch (error) {
    // Left running: the next start settles it from the version it runs.
    say("warn", "couldn't record how the update ended", { job: job.id, reason: reason(error) });
  }

  // The lock is held until the release and how the job ended are both in place.
  owner.close();
  await log.flushed();

  return await reexecute();
}

// The live server, checked from its host.

/** What a running server says of itself (`<home>/serving.json`), written before its ready line, removed at its stop. */
const servingRecord = object(
  {
    version: string({ min: 1, max: 100 }),
    pid: number({ integer: true, min: 1 }),
    url: optional(string({ min: 1, max: 2000 })),
    at: string({ min: 1, max: 100 }),
  },
  { strict: true }
);

type Serving = { version: string; pid: number; url?: string; at: string };

type ProbeFlags = { expect?: string; door?: string };

const PROBE_TIMEOUT_MS = 10_000;

/** A system error's code (`ECONNREFUSED`), else its message. */
function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return reason(error);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // Alive, but another user's: the signal was refused, not undeliverable.
    return errorCode(error) === "EPERM";
  }
}

/** Only the kit's stand-in login lives on this machine; a live server's issuer never does. */
function onThisMachine(url: string): boolean {
  const host = new URL(url).hostname;

  return host === "localhost" || host === "[::1]" || host.startsWith("127.");
}

/** An answer: its status, where it redirects, and whether it is the kit's own refusal of a request with no identity. */
type Answer = { status: number; location: string | null; kit: boolean } | { error: string };

/** The most of a body read to tell the kit's refusal (`{"kind":"signed-out",…}`) from another's. */
const REFUSAL_BYTES = 4096;

const refusal = object({ kind: literal("signed-out") });

function kitRefusal(status: number, body: string): boolean {
  if (status !== 401) {
    return false;
  }

  try {
    return refusal.parse(JSON.parse(body)).kind === "signed-out";
  } catch {
    return false;
  }
}

/** A GET with no identity, sent to `url` under this `Host`: how it was answered. */
function anonymous(url: string, host: string): Promise<Answer> {
  return new Promise((resolve) => {
    const sent = httpRequest(
      url,
      { headers: { host, accept: "application/json" }, timeout: PROBE_TIMEOUT_MS },
      (response) => {
        let body = "";

        response.setEncoding("utf-8");
        response.on("data", (chunk: string) => {
          body = (body + chunk).slice(0, REFUSAL_BYTES);
        });
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            status,
            location: response.headers.location ?? null,
            kit: kitRefusal(status, body),
          });
        });
      }
    );

    sent.once("timeout", () => {
      sent.destroy(new Error("no answer in time"));
    });
    sent.once("error", (error) => {
      resolve({ error: errorCode(error) });
    });
    sent.end();
  });
}

/** How the door at `url` answers a request with no identity, redirects not followed. */
async function knock(url: string): Promise<Answer> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    let body = "";

    if (response.status === 401) {
      body = (await response.text()).slice(0, REFUSAL_BYTES);
    } else {
      await response.body?.cancel();
    }

    return {
      status: response.status,
      location: response.headers.get("location"),
      kit: kitRefusal(response.status, body),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.cause !== undefined
          ? errorCode(error.cause)
          : reason(error),
    };
  }
}

const ACCESS_LOGIN = "/cdn-cgi/access/login/";

/** The proxy's login a redirect goes to, if it is one. */
function proxyLogin(answer: Answer): URL | undefined {
  if (
    "error" in answer ||
    (answer.status !== 302 && answer.status !== 303) ||
    answer.location === null
  ) {
    return undefined;
  }

  const location = URL.canParse(answer.location) ? new URL(answer.location) : undefined;

  return location?.pathname.startsWith(ACCESS_LOGIN) === true ? location : undefined;
}

function servingProblem(
  home: string,
  found: Serving | undefined,
  held: boolean
): string | undefined {
  if (!held) {
    return found === undefined
      ? `nothing runs on ${home}`
      : `nothing runs on ${home} (serving.json is left from pid ${found.pid})`;
  }

  if (found === undefined) {
    return `${home} is held, but no server says it serves (an update or a rollback holds it)`;
  }

  return pidAlive(found.pid)
    ? undefined
    : `serving.json names pid ${found.pid}, which isn't running`;
}

function versionProblem(
  live: Serving | undefined,
  installed: string,
  expected: string | undefined
) {
  if (live === undefined) {
    return "no running server";
  }

  if (live.version !== installed) {
    return `running ${live.version}, installed ${installed}: restart it`;
  }

  return expected === undefined || live.version === expected
    ? undefined
    : `running ${live.version}, expected ${expected}`;
}

/** Both hosts the server answers, asked with no identity: each must be refused, 401. */
/** Where the server listens, for a request from this host: its bound address at the url's port. */
function listening(bind: string, url: string): string {
  const address = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind;

  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${new URL(url).port}/api/`;
}

/** Both hosts the server answers, asked with no identity on its bound address: each must get the kit's refusal. */
async function refusedProblem(
  url: string,
  web: WebConfig
): Promise<{ hosts: string[]; problem?: string }> {
  const own = new URL(url);
  const hosts = [own.host];

  if (web.host !== undefined) {
    // A plain-http host is served on web.port; port 0 is the one the system picked, the url's.
    const port = web.port === 0 ? own.port : String(web.port);
    // Asked as the public host even when it is the url's own: that is the request the door sends.
    hosts.push(web.host.https ? web.host.name : `${web.host.name}:${port}`);
  }

  const target = listening(web.bind, url);
  const answers = await Promise.all(hosts.map((host) => anonymous(target, host)));
  const unreachable = answers.find((answer) => "error" in answer);

  if (unreachable !== undefined && "error" in unreachable) {
    return { hosts, problem: `nothing answers at ${target} (${unreachable.error})` };
  }

  const problems = answers.flatMap((answer, index) => {
    if ("error" in answer || answer.kit) {
      return [];
    }

    return answer.status === 421
      ? [`the server doesn't answer ${hosts[index]} (421)`]
      : [`${hosts[index]} answered ${answer.status} with no identity, not the kit's refusal`];
  });

  return problems.length === 0 ? { hosts } : { hosts, problem: problems.join("; ") };
}

/** The public door, knocked with no identity: a proxy web.json verifies sends it to that proxy's login. */
function doorProblem(
  target: string,
  answer: Answer,
  web: WebConfig,
  host: string
): string | undefined {
  if ("error" in answer) {
    return `${target} is unreachable (${answer.error})`;
  }

  const login = proxyLogin(answer);
  const access = web.access;

  if (access === undefined) {
    return answer.kit || login !== undefined
      ? undefined
      : `${target} answered ${answer.status} with no identity, not the kit's refusal`;
  }

  if (answer.status === 401) {
    return `the server answered itself (401): no proxy in front, though web.json expects ${access.teamDomain}`;
  }

  if (login === undefined) {
    return `${target} answered ${answer.status}, not the proxy's login`;
  }

  if (login.origin !== new URL(access.teamDomain).origin) {
    return `another team's door: ${login.origin}, web.json has ${access.teamDomain}`;
  }

  if (login.pathname.slice(ACCESS_LOGIN.length) !== host) {
    return `the proxy's login is for ${login.pathname.slice(ACCESS_LOGIN.length)}, not ${host}`;
  }

  const kid = login.searchParams.get("kid");

  return kid === access.audience
    ? undefined
    : `the door's audience is ${kid ?? "missing"}, web.json has ${access.audience}: every signed request would be refused`;
}

/** `probe` flags: undefined on bad usage. */
function probeFlags(args: readonly string[]): ProbeFlags | undefined {
  const flags: ProbeFlags = {};

  for (let at = 0; at < args.length; at += 2) {
    const value = args[at + 1];

    if (value === undefined || value.startsWith("--")) {
      return undefined;
    }

    if (args[at] === "--expect" && flags.expect === undefined) {
      flags.expect = value;
    } else if (
      args[at] === "--door" &&
      flags.door === undefined &&
      URL.canParse(value) &&
      ["http:", "https:"].includes(new URL(value).protocol)
    ) {
      flags.door = value;
    } else {
      return undefined;
    }
  }

  return flags;
}

/** `probe [--expect <version>] [--door <url>]`: the server running on this home, checked with no identity. */
async function runProbe(
  app: Package,
  args: readonly string[],
  home: string
): Promise<number | undefined> {
  const flags = probeFlags(args);

  if (flags === undefined) {
    return undefined;
  }

  let failed = false;

  const say = (name: string, problem: string | undefined, seen: string) => {
    failed ||= problem !== undefined;
    console.log(problem === undefined ? `ok ${name}: ${seen}` : `fail ${name}: ${problem}`);
  };

  const found = readRecord(join(home, "serving.json"), servingRecord);
  const serving = servingProblem(home, found, running(home));
  const live = serving === undefined ? found : undefined;
  say("serving", serving, `pid ${found?.pid} since ${found?.at}`);
  say(
    "version",
    versionProblem(live, app.version, flags.expect),
    `running ${app.version}${flags.expect === undefined ? "" : ", as expected"}`
  );

  if (!existsSync(join(home, "web.json"))) {
    say(
      "login",
      live?.url === undefined
        ? undefined
        : "serving a web, web.json is gone: the next start has none",
      "no web"
    );

    return failed ? 1 : 0;
  }

  const web = await loadWebConfig(home, []);

  if ("off" in web) {
    say("login", `web off: ${web.off}`, "");

    return 1;
  }

  const doors = [
    ...(web.access === undefined ? [] : [`behind ${web.access.teamDomain}`]),
    ...(web.oidc === undefined ? [] : [`signs in with ${web.oidc.issuer}`]),
  ];

  say(
    "login",
    web.oidc !== undefined && onThisMachine(web.oidc.issuer)
      ? `web.oidc.issuer ${web.oidc.issuer} is on this machine: the test login`
      : undefined,
    doors.join(", ")
  );

  const url = live?.url;

  if (url === undefined) {
    say("refused", live === undefined ? "no running server" : "the running server has no web", "");
  } else {
    const refused = await refusedProblem(url, web);
    say("refused", refused.problem, `401 for ${[...new Set(refused.hosts)].join(" and ")}`);
  }

  if (web.host === undefined) {
    return failed ? 1 : 0;
  }

  const port = web.port === 0 && url !== undefined ? new URL(url).port : String(web.port);

  const target =
    flags.door ??
    (web.host.https ? `https://${web.host.name}/` : `http://${web.host.name}:${port}/`);

  const answer = await knock(target);
  const login = proxyLogin(answer);

  const seen =
    web.access === undefined && login !== undefined
      ? `behind ${login.origin}'s login, which web.json doesn't verify`
      : web.access === undefined
        ? `${target} reaches a server that refuses with no identity`
        : `${target} goes to ${web.access.teamDomain}'s login for this audience`;

  say("door", doorProblem(target, answer, web, web.host.name), seen);

  return failed ? 1 : 0;
}

function help(options: CliOptions): string {
  const name = options.name;
  const extra = Object.entries(options.commands ?? {});

  const rows: [string, string][] = [
    [
      "serve",
      `Run the server on the home (${upper(name)}_HOME, default ~/.${name}): ${options.serves}`,
    ],
    [
      "update",
      "Install a release (edge, the default, or a version) over this one. Stop the server first, or use the page's update button.",
    ],
    [
      "rollback",
      "Reinstall the release the last update replaced (kept in the home's releases/), with the server stopped, after it starts on a copy of the store. A release that writes an older store schema is refused unless --with-store also puts back the store from before that migration. --crashed is a supervisor's crash hook.",
    ],
    [
      "probe",
      "Check the server running on the home from this host, with no identity: it serves, the version (--expect: the one that passed), no test login, requests without identity refused, and the public door (--door: where to knock) matching web.json.",
    ],
    ...extra.map(([command, each]): [string, string] => [command, each.help]),
    [
      "version",
      'Print the installed version; --json: {"version", "schema"} (the store schema it writes).',
    ],
  ];

  const usage = [
    "serve",
    "update [edge | <version>]",
    "rollback [--with-store | --crashed]",
    "probe [--expect <version>] [--door <url>]",
    ...extra.map(([, each]) => each.usage),
    "version [--json]",
  ].join(" | ");

  return [
    `Usage: ${name} [${usage}]`,
    "",
    ...rows.map(([command, text]) => `  ${command.padEnd(9)} ${text}`),
  ].join("\n");
}

/** Run the command line: the exit code. */
export async function runCli(args: readonly string[], options: CliOptions): Promise<number> {
  if (!NAME.test(options.name)) {
    throw new Error(`runCli: not an app name: ${options.name}`);
  }

  const root = typeof options.root === "string" ? options.root : fileURLToPath(options.root);
  const env = options.env ?? process.env;

  const app: Package = {
    name: options.name,
    root,
    version: readManifest(root).version,
    store: `${options.name}.sqlite`,
    env,
  };

  const home = resolvePath(env[`${upper(app.name)}_HOME`] ?? join(homedir(), `.${app.name}`));
  const [command = "serve", ...rest] = args;

  if (command === "serve" && rest.length === 0) {
    return await serve(app, options, home);
  }

  if (
    (command === "version" || command === "--version") &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))
  ) {
    console.log(
      rest.includes("--json")
        ? JSON.stringify({ version: app.version, schema: options.schema })
        : app.version
    );

    return 0;
  }

  if (command === "update") {
    return await runUpdate(app, options.schema, rest, home);
  }

  if (command === "rollback") {
    return await runRollback(app, options.schema, rest, home);
  }

  if (command === "probe") {
    const code = await runProbe(app, rest, home);

    if (code !== undefined) {
      return code;
    }

    console.log(help(options));

    return 2;
  }

  const own = options.commands?.[command];

  if (own !== undefined) {
    await mkdir(home, { recursive: true, mode: 0o700 });

    return await own.run(rest, home);
  }

  console.log(help(options));

  return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
}
