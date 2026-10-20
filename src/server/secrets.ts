/**
 * Credentials and sealing. A credential comes from a file in `$CREDENTIALS_DIRECTORY` (systemd's `LoadCredential` and
 * `LoadCredentialEncrypted`, which keep it sealed on disk and in memory only while the service runs), else from an
 * environment variable. Secrets an app stores (a provider's access tokens) are sealed with AES-256-GCM under a key
 * credential before they reach the store, so a copy of the home alone opens nothing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** A credential's value, or undefined: `$CREDENTIALS_DIRECTORY/<name>`, else `env[variable]`. */
export function credential(name: string, variable: string, env: Env): string | undefined {
  const directory = env.CREDENTIALS_DIRECTORY;

  if (directory !== undefined && directory !== "") {
    try {
      const value = readFileSync(join(directory, name), "utf-8").trim();

      if (value !== "") {
        return value;
      }
    } catch {
      // Not given as a file; the environment may have it.
    }
  }

  const value = env[variable]?.trim();

  return value === "" ? undefined : value;
}

const PREFIX = "v1.";

/** Seals and opens short secrets with one 32-byte key; the context (the owning row's id) binds each to its row. */
export class Sealer {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("the sealing key must be 32 bytes, as base64 or hex");
    }

    this.key = key;
  }

  /** The key from credential `name` (else `env[variable]`), as hex or base64, or why there is none. */
  static from(env: Env, name: string, variable: string): Sealer | { missing: string } {
    const raw = credential(name, variable, env);

    if (raw === undefined) {
      return { missing: `no ${name} credential (${variable})` };
    }

    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");

    try {
      return new Sealer(key);
    } catch (error) {
      return { missing: error instanceof Error ? error.message : String(error) };
    }
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));

    const body = Buffer.concat([
      cipher.update(plain, "utf-8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    return `${PREFIX}${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  open(sealed: string, context: string): string {
    const [version, iv, body] = sealed.split(".");

    if (`${version}.` !== PREFIX || iv === undefined || body === undefined) {
      throw new Error("Not a sealed value");
    }

    const bytes = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(-16));

    return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(
      "utf-8"
    );
  }
}
