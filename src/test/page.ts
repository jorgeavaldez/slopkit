/**
 * An app's real page, headless, for its tests: the app's own page entry (components, runtime, replica) in a DOM shim
 * (`happy-dom`), over the app's real server running in this process on loopback, signed in through the kit's
 * approve-all OpenID stand-in. Tests drive it as a person does, by accessible name, and read what it says; every action
 * ends when the page and the server are quiet, and the view is then checked by the kit's rules (`viewProblems`). No
 * browser and no real login. For vitest; one page at a time per process.
 *
 * - **One clock.** The page and the server see the driver's clock as `Date`, and their `setTimeout`/`setInterval` are
 *   virtual; Node's own I/O (fetch, sockets, IndexedDB) keeps real time. Only `settle` and `advance` move the clock.
 * - **Settle is a person who stops and waits:** every pending timeout within `idle` of the clock runs, the clock moving
 *   to each in turn, intervals crossed on the way running once, the server's due jobs after each move; in-flight fetches
 *   and socket messages finish. Bounded: past 200 rounds it throws, naming what stayed busy.
 * - **The page's own commands:** the driver only types, presses and selects in the DOM; what reaches the server is what
 *   the page sends.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import type { Element as DomElement } from "happy-dom";
// A fresh module graph for each page load, as a browser gives; this resets modules, it mocks nothing.
// oxlint-disable-next-line no-restricted-imports
import { vi } from "vitest";
import { WebSocket as NodeSocket } from "ws";

import type { WebConfig } from "../server/config.ts";
import { parseWebConfig } from "../server/config.ts";
import { Log, scoped } from "../server/log.ts";
import type { Logger } from "../server/log.ts";
import { isLine, MEANINGS } from "../states.ts";
import type { Line, Meaning } from "../states.ts";
import type { Model } from "../sync.ts";
import { identityProvider } from "./oidc.ts";
import { viewProblems } from "./states.ts";
import type { World } from "./states.ts";

/** What the app's server gives the driver: where it listens, how it stops, its due jobs run, its open jobs listed. */
export type PageServer = {
  url: string;
  close: () => Promise<void>;
  /** Runs the server's jobs due by now (the driver's clock). */
  due?: () => unknown;
  /** The server's jobs, for the honest check (`World.jobs`). */
  jobs?: () => World["jobs"];
};

/** What the page shows and its sync model, read from the loaded page entry. */
export type PageRead = {
  shown: unknown;
  // oxlint-disable-next-line typescript/no-explicit-any -- any app's model: only the kit's own fields are read
  model?: Model<any, any, any, any>;
};

export type PageOptions<E> = {
  /** The app's server in this process, on the driver's web config, reading time from `now`. */
  server: (context: {
    home: string;
    web: WebConfig;
    now: () => number;
    log: Logger;
  }) => Promise<PageServer>;
  /** Imports the app's page entry, which renders into `#app`; modules are fresh on each load. */
  page: () => Promise<E>;
  /** What the page shows and its sync model, from the loaded entry. */
  read?: (entry: E) => PageRead;
  /** When the clock starts: an instant or ms since the epoch. */
  at: string | number;
  /** The app's severity order, for the honest checks. */
  order?: readonly Meaning[];
  /** How far a settle waits for pending timeouts, in ms of the clock. */
  idle?: number;
  viewport?: { width: number; height: number };
};

/** A line the page's view holds now. */
export type ReadLine = {
  subject: string;
  kind: string;
  meaning: Meaning;
  text: string;
  owed: Line<unknown>["owed"];
};

export type Page = {
  /** Types into the text field with this accessible name (replacing its value), then settles. */
  type: (name: string | RegExp, text: string) => Promise<void>;
  /** Presses the button or link with this accessible name, then settles. */
  press: (name: string | RegExp) => Promise<void>;
  /** Picks an option (by value or label) in the select with this accessible name, then settles. */
  select: (name: string | RegExp, option: string) => Promise<void>;
  /** Moves the clock by `ms`, running what falls in it, then settles. */
  advance: (ms: number) => Promise<void>;
  /** Waits until quiet, then checks the view; throws on its problems unless `lenient`. */
  settle: (options?: { lenient?: boolean }) => Promise<{ lines: ReadLine[]; problems: string[] }>;
  /** The text of the element named by aria-label or aria-labelledby, or of the whole page. */
  text: (name?: string | RegExp) => string;
  /** The lines the view holds now. */
  lines: () => ReadLine[];
  /** A new page load: fresh modules and DOM; this device's storage, or a new device's empty one. */
  reload: (options?: { device?: "same" | "new" }) => Promise<void>;
  /** Drops the session: the server then answers this page as no one. */
  signOut: () => Promise<void>;
  /** Signs in again through the stand-in. */
  signIn: () => Promise<void>;
  readonly now: number;
  close: () => Promise<void>;
};

