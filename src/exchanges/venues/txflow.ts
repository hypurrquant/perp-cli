/**
 * TxFlow venue definition — MARKET DATA ONLY, through an UNOFFICIAL API.
 *
 * TxFlow publishes no official trading / data API yet (its "Platform API" is "Coming Soon").
 * perp-cli reads the undocumented Hyperliquid-style `POST /info` endpoint and the WebSocket the
 * TxFlow web app itself uses. It may change or be blocked without notice, so:
 *  - apiStatus is "unofficial" and every user-facing surface labels it;
 *  - funding is unverified (fundingVerified false): the rate is quoted in PERCENT per hour and is a
 *    live, moving estimate — kept out of arb ranking unless --include-unverified;
 *  - roles are ["marketData"]: every account / trading / funds / agent / builder / bot path
 *    refuses with CAPABILITY_UNSUPPORTED before any request (venue.ts roleUnsupported()).
 * There is no TxFlow order, transfer or account code at all.
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";

export const TXFLOW_REST_URL = "https://api.txflow.com";
export const TXFLOW_WS_URL = "wss://api.txflow.com/ws";

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
  // Unofficial API; the percent unit is inferred (HL-style 0.00125 %/h baseline on most markets);
  // the published value moves every tick (a live estimate, not a settled print).
  fundingVerified: false,
  roles: ["marketData"],
  gatedRoles: null,
  capabilities: null,
  // No rate-limit headers are published; conservative.
  rateLimit: { capacity: 20, refillPerSec: 2, weights: null },
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // Unused (no trading role); the field is required by the definition shape.
  maxSlippageBps: 1,
  builderFee: null,
  apiStatus: {
    kind: "unofficial",
    note: "undocumented HL-style API used by the app.txflow.com web app; read-only in perp-cli and may change or be blocked without notice",
    docs: "https://docs.txflow.com",
  },
  // A public-only adapter: market data works, every account / trading method refuses.
  async create(ctx) {
    const { TxflowPublicAdapter } = await import("../txflow/adapter.js");
    return new TxflowPublicAdapter(txflowVenue, ctx.network);
  },
};
