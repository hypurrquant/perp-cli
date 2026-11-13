/**
 * src/paths.ts — the single home-directory resolver. HOME unset must be a typed error, never
 * `./~/.perp` in the CWD (path.resolve does not expand "~"; SSOT Rule #2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerpError } from "../errors.js";
import { owsPath, perpDir, perpPath } from "../paths.js";

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platform, value: p });
}

function caught(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return null;
}

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  Object.defineProperty(process, "platform", platform);
});

describe("perpPath / owsPath", () => {
  it("resolves under HOME", () => {
    expect(perpPath("settings.json")).toBe(join(saved.HOME!, ".perp", "settings.json"));
    expect(owsPath("bin", "ows")).toBe(join(saved.HOME!, ".ows", "bin", "ows"));
  });

  it("reads HOME at call time, not at import time", () => {
    const other = join(saved.HOME!, "other-home");
    process.env.HOME = other;
    expect(perpDir()).toBe(join(other, ".perp"));
  });

  it("HOME unset → PerpError INVALID_PARAMS with remediation", () => {
    delete process.env.HOME;
    const err = caught(() => perpPath("settings.json"));
    expect(err).toBeInstanceOf(PerpError);
    expect((err as PerpError).structured.code).toBe("INVALID_PARAMS");
    expect((err as PerpError).structured.remediation).toMatch(/Set HOME/);
  });

  it("a relative HOME (\"~\") is refused, not resolved against the CWD", () => {
    process.env.HOME = "~";
    expect(caught(() => perpDir())).toBeInstanceOf(PerpError);
  });

  it("Windows: HOME unset → USERPROFILE", () => {
    setPlatform("win32");
    delete process.env.HOME;
    process.env.USERPROFILE = saved.HOME;
    expect(perpDir()).toBe(join(saved.HOME!, ".perp"));
  });

  it("non-Windows: USERPROFILE is not a substitute for HOME", () => {
    setPlatform("linux");
    delete process.env.HOME;
    process.env.USERPROFILE = saved.HOME;
    expect(caught(() => perpDir())).toBeInstanceOf(PerpError);
  });
});

describe("HOME unset: fund-guarding state refuses instead of using ./~/.perp", () => {
  let cwd: string;
  const prevCwd = process.cwd();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "perp-paths-cwd-"));
    process.chdir(cwd);
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the Aster nonce allocator throws and writes nothing in the CWD", async () => {
    const { nextAsterNonce } = await import("../exchanges/aster-nonce.js");
    expect(caught(() => nextAsterNonce("0xabc", 1_700_000_000_000))).toBeInstanceOf(PerpError);
    expect(existsSync(join(cwd, "~"))).toBe(false);
  });

  it("saveSettings throws and writes nothing in the CWD", async () => {
    const { saveSettings, loadSettings } = await import("../settings.js");
    process.env.HOME = saved.HOME;
    const s = loadSettings();
    delete process.env.HOME;
    expect(caught(() => saveSettings(s))).toBeInstanceOf(PerpError);
    expect(existsSync(join(cwd, "~"))).toBe(false);
  });

  it("the bot quarantine list throws instead of reading an empty ./~ file", async () => {
    const { listQuarantine } = await import("../bot/quarantine.js");
    expect(caught(() => listQuarantine())).toBeInstanceOf(PerpError);
  });

  it("the quarantine check still fails closed (symbol treated as quarantined)", async () => {
    const { isQuarantined } = await import("../bot/quarantine.js");
    expect(isQuarantined("GUARDCOIN", () => {})).toBe(true);
  });

  it("logExecution warns instead of throwing (a filled order is never turned into a failure)", async () => {
    const { logExecution } = await import("../execution-log.js");
    const rec = logExecution({ type: "market_order", exchange: "hyperliquid", symbol: "GUARD", side: "buy", size: "1", status: "success", dryRun: true });
    expect(rec.status).toBe("success");
    expect(existsSync(join(cwd, "~"))).toBe(false);
  });
});