type Timer = {
  id: number;
  at: number;
  delay: number;
  every: number;
  run: () => void;
  label: string;
  /** Whose timer: the server's outlive a page load, the page's die with it. */
  owner: "page" | "server";
};

/** Whether code runs for the server or the page: timers and their owner follow async context. */
const owner = new AsyncLocalStorage<"page" | "server">();

/** The longest real time a settle waits for I/O to finish before it says what stayed busy. */
const QUIET_LIMIT_MS = 10_000;
/** The most timeouts one move of the clock runs before it says which keeps re-arming. */

const FIRES = 200;

const ROUNDS = 200;
const QUIET_CHECKS = 3;
const QUIET_MS = 2;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const RealDate = Date;
const VIRTUAL = Symbol("virtual timer");

/**
 * Whether a timer is Node's own (fetch's parser and its tick, from `node:internal`): those keep real time, since they
 * are the I/O the page waits on, not the page's or the server's time.
 */
function internal(): boolean {
  // The frame that called setTimeout: this function, the wrapper, then the caller.
  const caller = new Error("stack").stack?.split("\n")[3] ?? "";

  return caller.includes("node:internal") || caller.includes("(node:");
}

let open = false;

function matches(name: string | RegExp, value: string): boolean {
  return typeof name === "string" ? value === name : name.test(value);
}

