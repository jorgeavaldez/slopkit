import { h, render } from "preact";

import { MEANINGS, states } from "../../src/states.ts";
import { createRuntime } from "../../src/web/runtime.ts";
import { api, empty, engine, tables } from "../sync-fixture.ts";

export const runtime = createRuntime({
  name: "page-fixture",
  api,
  sync: engine,
  replica: { version: 1, tables, empty },
});

const ui = states<never>({ order: MEANINGS });

const item = ui.subject<{ kind: "working"; key: string } | { kind: "ready" }>("item", {
  working: {
    meaning: "working",
    where: "main",
    claim: false,
    why: "Waiting on the server check",
    text: () => "working",
    action: null,
    owes: (state: { kind: "working"; key: string }) => ({ job: { kind: "check", key: state.key } }),
  },
  ready: {
    meaning: "ok",
    where: "main",
    claim: false,
    why: "The check finished",
    text: () => "checked",
    action: null,
  },
});

export const model = {
  get value() {
    return runtime.model();
  },
};

export const screen = {
  get value() {
    return ui.compose(
      [...runtime.model().replica.tables.history.values()].flatMap((row) =>
        row.id === "work" || row.id === "future"
          ? [
              item.line(
                row.value === 0 ? { kind: "working", key: row.id } : { kind: "ready" },
                `item:${row.id}`
              ),
            ]
          : []
      ),
      "ready"
    );
  },
};

let debounce: ReturnType<typeof setTimeout> | undefined;
let ticks = 0;
let timerAt = "not yet";
let selection = "a";
let probe = "not asked";
let loop = false;
let interval: ReturnType<typeof setInterval> | undefined;
let address = `${window.location.pathname}${window.location.search}${window.location.hash}`;
let popstates = 0;
let poppedState = "not traversed";
let localDraft = window.localStorage.getItem("local-draft") ?? "";
let sessionDraft = window.sessionStorage.getItem("session-draft") ?? "";
let exitDraft = window.localStorage.getItem("exit-draft") ?? "";
const savedExitDraft = exitDraft;
const savedExitEvents = window.localStorage.getItem("exit-events") ?? "";
const leaving: string[] = [];
const root = document.querySelector("#app");

if (!root) {
  throw new Error("missing #app");
}

const node = root;

function send(id: string, value: number) {
  runtime.command({ name: "put", id, value });
}

