import type { ExchangeAdapter, ExchangeMarketInfo } from "./exchanges/index.js";
import { symbolMatch } from "./utils.js";
import { DEFAULT_TAKER_FEE } from "./constants.js";
import { PerpError } from "./errors.js";

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

  // Fetch market list, balance, and positions in parallel.
  // Defer the orderbook call until symbol membership is confirmed so invalid
  // symbols return a structured symbol_valid failure instead of a venue error.
  // SSOT rule #2: errors must propagate, never silently substitute defaults.
  // getMarkets retains a tracked-error wrapper so the failed-load case surfaces
  // a structured symbol_valid check (not a generic exception).
  let marketsError: string | null = null;
  const [markets, balance, positions] = await Promise.all([
    adapter.getMarkets().catch((e: unknown) => {
      marketsError = e instanceof Error ? e.message : String(e);
      return [] as ExchangeMarketInfo[];
    }),
    adapter.getBalance(),
    adapter.getPositions(),
  ]);

  if (markets.length === 0 && marketsError) {
    checks.push({ check: "symbol_valid", passed: false, message: `Failed to load markets from ${adapter.name}: ${marketsError}` });
    return { valid: false, checks, warnings, timestamp: new Date().toISOString() };
  }

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

  const orderbook = params.type !== "limit"
    ? await adapter.getOrderbook(sym)
    : { bids: [] as [string, string][], asks: [] as [string, string][] };

  const markPrice = Number(market.markPrice);
  // Rule #2: NaN slipped past the previous `markPrice <= 0` check because
  // NaN comparisons are always false. Reject explicit non-finite values
  // upfront so downstream NaN propagation (notional, marginRequired,
  // slippage, deviation) is impossible.
  if (Number.isNaN(markPrice) || markPrice === Infinity || markPrice === -Infinity) {
    throw new PerpError(
      "EXCHANGE_ERROR",
      `${adapter.name} returned non-finite markPrice for ${sym}: ${market.markPrice}`,
      { exchange: adapter.name },
    );
  }
  if (params.type === "limit" && (params.price === undefined || !Number.isFinite(params.price))) {
    throw new Error(`Limit order requires explicit price (received ${params.price}); refusing silent mark-price substitution.`);
  }
  if (markPrice <= 0 && params.price === undefined) {
    throw new Error(`No mark price available for ${sym} on ${adapter.name} and no override price supplied; cannot validate trade.`);
  }
  const price = params.price ?? markPrice;
  const notional = params.size * price;
  if (params.leverage !== undefined && (!Number.isFinite(params.leverage) || params.leverage <= 0)) {
    throw new Error(`Leverage must be a positive number (received ${params.leverage}).`);
  }
  const leverage = params.leverage ?? market.maxLeverage;
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new Error(`No usable leverage for ${sym} (resolved=${leverage}); supply params.leverage explicitly.`);
  }
  const marginRequired = notional / leverage;

  // 2. Balance check
  const available = Number(balance.available);
  // Rule #2: a NaN `available` would silently take the "insufficient
  // balance" branch on the negative comparison and *also* render
  // misleading "$NaN available" in the user-visible message. Throw
  // instead so the trade flow surfaces a real venue/parsing failure.
  if (!Number.isFinite(available)) {
    throw new PerpError(
      "EXCHANGE_ERROR",
      `${adapter.name} returned non-finite balance.available: ${balance.available}`,
      { exchange: adapter.name },
    );
  }
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
      const pxN = Number(px);
      const szN = Number(sz);
      // Rule #2: a NaN level would silently inflate `availableLiquidity`
      // to NaN, the `>= notional` comparison would be false, and the
      // outer branch would emit a "Insufficient liquidity: $NaN" message.
      // Reject the level explicitly so a malformed orderbook can't
      // fabricate a passing or failing liquidity check.
      if (!Number.isFinite(pxN) || !Number.isFinite(szN) || pxN <= 0 || szN < 0) {
        throw new PerpError(
          "EXCHANGE_ERROR",
          `${adapter.name} orderbook level has non-finite or non-positive value for ${sym}: px=${px} sz=${sz}`,
          { exchange: adapter.name },
        );
      }
      availableLiquidity += pxN * szN;
      worstPrice = pxN;
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
      // Rule #2: NaN posSize would make `params.size > posSize` always
      // false, silently passing the reduce-only size check.
      if (!Number.isFinite(posSize)) {
        throw new PerpError(
          "EXCHANGE_ERROR",
          `${adapter.name} returned non-finite position size for ${sym}: ${pos.size}`,
          { exchange: adapter.name },
        );
      }
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
      // Rule #2: NaN funding rate must not propagate to envelope output;
      // surface the missing-data state via warnings rather than emitting
      // `fundingRate: NaN` to agents that JSON.parse the response.
      fundingRate: (() => {
        const fr = Number(market.fundingRate);
        if (!Number.isFinite(fr)) {
          warnings.push(`Funding rate unavailable for ${sym} on ${adapter.name} (received ${market.fundingRate})`);
          return 0;
        }
        return fr;
      })(),
      maxLeverage: market.maxLeverage,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Hard pre-trade risk gate for manual order commands.
 *
 * Unlike validateTrade (which is advisory — used by `trade check` and the MCP
 * preview), this is meant to run immediately before submitting a real order.
 * It throws RISK_VIOLATION when the order would breach the locally configured
 * limits (maxPositionUsd / maxTotalExposureUsd / maxPositions, plus any active
 * critical violation that suspends trading). reduce-only and --force orders are
 * exempt, so position-reducing and intentional-override flows are never blocked.
 *
 * Leverage is only checked when the caller passes an explicit value; the bare
 * buy/sell/market/limit commands carry no leverage argument, so the gate there
 * enforces notional/exposure rather than per-order leverage.
 */