export async function openPage<E>(options: PageOptions<E>): Promise<Page> {
  if (open) {
    throw new Error("openPage: another page is open in this process; close it first");
  }

  const clock = { now: typeof options.at === "number" ? options.at : RealDate.parse(options.at) };

  if (!Number.isFinite(clock.now)) {
    throw new TypeError(`openPage: at ${String(options.at)} isn't an instant`);
  }

  open = true;

  const idle = options.idle ?? 5000;
  const order = options.order ?? MEANINGS;
  const timers = new Map<number, Timer>();
  let nextTimer = 0;
  let activity = 0;
  let inflight = 0;
  const errors: string[] = [];
  const restore: (() => void)[] = [];

  const set = (key: string, value: unknown) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    restore.push(() => {
      if (before === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, before);
      }
    });
  };

  // The clock as Date, for page and server alike: `new Date()` and `Date.now()` read it, `Date()` says it, and every
  // other use is the real Date's, so a Date from structuredClone or IndexedDB is still `instanceof Date`.
  const Clocked = new Proxy(RealDate, {
    construct: (target, args: unknown[], newTarget: NewableFunction) =>
      // oxlint-disable-next-line typescript/no-unsafe-return -- the real Date's own construction, passed through
      Reflect.construct(target, args.length === 0 ? [clock.now] : args, newTarget),
    apply: () => new RealDate(clock.now).toString(),
    get: (target, key, receiver) =>
      // oxlint-disable-next-line typescript/no-unsafe-return -- the real Date's own members, passed through
      key === "now" ? () => clock.now : Reflect.get(target, key, receiver),
  });

  set("Date", Clocked);

  const handle = (timer: Timer) => ({
    [VIRTUAL]: true,
    id: timer.id,
    ref() {
      return this;
    },
    unref() {
      return this;
    },
    hasRef: () => true,
    refresh() {
      timer.at = clock.now + timer.delay;
      timers.set(timer.id, timer);

      return this;
    },
    [Symbol.toPrimitive]: () => timer.id,
  });

  const schedule = (
    run: (...args: unknown[]) => unknown,
    ms: unknown,
    every: boolean,
    rest: unknown[]
  ) => {
    const delay = Math.max(0, Number(ms) || 0);
    const id = ++nextTimer;

    const timer: Timer = {
      id,
      at: clock.now + delay,
      delay,
      every: every ? Math.max(1, delay) : 0,
      owner: owner.getStore() ?? "server",
      run: () => {
        owner.run(timer.owner, () => run(...rest));
      },
      label: `${every ? "interval" : "timeout"} ${delay} ms${run.name ? ` (${run.name})` : ""}`,
    };

    timers.set(id, timer);

    return handle(timer);
  };

  const clear = (value: unknown) => {
    if (typeof value === "object" && value !== null && !(VIRTUAL in value)) {
      // A real timer of Node's own.
      // SAFETY: only Node's real timers are objects without the virtual mark.
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      realClearTimeout(value as ReturnType<typeof realSetTimeout>);

      return;
    }

    const id =
      typeof value === "object" && value !== null && "id" in value
        ? Number(value.id)
        : Number(value);

    timers.delete(id);
  };

  type Run = (...args: unknown[]) => void;

  set("setTimeout", (run: Run, ms?: number, ...rest: unknown[]) =>
    internal() ? realSetTimeout(run, ms, ...rest) : schedule(run, ms, false, rest)
  );
  set("setInterval", (run: Run, ms?: number, ...rest: unknown[]) =>
    internal() ? realSetInterval(run, ms, ...rest) : schedule(run, ms, true, rest)
  );
  set("clearTimeout", clear);
  set("clearInterval", clear);

  const fire = (timer: Timer) => {
    if (timer.every > 0) {
      timer.at = Math.max(timer.at + timer.every, clock.now + timer.every);
    } else {
      timers.delete(timer.id);
    }

    activity++;

    try {
      timer.run();
    } catch (error) {
      errors.push(`${timer.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The pending timeout that comes first, at or before `to`. */
  const first = (to: number) =>
    [...timers.values()]
      .filter((each) => each.every === 0 && each.at <= to)
      .toSorted((a, b) => a.at - b.at || a.id - b.id)[0];

  /** Drops the page's timers; the server's go on. */
  const pages = () => {
    for (const timer of [...timers.values()].filter((each) => each.owner === "page")) {
      timers.delete(timer.id);
    }
  };

  /** Runs intervals due by now once each. */
  const intervals = () => {
    for (const each of [...timers.values()].filter(
      (timer) => timer.every > 0 && timer.at <= clock.now
    )) {
      fire(each);
    }
  };

  const onRejection = (reason: unknown) => {
    errors.push(
      `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`
    );
  };

  process.on("unhandledRejection", onRejection);
  restore.push(() => {
    process.off("unhandledRejection", onRejection);
  });
  set("reportError", (error: unknown) => {
    errors.push(`reported: ${error instanceof Error ? error.message : String(error)}`);
  });

  const quiet = async () => {
    let still = 0;
    let seen = activity;
    const until = RealDate.now() + QUIET_LIMIT_MS;

    while (still < QUIET_CHECKS) {
      if (RealDate.now() > until) {
        throw new Error(
          `the page never settles: ${inflight} requests or sockets still in flight after ${QUIET_LIMIT_MS} ms`
        );
      }

      // oxlint-disable-next-line no-await-in-loop -- each check waits out real I/O before the next
      await new Promise((resolve) => {
        realSetTimeout(resolve, QUIET_MS);
      });

      if (inflight === 0 && activity === seen) {
        still++;
      } else {
        still = 0;
        seen = activity;
      }
    }
  };

  // What to undo on close, or when opening fails part way: newest first.
  const undo: (() => Promise<void> | void)[] = [
    () => {
      for (const each of restore.toReversed()) {
        each();
      }

      open = false;
    },
  ];

  // Every step runs even when one fails, so a failed close never leaves the clock, the timers or the slot behind.
  const teardown = async () => {
    const failed: unknown[] = [];

    for (const each of undo.splice(0).toReversed()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- in order, newest first
        await each();
      } catch (error) {
        failed.push(error);
      }
    }

    if (failed.length > 0) {
      throw new AggregateError(failed, "openPage: closing failed");
    }
  };

  const opened = async (): Promise<Page> => {
    const home = await mkdtemp(join(tmpdir(), "slopkit-page-"));

    undo.push(() => rm(home, { recursive: true, force: true }));
    const provider = await identityProvider();

    undo.push(() => provider.close());

    const web = parseWebConfig(
      {
        port: 0,
        bind: "127.0.0.1",
        oidc: { issuer: provider.issuer, clientId: "page" },
        allow: ["sub:owner"],
      },
      []
    );

    const log = new Log(home, "page", { echo: false });

    undo.push(() => log.flushed());

    // The server runs in its own async context: its timers outlive a page load.
    const server = await owner.run("server", () =>
      options.server({ home, web, now: () => clock.now, log: scoped(log, "server") })
    );

    undo.push(() => owner.run("server", () => server.close()));

    /** Real I/O, the server's jobs due by now, then their I/O. */
    const step = async () => {
      await quiet();
      await owner.run("server", () => server.due?.());
      await quiet();
    };

    /** Moves the clock to `to`: each timeout due by then at its own instant, with I/O and due jobs after each, then
     * the intervals crossed, once each. */
    const move = async (to: number) => {
      for (let fired = 0; ; fired++) {
        const next = first(to);

        if (next === undefined) {
          break;
        }

        if (fired > FIRES) {
          throw new Error(`the page never settles: ${next.label} keeps re-arming`);
        }

        clock.now = Math.max(clock.now, next.at);
        fire(next);
        // oxlint-disable-next-line no-await-in-loop -- each timeout's effects land before the next runs
        await step();
      }

      clock.now = Math.max(clock.now, to);
      intervals();
      await step();
    };

    const base = new URL(server.url);
    const origin = base.origin;
    let cookie = "";

    // The server's own login, through the stand-in: its redirects followed by hand, the last session cookie kept.
    const signIn = async () => {
      let at = new URL("/auth/login", base);
      let found = "";

      for (let hop = 0; hop < 5; hop++) {
        // oxlint-disable-next-line no-await-in-loop -- each redirect follows the one before
        const response = await fetch(at, {
          redirect: "manual",
          headers: found === "" ? {} : { cookie: found },
        });

        const pair = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

        if (/^[^=]+=[^=]/.test(pair)) {
          found = pair;
        }

        const location = response.headers.get("location");

        if (location === null) {
          break;
        }

        at = new URL(location, at);
      }

      if (found === "") {
        throw new Error("openPage: the stand-in sign-in gave no session");
      }

      cookie = found;
    };

    await signIn();

    const nodeFetch = globalThis.fetch.bind(globalThis);
    let device = new IDBFactory();
    let window: Window | undefined;
    let entry: E | undefined;
    let pageGlobals: (() => void)[] = [];

    const pageFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), base);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);

      for (const [key, value] of new Headers(init.headers)) {
        headers.set(key, value);
      }

      if (url.origin === origin) {
        if (cookie !== "") {
          headers.set("cookie", cookie);
        }

        headers.set("origin", origin);
      }

      inflight++;
      activity++;

      try {
        const method = init.method ?? (input instanceof Request ? input.method : "GET");

        const response = await nodeFetch(url, { ...init, method, headers });
        // The body is read here, so the request counts as in flight until it has all arrived.

        const body =
          response.status === 204 || response.status === 304 ? null : await response.arrayBuffer();

        const copy = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });

        Object.defineProperty(copy, "url", { value: response.url });

        return copy;
      } finally {
        inflight--;
        activity++;
      }
    };

    const sockets = new Set<NodeSocket>();

    class PageSocket extends NodeSocket {
      constructor(url: string | URL) {
        super(String(url), { headers: cookie === "" ? { origin } : { cookie, origin } });
        sockets.add(this);
        this.once("close", () => {
          sockets.delete(this);
        });
        inflight++;
        // The handshake is in flight until it opens, fails or closes, whichever comes first; a refused upgrade fails
        // and closes, as in a browser, so the page's retry runs.
        let pending = true;

        const done = () => {
          if (pending) {
            pending = false;
            inflight--;
          }

          activity++;
        };

        this.once("open", done);
        this.once("error", done);
        this.once("close", done);
        this.on("message", () => {
          activity++;
        });
      }
    }

    const unload = async () => {
      // The page goes as a closed tab does: its timers stop, its sockets close, and what it had in flight lands before
      // its globals go, so nothing of it runs afterwards. The server's timers go on.

      pages();

      for (const socket of sockets) {
        socket.close();
      }

      await quiet();

      for (const each of pageGlobals.toReversed()) {
        each();
      }

      pageGlobals = [];

      if (window !== undefined) {
        await window.happyDOM.abort();
        await window.happyDOM.close();
        window = undefined;
      }

      pages();
    };

    const load = async () => {
      window = new Window({
        url: base.href,
        width: options.viewport?.width ?? 412,
        height: options.viewport?.height ?? 915,
      });
      // The window's own timers and Date are the driver's, as the bare globals are.

      for (const key of ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"]) {
        Object.defineProperty(window, key, {
          value: Reflect.get(globalThis, key),
          configurable: true,
          writable: true,
        });
      }

      // An error a listener throws: the DOM reports it on the window rather than to the caller.
      window.addEventListener("error", (event) => {
        const error: unknown = "error" in event ? event.error : undefined;

        errors.push(`page error: ${error instanceof Error ? error.message : String(error)}`);
      });

      const own: (() => void)[] = [];

      const put = (key: string, value: unknown) => {
        const before = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        own.push(() => {
          if (before === undefined) {
            Reflect.deleteProperty(globalThis, key);
          } else {
            Object.defineProperty(globalThis, key, before);
          }
        });
      };

      const shim: Record<string, unknown> = Object.fromEntries(
        Object.getOwnPropertyNames(window).flatMap((key) => {
          try {
            return [[key, Reflect.get(window ?? {}, key)]];
          } catch {
            return [];
          }
        })
      );

      for (const [key, value] of Object.entries(shim)) {
        // The DOM's classes and objects, where Node has none of its own; Node keeps its timers, fetch and streams.
        if (!(key in globalThis) || ["Event", "CustomEvent"].includes(key)) {
          put(key, value);
        }
      }

      for (const [key, value] of Object.entries({
        window,
        self: window,
        document: window.document,
        location: window.location,
        navigator: window.navigator,
        localStorage: window.localStorage,
        sessionStorage: window.sessionStorage,
        indexedDB: device,
        fetch: pageFetch,
        WebSocket: PageSocket,
      })) {
        put(key, value);
      }

      pageGlobals = own;
      window.document.body.innerHTML = '<div id="app"></div>';
      vi.resetModules();
      entry = await owner.run("page", () => options.page());
    };

    const doc = () => {
      if (window === undefined) {
        throw new Error("the page isn't loaded");
      }

      return window.document;
    };

    /** An element's accessible name: aria-label, aria-labelledby, its <label>, or its text. */
    const nameOf = (element: DomElement): string => {
      const label = element.getAttribute("aria-label");

      if (label !== null) {
        return label.trim();
      }

      const by = element.getAttribute("aria-labelledby");

      if (by !== null) {
        return by
          .split(/\s+/)
          .map((id) => doc().querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
          .join(" ")
          .trim();
      }

      const id = element.getAttribute("id");
      const labelled = id === null ? null : doc().querySelector(`label[for="${id}"]`);
      const wrapping = element.closest("label");
      const from = labelled ?? (wrapping === element ? null : wrapping);

      if (from !== null && element.tagName !== "BUTTON") {
        const copy = from.cloneNode(true);

        for (const control of copy.querySelectorAll("input, select, textarea, button")) {
          control.remove();
        }

        return (copy.textContent ?? "").replaceAll(/\s+/g, " ").trim();
      }

      if (
        element.tagName === "INPUT" &&
        /^(submit|button|reset)$/i.test(element.getAttribute("type") ?? "")
      ) {
        return (element.getAttribute("value") ?? "").trim();
      }

      return (element.textContent ?? "").replaceAll(/\s+/g, " ").trim();
    };

    const find = (selector: string, name: string | RegExp, what: string): HTMLElement => {
      const found = [...doc().querySelectorAll(selector)].filter((each) =>
        matches(name, nameOf(each))
      );

      if (found.length !== 1) {
        const names = [...doc().querySelectorAll(selector)].map((each) => `"${nameOf(each)}"`);

        throw new Error(
          `${found.length === 0 ? "no" : `${found.length}`} ${what} named ${String(name)}; there are: ${names.join(", ") || "none"}`
        );
      }

      // SAFETY: happy-dom's HTML elements are the DOM's, under its own type names.
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions
      return found[0] as unknown as HTMLElement;
    };

    const event = (target: EventTarget, type: string) => {
      if (window === undefined) {
        return;
      }

      // SAFETY: happy-dom's Event is the DOM's Event, under its own type name.
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions
      const made = new window.Event(type, { bubbles: true }) as unknown as Event;

      // The page's handlers run as the page: what they start is the page's, and dies with a reload.
      owner.run("page", () => target.dispatchEvent(made));
    };

    const read = (): PageRead =>
      entry === undefined || options.read === undefined
        ? { shown: undefined }
        : options.read(entry);

    const lines = (): ReadLine[] => {
      const found: ReadLine[] = [];
      const seen = new Set<object>();

      const visit = (value: unknown): void => {
        if (typeof value !== "object" || value === null || seen.has(value)) {
          return;
        }

        seen.add(value);

        if (isLine(value)) {
          found.push({
            subject: value.subject,
            kind: value.kind,
            meaning: value.meaning,
            text: value.text,
            owed: value.owed,
          });

          return;
        }

        for (const each of value instanceof Map
          ? [...value.keys(), ...value.values()]
          : value instanceof Set || Array.isArray(value)
            ? value
            : Object.values(value)) {
          visit(each);
        }
      };

      visit(read().shown);

      return found;
    };

    const settleWithin = async (
      within: number,
      settling: { lenient?: boolean } = {}
    ): Promise<{ lines: ReadLine[]; problems: string[] }> => {
      const horizon = clock.now + within;
      let rounds = 0;

      for (;;) {
        if (++rounds > ROUNDS) {
          const busy = [...timers.values()].filter(
            (each) => each.every === 0 && each.at <= horizon
          );

          throw new Error(
            `the page never settles: after ${ROUNDS} rounds still ${[
              ...busy.map((each) => each.label),
              ...(inflight > 0 ? [`${inflight} requests in flight`] : []),
            ].join(", ")}`
          );
        }

        // Each round waits for the last one's work: real I/O, then the jobs it made due, then their I/O.
        // oxlint-disable-next-line no-await-in-loop -- in order, by design
        await step();

        const next = first(horizon);

        if (next === undefined) {
          break;
        }

        // oxlint-disable-next-line no-await-in-loop -- in order, by design
        await move(next.at);
      }

      const problems = errors.splice(0);
      const now = read();
      problems.push(
        ...viewProblems(now.shown, {
          order,
          world: {
            now: clock.now,
            ...(server.jobs === undefined ? {} : { jobs: server.jobs() ?? [] }),
            ...(now.model === undefined ? {} : { model: now.model }),
          },
        })
      );

      if (problems.length > 0 && settling.lenient !== true) {
        throw new Error(`the page settled with problems:\n- ${problems.join("\n- ")}`);
      }

      return { lines: lines(), problems };
    };

    const settle: Page["settle"] = (settling) => settleWithin(idle, settling);

    undo.push(unload);

    await load();

    // The first screen is the one at `at`: what loads and syncs now, with no time passing.

    await settleWithin(0);

    return {
      async type(name, text) {
        const field = find(
          "input, textarea, [contenteditable], [role=textbox], [role=searchbox]",
          name,
          "text field"
        );

        if ("value" in field) {
          // SAFETY: an input or textarea takes a value.
          // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          (field as HTMLInputElement).value = text;
        } else {
          field.textContent = text;
        }

        event(field, "input");
        event(field, "change");
        await settle();
      },
      async press(name) {
        const button = find(
          "button, input[type=submit], input[type=button], input[type=reset], a[href], [role=button], [role=link], [role=tab], [role=menuitem]",
          name,
          "button"
        );

        owner.run("page", () => {
          button.click();
        });
        await settle();
      },
      async select(name, option) {
        // SAFETY: matched by the select selector, so a select element.
        // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions
        const field = find("select", name, "select") as unknown as HTMLSelectElement;

        const chosen = [...field.options].find(
          (each) => each.value === option || each.text.trim() === option
        );

        if (chosen === undefined) {
          throw new Error(`select ${String(name)} has no option ${option}`);
        }

        field.value = chosen.value;
        event(field, "input");
        event(field, "change");
        await settle();
      },
      async advance(ms) {
        await move(clock.now + Math.max(0, ms));
        await settle();
      },
      settle,
      text(name) {
        return (
          name === undefined
            ? (doc().querySelector("#app")?.textContent ?? "")
            : (find("[aria-label], [aria-labelledby]", name, "named element").textContent ?? "")
        )
          .replaceAll(/\s+/g, " ")
          .trim();
      },
      lines,
      async reload(reloading = {}) {
        await unload();

        if (reloading.device === "new") {
          device = new IDBFactory();
        }

        await load();
        await settle();
      },
      async signOut() {
        cookie = "";
        const { problems } = await settle({ lenient: true });

        // Page errors in signing out fail the next settle; its view is checked again there.
        errors.push(...problems.filter((each) => !each.includes(" (working) but owes ")));
      },
      async signIn() {
        await signIn();
        await settle();
      },
      get now() {
        return clock.now;
      },
      async close() {
        await teardown();
      },
    };
  };

  try {
    return await opened();
  } catch (error) {
    await teardown().catch(() => undefined);
    throw error;
  }
}
