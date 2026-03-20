// exchanges/ barrel — public API
export type {
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
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
export { HyperliquidSpotAdapter } from "./hyperliquid-spot.js";
export { LighterSpotAdapter } from "./lighter-spot.js";
