/**
 * Pacifica venue definition.
 * Adapter + public-data code are loaded lazily.
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../../funding/legacy-public.js")).legacyPublicData("pacifica").fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../../funding/legacy-public.js")).legacyPublicData("pacifica").fetchMarkets(net);
  },
};

/** Pacifica `client_order_id` format: "Full UUID string" (docs.pacifica.fi rest-api orders/create-limit-order). */
export const PACIFICA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const pacificaVenue: VenueDefinition = {
  id: "pacifica",
  aliases: ["pac"],
  displayName: "Pacifica",
  family: "pacifica",
  masterKeyKind: "solana",
  agentKeyKind: "solana",
  secretStorage: { kind: "ows-wallet", dir: null },
  // URLs: src/pacifica/constants.ts
  networks: {
    mainnet: {
      restUrl: "https://api.pacifica.fi/api/v1",
      wsUrl: "wss://ws.pacifica.fi/ws",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "solana",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    testnet: {
      restUrl: "https://test-api.pacifica.fi/api/v1",
      wsUrl: "wss://test-ws.pacifica.fi/ws",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "solana",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
  },
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  fundingVerified: true,
  roles: ["marketData", "account", "trading"],
  capabilities: {
    marketOrder: "slippageBounded",
    timeInForce: ["GTC", "IOC", "ALO", "TOB"],
    reduceOnlyTif: null,
    // docs.pacifica.fi rest-api orders/create-limit-order: `client_order_id` | Full UUID string |
    // optional | "Client-defined order ID"; orders/cancel-order accepts `client_order_id`
    // ("required (if no OID)"). CLI rule: V2_CLIENT_ID_RULES (commands/trade.ts) / PACIFICA_UUID_RE.
    clientOrderId: true,
    orderAck: "sync",
    tpsl: "positionLevel",
    amend: "native",
    batchPlaceMax: null,
    marginModes: ["cross", "isolated"],
    withdrawAssets: ["USDC"],
  },
  // docs.pacifica.fi "Rate limits": "Pacifica uses a credit-based rate limiting system with a
  // 60-second rolling window." Tier "Unidentified IP | 125" base credits/60s (valid API Config
  // Key: 300); "Standard request/action | 1" credit.
  // Declared only — per the limiter is applied to new venues + lighter-rh.
  rateLimit: { capacity: 125, refillPerSec: 125 / 60, weights: null },
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  // spot (SOL-USDC) shares the perp account — USDC is perp margin, no transfer.
  spot: {
    accountModel: "unified",
    quoteAssets: { mainnet: ["USDC"], testnet: ["USDC"] },
    capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: false },
    async createSpot(perp) {
      const [{ PacificaAdapter }, { PacificaSpotAdapter }] = await Promise.all([
        import("../pacifica.js"), import("../pacifica-spot.js"),
      ]);
      if (!(perp instanceof PacificaAdapter)) throw new Error(`pacifica spot needs a PacificaAdapter (got ${perp.name})`);
      const spot = new PacificaSpotAdapter(perp);
      await spot.init();
      return spot;
    },
  },
  maxSlippageBps: 5000,
  builderFee: BUILDER_FEE_CAPABILITIES["pacifica"],
  apiStatus: { kind: "official" },
  create: async ctx => (await import("./create-helpers.js")).createPacifica(ctx),
};
