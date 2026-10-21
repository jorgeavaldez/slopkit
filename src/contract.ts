/**
 * HTTP contracts: each endpoint is one value naming its method, path, request and response schemas, shared by the
 * server (which checks requests and its own replies) and the page (which checks replies, since a proxy in between can
 * answer anything, such as an HTML login page). Failures are a closed set of kinds; a caller handles each by kind.
 */
import { check, object, optional, string } from "./schema.ts";
import type { Schema } from "./schema.ts";

export type Endpoint<Req, Res> = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly request: Schema<Req>;
  readonly response: Schema<Res>;
  /** Only a person's login may call it, never a service token's. */
  readonly person: boolean;
};

export function endpoint<Req, Res>(
  method: "GET" | "POST",
  path: string,
  request: Schema<Req>,
  response: Schema<Res>,
  options: { person?: boolean } = {}
): Endpoint<Req, Res> {
  return { method, path, request, response, person: options.person ?? false };
}

/**
 * Why a call failed. `signed-out`: the login is gone (the only kind that reloads the page). `forbidden`: signed in but
 * not allowed. `invalid`: the request broke the contract. `conflict`: refused for the current state. `upstream`: a
 * service behind the server failed. `unavailable`: the server is up but can't now. `offline`: no answer. `unreadable`:
 * a reply that broke the contract (not JSON, or failing its schema): it may have acted, and the server never sends it.
 *
 * `refused`: the server's own refusal, its kit error body naming a kind that matches the status; only then can it be
 * final, since a proxy can answer any status. `path`: where a refused request broke its schema. `retryAfterMs`: the
 * provider's `Retry-After`, a floor for the next try.
 */
export type Failure = {
  kind:
    | "signed-out"
    | "forbidden"
    | "invalid"
    | "conflict"
    | "upstream"
    | "unavailable"
    | "offline"
    | "unreadable";
  message: string;
  refused?: true;
  path?: string;
  retryAfterMs?: number;
};

/** The kinds a server answers with: a reply it can't read is the client's observation, never a server's. */
export type RefusalKind = Exclude<Failure["kind"], "unreadable">;

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export const STATUS: Record<RefusalKind, number> = {
  "signed-out": 401,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  upstream: 502,
  unavailable: 503,
  offline: 503,
};

const KINDS: readonly RefusalKind[] = [
  "signed-out",
  "forbidden",
  "invalid",
  "conflict",
  "upstream",
  "unavailable",
  "offline",
];

/** A body that was due as JSON and wasn't. */
const UNREADABLE = Symbol("unreadable");

/** A failure's body, as `serveWeb` answers it: its message is shown when there is one. */
const ERROR_BODY = object({ message: string() });

/** The kit's own error body: a kind it can send, its message, and the schema path of a refused request. */
const KIT_BODY = object({ kind: string(), message: string(), path: optional(string()) });

/**
 * A status's kind when no kit body says otherwise. A wrong endpoint or method and a body past the server's limit are
 * `invalid` (no command path: incompatible); a timeout or rate limit is `unavailable`, retried.
 */
function kindOf(status: number): Failure["kind"] {
  if (status === 401) {
    return "signed-out";
  }

  if (status === 403) {
    return "forbidden";
  }

  if (status === 409) {
    return "conflict";
  }

  if (status === 408 || status === 429) {
    return "unavailable";
  }

  if (status === 502 || status === 504) {
    return "upstream";
  }

  if (status >= 500) {
    return "unavailable";
  }

  return "invalid";
}

/** The longest a `Retry-After` defers the next try: a bad header can delay sync, never stop it. */
export const RETRY_AFTER_MAX_MS = 3_600_000;

/**
 * `Retry-After` as milliseconds from now, capped at `RETRY_AFTER_MAX_MS`: delay seconds or an HTTP date; undefined
 * when absent or unreadable.
 */
function retryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const at = /^\d+$/.test(value.trim())
    ? Number(value.trim()) * 1000
    : Date.parse(value) - Date.now();

  return Number.isNaN(at) ? undefined : Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at));
}

/** GET requests carry their input as one `q` query parameter of JSON; POST as the body. */
export function encodeUrl<Req>(route: Endpoint<Req, unknown>, request: Req): string {
  if (route.method === "POST") {
    return route.path;
  }

  return `${route.path}?q=${encodeURIComponent(JSON.stringify(request))}`;
}

/**
 * Call an endpoint from a browser (or any fetch). Every outcome is a `Result`: thrown errors, redirects and successful
 * HTML pages (a proxy's login page means signed out), error statuses, and successes that aren't JSON or break the
 * schema (`unreadable`) all become a `Failure`. An error is `refused` only with the kit's own body.
 */
export async function call<Req, Res>(
  route: Endpoint<Req, Res>,
  request: Req,
  options: {
    fetch?: typeof fetch;
    base?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<Result<Res>> {
  const send = options.fetch ?? fetch;
  let response: Response;

  try {
    response = await send(`${options.base ?? ""}${encodeUrl(route, request)}`, {
      method: route.method,
      credentials: "same-origin",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...options.headers,
      },
      ...(route.method === "POST" ? { body: JSON.stringify(request) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    return {
      ok: false,
      failure: { kind: "offline", message: error instanceof Error ? error.message : String(error) },
    };
  }

  // A redirect (an opaque one, in a browser) or a successful HTML page is a proxy sending the browser to sign in. An
  // HTML error page keeps its status's kind.
  const type = response.headers.get("content-type") ?? "";

  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400) ||
    (response.ok && type.includes("text/html"))
  ) {
    return { ok: false, failure: { kind: "signed-out", message: "the login expired" } };
  }

  const body: unknown = type.includes("application/json")
    ? await response.json().catch(() => UNREADABLE)
    : UNREADABLE;

  if (!response.ok) {
    const kit = check(KIT_BODY, body);

    const named = kit.ok ? KINDS.find((each) => each === kit.value.kind) : undefined;

    // Only the kit's own body, naming a kind its status carries, is the server's refusal; anything else is a status.
    const own = kit.ok && named !== undefined && STATUS[named] === response.status;
    const kind = own ? named : kindOf(response.status);

    const after =
      kind === "unavailable" ? retryAfter(response.headers.get("retry-after")) : undefined;

    if (own) {
      const path = kit.value.path;

      return {
        ok: false,
        failure: {
          kind,
          message: kit.value.message,
          refused: true,
          ...(path === undefined ? {} : { path }),
          ...(after === undefined ? {} : { retryAfterMs: after }),
        },
      };
    }

    const error = check(ERROR_BODY, body);

    return {
      ok: false,
      failure: {
        kind,
        message: error.ok ? error.value.message : `HTTP ${response.status}`,
        ...(after === undefined ? {} : { retryAfterMs: after }),
      },
    };
  }

  // A success the page can't read may still have acted: unreadable, never a refusal.
  if (body === UNREADABLE) {
    return {
      ok: false,
      failure: { kind: "unreadable", message: `reply: not JSON (HTTP ${response.status})` },
    };
  }

  const parsed = check(route.response, body);

  if (!parsed.ok) {
    return {
      ok: false,
      failure: { kind: "unreadable", message: `reply: ${parsed.error.message}` },
    };
  }

  return { ok: true, value: parsed.value };
}
