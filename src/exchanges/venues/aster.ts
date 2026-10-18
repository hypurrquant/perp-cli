/**
 * Aster venue definition.
 * Adapter + public-data code are loaded lazily.
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

/** Aster client order id (V3 futures "New Order" `newClientOrderId` rule). */
export const ASTER_CLIENT_ID_RE = /^[.A-Z:/a-z0-9_-]{1,36}$/;

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../../funding/legacy-public.js")).legacyPublicData("aster").fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../../funding/legacy-public.js")).legacyPublicData("aster").fetchMarkets(net);
  },
};

/** Chains the CLI deposits from / withdraws to (`--chain`). */
export type AsterFundsChain = "bsc" | "arbitrum";
export type AsterFundsAsset = "USDT" | "USDC";

export interface AsterFundsChainPins {
  chainId: number;
  /** Display name. */
  label: string;
  /** `destination Chain` of the EVM withdraw signature (docs "chainName definition"). */
  withdrawChainName: "BSC" | "Arbitrum";
  /** Public JSON-RPC of the chain (no env override). */
  rpcUrl: string;
  /** AstherusVault (ERC-1967 proxy) — the deposit contract. */
  vault: string;
  tokens: Readonly<Record<AsterFundsAsset, string>>;
  sources: readonly string[];
}

/**
 * PINNED Aster vault + token addresses (mainnet). A deposit is `approve(vault, exact amount)` then
 * `deposit(address currency, uint256 amount, uint256 broker)` on the vault — never a plain token
 * transfer. Verified 2026-10-05 against:
 *   - github.com/asterdex/api-docs demo/aster-deposit-withdrawal.md "Mainnet contract addresses"
 *     (BSC 0x1284…7974, Arbitrum 0x9E36…E1d5) and its ethers example (BSC USDT 0x55d3…7955)
 *   - docs.asterdex.com/overview/smart-contracts
 *   - the verified AstherusVault source on BscScan / Arbiscan (`deposit(address,uint256,uint256)`
 *     selector 0x0efe6a8b, `supportToken(address)`, `paused()`, event Deposit)
 *   - live `supportToken(token)` non-zero for all four tokens below
 * Token decimals are NOT pinned: they are read on-chain (`decimals()`) before every deposit
 * (BSC USDT / USDC have 18, Arbitrum USDC / USDT have 6).
 */
