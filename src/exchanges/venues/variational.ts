/**
 * Variational (Omni) venue definition — MARKET DATA ONLY, through the OFFICIAL read-only API.
 *
 * Variational Omni is an RFQ venue: the Omni Liquidity Provider (OLP) is the only maker and quotes
 * every trade — there is no order book (docs.variational.io/variational-protocol/key-concepts/trading-via-rfq).
 * Its documented public API (docs.variational.io/technical-documentation/api) is one endpoint,
 * `GET /metadata/v2/stats`, serving every market at once. The trading API "is still in
 * development, and is not yet available to any users", so:
 *  - roles are ["marketData"]: every account / trading / funds / agent / builder / bot path refuses
 *    with CAPABILITY_UNSUPPORTED before any request (venue.ts roleUnsupported());
 *  - `market book` shows the OLP's indicative RFQ quotes at fixed notionals, labelled as such
 *    (never as order-book levels).
 * No WebSocket is documented, so there is no ws codec.
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";

export const VARIATIONAL_REST_URL = "https://omni-client-api.prod.ap-northeast-1.variational.io";
export const VARIATIONAL_API_DOCS = "https://docs.variational.io/technical-documentation/api";

/** Lazy: public.ts is only loaded when market data is actually requested. */
const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../variational/public.js")).variationalPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../variational/public.js")).variationalPublicData.fetchMarkets(net);
  },
};

export const variationalVenue: VenueDefinition = {
  id: "variational",
  aliases: ["var", "omni"],
  displayName: "Variational",
  family: "variational",
  masterKeyKind: "none",
  agentKeyKind: "none",
  secretStorage: { kind: "none", dir: null },
  networks: {
    mainnet: {
      restUrl: VARIATIONAL_REST_URL,
      // No WebSocket is documented.
      wsUrl: null,
      explorerUrl: null,
      signingChainId: null,
      // Settlement pools live on Arbitrum; perp-cli never touches them (read-only).
      settlementChain: "offchain",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    // No public testnet API.
    testnet: null,
  },
  // funding.interval_seconds is per market (1h / 4h / 8h perps; 24h swaps).
  fundingRateBasis: "perMarket",
  settlementIntervalHours: "perMarket",
  // The unit is documented: funding.last.interval_rate is a decimal fraction for one
  // interval_seconds window, positive = longs pay. Cross-checked on every perp of the live payload
  // (2026-10-19, 557 perps): interval_rate = annualized_rate × interval_seconds / 365 d within
  // rounding (max relative deviation 6e-4); a row that breaks that identity gets no rate.
  // Not checked against settled payments (no public account API).
  fundingVerified: true,
  roles: ["marketData"],
  gatedRoles: null,
  capabilities: null,
  // Documented: 10 requests / 10 s per IP (shared with the legacy v1 endpoint). One call serves
  // every market and is cached briefly (variational/public.ts), so commands rarely hit this.
  rateLimit: { capacity: 10, refillPerSec: 1, weights: null },
  // docs.variational.io/legal/restricted-persons (last updated 2026-04-20). Warn-only (never enforced).
  restrictedRegions: ["US", "CA", "CU", "IR", "KP", "SD", "SY", "TW", "PR", "GU", "VI", "AS", "MP", "UM", "FM", "MH", "PW"],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // Unused (no trading role); the field is required by the definition shape.
  maxSlippageBps: 1,
  builderFee: null,
  apiStatus: { kind: "official" },
  // A public-only adapter: market data works, every account / trading method refuses.
  async create(ctx) {
    const { VariationalPublicAdapter } = await import("../variational/adapter.js");
    return new VariationalPublicAdapter(variationalVenue, ctx.network);
  },
};
