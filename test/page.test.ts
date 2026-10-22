/** Contract choices where no shape/error text is prescribed:
 * - web is the parsed WebConfig accepted by serveSync; due/jobs may be synchronous.
 * - lookups are exact for strings; duplicate or missing names must reject, never pick arbitrarily.
 * - type replaces the input value in one edit, rather than issuing per-keystroke commands.
 * - settle's idle horizon follows the clock as timeouts re-arm; intervals alone do not advance it.
 * - both a Map's keys and values count as reached view data (view-problems.test.ts).
 * Error assertions only pin the spec's words, not a driver's incidental diagnostics.
 */
import { afterEach, expect, test } from "vitest";

import { MEANINGS } from "../src/states.ts";
import { openPage } from "../src/test/page.ts";
import type * as Entry from "./page-fixture/page.ts";
import { startServer } from "./page-fixture/server.ts";
import type { ServerInput } from "./page-fixture/server.ts";

const at = "2026-10-21T12:00:00-04:00";
let page: Awaited<ReturnType<typeof openPage>> | undefined;
let server: Awaited<ReturnType<typeof startServer>>;

afterEach(async () => {
  await page?.close();
  page = undefined;
});

async function open(idle?: number, path?: string) {
  page = await openPage({
    server: async (options: ServerInput) => {
      server = await startServer(options);

      return server;
    },
    page: () => import("./page-fixture/page.ts"),
    read: (entry: typeof Entry) => ({
      shown: entry.screen.value,
      model: entry.model.value,
    }),
    at,
    order: MEANINGS,
    viewport: { width: 412, height: 915 },
    ...(idle === undefined ? {} : { idle }),
    ...(path === undefined ? {} : { path }),
  });

  return page;
}

test("press sends only the real button's command and settle waits for its durable effect", async () => {
  const p = await open();
  expect(server.received).toStrictEqual([]);
  expect(p.text("viewport")).toBe("412x915");
  expect(server.now()).toBe(Date.parse(at));
  await p.press("send x");
  expect(server.received.map((each) => each.command)).toStrictEqual([
    { name: "put", id: "x", value: 9 },
  ]);
  expect(server.store.rows("history").find((row) => row.id === "x")?.value).toBe(9);
  expect(p.text("transactions")).toContain("x:9");
  expect(p.text("transactions")).not.toContain("long:2");
});

test("accessible names support aria-label, labels, nested labels, text, regex, and links", async () => {
  const p = await open();
  await p.press(/^send x twice$/);
  await p.press("send by link");
  await p.type("direct input", "direct");
  await p.select("credit account", "b");
  expect(server.received.map((each) => each.command.id)).toStrictEqual([
    "long",
    "linked",
    "direct",
    "account-b",
  ]);
  expect(p.text("transactions")).toContain("account-b:8");
  expect(p.text()).toContain("seed:42");
  await expect(p.press("send")).rejects.toThrow(Error);
  await expect(p.press(/send/)).rejects.toThrow(Error);
  await expect(p.type("missing input", "x")).rejects.toThrow(Error);
});

test("default settle waits through the 600 ms debounce without a sleep or explicit advance", async () => {
  const p = await open();
  const before = server.now();
  await p.type("find item", "debounced");
  expect(server.received.map((each) => each.command)).toStrictEqual([
    { name: "put", id: "debounced", value: 6 },
  ]);
  expect(server.received[0]?.now).toBe(before + 600);
  expect(server.received[0]?.date).toBe(before + 600);
  expect(p.text("transactions")).toContain("debounced:6");
});

test("idle can be bounded below a debounce; only advance reaches it", async () => {
  const p = await open(0);
  const before = server.now();
  await p.type("find item", "old");
  await p.type("find item", "new");
  await p.settle();
  expect(server.now()).toBe(before);
  expect(server.received).toStrictEqual([]);
  await p.advance(599);
  expect(server.received).toStrictEqual([]);
  await p.advance(1);
  expect(server.received.map((each) => each.command.id)).toStrictEqual(["new"]);
  expect(server.now()).toBe(before + 600);
  expect(p.text("transactions")).toContain("new:6");
});

test("settle does not run a timeout beyond idle; advance moves Date and Date.now", async () => {
  const p = await open();
  const before = server.now();
  await p.press("arm far timer");
  await p.settle();
  expect(server.now()).toBe(before);
  expect(p.text("timer")).toBe("not yet");
  await p.advance(6000);
  expect(p.text("timer")).toBe(new Date(before + 6000).toISOString());
  expect(server.now()).toBe(before + 6000);
  expect(p.text("page clock")).toBe(`${before + 6000}:${new Date(before + 6000).toISOString()}`);
});

