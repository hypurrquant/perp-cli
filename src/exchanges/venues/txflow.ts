/**
 * TxFlow venue definition — MARKET DATA ONLY, through TxFlow's official API (Beta).
 *
 * Docs: https://docs.txflow.com/api (Info API `POST /info`, WebSocket `/ws`; host rpc.txflow.com,
 * every `/info` request sends `x-api-version`). perp-cli reads market data only:
 *  - funding is unverified (fundingVerified false): the rate is documented in PERCENT per settlement
 *    interval, but the docs do not say whether it is the next settlement's estimate or the last
 *    settled print, and there is no public market funding-history read to check it against — kept
 *    out of arb ranking unless --include-unverified;
 *  - roles are ["marketData"]: every account / trading / funds / agent / builder / bot path
 *    refuses with CAPABILITY_UNSUPPORTED before any request (venue.ts roleUnsupported()).
 * There is no TxFlow order, transfer or account code at all.
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";

export const TXFLOW_REST_URL = "https://rpc.txflow.com";
export const TXFLOW_WS_URL = "wss://rpc.txflow.com/ws";
/** Sent as `x-api-version` on every `/info` request (docs: Overview → Versioning). */
export const TXFLOW_API_VERSION = "2026-08-16";
/** Refusal remediation for every account / trading path (market funding history is not readable either). */
export const TXFLOW_READ_ONLY_REMEDIATION =
  "Trade on the TxFlow website; perp-cli shows TxFlow market data only (perp -e txflow market list|prices|info|book|trades|kline)";

/** Lazy: public.ts (and `ws`) is only loaded when market data is actually requested. */
const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../txflow/public.js")).txflowPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../txflow/public.js")).txflowPublicData.fetchMarkets(net);
  },
};

export const txflowVenue: VenueDefinition = {
  id: "txflow",
  aliases: ["txf"],
  displayName: "TxFlow",
  family: "txflow",
  masterKeyKind: "none",
  agentKeyKind: "none",
  secretStorage: { kind: "none", dir: null },
  networks: {
    mainnet: {
      restUrl: TXFLOW_REST_URL,
      wsUrl: TXFLOW_WS_URL,
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "offchain",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    // No public testnet.
    testnet: null,
  },
  // settlementIntervalMs = 3600000 on every market (marketTicker); the rate is percent per hour.
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  // Percent per settlement interval (docs: marketTicker `fundingRate`); whether it is the next
  // settlement's estimate or the last settled print is undocumented and there is no public
  // funding-history read to check it, so it stays unverified.
  fundingVerified: false,
  roles: ["marketData"],
  gatedRoles: null,
  readOnlyRemediation: TXFLOW_READ_ONLY_REMEDIATION,
  capabilities: null,
  // Docs (Rate limits): /info 50 requests/s per IP, then HTTP 429 + Retry-After. Kept well under it.
  rateLimit: { capacity: 20, refillPerSec: 10, weights: null },
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // Unused (no trading role); the field is required by the definition shape.
  maxSlippageBps: 1,
  builderFee: null,
  apiStatus: { kind: "official" },
  // A public-only adapter: market data works, every account / trading method refuses.
  async create(ctx) {
    const { TxflowPublicAdapter } = await import("../txflow/adapter.js");
    return new TxflowPublicAdapter(txflowVenue, ctx.network);
  },
};
