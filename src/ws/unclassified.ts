/**
 * Tickers that name DIFFERENT instruments on different venues — listed everywhere, never matched
 * across venues (canonical null): the one table for the CLI (assetClass "unclassified"), the
 * public directory / MCP / arb and the WS directory (defaultCanonicalize). src/ws keeps it so the
 * WS bundle needs no CLI module.
 *  - SPX: the SPX6900 token on Hyperliquid / Aster / Lighter / Pacifica; its ticker equals the
 *    canonical key of the S&P 500 index.
 *  - Pacifica BP / CHIP: tickers that collide with a listed equity / ETF.
 *  - Lighter BB / BOT / WEN / QNT: grouped with US equities there, each also a live crypto ticker.
 *  - Lighter RH: every listed perp is classified (LIGHTER_RH_CLASS); an unlisted one is not.
 */
export const UNCLASSIFIED_TICKERS: Readonly<Record<string, ReadonlySet<string>>> = {
  hyperliquid: new Set(["SPX"]),
  aster: new Set(["SPX"]),
  pacifica: new Set(["SPX", "BP", "CHIP"]),
  lighter: new Set(["BB", "BOT", "WEN", "QNT", "SPX"]),
};

/** Lighter RH listing classification (live listings 2026-09-30). */
export const LIGHTER_RH_CLASS: Readonly<Record<string, "crypto" | "commodity" | "etf" | "equity" | "preIpo">> = {
  // crypto
  BTC: "crypto", ETH: "crypto", SOL: "crypto", HYPE: "crypto", ZEC: "crypto", LIT: "crypto",
  VVV: "crypto", SUI: "crypto", NEAR: "crypto", XRP: "crypto", CASHCAT: "crypto", PONS: "crypto",
  // commodity (canonical via EXPLICIT_CANONICAL: XAU → GOLD, XAG → SILVER)
  XAU: "commodity", XAG: "commodity",
  // etf
  SPY: "etf", QQQ: "etf", SOXL: "etf", SLV: "etf", USO: "etf", SGOV: "etf",
  // equity
  AAPL: "equity", AMZN: "equity", GOOGL: "equity", META: "equity", MSFT: "equity", NVDA: "equity",
  TSLA: "equity", AMD: "equity", INTC: "equity", MU: "equity", TSM: "equity", ORCL: "equity",
  PLTR: "equity", COIN: "equity", CRCL: "equity", CRWV: "equity", BABA: "equity", SNDK: "equity",
  SMCI: "equity", SOFI: "equity", AMC: "equity", RGTI: "equity", QBTS: "equity", CLSK: "equity",
  IREN: "equity", WULF: "equity", LUNR: "equity", ASTS: "equity", BE: "equity", USAR: "equity",
  SPCX: "equity", SKHY: "equity",
  // pre-IPO / private (explicit-only canonical → null unless mapped)
  OPENAI: "preIpo", ANTHROPIC: "preIpo", SHEIN: "preIpo", ANSEM: "preIpo", AI: "preIpo",
};

/** true = `base` on `venue` is never matched across venues (native markets only — not HIP-3 dexes). */
export function isUnclassifiedTicker(venue: string, base: string): boolean {
  const up = base.toUpperCase();
  if (venue === "lighter-rh") return LIGHTER_RH_CLASS[up] === undefined;
  return UNCLASSIFIED_TICKERS[venue]?.has(up) === true;
}
