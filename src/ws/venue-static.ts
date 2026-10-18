/**
 * Static per-venue facts for perp-cli/ws (§5.2, §6). URLs and funding intervals are parity-tested
 * against src/exchanges/venues/*.ts; heartbeat/stale values come from the Phase 0 probe
 * (.omc/plans/ws-phase0-findings.md).
 */

import type { Network, VenueId } from "./ids.js";

export interface VenueStatic {
  wsUrl: Record<Network, string | null>;
  restUrl: Record<Network, string | null>;
  /** WS funding interval in hours, or "perMarket" (labelled REST source). */
  rateIntervalHours: number | "perMarket";
  settlementIntervalHours: number | "perMarket";
  fundingVerified: boolean;
  ping: { message: string; everyMs: number } | null;
  staleAfterMs: number;
  limits: {
    subscriptionsPerSocket: number; newConnectionsPerMin: number; outboundPerMin: number;
    /** Per-socket caps per WireSub.group (VenueCodec.limits.perGroup). */
    perGroup?: Record<string, number>;
    /** Sockets one stream may open (VenueCodec.limits.maxSockets; absent = 1). */
    maxSockets?: number;
  };
}

export const VENUE_STATIC: Record<"hyperliquid" | "pacifica" | "lighter" | "lighter-rh" | "aster" | "arcus", VenueStatic> & Partial<Record<VenueId, VenueStatic>> = {
  hyperliquid: {
    wsUrl: { mainnet: "wss://api.hyperliquid.xyz/ws", testnet: "wss://api.hyperliquid-testnet.xyz/ws" },
    restUrl: { mainnet: "https://api.hyperliquid.xyz", testnet: "https://api.hyperliquid-testnet.xyz" },
    rateIntervalHours: 1,
    settlementIntervalHours: 1,
    fundingVerified: true,
    // Idle limit 60 s (Phase 0: closed at 60.1 s, no close frame).
    ping: { message: JSON.stringify({ method: "ping" }), everyMs: 20_000 },
    // allDexsAssetCtxs cadence ~11–15 s (Phase 0) → 30 s; per-coin activeAssetCtx uses 10 s.
    staleAfterMs: 30_000,
    // Per IP: 1000 subs, 10 conns, 30 new conns/min, 2000 msgs/min.
    limits: { subscriptionsPerSocket: 1000, newConnectionsPerMin: 30, outboundPerMin: 2000 },
  },
  pacifica: {
    wsUrl: { mainnet: "wss://ws.pacifica.fi/ws", testnet: "wss://test-ws.pacifica.fi/ws" },
    restUrl: { mainnet: "https://api.pacifica.fi/api/v1", testnet: "https://test-api.pacifica.fi/api/v1" },
    rateIntervalHours: 1,
    settlementIntervalHours: 1,
    fundingVerified: true,
    ping: { message: JSON.stringify({ method: "ping" }), everyMs: 20_000 },
    staleAfterMs: 10_000, // `prices` every 3 s
    // docs.pacifica.fi/api-documentation/api/rate-limits: max 100 concurrent connections per IP, max
    // 20 subscriptions per channel per connection → perGroup (one group per channel `source`) and up
    // to 50 sockets per stream (half the per-IP cap: other streams / processes share the IP). The
    // server closes a socket after 60 s without a client message (ping every 20 s) and at 24 h
    // (reconnect + resubscribe). No documented total per socket, new-connection rate or outbound
    // rate: those are library self-limits, not venue values.
    limits: {
      subscriptionsPerSocket: 100, newConnectionsPerMin: 60, outboundPerMin: 1000, maxSockets: 50,
      perGroup: { prices: 20, bbo: 20, account_info: 20, account_positions: 20, account_order_updates: 20, account_trades: 20 },
    },
  },
  lighter: {
    wsUrl: { mainnet: "wss://mainnet.zklighter.elliot.ai/stream", testnet: "wss://testnet.zklighter.elliot.ai/stream" },
    restUrl: { mainnet: "https://mainnet.zklighter.elliot.ai", testnet: "https://testnet.zklighter.elliot.ai" },
    // WS funding_rate / current_funding_rate are PERCENT per 1 h (Phase 0); the CLI REST basis
    // (perHours 8) applies to REST /api/v1/funding-rates only.
    rateIntervalHours: 1,
    settlementIntervalHours: 1,
    fundingVerified: true,
    ping: { message: JSON.stringify({ type: "ping" }), everyMs: 30_000 }, // idle limit 120 s
    staleAfterMs: 10_000, // market_stats/all updates ~1 s
    limits: { subscriptionsPerSocket: 500, newConnectionsPerMin: 255, outboundPerMin: 200 },
  },
  "lighter-rh": {
    // Testnet WS answers HTTP 403 (CloudFront, Phase 0) → unsupported.
    wsUrl: { mainnet: "wss://api.rh.lighter.xyz/stream", testnet: null },
    restUrl: { mainnet: "https://api.rh.lighter.xyz", testnet: "https://api.rh-testnet.lighter.xyz" },
    rateIntervalHours: 1,
    settlementIntervalHours: 1,
    fundingVerified: true,
    ping: { message: JSON.stringify({ type: "ping" }), everyMs: 30_000 },
    staleAfterMs: 10_000,
    limits: { subscriptionsPerSocket: 500, newConnectionsPerMin: 255, outboundPerMin: 200 },
  },
  aster: {
    wsUrl: { mainnet: "wss://fstream.asterdex.com", testnet: "wss://fstream.asterdex-testnet.com" },
    restUrl: { mainnet: "https://fapi.asterdex.com", testnet: "https://fapi.asterdex-testnet.com" },
    rateIntervalHours: "perMarket", // rest:/fapi/v3/fundingInfo
    settlementIntervalHours: "perMarket",
    fundingVerified: true,
    ping: null, // server protocol pings, answered by the runtime
    staleAfterMs: 5_000, // markPrice@1s
    // 200 streams/conn, 10 client→server msgs/s. No documented new-connection rate: a library self-limit.
    limits: { subscriptionsPerSocket: 200, newConnectionsPerMin: 60, outboundPerMin: 600 },
  },
  arcus: {
    wsUrl: { mainnet: "wss://api.arcus.xyz/v1/ws", testnet: "wss://api.testnet.arcus.xyz/v1/ws" },
    restUrl: { mainnet: "https://api.arcus.xyz", testnet: "https://api.testnet.arcus.xyz" },
    rateIntervalHours: 1,
    settlementIntervalHours: 1,
    fundingVerified: true,
    ping: { message: JSON.stringify({ type: "ping" }), everyMs: 30_000 },
    staleAfterMs: 15_000, // `markets` every ~5 s
    limits: { subscriptionsPerSocket: 100, newConnectionsPerMin: 50, outboundPerMin: 1000 },
  },
};
