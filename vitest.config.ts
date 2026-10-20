import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist/ holds the built conformance suite; the packed check runs it from an installed copy instead.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