test("server timeouts and clears share the page clock; real network I/O still completes", async () => {
  const p = await open();
  const before = server.now();
  server.serverTimeout(600);
  const cancelled = server.serverTimeout(300);
  clearTimeout(cancelled);
  await p.settle();
  expect(server.serverTimers).toStrictEqual([`timeout:${before + 600}`]);
  expect(server.now()).toBe(before + 600);
  await p.press("probe identity");
  expect(p.text("identity")).toContain("200:");
  expect(p.text("identity")).toContain(`"now":${before + 600}`);
  expect(p.text("identity")).toContain(`"date":${before + 600}`);
});

test("crossed page and server intervals run once, at the end, and clears stop them", async () => {
  const p = await open();
  await p.press("start interval");
  expect(p.text("ticks")).toBe("0");
  const before = server.now();
  const interval = server.serverInterval(100);
  await p.advance(1000);
  expect(p.text("ticks")).toBe("1");
  expect(server.serverTimers).toStrictEqual([`interval:${before + 1000}`]);
  await p.settle();
  expect(p.text("ticks")).toBe("1");
  clearInterval(interval);
  await p.press("stop interval");
  await p.advance(1000);
  expect(p.text("ticks")).toBe("1");
  expect(server.serverTimers).toHaveLength(1);
});

test("timeouts crossed during advance run at their scheduled instants", async () => {
  const p = await open(0);
  const before = server.now();
  server.serverTimeout(200);
  server.serverTimeout(400);
  await p.advance(1000);
  expect(server.serverTimers).toStrictEqual([`timeout:${before + 200}`, `timeout:${before + 400}`]);
  expect(server.now()).toBe(before + 1000);
});

test("settle runs due jobs and waits through the resulting socket/pull before reading the view", async () => {
  const p = await open();
  await p.press("check now");
  expect(server.jobs()).toStrictEqual([]);
  expect(server.store.rows("history").find((row) => row.id === "work")?.value).toBe(1);
  expect(p.text("transactions")).toContain("work:1");
  expect(p.text("statuses")).toBe("checked");
  const shown = await p.settle();
  expect(shown.problems).toStrictEqual([]);
  expect(shown.lines).toStrictEqual(p.lines());
  expect(p.lines()).toStrictEqual([
    expect.objectContaining({
      subject: "item:work",
      kind: "ready",
      meaning: "ok",
      text: "checked",
      owed: null,
    }),
  ]);
});

test("a future job never justifies a working line; normal settle throws and lenient reports it", async () => {
  const p = await open();
  await expect(p.press("pretend to check tomorrow")).rejects.toThrow(
    /owes job check:future, which isn't under way/
  );
  const shown = await p.settle({ lenient: true });
  expect(shown.problems).toStrictEqual([
    'item:future.working says "working" (working) but owes job check:future, which isn\'t under way',
  ]);
  expect(p.lines()).toStrictEqual([
    expect.objectContaining({
      subject: "item:future",
      meaning: "working",
      owed: { job: { kind: "check", key: "future" } },
    }),
  ]);
  await expect(p.settle()).rejects.toThrow(/owes job check:future/);
});

test("a near-future job runs only when the clock reaches it, including during idle waiting", async () => {
  const p = await open();
  const before = server.now();
  server.ask("external", before + 600);
  server.serverTimeout(600);
  await p.settle();
  expect(server.jobs()).toStrictEqual([]);
  expect(server.store.rows("history").find((row) => row.id === "external")?.value).toBe(1);
  expect(p.text("transactions")).toContain("external:1");
});

test("the stand-in logs in as owner, signOut yields 401, and signIn restores the session", async () => {
  const p = await open();
  expect(server.web.bind).toBe("127.0.0.1");
  expect(server.web.port).toBe(0);
  expect(server.web.allow).toStrictEqual(["sub:owner"]);
  expect(new URL(server.web.oidc?.issuer ?? "").hostname).toBe("127.0.0.1");
  await p.press("send x");
  expect(server.received[0]).toMatchObject({ identities: ["sub:owner"], person: true });
  await p.signOut();
  await p.press("probe identity");
  expect(p.text("identity")).toMatch(/^401:/);
  await p.signIn();
  await p.press("probe identity");
  expect(p.text("identity")).toContain("200:");
  expect(p.text("identity")).toContain('"sub:owner"');
});

test("reload is a fresh page on the same IndexedDB; signed-out reload keeps rows, no new-device reset", async () => {
  const p = await open();
  await p.press("send x");
  await p.press("start interval");
  await p.advance(100);
  expect(p.text("ticks")).toBe("1");
  await p.signOut();
  const pullsBefore = server.pulls.length;
  await p.reload();
  expect(p.text("ticks")).toBe("0");
  expect(p.text("transactions")).toContain("seed:42");
  expect(p.text("transactions")).toContain("x:9");
  await p.press("probe identity");
  expect(p.text("identity")).toMatch(/^401:/);
  await p.signIn();
  await p.settle();

  for (const pull of server.pulls.slice(pullsBefore)) {
    expect(pull.dataset).not.toBeNull();
    expect(pull.since).toBeGreaterThan(0);
  }
});

