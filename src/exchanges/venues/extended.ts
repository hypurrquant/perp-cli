/**
 * Extended (formerly X10) — perps order book on Starknet, USD collateral. MARKET DATA ONLY in this
 * version, through the OFFICIAL public REST API (https://api.docs.extended.exchange/).
 *
 *  - roles are ["marketData"]: every account / trading / funds / agent / builder / bot path
 *    refuses with CAPABILITY_UNSUPPORTED before any request (venue.ts roleUnsupported(), with the
 *    readOnlyRemediation below). There is no Extended order, signing (Stark), transfer or account
 *    code at all; trading is planned for a later release.
 *  - Hosts (docs "Mainnet" / "Testnet"): mainnet api.starknet.extended.exchange, testnet (Sepolia)
 *    api.starknet.sepolia.extended.exchange. The old api.extended.exchange answers 404.
 *  - Every request must carry a User-Agent header (docs "Mandatory headers"; none → HTTP 403).
 *  - Funding (docs "Get funding rates history", docs.extended.exchange funding-payments): applied
 *    once per hour; marketStats.fundingRate is the current hour's ACCRUING rate (recomputed every
 *    minute) as a FRACTION per hour — see extended/public.ts.
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";

export const EXTENDED_DOCS_URL = "https://api.docs.extended.exchange/";

/** The remediation of every role refusal (owner decision: phase 1 is read-only). */
export const EXTENDED_READ_ONLY_REMEDIATION =
  "Extended is read-only (market data) in this version; trading is planned for a later release. Market data: perp -e extended market list|prices|info|book|trades|funding|kline";

/** Lazy: public.ts is only loaded when market data is actually requested. */
const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../extended/public.js")).extendedPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../extended/public.js")).extendedPublicData.fetchMarkets(net);
  },
};

export const extendedVenue: VenueDefinition = {
  id: "extended",
  aliases: ["ext", "x10"],
  displayName: "Extended",
  family: "extended",
  masterKeyKind: "none",
  agentKeyKind: "none",
  secretStorage: { kind: "none", dir: null },
  networks: {
    mainnet: {
      restUrl: "https://api.starknet.extended.exchange/api/v1",
      wsUrl: "wss://api.starknet.extended.exchange/stream.extended.exchange/v1",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "starknet",
      collateral: ["USD"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    testnet: {
      restUrl: "https://api.starknet.sepolia.extended.exchange/api/v1",
      // The docs' SDK config (TESTNET_CONFIG stream_url). Unused (no ws codec); live 2026-10-19 it
      // answered HTTP 403 to a public stream (api.starknet.sepolia… answered 503) — unverified.
      wsUrl: "wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "starknet",
      collateral: ["USD"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
  },
  // Funding is applied once per hour on every perpetual market; the published rate is per hour.
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  // Not verified: the unit / sign of marketStats.fundingRate is not checked against a settled account
  // funding payment (needs an account; RISEx's bar). Partial evidence only: docs + one recorded
  // settlement (src/__tests__/fixtures/extended/funding-settlement-evidence.json — last accruing value
  // == applied print on 8 markets, 5 of them at the baseline). And `_24_5` equities print 0 while
  // their underlying is closed (TSLA_24_5: 34 of 43 weekend prints were 0), so hourly × 8760
  // overstates them. Until settled against payments Extended is not a funding-arb venue.
  fundingVerified: false,
  roles: ["marketData"],
  capabilities: null,
  // Docs "Rate Limits": default tier 1,000 requests/minute per IP, all endpoints throttled by IP.
  // 15/s sustained (900/min) leaves headroom for other processes on the same IP.
  rateLimit: { capacity: 50, refillPerSec: 15, weights: null },
  // docs.extended.exchange/extended-resources/legal/restricted-countries (2026-10-19), Category A;
  // Ukraine is restricted only for Crimea / Donetsk / Kherson / Luhansk / Zaporizhzhia (no alpha-2).
  // Warning-only and shown with credentials — unused while the venue is market data only.
  restrictedRegions: ["AF", "CA", "HK", "CU", "IR", "IQ", "YE", "KP", "RU", "SY", "SC", "GB", "US"],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // Unused (no trading role); the field is required by the definition shape.
  maxSlippageBps: 1,
  builderFee: null,
  apiStatus: { kind: "official" },
  gatedRoles: null,
  readOnlyRemediation: EXTENDED_READ_ONLY_REMEDIATION,
  // A public-only adapter: market data works, every account / trading method refuses.
  async create(ctx) {
    const { ExtendedPublicAdapter } = await import("../extended/adapter.js");
    return new ExtendedPublicAdapter(extendedVenue, ctx.network);
  },
};
