/**
 * Lighter asset-index defaults on the funds tree.
 *
 * The on-chain bridge takes `deposit(address _to, uint8 _assetIndex, uint8
 * _routeType, uint256 _amount)`, and the Lighter deposit docs name
 * GET /api/v1/assetDetails as the source for `_assetIndex`. That registry is
 * `3 = USDC (l1_decimals 6)`, `2 = LIT (l1_decimals 18)`, `1 = ETH`.
 *
 * Both the deposit and the withdraw command shipped a `--asset-id` default of
 * "2" labelled "USDC". 966ffc0 corrected the withdraw side (P0) but missed the
 * deposit side, which kept declaring USDC transfers as LIT while the same
 * handler approves the USDC ERC20 and sizes the amount with parseUnits(amt, 6).
 *
 * These assertions pin the option defaults themselves — the defect was in the
 * declared default, not in the handler, so a handler test would not have caught
 * it (and did not).
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerFundsCommands } from "../../commands/funds.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";

const LIGHTER_USDC_ASSET_ID = "3";

function buildProgram(): Command {
  const prog = new Command();
  prog.exitOverride();
  registerFundsCommands(
    prog,
    async () => { throw new Error("getAdapter should not be called for option-default checks"); },
    () => true,
    () => "mainnet" as const,
    async () => { throw new Error("getAdapterForExchange should not be called for option-default checks"); },
  );
  return prog;
}

/** Walk the command tree by name path, e.g. ["funds","deposit","lighter","ethereum"]. */
function findCommand(root: Command, path: string[]): Command {
  let cur: Command = root;
  for (const name of path) {
    const next = cur.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`command not found: ${path.join(" ")} (missing "${name}")`);
    cur = next as Command;
  }
  return cur;
}

function assetIdOption(cmd: Command) {
  const opt = cmd.options.find((o) => o.long === "--asset-id");
  if (!opt) throw new Error(`--asset-id not declared on "${cmd.name()}"`);
  return opt;
}

describe("Lighter --asset-id defaults match the live assetDetails registry", () => {
  it("deposit lighter ethereum defaults to USDC (3), not LIT (2)", () => {
    const cmd = findCommand(buildProgram(), ["funds", "deposit", "lighter", "ethereum"]);
    expect(assetIdOption(cmd).defaultValue).toBe(LIGHTER_USDC_ASSET_ID);
  });

  it("deposit lighter ethereum --asset-id description does not mislabel 2 as USDC", () => {
    const cmd = findCommand(buildProgram(), ["funds", "deposit", "lighter", "ethereum"]);
    expect(assetIdOption(cmd).description).not.toMatch(/2\s*=\s*USDC/i);
  });

  it("withdraw lighter still defaults to USDC (3) — 966ffc0 must not regress", () => {
    const cmd = findCommand(buildProgram(), ["funds", "withdraw", "lighter"]);
    expect(assetIdOption(cmd).defaultValue).toBe(LIGHTER_USDC_ASSET_ID);
  });

  it("deposit and withdraw agree on the USDC asset index", () => {
    const prog = buildProgram();
    const dep = assetIdOption(findCommand(prog, ["funds", "deposit", "lighter", "ethereum"]));
    const wd = assetIdOption(findCommand(prog, ["funds", "withdraw", "lighter"]));
    expect(dep.defaultValue).toBe(wd.defaultValue);
  });
});
