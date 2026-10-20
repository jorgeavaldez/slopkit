/** Concurrent sign-ins: real OIDC and files, a fresh WebAuth reading them, no filesystem mocks. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { WebAuth } from "../src/server/auth.ts";
import { parseWebConfig } from "../src/server/config.ts";
import { identityProvider } from "../src/test/oidc.ts";

async function code(auth: WebAuth) {
  const login = await auth.loginUrl("http://127.0.0.1/callback");
  const answer = await fetch(login, { redirect: "manual" });
  const url = new URL(answer.headers.get("location") ?? "");

  return { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "" };
}

// Guard: shared initial-load promise and serialized map mutations/publication, across login/logout overlap.
test("all concurrent first logins remain valid now and after reopen; logout never resurrects", async () => {
  const home = await mkdtemp(join(tmpdir(), "auth-oracle-"));
  const provider = await identityProvider("someone");

  try {
    const config = parseWebConfig(
      { oidc: { issuer: provider.issuer, clientId: "test" }, allow: ["sub:someone"] },
      []
    );

    const auth = new WebAuth(config, home, {});
    const codes = await Promise.all(Array.from({ length: 8 }, () => code(auth)));
    const tokens = await Promise.all(codes.map((value) => auth.callback(value.state, value.code)));

    for (const token of tokens) {
      expect(await auth.identify(undefined, token)).toStrictEqual(["sub:someone"]);
    }

    const reopened = new WebAuth(config, home, {});

    for (const token of tokens) {
      expect(await reopened.identify(undefined, token)).toStrictEqual(["sub:someone"]);
    }

    const freshCodes = await Promise.all(Array.from({ length: 4 }, () => code(reopened)));

    const [fresh] = await Promise.all([
      Promise.all(freshCodes.map((value) => reopened.callback(value.state, value.code))),
      Promise.all(tokens.slice(0, 4).map((token) => reopened.logout(token))),
    ]);

    const final = new WebAuth(config, home, {});

    for (const token of tokens.slice(0, 4)) {
      expect(await final.identify(undefined, token)).toBeUndefined();
    }

    for (const token of [...tokens.slice(4), ...fresh]) {
      expect(await final.identify(undefined, token)).toStrictEqual(["sub:someone"]);
    }
  } finally {
    await provider.close();
    await rm(home, { recursive: true, force: true });
  }
});
