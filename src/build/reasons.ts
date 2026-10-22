/**
 * Builds the page without its state tables' reasons. A display's `why` (`slopkit/states`) is for whoever reads the
 * table, and the kit checks every state has one; the page never draws it, so its words needn't ship.
 *
 * `dropReasons()` is an esbuild plugin: in the app's own files, the `why` of each display in a table written inline in
 * a `.subject(name, { ... })` call becomes `"."` when it is a plain string. Anything else stays: a reason passed by
 * name, one built from values, a table passed by name, a `why` outside a subject's table. A table it can't read to its
 * end fails the build rather than guessing.
 */
import { readFile } from "node:fs/promises";

import type { Loader, Plugin } from "esbuild";

type Range = { start: number; end: number };

const SPACE = /\s/;
const WORD = /[\w$]/;

/** Where the comment, string or template starting at `at` ends, or `at` when none starts there. */
function skipped(source: string, at: number): number {
  const char = source[at];
  const next = source[at + 1];

  if (char === "/" && next === "/") {
    const end = source.indexOf("\n", at);

    return end === -1 ? source.length : end;
  }

  if (char === "/" && next === "*") {
    const end = source.indexOf("*/", at + 2);

    return end === -1 ? source.length : end + 2;
  }

  if (char === '"' || char === "'") {
    let index = at + 1;

    while (index < source.length && source[index] !== char) {
      index += source[index] === "\\" ? 2 : 1;
    }

    return index + 1;
  }

  if (char === "`") {
    let index = at + 1;

    while (index < source.length && source[index] !== "`") {
      if (source[index] === "\\") {
        index += 2;
      } else if (source[index] === "$" && source[index + 1] === "{") {
        index = closing(source, index + 1, "}");
      } else {
        index++;
      }
    }

    return index + 1;
  }

  return at;
}

/** A regex literal starts here: a `/` where an operand is expected. */
function regexAt(source: string, at: number): boolean {
  if (source[at] !== "/" || source[at + 1] === "/" || source[at + 1] === "*") {
    return false;
  }

  let back = at - 1;

  while (back >= 0 && SPACE.test(source[back] ?? "")) {
    back--;
  }

  return back < 0 || "(,=:[!&|?{};>".includes(source[back] ?? "");
}

function regexEnd(source: string, at: number): number {
  let index = at + 1;
  let inClass = false;

  while (index < source.length) {
    const char = source[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      return index + 1;
    }

    index++;
  }

  return index;
}

/** Past whatever can't hold code: comments, strings, templates and regex literals; `at` itself when it's code. */
function past(source: string, at: number): number {
  const end = skipped(source, at);

  if (end !== at) {
    return end;
  }

  return regexAt(source, at) ? regexEnd(source, at) : at;
}

/** The index just past the `close` that matches the opener at `open`; throws at the end of the source. */
function closing(source: string, open: number, close: "}" | ")" | "]"): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [close];
  let index = open + 1;

  while (index < source.length) {
    const end = past(source, index);

    if (end !== index) {
      index = end;
      continue;
    }

    const char = source[index] ?? "";

    if (char in pairs) {
      stack.push(pairs[char] ?? "");
    } else if (char === stack.at(-1)) {
      stack.pop();

      if (stack.length === 0) {
        return index + 1;
      }
    }

    index++;
  }

  throw new Error("a state table that never closes");
}

/** Past whitespace and comments. */
function blank(source: string, at: number): number {
  let index = at;

  for (;;) {
    while (index < source.length && SPACE.test(source[index] ?? "")) {
      index++;
    }

    const next = source[index + 1];

    if (source[index] !== "/" || (next !== "/" && next !== "*")) {
      return index;
    }

    index = skipped(source, index);
  }
}

/** A plain string literal (no `${}`) starting at `at`: its end, else undefined. */
function plain(source: string, at: number): number | undefined {
  const char = source[at];

  if (char !== '"' && char !== "'" && char !== "`") {
    return undefined;
  }

  const end = skipped(source, at);

  return char === "`" && source.slice(at, end).includes("${") ? undefined : end;
}

/**
 * An object literal's own properties from its `{` at `open`: each key and where its value starts and ends. Throws when
 * the object never closes.
 */
