import { expect, test } from "vitest";

import { boolean, check, literal, object, record, string, variant } from "../schema.ts";

test("strict objects reject an unknown own field even when its name belongs to Object.prototype", () => {
  const input: unknown = JSON.parse('{"id":"a","constructor":123}');
  const parsed = check(object({ id: string() }, { strict: true }), input);
  expect(parsed).toMatchObject({ ok: false, error: { path: ".constructor" } });
});

test("an unknown prototype-named variant returns an Invalid result, not an unexpected exception", () => {
  const schema = variant("kind", { ok: object({ kind: literal("ok") }) });
  const input: unknown = JSON.parse('{"kind":"constructor"}');
  const parsed = check(schema, input);
  expect(parsed).toMatchObject({ ok: false, error: { path: ".kind" } });
});

test("a record preserves an own __proto__ JSON key without making its value inherited properties", () => {
  const input: unknown = JSON.parse('{"__proto__":{"isAdmin":true}}');
  const parsed = record(object({ isAdmin: boolean() })).parse(input);
  expect(Object.keys(parsed)).toStrictEqual(["__proto__"]);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(Object.hasOwn(parsed, "isAdmin")).toBe(false);
  expect(parsed.isAdmin).toBeUndefined();
  expect(JSON.stringify(parsed)).toBe('{"__proto__":{"isAdmin":true}}');
});
