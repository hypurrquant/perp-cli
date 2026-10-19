import { defineConfig } from "vitest/config";

/**
 * Opt-in LIVE conformance run (docs/TESTING.md §3): the conformance suite against live public
 * mainnet endpoints (read-only, isolated HOME — no keys). Not part of `pnpm test`.
 *   pnpm test:conformance:live                 (PERP_LIVE=1)
 *   pnpm conformance:record --venue <id>       (PERP_RECORD=1 → writes fixtures, then prunes them)
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/conformance/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    setupFiles: ["src/__tests__/helpers/isolate-home.ts"],
  },
});
