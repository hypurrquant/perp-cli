/**
 * QFEX venue definition.
 *
 * TradFi perpetuals (equities, indices, commodities; no spot) on a custodial, off-chain
 * matching engine. All markets are cross-margin, margin asset USDC. Orders go over the Trade
 * WebSocket only; account reads, leverage and transfers over REST; deposits / withdrawals over
 * the separate "banker" host. Hot-path key = HMAC API key created on the QFEX website (2FA),
 * stored in ~/.perp/qfex-agents/<publicKey>.json (SSOT Rule #3). There is no wallet signature.
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import type { Network } from "../venue-types.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";
import { QFEX_MODIFY_KEEPS_CLIENT_ID, QFEX_RESTING_REDUCE_ONLY_VERIFIED } from "../qfex/signing.js";

/**
 * Hosts per network. VenueNetworkConfig carries only two (rest + ws), so the MDS and banker
 * hosts live here. Testnet = QFEX "UAT": "identical API and behaviour, separate exchange
 * instance with no real funds" (official CLI README "Environments").
 */
export const QFEX_ENDPOINTS: Readonly<Record<Network, { rest: string; tradeWs: string; mdsWs: string; banker: string }>> = {
  mainnet: { rest: "https://api.qfex.com", tradeWs: "wss://trade.qfex.com", mdsWs: "wss://mds.qfex.com", banker: "https://banker.qfex.com" },
  testnet: { rest: "https://api.qfex.io", tradeWs: "wss://trade.qfex.io", mdsWs: "wss://mds.qfex.io", banker: "https://banker.qfex.io" },
};

/** Chain QFEX USDC deposits / withdrawals use in perp-cli (banker network ARBITRUM_ONE). */
export const QFEX_WITHDRAW_NETWORK = "arbitrum";

/**
 * API withdrawals are switched off (owner decision 2026-10-13): `funds withdraw qfex` and
 * QfexAdapter.withdraw refuse with CAPABILITY_UNSUPPORTED. The implementation (banker POST
 * /withdraw behind settings.withdraw.qfex) is kept; flip this to re-enable it.
 */
export const QFEX_WITHDRAW_ENABLED: boolean = false;

/** The uniform refusal while QFEX_WITHDRAW_ENABLED is false. */
export const QFEX_WITHDRAW_DISABLED = { reason: "QFEX withdrawals are disabled in perp-cli for now", remediation: "Withdraw from the QFEX web app" } as const;
/** Banker `network` value for QFEX_WITHDRAW_NETWORK. */
export const QFEX_BANKER_NETWORK = "ARBITRUM_ONE";

/** Lazy: public.ts (and `ws`) is only loaded when market data is actually requested. */
const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../qfex/public.js")).qfexPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../qfex/public.js")).qfexPublicData.fetchMarkets(net);
  },
};

function network(net: Network): VenueDefinition["networks"]["mainnet"] {
  return {
    restUrl: QFEX_ENDPOINTS[net].rest,
    wsUrl: QFEX_ENDPOINTS[net].tradeWs,
    explorerUrl: null,
    signingChainId: null,
    settlementChain: "offchain",
    collateral: ["USDC"],
    collateralAssetIndex: null,
    rpcUrl: null,
    depositPins: null,
  };
}

