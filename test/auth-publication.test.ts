/** Session publication with a warm session map: real OIDC and files, no replacement of fs or auth internals. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { WebAuth } from "../src/server/auth.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { identityProvider } from "../src/test/oidc.ts";

async function authorization(auth: WebAuth) {
  const url = await auth.loginUrl("http://127.0.0.1/callback");
  const response = await fetch(url, { redirect: "manual" });
  const back = new URL(response.headers.get("location") ?? "");

  return { state: back.searchParams.get("state") ?? "", code: back.searchParams.get("code") ?? "" };
}

// Guard: serialize mutations THROUGH durable file publication. A shared warm map alone cannot order rename results.
// Expectations are successful callback tokens minus completed logouts, not the implementation's session file/map.
// The cold-load optimization is deliberately NOT what this trace tests: first seed a single completed login.
test("overlapping warm-map logins/logouts never publish an older snapshot last", async () => {
  const home = await mkdtemp(join(tmpdir(), "auth-publication-"));
  const provider = await identityProvider("someone");

  try {
    const config = parseWebConfig(
      { oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
      []
    );

    const auth = new WebAuth(config, home, {});
    const first = await authorization(auth);
    let live = [await auth.callback(first.state, first.code)];
    const revoked: string[] = [];

    // Bounded real-I/O race pressure. Native probe reproduced a missing successful token by wave seven (~1.8s).
    // No sleeps, forced private interleaving, guessed on-disk representation or probabilistic expected results.
    for (let wave = 0; wave < 16; wave++) {
      const codes = await Promise.all(Array.from({ length: 64 }, () => authorization(auth)));
      const removing = live.slice(0, Math.floor(live.length / 2));
      const keeping = live.slice(removing.length);
      const additions = Promise.all(codes.map(({ state, code }) => auth.callback(state, code)));
      await Promise.all([additions, Promise.all(removing.map((token) => auth.logout(token)))]);
      live = [...keeping, ...(await additions)];
      revoked.push(...removing);
      const reopened = new WebAuth(config, home, {});

      for (const token of live) {
        expect(
          await auth.identify(undefined, token),
          `wave ${wave}: live token missing in memory`
        ).toStrictEqual(["sub:someone"]);
        expect(
          await reopened.identify(undefined, token),
          `wave ${wave}: successful callback missing after reopen (older snapshot published last)`
        ).toStrictEqual(["sub:someone"]);
      }

      for (const token of revoked) {
        expect(
          await auth.identify(undefined, token),
          `wave ${wave}: logout resurrected in memory`
        ).toBeUndefined();
        expect(
          await reopened.identify(undefined, token),
          `wave ${wave}: completed logout resurrected after reopen`
        ).toBeUndefined();
      }
    }
  } finally {
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
