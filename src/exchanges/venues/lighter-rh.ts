/**
 * Lighter RH venue definition.
 * Same engine/adapter as Lighter; USDG collateral on the Robinhood chain.
 * Master key = OWS wallet only (no env / raw-PK tier); referral off.
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { LIGHTER_RH_CAPABILITIES, LIGHTER_RH_NETWORKS, LIGHTER_RH_RATE_LIMIT } from "./lighter-family.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../lighter-public.js")).lighterPublicData("lighter-rh").fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../lighter-public.js")).lighterPublicData("lighter-rh").fetchMarkets(net);
  },
};

export const lighterRhVenue: VenueDefinition = {
  id: "lighter-rh",
  aliases: ["lrh", "rh"],
  displayName: "Lighter RH",
  family: "lighter",
  masterKeyKind: "evm",
  agentKeyKind: "lighter-l2",
  secretStorage: { kind: "perp-keystore", dir: "lighter-rh-agents" },
  networks: LIGHTER_RH_NETWORKS,
  // "Lighter RH is the same API/engine as Lighter" → Lighter's basis/interval (live-data check pending).
  fundingRateBasis: { kind: "perHours", hours: 8 },
  settlementIntervalHours: 1,
  fundingVerified: true,
  roles: ["marketData", "account", "trading"],
  capabilities: LIGHTER_RH_CAPABILITIES,
  // Applied by the rate limiter (new venues + lighter-rh).
  rateLimit: LIGHTER_RH_RATE_LIMIT,
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  // per account (account_trading_mode, read by LighterSpotAdapter.init): Unified (1) shares
  // the collateral between spot and perp (no transfer); Classic (0) = separate spot balance +
  // self-transfer of the venue collateral.
  spot: {
    accountModel: "runtime",
    // Spot quote = the network's collateral (USDG mainnet, USDC testnet).
    quoteAssets: { mainnet: LIGHTER_RH_NETWORKS.mainnet.collateral, testnet: LIGHTER_RH_NETWORKS.testnet.collateral },
    capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: true },
    async createSpot(perp) {
      const [{ LighterAdapter }, { LighterSpotAdapter }] = await Promise.all([
        import("../lighter.js"), import("../lighter-spot.js"),
      ]);
      if (!(perp instanceof LighterAdapter)) throw new Error(`lighter-rh spot needs a LighterAdapter (got ${perp.name})`);
      const spot = new LighterSpotAdapter(perp);
      await spot.init();
      return spot;
    },
  },
  maxSlippageBps: 5000,
  builderFee: BUILDER_FEE_CAPABILITIES["lighter-rh"],
  apiStatus: { kind: "official" },
  create: async ctx => (await import("./create-helpers.js")).createLighterFamily("lighter-rh", ctx),
};
