/**
 * Settings files in an app's home, which can never keep the app from starting: an invalid field keeps its default and
 * the rest applies, a file that isn't JSON means the defaults, and unknown keys are ignored; each says why in
 * `warnings`. `web.json` (the web server: port, host, login) is all or nothing: a half-configured login keeps the web
 * off rather than open.
 */
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

/** The web server, from `<home>/web.json`. Every request needs an identity on `allow`. */
export type WebConfig = {
  /** 0: the system picks a free port at each start. */
  port: number;
  bind: string;
  /** The other host it answers besides localhost: served over TLS by a proxy (`https`), or directly over plain http. */
  host: { name: string; https: boolean } | undefined;
  /** An identity-aware proxy that signs each request (`Cf-Access-Jwt-Assertion`), checked against its keys. */
  access: { teamDomain: string; audience: string; subjectClaim: string } | undefined;
  /** The server's own login: OpenID Connect authorization code with PKCE. */
  oidc:
    | {
        issuer: string;
        clientId: string;
        clientSecretEnv: string | undefined;
        scopes: string[];
        subjectClaim: string;
      }
    | undefined;
  /** `sub:<subject>`, `email:<address>`, or `service:<client id>` for a proxy's service token. */
  allow: string[];
};

export type Fields = Record<string, unknown>;

export function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown, field: string): Fields {
  if (!isObject(value)) {
    throw new Error(`${field} must be an object`);
  }

  return value;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be text`);
  }

  return value.trim();
}

export function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }

  return value;
}

export function url(value: unknown, field: string): string {
  const raw = text(value, field);
  const parsed = URL.canParse(raw) ? new URL(raw) : undefined;
  // Plain http only for a provider on this machine.
  const loopback = parsed?.hostname === "127.0.0.1" || parsed?.hostname === "localhost";

  if (
    parsed === undefined ||
    !(parsed.protocol === "https:" || (loopback && parsed.protocol === "http:"))
  ) {
    throw new Error(`${field} must be an https URL`);
  }

  return raw.replace(/\/+$/, "");
}

/** One setting: absent keeps the default, and so does a bad value, with a warning. */
export function setting<T>(
  section: Fields,
  key: string,
  field: string,
  fallback: T,
  read: (raw: unknown, name: string) => T,
  warnings: string[]
): T {
  if (section[key] === undefined) {
    return fallback;
  }

  try {
    return read(section[key], `${field}.${key}`);
  } catch (error) {
    warnings.push(`${error instanceof Error ? error.message : String(error)}; using the default`);

    return fallback;
  }
}

export function unknownKeys(
  section: Fields,
  field: string,
  known: string[],
  warnings: string[]
): void {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) {
      warnings.push(`${field === "" ? "" : `${field}.`}${key} is not a setting; ignored`);
    }
  }
}

function webHost(raw: string, port: number): NonNullable<WebConfig["host"]> {
  const plain = /^http:\/\/([a-z0-9.-]+)(?::(\d+))?\/?$/i.exec(raw);

  if (plain?.[1] !== undefined) {
    if (plain[2] !== undefined && Number(plain[2]) !== port) {
      throw new Error("web.host is served on web.port: leave the port out of it");
    }

    return { name: plain[1].toLowerCase(), https: false };
  }

  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(raw)) {
    throw new Error("web.host must be a host name a proxy serves over https, or http://<name>");
  }

  return { name: raw.toLowerCase(), https: true };
}

/** `web.json` is all or nothing: a login half configured must never open the server. Throws with what is wrong. */
export function parseWebConfig(value: unknown, warnings: string[]): WebConfig {
  const web = object(value, "web.json");
  unknownKeys(web, "web", ["port", "bind", "host", "access", "oidc", "allow"], warnings);
  let access: WebConfig["access"];

  if (web.access !== undefined) {
    const raw = object(web.access, "web.access");
    access = {
      teamDomain: url(raw.teamDomain, "web.access.teamDomain"),
      audience: text(raw.audience, "web.access.audience"),
      subjectClaim:
        raw.subjectClaim === undefined ? "sub" : text(raw.subjectClaim, "web.access.subjectClaim"),
    };
  }

  let oidc: WebConfig["oidc"];

  if (web.oidc !== undefined) {
    const raw = object(web.oidc, "web.oidc");
    const scopes: unknown = raw.scopes ?? ["openid", "profile", "email"];

    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
      throw new Error("web.oidc.scopes must be a list of strings");
    }

    if (!scopes.includes("openid")) {
      throw new Error("web.oidc.scopes must include openid");
    }

    oidc = {
      issuer: url(raw.issuer, "web.oidc.issuer"),
      clientId: text(raw.clientId, "web.oidc.clientId"),
      clientSecretEnv:
        raw.clientSecretEnv === undefined
          ? undefined
          : text(raw.clientSecretEnv, "web.oidc.clientSecretEnv"),
      scopes,
      subjectClaim:
        raw.subjectClaim === undefined ? "sub" : text(raw.subjectClaim, "web.oidc.subjectClaim"),
    };
  }

  const listed: unknown = web.allow ?? [];

  const allow = Array.isArray(listed)
    ? listed.filter(
        (entry): entry is string =>
          typeof entry === "string" && /^(sub|email|service):.+$/.test(entry)
      )
    : [];

  if (!Array.isArray(listed) || allow.length !== listed.length) {
    throw new Error("web.allow must list sub:<subject>, email:<address> or service:<client id>");
  }

  if (access === undefined && oidc === undefined) {
    throw new Error("web.json needs a login: web.access (an identity-aware proxy) or web.oidc");
  }

  if (allow.length === 0) {
    throw new Error("web.allow is empty: list who may use it");
  }

  const port = web.port === undefined ? 7430 : integer(web.port, "web.port", 0, 65_535);
  const bind = web.bind === undefined ? "127.0.0.1" : text(web.bind, "web.bind");

  if (isIP(bind) === 0) {
    throw new Error("web.bind must be an IP address, such as 127.0.0.1");
  }

  return {
    port,
    bind,
    host: web.host === undefined ? undefined : webHost(text(web.host, "web.host"), port),
    access,
    oidc,
    allow,
  };
}

export async function readJson(path: string, warnings: string[]): Promise<unknown> {
  const raw = await readFile(path, "utf-8").catch(() => undefined);

  if (raw === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    warnings.push(`${path} is not JSON; ignored`);

    return undefined;
  }
}

/** `web.json`, or why the web stays off: missing, not JSON, or invalid. Never throws. */
export async function loadWebConfig(
  home: string,
  warnings: string[]
): Promise<WebConfig | { off: string }> {
  const path = join(home, "web.json");
  const value = await readJson(path, warnings);

  if (value === undefined) {
    return { off: `no usable ${path}` };
  }

  try {
    const own: string[] = [];
    const web = parseWebConfig(value, own);
    warnings.push(...own.map((warning) => `${path}: ${warning}`));

    return web;
  } catch (error) {
    return { off: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
