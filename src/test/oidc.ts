/**
 * An OpenID provider on loopback that approves every authorization at once: discovery, keys, and a token endpoint that
 * checks the PKCE verifier and signs an ID token for one fixed subject. For tests and local development only.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

async function body(request: IncomingMessage): Promise<string> {
  let text = "";

  for await (const chunk of request) {
    text += String(chunk);
  }

  return text;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the stand-in answers whatever JSON a case needs
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function identityProvider(
  subject = "owner"
): Promise<{ issuer: string; close: () => Promise<void> }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string; client: string }>();
  let issuer = "";

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer);

      if (url.pathname === "/.well-known/openid-configuration") {
        return json(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }

      if (url.pathname === "/jwks") {
        return json(response, 200, { keys: [jwk] });
      }

      if (url.pathname === "/authorize") {
        const code = randomBytes(16).toString("base64url");
        const query = url.searchParams;
        codes.set(code, {
          challenge: query.get("code_challenge") ?? "",
          nonce: query.get("nonce") ?? "",
          client: query.get("client_id") ?? "",
        });
        const back = new URL(query.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", query.get("state") ?? "");
        response.writeHead(302, { location: back.toString() });

        return response.end();
      }

      if (url.pathname === "/token") {
        const form = new URLSearchParams(await body(request));
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");

        const verifier = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");

        if (code === undefined || code.challenge !== verifier) {
          return json(response, 400, {});
        }

        const idToken = await new SignJWT({ nonce: code.nonce })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
          .setIssuer(issuer)
          .setSubject(subject)
          .setAudience(code.client)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey);

        return json(response, 200, { id_token: idToken, token_type: "Bearer", access_token: "-" });
      }

      json(response, 404, {});
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- server.address() is AddressInfo | string | null
  if (typeof address !== "object" || address === null) {
    throw new Error("not listening on TCP");
  }

  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