test("a timeout that re-arms inside idle hits the bounded settle and names the busy timer", async () => {
  const p = await open();
  await expect(p.press("start endless timer")).rejects.toThrow(
    /never settles.*(?:timer|timeout|ping)|(?:timer|timeout|ping).*never settles/is
  );
});

test.each(["throw page error", "reject page promise"])(
  "page failure fails the action's next settle: %s",
  async (name) => {
    const p = await open();
    await expect(p.press(name)).rejects.toThrow(
      name === "throw page error" ? /fixture page exploded/ : /fixture rejection/
    );
  }
);

test("reload with device new starts an empty IndexedDB on the same server and session", async () => {
  const p = await open();
  await p.press("send x");
  const pullsBefore = server.pulls.length;
  await p.reload({ device: "new" });
  expect(
    server.pulls.slice(pullsBefore).some((pull) => pull.dataset === null && pull.since === 0)
  ).toBe(true);
  expect(p.text("transactions")).toContain("x:9");
  await p.press("probe identity");
  expect(p.text("identity")).toContain("200:");
  expect(p.text("identity")).toContain('"sub:owner"');
});

test("one page at a time; close releases the slot and stops its server", async () => {
  const p = await open();
  const oldUrl = server.url;
  await expect(
    openPage({
      server: async () => server,
      page: () => import("./page-fixture/page.ts"),
      read: (entry: typeof Entry) => ({
        shown: entry.screen.value,
        model: entry.model.value,
      }),
      at,
      order: MEANINGS,
    })
  ).rejects.toThrow(Error);
  await p.close();
  page = undefined;
  await expect(fetch(oldUrl)).rejects.toThrow(Error);
  const second = await open();
  expect(second.text("transactions")).toContain("seed:42");
});

function location(p: Awaited<ReturnType<typeof openPage>>): string {
  const current: typeof p & { location?: () => string } = p;

  if (!current.location) {
    throw new Error("page.location is not available");
  }

  return current.location();
}

async function back(p: Awaited<ReturnType<typeof openPage>>) {
  const current: typeof p & { back?: () => void | Promise<void> } = p;

  if (!current.back) {
    throw new Error("page.back is not available");
  }

  await current.back();
  await p.settle();
}

test("a deep link loads its path, query and fragment before the page reads its address", async () => {
  const p = await open(undefined, "/items?item=a#details");
  expect(p.text("open item")).toBe("a");
  expect(p.text("page address")).toBe("/items?item=a#details");
  expect(location(p)).toBe(`${server.url}/items?item=a#details`);
});

test("reload keeps the current pushed address rather than the initial deep link", async () => {
  const p = await open(undefined, "/items?item=a#details");
  await p.press("open item b");
  expect(p.text("open item")).toBe("b");
  expect(p.text("popstate count")).toBe("0");
  expect(location(p)).toBe(`${server.url}/items?item=b#details`);
  await p.reload();
  expect(p.text("open item")).toBe("b");
  expect(p.text("page address")).toBe("/items?item=b#details");
  expect(location(p)).toBe(`${server.url}/items?item=b#details`);
});

test("history back restores each address and delivers one popstate for each traversal", async () => {
  const p = await open(undefined, "/items?item=a#details");
  await p.press("open item b");
  await p.press("open item c");
  expect(p.text("open item")).toBe("c");
  expect(p.text("popstate count")).toBe("0");
  await back(p);
  expect(p.text("open item")).toBe("b");
  expect(p.text("popstate count")).toBe("1");
  expect(location(p)).toBe(`${server.url}/items?item=b#details`);
  await back(p);
  expect(p.text("open item")).toBe("a");
  expect(p.text("popstate count")).toBe("2");
  expect(location(p)).toBe(`${server.url}/items?item=a#details`);
});

test("reload keeps local and session drafts and IndexedDB without a server refill", async () => {
  const p = await open();
  await p.type("local draft", "local text");
  await p.type("session draft", "session text");
  await p.press("send x");
  await p.signOut();
  await p.reload();
  expect(p.text("saved local draft")).toBe("local text");
  expect(p.text("saved session draft")).toBe("session text");
  expect(p.text("transactions")).toContain("seed:42");
  expect(p.text("transactions")).toContain("x:9");
  await p.press("probe identity");
  expect(p.text("identity")).toMatch(/^401:/);
});

test("a new device clears local and session drafts and IndexedDB without changing the server or session", async () => {
  const p = await open();
  await p.type("local draft", "local text");
  await p.type("session draft", "session text");
  await p.press("send x");
  expect(p.text("saved local draft")).toBe("local text");
  expect(p.text("saved session draft")).toBe("session text");
  expect(p.text("transactions")).toContain("x:9");
  await p.signOut();
  await p.reload({ device: "new" });
  expect(p.text("saved local draft")).toBe("");
  expect(p.text("saved session draft")).toBe("");
  expect(p.text("transactions")).toBe("");
  expect(server.store.rows("history").find((row) => row.id === "x")?.value).toBe(9);
  await p.press("probe identity");
  expect(p.text("identity")).toMatch(/^401:/);
});
