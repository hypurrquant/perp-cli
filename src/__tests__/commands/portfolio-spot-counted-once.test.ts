/**
 * `perp portfolio` counts spot money once: a spot row already inside the venue's perp equity is
 * `shared` and is not added again. Real adapters and spot adapters; only `fetch` is stubbed
 * (no network). Pacifica `account_equity` is "Account balance + unrealized PnL + isolated margin +
 * raw spot market value" (docs get-account-info).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { Keypair } from "@solana/web3.js";
import { addRootSafetyOptions } from "../../cli-flags.js";
import { registerPortfolioCommand } from "../../commands/portfolio.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import PAC_MARKET_DATA from "../fixtures/pacifica/market-data-live.json";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const pacOk = (data: unknown) => json({ success: true, data, error: null, code: null });
const pathOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname.replace("/api/v1", "");

// GET /account (the live shape of balance-by-address.test.ts): 0.96 SOL held in spot.
const PAC_ACCOUNT = {
  balance: "4730.207244", account_equity: "3634.308012", available_to_spend: "2495.195745", available_to_withdraw: "2495.195745",
  pending_interest: "0", total_margin_used: "1119.653067", spot_balances: [{ symbol: "SOL", amount: "0.96", available_to_withdraw: "0.96" }],
};
// GET /info/prices row (live shape, conformance/pacifica.json) of the spot market.
const SOL_USDC_PRICE = { funding: "0", mark: "100", mid: "100.005", next_funding: "0", open_interest: "0", oracle: "100.019006", symbol: "SOL-USDC", timestamp: 1793071048106, volume_24h: "76508653.2516", yesterday_price: "100.72" };

function pacificaVenue(input: string | URL | Request): Response {
  switch (pathOf(input)) {
    case "/account": return pacOk(PAC_ACCOUNT);
    case "/info": return json(PAC_MARKET_DATA.info);
    case "/info/prices": return pacOk([SOL_USDC_PRICE]);
    case "/positions": case "/orders": case "/funding/history": return pacOk([]);
    default: throw new Error(`unexpected Pacifica request ${pathOf(input)}`);
  }
}

interface PortfolioData {
  exchanges: Array<{ perp: { equity: string }; totalAccountValueUsd: number }>;
  totals: { accountValueUsd: number };
}

async function portfolio(venue: string, adapter: ExchangeAdapter): Promise<PortfolioData> {
  const prog = new Command();
  prog.exitOverride();
  addRootSafetyOptions(prog).option("-e, --exchange <exchange>", "Exchange", "pacifica").option("--json", "JSON output");
  registerPortfolioCommand(prog, async () => adapter, () => true, "1.0.0-test");
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await prog.parseAsync(["node", "perp", "-e", venue, "--json", "portfolio"]);
  const joined = out.join("");
  return JSON.parse(joined.slice(joined.indexOf("{"))).data;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("portfolio: spot money is counted once", () => {
  it("Pacifica: spot holdings are inside account_equity — the account value is account_equity", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => pacificaVenue(input)));
    const data = await portfolio("pacifica", new PacificaAdapter(Keypair.generate(), "mainnet"));
    expect(data.exchanges[0].perp.equity).toBe("3634.308012");
    expect(data.exchanges[0].totalAccountValueUsd).toBe(3634.308012);
    expect(data.totals.accountValueUsd).toBe(3634.308012);
  });
});