function properties(source: string, open: number): { keys: Map<string, Range>; end: number } {
  const keys = new Map<string, Range>();
  const end = closing(source, open, "}");
  let index = blank(source, open + 1);

  while (index < end - 1) {
    // The key: a name, a quoted name, or none this reader names (a spread, a computed key).
    let key = "";
    const quote = plain(source, index);

    if (quote === undefined) {
      const start = index;

      while (WORD.test(source[index] ?? "")) {
        index++;
      }

      key = source.slice(start, index);
    } else {
      key = source.slice(index + 1, quote - 1);
      index = quote;
    }

    index = blank(source, index);
    const valueStart = source[index] === ":" ? blank(source, index + 1) : index;

    // The value runs to the next comma at this object's own depth.
    let at = valueStart;

    while (at < end - 1 && source[at] !== ",") {
      const skip = past(source, at);

      if (skip !== at) {
        at = skip;
      } else if (source[at] === "{" || source[at] === "(" || source[at] === "[") {
        at = closing(source, at, source[at] === "{" ? "}" : source[at] === "(" ? ")" : "]");
      } else {
        at++;
      }
    }

    let valueEnd = at;

    while (valueEnd > valueStart && SPACE.test(source[valueEnd - 1] ?? "")) {
      valueEnd--;
    }

    if (key !== "") {
      keys.set(key, { start: valueStart, end: valueEnd });
    }

    index = blank(source, at + 1);
  }

  return { keys, end };
}

/** Each display's plain-string `why` in the tables written inline in `.subject(name, { ... })` calls. */
export function reasons(source: string): Range[] {
  const found: Range[] = [];
  const call = /\.subject\s*(?=[<(])/g;

  for (const match of source.matchAll(call)) {
    let index = blank(source, match.index + match[0].length);

    // Type arguments: balanced angle brackets, `=>` inside them is no close.
    if (source[index] === "<") {
      let depth = 0;

      do {
        const skip = past(source, index);

        if (skip !== index) {
          index = skip;
          continue;
        }

        if (source[index] === "<") {
          depth++;
        } else if (source[index] === ">" && source[index - 1] !== "=") {
          depth--;
        }

        index++;
      } while (depth > 0 && index < source.length);

      index = blank(source, index);
    }

    if (source[index] !== "(") {
      continue;
    }

    const name = blank(source, index + 1);
    const nameEnd = plain(source, name);

    if (nameEnd === undefined) {
      continue;
    }

    const comma = blank(source, nameEnd);
    const open = blank(source, comma + 1);

    if (source[comma] !== "," || source[open] !== "{") {
      continue;
    }

    for (const display of properties(source, open).keys.values()) {
      if (source[display.start] !== "{") {
        continue;
      }

      const { keys } = properties(source, display.start);
      const why = keys.get("why");

      if (why !== undefined && keys.has("meaning") && plain(source, why.start) === why.end) {
        found.push(why);
      }
    }
  }

  return found;
}

/** The source with each reason `reasons` finds replaced by `"."`. */
export function withoutReasons(source: string): string {
  let out = source;

  for (const { start, end } of reasons(source).toReversed()) {
    out = `${out.slice(0, start)}"."${out.slice(end)}`;
  }

  return out;
}

const LOADERS: Record<string, Loader> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mts: "ts", mjs: "js" };

/** The esbuild plugin: the app's own files (not `node_modules`) without their state tables' reasons. */
export function dropReasons(): Plugin {
  return {
    name: "slopkit-drop-reasons",
    setup(builder) {
      builder.onLoad({ filter: /\.[mc]?[jt]sx?$/ }, async (args) => {
        if (/[\\/]node_modules[\\/]/.test(args.path)) {
          return undefined;
        }

        const source = await readFile(args.path, "utf-8");

        if (!source.includes(".subject")) {
          return undefined;
        }

        const extension = args.path.slice(args.path.lastIndexOf(".") + 1);

        try {
          return { contents: withoutReasons(source), loader: LOADERS[extension] ?? "ts" };
        } catch (error) {
          throw new Error(`dropping state reasons in ${args.path}: ${String(error)}`, {
            cause: error,
          });
        }
      });
    },
  };
}
