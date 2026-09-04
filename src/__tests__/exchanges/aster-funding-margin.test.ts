/**
 * Two Aster venue-semantics guards.
 *
 * 1. Funding interval comes from `GET /fapi/v3/fundingInfo`
 *    (`fundingIntervalHours`, weight 1, whole venue per call). It used to be
 *    inferred by differencing the last two fundingRate timestamps and bucketing
 *    to 1/4/8h — wrong for a newly listed symbol, across a schedule change, or
 *    when a settlement is skipped. Aster genuinely mixes 1h / 4h / 8h symbols,
 *    and a wrong interval is precisely the v0.7.23 Aster funding bug.
 *
 * 2. `POST /fapi/v3/marginType` failures were swallowed wholesale. Only
 *    `-4046 NO_NEED_TO_CHANGE_MARGIN_TYPE` is a benign no-op; every other
 *    rejection means the account is still on the previous margin mode, so
 *    swallowing it told the user "isolated" while the position stayed cross.
 */
import { describe, it, expect, vi } from "vitest";

async function buildAdapter() {
  const { AsterAdapter } = await import("../../exchanges/aster.js");
  const ast = new AsterAdapter(undefined, false);
  (ast as unknown as { _resolveSigner: () => unknown })._resolveSigner =
    vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
  return ast;
}

const FUNDING_INFO = [
  { symbol: "BTCUSDT", fundingIntervalHours: 8, fundingFeeCap: 0.02 },
  { symbol: "SUSHIUSDT", fundingIntervalHours: 1, fundingFeeCap: 0.02 },
  { symbol: "ZORAUSDT", fundingIntervalHours: 4, fundingFeeCap: 0.02 },
];

describe("AsterAdapter.getFundingHours — read, do not estimate", () => {
  it("reads fundingIntervalHours per symbol and preserves 1h / 4h / 8h", async () => {
    const ast = await buildAdapter();
    const publicGet = vi.fn().mockResolvedValue(FUNDING_INFO);
    (ast as unknown as { _publicGet: unknown })._publicGet = publicGet;

    expect(await ast.getFundingHours("BTC")).toBe(8);
    expect(await ast.getFundingHours("SUSHI")).toBe(1);
    expect(await ast.getFundingHours("ZORA")).toBe(4);
  });

  it("loads the whole venue in ONE call, not one per symbol", async () => {
    const ast = await buildAdapter();
    const publicGet = vi.fn().mockResolvedValue(FUNDING_INFO);
    (ast as unknown as { _publicGet: unknown })._publicGet = publicGet;

    await ast.getFundingHours("BTC");
    await ast.getFundingHours("SUSHI");
    await ast.getFundingHours("ZORA");

    expect(publicGet).toHaveBeenCalledTimes(1);
    expect(publicGet.mock.calls[0][0]).toBe("/fapi/v3/fundingInfo");
  });

  it("never consults the fundingRate history endpoint for the interval", async () => {
    const ast = await buildAdapter();
    const publicGet = vi.fn().mockResolvedValue(FUNDING_INFO);
    (ast as unknown as { _publicGet: unknown })._publicGet = publicGet;

    await ast.getFundingHours("BTC");
    const paths = publicGet.mock.calls.map((c) => String(c[0]));
    expect(paths).not.toContain("/fapi/v3/fundingRate");
  });

  it("returns undefined for a symbol the venue does not list", async () => {
    const ast = await buildAdapter();
    (ast as unknown as { _publicGet: unknown })._publicGet = vi.fn().mockResolvedValue(FUNDING_INFO);
    expect(await ast.getFundingHours("NOSUCH")).toBeUndefined();
  });

  it("throws when the venue returns a non-array instead of defaulting", async () => {
    // Rule #2: a malformed funding table must not silently become "no interval",
    // which downstream would read as the exchange default.
    const ast = await buildAdapter();
    (ast as unknown as { _publicGet: unknown })._publicGet = vi.fn().mockResolvedValue({ code: -1 });
    await expect(ast.getFundingHours("BTC")).rejects.toThrow(/did not return an array/);
  });
});

