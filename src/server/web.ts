/**
 * The web server every app of the kit runs: on 127.0.0.1 unless `web.bind` opens it, published by a tunnel on the same
 * host or reached directly by `web.host`. Nothing is trusted for being local: every request needs an allowed identity
 * (an access proxy's JWT or the server's own OIDC login), the Host must be ours, and every POST and the socket must come
 * from the page's own Origin. Responses carry a strict CSP and no framing.
 *
 * An agent's key (`Authorization: Bearer`) decides a request alone and needs no Origin: the Origin check guards
 * credentials a browser sends on its own (cookies), and a bearer isn't one.
 *
 * Routes are contract endpoints: the request is checked against its schema before the handler runs and the reply
 * after, so neither side can drift from the contract. Failures answer `{ kind, message, path? }` with the kind's status.
 * Raw routes (`rawRoute`) take and answer bytes behind the same guards, with their own body limit.
 * The socket is a hint channel: the app sends small messages (pokes, pings); nothing correct depends on it.
 * Every API request is logged with an id, status, time and whether a person or a service asked.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { STATUS } from "../contract.ts";
import type { Endpoint, RefusalKind } from "../contract.ts";
import { Invalid } from "../schema.ts";
import { WebAuth } from "./auth.ts";
import type { WebConfig } from "./config.ts";
import type { Logger } from "./log.ts";

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/** Who asked: their identities, whether a person (not a service token or a key), and how they signed in. */
export type Caller = {
  identities: string[];
  person: boolean;
  login: "access" | "oidc" | "key";
  request: string;
};

/**
 * A handler's refusal, answered as a typed failure: the kit's error body, so the page can tell it from a proxy's.
 * `path` names where a request broke its schema (`request.commands[1].command.value`).
 */
export class Refusal extends Error {
  readonly kind: RefusalKind;
  readonly path: string | undefined;
  constructor(kind: RefusalKind, message: string, path?: string) {
    super(message);
    this.kind = kind;
    this.path = path;
  }
}

/** A body limit as given: a positive whole number of bytes. */
function bodyBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`a body limit must be a positive integer, got ${bytes}`);
  }

  return bytes;
}

/** A route: an endpoint and its handler, typed together and run untyped by the server. */
export type Route = {
  method: "GET" | "POST";
  path: string;
  person: boolean;
  /** Its own request body limit; `serveWeb`'s `bodyLimit` when absent. */
  bodyLimit?: number;
  run: (input: unknown, caller: Caller) => Promise<unknown>;
};

export function route<Req, Res>(
  endpoint: Endpoint<Req, Res>,
  handle: (request: Req, caller: Caller) => Res | Promise<Res>,
  options: { bodyLimit?: number } = {}
): Route {
  return {
    method: endpoint.method,
    path: endpoint.path,
    person: endpoint.person,
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: bodyBytes(options.bodyLimit) }),
    run: async (input, caller) => {
      let request: Req;

      try {
        request = endpoint.request.parse(input, "request");
      } catch (error) {
        if (error instanceof Invalid) {
          throw new Refusal("invalid", error.message, error.path);
        }

        throw error;
      }

      // The reply is checked too: a server bug answers 500 rather than a reply the page would refuse.
      return endpoint.response.parse(await handle(request, caller), "reply");
    },
  };
}

/**
 * What a raw route's handler gets: the URL, what a `/*` path matched past its prefix (`{ "*": rest }`, decoded once;
 * `{}` for an exact path), the bounded body, the headers.
 */
export type RawRequest = {
  url: URL;
  params: Record<string, string>;
  body: Buffer | undefined;
  headers: IncomingMessage["headers"];
};

/**
 * What a raw route answers. `cache`: `immutable` for content named by its hash (kept for a year, by this browser only),
 * else `no-store`. The security headers are always the server's: `headers` can add others (`etag`,
 * `content-disposition`), never replace those; a `content-security-policy` only adds directives that tighten the
 * server's (`content-security-policy: sandbox` for bytes someone else made).
 */
