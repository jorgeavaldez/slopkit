/**
 * Schemas: one value describes a shape, checks it at a boundary, and gives its type (`Infer`). No dependencies and
 * browser-safe, so the server and the page check the same contract. A value that doesn't fit throws `Invalid` with
 * the path to the first problem; nothing is coerced.
 */

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  if (typeof value === "string") {
    return value.length > 40 ? "a long string" : JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return typeof value;
}

export class Invalid extends Error {
  readonly path: string;
  constructor(path: string, expected: string, value: unknown) {
    super(`${path || "value"}: expected ${expected}, got ${describe(value)}`);
    this.path = path;
  }
}

export type Schema<T> = {
  readonly expected: string;
  /**
   * The schema's full structure (every field, type, bound, pattern, literal, optionality and strictness): two schemas
   * built differently have different shapes, two built alike the same one. A stored copy keeps the shapes it was
   * written with, so a change can't be read as the old shape by accident.
   */
  readonly shape: string;
  /** The value as `T`, or throws `Invalid`. `path` names where it is, for the error. */
  readonly parse: (value: unknown, path?: string) => T;
};

export type Infer<S> = S extends Schema<infer T> ? T : never;

/** Parse, or the error: for callers that branch rather than throw. */
export function check<T>(
  schema: Schema<T>,
  value: unknown
): { ok: true; value: T } | { ok: false; error: Invalid } {
  try {
    return { ok: true, value: schema.parse(value, "") };
  } catch (error) {
    if (error instanceof Invalid) {
      return { ok: false, error };
    }

    throw error;
  }
}

function define<T>(
  expected: string,
  shape: string,
  parse: (value: unknown, path: string) => T
): Schema<T> {
  return { expected, shape, parse: (value, path = "") => parse(value, path) };
}

export function string(
  options: { min?: number; max?: number; pattern?: RegExp } = {}
): Schema<string> {
  const { min = 0, max = 100_000, pattern } = options;
  const expected = `text${pattern ? ` matching ${String(pattern)}` : ""}`;
  const shape = `string(${min},${max}${pattern ? `,${String(pattern)}` : ""})`;

  return define(expected, shape, (value, path) => {
    if (
      typeof value !== "string" ||
      value.length < min ||
      value.length > max ||
      (pattern && !pattern.test(value))
    ) {
      throw new Invalid(path, expected, value);
    }

    return value;
  });
}

export function number(
  options: { integer?: boolean; min?: number; max?: number } = {}
): Schema<number> {
  const { integer = false, min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = options;
  const expected = `${integer ? "an integer" : "a number"} from ${min} to ${max}`;

  return define(expected, `number(${integer},${min},${max})`, (value, path) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (integer && !Number.isSafeInteger(value)) ||
      value < min ||
      value > max
    ) {
      throw new Invalid(path, expected, value);
    }

    return value;
  });
}

export function boolean(): Schema<boolean> {
  return define("a boolean", "boolean", (value, path) => {
    if (typeof value !== "boolean") {
      throw new Invalid(path, "a boolean", value);
    }

    return value;
  });
}

export function literal<const T extends readonly (string | number | boolean)[]>(
  ...values: T
): Schema<T[number]> {
  const expected = `one of ${values.map((each) => JSON.stringify(each)).join(", ")}`;

  return define(expected, `literal(${JSON.stringify(values)})`, (value, path) => {
    const found = values.find((each) => each === value);

    if (found === undefined) {
      throw new Invalid(path, expected, value);
    }

    return found;
  });
}

/** Exactly null: a field a state never has. */
export function nil(): Schema<null> {
  return define("null", "null", (value, path) => {
    if (value !== null) {
      throw new Invalid(path, "null", value);
    }

    return null;
  });
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  const expected = `${inner.expected} or null`;

  return define(expected, `nullable(${inner.shape})`, (value, path) =>
    value === null ? null : inner.parse(value, path)
  );
}

export function array<T>(item: Schema<T>, options: { max?: number } = {}): Schema<T[]> {
  const expected = `a list of ${item.expected}`;
  const shape = `array(${item.shape}${options.max === undefined ? "" : `,${options.max}`})`;

  return define(expected, shape, (value, path) => {
    if (!Array.isArray(value) || value.length > (options.max ?? Number.MAX_SAFE_INTEGER)) {
      throw new Invalid(path, expected, value);
    }

    return value.map((each: unknown, index) => item.parse(each, `${path}[${index}]`));
  });
}

