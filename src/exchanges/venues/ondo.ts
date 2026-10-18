/**
 * Ondo Perps venue definition.
 *
 * Off-chain matching engine; collateral is USDC plus eligible Ondo Global
 * Markets tokenized stocks (docs collateral-assets). Hot-path key = HMAC API
 * key stored in ~/.perp/ondo-agents/<keyId>.json (SSOT Rule #3).
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

/** Lazy: public.ts is only loaded when market data is actually requested. */
const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../ondo/public.js")).ondoPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../ondo/public.js")).ondoPublicData.fetchMarkets(net);
  },
};

/** Chains the CLI funds an Ondo Perps account from (`funds deposit ondo --chain`). */
export type OndoDepositChain = "arbitrum" | "ethereum";

export interface OndoDepositChainPins {
  chainId: number;
  label: string;
  /** Public JSON-RPC of the chain (no env override). */
  rpcUrl: string;
  /** Native USDC (Circle) on that chain — the only asset the CLI sends. */
  usdc: string;
  sources: readonly string[];
}

/**
 * PINNED USDC token addresses for Ondo Perps funding (mainnet). Funding is a plain ERC-20
 * transfer of USDC to the account's own funding address (docs.ondoperps.xyz/funding-ondo-perps:
 * "USDC is supported on Ethereum and Arbitrum"; api-reference/integration_guide "Deposit USDC").
 * The network names equal the `network` values of POST /v1/wallet/deposit_address/list
 * (live 2026-10-05: "ethereum" | "arbitrum" | "avalanche"). Decimals are read on-chain.
 */
export const ONDO_DEPOSIT_CHAINS: Readonly<Record<OndoDepositChain, OndoDepositChainPins>> = {
  arbitrum: {
    chainId: 42161,
    label: "Arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    sources: ["https://developers.circle.com/stablecoins/usdc-contract-addresses", "https://docs.ondoperps.xyz/funding-ondo-perps"],
  },
  ethereum: {
    chainId: 1,
    label: "Ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    sources: ["https://developers.circle.com/stablecoins/usdc-contract-addresses", "https://docs.ondoperps.xyz/funding-ondo-perps"],
  },
};

/** Collateral accepted for margin (docs collateral-assets, 2026-09-30). */
const ONDO_COLLATERAL = [
  "USDC",
  "SPYon", "QQQon", "NVDAon", "GOOGLon", "TSLAon", "MUon", "SNDKon",
  "DRAMon", "SPCXon", "CRCLon", "SLVon", "GLDon",
];

export const ondoVenue: VenueDefinition = {
  id: "ondo",
  aliases: ["ondo-perps"],
  displayName: "Ondo Perps",
  family: "ondo",
  masterKeyKind: "evm",
  agentKeyKind: "hmac",
  secretStorage: { kind: "perp-keystore", dir: "ondo-agents" },
  networks: {
    mainnet: {
      restUrl: "https://api.ondoperps.xyz",
      wsUrl: "wss://api.ondoperps.xyz/ws",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "offchain",
      collateral: ONDO_COLLATERAL,
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
    testnet: {
      restUrl: "https://api.ondoperps-sandbox.xyz",
      wsUrl: "wss://api.ondoperps-sandbox.xyz/ws",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "offchain",
      collateral: ONDO_COLLATERAL,
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
  },
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  fundingVerified: true,
  roles: ["marketData", "account", "trading"],
  gatedRoles: null,
  capabilities: {
    // The venue offers native market orders; the adapter sends every market order
    // as an IOC LIMIT at the tick-aligned protection price (mark ± resolved
    // slippage).
    marketOrder: "native",
    timeInForce: ["GTC", "IOC", "ALO"],
    // A reduce-only limit order must be IOC: the venue refuses a resting one with HTTP 400
    // `reduce_only_invalid_tif` "reduce only order can only be IOC" (live mainnet 2026-10-05).
    // docs.ondoperps.xyz/api-reference/rest-spec.json lists the errorCode `reduce_only_invalid_tif`
    // on POST /v1/perps/orders; the rule itself is not spelled out in the prose docs.
    reduceOnlyTif: ["IOC"],
    clientOrderId: true,
    orderAck: "sync",
    tpsl: "attached",
    amend: "cancelReplace",
    batchPlaceMax: 20,
    marginModes: ["cross"],
    // The API does not allow withdrawals (web app only) — OndoAdapter.withdraw refuses.
    withdrawAssets: null,
  },
  rateLimit: { capacity: 1, refillPerSec: 1, weights: null },
  // Docs (account-set-up, about): "outside the U.S., Panama and other prohibited
  // jurisdictions". The remaining prohibited list is only in the Terms of Service.
  restrictedRegions: ["US", "PA"],
  symbolIdentity: "baseTicker",
  publicData,
  // separate spot wallet + POST /v1/spot/transfers (spot ↔ margin).
  spot: {
    accountModel: "separate",
    quoteAssets: { mainnet: ["USDC"], testnet: ["USDC"] },
    capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: true },
    async createSpot(perp) {
      const [{ OndoAdapter }, { OndoSpotAdapter }] = await Promise.all([
        import("../ondo/adapter.js"), import("../ondo/spot.js"),
      ]);
      if (!(perp instanceof OndoAdapter)) throw new Error(`ondo spot needs an OndoAdapter (got ${perp.name})`);
      const spot = new OndoSpotAdapter(perp);
      await spot.init();
      return spot;
    },
  },
  maxSlippageBps: 5000,
  builderFee: BUILDER_FEE_CAPABILITIES["ondo"],
  apiStatus: { kind: "official" },
  create: async ctx => {
    const adapter = new (await import("../ondo/adapter.js")).OndoAdapter(ondoVenue, ctx);
    // Builder code: only settings builder.ondo (off by default). Ondo has no approval step.
    const { loadSettings } = await import("../../settings.js");
    const { resolveBuilderGate } = await import("../builder-fee.js");
    adapter.builderFee = resolveBuilderGate("ondo", ctx, loadSettings().builder, null, () => "");
    return adapter;
  },
};
