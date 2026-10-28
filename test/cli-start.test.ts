import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { array, literal, object, string } from "../src/schema.ts";
import type { Schema } from "../src/schema.ts";
import { running } from "../src/server/cli.ts";
import type { Served } from "../src/server/cli.ts";
import {
  cleanup,
  directory,
  installed,
  mirror,
  pack,
  VERSION_ONE,
  VERSION_TWO,
} from "./cli-fixture.ts";
import type { Release } from "./cli-fixture.ts";

let first: Release;
let releases: Awaited<ReturnType<typeof mirror>>;

beforeAll(async () => {
  const home = await directory();
  first = await pack(home, VERSION_ONE);
  const second = await pack(home, VERSION_TWO);
  releases = await mirror(new Map([[`v${VERSION_TWO}`, second]]));
}, 60_000);

afterAll(async () => {
  await releases?.close();
  await cleanup();
});

// Kept uncalled: a missing start is a compile-time error, while both callback return forms are accepted.
function servedContract() {
  // @ts-expect-error every newly built app must provide its own work's start
  const missing: Served = { close: async () => {} };
  const synchronous = { start: () => {}, close: async () => {} };
  const asynchronous = { start: async () => {}, close: async () => {} };
  const accepted: Served[] = [synchronous, asynchronous];

  return { missing, accepted };
}

void servedContract;

type WorkConfig = {
  proof?: string;
  startProvider?: string;
  startProof?: string;
  startPort?: number;
  startFailure?: "throw" | "reject";
};

async function configure(home: string, value: WorkConfig) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify(value));
}

const startRecord = object({ version: string(), home: string() });

async function records<T>(path: string, schema: Schema<T>): Promise<T[]> {
  return (await readFile(path, "utf-8"))
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)));
}

/** Real loopback provider; a held answer proves readiness waits for asynchronous app work. */
async function provider(hold = false) {
  const calls: { version: string; home: string }[] = [];
  const entered = Promise.withResolvers<void>();
  const pending = new Set<ServerResponse>();

  const release = () => {
    for (const response of pending) {
      response.end("started");
    }

    pending.clear();
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    calls.push(
      object({ version: string(), home: string() }).parse({
        version: url.searchParams.get("version"),
        home: url.searchParams.get("home"),
      })
    );
    entered.resolve();

    if (hold) {
      pending.add(response);
    } else {
      response.end("started");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address union is checked at this loopback boundary
  if (address === null || typeof address === "string") {
    throw new Error("provider has no TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/work`,
    calls,
    entered: entered.promise,
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** A live service owns a fixed port throughout an install's check. */
async function liveListener() {
  const server = createServer((_request, response) => {
    response.end("live listener");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address union is checked at this loopback boundary
  if (address === null || typeof address === "string") {
    throw new Error("live listener has no TCP address");
  }

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

test("real serve awaits app start before ready and runs its outbound work once", async () => {
  const h = await installed(first, releases.url);
  const work = await provider(true);
  const proof = join(h.base, "started.jsonl");
  await configure(h.home, { startProvider: work.url, startProof: proof });
  const child = h.start();

  try {
    const firstEvent = await Promise.race([
      work.entered.then(() => "work"),
      child.line(/^notebook ready/).then(() => "ready"),
    ]);

    expect(firstEvent).toBe("work");
    expect(child.output()).not.toMatch(/^notebook ready/m);
    expect(existsSync(proof)).toBe(false);
    work.release();
    await child.line(/^notebook ready/);
    expect(await records(proof, startRecord)).toStrictEqual([
      { version: VERSION_ONE, home: h.home },
    ]);
    expect(work.calls).toStrictEqual([{ version: VERSION_ONE, home: h.home }]);
  } finally {
    work.release();
    await child.stop();
    await work.close();
  }
});

test.each(["throw", "reject"] as const)(
  "a start that will %s closes the opened app and exits nonzero without ready",
  async (startFailure) => {
    const h = await installed(first, releases.url);
    await configure(h.home, { startFailure });
    const child = h.start();

    try {
      // rc.6 wrongly becomes ready and stays up. Stop it on that observable failure, never on a sleep.
      const result = await Promise.race([
        child.finished,
        child.line(/^notebook ready/).then(() => child.stop()),
      ]);

      expect.soft(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect.soft(result.out).not.toMatch(/^notebook ready/m);

      const events = await records(
        join(h.home, "events.jsonl"),
        object({ event: literal("close") })
      );

      expect(events).toStrictEqual([{ event: "close" }]);
      expect(running(h.home)).toBe(false);
      expect(existsSync(join(h.home, "serving.json"))).toBe(false);
      expect((await h.run(["seed", "after-failure", "store closed"])).code).toBe(0);
    } finally {
      await child.stop();
    }
  }
);

test.each(["update", "rollback", "crashed"] as const)(
  "%s checks copied data without app work or a second listener; real serve starts that same work",
  async (operation) => {
    const h = await installed(first, releases.url);
    expect((await h.run(["seed", "saved", "original"])).code).toBe(0);

    if (operation !== "update") {
      const prepared = await h.run(["update", VERSION_TWO]);

      if (prepared.code !== 0) {
        throw new Error(prepared.out + prepared.err);
      }
    }

    const work = await provider();
    const live = await liveListener();
    let liveOpen = true;
    const proof = join(h.base, "opened.jsonl");
    const started = join(h.base, "started.jsonl");
    const version = operation === "update" ? VERSION_TWO : VERSION_ONE;
    await configure(h.home, {
      proof,
      startProvider: work.url,
      startProof: started,
      startPort: live.port,
    });
    let child: ReturnType<typeof h.start> | undefined;

    try {
      const result = await h.run(
        operation === "update"
          ? ["update", VERSION_TWO]
          : operation === "crashed"
            ? ["rollback", "--crashed"]
            : ["rollback"],
        { MONITOR_SERVICE_RESULT: "exit-code" }
      );

      expect(result.code).toBe(0);
      expect((await h.package()).version).toBe(version);

      const opened = await records(
        proof,
        object({
          version: string(),
          home: string(),
          rows: array(object({ id: string(), value: string() })),
        })
      );

      expect(opened).toHaveLength(1);
      expect(opened[0]?.version).toBe(version);
      expect(opened[0]?.home).not.toBe(h.home);
      expect(opened[0]?.rows).toStrictEqual([{ id: "saved", value: "original" }]);
      expect(work.calls).toStrictEqual([]);
      expect(existsSync(started)).toBe(false);
      expect(await (await fetch(live.url)).text()).toBe("live listener");

      // Positive control: the very same release and config must do this work in a real serve.
      await live.close();
      liveOpen = false;
      child = h.start();
      await child.line(/^notebook ready/);
      expect(work.calls).toStrictEqual([{ version, home: h.home }]);
      expect(await records(started, startRecord)).toStrictEqual([{ version, home: h.home }]);
      expect(await (await fetch(live.url)).text()).toBe(`app work listener ${version}`);
    } finally {
      await child?.stop();
      await work.close();

      if (liveOpen) {
        await live.close();
      }
    }
  }
);