export type RawReply = {
  status: number;
  type: string;
  body: Buffer | string;
  cache?: "immutable" | "no-store";
  headers?: Record<string, string>;
};

/** A route that takes and answers bytes, behind every guard a contract route has. */
export type RawRoute = {
  raw: true;
  method: "GET" | "POST";
  /** Exact, or a prefix ending in `/*`. */
  path: string;
  person: boolean;
  bodyLimit: number;
  handle: (request: RawRequest, caller: Caller) => RawReply | Promise<RawReply>;
};

export function rawRoute(definition: {
  method: "GET" | "POST";
  path: string;
  person?: boolean;
  bodyLimit?: number;
  handle: RawRoute["handle"];
}): RawRoute {
  if (!/^\/[^*]*(\/\*)?$/.test(definition.path)) {
    throw new Error(`a raw route's path is exact or ends in /*: ${definition.path}`);
  }

  return {
    raw: true,
    method: definition.method,
    path: definition.path,
    person: definition.person ?? false,
    bodyLimit: bodyBytes(definition.bodyLimit ?? 65_536),
    handle: definition.handle,
  };
}

/** Types worth gzipping; images never are, whatever their format. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json))/i;

/** CSP directives that only take away: a handler may add these to the server's policy. */
const TIGHTENING = new Set([
  "sandbox",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "require-trusted-types-for",
  "trusted-types",
]);

function directives(policy: string): Map<string, string> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().replaceAll(/\s+/g, " "))
      .filter((part) => part !== "")
      .map((part) => {
        const space = part.indexOf(" ");

        return space === -1
          ? [part.toLowerCase(), ""]
          : [part.slice(0, space).toLowerCase(), part.slice(space + 1)];
      })
  );
}

/**
 * The server's policy with the tightening directives a handler's policy names added (`sandbox` for bytes someone else
 * made). Everything else in the handler's policy is ignored: the server's directives are never replaced or dropped.
 */
function tightened(base: string, offered: string | undefined): string {
  if (offered === undefined) {
    return base;
  }

  const own = directives(base);

  const added = [...directives(offered)].flatMap(([name, value]) =>
    TIGHTENING.has(name) && !own.has(name) ? [value === "" ? name : `${name} ${value}`] : []
  );

  return [base, ...added].join("; ");
}

export type Socket = {
  path: string;
  /** A socket opened: return what to do when it closes. `send` takes JSON-ready values. */
  open: (send: (message: unknown) => void, caller: Caller) => () => void;
};

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];

  return Array.isArray(value) ? value[0] : value;
}

