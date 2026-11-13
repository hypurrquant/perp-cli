/**
 * Vitest setup file (vitest.config.ts → setupFiles): points HOME (and TMPDIR) at a
 * fresh temp directory for every unit test file, BEFORE any module under test is imported.
 *
 * Production modules resolve their paths from HOME (~/.perp/settings.json,
 * bot-quarantine.json, executions.jsonl, client-ids.jsonl, arb-state.json, agent keystores,
 * equity-history, jobs, logs, trade-journal — all via src/paths.ts, at call time) and the cache from os.tmpdir() (TMPDIR). Without this, unit tests read
 * the developer's real settings (strict parsing makes results machine-dependent) and WRITE
 * to the real quarantine file — a mocked "outcome unknown" order quarantined BTC/ETH for
 * the user's live bots (2026-10-01).
 *
 * Integration tests (src/__tests__/integration/**, *.integration.test.ts) keep the real
 * HOME: they need the developer's real keys/agents (`pnpm test:all`).
 *
 * The real HOME is exposed as PERP_TEST_REAL_HOME for the isolation guard test
 * (src/__tests__/test-isolation.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

const testPath = expect.getState().testPath ?? "";
const isIntegration = /[\\/]integration[\\/]/.test(testPath) || /\.integration\.test\.ts$/.test(testPath);

if (!isIntegration) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TMPDIR: process.env.TMPDIR };
  const fakeHome = mkdtempSync(join(tmpdir(), "perp-cli-test-home-"));
  const fakeTmp = join(fakeHome, "tmp");
  mkdirSync(fakeTmp);
  process.env.PERP_TEST_REAL_HOME = saved.HOME ?? "";
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.TMPDIR = fakeTmp;

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });
}
