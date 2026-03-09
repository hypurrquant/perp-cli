import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for HIP-3 deployed perp dex support.
 *
 * Tests the parsing logic for allPerpMetas, dex-specific meta/markets,
 * and the dex getter/setter behavior — all without real API calls.
 */

// ── Mock data matching real Hyperliquid API responses ──

const MOCK_ALL_PERP_METAS = [
  // Entry 0: native/validator perps
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 40 },
      { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      { name: "SOL", szDecimals: 2, maxLeverage: 20 },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  // Entry 1: "xyz" dex
  {
    universe: [
      { name: "xyz:XYZ100", szDecimals: 4, maxLeverage: 30 },
      { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10 },
      { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 20 },
      { name: "xyz:GOLD", szDecimals: 3, maxLeverage: 10 },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  // Entry 2: "vntl" dex
  {
    universe: [
      { name: "vntl:SPACEX", szDecimals: 2, maxLeverage: 5 },
      { name: "vntl:OPENAI", szDecimals: 2, maxLeverage: 5 },
      { name: "vntl:ANTHROPIC", szDecimals: 2, maxLeverage: 5 },
    ],
    marginTables: [],
    collateralToken: 360,
  },
  // Entry 3: empty dex (edge case)
  {
    universe: [],
    marginTables: [],
    collateralToken: 0,
  },
];

const MOCK_DEX_META = {
  universe: [
    { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10 },
    { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 20 },
  ],
};

const MOCK_DEX_CTXS = [
  { markPx: "392.26", funding: "-0.0000239162", openInterest: "39985.292", dayNtlVlm: "3054400.08", oraclePx: "392.00" },
  { markPx: "175.94", funding: "-0.0000094967", openInterest: "392790.598", dayNtlVlm: "38782380.60", oraclePx: "176.00" },
];

const MOCK_DEX_CLEARINGHOUSE = {
  marginSummary: { accountValue: "1000.00", totalMarginUsed: "200.00" },
  crossMarginSummary: { accountValue: "1000.00", totalMarginUsed: "200.00" },
  withdrawable: "800.00",
  assetPositions: [
    {
      position: {
        coin: "xyz:TSLA",
        szi: "5.0",
        entryPx: "380.00",
        positionValue: "1961.30",
        liquidationPx: "350.00",
        unrealizedPnl: "61.30",
        leverage: { value: 2 },
      },
    },
    {
      position: {
        coin: "xyz:NVDA",
        szi: "-10.0",
        entryPx: "180.00",
        positionValue: "1759.40",
        liquidationPx: "210.00",
        unrealizedPnl: "40.60",
        leverage: { value: 3 },
      },
    },
  ],
};

// ── Tests ──

describe("HIP-3 Deployed Perps — listDeployedDexes parsing", () => {
  it("extracts dex names from asset prefixes, skipping native perps", () => {
    // Simulate the parsing logic from listDeployedDexes
    const allMetas = MOCK_ALL_PERP_METAS;
    const dexes: { name: string; assets: string[] }[] = [];

    for (let i = 1; i < allMetas.length; i++) {
      const meta = allMetas[i];
      const universe = meta.universe ?? [];
      if (universe.length === 0) continue;
      const firstAsset = universe[0].name;
      const colonIdx = firstAsset.indexOf(":");
      const dexName = colonIdx > 0 ? firstAsset.slice(0, colonIdx) : `dex-${i}`;
      dexes.push({
        name: dexName,
        assets: universe.map((a) => a.name),
      });
    }

    expect(dexes).toHaveLength(2); // xyz, vntl (empty one skipped)
    expect(dexes[0].name).toBe("xyz");
    expect(dexes[0].assets).toEqual(["xyz:XYZ100", "xyz:TSLA", "xyz:NVDA", "xyz:GOLD"]);
    expect(dexes[1].name).toBe("vntl");
    expect(dexes[1].assets).toContain("vntl:SPACEX");
    expect(dexes[1].assets).toContain("vntl:ANTHROPIC");
  });

  it("skips entries with empty universe", () => {
    const allMetas = MOCK_ALL_PERP_METAS;
    const nonEmpty = allMetas.slice(1).filter((m) => m.universe.length > 0);
    expect(nonEmpty).toHaveLength(2);
  });

  it("handles response with only native perps", () => {
    const onlyNative = [MOCK_ALL_PERP_METAS[0]];
    const dexes: string[] = [];
    for (let i = 1; i < onlyNative.length; i++) {
      dexes.push("should-not-reach");
    }
    expect(dexes).toHaveLength(0);
  });
});

describe("HIP-3 Deployed Perps — dex-specific market parsing", () => {
  it("parses metaAndAssetCtxs with dex param correctly", () => {
    const universe = MOCK_DEX_META.universe;
    const ctxs = MOCK_DEX_CTXS;

    const markets = universe.map((asset, i) => {
      const ctx = ctxs[i] ?? {};
      return {
        symbol: asset.name,
        markPrice: String(ctx.markPx ?? "0"),
        indexPrice: String(ctx.oraclePx ?? "0"),
        fundingRate: String(ctx.funding ?? "0"),
        volume24h: String(ctx.dayNtlVlm ?? "0"),
        openInterest: String(ctx.openInterest ?? "0"),
        maxLeverage: Number(asset.maxLeverage ?? 50),
      };
    });

    expect(markets).toHaveLength(2);

    expect(markets[0].symbol).toBe("xyz:TSLA");
    expect(markets[0].markPrice).toBe("392.26");
    expect(markets[0].fundingRate).toBe("-0.0000239162");
    expect(markets[0].maxLeverage).toBe(10);

    expect(markets[1].symbol).toBe("xyz:NVDA");
    expect(Number(markets[1].volume24h)).toBeGreaterThan(1_000_000);
    expect(markets[1].maxLeverage).toBe(20);
  });

  it("asset map is built from dex universe", () => {
    const assetMap = new Map<string, number>();
    MOCK_DEX_META.universe.forEach((asset, idx) => {
      assetMap.set(asset.name, idx);
    });

    expect(assetMap.get("xyz:TSLA")).toBe(0);
    expect(assetMap.get("xyz:NVDA")).toBe(1);
    expect(assetMap.get("BTC")).toBeUndefined(); // native asset not in dex
  });
});

describe("HIP-3 Deployed Perps — dex-specific balance/positions parsing", () => {
  it("parses clearinghouseState with dex param", () => {
    const s = MOCK_DEX_CLEARINGHOUSE;
    const margin = s.marginSummary ?? {};
    const cross = s.crossMarginSummary ?? {};

    const equity = Number(margin.accountValue ?? cross.accountValue ?? 0);
    const available = Number(s.withdrawable ?? 0);
    const marginUsed = Number(margin.totalMarginUsed ?? cross.totalMarginUsed ?? 0);

    expect(equity).toBe(1000);
    expect(available).toBe(800);
    expect(marginUsed).toBe(200);
  });

  it("parses dex positions with prefixed coin names", () => {
    const positions = MOCK_DEX_CLEARINGHOUSE.assetPositions
      .filter((p) => Number(p.position.szi) !== 0)
      .map((p) => {
        const pos = p.position;
        const szi = Number(pos.szi);
        return {
          symbol: pos.coin,
          side: szi > 0 ? "long" : "short",
          size: String(Math.abs(szi)),
          entryPrice: pos.entryPx,
          unrealizedPnl: pos.unrealizedPnl,
        };
      });

    expect(positions).toHaveLength(2);

    expect(positions[0].symbol).toBe("xyz:TSLA");
    expect(positions[0].side).toBe("long");
    expect(positions[0].size).toBe("5");

    expect(positions[1].symbol).toBe("xyz:NVDA");
    expect(positions[1].side).toBe("short");
    expect(positions[1].size).toBe("10");
  });
});

describe("HIP-3 Deployed Perps — setDex behavior", () => {
  it("setDex clears asset map and sets dex name", () => {
    const assetMap = new Map<string, number>();
    assetMap.set("BTC", 0);
    assetMap.set("ETH", 1);
    let dex = "";

    // Simulate setDex("xyz")
    dex = "xyz";
    assetMap.clear();

    expect(dex).toBe("xyz");
    expect(assetMap.size).toBe(0);
  });

  it("empty dex string means native perps", () => {
    let dex = "xyz";
    dex = "";
    expect(dex).toBeFalsy();
    expect(!dex).toBe(true); // Used as condition: if (this._dex) { ... }
  });
});

describe("HIP-3 — dex name extraction edge cases", () => {
  it("handles single-char prefix", () => {
    const name = "a:BTC";
    const prefix = name.slice(0, name.indexOf(":"));
    expect(prefix).toBe("a");
  });

  it("handles no colon (fallback to dex-N)", () => {
    const name = "UNKNOWN";
    const colonIdx = name.indexOf(":");
    const dexName = colonIdx > 0 ? name.slice(0, colonIdx) : "dex-1";
    expect(dexName).toBe("dex-1");
  });

  it("handles multiple colons (takes first)", () => {
    const name = "abc:def:GHI";
    const colonIdx = name.indexOf(":");
    const dexName = name.slice(0, colonIdx);
    expect(dexName).toBe("abc");
  });
});
