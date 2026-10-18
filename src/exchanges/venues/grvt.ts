/**
 * GRVT venue definition — MARKET DATA ONLY in this version (official, documented API).
 *
 * GRVT (api-docs.grvt.io) is a hybrid perps exchange (off-chain matching, ZK-validium settlement on
 * GRVT chain 325), USDT collateral. perp-cli reads its public Market Data REST API
 * (`POST https://market-data.grvt.io/full/v1/<endpoint>`, no key) and nothing else:
 *  - roles are ["marketData"]: every account / trading / funds / agent / builder / bot path refuses
 *    with CAPABILITY_UNSUPPORTED before any request (venue.ts roleUnsupported(), with the
 *    readOnlyRemediation below). There is no GRVT order, signing, transfer or account code at all.
 *  - funding is unverified (fundingVerified false): the ticker's `funding_rate` is the venue's
 *    indicative rate for the active interval (a moving estimate of the next payment, "predicted"),
 *    quoted in percent per the market's own funding interval (4 h or 8 h, per instrument). The
 *    percent unit is documented for settled history (/full/v1/funding "percentage points") and
 *    observed identical in magnitude on the ticker (whose schema says "centibeeps"); it is not yet
 *    checked against settled funding payments (an authenticated read) — kept out of arb ranking
 *    unless --include-unverified.
 * Not registered here; the registry module owns registerVenue().
 */

import type { RateLimitPolicy, VenueDefinition, VenuePublicData } from "../venue.js";

export const GRVT_DOCS_URL = "https://api-docs.grvt.io";

/** Uniform refusal text for every write / signer / setup-trading path on GRVT. */
export const GRVT_READ_ONLY_REMEDIATION = "GRVT is read-only (market data) in this version; trading is planned for a later release";

/**
 * help.grvt.io "What are the rate limitations on Grvt?" — REST Market Data, every tier, per minute:
 * GetInstrument / MiniTicker / Ticker 1500, all others 500 (WS JSON-RPC calls count too). Two token
 * buckets sized so that no 60 s window can exceed the limit (capacity + 60 s × refill ≤ limit).
 */
export const GRVT_TICKER_RATE_LIMIT: RateLimitPolicy = { capacity: 750, refillPerSec: 12, weights: null };
export const GRVT_OTHER_RATE_LIMIT: RateLimitPolicy = { capacity: 250, refillPerSec: 4, weights: null };

/** Lazy: public.ts is only loaded when market data is actually requested. */
const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../grvt/public.js")).grvtPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../grvt/public.js")).grvtPublicData.fetchMarkets(net);
  },
};

export const grvtVenue: VenueDefinition = {
  id: "grvt",
  aliases: ["grv"],
  displayName: "GRVT",
  family: "grvt",
  masterKeyKind: "none",
  agentKeyKind: "none",
  secretStorage: { kind: "none", dir: null },
  networks: {
    // grvt-pysdk grvt_raw_env.py (PROD / TESTNET); the docs' "Try it out" uses the same hosts.
    mainnet: {
      restUrl: "https://market-data.grvt.io",
      wsUrl: "wss://market-data.grvt.io/ws/full",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "offchain",
      collateral: ["USDT"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    testnet: {
      restUrl: "https://market-data.testnet.grvt.io",
      wsUrl: "wss://market-data.testnet.grvt.io/ws/full",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "offchain",
      collateral: ["USDT"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
  },
  // Per instrument: funding_interval_hours is 8 or 4 (live 2026-10-19: 124 × 8 h, 60 × 4 h).
  fundingRateBasis: "perMarket",
  settlementIntervalHours: "perMarket",
  fundingVerified: false,
  roles: ["marketData"],
  // Not a release gate (nothing is implemented and switched off): the venue has no trading code yet.
  gatedRoles: null,
  capabilities: null,
  // "All others" bucket (instruments, book, trade, funding, kline, margin_rules); the ticker bucket
  // is GRVT_TICKER_RATE_LIMIT (grvt/client.ts picks per endpoint).
  rateLimit: GRVT_OTHER_RATE_LIMIT,
  // help.grvt.io/en/articles/9711621-restricted-jurisdictions (also Crimea / Donetsk / Luhansk /
  // Kherson / Zaporizhzhya / Sevastopol regions). Trading needs KYC — relevant once trading lands.
  restrictedRegions: ["US", "PR", "AS", "GU", "MP", "VI", "SG", "HK", "KP", "IR", "MM", "BY", "CU", "AF", "CA", "LY", "RU", "SO", "SS", "SD", "SY"],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // Unused (no trading role); the field is required by the definition shape.
  maxSlippageBps: 1,
  builderFee: null,
  apiStatus: { kind: "official" },
  readOnlyRemediation: GRVT_READ_ONLY_REMEDIATION,
  // A public-only adapter: market data works, every account / trading method refuses.
  async create(ctx) {
    const { GrvtPublicAdapter } = await import("../grvt/adapter.js");
    return new GrvtPublicAdapter(grvtVenue, ctx.network);
  },
};
