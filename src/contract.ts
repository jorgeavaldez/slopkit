/**
 * HTTP contracts: each endpoint is one value naming its method, path, request and response schemas, shared by the
 * server (which checks requests and its own replies) and the page (which checks replies, since a proxy in between can
 * answer anything, such as an HTML login page). Failures are a closed set of kinds; a caller handles each by kind.
 */
import { check, object, string } from "./schema.ts";
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
 * not allowed. `invalid`: the request or the reply broke the contract. `conflict`: refused for the current state.
 * `upstream`: a service behind the server failed. `unavailable`: the server is up but can't now. `offline`: no answer.
 */
export type Failure = {
  kind:
    | "signed-out"
    | "forbidden"
    | "invalid"
    | "conflict"
    | "upstream"
    | "unavailable"
    | "offline";
  message: string;
};

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export const STATUS: Record<Failure["kind"], number> = {
  "signed-out": 401,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  upstream: 502,
  unavailable: 503,
  offline: 503,
};

/** A failure's body, as `serveWeb` answers it: its message is shown when there is one. */
const ERROR_BODY = object({ message: string() });

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

  if (status === 502 || status === 504) {
    return "upstream";
  }

  if (status >= 500) {
    return "unavailable";
  }

  return "invalid";
}

/** GET requests carry their input as one `q` query parameter of JSON; POST as the body. */
export function encodeUrl<Req>(route: Endpoint<Req, unknown>, request: Req): string {
  if (route.method === "POST") {
    return route.path;
  }

  return `${route.path}?q=${encodeURIComponent(JSON.stringify(request))}`;
}

/**
 * Call an endpoint from a browser (or any fetch). Every outcome is a `Result`: thrown errors, non-JSON answers (a
 * proxy's login page means signed out), error statuses and replies that break the schema all become a `Failure`.
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

  // A redirect (an opaque one, in a browser) or an HTML page is a proxy sending the browser to sign in.
  const type = response.headers.get("content-type") ?? "";

  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400) ||
    type.includes("text/html")
  ) {
    return { ok: false, failure: { kind: "signed-out", message: "the login expired" } };
  }

  const body: unknown = type.includes("application/json")
    ? await response.json().catch(() => undefined)
    : undefined;

  if (!response.ok) {
    const error = check(ERROR_BODY, body);

    return {
      ok: false,
      failure: {
        kind: kindOf(response.status),
        message: error.ok ? error.value.message : `HTTP ${response.status}`,
      },
    };
  }

  const parsed = check(route.response, body);

  if (!parsed.ok) {
    return { ok: false, failure: { kind: "invalid", message: `reply: ${parsed.error.message}` } };
  }

  return { ok: true, value: parsed.value };
}
