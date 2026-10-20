/**
 * Session publications never overlap, checked deterministically. `auth-publication` catches an unserialized publication only
 * when the filesystem happens to finish an older snapshot's rename last, which is schedule-dependent. This one
 * watches the home with the kernel's own record (inotify through `fs.watch`): a publication stages a new file beside
 * the session file and renames it over it, so a second staged file appearing while one is still there is two
 * publications in flight, whichever finishes last. Real OIDC and files; no mocks, no sleeps, no guessed file names.
 */
import { watch } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { WebAuth } from "../src/server/auth.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { identityProvider } from "../src/test/oidc.ts";

async function login(auth: WebAuth) {
  const url = await auth.loginUrl("http://127.0.0.1/callback");
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "");

  return await auth.callback(
    back.searchParams.get("state") ?? "",
    back.searchParams.get("code") ?? ""
  );
}

// Guard: `change` runs each mutation and its publication after every earlier one. Logouts need no network, so all
// of them start in one tick: unserialized, every staged file is created before the first is renamed.
test("changes started together publish one at a time, and the last publication holds all of them", async () => {
  const home = await mkdtemp(join(tmpdir(), "auth-serialized-"));
  const provider = await identityProvider("someone");

  try {
    const config = parseWebConfig(
      { oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
      []
    );

    const auth = new WebAuth(config, home, {});
    const tokens: string[] = [];

    for (let i = 0; i < 8; i++) {
      tokens.push(await login(auth));
    }

    const settled = new Set(await readdir(home));
    const staged = new Map<string, number>();
    let inFlight = 0;
    let most = 0;
    const { promise: seen, resolve: barrier } = Promise.withResolvers<void>();

    const watcher = watch(home, (event, name) => {
      if (event !== "rename" || name === null || settled.has(name)) {
        return;
      }

      if (name === "barrier") {
        return barrier();
      }

      // A staged file's first event is its creation, its second the rename that publishes it.
      const events = (staged.get(name) ?? 0) + 1;
      staged.set(name, events);
      inFlight += events % 2 === 1 ? 1 : -1;
      most = Math.max(most, inFlight);
    });

    try {
      await Promise.all(tokens.slice(0, 6).map((token) => auth.logout(token)));
      // inotify reports in order: once the barrier's creation arrives, every publication's events have.
      await writeFile(join(home, "barrier"), "");
      await seen;
    } finally {
      watcher.close();
    }

    expect(staged.size, "each logout published").toBeGreaterThanOrEqual(2);
    expect(most, "two session publications in flight at once").toBe(1);
    const reopened = new WebAuth(config, home, {});

    for (const token of tokens.slice(0, 6)) {
      expect(await reopened.identify(undefined, token)).toBeUndefined();
    }

    for (const token of tokens.slice(6)) {
      expect(await reopened.identify(undefined, token)).toStrictEqual(["sub:someone"]);
    }
  } finally {
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});