function paint() {
  function navigate(path: string, state: string | null = null) {
    window.history.pushState(state, "", path);
    address = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    paint();
  }

  render(
    h(
      "main",
      {},
      h("button", { "aria-label": "send x", onClick: () => send("x", 9) }, "×"),
      h("button", { onClick: () => navigate("/items?item=b#details") }, "open item b"),
      h("button", { onClick: () => navigate("/items?item=c#details") }, "open item c"),
      h(
        "button",
        { onClick: () => navigate("/items?item=b#details", "item-b-state") },
        "open item b with state"
      ),
      h("button", { onClick: () => window.history.back() }, "page back"),
      h(
        "button",
        {
          onClick: () => {
            window.location.hash = "x";
            address = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            paint();
          },
        },
        "change fragment"
      ),
      h("input", {
        "aria-label": "exit draft",
        value: exitDraft,
        onInput: (event: Event) => {
          const target = event.currentTarget;

          if (!(target instanceof HTMLInputElement)) {
            throw new Error("not an input");
          }

          exitDraft = target.value;
          paint();
        },
      }),
      h("input", {
        "aria-label": "local draft",
        value: localDraft,
        onInput: (event: Event) => {
          const target = event.currentTarget;

          if (!(target instanceof HTMLInputElement)) {
            throw new Error("not an input");
          }

          localDraft = target.value;
          window.localStorage.setItem("local-draft", localDraft);
          paint();
        },
      }),
      h("input", {
        "aria-label": "session draft",
        value: sessionDraft,
        onInput: (event: Event) => {
          const target = event.currentTarget;

          if (!(target instanceof HTMLInputElement)) {
            throw new Error("not an input");
          }

          sessionDraft = target.value;
          window.sessionStorage.setItem("session-draft", sessionDraft);
          paint();
        },
      }),
      h("output", { "aria-label": "page address" }, address),
      h(
        "output",
        { "aria-label": "open item" },
        new URL(address, window.location.origin).searchParams.get("item") ?? "none"
      ),
      h("output", { "aria-label": "popstate count" }, String(popstates)),
      h("output", { "aria-label": "popstate state" }, poppedState),
      h("output", { "aria-label": "history state" }, JSON.stringify(window.history.state)),
      h("output", { "aria-label": "saved exit draft" }, savedExitDraft),
      h("output", { "aria-label": "saved exit events" }, savedExitEvents),
      h("output", { "aria-label": "saved local draft" }, localDraft),
      h("output", { "aria-label": "saved session draft" }, sessionDraft),
      h("button", { onClick: () => send("long", 2) }, "send x twice"),
      h(
        "a",
        {
          href: "#linked",
          "aria-label": "send by link",
          onClick: (event: Event) => {
            event.preventDefault();
            send("linked", 3);
          },
        },
        "link"
      ),
      h("label", { htmlFor: "search" }, "find item"),
      h("input", {
        id: "search",
        onInput: (event: Event) => {
          const target = event.currentTarget;

          if (!(target instanceof HTMLInputElement)) {
            throw new Error("not an input");
          }

          const value = target.value;
          clearTimeout(debounce);
          debounce = setTimeout(() => send(value, 6), 600);
        },
      }),
      h("input", {
        "aria-label": "direct input",
        onInput: (event: Event) => {
          const target = event.currentTarget;

          if (!(target instanceof HTMLInputElement)) {
            throw new Error("not an input");
          }

          send(target.value, 7);
        },
      }),
      h(
        "label",
        {},
        "credit account",
        h(
          "select",
          {
            value: selection,
            onChange: (event: Event) => {
              const target = event.currentTarget;

              if (!(target instanceof HTMLSelectElement)) {
                throw new Error("not a select");
              }

              selection = target.value;
              send(`account-${selection}`, 8);
              paint();
            },
          },
          h("option", { value: "a" }, "Account A"),
          h("option", { value: "b" }, "Account B")
        )
      ),
      h("button", { onClick: () => send("work", 0) }, "check now"),
      h("button", { onClick: () => send("future", 0) }, "pretend to check tomorrow"),
      h(
        "button",
        {
          onClick: () => {
            setTimeout(() => {
              timerAt = new Date().toISOString();
              paint();
            }, 6000);
          },
        },
        "arm far timer"
      ),
      h(
        "button",
        {
          onClick: () => {
            interval = setInterval(() => {
              ticks++;
              paint();
            }, 100);
          },
        },
        "start interval"
      ),
      h(
        "button",
        {
          onClick: () => {
            clearInterval(interval);
          },
        },
        "stop interval"
      ),
      h(
        "button",
        {
          onClick: () => {
            loop = true;

            const ping = () => {
              if (loop) {
                setTimeout(ping, 1);
              }
            };

            setTimeout(ping, 1);
          },
        },
        "start endless timer"
      ),
      h(
        "button",
        {
          onClick: () => {
            loop = false;
          },
        },
        "stop endless timer"
      ),
      h(
        "button",
        {
          onClick: () => {
            throw new Error("fixture page exploded");
          },
        },
        "throw page error"
      ),
      h(
        "button",
        {
          onClick: () => {
            void Promise.reject(new Error("fixture rejection"));
          },
        },
        "reject page promise"
      ),
      h(
        "button",
        {
          onClick: () => {
            void fetch("/identity").then(async (response) => {
              probe = `${response.status}:${await response.text()}`;
              paint();
            });
          },
        },
        "probe identity"
      ),
      h(
        "section",
        { "aria-label": "transactions" },
        [...runtime.model().replica.tables.history.values()].map((row) =>
          h("p", { key: row.id }, `${row.id}:${row.value}`)
        )
      ),
      h("output", { "aria-label": "timer" }, timerAt),
      h("output", { "aria-label": "ticks" }, String(ticks)),
      h("output", { "aria-label": "identity" }, probe),
      h("output", { "aria-label": "page clock" }, `${Date.now()}:${new Date().toISOString()}`),
      h("output", { "aria-label": "connection" }, runtime.model().connection.kind),
      h("output", { "aria-label": "viewport" }, `${window.innerWidth}x${window.innerHeight}`),
      h(
        "output",
        { "aria-label": "statuses" },
        screen.value.parts.map((line) => line.text).join(" ")
      )
    ),
    node
  );
}

runtime.subscribe(paint);

document.addEventListener("visibilitychange", () => {
  leaving.push(`visibility:${document.visibilityState}`);
});

window.addEventListener("pagehide", () => {
  leaving.push("pagehide");
  window.localStorage.setItem("exit-draft", exitDraft);
  window.localStorage.setItem("exit-events", leaving.join(" "));
  runtime.stop();
});

window.addEventListener("popstate", (event: PopStateEvent) => {
  popstates++;
  poppedState = JSON.stringify(event.state) ?? "undefined";
  address = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  paint();
});

runtime.start();

paint();
