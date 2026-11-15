/**
 * Guard: unit tests must never resolve a path under the developer's real HOME.
 * (helpers/isolate-home.ts points HOME/TMPDIR at a temp dir before modules load.)
 * If this fails, a test run can write ~/.perp/bot-quarantine.json, settings.json,
 * executions.jsonl, … of the real user — e.g. quarantine BTC for their live bots.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const realHome = process.env.PERP_TEST_REAL_HOME ?? "";
const fakeHome = process.env.HOME ?? "";

function underFakeHome(p: string): boolean {
  return resolve(p).startsWith(resolve(fakeHome) + sep);
}

describe("unit-test HOME isolation", () => {
  it("HOME is a temp dir, not the real home", () => {
    expect(realHome).not.toBe("");
    expect(fakeHome).not.toBe(realHome);
    expect(fakeHome).toContain("perp-cli-test-home-");
    expect(homedir()).toBe(fakeHome);
  });

  it("os.tmpdir() (cache dir root) is inside the isolated home", () => {
    expect(underFakeHome(tmpdir())).toBe(true);
  });

  it("the quarantine file resolves inside the isolated home and quarantineSymbol writes there", async () => {
    const q = await import("../bot/quarantine.js");
    expect(underFakeHome(q.quarantineFile())).toBe(true);
    q.quarantineSymbol("isolation-guard", "GUARDCOIN", "isolation guard", "none", () => {});
    expect(existsSync(join(fakeHome, ".perp", "bot-quarantine.json"))).toBe(true);
    expect(readFileSync(q.quarantineFile(), "utf8")).toContain("GUARDCOIN");
    // The real file (if any) never sees the guard entry.
    const realFile = join(realHome, ".perp", "bot-quarantine.json");
    if (existsSync(realFile)) expect(readFileSync(realFile, "utf8")).not.toContain("GUARDCOIN");
  });

  it("settings are read from / written to the isolated home", async () => {
    const { loadSettings, saveSettings } = await import("../settings.js");
    saveSettings(loadSettings());
    expect(existsSync(join(fakeHome, ".perp", "settings.json"))).toBe(true);
  });

  it("the execution log writes inside the isolated home", async () => {
    vi.resetModules();
    const { logExecution } = await import("../execution-log.js");
    logExecution({ type: "market_order", exchange: "hyperliquid", symbol: "GUARD", side: "buy", size: "1", status: "success", dryRun: true });
    expect(existsSync(join(fakeHome, ".perp", "executions.jsonl"))).toBe(true);
  });

  it("agent keystores resolve inside the isolated home", async () => {
    const { venueKeystoreDir } = await import("../agent-wallet/venue-keystore.js");
    const { lighterKeystorePath } = await import("../agent-wallet/lighter-keystore.js");
    expect(underFakeHome(venueKeystoreDir("lighter-rh-agents"))).toBe(true);
    expect(underFakeHome(lighterKeystorePath(1, 2))).toBe(true);
  });
});
