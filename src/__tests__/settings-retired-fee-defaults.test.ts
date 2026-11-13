/**
 * A settings.json written by an earlier version holds the fee defaults that version shipped (every
 * save wrote DEFAULTS.fees). A stored entry exactly equal to a retired default is treated as unset at
 * load, so the current default applies; any other stored value still wins. HOME isolated
 * (helpers/isolate-home.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadSettings } from "../settings.js";
import { getMakerFee, getTakerFee } from "../constants.js";

const PERP_DIR = resolve(process.env.HOME ?? "", ".perp");
function storeFees(fees: unknown): void {
  mkdirSync(PERP_DIR, { recursive: true });
  writeFileSync(resolve(PERP_DIR, "settings.json"), JSON.stringify({ fees }));
}

beforeEach(() => { rmSync(PERP_DIR, { recursive: true, force: true }); });

describe("stored fees and the retired shipped defaults", () => {
  it("an entry equal to a retired default is unset — the current default applies", () => {
    storeFees({ hyperliquid: { taker: 0.00035, maker: 0.00002 }, pacifica: { taker: 0.00035, maker: 0.0001 } });
    expect([getTakerFee("hyperliquid"), getMakerFee("hyperliquid")]).toEqual([0.00045, 0.00015]);
    expect([getTakerFee("pacifica"), getMakerFee("pacifica")]).toEqual([0.0004, 0.00015]);
  });

  it("any other stored entry still wins — an Arcus 225 / 0 ppm entry (the RWA rate, set by `fees set`) included", () => {
    storeFees({ hyperliquid: { taker: 0.00035, maker: 0.0001 }, arcus: { taker: 0.000225, maker: 0 } });
    expect(loadSettings().fees.hyperliquid).toEqual({ taker: 0.00035, maker: 0.0001 });
    expect([getTakerFee("arcus"), getMakerFee("arcus")]).toEqual([0.000225, 0]);
  });
});
