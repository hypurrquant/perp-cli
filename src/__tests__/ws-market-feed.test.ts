/**
 * Tests for WebSocket market feed implementations.
 * Tests message parsing logic and factory without actual WS connections.
 */
import { describe, it, expect } from "vitest";
import { HyperliquidMarketFeed, LighterMarketFeed, createMarketFeed } from "../ws/market-feed.js";

// Helper: call private handleMessage
function callHandleMessage(feed: HyperliquidMarketFeed, msg: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (feed as any).handleMessage(msg);
}

describe("HyperliquidMarketFeed", () => {
  it("exposes correct WS URL", () => {
    const feed = new HyperliquidMarketFeed();
    expect(feed.wsUrl).toBe("wss://api.hyperliquid.xyz/ws");
  });

  it("emits prices from allMids message", () => {
    const feed = new HyperliquidMarketFeed();
    const received: unknown[] = [];
    feed.on("prices", (data: unknown) => received.push(data));

    callHandleMessage(feed, {
      channel: "allMids",
      data: { mids: { ETH: "3500.5", BTC: "95000.2" } },
    });

    expect(received).toHaveLength(1);
    const updates = received[0] as Array<{ symbol: string; mid: number }>;
    expect(updates).toEqual(expect.arrayContaining([
      { symbol: "ETH", mid: 3500.5 },
      { symbol: "BTC", mid: 95000.2 },
    ]));
  });

  it("emits book from l2Book message", () => {
    const feed = new HyperliquidMarketFeed();
    const received: unknown[] = [];
    feed.on("book", (data: unknown) => received.push(data));

    callHandleMessage(feed, {
      channel: "l2Book",
      data: {
        coin: "ETH",
        levels: [
          [{ px: "3499", sz: "10", n: 5 }, { px: "3498", sz: "20", n: 3 }],
          [{ px: "3501", sz: "8", n: 3 }, { px: "3502", sz: "15", n: 2 }],
        ],
      },
    });

    expect(received).toHaveLength(1);
    const book = received[0] as { bids: [string, string][]; asks: [string, string][] };
    expect(book.bids).toEqual([["3499", "10"], ["3498", "20"]]);
    expect(book.asks).toEqual([["3501", "8"], ["3502", "15"]]);
  });

  it("parses HL trade sides correctly (A=sell, B=buy)", () => {
    const feed = new HyperliquidMarketFeed();
    const trades: unknown[] = [];
    feed.on("trade", (data: unknown) => trades.push(data));

    callHandleMessage(feed, {
      channel: "trades",
      data: [
        { coin: "ETH", side: "A", px: "3500", sz: "0.1", time: 1000 },
        { coin: "ETH", side: "B", px: "3501", sz: "0.2", time: 1001 },
      ],
    });

    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ side: "sell", price: "3500", size: "0.1" });
    expect(trades[1]).toMatchObject({ side: "buy", price: "3501", size: "0.2" });
  });

  it("emits candle data", () => {
    const feed = new HyperliquidMarketFeed();
    const candles: unknown[] = [];
    feed.on("candle", (data: unknown) => candles.push(data));

    callHandleMessage(feed, {
      channel: "candle",
      data: { s: "ETH", i: "1m", o: "3500", h: "3510", l: "3490", c: "3505", v: "1000", t: 1234567890 },
    });

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ o: "3500", h: "3510", l: "3490", c: "3505", v: "1000", t: 1234567890 });
  });

  it("ignores messages with no data", () => {
    const feed = new HyperliquidMarketFeed();
    const received: unknown[] = [];
    feed.on("prices", (d: unknown) => received.push(d));
    feed.on("book", (d: unknown) => received.push(d));

    callHandleMessage(feed, { channel: "allMids" }); // no data
    callHandleMessage(feed, { channel: "l2Book" });

    expect(received).toHaveLength(0);
  });

  it("ignores unknown channels", () => {
    const feed = new HyperliquidMarketFeed();
    const received: unknown[] = [];
    feed.on("prices", (d: unknown) => received.push(d));

    callHandleMessage(feed, { channel: "unknown", data: { foo: "bar" } });

    expect(received).toHaveLength(0);
  });
});

describe("LighterMarketFeed", () => {
  it("constructs with default intervals", () => {
    const feed = new LighterMarketFeed();
    expect(feed).toBeDefined();
  });

  it("constructs with custom intervals", () => {
    const feed = new LighterMarketFeed({
      pricesIntervalMs: 5000,
      bookIntervalMs: 3000,
      candleIntervalMs: 10000,
    });
    expect(feed).toBeDefined();
  });
});

describe("createMarketFeed factory", () => {
  it("creates HyperliquidMarketFeed for 'hyperliquid'", () => {
    const feed = createMarketFeed("hyperliquid");
    expect(feed).toBeInstanceOf(HyperliquidMarketFeed);
  });

  it("creates LighterMarketFeed for 'lighter'", () => {
    const feed = createMarketFeed("lighter");
    expect(feed).toBeInstanceOf(LighterMarketFeed);
  });

  it("throws for 'pacifica'", () => {
    expect(() => createMarketFeed("pacifica")).toThrow();
  });

  it("throws for unknown exchange", () => {
    expect(() => createMarketFeed("unknown")).toThrow();
  });
});
