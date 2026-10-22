/**
 * Agent access, checked on an app's real server: the app lists what its agents read with a key and what only the
 * person may do, and `agentAccess` proves over HTTP, as an agent calls it (a bearer key, no Origin, no login), that:
 *
 * - the key reads each `reads` case, and the reply is the contract's;
 * - none of those reads is public: without credentials it's `signed-out`, with an unknown key `forbidden`;
 * - the key is refused each `refused` case: `forbidden`, or a reply the case judges a refusal (a sync push answers
 *   each command it refuses with a receipt).
 *
 * Every failure is collected and thrown together, so one run shows the whole gap.
 */
import { call } from "../contract.ts";
import type { Endpoint, Result } from "../contract.ts";

export type AgentCase = {
  name: string;
  check: (base: string, token: string) => Promise<string[]>;
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const said = <T>(result: Result<T>) =>
  result.ok ? "an answer" : `${result.failure.kind}: ${result.failure.message}`;

/** A call an agent's key makes and gets answered. */
export function reads<Req, Res>(
  endpoint: Endpoint<Req, Res>,
  input: Req,
  name?: string
): AgentCase {
  const named = name ?? `${endpoint.method} ${endpoint.path}`;

  return {
    name: named,
    check: async (base, token) => {
      const failures: string[] = [];
      const read = await call(endpoint, input, { base, headers: bearer(token) });

      if (!read.ok) {
        failures.push(`${named}: a key should read it, got ${said(read)}`);
      }

      const anonymous = await call(endpoint, input, { base });

      if (anonymous.ok || anonymous.failure.kind !== "signed-out") {
        failures.push(
          `${named}: without credentials it should be signed-out, got ${said(anonymous)}`
        );
      }

      const unknown = await call(endpoint, input, { base, headers: bearer("nobody.not-a-key") });

      if (unknown.ok || unknown.failure.kind !== "forbidden") {
        failures.push(`${named}: an unknown key should be forbidden, got ${said(unknown)}`);
      }

      return failures;
    },
  };
}

/** A call only the person may make: the key gets `forbidden`, or an answer `refusal` judges a refusal. */
export function refused<Req, Res>(
  endpoint: Endpoint<Req, Res>,
  input: Req,
  options: { name?: string; refusal?: (reply: Res) => boolean } = {}
): AgentCase {
  const named = options.name ?? `${endpoint.method} ${endpoint.path}`;

  return {
    name: named,
    check: async (base, token) => {
      const result = await call(endpoint, input, { base, headers: bearer(token) });

      const refusal = result.ok
        ? options.refusal?.(result.value) === true
        : result.failure.kind === "forbidden";

      return refusal ? [] : [`${named}: a key should be refused, got ${said(result)}`];
    },
  };
}

/** Run every case against the app at `url` with an allowed key's `token`; throws listing every failure. */
export async function agentAccess(options: {
  url: string;
  token: string;
  reads: readonly AgentCase[];
  refused: readonly AgentCase[];
}): Promise<void> {
  if (options.reads.length === 0 || options.refused.length === 0) {
    throw new Error(
      "agentAccess: name at least one read and one refused call, or it proves nothing"
    );
  }

  const base = options.url.replace(/\/$/, "");

  const failures = (
    await Promise.all(
      [...options.reads, ...options.refused].map((each) => each.check(base, options.token))
    )
  ).flat();

  if (failures.length > 0) {
    throw new Error(`agent access:\n${failures.map((line) => `- ${line}`).join("\n")}`);
  }
}
