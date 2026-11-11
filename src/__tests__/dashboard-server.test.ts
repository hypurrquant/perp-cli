/**
 * Dashboard server (startDashboard): who may read the account snapshot over its WebSocket. A real
 * server on 127.0.0.1 (port 0) and real `ws` clients; the venue adapter is a stub and the arb /
 * funding reads fail offline (no network).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { request } from "node:http";
import { WebSocket } from "ws";
import type { ExchangeAdapter } from "../exchanges/interface.js";

vi.mock("../funding/rates.js", () => ({
  fetchAllFundingRates: async () => { throw new Error("offline (test)"); },
  isRankedComparison: () => false,
}));
vi.mock("../dex-asset-map.js", () => ({
  fetchAllDexAssets: async () => { throw new Error("offline (test)"); },
  findDexArbPairs: () => [],
}));

import { startDashboard } from "../dashboard/server.js";
import { FEED_STALE_MS } from "../dashboard/ws-feeds.js";

const adapter = {
  name: "aster",
  getBalance: async () => ({ equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "5" }),
  getPositions: async () => [],
  getOpenOrders: async () => [],
  getMarkets: async () => [],
} as unknown as ExchangeAdapter;

let dash: { port: number; close: () => void } | null = null;
afterEach(() => { dash?.close(); dash = null; });

/** The first message the dashboard sends this client, or the handshake error. */
function firstMessage(port: number, origin?: string, host?: string): Promise<{ type: string } | Error> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { ...(origin === undefined ? {} : { origin }), ...(host === undefined ? {} : { headers: { Host: host } }) });
    ws.on("message", (raw) => { resolve(JSON.parse(String(raw)) as { type: string }); ws.close(); });
    ws.on("error", resolve);
  });
}

describe("dashboard WebSocket: only the dashboard's own page reads the account (security)", () => {
  it("a page on another origin is refused (403) and gets no snapshot", async () => {
    dash = await startDashboard([{ name: "aster", adapter }], { port: 0 });
    const r = await firstMessage(dash.port, "https://evil.example");
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("403");
  });

  it("the dashboard's own origin (localhost / 127.0.0.1) and a client without Origin get the snapshot", async () => {
    dash = await startDashboard([{ name: "aster", adapter }], { port: 0 });
    for (const origin of [`http://localhost:${dash.port}`, `http://127.0.0.1:${dash.port}`, undefined]) {
      expect(await firstMessage(dash.port, origin)).toMatchObject({ type: "snapshot" });
    }
  });
});

/** GET /api/snapshot with the given Host header: the status code and the body. */
function getSnapshot(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/snapshot", headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += String(c); });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("dashboard HTTP + WebSocket: only the dashboard's own host name (DNS rebinding, security)", () => {
  it("/api/snapshot under another Host is refused (403) and carries no account data", async () => {
    dash = await startDashboard([{ name: "aster", adapter }], { port: 0 });
    const r = await getSnapshot(dash.port, `evil.example:${dash.port}`);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("equity");
  });

  it("/api/snapshot under localhost / 127.0.0.1 on the served port is served", async () => {
    dash = await startDashboard([{ name: "aster", adapter }], { port: 0 });
    for (const host of [`localhost:${dash.port}`, `127.0.0.1:${dash.port}`]) {
      expect((await getSnapshot(dash.port, host)).status).toBe(200);
    }
  });

  it("a localhost Host on another port (a port-forward to a different local port) is refused", async () => {
    dash = await startDashboard([{ name: "aster", adapter }], { port: 0 });
    expect((await getSnapshot(dash.port, `localhost:${dash.port + 1}`)).status).toBe(403);
  });

  it("a WebSocket handshake under another Host (no Origin) is refused (403)", async () => {
    dash = await startDashboard([{ name: "aster", adapter }], { port: 0 });
    const r = await firstMessage(dash.port, undefined, `evil.example:${dash.port}`);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("403");
  });
});

describe("dashboard pushes a feed turning stale (no venue update needed)", () => {
  it("a feed silent for FEED_STALE_MS is pushed as stale to the open page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      let reads = 0;
      const silent = {
        ...adapter,
        // The first read answers; every later one never does (the venue went quiet).
        getBalance: () => (reads++ === 0 ? adapter.getBalance() : new Promise(() => {})),
      } as unknown as ExchangeAdapter;
      dash = await startDashboard([{ name: "aster", adapter: silent }], { port: 0 });
      const snaps: Array<{ exchanges: Array<{ feed?: { stale: boolean } }> }> = [];
      const ws = new WebSocket(`ws://127.0.0.1:${dash.port}`);
      ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "snapshot") snaps.push(m.data); });
      await expect.poll(() => snaps.length).toBe(1);
      expect(snaps[0].exchanges[0].feed?.stale).toBe(false);
      vi.setSystemTime(Date.now() + FEED_STALE_MS + 5000);
      await vi.advanceTimersByTimeAsync(FEED_STALE_MS + 5000);
      await expect.poll(() => snaps.at(-1)?.exchanges[0].feed?.stale).toBe(true);
      ws.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