export async function enforceOrderRisk(
  adapter: ExchangeAdapter,
  p: { symbol: string; size: number; price?: number; leverage?: number; reduceOnly?: boolean; force?: boolean },
): Promise<void> {
  if (p.reduceOnly || p.force) return;

  const { loadRiskLimits, assessRisk, preTradeCheck } = await import("./risk.js");
  const limits = loadRiskLimits();

  // Resolve notional: limit orders carry a price; market orders need markPrice.
  let price = p.price;
  if (price == null || !Number.isFinite(price)) {
    const markets = await adapter.getMarkets();
    const m = markets.find((mk) => symbolMatch(mk.symbol, p.symbol));
    if (!m) {
      throw new PerpError("SYMBOL_NOT_FOUND", `${p.symbol} not found on ${adapter.name}`, { exchange: adapter.name });
    }
    price = Number(m.markPrice);
  }
  // SSOT rule #2: if the notional cannot be computed we cannot enforce the
  // limit — fail closed (the caller may pass --force) rather than wave it
  // through with a silent zero notional that bypasses the position cap.
  if (!Number.isFinite(price) || (price as number) <= 0) {
    throw new PerpError("PRICE_STALE", `Cannot resolve a mark price for ${p.symbol} on ${adapter.name} to check risk limits`, {
      exchange: adapter.name,
      remediation: "Retry, or pass --force to skip the local risk check.",
    });
  }

  const notional = Math.abs(p.size * (price as number));
  const [balance, positions] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
  const assessment = assessRisk(
    [{ exchange: adapter.name, balance }],
    positions.map((pos) => ({ exchange: adapter.name, position: pos })),
    limits,
  );

  const check = preTradeCheck(assessment, notional, p.leverage ?? 0);
  if (!check.allowed) {
    throw new PerpError("RISK_VIOLATION", check.reason ?? "Order blocked by local risk limits", {
      exchange: adapter.name,
      remediation: "Adjust limits with `perp risk set ...`, reduce the order size, or pass --force to override.",
      details: { symbol: p.symbol, notional },
    });
  }
}
