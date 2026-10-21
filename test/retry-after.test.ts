import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { call, endpoint, RETRY_AFTER_MAX_MS } from "../src/contract.ts";
import { object } from "../src/schema.ts";

let base = "";

const web = createServer((request, response) => {
  const path = (request.url ?? "").split("?")[0];
  const huge = path === "/huge";
  response.writeHead(503, {
    "content-type": "application/json",
    "retry-after": huge ? "999999999" : "120",
  });
  response.end(
    JSON.stringify(path === "/kit" ? { kind: "unavailable", message: "busy" } : { message: "busy" })
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    web.listen(0, "127.0.0.1", resolve);
  });
  const address = web.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- node's public address() union includes Unix sockets
  if (address === null || typeof address === "string") {
    throw new Error("no loopback address");
  }

  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    web.close(() => {
      resolve();
    });
  });
});

const get = (path: string) => call(endpoint("GET", path, object({}), object({})), {}, { base });

describe("Retry-After", () => {
  test("the kit's own unavailable refusal keeps its Retry-After", async () => {
    const result = await get("/kit");
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "unavailable", retryAfterMs: 120_000 },
    });
  });

  test("a Retry-After past the cap waits the cap, never longer", async () => {
    const result = await get("/huge");
    expect(result).toMatchObject({ ok: false, failure: { retryAfterMs: RETRY_AFTER_MAX_MS } });
    expect(RETRY_AFTER_MAX_MS).toBe(3_600_000);
  });
});
