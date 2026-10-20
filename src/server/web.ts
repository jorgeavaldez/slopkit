/**
 * The web server every app of the kit runs: on 127.0.0.1 unless `web.bind` opens it, published by a tunnel on the same
 * host or reached directly by `web.host`. Nothing is trusted for being local: every request needs an allowed identity
 * (an access proxy's JWT or the server's own OIDC login), the Host must be ours, and every POST and the socket must come
 * from the page's own Origin. Responses carry a strict CSP and no framing.
 *
 * Routes are contract endpoints: the request is checked against its schema before the handler runs and the reply
 * after, so neither side can drift from the contract. Failures answer `{ kind, message }` with the kind's status.
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
import type { Endpoint, Failure } from "../contract.ts";
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

/** Who asked: their identities, whether a person (not a service token), and how they signed in. */
export type Caller = {
  identities: string[];
  person: boolean;
  login: "access" | "oidc";
  request: string;
};

/** A handler's refusal, answered as a typed failure. */
export class Refusal extends Error {
  readonly kind: Failure["kind"];
  constructor(kind: Failure["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A route: an endpoint and its handler, typed together and run untyped by the server. */
export type Route = {
  method: "GET" | "POST";
  path: string;
  person: boolean;
  run: (input: unknown, caller: Caller) => Promise<unknown>;
};

export function route<Req, Res>(
  endpoint: Endpoint<Req, Res>,
  handle: (request: Req, caller: Caller) => Res | Promise<Res>
): Route {
  return {
    method: endpoint.method,
    path: endpoint.path,
    person: endpoint.person,
    run: async (input, caller) => {
      let request: Req;

      try {
        request = endpoint.request.parse(input, "request");
      } catch (error) {
        if (error instanceof Invalid) {
          throw new Refusal("invalid", error.message);
        }

        throw error;
      }

      // The reply is checked too: a server bug answers 500 rather than a reply the page would refuse.
      return endpoint.response.parse(await handle(request, caller), "reply");
    },
  };
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

  if (bytes.length > 1024 && /\bgzip\b/.test(header(request, "accept-encoding") ?? "")) {
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
  kind: Failure["kind"],
  message: string
): void {
  send(request, response, STATUS[kind], JSON.stringify({ kind, message }), {
    "content-type": "application/json",
  });
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  let text = "";

  for await (const chunk of request) {
    text += String(chunk);

    if (text.length > limit) {
      throw new Refusal("invalid", "the request is too large");
    }
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
  routes: Route[];
  socket?: Socket;
  /** The session cookie's name. */
  cookie: string;
  /** Request bodies past this are refused; default 64 KB. */
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
  const routes = new Map(options.routes.map((each) => [`${each.method} ${each.path}`, each]));
  const manifest = JSON.stringify(options.manifest);

  /** The caller, or undefined when not signed in, or false when signed in but not allowed. */
  async function identify(request: IncomingMessage): Promise<Caller | false | undefined> {
    const jwt = header(request, "cf-access-jwt-assertion");
    const identities = await auth.identify(jwt, sessionToken(request, cookie));

    if (identities === undefined || identities === false) {
      return identities;
    }

    return {
      identities,
      person: !identities.some((identity) => identity.startsWith("service:")),
      login: jwt === undefined ? "oidc" : "access",
      request: randomBytes(6).toString("base64url"),
    };
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
      if (method === "POST" && !origins.has(header(request, "origin") ?? "")) {
        throw new Refusal("forbidden", "bad origin");
      }

      if (found.person && !caller.person) {
        throw new Refusal("forbidden", "only a person's login can do this");
      }

      let input: unknown;

      if (method === "POST") {
        input = await readBody(request, options.bodyLimit ?? 65_536);
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
        error instanceof Refusal ? message : "the server failed; see its log"
      );
    }

    log(status < 400 ? "info" : "warn", "request", {
      request: caller.request,
      method,
      path: url.pathname,
      status,
      ms: Math.round(performance.now() - started),
      person: caller.person,
    });
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

      if (!origins.has(header(request, "origin") ?? "")) {
        return refuse(403);
      }

      const caller = await identify(request);

      if (caller === undefined || caller === false) {
        return refuse(caller === false ? 403 : 401);
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
