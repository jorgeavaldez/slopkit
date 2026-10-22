import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { endpoint } from "../contract.ts";
import { array, literal, object, string } from "../schema.ts";
import { parseWebConfig } from "../server/config.ts";
import { addKey } from "../server/keys.ts";
import { Log, scoped } from "../server/log.ts";
import { route, serveWeb } from "../server/web.ts";
import { agentAccess, reads, refused } from "../test/agents.ts";
import { identityProvider } from "../test/oidc.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close();
  }
});

const list = endpoint("GET", "/api/list", object({}), object({ items: array(string()) }));

const grade = endpoint(
  "POST",
  "/api/grade",
  object({ item: string() }),
  object({ ok: literal(true) })
);

const push = endpoint(
  "POST",
  "/api/push",
  object({ item: string() }),
  object({ outcome: literal("done", "forbidden") })
);

/** An app on loopback with one key: `person` says which of its routes only a person's login may call. */
async function app(person: { list: boolean; grade: boolean }) {
  const home = await mkdtemp(join(tmpdir(), "agent-access-"));
  const provider = await identityProvider("owner");
  const token = await addKey(home, "agent");

  const server = await serveWeb({
    home,
    config: parseWebConfig(
      {
        port: 0,
        oidc: { issuer: provider.issuer, clientId: "test" },
        allow: ["sub:owner", "key:agent"],
      },
      []
    ),
    env: {},
    log: scoped(new Log(home, "test", { echo: false }), "web"),
    assets: home,
    manifest: {},
    cookie: "app_session",
    routes: [
      route({ ...list, person: person.list }, () => ({ items: ["a"] })),
      route({ ...grade, person: person.grade }, () => ({ ok: true as const })),
      route(push, (_request, caller) => ({ outcome: caller.person ? "done" : "forbidden" })),
    ],
  });

  cleanups.push(async () => {
    await server.close();
    await provider.close();
    await rm(home, { recursive: true, force: true });
  });

  return { url: server.url, token };
}

const cases = {
  reads: [reads(list, {})],
  refused: [
    refused(grade, { item: "a" }),
    refused(push, { item: "a" }, { refusal: (reply) => reply.outcome === "forbidden" }),
  ],
};

test("an app whose key reads its agents' calls and is refused the person's passes", async () => {
  const running = await app({ list: false, grade: true });

  await expect(agentAccess({ ...running, ...cases })).resolves.toBeUndefined();
});

test("a person's call a key can make fails, naming it", async () => {
  const running = await app({ list: false, grade: false });

  await expect(agentAccess({ ...running, ...cases })).rejects.toThrow(
    "POST /api/grade: a key should be refused, got an answer"
  );
});

test("an agent's read a key can't make fails, naming it", async () => {
  const running = await app({ list: true, grade: true });

  await expect(agentAccess({ ...running, ...cases })).rejects.toThrow(
    "GET /api/list: a key should read it, got forbidden"
  );
});

test("a check with nothing to read or nothing refused proves nothing and fails", async () => {
  const running = await app({ list: false, grade: true });

  await expect(agentAccess({ ...running, reads: [], refused: cases.refused })).rejects.toThrow(
    "proves nothing"
  );
});