function sessionToken(request: IncomingMessage, cookie: string): string | undefined {
  return (header(request, "cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookie}=`))
    ?.slice(cookie.length + 1);
}

/** Send a body, gzipped when the client takes it and it is worth it. */
function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {}
): void {
  let bytes = typeof body === "string" ? Buffer.from(body) : body;
  const extra: Record<string, string> = {};
  const type = headers["content-type"] ?? "text/plain";

  if (
    bytes.length > 1024 &&
    COMPRESSIBLE.test(type) &&
    /\bgzip\b/.test(header(request, "accept-encoding") ?? "")
  ) {
    bytes = gzipSync(bytes, { level: 6 });
    extra["content-encoding"] = "gzip";
    extra.vary = "accept-encoding";
  }

  response.writeHead(status, {
    ...SECURITY,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
    ...extra,
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function failure(
  request: IncomingMessage,
  response: ServerResponse,
  kind: RefusalKind,
  message: string,
  path?: string
): void {
  send(
    request,
    response,
    STATUS[kind],
    JSON.stringify({ kind, message, ...(path === undefined ? {} : { path }) }),
    { "content-type": "application/json" }
  );
}

/** The body's bytes, counted against `limit` as they arrive: past it, refused before anything reads them. */
async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(header(request, "content-length"));

  if (Number.isFinite(declared) && declared > limit) {
    throw new Refusal("invalid", "the request is too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;

    if (size > limit) {
      throw new Refusal("invalid", "the request is too large");
    }

    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

/**
 * The body as JSON: its bytes collected and counted against `limit`, then decoded once, so a character split between
 * chunks arrives whole. Bytes that aren't UTF-8 are refused, never replaced.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const bytes = await readBytes(request, limit);
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Refusal("invalid", "the request is not UTF-8");
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Refusal("invalid", "the request is not JSON");
  }
}

export type WebOptions = {
  home: string;
  config: WebConfig;
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  /** The built client: `index.html`, hashed assets, `sw.js`. */
  assets: string;
  /** The install manifest. */
  manifest: Record<string, unknown>;
  /** Contract routes (`route`) and routes that take and answer bytes (`rawRoute`). */
  routes: (Route | RawRoute)[];
  socket?: Socket;
  /** The session cookie's name. */
  cookie: string;
  /**
   * Request bodies past this many bytes are refused, unless a route sets its own; default 64 KiB. Give a push endpoint
   * `PUSH_BYTES` or more.
   */
  bodyLimit?: number;
};

export async function serveWeb(
  options: WebOptions
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const { config, log, cookie } = options;
  const auth = new WebAuth(config, options.home, options.env);
  const hosts = new Set<string>();
  const origins = new Set<string>();
  let plainHost: string | undefined;
  const contract = options.routes.filter((each): each is Route => !("raw" in each));
  const raws = options.routes.filter((each): each is RawRoute => "raw" in each);
  const routes = new Map(contract.map((each) => [`${each.method} ${each.path}`, each]));
  const manifest = JSON.stringify(options.manifest);

  // A raw route can't take over the login, the socket or the manifest, or shadow another route.
  for (const each of raws) {
    const prefix = each.path.endsWith("/*") ? each.path.slice(0, -1) : undefined;

    const covers = (path: string) =>
      prefix === undefined
        ? path === each.path
        : path.startsWith(prefix) || path === prefix.slice(0, -1) || prefix === "/";

    if (
      each.path.startsWith("/auth/") ||
      covers("/auth/login") ||
      covers("/manifest.webmanifest") ||
      (options.socket !== undefined && covers(options.socket.path)) ||
      contract.some((other) => covers(other.path))
    ) {
      throw new Error(`a raw route can't serve ${each.path}`);
    }
  }

  if (new Set(raws.map((each) => `${each.method} ${each.path}`)).size !== raws.length) {
    throw new Error("two raw routes have the same method and path");
  }

  /** The raw routes for a path, most specific first, with what a `/*` matched. */
  function rawFor(path: string): { found: RawRoute; params: string | undefined }[] {
    // Matched on the decoded path, so a prefix's remainder is decoded exactly once.
    return raws
      .flatMap((each): { found: RawRoute; params: string | undefined; rank: number }[] => {
        if (each.path === path) {
          return [{ found: each, params: undefined, rank: Number.MAX_SAFE_INTEGER }];
        }

        const prefix = each.path.endsWith("/*") ? each.path.slice(0, -1) : undefined;

        return prefix !== undefined && path.startsWith(prefix)
          ? [{ found: each, params: path.slice(prefix.length), rank: prefix.length }]
          : [];
      })
      .toSorted((a, b) => b.rank - a.rank);
  }

  /** The caller, or undefined when not signed in, or false when signed in but not allowed. */
  async function identify(request: IncomingMessage): Promise<Caller | false | undefined> {
    const authorization = header(request, "authorization");

    // Any Authorization is a bearer's claim: one that isn't a well-formed bearer is refused, never ignored.
    const bearer =
      authorization === undefined ? undefined : (/^Bearer (\S+)$/i.exec(authorization)?.[1] ?? "");

    const jwt = header(request, "cf-access-jwt-assertion");

    const identities = await auth.identify(jwt, sessionToken(request, cookie), bearer);

    if (identities === undefined || identities === false) {
      return identities;
    }

    return {
      identities,
      person: !identities.some(
        (identity) => identity.startsWith("service:") || identity.startsWith("key:")
      ),
      login: bearer === undefined ? (jwt === undefined ? "oidc" : "access") : "key",
      request: randomBytes(6).toString("base64url"),
    };
  }

  /** Whether a request may act: a key always (it isn't sent on its own); a cookie or proxy only from the page. */
  const fromPage = (request: IncomingMessage, caller: Caller): boolean =>
    caller.login === "key" || origins.has(header(request, "origin") ?? "");

  /** Log one request's outcome, as every route does. */
  function logged(
    caller: Caller,
    method: string,
    path: string,
    status: number,
    started: number
  ): void {
    log(status < 400 ? "info" : "warn", "request", {
      request: caller.request,
      method,
      path,
      status,
      ms: Math.round(performance.now() - started),
      person: caller.person,
      ...(caller.login === "key" ? { caller: caller.identities.join(" ") } : {}),
    });
  }

  async function raw(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    caller: Caller,
    candidates: { found: RawRoute; params: string | undefined }[]
  ): Promise<void> {
    const started = performance.now();
    const method = request.method === "HEAD" ? "GET" : (request.method ?? "GET");
    const match = candidates.find((each) => each.found.method === method);
    let status = 200;

    try {
      if (match === undefined) {
        status = 405;
        send(request, response, 405, "Method not allowed");
        logged(caller, method, url.pathname, status, started);

        return;
      }

      const { found, params } = match;

      if (method === "POST" && !fromPage(request, caller)) {
        throw new Refusal("forbidden", "bad origin");
      }

      if (found.person && !caller.person) {
        throw new Refusal("forbidden", "only a person's login can do this");
      }

      const body = method === "POST" ? await readBytes(request, found.bodyLimit) : undefined;

      const reply = await found.handle(
        {
          url,
          params: params === undefined ? {} : { "*": params },
          body,
          headers: request.headers,
        },
        caller
      );

      status = reply.status;

      const offered = Object.entries(reply.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "content-security-policy"
      )?.[1];

      const own = Object.fromEntries(
        Object.entries(reply.headers ?? {}).filter(
          ([name]) =>
            !(name.toLowerCase() in SECURITY) &&
            !["content-type", "content-encoding", "cache-control", "vary"].includes(
              name.toLowerCase()
            )
        )
      );

      send(request, response, reply.status, reply.body, {
        ...own,
        "content-type": reply.type,
        "cache-control":
          reply.cache === "immutable" ? "private, max-age=31536000, immutable" : "no-store",
        "content-security-policy": tightened(SECURITY["content-security-policy"], offered),
      });
    } catch (error) {
      const kind = error instanceof Refusal ? error.kind : "unavailable";
      status = STATUS[kind];

      if (!(error instanceof Refusal)) {
        log("error", "handler failed", {
          request: caller.request,
          path: url.pathname,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      failure(
        request,
        response,
        kind,
        error instanceof Refusal ? error.message : "the server failed; see its log"
      );
    }

    logged(caller, method, url.pathname, status, started);
  }

  async function asset(
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): Promise<void> {
    const relative = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");

    if (relative.split(sep).includes("..")) {
      return send(request, response, 400, "Bad path");
    }

    let file = join(options.assets, relative || "index.html");

    // Client routes are the app's: anything without an extension gets the shell.
    if (!extname(file)) {
      file = join(options.assets, "index.html");
    }

    const found = await stat(file).catch(() => undefined);

    if (found?.isFile() !== true) {
      return send(
        request,
        response,
        extname(path) ? 404 : 503,
        extname(path) ? "Not found" : "The web client is not built"
      );
    }

    // Hashed assets never change; the shell and the service worker must be refetched.
    const immutable = /\.[0-9A-Z]{8}\.(js|css)$/i.test(file);

    const headers = {
      "content-type": TYPES.get(extname(file)) ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };

    // A build's brotli copy (`<file>.br`, compressed once at its best level) goes to a client that takes it: smaller
    // than gzip on the wire, at no cost per request.
    const brotli = /\bbr\b/.test(header(request, "accept-encoding") ?? "")
      ? await readFile(`${file}.br`).catch(() => undefined)
      : undefined;

    if (brotli !== undefined) {
      response.writeHead(200, {
        ...SECURITY,
        ...headers,
        "content-encoding": "br",
        vary: "accept-encoding",
      });
      response.end(request.method === "HEAD" ? undefined : brotli);

      return;
    }

    send(request, response, 200, await readFile(file), headers);
  }

  async function api(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    caller: Caller
  ): Promise<void> {
    const started = performance.now();
    const method = request.method === "POST" ? "POST" : "GET";
    const found = routes.get(`${method} ${url.pathname}`);
    let status = 200;

    try {
      if (found === undefined) {
        throw new Refusal("invalid", `no ${method} ${url.pathname}`);
      }

      // A page from anywhere else must never act with this browser's credentials.
      if (method === "POST" && !fromPage(request, caller)) {
        throw new Refusal("forbidden", "bad origin");
      }

      if (found.person && !caller.person) {
        throw new Refusal("forbidden", "only a person's login can do this");
      }

      let input: unknown;

      if (method === "POST") {
        input = await readBody(request, found.bodyLimit ?? options.bodyLimit ?? 65_536);
      } else {
        const q = url.searchParams.get("q");

        try {
          input = q === null ? {} : JSON.parse(q);
        } catch {
          throw new Refusal("invalid", "q is not JSON");
        }
      }

      const reply = await found.run(input, caller);
      send(request, response, 200, JSON.stringify(reply), { "content-type": "application/json" });
    } catch (error) {
      const kind = error instanceof Refusal ? error.kind : "unavailable";
      status = STATUS[kind];
      const message = error instanceof Error ? error.message : String(error);

      if (!(error instanceof Refusal)) {
        log("error", "handler failed", {
          request: caller.request,
          path: url.pathname,
          reason: message,
        });
      }

      failure(
        request,
        response,
        kind,
        error instanceof Refusal ? message : "the server failed; see its log",
        error instanceof Refusal ? error.path : undefined
      );
    }

    logged(caller, method, url.pathname, status, started);
  }

  /** The sockets each sign-in session opened, so signing out closes them. */
  const signedIn = new Map<string, Set<WebSocket>>();

  const server = createServer((request, response) => {
    void (async () => {
      if (!hosts.has(header(request, "host") ?? "")) {
        return send(request, response, 421, "Unknown host");
      }

      const url = new URL(request.url ?? "/", "http://localhost");
      const https = config.host?.https === true && header(request, "host") === config.host.name;
      const secure = header(request, "host") === plainHost ? "" : " Secure;";
      const callback = `${https ? "https" : "http"}://${header(request, "host") ?? ""}/auth/callback`;

      if (url.pathname === "/auth/login" && request.method === "GET") {
        if (!auth.oidc) {
          return send(request, response, 404, "No login here");
        }

        return send(request, response, 302, "", { location: await auth.loginUrl(callback) });
      }

      if (url.pathname === "/auth/callback" && request.method === "GET") {
        try {
          const token = await auth.callback(
            url.searchParams.get("state") ?? "",
            url.searchParams.get("code") ?? ""
          );

          log("info", "signed in");

          return send(request, response, 302, "", {
            location: "/",
            "set-cookie": `${cookie}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${7 * 86_400}`,
          });
        } catch (error) {
          log("warn", "sign-in failed", { reason: error instanceof Error ? error.message : "" });

          return send(
            request,
            response,
            403,
            error instanceof Error ? error.message : "Sign-in failed"
          );
        }
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        if (!origins.has(header(request, "origin") ?? "")) {
          return send(request, response, 403, "Bad origin");
        }

        const token = sessionToken(request, cookie);
        await auth.logout(token);

        for (const socket of token === undefined ? [] : (signedIn.get(token) ?? [])) {
          socket.close(4001, "signed out");
        }

        if (token !== undefined) {
          signedIn.delete(token);
        }

        return send(request, response, 204, "", {
          "set-cookie": `${cookie}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`,
        });
      }

      const caller = await identify(request);

      if (caller === undefined || caller === false) {
        log("warn", caller === false ? "refused" : "not signed in", { path: url.pathname });

        const navigation =
          request.method === "GET" && (header(request, "accept") ?? "").includes("text/html");

        if (caller === undefined && navigation && auth.oidc) {
          return send(request, response, 302, "", { location: "/auth/login" });
        }

        return failure(
          request,
          response,
          caller === false ? "forbidden" : "signed-out",
          caller === false ? "not allowed" : "sign in first"
        );
      }

      let decoded: string;

      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        return send(request, response, 400, "Bad path");
      }

      const candidates = rawFor(decoded);

      if (candidates.length > 0) {
        return await raw(request, response, url, caller, candidates);
      }

      if (url.pathname.startsWith("/api/")) {
        return await api(request, response, url, caller);
      }

      if (url.pathname === "/manifest.webmanifest" && request.method === "GET") {
        return send(request, response, 200, manifest, {
          "content-type": "application/manifest+json",
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return send(request, response, 405, "Method not allowed");
      }

      await asset(request, response, url.pathname);
    })().catch((error: unknown) => {
      log("error", "request failed", { reason: error instanceof Error ? error.message : "" });

      if (!response.headersSent) {
        send(request, response, 500, "Failed");
      }
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (request, stream, head) => {
    const refuse = (status: number): void => {
      stream.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
    };

    void (async () => {
      if (!hosts.has(header(request, "host") ?? "")) {
        return refuse(421);
      }

      if (
        options.socket === undefined ||
        new URL(request.url ?? "/", "http://localhost").pathname !== options.socket.path
      ) {
        return refuse(404);
      }

      const caller = await identify(request);

      if (caller === undefined || caller === false) {
        return refuse(caller === false ? 403 : 401);
      }

      if (!fromPage(request, caller)) {
        return refuse(403);
      }

      const open = options.socket.open;
      sockets.handleUpgrade(request, stream, head, (socket) => {
        socket.on("error", () => {
          // ws closes the socket after an error; the close handler below does the cleanup.
        });
        const opened = performance.now();
        const token = sessionToken(request, cookie);

        if (token !== undefined) {
          signedIn.set(token, (signedIn.get(token) ?? new Set()).add(socket));
        }

        let sent = 0;

        const closed = open((message) => {
          if (socket.readyState !== socket.OPEN) {
            return;
          }

          sent += 1;
          socket.send(JSON.stringify(message));
        }, caller);

        log("info", "socket opened", {
          request: caller.request,
          sockets: sockets.clients.size,
          person: caller.person,
        });
        socket.on("close", () => {
          closed();

          if (token !== undefined) {
            signedIn.get(token)?.delete(socket);
          }

          log("info", "socket closed", {
            request: caller.request,
            ms: Math.round(performance.now() - opened),
            sent,
            sockets: sockets.clients.size,
          });
        });
      });
    })().catch(() => refuse(500));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  for (const local of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    hosts.add(local);
    origins.add(`http://${local}`);
  }

  if (config.host?.https === true) {
    hosts.add(config.host.name);
    origins.add(`https://${config.host.name}`);
  } else if (config.host !== undefined) {
    plainHost = `${config.host.name}:${port}`;
    hosts.add(plainHost);
    origins.add(`http://${plainHost}`);
  }

  return {
    url: `http://${plainHost ?? `127.0.0.1:${port}`}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) {
          client.close(1012, "restarting");
        }

        sockets.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