describe("AsterAdapter.setLeverage — margin-type failures are not swallowed", () => {
  const buildWithMarginTypeError = async (err: Error | null) => {
    const ast = await buildAdapter();
    const calls: string[] = [];
    (ast as unknown as { _signedPostEip712: unknown })._signedPostEip712 = vi.fn(
      async (path: string) => {
        calls.push(path);
        if (path === "/fapi/v3/marginType" && err) throw err;
        return { ok: true };
      },
    );
    return { ast, calls };
  };

  it("swallows -4046 NO_NEED_TO_CHANGE_MARGIN_TYPE and still sets leverage", async () => {
    const { ast, calls } = await buildWithMarginTypeError(
      new Error('{"code":-4046,"msg":"No need to change margin type."}'),
    );
    await expect(ast.setLeverage("BTC", 5, "isolated")).resolves.toBeDefined();
    expect(calls).toContain("/fapi/v3/leverage");
  });

  it("matches the benign case by message text too", async () => {
    const { ast } = await buildWithMarginTypeError(new Error("No need to change margin type"));
    await expect(ast.setLeverage("BTC", 5, "isolated")).resolves.toBeDefined();
  });

  it("THROWS on any other margin-type rejection (e.g. open position)", async () => {
    // Previously swallowed: the user was told isolated while staying cross, and
    // the leverage change below then applied to a cross position.
    const { ast, calls } = await buildWithMarginTypeError(
      new Error('{"code":-4048,"msg":"Margin type cannot be changed if there exists position."}'),
    );
    await expect(ast.setLeverage("BTC", 5, "isolated")).rejects.toThrow(/cannot be changed/);
    expect(calls).not.toContain("/fapi/v3/leverage");
  });

  it("does not touch marginType at all when no margin mode is requested", async () => {
    const { ast, calls } = await buildWithMarginTypeError(null);
    await ast.setLeverage("BTC", 5);
    expect(calls).not.toContain("/fapi/v3/marginType");
    expect(calls).toContain("/fapi/v3/leverage");
  });
});

/**
 * positionRisk failures must not silently disable liquidation monitoring, and
 * hedge-mode accounts must not be silently mis-rendered.
 */
describe("AsterAdapter.getPositions — positionRisk failure is surfaced", () => {
  const buildPositions = async (positions: unknown[], riskResult: unknown[] | Error) => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    (ast as unknown as { _resolveSigner: () => unknown })._resolveSigner =
      vi.fn().mockReturnValue({ kind: "agent", signer: {}, agent: {} });
    (ast as unknown as { _signedGetEip712: unknown })._signedGetEip712 = vi.fn(
      async (path: string) => {
        if (path === "/fapi/v3/positionRisk") {
          if (riskResult instanceof Error) throw riskResult;
          return riskResult;
        }
        return { positions };
      },
    );
    return ast;
  };

  const POS = [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "60000", unrealizedProfit: "0", leverage: "10" }];

  it("reports mark/liq as N/A (not 0) when positionRisk fails", async () => {
    // "0" is filtered by risk.ts and gates off event-stream's liquidation
    // warning, so a zero here silently removes the position from monitoring.
    const ast = await buildPositions(POS, new Error("429 rate limited"));
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = await ast.getPositions();
    warn.mockRestore();
    expect(out[0].liquidationPrice).toBe("N/A");
    expect(out[0].markPrice).toBe("N/A");
  });

  it("warns on stderr naming the suppressed liquidation warnings", async () => {
    const ast = await buildPositions(POS, new Error("429 rate limited"));
    const lines: string[] = [];
    const warn = vi.spyOn(process.stderr, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
    await ast.getPositions();
    warn.mockRestore();
    expect(lines.join("")).toMatch(/liquidation warnings are suppressed/i);
  });

  it("still populates mark/liq normally when positionRisk succeeds", async () => {
    const ast = await buildPositions(POS, [{ symbol: "BTCUSDT", markPrice: "61000", liquidationPrice: "50000" }]);
    const out = await ast.getPositions();
    expect(out[0].markPrice).toBe("61000");
    expect(out[0].liquidationPrice).toBe("50000");
  });

  it("refuses a hedge-mode account instead of collapsing the two legs", async () => {
    // Hedge mode returns LONG and SHORT rows for the same symbol; everything
    // here is keyed by symbol, so one leg would inherit the other's liq price.
    const hedged = [
      { symbol: "BTCUSDT", positionAmt: "1", entryPrice: "60000", unrealizedProfit: "0", leverage: "10" },
      { symbol: "BTCUSDT", positionAmt: "-1", entryPrice: "61000", unrealizedProfit: "0", leverage: "10" },
    ];
    const ast = await buildPositions(hedged, []);
    await expect(ast.getPositions()).rejects.toThrow(/hedge mode is not supported/i);
  });
});
