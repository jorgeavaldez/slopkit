import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { array, literal, nullable, object, string } from "../src/schema.ts";
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
  holdStart?: boolean;
  environmentProof?: string;
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

async function heldStart() {
  const h = await installed(first, releases.url);
  await configure(h.home, { holdStart: true });
  const child = h.start();
  const held = await child.line(/^fixture start held · /);
  const url = string({ min: 1 }).parse(held.split(" · ")[1]);

  return { h, child, url };
}

// The kit may already have closed the listener. Releasing a still-open gate also lets a broken guard finish,
// exposing its erroneous ready line instead of turning this regression into a timeout.
async function releaseStart(url: string) {
  await fetch(new URL("/gate", url), { method: "POST" }).catch(() => undefined);
}

const startupClose = object({ event: literal("close"), serving: literal(false) });

test("SIGTERM during held start closes without ready or a serving record, exits zero and releases the lock", async () => {
  const { h, child, url } = await heldStart();

  try {
    expect(child.child.kill("SIGTERM")).toBe(true);
    // This fixture's observer acknowledges signal delivery, not a delay guessed to be long enough.
    await child.line(/^fixture stop noticed$/);
    await releaseStart(url);
    const result = await child.finished;

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.out).not.toMatch(/^notebook ready/m);
    expect(await records(join(h.home, "events.jsonl"), startupClose)).toStrictEqual([
      { event: "close", serving: false },
    ]);
    expect(existsSync(join(h.home, "serving.json"))).toBe(false);
    expect(running(h.home)).toBe(false);
    expect((await h.run(["seed", "after-stop", "store closed"])).code).toBe(0);
  } finally {
    await child.stop("SIGKILL");
  }
});

test("an app update during held start closes without first publishing ready or a serving record", async () => {
  const { h, child, url } = await heldStart();

  try {
    const requested = await fetch(new URL("/stop-start", url), { method: "POST" });
    expect(await requested.text()).toBe("update requested");
    await releaseStart(url);
    await child.line(/^fixture held start closed$/);
    // update() may reexecute immediately: only the stopped invocation's output and close are judged here.
    const beforeRestart = child.output().split("fixture held start closed")[0];

    expect(beforeRestart).not.toMatch(/^notebook ready/m);
    const closed = await records(join(h.home, "events.jsonl"), startupClose);
    expect(closed[0]).toStrictEqual({ event: "close", serving: false });
  } finally {
    await child.stop("SIGKILL");
  }
});

test("a boot-check mark for another home cannot suppress real work and is hidden from serve and start, including checks", async () => {
  const h = await installed(first, releases.url);
  const stray = await directory();
  const environmentProof = join(h.base, "environment.jsonl");
  const startProof = join(h.base, "started.jsonl");
  const work = await provider();
  await configure(h.home, { environmentProof, startProof, startProvider: work.url });
  const child = h.start({ SLOPKIT_BOOT_CHECK: stray });

  const observation = object({
    phase: literal("serve", "start"),
    version: string(),
    home: string(),
    mark: nullable(string()),
    contextMark: nullable(string()),
  });

  try {
    await child.line(/^notebook ready/);
    expect(work.calls).toStrictEqual([{ version: VERSION_ONE, home: h.home }]);
    expect(await records(startProof, startRecord)).toStrictEqual([
      { version: VERSION_ONE, home: h.home },
    ]);
    expect(await records(environmentProof, observation)).toStrictEqual([
      { phase: "serve", version: VERSION_ONE, home: h.home, mark: null, contextMark: null },
      { phase: "start", version: VERSION_ONE, home: h.home, mark: null, contextMark: null },
    ]);
    expect((await child.stop()).code).toBe(0);
    expect((await h.run(["update", VERSION_TWO], { SLOPKIT_BOOT_CHECK: stray })).code).toBe(0);
    const observations = await records(environmentProof, observation);

    expect(observations).toHaveLength(3);
    expect(observations[2]).toMatchObject({
      phase: "serve",
      version: VERSION_TWO,
      mark: null,
      contextMark: null,
    });
    expect(observations[2]?.home).not.toBe(h.home);
    expect(work.calls).toStrictEqual([{ version: VERSION_ONE, home: h.home }]);
    expect(await records(startProof, startRecord)).toStrictEqual([
      { version: VERSION_ONE, home: h.home },
    ]);
  } finally {
    await child.stop();
    await work.close();
  }
});
