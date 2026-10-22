/**
 * Agent keys: bearer tokens an agent or a check sends as `Authorization: Bearer <token>`, for an app's API on its own
 * binding without a person's login or a proxy's service token. The home keeps only each key's SHA-256
 * (`<home>/web-keys.json`, mode 0600); the token is shown once, by `addKey`. A key's identity is `key:<name>`, allowed
 * only when `web.allow` lists it, and it is never a person.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE = "web-keys.json";
const NAME = /^[a-z0-9-]{1,32}$/;
const TOKEN = /^([a-z0-9-]{1,32})\.([A-Za-z0-9_-]{43})$/;

type Entry = { name: string; sha256: string };

const digest = (token: string): Buffer => createHash("sha256").update(token).digest();

function parse(raw: string): Entry[] {
  const value: unknown = JSON.parse(raw);

  if (!Array.isArray(value)) {
    throw new TypeError(`${FILE} must be a list`);
  }

  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(`${FILE} holds an entry that isn't an object`);
    }

    const { name, sha256 } = Object.fromEntries(Object.entries(entry));

    if (typeof name !== "string" || !NAME.test(name) || typeof sha256 !== "string") {
      throw new TypeError(`${FILE} holds an entry without a name and a sha256`);
    }

    return { name, sha256 };
  });
}

async function read(home: string): Promise<Entry[]> {
  const raw = await readFile(join(home, FILE), "utf-8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "[]";
    }

    throw error;
  });

  return parse(raw);
}

async function write(home: string, entries: Entry[]): Promise<void> {
  const path = join(home, FILE);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Changes to one home's keys, one at a time in this process: each reads the file its predecessor wrote. */
const writing = new Map<string, Promise<unknown>>();

function serialized<T>(home: string, change: () => Promise<T>): Promise<T> {
  const next = (writing.get(home) ?? Promise.resolve()).then(change, change);
  writing.set(
    home,
    next.catch(() => undefined)
  );

  return next;
}

/** A new key named `name`: returns its token, the only time it exists outside the agent that keeps it. */
export function addKey(home: string, name: string): Promise<string> {
  if (!NAME.test(name)) {
    return Promise.reject(new Error("a key's name is 1–32 of a-z, 0-9 and -"));
  }

  return serialized(home, async () => {
    const entries = await read(home);

    if (entries.some((entry) => entry.name === name)) {
      throw new Error(`a key named ${name} exists; revoke it first`);
    }

    const token = `${name}.${randomBytes(32).toString("base64url")}`;
    await write(home, [...entries, { name, sha256: digest(token).toString("base64url") }]);

    return token;
  });
}

/** Removes the key named `name`; whether there was one. Its token stops working at the next request. */
export function revokeKey(home: string, name: string): Promise<boolean> {
  return serialized(home, async () => {
    const entries = await read(home);
    const kept = entries.filter((entry) => entry.name !== name);

    if (kept.length === entries.length) {
      return false;
    }

    await write(home, kept);

    return true;
  });
}

/**
 * The keys a server checks, reread whenever the file changes (its size, time or inode), so a revocation holds from the
 * next request. A file it can't read refuses every key until it can.
 */
export class Keys {
  private readonly path: string;
  private seen = "";
  private entries: Entry[] | undefined;

  constructor(home: string) {
    this.path = join(home, FILE);
  }

  /** The key's name for a token, or undefined when it isn't one of ours. */
  async verify(token: string): Promise<string | undefined> {
    const shape = TOKEN.exec(token);

    if (shape?.[1] === undefined) {
      return undefined;
    }

    const name = shape[1];
    const entries = await this.load();
    const entry = entries?.find((each) => each.name === name);

    if (entry === undefined) {
      return undefined;
    }

    const expected = Buffer.from(entry.sha256, "base64url");
    const actual = digest(token);

    return expected.length === actual.length && timingSafeEqual(expected, actual)
      ? name
      : undefined;
  }

  private async load(): Promise<Entry[] | undefined> {
    const found = await stat(this.path).catch(() => undefined);

    if (found === undefined) {
      this.seen = "";
      this.entries = [];

      return this.entries;
    }

    const version = `${found.ino}:${found.size}:${found.mtimeMs}`;

    if (version !== this.seen) {
      try {
        this.entries = parse(await readFile(this.path, "utf-8"));
      } catch {
        this.entries = undefined;
      }

      this.seen = version;
    }

    return this.entries;
  }
}
