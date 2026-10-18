/**
 * Arcus — perps on the Robinhood chain rootchain, USDG collateral
 * Not registered here; the registry module owns registerVenue().
 * Adapter and public-data code are loaded lazily.
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../arcus/public.js")).arcusPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../arcus/public.js")).arcusPublicData.fetchMarkets(net);
  },
};

export const arcusVenue: VenueDefinition = {
  id: "arcus",
  aliases: [],
  displayName: "Arcus",
  family: "arcus",
  masterKeyKind: "evm",
  agentKeyKind: "ed25519",
  // Ed25519 agent key lives only in OWS wallet `agent-arcus-<master>` (SSOT Rule #3).
  secretStorage: { kind: "ows-wallet", dir: null },
  networks: {
    mainnet: {
      restUrl: "https://api.arcus.xyz",
      wsUrl: "wss://api.arcus.xyz/v1/ws",
      explorerUrl: null,
      signingChainId: 4663,
      settlementChain: "robinhood",
      collateral: ["USDG"],
      collateralAssetIndex: null,
      rpcUrl: "https://rpc.mainnet.chain.robinhood.com", // eth_chainId 0x1237 = 4663 (verified)
      depositPins: null,
    },
    testnet: {
      restUrl: "https://api.testnet.arcus.xyz",
      wsUrl: "wss://api.testnet.arcus.xyz/v1/ws",
      explorerUrl: null,
      signingChainId: 46630,
      settlementChain: "robinhood",
      collateral: ["USDG"],
      collateralAssetIndex: null,
      rpcUrl: "https://rpc.testnet.chain.robinhood.com", // eth_chainId 0xb626 = 46630 (verified)
      depositPins: null,
    },
  },
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  fundingVerified: true,
  roles: ["marketData", "account", "trading"],
  capabilities: {
    marketOrder: "slippageBounded",
    // GTC = GTT at goodTil now + 40 days (ARCUS_GOOD_TIL_HORIZON_MS); GTT kept as the venue alias.
    timeInForce: ["GTC", "GTT", "IOC", "FOK", "ALO"],
    reduceOnlyTif: null,
    clientOrderId: true,
    orderAck: "async",
    tpsl: "batchGroup",
    amend: "native",
    batchPlaceMax: 100,
    marginModes: ["cross", "isolated"],
    withdrawAssets: ["USDG"],
  },
  // Per-IP bucket: 1,500 weight, refilling 1,500/min (docs "Rate limits").
  // Weights per the docs' tier table; unlisted endpoints cost 1 (root/time tier).
  // Order writes are 0 on the IP layer (per-subaccount pools govern them).
  rateLimit: {
    capacity: 1500,
    refillPerSec: 25,
    weights: {
      setLeverage: 125, withdraw: 125, transfer: 125,
      placeOrder: 0, modifyOrder: 0, cancelOrder: 0, cancelAllOrders: 0,
      batchPlaceOrders: 0, batchCancelOrders: 0, scheduleCancel: 0,
      account: 2, positions: 2, order: 2, leverages: 2, mids: 2,
      // l2OrderBook = 2 + floor(nLevels / 20); the adapter requests 50 levels (rate-limits doc).
      l2OrderBook: 4,
      markets: 20, prices: 20, trades: 20, candles: 20, openOrders: 20, orders: 20,
      fills: 20, funding: 20, fundingRates: 20, apiKeys: 20, createApiKey: 20, revokeApiKey: 20,
    },
  },
  restrictedRegions: ["US", "CA", "GB"],
  symbolIdentity: "baseTicker",
  publicData,
  // market swaps via router.spot.arcus.xyz, settled on-chain from the master EVM wallet.
  spot: {
    accountModel: "wallet",
    quoteAssets: { mainnet: ["USDG"], testnet: ["USDG"] },
    capabilities: { limitOrder: false, orderbook: false, cancel: false, transfer: false },
    async createSpot(perp, opts) {
      const [{ ArcusAdapter }, { ArcusSpotAdapter }] = await Promise.all([
        import("../arcus/adapter.js"), import("../arcus/spot.js"),
      ]);
      if (!(perp instanceof ArcusAdapter)) throw new Error(`arcus spot needs an ArcusAdapter (got ${perp.name})`);
      const spot = new ArcusSpotAdapter(perp, { confirmOnchainApprove: opts.confirmOnchainApprove });
      await spot.init();
      return spot;
    },
  },
  // Arcus venue slippage limit.
  maxSlippageBps: 1000,
  builderFee: BUILDER_FEE_CAPABILITIES["arcus"],
  apiStatus: { kind: "official" },
  async create(ctx) {
    const { ArcusAdapter } = await import("../arcus/adapter.js");
    return new ArcusAdapter(arcusVenue, ctx);
  },
};