/** A field that may be absent: `optional(s)` in an object's shape. */
export type Optional<T> = Schema<T | undefined> & { readonly optional: true };

export function optional<T>(inner: Schema<T>): Optional<T> {
  return {
    expected: `${inner.expected} or absent`,
    shape: `optional(${inner.shape})`,
    optional: true,
    parse: (value, path = "") => (value === undefined ? undefined : inner.parse(value, path)),
  };
}

type Shape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Optional<unknown> ? K : never;
}[keyof S];

type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

type Simplify<T> = { [K in keyof T]: T[K] };

export type ObjectOf<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field of the value itself, never one it inherits (`constructor`, `__proto__`). */
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Sets a field as data on `out` itself: a key named `__proto__` stays a field and never changes `out`'s prototype. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * An object with these fields. `strict` refuses fields it doesn't name: our own contracts are strict; another
 * service's responses are not, since they grow fields we don't use.
 */
export function object<S extends Shape>(
  shape: S,
  options: { strict?: boolean } = {}
): Schema<ObjectOf<S>> {
  const expected = `an object with ${Object.keys(shape).join(", ") || "no fields"}`;

  const fields = Object.entries(shape).map(
    ([key, field]) => `${JSON.stringify(key)}:${field.shape}`
  );

  const described = `object(${options.strict === true ? "strict" : "loose"},{${fields.join(",")}})`;

  return define(expected, described, (value, path) => {
    if (!isRecord(value)) {
      throw new Invalid(path, expected, value);
    }

    if (options.strict === true) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) {
          throw new Invalid(`${path}.${key}`, "no such field", value[key]);
        }
      }
    }

    const out: Record<string, unknown> = {};

    for (const [key, field] of Object.entries(shape)) {
      const parsed = field.parse(own(value, key), `${path}.${key}`);

      if (parsed !== undefined) {
        put(out, key, parsed);
      }
    }

    // SAFETY: every field was parsed against the shape above; this is the one place the type is asserted.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    return out as ObjectOf<S>;
  });
}

/** One of several objects, told apart by the `tag` field. */
export function variant<K extends string, V extends Record<string, Schema<object>>>(
  tag: K,
  variants: V
): Schema<{ [T in keyof V]: Infer<V[T]> & { [P in K]: T } }[keyof V]> {
  const expected = `an object whose ${tag} is ${Object.keys(variants).join(" | ")}`;

  const cases = Object.entries(variants).map(
    ([key, each]) => `${JSON.stringify(key)}:${each.shape}`
  );

  return define(expected, `variant(${JSON.stringify(tag)},{${cases.join(",")}})`, (value, path) => {
    if (!isRecord(value)) {
      throw new Invalid(path, expected, value);
    }

    const name = own(value, tag);

    const inner =
      typeof name === "string" && Object.hasOwn(variants, name) ? variants[name] : undefined;

    if (inner === undefined) {
      throw new Invalid(`${path}.${tag}`, expected, name);
    }

    const parsed = inner.parse(value, path);

    // SAFETY: the tag picked the variant that parsed the value, so the value is that variant's.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    return { ...parsed, [tag]: name } as { [T in keyof V]: Infer<V[T]> & { [P in K]: T } }[keyof V];
  });
}

/** A map from text keys to one shape of value. */
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  const expected = `a map of ${value.expected}`;

  return define(expected, `record(${value.shape})`, (input, path) => {
    if (!isRecord(input)) {
      throw new Invalid(path, expected, input);
    }

    const out: Record<string, T> = {};

    for (const [key, each] of Object.entries(input)) {
      put(out, key, value.parse(each, `${path}.${key}`));
    }

    return out;
  });
}

/** A plain JSON scalar: text, a finite number, a boolean or null. */
export function scalar(): Schema<string | number | boolean | null> {
  const expected = "text, a number, a boolean or null";

  return define(expected, "scalar", (value, path) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    throw new Invalid(path, expected, value);
  });
}
