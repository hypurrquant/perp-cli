/**
 * The universal JSON output contracts of the read commands (docs/TESTING.md §4) — ONE definition,
 * used by the conformance suite for every venue, by the CLI ⇄ MCP parity checks and by the live run.
 *
 * Units: venue-sourced quantities are DECIMAL STRINGS (exact, as the venue published them);
 * times are unix MILLISECONDS (integers); funding rates are fractions per `intervalHours`
 * (never percent, never pre-annualized) unless the field name says otherwise (`annualizedPct`).
 * Computed analytics of `arb scan` (spreads, percentages, hourly rates) are JSON numbers.
 * Unknown = null, never 0 / "" / omitted. Objects are LOOSE: a venue may add fields (additive
 * contract changes); removing or retyping a field listed here is a breaking change
 * (CHANGELOG "JSON contract changes").
 */
import { z } from "zod";

export const Dec = z.string().regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/, "decimal string");
export const DecOrNull = Dec.nullable();
export const PosDec = Dec.refine(s => Number(s) > 0, "> 0");
/** Unix milliseconds (2001 … 2286). A seconds value fails here. */
export const Ms = z.number().int().gt(1e12).lt(1e13);
export const RateKind = z.enum(["lastSettled", "accruing", "predicted"]);

// ── market list / prices / info ──

export const MarginTier = z.object({ lowerBound: z.number().nonnegative(), maxLeverage: z.number().positive() });

export const MarketRow = z.looseObject({
  symbol: z.string().min(1),
  markPrice: PosDec,
  indexPrice: PosDec.nullable(),
  fundingRate: DecOrNull,
  volume24h: DecOrNull,
  openInterest: DecOrNull,
  maxLeverage: z.number().positive().nullable(),
  sizeDecimals: z.number().int().nonnegative().nullable(),
  stepSize: PosDec.nullable(),
  fundingHours: z.number().positive().nullable(),
  marginTiers: z.array(MarginTier).nullable(),
});
export const MarketList = z.array(MarketRow);
/** `market list` / `market prices` without -e: every venue, grouped. */
export const MarketListAll = z.looseObject({
  exchanges: z.record(z.string(), MarketList),
  errors: z.record(z.string(), z.string()).optional(),
});

// ── funding ──

/**
 * One settled / published funding print. intervalHours + rateKind are checked separately (fields check).
 * `rate` is null only on a window the market was closed for (`marketClosed: true`, QFEX outside
 * market_hours: no funding exchanged) — never "0" as a stand-in.
 */
export const FundingRowBase = z.looseObject({
  time: Ms,
  rate: DecOrNull,
  price: PosDec.nullable(),
  marketClosed: z.boolean().optional(),
}).refine(r => r.rate !== null || r.marketClosed === true, { message: "rate is null on a print that is not marketClosed", path: ["rate"] });
/** A closed-market window has no settled rate: `rateKind` null there, a RateKind everywhere else. */
export const FundingRowFields = z.looseObject({
  intervalHours: z.number().positive(),
  rateKind: RateKind.nullable(),
  marketClosed: z.boolean().optional(),
}).refine(r => r.rateKind !== null || r.marketClosed === true, { message: "rateKind is null on a print that is not marketClosed", path: ["rateKind"] });
export const FundingHistory = z.array(FundingRowBase);

/** A venue without a funding-history API (Variational): its current terms, labelled. */
export const CurrentFundingTerms = z.looseObject({
  kind: z.literal("currentFunding"),
  venue: z.string(),
  symbol: z.string(),
  ticker: z.string(),
  contractType: z.enum(["perpetual", "swap"]),
  rateKind: z.literal("predicted").nullable(),
  intervalRate: DecOrNull,
  intervalHours: z.number().positive().nullable(),
  hourlyRate: z.number().nullable(),
  annualizedPct: z.number().nullable(),
  venueAnnualizedRate: DecOrNull,
  nextFundingTime: Ms.nullable(),
  swap: z.unknown(),
  note: z.string().min(1),
});

// ── book / trades / kline ──

export const Level = z.tuple([PosDec, PosDec]);
export const Orderbook = z.looseObject({ bids: z.array(Level), asks: z.array(Level) });

