/**
 * Lighter-family constants shared by the `lighter` and `lighter-rh` venues
 *
 * Both venues run the same API/engine and the same LighterAdapter class; they
 * differ only in the values below. This module has no runtime imports so venue
 * definitions and public-data paths can use it without loading the WASM SDK.
 */

import type { RateLimitPolicy, VenueCapabilities, VenueNetworkConfig } from "../venue.js";

export type LighterVenueId = "lighter" | "lighter-rh";

/**
 * Lighter (main). REST hosts are the values LighterAdapter used before
 * venue-parameterization. Mainnet WS is the one ws-feeds.ts connects to.
 * Testnet WS per apidocs.lighter.xyz websocket-reference (opened in the 2026-10-13 ws probe).
 * explorerUrl is the explorer API host; callers append `/api/...`
 * (lighter-spot.ts uses `${explorerUrl}/api/markets`). The testnet explorer host
 * is the one lighter-ts-sdk documented (`https://testnet.explorer.elliot.ai/api`).
 */
export const LIGHTER_NETWORKS: { mainnet: VenueNetworkConfig; testnet: VenueNetworkConfig } = {
  mainnet: {
    restUrl: "https://mainnet.zklighter.elliot.ai",
    wsUrl: "wss://mainnet.zklighter.elliot.ai/stream",
    explorerUrl: "https://explorer.elliot.ai",
    signingChainId: 304,
    settlementChain: "ethereum",
    collateral: ["USDC"],
    collateralAssetIndex: 3,
    rpcUrl: null,
    depositPins: null,
  },
  testnet: {
    restUrl: "https://testnet.zklighter.elliot.ai",
    wsUrl: "wss://testnet.zklighter.elliot.ai/stream",
    explorerUrl: "https://testnet.explorer.elliot.ai",
    signingChainId: 300,
    settlementChain: "ethereum",
    collateral: ["USDC"],
    collateralAssetIndex: 3,
    rpcUrl: null,
    depositPins: null,
  },
};

/**
 * Lighter RH (apidocs.rh.lighter.xyz). Chain ids 466324 / 300 per get-started.md.
 * Collateral asset id 3, 6 decimals on both networks — but a different token:
 * mainnet asset 3 is USDG, testnet asset 3 is USDC (live GET
 * api.rh-testnet.lighter.xyz/api/v1/assetDetails, 2026-10-02: ids 1 ETH, 2 LIT,
 * 3 USDC l1_decimals 6 / decimals 6; no USDG listed).
 * explorerUrl is the explorer **API** host (`https://explorerapi.rh.lighter.xyz/api/`,
 * rate-limits.md); no UI explorer URL is documented.
 * Testnet WS is not documented → null (a WS upgrade on
 * wss://api.rh-testnet.lighter.xyz/stream answered 101 on 2026-09-30, but HTTP 403 from
 * CloudFront in the 2026-10-13 ws probe).
 * Testnet explorer is not documented → null.
 * rpcUrl (mainnet): Robinhood Chain RPC — the L1 the RH contract lives on
 * (GET /api/v1/layer1BasicInfo l1_providers chainId 4663; eth_chainId 0x1237 verified
 * 2026-10-02; same RPC as the Arcus venue). Testnet: the RH testnet L1 (chainId 123456
 * per layer1BasicInfo) has no documented RPC → null.
 */
export const LIGHTER_RH_NETWORKS: { mainnet: VenueNetworkConfig; testnet: VenueNetworkConfig } = {
  mainnet: {
    restUrl: "https://api.rh.lighter.xyz",
    wsUrl: "wss://api.rh.lighter.xyz/stream",
    explorerUrl: "https://explorerapi.rh.lighter.xyz",
    signingChainId: 466324,
    settlementChain: "robinhood",
    collateral: ["USDG"],
    collateralAssetIndex: 3,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    // Verified 2026-10-02: contract + chainId 4663 on apidocs.lighter.xyz/docs/lighter-rh and
    // apidocs.rh.lighter.xyz "Deposits, Transfers, and Withdrawals"; USDG token on Paxos'
    // USDG mainnet list (Robinhood Mainnet); both equal GET /api/v1/layer1BasicInfo + assetDetails.
    depositPins: {
      chainId: 4663,
      contract: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
      token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      sources: [
        "https://apidocs.lighter.xyz/docs/lighter-rh",
        "https://apidocs.rh.lighter.xyz/docs/deposits-transfers-and-withdrawals",
        "https://docs.paxos.com/guides/stablecoin/usdg/mainnet",
      ],
    },
  },
  testnet: {
    restUrl: "https://api.rh-testnet.lighter.xyz",
    wsUrl: null,
    explorerUrl: null,
    signingChainId: 300,
    settlementChain: "robinhood",
    collateral: ["USDC"],
    collateralAssetIndex: 3,
    rpcUrl: null,
    depositPins: null,
  },
};