export const ASTER_FUNDS_CHAINS: Readonly<Record<AsterFundsChain, AsterFundsChainPins>> = {
  bsc: {
    chainId: 56,
    label: "BNB Chain",
    withdrawChainName: "BSC",
    rpcUrl: "https://bsc-dataseed.bnbchain.org",
    vault: "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974",
    tokens: {
      USDT: "0x55d398326f99059fF775485246999027B3197955",
      USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    },
    sources: [
      "https://github.com/asterdex/api-docs/blob/master/demo/aster-deposit-withdrawal.md",
      "https://docs.asterdex.com/overview/smart-contracts",
      "https://bscscan.com/address/0x128463A60784c4D3f46c23Af3f65Ed859Ba87974#code",
    ],
  },
  arbitrum: {
    chainId: 42161,
    label: "Arbitrum",
    withdrawChainName: "Arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    vault: "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5",
    tokens: {
      USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    sources: [
      "https://github.com/asterdex/api-docs/blob/master/demo/aster-deposit-withdrawal.md",
      "https://docs.asterdex.com/overview/smart-contracts",
      "https://arbiscan.io/address/0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5#code",
    ],
  },
};

/** Vault `broker` argument: 1 = perp (futures) account; 1000 = spot account (never used here). */
export const ASTER_DEPOSIT_BROKER_PERP = 1n;

/**
 * Why deposit / withdraw are mainnet only (uniform CAPABILITY_UNSUPPORTED on testnet): the vault
 * addresses above are mainnet deployments, and the withdraw signature's `aster chain` is the
 * fixed string "Mainnet" (no testnet value is documented).
 */
export const ASTER_FUNDS_TESTNET_UNSUPPORTED = {
  reason: "the pinned vault contracts are mainnet deployments and the withdraw signature is defined for \"Mainnet\" only",
  remediation: "Run without -n testnet; fund the Aster testnet account from the testnet app faucet",
} as const;

export const asterVenue: VenueDefinition = {
  id: "aster",
  aliases: ["ast"],
  displayName: "Aster",
  family: "aster",
  masterKeyKind: "evm",
  agentKeyKind: "evm",
  secretStorage: { kind: "ows-wallet", dir: null },
  // Hosts per github.com/asterdex/api-docs V3 (aster-finance-futures-api-v3.md / -testnet.md):
  // REST base "https://fapi.asterdex.com" / "https://fapi.asterdex-testnet.com",
  // WS "wss://fstream.asterdex.com" / "wss://fstream.asterdex-testnet.com"
  // (live 2026-10-02: testnet /fapi/v3/time 200, both WS handshakes open). The old
  // testnet host testnet.asterdex.com does not resolve. AsterAdapter and the public
  // data path (api/public/urls.ts) both read these values — no env override.
  // No explorer / signing chain id in code → null. Markets quote in USDT (aster.ts symbol mapping).
  networks: {
    mainnet: {
      restUrl: "https://fapi.asterdex.com",
      wsUrl: "wss://fstream.asterdex.com",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "bnb",
      collateral: ["USDT"],
      collateralAssetIndex: null,
      // Default deposit route (BNB Chain USDT); the Arbitrum route is in ASTER_FUNDS_CHAINS.
      rpcUrl: ASTER_FUNDS_CHAINS.bsc.rpcUrl,
      depositPins: {
        chainId: ASTER_FUNDS_CHAINS.bsc.chainId,
        contract: ASTER_FUNDS_CHAINS.bsc.vault,
        token: ASTER_FUNDS_CHAINS.bsc.tokens.USDT,
        sources: ASTER_FUNDS_CHAINS.bsc.sources,
      },
    },
    testnet: {
      restUrl: "https://fapi.asterdex-testnet.com",
      wsUrl: "wss://fstream.asterdex-testnet.com",
      explorerUrl: null,
      signingChainId: null,
      settlementChain: "bnb",
      collateral: ["USDT"],
      collateralAssetIndex: null,
      rpcUrl: null,
      depositPins: null,
    },
  },
  // Per symbol: GET /fapi/v3/fundingInfo lists fundingIntervalHours per market
  // (live 2026-09-30: 4h, 8h, 1h and 2h markets). A flat venue value would be wrong.
  fundingRateBasis: "perMarket",
  settlementIntervalHours: "perMarket",
  fundingVerified: true,
  roles: ["marketData", "account", "trading"],
  gatedRoles: null,
  capabilities: {
    // Market = IOC LIMIT at mark ± slippage (adapter marketOrder), never native MARKET.
    marketOrder: "slippageBounded",
    // Live exchangeInfo timeInForce: GTC/IOC/GTX/HIDDEN — no FOK. ALO is the common name for GTX.
    timeInForce: ["GTC", "IOC", "ALO", "GTX"],
    reduceOnlyTif: null,
    // V3 futures "New Order": `newClientOrderId` "A unique id among open orders. Automatically
    // generated if not sent. Can only be string following the rule: ^[\\.A-Z\\:/a-z0-9_-]{1,36}$";
    // "Query Order" / "Cancel Order": "Either `orderId` or `origClientOrderId` must be sent."
    clientOrderId: true,
    orderAck: "sync",
    tpsl: "separateOrders",
    // PUT /fapi/v3/order (V3 "Modify Order", LIMIT only).
    amend: "native",
    batchPlaceMax: null,
    marginModes: ["cross", "isolated"],
    // POST /fapi/v3/aster/user-withdraw (mainnet only — exchanges/aster-funds.ts): USDT (default)
    // or USDC to the account owner's own address on BNB Chain or Arbitrum. Needs an API wallet
    // with canWithdraw. USDC: listed by POST /fapi/v3/aster/user-withdraw-info (live 2026-10-13:
    // USDC on chains 1 / 56 / 4663 / 5042 / 42161 with perpMaxWithdrawAmount + withdrawFee).
    withdrawAssets: ["USDT", "USDC"],
  },
  // GET /fapi/v1/exchangeInfo rateLimits: REQUEST_WEIGHT 2400/min
  // (ORDERS 1200/min and 300/10s are separate order-count limits, not modeled).
  // Declared only — per the limiter is applied to new venues + lighter-rh.
  rateLimit: { capacity: 2400, refillPerSec: 40, weights: null },
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  // separate spot account (sapi /api/v3) + /asset/wallet/transfer. Agent signer needs canSpotTrade.
  spot: {
    accountModel: "separate",
    quoteAssets: { mainnet: ["USDT", "USD1"], testnet: ["USDT", "USD1"] },
    capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: true },
    async createSpot(perp) {
      const [{ AsterAdapter }, { AsterSpotAdapter }] = await Promise.all([
        import("../aster.js"), import("../aster-spot.js"),
      ]);
      if (!(perp instanceof AsterAdapter)) throw new Error(`aster spot needs an AsterAdapter (got ${perp.name})`);
      const spot = new AsterSpotAdapter(perp);
      await spot.init();
      return spot;
    },
  },
  // PERCENT_PRICE is per symbol (live 2026-10-02: multiplierUp 1.02..1.15), not a venue
  // constant — the adapter rejects a protection price outside the symbol's band
  // (INVALID_PARAMS) at order time; this is only the outer venue-wide bound.
  maxSlippageBps: 5000,
  builderFee: BUILDER_FEE_CAPABILITIES["aster"],
  apiStatus: { kind: "official" },
  create: async ctx => (await import("./create-helpers.js")).createAster(ctx),
};
