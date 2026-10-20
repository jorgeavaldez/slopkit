/** Session file recovery: malformed JSON signs out; an I/O failure must not turn intact sessions into none. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { WebAuth } from "../src/server/auth.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { identityProvider } from "../src/test/oidc.ts";

async function authorization(auth: WebAuth) {
  const response = await fetch(await auth.loginUrl("http://127.0.0.1/callback"), {
    redirect: "manual",
  });

  const back = new URL(response.headers.get("location") ?? "");

  return { state: back.searchParams.get("state") ?? "", code: back.searchParams.get("code") ?? "" };
}

type Seeded = {
  config: ReturnType<typeof parseWebConfig>;
  home: string;
  path: string;
  token: string;
  original: Buffer;
};

/** A home with one real signed-in session, written by a successful callback under the released filename. */
async function withSession(run: (seeded: Seeded) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "auth-corruption-"));
  const provider = await identityProvider("someone");

  try {
    const config = parseWebConfig(
      { oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
      []
    );

    const seed = new WebAuth(config, home, {});
    const initial = await authorization(seed);
    const token = await seed.callback(initial.state, initial.code);
    const path = join(home, "web-sessions.json");
    await run({ config, home, path, token, original: await readFile(path) });
  } finally {
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
}

// Guard: malformed JSON is an explicit sign-out/reset policy; I/O failure rejects and preserves the source.
test("malformed sessions JSON signs everyone out, and the next sign-in writes a readable file", () =>
  withSession(async ({ config, home, path, token }) => {
    const broken = "{ this is not valid sessions JSON";
    await writeFile(path, broken);
    const reopened = new WebAuth(config, home, {});
    // Approved liveness policy: unreadable JSON has no recoverable sessions; sign in again without hand repair.
    expect(await reopened.identify(undefined, token)).toBeUndefined();
    const login = await authorization(reopened);
    const nextToken = await reopened.callback(login.state, login.code);
    const persisted = await readFile(path, "utf-8");
    expect(persisted).not.toBe(broken);
    expect(() => {
      JSON.parse(persisted);
    }).not.toThrow();
    const fresh = new WebAuth(config, home, {});
    expect(await fresh.identify(undefined, nextToken)).toStrictEqual(["sub:someone"]);
    expect(await fresh.identify(undefined, token)).toBeUndefined();
  }));

test("an unreadable sessions path fails sign-in and keeps the sessions it can't read", () =>
  withSession(async ({ config, home, path, token, original }) => {
    await rm(path);
    await mkdir(path);
    const reopened = new WebAuth(config, home, {});
    await expect(reopened.identify(undefined, token)).rejects.toThrow("EISDIR");
    const login = await authorization(reopened);
    await expect(reopened.callback(login.state, login.code)).rejects.toThrow("EISDIR");
    expect((await stat(path)).isDirectory()).toBe(true);
    // A repair + restart reads the original successful session; no empty rewrite has destroyed its recovery source.
    await rm(path, { recursive: true });
    await writeFile(path, original);
    expect(await new WebAuth(config, home, {}).identify(undefined, token)).toStrictEqual([
      "sub:someone",
    ]);
  }));
