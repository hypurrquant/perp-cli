/**
 * Lighter (main) venue definition.
 * Shares LighterAdapter and constants with lighter-rh (./lighter-family.ts).
 */

import type { VenueDefinition, VenuePublicData } from "../venue.js";
import { LIGHTER_CAPABILITIES, LIGHTER_NETWORKS, LIGHTER_RATE_LIMIT } from "./lighter-family.js";
import { BUILDER_FEE_CAPABILITIES } from "../builder-fee.js";

const publicData: VenuePublicData = {
  async fetchFundingRates(net) {
    return (await import("../lighter-public.js")).lighterPublicData("lighter").fetchFundingRates(net);
  },
  async fetchMarkets(net) {
    return (await import("../lighter-public.js")).lighterPublicData("lighter").fetchMarkets(net);
  },
};

export const lighterVenue: VenueDefinition = {
  id: "lighter",
  aliases: ["lt"],
  displayName: "Lighter",
  family: "lighter",
  masterKeyKind: "evm",
  agentKeyKind: "lighter-l2",
  secretStorage: { kind: "perp-keystore", dir: "lighter-agents" },
  networks: LIGHTER_NETWORKS,
  // The market rows' fundingRate is the settled hourly rate (WS market_stats, lighter-public.ts).
  fundingRateBasis: { kind: "perHours", hours: 1 },
  settlementIntervalHours: 1,
  fundingVerified: true,
  roles: ["marketData", "account", "trading"],
  gatedRoles: null,
  capabilities: LIGHTER_CAPABILITIES,
  // Declared only — per the limiter is applied to new venues + lighter-rh, not lighter.
  rateLimit: LIGHTER_RATE_LIMIT,
  restrictedRegions: [],
  symbolIdentity: "baseTicker",
  publicData,
  // per account (account_trading_mode, read by LighterSpotAdapter.init): Unified (1) shares
  // the collateral between spot and perp (no transfer); Classic (0) = separate spot balance +
  // self-transfer of the venue collateral.
  spot: {
    accountModel: "runtime",
    quoteAssets: { mainnet: LIGHTER_NETWORKS.mainnet.collateral, testnet: LIGHTER_NETWORKS.testnet.collateral },
    capabilities: { limitOrder: true, orderbook: true, cancel: true, transfer: true },
    async createSpot(perp) {
      const [{ LighterAdapter }, { LighterSpotAdapter }] = await Promise.all([
        import("../lighter.js"), import("../lighter-spot.js"),
      ]);
      if (!(perp instanceof LighterAdapter)) throw new Error(`lighter spot needs a LighterAdapter (got ${perp.name})`);
      const spot = new LighterSpotAdapter(perp);
      await spot.init();
      return spot;
    },
  },
  maxSlippageBps: 5000,
  builderFee: BUILDER_FEE_CAPABILITIES["lighter"],
  apiStatus: { kind: "official" },
  create: async ctx => (await import("./create-helpers.js")).createLighterFamily("lighter", ctx),
};