export function lighterFamilyNetworks(venue: LighterVenueId): { mainnet: VenueNetworkConfig; testnet: VenueNetworkConfig } {
  switch (venue) {
    case "lighter": return LIGHTER_NETWORKS;
    case "lighter-rh": return LIGHTER_RH_NETWORKS;
  }
}

/**
 * + + . timeInForce lists the CLI inputs the adapter accepts:
 * GTC is mapped to GTT (28-day expiry, LIGHTER_GTT_EXPIRY_MS) by LighterAdapter.limitOrder;
 * ALO is sent as time-in-force 2 (POST_ONLY); FOK is not offered.
 * clientOrderId: Lighter `clientOrderIndex`, a numeric id — CLI format rule
 * in LIGHTER_CLIENT_ORDER_INDEX_MAX / lighterClientOrderIndex() (lighter.ts).
 */
export const LIGHTER_CAPABILITIES: VenueCapabilities = {
  marketOrder: "slippageBounded",
  // ALO → time-in-force 2 = POST_ONLY (apidocs trading.md; signed by the official lighter-go
  // v1.0.9 WASM). Testnet confirmation that a crossing post-only is cancelled
  // (canceled-post-only) is still pending.
  timeInForce: ["GTC", "GTT", "IOC", "ALO"],
  reduceOnlyTif: null,
  clientOrderId: true,
  orderAck: "async",
  tpsl: "separateOrders",
  amend: "native",
  batchPlaceMax: null,
  marginModes: ["cross", "isolated"],
  withdrawAssets: ["USDC"],
};

/**
 * GTC/GTT (and post-only) resting-order lifetime on both Lighter venues: orderExpiry -1 is
 * resolved to now + 28 days by LighterWasmSigner (the venue allows 5 min – 30 days).
 * Recorded as the execution record's expiry for GTC→GTT.
 */
export const LIGHTER_GTT_EXPIRY_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * The ONE declared reference price for slippage-bounded orders on both Lighter venues: mid of best bid / best ask from `/api/v1/orderBookOrders`. Replaces
 * orderBookDetails `last_trade_price` (stale on thin RH stock books). No runtime
 * substitute: a missing side → PRICE_STALE before anything is sent.
 */
export const LIGHTER_REFERENCE_PRICE_SOURCE = "orderBookOrders.mid" as const;

/** Largest Lighter clientOrderIndex: 48-bit (2^48 − 1). 0 is the venue's "nil" index → 1 is the minimum. */
export const LIGHTER_CLIENT_ORDER_INDEX_MAX = 2 ** 48 - 1;

export const LIGHTER_RH_CAPABILITIES: VenueCapabilities = {
  ...LIGHTER_CAPABILITIES,
  withdrawAssets: ["USDG"],
};

/**
 * Standard-account REST limit: 60 requests per rolling minute, unweighted
 * (rate-limits.md). The account tier cannot be determined from here, so the
 * standard policy is used.
 *
 * Not modeled: on Premium/Plus accounts the limit is 24,000 *weighted*
 * requests/min (`trades`/`recentTrades` weight 600, `sendTx`/`nextNonce` 6,
 * others 300). The docs also apply `24000 / weight` when it is lower than 60, so
 * even standard accounts get only 40/min on `trades`/`recentTrades` and 8/min on
 * the 3000-weight endpoints. A 429 from those surfaces as RATE_LIMITED.
 */
export const LIGHTER_RH_RATE_LIMIT: RateLimitPolicy = { capacity: 60, refillPerSec: 1, weights: null };

/**
 * Lighter main: same engine and the same standard-account tier (60 req/min).
 * Taken from the RH docs ("same API/engine"); the main-venue figure is not
 * separately verified here.
 */
export const LIGHTER_RATE_LIMIT: RateLimitPolicy = { capacity: 60, refillPerSec: 1, weights: null };

export function lighterFamilyRateLimit(venue: LighterVenueId): RateLimitPolicy {
  switch (venue) {
    case "lighter": return LIGHTER_RATE_LIMIT;
    case "lighter-rh": return LIGHTER_RH_RATE_LIMIT;
  }
}

/** API key indexes Lighter RH reserves for its desktop/mobile interfaces (api-keys.md; valid range 0–254). */
export const LIGHTER_RH_RESERVED_KEY_INDEXES: readonly number[] = [0, 1, 2, 3, 157];
