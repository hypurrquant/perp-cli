/**
 * Live, read-only checks (gated):
 *   PERP_RISEX_LIVE=1   RISEx public reads on mainnet and testnet, pins still match, funding unit.
 *   PERP_TXFLOW_LIVE=1  TxFlow drift detector: perpMeta / l2Book / WS snapshot still readable and
 *                       joinable by id; the HL-style 0.00125 %/h baseline still dominates.
 * Nothing is signed or sent.
 */
import { describe, it, expect } from "vitest";
import "../../exchanges/venues/index.js";
import { getVenue } from "../../exchanges/venue.js";
import { risexClient, fetchRisexRawMarkets } from "../../exchanges/risex/public.js";
import { assertReviewedContracts, chainReader, loadSigningContext } from "../../exchanges/risex/session.js";
import { RISEX_PINS } from "../../exchanges/risex/typed-data.js";
import { RisexAdapter } from "../../exchanges/risex/adapter.js";
import { TxflowClient, fetchAllAssetCtxsOnce } from "../../exchanges/txflow/client.js";
import { fetchTxflowDirectory, fetchTxflowFundingRates, fetchTxflowMarkets } from "../../exchanges/txflow/public.js";
import { TxflowAdapter } from "../../exchanges/txflow/adapter.js";

describe.skipIf(process.env.PERP_RISEX_LIVE !== "1")("RISEx live public reads", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    it(`${net}: markets, funding, book, trades, pinned signing context`, async () => {
      const def = getVenue("risex");
      const markets = await def.publicData.fetchMarkets(net);
      expect(markets.find(m => m.symbol === "BTC")?.fundingRateBasis).toEqual({ kind: "perHours", hours: 1 });
      const rates = await def.publicData.fetchFundingRates(net);
      expect(rates.length).toBeGreaterThan(0);
      // A fraction per hour, not percent (mainnet; testnet markets can sit at extreme rates).
      if (net === "mainnet") for (const r of rates) expect(Math.abs(Number(r.rate))).toBeLessThan(0.01);
      await loadSigningContext(risexClient(net), net); // throws when the router / auth / chain moved
      // The reviewed permission model still holds: same implementations, same registry, no permission id ≥5.
      const chain = chainReader(net);
      const pin = RISEX_PINS[net];
      expect((await chain.implementationOf(pin.auth)).toLowerCase()).toBe(pin.authImplementation.toLowerCase());
      expect((await chain.implementationOf(pin.router)).toLowerCase()).toBe(pin.routerImplementation.toLowerCase());
      expect((await chain.accountRegistry()).toLowerCase()).toBe(pin.accountRegistry.toLowerCase());
      expect((await chain.implementationOf(pin.accountRegistry)).toLowerCase()).toBe(pin.accountRegistryImplementation.toLowerCase());
      await assertReviewedContracts(chain, net);
      expect(await chain.permissionIdExists(5)).toBe(false);
      expect(await chain.permissionIdExists(4)).toBe(true);
      const a = new RisexAdapter(def, net, { account: null, signer: null, meta: null, noSignerReason: null });
      const book = await a.getOrderbook("BTC");
      expect(book.bids.length + book.asks.length).toBeGreaterThan(0);
      expect((await a.getFundingHistory("BTC", 3)).length).toBeGreaterThan(0);
      expect((await fetchRisexRawMarkets(risexClient(net))).length).toBeGreaterThan(0);
    });
  }
});

describe.skipIf(process.env.PERP_TXFLOW_LIVE !== "1")("TxFlow live drift detector (official API, Beta)", () => {
  it("perpMeta + WS snapshot still join by id; funding still percent per hour", async () => {
    const def = getVenue("txflow");
    const dir = await fetchTxflowDirectory(new TxflowClient(def.networks.mainnet.restUrl, def.rateLimit));
    expect(dir.length).toBeGreaterThan(100);
    const ctxs = await fetchAllAssetCtxsOnce(def.networks.mainnet.wsUrl as string);
    const ids = new Set(dir.map(m => String(m.index)));
    expect(ctxs.filter(c => ids.has(c.coin)).length).toBeGreaterThan(dir.length * 0.9);
    const baseline = ctxs.filter(c => c.ctx.funding === "0.00125000").length;
    expect(baseline).toBeGreaterThan(ctxs.length / 4);
    const rates = await fetchTxflowFundingRates("mainnet");
    expect(rates.find(r => r.symbol === "BTC")).toBeDefined();
    const book = await new TxflowAdapter(def, "mainnet").getOrderbook("BTC");
    expect(book.bids.length).toBeGreaterThan(0);
    // webData2 assetCtxs still carries 24 h volume for the listed perps.
    const markets = await fetchTxflowMarkets("mainnet");
    expect(markets.filter(m => m.volume24h !== null).length).toBeGreaterThan(markets.length / 2);
  });
});
