/**
 * Lighter-family WebSocket URLs are the documented read-only ones (`?readonly=true`).
 *
 * The plain URL answered HTTP 400 to the nightly conformance's US runners on every run
 * 2026-10-27..31 while REST worked: the CLI listed Lighter / Lighter RH with fundingRate null and
 * the perp-ws Lighter streams reconnect-looped. docs.lighter.xyz/api/websocket gives the read-only
 * URL for "a restricted region"; perp-cli only reads over WS (orders go through REST /sendTx).
 *
 * Covers the constants (CLI venue definitions, perp-ws static facts, the codec) and the socket the
 * CLI's settled-funding reader actually opens. No network: the ws module is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWs extends EventEmitter {
    constructor(url: string) { super(); opened.urls.push(url); setTimeout(() => this.emit("open"), 0); }
    send() { setTimeout(() => this.emit("message", JSON.stringify({ type: "subscribed/market_stats", channel: "market_stats:all", market_stats: {} })), 0); }
    close() { /* closed */ }
  }
  return { default: FakeWs, WebSocket: FakeWs };
});

const { LIGHTER_NETWORKS, LIGHTER_RH_NETWORKS } = await import("../exchanges/venues/lighter-family.js");
const { VENUE_STATIC } = await import("../ws/venue-static.js");
const { lighter, lighterRh } = await import("../ws/codecs/lighter.js");
const { fetchLighterFundingStats, clearLighterFundingStatsCache } = await import("../exchanges/lighter-public.js");

const readOnly = (url: string | null): boolean => url !== null && new URL(url).searchParams.get("readonly") === "true";

describe("Lighter-family WS URLs are read-only (?readonly=true)", () => {
  beforeEach(() => { opened.urls = []; clearLighterFundingStatsCache(); });

  it("CLI venue definitions, perp-ws static facts and codecs", () => {
    const urls = [
      LIGHTER_NETWORKS.mainnet.wsUrl, LIGHTER_NETWORKS.testnet.wsUrl, LIGHTER_RH_NETWORKS.mainnet.wsUrl,
      VENUE_STATIC.lighter.wsUrl.mainnet, VENUE_STATIC.lighter.wsUrl.testnet, VENUE_STATIC["lighter-rh"].wsUrl.mainnet,
      lighter.url("mainnet"), lighter.url("testnet"), lighterRh.url("mainnet"),
    ];
    for (const u of urls) expect(readOnly(u), String(u)).toBe(true);
    // RH testnet publishes no WS (null), never a plain URL.
    expect(LIGHTER_RH_NETWORKS.testnet.wsUrl).toBeNull();
    expect(VENUE_STATIC["lighter-rh"].wsUrl.testnet).toBeNull();
  });

  it("the settled-funding reader (market list / MCP get_markets funding) opens the read-only socket", async () => {
    await fetchLighterFundingStats("lighter", "mainnet");
    await fetchLighterFundingStats("lighter", "testnet");
    await fetchLighterFundingStats("lighter-rh", "mainnet");
    expect(opened.urls).toEqual([
      "wss://mainnet.zklighter.elliot.ai/stream?readonly=true",
      "wss://testnet.zklighter.elliot.ai/stream?readonly=true",
      "wss://api.rh.lighter.xyz/stream?readonly=true",
    ]);
  });
});
