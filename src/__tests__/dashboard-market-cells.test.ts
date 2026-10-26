/**
 * Dashboard market table (getUI → marketCells): QFEX non-USD rows print their quote currency,
 * open interest is base units (it was "$6" for 5.6957 SAMSUNG shares — and for every venue's
 * base-unit OI), and a null funding rate is "-" (QFEX lists carry fundingRate null; 0.15.0 showed 0.0000%).
 * Row values: the live QFEX SAMSUNG-KRW / AAPL market rows of 2026-10-19 (perp -e qfex market list).
 */
import { describe, it, expect } from "vitest";
import { getUI } from "../dashboard/ui.js";

type Cells = { mark: string; index: string; funding: string; volume: string; oi: string };

function marketCells(): (m: Record<string, unknown>) => Cells {
  const html = getUI();
  const line = (name: string): string => {
    const l = html.split("\n").find(x => x.startsWith(`function ${name}(`));
    if (l === undefined) throw new Error(`dashboard UI has no ${name}()`);
    return l;
  };
  return new Function(`${line("fmt")}\n${line("usdOrDash")}\n${line("escHtml")}\n${line("marketCells")}\nreturn marketCells;`)() as (m: Record<string, unknown>) => Cells;
}

describe("dashboard market cells", () => {
  const cells = marketCells();

  it("SAMSUNG-KRW: KRW prices / volume, OI in shares, funding null → -", () => {
    expect(cells({
      symbol: "SAMSUNG-KRW", markPrice: "220180", indexPrice: "220092.36054959", fundingRate: null,
      volume24h: null, volume24hQuote: "9936964.589", openInterest: "5.6957", quoteAsset: "KRW",
    })).toEqual({ mark: "220,180.00 KRW", index: "220,092.36 KRW", funding: "-", volume: "9,936,965 KRW", oi: "5.6957 SAMSUNG-KRW" });
  });

  it("USD row: $ prices; OI still base units, never $", () => {
    expect(cells({
      symbol: "AAPL", markPrice: "342.45", indexPrice: "342.47", fundingRate: "0.00000007",
      volume24h: "1624169.13611", openInterest: "10451.534", quoteAsset: "USD",
    })).toEqual({ mark: "$342.45", index: "$342.47", funding: "0.0000%", volume: "$1,624,169", oi: "10,451.534 AAPL" });
  });
});

describe("dashboard escapes venue strings (B2-7)", () => {
  const html = getUI();

  it("marketCells escapes quoteAsset and the symbol's base", () => {
    const c = marketCells()({ symbol: "<img src=x onerror=alert(1)>-KRW", markPrice: "1", indexPrice: null, fundingRate: null, volume24h: null, openInterest: "1", quoteAsset: "<b>KRW</b>" });
    expect(c.mark).toBe("1.00 &lt;b&gt;KRW&lt;/b&gt;");
    expect(c.oi).toBe("1 &lt;img src=x onerror=alert(1)&gt;-KRW");
  });

  it("every symbol / dex / order field / event cell goes through escHtml; the page script still parses", () => {
    for (const raw of ["${m.symbol}<", "${o.symbol}<", "${sym}<", "${dex}<", "${e.exchange}<", "${o.status}<"]) {
      expect(html.includes(raw), raw).toBe(false);
    }
    expect(html).toContain("${escHtml(m.symbol)}");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script as string)).not.toThrow();
  });
});
