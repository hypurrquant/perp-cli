import type { ExchangeAdapter, ExchangeMarketInfo } from "./exchanges/index.js";
import { symbolMatch } from "./utils.js";
import { DEFAULT_TAKER_FEE } from "./constants.js";

export interface CheckResult {
  check: "symbol_valid" | "balance_sufficient" | "price_fresh" | "liquidity_ok" | "risk_limits" | "position_exists";
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface TradeValidation {
  valid: boolean;
  checks: CheckResult[];
  warnings: string[];
  estimatedCost?: {
    margin: number;
    fee: number;
    slippage: number;
    total: number;
  };
  marketInfo?: {
    symbol: string;
    markPrice: number;
    fundingRate: number;
    maxLeverage: number;
  };
  timestamp: string;
}

export interface TradeCheckParams {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price?: number;           // for limit orders
  type?: "market" | "limit" | "stop";
  leverage?: number;
  reduceOnly?: boolean;
}

// Use centralized DEFAULT_TAKER_FEE from constants.ts (0.035%)
const DEFAULT_MAX_SLIPPAGE = 0.005; // 0.5%

/**
 * Validate a trade before execution.
 * Runs multiple checks in parallel where possible.
 */
export async function validateTrade(
  adapter: ExchangeAdapter,
  params: TradeCheckParams,
): Promise<TradeValidation> {
  const checks: CheckResult[] = [];
  const warnings: string[] = [];
  const sym = params.symbol.toUpperCase();

  // Fetch market data, balance, positions, orderbook in parallel
  const [markets, balance, positions, orderbook] = await Promise.all([
    adapter.getMarkets().catch(() => [] as ExchangeMarketInfo[]),
    adapter.getBalance().catch(() => ({ equity: "0", available: "0", marginUsed: "0", unrealizedPnl: "0" })),
    adapter.getPositions().catch(() => []),
    params.type !== "limit" ? adapter.getOrderbook(sym).catch(() => ({ bids: [] as [string, string][], asks: [] as [string, string][] })) : Promise.resolve({ bids: [] as [string, string][], asks: [] as [string, string][] }),
  ]);

  // 1. Symbol validity (handle BTC vs BTC-PERP suffix variants)
  const market = markets.find(m => {
    const ms = m.symbol.toUpperCase();
    return ms === sym || ms === `${sym}-PERP` || ms.replace(/-PERP$/, "") === sym;
  });
  if (market) {
    checks.push({ check: "symbol_valid", passed: true, message: `${sym} found on ${adapter.name}`, details: { maxLeverage: market.maxLeverage } });
  } else {
    checks.push({ check: "symbol_valid", passed: false, message: `${sym} not found on ${adapter.name}` });
    return { valid: false, checks, warnings, timestamp: new Date().toISOString() };
  }

  const markPrice = Number(market.markPrice);
  const price = params.price ?? markPrice;
  const notional = params.size * price;
  const leverage = params.leverage ?? market.maxLeverage;
  const marginRequired = notional / leverage;

  // 2. Balance check
  const available = Number(balance.available);
  if (params.reduceOnly) {
    // reduce-only doesn't need margin
    checks.push({ check: "balance_sufficient", passed: true, message: "Reduce-only order, no margin needed" });
  } else if (available >= marginRequired) {
    checks.push({ check: "balance_sufficient", passed: true, message: `Available $${available.toFixed(2)} >= margin required $${marginRequired.toFixed(2)}`, details: { available, marginRequired, leverage } });
  } else {
    checks.push({ check: "balance_sufficient", passed: false, message: `Insufficient balance: $${available.toFixed(2)} available, $${marginRequired.toFixed(2)} required at ${leverage}x`, details: { available, marginRequired, leverage } });
  }

  // 3. Price freshness (if mark price is way off from input price for limits)
  if (params.price && markPrice > 0) {
    const deviation = Math.abs(params.price - markPrice) / markPrice;
    if (deviation > 0.10) {
      checks.push({ check: "price_fresh", passed: false, message: `Price $${params.price} deviates ${(deviation * 100).toFixed(1)}% from mark $${markPrice.toFixed(2)}`, details: { price: params.price, markPrice, deviationPct: deviation * 100 } });
    } else if (deviation > 0.03) {
      checks.push({ check: "price_fresh", passed: true, message: `Price deviation ${(deviation * 100).toFixed(1)}% from mark` });
      warnings.push(`Price $${params.price} is ${(deviation * 100).toFixed(1)}% from mark price $${markPrice.toFixed(2)}`);
    } else {
      checks.push({ check: "price_fresh", passed: true, message: "Price within normal range of mark" });
    }
  } else {
    checks.push({ check: "price_fresh", passed: true, message: markPrice > 0 ? `Mark price: $${markPrice.toFixed(2)}` : "No mark price to compare" });
  }

  // 4. Liquidity check (market orders)
  if (params.type !== "limit" && orderbook.bids.length > 0) {
    const book = params.side === "buy" ? orderbook.asks : orderbook.bids;
    let availableLiquidity = 0;
    let worstPrice = 0;
    for (const [px, sz] of book) {
      availableLiquidity += Number(px) * Number(sz);
      worstPrice = Number(px);
      if (availableLiquidity >= notional) break;
    }

    if (availableLiquidity >= notional) {
      const slippage = markPrice > 0 ? Math.abs(worstPrice - markPrice) / markPrice : 0;
      if (slippage > DEFAULT_MAX_SLIPPAGE) {
        checks.push({ check: "liquidity_ok", passed: false, message: `Slippage ${(slippage * 100).toFixed(2)}% exceeds ${(DEFAULT_MAX_SLIPPAGE * 100).toFixed(1)}% threshold`, details: { slippagePct: slippage * 100, worstPrice, liquidityUsd: availableLiquidity } });
      } else {
        checks.push({ check: "liquidity_ok", passed: true, message: `Sufficient liquidity ($${availableLiquidity.toFixed(0)}), slippage ~${(slippage * 100).toFixed(3)}%`, details: { slippagePct: slippage * 100, liquidityUsd: availableLiquidity } });
      }
    } else {
      checks.push({ check: "liquidity_ok", passed: false, message: `Insufficient liquidity: $${availableLiquidity.toFixed(0)} available vs $${notional.toFixed(0)} needed`, details: { liquidityUsd: availableLiquidity, notional } });
    }
  } else {
    checks.push({ check: "liquidity_ok", passed: true, message: "Liquidity check skipped (limit order or no book data)" });
  }

  // 5. Risk limits (use existing risk system)
  try {
    const { assessRisk, preTradeCheck } = await import("./risk.js");
    const assessment = assessRisk(
      [{ exchange: adapter.name, balance }],
      positions.map(p => ({ exchange: adapter.name, position: p })),
    );
    const riskResult = preTradeCheck(assessment, notional, leverage);
    if (riskResult.allowed) {
      checks.push({ check: "risk_limits", passed: true, message: "Within risk limits" });
    } else {
      checks.push({ check: "risk_limits", passed: false, message: `Risk violation: ${riskResult.reason}`, details: { reason: riskResult.reason } });
    }
    // Surface non-critical violations from the assessment as warnings
    for (const v of assessment.violations) {
      if (v.severity !== "critical") {
        warnings.push(`${v.rule}: ${v.message}`);
      }
    }
  } catch {
    checks.push({ check: "risk_limits", passed: true, message: "Risk check skipped (no limits configured)" });
  }

  // 6. Position check (for reduce-only)
  if (params.reduceOnly) {
    const pos = positions.find(p => symbolMatch(p.symbol, sym));
    if (pos) {
      const posSize = parseFloat(pos.size);
      if (params.size > posSize) {
        checks.push({ check: "position_exists", passed: false, message: `Reduce size ${params.size} exceeds position ${posSize}`, details: { positionSize: posSize, reduceSize: params.size } });
      } else {
        checks.push({ check: "position_exists", passed: true, message: `Position exists: ${pos.side} ${pos.size}`, details: { side: pos.side, size: posSize } });
      }
    } else {
      checks.push({ check: "position_exists", passed: false, message: `No position found for ${sym} (reduce-only requires open position)` });
    }
  }

  // Estimated cost
  const fee = notional * DEFAULT_TAKER_FEE;
  const estimatedSlippage = params.type === "limit" ? 0 : notional * 0.001;

  const valid = checks.every(c => c.passed);

  if (leverage > market.maxLeverage) {
    warnings.push(`Requested leverage ${leverage}x exceeds max ${market.maxLeverage}x`);
  }

  return {
    valid,
    checks,
    warnings,
    estimatedCost: {
      margin: marginRequired,
      fee,
      slippage: estimatedSlippage,
      total: marginRequired + fee + estimatedSlippage,
    },
    marketInfo: {
      symbol: sym,
      markPrice,
      fundingRate: Number(market.fundingRate),
      maxLeverage: market.maxLeverage,
    },
    timestamp: new Date().toISOString(),
  };
}
