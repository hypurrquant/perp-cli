/**
 * RISEx — fully on-chain perps order book on RISE chain (chainId 4153), USDC collateral.
 *
 * Two keys (developer.rise.trade "Integration"): the account (master EVM wallet) signs setup only;
 * a registered session SIGNER signs every order / cancel / leverage / margin action with an EIP-712
 * VerifyWitness permit (the server submits it and pays gas). perp-cli registers the signer with the
 * master and then restricts it ON-CHAIN to the trading permission (no fund movement), and keeps its
 * key in OWS wallet `agent-risex-<master>[-testnet]` (SSOT Rule #3).
 *
 * RELEASE PHASE: trading is implemented but switched OFF in this release (risex-release.ts
 * RISEX_TRADING_ENABLED). RISEx is read-only here — market data and public-by-address account
 * reads; every trading / signer path refuses with CAPABILITY_UNSUPPORTED (RISEX_TRADING_GATE).
 *
 * Deposits and withdrawals are app-only (owner decision 2026-10-13): `funds deposit|withdraw risex`
 * refuse with CAPABILITY_UNSUPPORTED and point to app.rise.trade. Account reads are public by
 * address. TP/SL and builder fees are not implemented yet.
 * Not registered here; the registry module owns registerVenue().
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { RISEX_TRADING_ENABLED } from "./risex-release.js";

export const RISEX_APP_URL = "https://app.rise.trade";

/** The uniform deposit / withdraw refusal (owner decision: funds move through the RISEx app only). */
export const RISEX_FUNDS_APP_ONLY = {
  reason: "RISEx deposits and withdrawals are done in the RISEx app; perp-cli does not move RISEx funds",
  remediation: `Deposit / withdraw at ${RISEX_APP_URL} (Portfolio → Deposit / Withdraw). perp-cli reads RISEx market data and your account (read-only in this release)`,
} as const;

/** The uniform refusal for every RISEx trading / signer path while RISEX_TRADING_ENABLED is false. */
export const RISEX_TRADING_GATE = {
  reason: "RISEx trading is planned for a later perp-cli release; in this version RISEx is read-only (market data and account reads)",
  remediation: `Trade RISEx in the RISEx app (${RISEX_APP_URL}). perp-cli shows RISEx market data (perp -e risex market list|prices|funding|book) and account reads (perp -e risex portfolio, perp -e risex account positions)`,
} as const;

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../risex/public.js")).risexPublicData.fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../risex/public.js")).risexPublicData.fetchMarkets(net);
  },
};

export const risexVenue: VenueDefinition = {
  id: "risex",
  aliases: ["rise"],
  displayName: "RISEx",
  family: "risex",
  masterKeyKind: "evm",
  agentKeyKind: "evm",
  secretStorage: { kind: "ows-wallet", dir: null },
  networks: {
    mainnet: {
      restUrl: "https://api.rise.trade",
      wsUrl: "wss://ws.rise.trade/ws",
      explorerUrl: "https://explorer.risechain.com",
      signingChainId: 4153,
      settlementChain: "rise",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: "https://rpc.risechain.com",
      depositPins: null,
    },
    testnet: {
      restUrl: "https://api.testnet.rise.trade",
      // ws.testnet.rise.trade answered 525 on 2026-10-13; the API host serves the socket.
      wsUrl: "wss://api.testnet.rise.trade/ws/",
      explorerUrl: null,
      signingChainId: 11155931,
      settlementChain: "rise",
      collateral: ["USDC"],
      collateralAssetIndex: null,
      rpcUrl: "https://testnet.riselabs.xyz",
      depositPins: null,
    },
  },
  // funding_interval = 3600e9 ns on every market; current_funding_rate is a fraction per hour.
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  // Verified 2026-10-14: current_funding_rate equals the last settled print in
  // /funding-rate-history, and public /v1/account/funding-payments satisfy
  // payment = position size × index price × rate for that hour, positive = paid. Evidence: raw
  // records of 6 mainnet accounts / 23 markets / 31 hours in
  // src/__tests__/fixtures/risex/funding-payments-evidence.json, checked by risex-evidence.test.ts.
  fundingVerified: true,
  // Phase 1 (0.15.0): read-only. The trading role comes back with RISEX_TRADING_ENABLED (phase 2).
  roles: RISEX_TRADING_ENABLED ? ["marketData", "account", "trading"] : ["marketData", "account"],
  gatedRoles: RISEX_TRADING_ENABLED ? null : { roles: ["trading"], ...RISEX_TRADING_GATE },
  // Describes the implemented trading path; unreachable while the trading role is gated
  // (requireCapabilities() checks the role first).
  capabilities: {
    // Market = order_type Market + IOC with a price_ticks bound (the venue requires FOK/IOC).
    marketOrder: "slippageBounded",
    // ALO = GTC + post_only. GTT is not offered (the ttl_units unit is undocumented).
    timeInForce: ["GTC", "IOC", "FOK", "ALO"],
    reduceOnlyTif: null,
    clientOrderId: true,
    // The response carries block_number (on-chain inclusion); IOC also carries filled_quantity.
    orderAck: "sync",
    tpsl: null,
    amend: null,
    batchPlaceMax: null,
    marginModes: ["cross", "isolated"],
    withdrawAssets: null,
  },
  // Documented 500 requests / 10 s per IP; Cloudflare 200 / 10 s observed — the stricter one.
  rateLimit: { capacity: 200, refillPerSec: 20, weights: null },
  // Not yet reviewed (open question Q-R5).
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  spot: null,
  // The venue's own match_price_band (2% today) is checked per market before sending.
  maxSlippageBps: 1000,
  builderFee: null,
  apiStatus: { kind: "official" },
  async create(ctx) {
    const { RisexAdapter } = await import("../risex/adapter.js");
    return RisexAdapter.create(risexVenue, ctx);
  },
};