/** An RFQ venue (Variational) has no order book: its maker's indicative quotes, labelled. */
export const RfqQuotes = z.looseObject({
  kind: z.literal("rfqQuotes"),
  venue: z.string(),
  symbol: z.string(),
  ticker: z.string(),
  markPrice: PosDec,
  updatedAt: z.string().nullable(),
  baseSpreadBps: DecOrNull,
  quotes: z.array(z.looseObject({ tier: z.string(), notionalUsd: DecOrNull, bid: PosDec, ask: PosDec })),
  note: z.string().min(1),
});

export const PublicTrade = z.looseObject({
  time: Ms,
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  price: PosDec,
  size: PosDec,
  fee: z.null(),
});
export const Trades = z.array(PublicTrade);

export const Kline = z.looseObject({
  time: Ms,
  open: PosDec,
  high: PosDec,
  low: PosDec,
  close: PosDec,
  volume: DecOrNull,
  quoteVolume: DecOrNull,
  trades: z.number().int().nonnegative().nullable(),
});
export const Klines = z.array(Kline);

// ── health ──

export const HealthProbe = z.looseObject({
  exchange: z.string(),
  // `perp health` has printed "down" for a failed probe since 0.15.0 (src/commands/risk.ts).
  status: z.enum(["ok", "down"]),
  latency_ms: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  probe: z.string(),
  apiStatus: z.enum(["official", "unofficial"]),
});
export const Health = z.looseObject({
  allHealthy: z.boolean(),
  network: z.enum(["mainnet", "testnet"]),
  exchanges: z.array(HealthProbe),
  unofficial: z.array(HealthProbe),
  skipped: z.array(z.unknown()),
});

// ── arb scan ──

const ArbCommon = {
  symbol: z.string(),
  markPrice: z.number().positive(),
  grossSpread: z.number(),
  netSpread: z.number(),
  estFeesPct: z.number(),
};
export const ArbOpportunity = z.discriminatedUnion("mode", [
  z.looseObject({ mode: z.literal("perp-perp"), ...ArbCommon, longExch: z.string(), shortExch: z.string(), priceGapPct: z.number().nullable() }),
  z.looseObject({
    mode: z.literal("spot-perp"), ...ArbCommon, perpExchange: z.string(), spotExchanges: z.array(z.string()).min(1),
    perpFundingRate: z.number(), direction: z.string(), breakEvenDays: z.number().nullable(),
  }),
]);
export const ArbScan = z.array(ArbOpportunity);

export const RateRow = z.looseObject({
  exchange: z.string(),
  symbol: z.string(),
  canonical: z.string().nullable(),
  fundingRate: z.number(),
  basis: z.unknown(),
  hourlyRate: z.number(),
  annualizedPct: z.number(),
  markPrice: z.number().positive().nullable(),
  nextFundingTime: Ms.nullable(),
  fundingVerified: z.boolean(),
  apiStatus: z.enum(["official", "unofficial"]),
});
export const RateSymbol = z.looseObject({
  symbol: z.string(),
  rates: z.array(RateRow),
  // null = no ranked pair (fewer than two verified rows; --include-unverified display rows).
  maxSpreadAnnual: z.number().nullable(),
  longExchange: z.string().nullable(),
  shortExchange: z.string().nullable(),
  executable: z.boolean(),
  readOnlyLegs: z.array(z.string()),
});
export const ArbRates = z.looseObject({ symbols: z.array(RateSymbol), exchangeStatus: z.record(z.string(), z.string()) });

export const GapRow = z.looseObject({
  symbol: z.string(),
  maxGap: z.number(),
  maxGapPct: z.number(),
  cheapest: z.string(),
  expensive: z.string(),
});
export const ArbGaps = z.array(GapRow);

export const BasisRow = z.looseObject({
  symbol: z.string(),
  prices: z.record(z.string(), z.number()),
  priceDiff: z.number(),
  pctDiff: z.number(),
  buyOn: z.string(),
  sellOn: z.string(),
});
export const ArbBasis = z.array(BasisRow);

// ── error envelope ──

export const ErrorEnvelope = z.looseObject({
  ok: z.literal(false),
  error: z.looseObject({ code: z.string(), message: z.string().min(1), remediation: z.string().min(1) }),
});

/** "" when valid, else a short list of issues (path: message). */
export function issues(schema: z.ZodType, value: unknown, max = 6): string {
  const r = schema.safeParse(value);
  if (r.success) return "";
  return r.error.issues.slice(0, max).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
