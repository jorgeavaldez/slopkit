import { expect, test } from "vitest";

import { states, MEANINGS } from "../states.ts";
import type { EffectKind } from "../states.ts";

test("mutating caller-owned call metadata cannot make a lost non-idempotent effect retryable", () => {
  const calls: Record<"charge", EffectKind> = { charge: "once" };

  const source = states<never>({ order: MEANINGS }).source<{ kind: "ok" }, "TEMP", "charge">({
    name: "payments",
    states: {
      ok: {
        meaning: "ok",
        where: "panel",
        claim: false,
        why: "No payment needs recovery",
        text: () => "ready",
        action: null,
      },
    },
    codes: { TEMP: "retrying" },
    calls,
  });

  expect(source.fault("charge", { kind: "lost", reason: "reply lost" })).toStrictEqual({
    who: "retrying",
    effect: "unknown",
    retry: false,
    code: "LOST",
    documented: false,
  });
  calls.charge = "read";
  expect(source.fault("charge", { kind: "lost", reason: "reply lost" })).toStrictEqual({
    who: "retrying",
    effect: "unknown",
    retry: false,
    code: "LOST",
    documented: false,
  });
  expect(source.fault("charge", { kind: "malformed", reason: "unreadable reply" })).toStrictEqual({
    who: "us",
    effect: "unknown",
    retry: false,
    code: "MALFORMED",
    documented: false,
  });
  expect(source.calls).toStrictEqual({ charge: "once" });
});
