/**
 * TxFlow venue definition — official API (Beta), docs https://docs.txflow.com/api.
 *
 * Info API `POST /info`, Exchange API `POST /exchange`, WebSocket `/ws`; one host per network
 * (mainnet rpc.txflow.com, testnet rpc.txflow-testnet.xyz); every request sends `x-api-version`.
 *  - funding is unverified (fundingVerified false): the rate is documented in PERCENT per settlement
 *    interval, but the docs do not say whether it is the next settlement's estimate or the last
 *    settled print, and there is no public market funding-history read to check it against — kept
 *    out of arb ranking unless --include-unverified;
 *  - account reads are by the account address (`user`), unsigned — the adapter reads the master /
 *    agent's account; keyless `--address` reads are not wired for TxFlow (no conformance replay yet);
 *  - RELEASE SWITCH: trading is on (txflow-release.ts TXFLOW_TRADING_ENABLED); switched off, every
 *    trading / agent write refuses with CAPABILITY_UNSUPPORTED (TXFLOW_TRADING_GATE);
 *  - trading is signed by an AGENT key the master approves with approveAgent (txflow/signing.ts);
 *    mainnet `/exchange` is open to whitelisted accounts only (apply at txflow.com/apply) — a
 *    refusal is POLICY_DENIED with that link; testnet is open;
 *  - deposits / withdrawals / transfers are done in the TxFlow web app (CAPABILITY_UNSUPPORTED);
 *  - no builder codes (builderFee null), no TWAP, no unattended automation (automationGate).
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { TXFLOW_TRADING_ENABLED } from "./txflow-release.js";

export const TXFLOW_REST_URL = "https://rpc.txflow.com";
export const TXFLOW_WS_URL = "wss://rpc.txflow.com/ws";
export const TXFLOW_TESTNET_REST_URL = "https://rpc.txflow-testnet.xyz";
export const TXFLOW_TESTNET_WS_URL = "wss://rpc.txflow-testnet.xyz/ws";
/** Sent as `x-api-version` on every `/info` and `/exchange` request (docs: Overview → Conventions). */
export const TXFLOW_API_VERSION = "2026-08-16";
export const TXFLOW_APP_URL = "https://txflow.com";

/** The uniform deposit / withdraw / transfer refusal: funds move through the TxFlow web app. */
export const TXFLOW_FUNDS_APP_ONLY = {
  reason: "TxFlow deposits, withdrawals and transfers are signed by the master wallet in the TxFlow web app; perp-cli does not move TxFlow funds",
  remediation: `Deposit / withdraw in the TxFlow web app (${TXFLOW_APP_URL}). perp-cli reads the TxFlow account (perp -e txflow portfolio) and trades with an approved agent key`,
} as const;

/** The uniform refusal of every TxFlow trading / agent write while TXFLOW_TRADING_ENABLED is false. */
export const TXFLOW_TRADING_GATE = {
  reason: "TxFlow trading is switched off in this build",
  remediation: `Trade TxFlow in the TxFlow web app (${TXFLOW_APP_URL}). perp-cli shows TxFlow market data (perp -e txflow market list|prices|info|book|trades|kline) and account reads (perp -e txflow portfolio, perp -e txflow account positions)`,
} as const;

/** The uniform refusal of unattended trading (bots, plans, TWAP / grid / DCA, funding arb, jobs). */
export const TXFLOW_AUTOMATION_GATE = {
  reason: "unattended trading on TxFlow is not enabled until its trading path is verified live",
  remediation: "Trade TxFlow manually with perp trade … -e txflow",
} as const;

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
  masterKeyKind: "evm",
  agentKeyKind: "evm",
  // Agent keys live in OWS wallets (agent-txflow-<master>[-testnet] / agent-txflow-import-<name>).
  secretStorage: { kind: "ows-wallet", dir: null },
  networks: {
    mainnet: {
      restUrl: TXFLOW_REST_URL,
      wsUrl: TXFLOW_WS_URL,
      explorerUrl: null,
      signingChainId: 869,
      settlementChain: "offchain",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    testnet: {
      restUrl: TXFLOW_TESTNET_REST_URL,
      wsUrl: TXFLOW_TESTNET_WS_URL,
      explorerUrl: null,
      signingChainId: 2511,
      settlementChain: "offchain",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
  },
  // settlementIntervalMs = 3600000 on every market (marketTicker); the rate is percent per hour.
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  // Percent per settlement interval (docs: marketTicker `fundingRate`); whether it is the next
  // settlement's estimate or the last settled print is undocumented and there is no public
  // funding-history read to check it, so it stays unverified.
  fundingVerified: false,
  // Trading is behind the release switch (txflow-release.ts); account reads stay on either way.
  roles: TXFLOW_TRADING_ENABLED ? ["marketData", "account", "trading"] : ["marketData", "account"],
  gatedRoles: TXFLOW_TRADING_ENABLED ? null : { roles: ["trading"], ...TXFLOW_TRADING_GATE },
  capabilities: {
    // Market = IOC limit at mark ± the slippage bound (the venue also caps market fills at oracle ± 5%).
    marketOrder: "slippageBounded",
    // FOK is not offered; GTD is Outcome-only (docs: Orders & Time-in-Force, "What each market supports").
    timeInForce: ["GTC", "IOC", "ALO"],
    reduceOnlyTif: null,
    clientOrderId: true,
    // The /exchange response is one status for the whole action, with no order id or fill: the
    // order is read back by its client order id.
    orderAck: "async",
    // Reduce-only trigger orders (tp / sl), placed after the entry's verified fill.
    tpsl: "separateOrders",
    // modify2: price and size in place, same order id.
    amend: "native",
    batchPlaceMax: null,
    marginModes: ["cross", "isolated"],
    withdrawAssets: null,
  },
  // Docs (Rate limits): /info 50 requests/s and /exchange 10 requests/s per IP, then HTTP 429 +
  // Retry-After. Kept well under both.
  rateLimit: { capacity: 20, refillPerSec: 10, weights: null },
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // The venue's own market-order tolerance is a fixed 5% around the oracle price.
  maxSlippageBps: 500,
  builderFee: null,
  apiStatus: { kind: "official" },
  async create(ctx) {
    const { TxflowAdapter } = await import("../txflow/adapter.js");
    return TxflowAdapter.create(txflowVenue, ctx);
  },
};