export const qfexVenue: VenueDefinition = {
  id: "qfex",
  aliases: ["qf"],
  displayName: "QFEX",
  family: "qfex",
  // Custodial: there is no owner-wallet signing path at all.
  masterKeyKind: "none",
  agentKeyKind: "hmac",
  secretStorage: { kind: "perp-keystore", dir: "qfex-agents" },
  networks: { mainnet: network("mainnet"), testnet: network("testnet") },
  // Docs /qfex/funding: settled every 60 minutes.
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  // Q4: the unit of `funding_rate` (and funding_rate vs next_funding_rate) is not verified
  // against settled payments, and equity funding accrues only ~120 of 168 hours a week, so
  // hourly × 8760 overstates it. Until both are settled QFEX is not a funding-arb venue.
  fundingVerified: false,
  roles: ["marketData", "account", "trading"],
  capabilities: {
    // The venue offers a native MARKET order (bounded only by the price band — docs /qfex/risk-limits
    // "Dynamic price bands": 1.65%–10% by product preset and session; "integrations should use
    // that live value rather than hardcoding a percentage"); the
    // adapter sends every market order as an IOC LIMIT at the tick-aligned protection price
    // (mark ± resolved slippage) — the same declaration as Ondo.
    marketOrder: "native",
    // ALO = order_type "ALO" + GTC.
    timeInForce: ["GTC", "IOC", "FOK", "ALO"],
    // Reduce-only (Q2, production 2026-10-05: `reduce_only` is a JSON boolean; rejected with no
    // position, but an order larger than the position is accepted and RESTS at full size). The
    // adapter enforces side and size against the live position before each send, which covers
    // an immediate order only — a resting one is refused until match-time capping is proven
    // (QFEX_RESTING_REDUCE_ONLY_VERIFIED, qfex/signing.ts).
    reduceOnlyTif: QFEX_RESTING_REDUCE_ONLY_VERIFIED === true ? null : ["IOC"],
    clientOrderId: true,
    // The ACK arrives first; fills / rejections follow as separate events. Client order ids
    // are GENERATED only (venue ids are not unique) — a user --client-id is refused.
    orderAck: "async",
    // Attached take_profit / stop_loss exists on add_order, but the stop quantity on a partial
    // or zero-fill entry and the id of the resulting stop are unverified (Q7) → separate
    // reduce-only TAKE_PROFIT / STOP_LOSS stop orders sized to the verified fill (Q21 passed on
    // production 2026-10-12: the stop ACK echoes the client id — qfex/signing.ts QFEX_STOP_CLIENT_ID_ECHO).
    tpsl: "separateOrders",
    // modify_order returns a NEW order id; the MODIFIED frame keeps the client id (Q5, production
    // 2026-10-12 — QFEX_MODIFY_KEEPS_CLIENT_ID) → native amend correlated by client id.
    amend: QFEX_MODIFY_KEEPS_CLIENT_ID === true ? "native" : null,
    batchPlaceMax: null,
    marginModes: ["cross"],
    // TRON USDT and USD bank rails are out of scope. API withdrawals are off (QFEX_WITHDRAW_ENABLED).
    withdrawAssets: QFEX_WITHDRAW_ENABLED ? ["USDC"] : null,
  },
  // Venue budget: 12,000 weight / 60 s per USER across all connections and keys (general and
  // cancel buckets separate). This process takes 25% (50/s, burst 100); the rest is left to the
  // user's other processes, the QFEX web app and the official CLI. Weights: docs /websocket/rate.
  rateLimit: {
    capacity: 100,
    refillPerSec: 50,
    weights: {
      add_order: 1, cancel_order: 1, modify_order: 1, get_order: 2, get_user_orders: 5, cancel_all_orders: 2,
      get_user_trades: 0.5, subscribe: 0.1, unsubscribe: 0.1, set_user_leverage: 0.1, cancel_stop_order: 1,
      modify_stop_order: 1,
    },
  },
  // Docs /qfex/faq + prohibited-jurisdictions ("including but not limited to"). Warn-only.
  restrictedRegions: ["US", "GB", "ES", "UA", "SY", "IR", "RU", "KP", "MM", "BY", "VE", "SD"],
  symbolIdentity: "explicit",
  publicData,
  spot: null,
  // Widest documented price band (equities at the open: 10%). The order's own band is checked before sending.
  maxSlippageBps: 1000,
  builderFee: BUILDER_FEE_CAPABILITIES["qfex"],
  apiStatus: { kind: "official" },
  create: async ctx => {
    const { QfexAdapter } = await import("../qfex/adapter.js");
    const adapter = new QfexAdapter(qfexVenue, ctx);
    // Builder code: only settings builder.qfex (off by default); no approval step. It rides on
    // the connection's auth, so --no-builder / testnet use a session without it.
    const { loadSettings } = await import("../../settings.js");
    const { resolveBuilderGate } = await import("../builder-fee.js");
    const settings = loadSettings();
    adapter.builderFee = resolveBuilderGate("qfex", ctx, settings.builder, null, () => "");
    // Withdraw gate (settings.withdraw.qfex): absent = withdraw() refuses.
    const gate = settings.withdraw.qfex;
    adapter.withdrawGate = gate === undefined ? null : gate;
    return adapter;
  },
};
