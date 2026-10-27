/**
 * The ONE capability table of the conformance suite: per venue, which read command is expected to
 * work, which answers with a declared alternate contract, and which refuses with
 * CAPABILITY_UNSUPPORTED (and why). Every registered venue (listVenues()) MUST have an entry —
 * the suite fails for a venue without one, and for a venue without a recorded fixture, unless it is
 * listed in OPT_OUT with a documented reason. Entries are cross-checked against the venue
 * definition and the adapter (roles, getFundingTerms / getRfqQuotes) in venues.conformance.test.ts.
 */
import type { VenueId } from "../../exchanges/venue-types.js";

export type ReadCommand = "list" | "prices" | "info" | "funding" | "book" | "trades" | "kline";
export const READ_COMMANDS: readonly ReadCommand[] = ["list", "prices", "info", "funding", "book", "trades", "kline"];

export type Expect =
  | { kind: "ok" }
  /** A labelled alternate contract (contracts.ts) instead of the default one. */
  | { kind: "alt"; contract: "currentFunding" | "rfqQuotes"; reason: string }
  | { kind: "unsupported"; reason: string }
  /**
   * The venue serves this read only to an authenticated account. The keyless suite asserts the
   * typed refusal (NO_SIGNER_AVAILABLE + remediation) — never a silent empty result.
   */
  | { kind: "credentials"; reason: string };

export interface VenueConformance {
  /** A liquid market every cell reads (the venue's BTC perp unless the venue lists none). */
  symbol: string;
  /** Symbols kept when the fixture is trimmed (fixture-tools.ts). */
  keep: string[];
  /** Cells not listed are { kind: "ok" }. */
  cells: Partial<Record<ReadCommand, Expect>>;
}

const DEFAULT_KEEP = ["BTC", "ETH", "SOL"];

export const VENUE_CONFORMANCE: Record<VenueId, VenueConformance> = {
  pacifica: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  hyperliquid: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  lighter: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  aster: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  "lighter-rh": { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  ondo: {
    symbol: "BTC", keep: DEFAULT_KEEP,
    cells: { kline: { kind: "credentials", reason: "GET /v1/perps/candles requires an API key (HMAC-signed read)" } },
  },
  arcus: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  qfex: {
    symbol: "NVDA", keep: ["NVDA", "TSLA", "AAPL"],
    cells: { trades: { kind: "unsupported", reason: "the documented public trade endpoint (GET /public/trades) answers 404 on mainnet" } },
  },
  risex: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  txflow: {
    symbol: "BTC", keep: DEFAULT_KEEP,
    cells: { funding: { kind: "unsupported", reason: "TxFlow publishes no market funding-history read (fundingHistory → HTTP 403)" } },
  },
  variational: {
    symbol: "BTC", keep: DEFAULT_KEEP,
    cells: {
      funding: { kind: "alt", contract: "currentFunding", reason: "no funding-history API: current terms (kind currentFunding)" },
      book: { kind: "alt", contract: "rfqQuotes", reason: "RFQ venue: indicative maker quotes, not an order book (kind rfqQuotes)" },
      trades: { kind: "unsupported", reason: "the public API publishes no trade tape" },
      kline: { kind: "unsupported", reason: "the public API publishes no candles" },
    },
  },
  grvt: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
  extended: { symbol: "BTC", keep: DEFAULT_KEEP, cells: {} },
};

/**
 * Venues excluded from the conformance suite, each with the documented reason. Empty today —
 * an entry without a reason (or for an unregistered venue) fails the suite.
 */
export const OPT_OUT: Partial<Record<VenueId, string>> = {};

export function expectOf(venue: VenueId, cmd: ReadCommand): Expect {
  return VENUE_CONFORMANCE[venue].cells[cmd] ?? { kind: "ok" };
}

/** CLI argv of one read cell. */
export function argvOf(venue: string, cmd: ReadCommand, symbol: string): string[] {
  switch (cmd) {
    case "list": return ["-e", venue, "market", "list"];
    case "prices": return ["-e", venue, "market", "prices"];
    case "info": return ["-e", venue, "market", "info", symbol];
    case "funding": return ["-e", venue, "market", "funding", symbol, "--limit", String(FUNDING_LIMIT)];
    case "book": return ["-e", venue, "market", "book", symbol];
    case "trades": return ["-e", venue, "market", "trades", symbol, "--limit", String(TRADES_LIMIT)];
    case "kline": return ["-e", venue, "market", "kline", symbol, KLINE_INTERVAL];
  }
}

export const FUNDING_LIMIT = 5;
export const TRADES_LIMIT = 5;
export const KLINE_INTERVAL = "1h";
export const KLINE_INTERVAL_MS = 3_600_000;
/** An unknown symbol no venue lists. */
export const UNKNOWN_SYMBOL = "NOPEXYZ";
/** Read commands that take a symbol (the unknown-symbol cells). */
export const SYMBOL_COMMANDS: readonly ReadCommand[] = ["info", "funding", "book", "trades", "kline"];
