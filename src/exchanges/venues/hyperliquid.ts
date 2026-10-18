/**
 * Hyperliquid venue definition.
 * HIP-3 dexes are not venues: they are selected via VenueCreateContext.hlDex.
 * Adapter + public-data code are loaded lazily.
 */

import type { Network, VenueDefinition, VenuePublicData } from "../venue.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

/**
 * Per-network parameters of Hyperliquid *user-signed* actions (approveAgent,
 * userSetAbstraction, …) — EIP-712 domain "HyperliquidSignTransaction".
 * `hyperliquidChain` selects the HL environment and prevents cross-network
 * replay; `signatureChainId` is the wallet signing chain and must equal the
 * domain chainId. Values mirror hyperliquid-python-sdk `sign_user_signed_action`
 * ("Mainnet"/"Testnet") and the exchange-endpoint docs ("0xa4b1" Arbitrum One;
 * testnet signs on Arbitrum Sepolia 0x66eee as the SDK does).
 */
export const HL_USER_SIGNED: Record<Network, {
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainIdHex: string;
  signatureChainId: number;
}> = {
  mainnet: { hyperliquidChain: "Mainnet", signatureChainIdHex: "0xa4b1", signatureChainId: 42161 },
  testnet: { hyperliquidChain: "Testnet", signatureChainIdHex: "0x66eee", signatureChainId: 421614 },
};

/** Hyperliquid client order id (cloid): "0x" + 32 lowercase hex chars (128 bits). */
export const HL_CLOID_RE = /^0x[0-9a-f]{32}$/;

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../../funding/legacy-public.js")).legacyPublicData("hyperliquid").fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../../funding/legacy-public.js")).legacyPublicData("hyperliquid").fetchMarkets(net);
  },
};

export const hyperliquidVenue: VenueDefinition = {
  id: "hyperliquid",
  aliases: ["hl"],
  displayName: "Hyperliquid",
  family: "hyperliquid",
  masterKeyKind: "evm",
  agentKeyKind: "evm",
  secretStorage: { kind: "ows-wallet", dir: null },
  // REST: src/exchanges/hyperliquid.ts; mainnet WS: src/dashboard/ws-feeds.ts.
  // Testnet WS per the HL websocket docs (opened in the 2026-10-13 ws probe). signingChainId: L1 action phantom-agent domain (hyperliquid.ts).
  networks: {
    mainnet: {
      restUrl: "https://api.hyperliquid.xyz",
      wsUrl: "wss://api.hyperliquid.xyz/ws",
      explorerUrl: null,
      signingChainId: 1337,
      settlementChain: "hyperliquid",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    testnet: {
      restUrl: "https://api.hyperliquid-testnet.xyz",
      wsUrl: "wss://api.hyperliquid-testnet.xyz/ws",
      explorerUrl: null,
      signingChainId: 1337,
      settlementChain: "hyperliquid",
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
  // marketOrder: IOC limit at a protection price. Declared reference
  // price = l2Book mid ((best bid + best ask) / 2) for native perps, HIP-3 and spot —
  // no runtime substitute; a one-sided/empty book → PRICE_STALE. Rounding: 5 significant
  // figures, max 6 − szDecimals (perp) / 8 − szDecimals (spot) decimals, toward crossing.
  // tpsl stays "separateOrders": HL `normalTpsl` grouping was evaluated and not
  // used — its children have a fixed size equal to the parent and are fully cancelled when
  // a partially filled parent is cancelled (HL docs, TP/SL orders), so a partially filled
  // IOC entry would be left unprotected; separateOrders sizes TP/SL to the verified fill.
  capabilities: {
    marketOrder: "slippageBounded",
    timeInForce: ["GTC", "IOC", "ALO"],
    reduceOnlyTif: null,
    // HL docs exchange-endpoint "Place an order": `c` "Cloid (client order id)" — "an optional
    // 128 bit hex string, e.g. 0x1234567890abcdef1234567890abcdef"; cancelled by `cancelByCloid`,
    // queried by info `orderStatus` (`oid` "u64 … or 16-byte hex string representing the client
    // order id"). Native perps and HIP-3 dexes alike (the global asset id selects the dex).
    clientOrderId: true,
    orderAck: "sync",
    tpsl: "separateOrders",
    amend: "native",
    batchPlaceMax: null,
    marginModes: ["cross", "isolated"],
    withdrawAssets: ["USDC"],
  },
  // HL docs "Rate limits and user limits": REST requests share an aggregated
  // weight of 1200/min per IP. Exchange actions weigh 1 (unbatched); light info
  // requests 2; most info requests 20; userRole 60.
  // Declared only — per the limiter is applied to new venues + lighter-rh.
  rateLimit: {
    capacity: 1200,
    refillPerSec: 20,
    weights: {
      l2Book: 2, allMids: 2, clearinghouseState: 2, orderStatus: 2, spotClearinghouseState: 2, exchangeStatus: 2,
      userRole: 60,
    },
  },
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  // spot USDC is shared with perp margin when the account is unified (isUnifiedAccount, read at init).
  spot: {
    accountModel: "runtime",
    quoteAssets: { mainnet: ["USDC"], testnet: ["USDC"] },
    capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: true },
    async createSpot(perp) {
      const [{ HyperliquidAdapter }, { HyperliquidSpotAdapter }] = await Promise.all([
        import("../hyperliquid.js"), import("../hyperliquid-spot.js"),
      ]);
      if (!(perp instanceof HyperliquidAdapter)) throw new Error(`hyperliquid spot needs a HyperliquidAdapter (got ${perp.name})`);
      const spot = new HyperliquidSpotAdapter(perp);
      await spot.init();
      return spot;
    },
  },
  maxSlippageBps: 5000,
  builderFee: BUILDER_FEE_CAPABILITIES["hyperliquid"],
  apiStatus: { kind: "official" },
  create: async ctx => (await import("./create-helpers.js")).createHyperliquid(ctx),
};
