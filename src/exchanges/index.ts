// exchanges/ barrel — public API
export type {
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangePublicTrade,
  ExchangeFundingPayment,
  ExchangeKline,
  ExchangeAdapter,
} from "./interface.js";

export type { SpotMarketInfo, SpotBalance, SpotAdapter } from "./spot-interface.js";
export { SPOT_PERP_TOKEN_MAP, PERP_TO_SPOT_MAP, MAX_PRICE_DEVIATION_PCT } from "./spot-interface.js";

// Capability interfaces + type guards
export * from "./capabilities.js";

// Adapter registry
export { registerAdapter, getAdapterRegistration, listExchanges, resolveExchangeName } from "./registry.js";
export type { AdapterRegistration } from "./registry.js";

export { PacificaAdapter } from "./pacifica.js";
export { HyperliquidAdapter } from "./hyperliquid.js";
export { LighterAdapter } from "./lighter.js";
export { AsterAdapter } from "./aster.js";
export { HyperliquidSpotAdapter } from "./hyperliquid-spot.js";
export { LighterSpotAdapter } from "./lighter-spot.js";

// Venue abstraction
export {
  getVenue, listVenues, listVenuesWithRole, resolveVenueId, tryResolveVenueId, parseVenueRef,
  networkConfig, requireCapabilities, fundingBasisOf, settlementIntervalOf, isLegacyVenue, isVenueId,
  READ_ONLY_CREDENTIALS,
} from "./venue.js";
export type {
  VenueDefinition, VenueCapabilities, VenueCreateContext, VenueCredentials, VenueNetworkConfig,
  VenuePublicData, VenueRole, VenueRef, RateLimitPolicy, MasterKeyKind, AgentKeyKind,
} from "./venue.js";
export type { VenueId, LegacyVenueId, Network, FundingRateBasis, VenueMarket, VenueFundingRate, TimeInForce, OrderRequest, OrderResult } from "./venue-types.js";
export { ensureVenuesRegistered, ALL_VENUES } from "./venues/index.js";
export { isTradingV2, validateOrderRequest, validateLegacyTif } from "./trading-v2.js";
export type { TradingV2 } from "./trading-v2.js";
