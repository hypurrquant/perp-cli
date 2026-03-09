import type { ExchangeAdapter } from "../exchanges/interface.js";
import { symbolMatch } from "../utils.js";
import { updateJobState } from "../jobs.js";
import { fetchAllBalances, computeRebalancePlan, hasEnoughBalance, type ExchangeBalanceSnapshot } from "../rebalance.js";
import { checkArbLiquidity } from "../liquidity.js";
import { computeAnnualSpread, toHourlyRate } from "../funding.js";
import { computeMatchedSize, reconcileArbFills } from "../arb-sizing.js";

export interface FundingArbParams {
  minSpread: number;       // minimum annual spread % to trigger entry
  closeSpread: number;     // close when annual spread drops below this %
  size: string;            // position size per leg (base amount)
  sizeUsd?: number;        // position size in USD (alternative to base amount)
  symbols?: string[];      // filter symbols (empty = all)
  intervalSec: number;     // check interval in seconds
  autoExecute: boolean;    // actually place trades or just monitor
  maxPositions?: number;   // max simultaneous arb positions, default 3
  autoRebalance?: boolean; // auto-rebalance when one exchange runs low
  rebalanceThreshold?: number; // trigger rebalance when available < this USD
  maxDrawdown?: number;    // close all if total uPnL exceeds this negative USD
}

interface FundingRate {
  exchange: string;
  symbol: string;
  fundingRate: number;
  markPrice: number;
}

interface ArbPosition {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  size: string;
  entrySpread: number;
  openedAt: number;
  entryPrices: { long: number; short: number };
}

const PACIFICA_URL = "https://api.pacifica.fi/api/v1/info/prices";
const HL_URL = "https://api.hyperliquid.xyz/info";
const LIGHTER_URL = "https://mainnet.zklighter.elliot.ai";

async function fetchAllRates(): Promise<FundingRate[]> {
  const [pacRates, hlRates, ltRates] = await Promise.allSettled([
    fetchPacifica(),
    fetchHyperliquid(),
    fetchLighter(),
  ]);

  return [
    ...(pacRates.status === "fulfilled" ? pacRates.value : []),
    ...(hlRates.status === "fulfilled" ? hlRates.value : []),
    ...(ltRates.status === "fulfilled" ? ltRates.value : []),
  ];
}

async function fetchPacifica(): Promise<FundingRate[]> {
  const res = await fetch(PACIFICA_URL);
  const json = await res.json();
  const data = json.data ?? json;
  if (!Array.isArray(data)) return [];
  return data.map((p: Record<string, unknown>) => ({
    exchange: "pacifica",
    symbol: String(p.symbol ?? ""),
    fundingRate: Number(p.funding ?? 0),
    markPrice: Number(p.mark ?? 0),
  }));
}

async function fetchHyperliquid(): Promise<FundingRate[]> {
  const res = await fetch(HL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const json = await res.json();
  const universe = json[0]?.universe ?? [];
  const ctxs = json[1] ?? [];
  return universe.map((a: Record<string, unknown>, i: number) => {
    const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
    return {
      exchange: "hyperliquid",
      symbol: String(a.name ?? ""),
      fundingRate: Number(ctx.funding ?? 0),
      markPrice: Number(ctx.markPx ?? 0),
    };
  });
}

async function fetchLighter(): Promise<FundingRate[]> {
  const [detailsRes, fundingRes] = await Promise.all([
    fetch(`${LIGHTER_URL}/api/v1/orderBookDetails`).then((r) => r.json()),
    fetch(`${LIGHTER_URL}/api/v1/funding-rates`).then((r) => r.json()),
  ]);

  const idToMeta = new Map<number, { symbol: string; price: number }>();
  const details = (detailsRes as Record<string, unknown>).order_book_details ?? [];
  for (const m of details as Array<Record<string, unknown>>) {
    const marketId = Number(m.market_id);
    const sym = String(m.symbol ?? "");
    const price = Number(m.last_trade_price ?? 0);
    if (sym) idToMeta.set(marketId, { symbol: sym, price });
  }

  const rates: FundingRate[] = [];
  const fundingList = (fundingRes as Record<string, unknown>).funding_rates ?? [];
  for (const fr of fundingList as Array<Record<string, unknown>>) {
    const marketId = Number(fr.market_id);
    const symbol = String(fr.symbol ?? "") || idToMeta.get(marketId)?.symbol;
    if (!symbol) continue;
    rates.push({
      exchange: "lighter",
      symbol,
      fundingRate: Number(fr.rate ?? fr.funding_rate ?? 0),
      markPrice: idToMeta.get(marketId)?.price ?? 0,
    });
  }
  return rates;
}

// annualize: use computeAnnualSpread from funding.ts for cross-exchange comparison

export async function runFundingArb(
  adapters: Map<string, ExchangeAdapter>,
  params: FundingArbParams,
  jobId?: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const maxPos = params.maxPositions ?? 3;
  const closeSpread = params.closeSpread ?? 5;
  const positions: ArbPosition[] = [];
  let cycleCount = 0;
  let lastRebalanceCheck = 0;

  log(`[ARB] Funding rate arbitrage started`);
  log(`[ARB] Entry spread: >= ${params.minSpread}% | Close spread: <= ${closeSpread}%`);
  log(`[ARB] Size: ${params.size} | Interval: ${params.intervalSec}s`);
  log(`[ARB] Auto-execute: ${params.autoExecute} | Max positions: ${maxPos}`);
  log(`[ARB] Exchanges: ${[...adapters.keys()].join(", ")}`);
  if (params.autoRebalance) log(`[ARB] Auto-rebalance: ON (threshold: $${params.rebalanceThreshold ?? 100})`);
  if (params.maxDrawdown) log(`[ARB] Max drawdown: $${params.maxDrawdown}`);
  if (params.symbols?.length) log(`[ARB] Symbols: ${params.symbols.join(", ")}`);

  while (true) {
    cycleCount++;
    try {
      const rates = await fetchAllRates();

      // Group by symbol
      const rateMap = new Map<string, FundingRate[]>();
      for (const r of rates) {
        if (params.symbols?.length && !params.symbols.includes(r.symbol)) continue;
        if (!rateMap.has(r.symbol)) rateMap.set(r.symbol, []);
        rateMap.get(r.symbol)!.push(r);
      }

      // ── Phase 1: Check positions for close conditions ──
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        const symbolRates = rateMap.get(pos.symbol);
        if (!symbolRates) continue;

        const longRate = symbolRates.find((r) => r.exchange === pos.longExchange);
        const shortRate = symbolRates.find((r) => r.exchange === pos.shortExchange);
        if (!longRate || !shortRate) continue;

        const currentSpread = computeAnnualSpread(shortRate.fundingRate, shortRate.exchange, longRate.fundingRate, longRate.exchange);

        if (currentSpread <= closeSpread) {
          log(`[ARB] CLOSE signal: ${pos.symbol} spread ${currentSpread.toFixed(1)}% <= ${closeSpread}%`);

          if (params.autoExecute) {
            const longAdapter = adapters.get(pos.longExchange);
            const shortAdapter = adapters.get(pos.shortExchange);

            if (longAdapter && shortAdapter) {
              try {
                await Promise.all([
                  longAdapter.marketOrder(pos.symbol, "sell", pos.size),
                  shortAdapter.marketOrder(pos.symbol, "buy", pos.size),
                ]);
                log(`[ARB] CLOSED ${pos.symbol} — both legs unwound`);

                // Estimate P&L from funding collected
                const hoursOpen = (Date.now() - pos.openedAt) / (1000 * 60 * 60);
                // entrySpread is annualized %; convert to per-hour rate
                const hourlySpreadRate = pos.entrySpread / 100 / (24 * 365);
                const estimatedFunding = hourlySpreadRate * hoursOpen * Number(pos.size) * pos.entryPrices.long;
                log(`[ARB] Est. funding P&L: ~$${estimatedFunding.toFixed(2)} (${hoursOpen.toFixed(1)}h open)`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`[ARB] Close error: ${msg}`);
                continue; // don't remove position if close failed
              }
            }
          }

          positions.splice(i, 1);
        }
      }

      // ── Phase 2: Max drawdown check ──
      if (params.maxDrawdown && params.autoExecute && positions.length > 0) {
        try {
          const snapshots = await fetchAllBalances(adapters);
          const totalPnl = snapshots.reduce((s, e) => s + e.unrealizedPnl, 0);
          if (totalPnl < -params.maxDrawdown) {
            log(`[ARB] MAX DRAWDOWN hit: uPnL $${totalPnl.toFixed(2)} < -$${params.maxDrawdown}`);
            log(`[ARB] Closing all ${positions.length} positions...`);
            await closeAllPositions(positions, adapters, log);
            positions.length = 0;
          }
        } catch { /* non-critical */ }
      }

      // ── Phase 3: Balance check + rebalance trigger ──
      let balanceSnapshots: ExchangeBalanceSnapshot[] | null = null;
      const shouldCheckBalance = params.autoRebalance && (Date.now() - lastRebalanceCheck > 300_000); // every 5 min

      if (shouldCheckBalance || (params.autoExecute && positions.length < maxPos)) {
        try {
          balanceSnapshots = await fetchAllBalances(adapters);
          lastRebalanceCheck = Date.now();

          if (params.autoRebalance) {
            const threshold = params.rebalanceThreshold ?? 100;
            const lowExchanges = balanceSnapshots.filter((s) => s.available < threshold);
            if (lowExchanges.length > 0) {
              const plan = computeRebalancePlan(balanceSnapshots, { minMove: 50, reserve: 20 });
              if (plan.moves.length > 0) {
                log(`[ARB] Rebalance needed: ${plan.summary}`);
                for (const move of plan.moves) {
                  log(`[ARB]   $${move.amount} ${move.from} → ${move.to}`);
                }
                log(`[ARB] Run 'perp rebalance execute' to rebalance.`);
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // ── Phase 4: Find new entry opportunities ──
      if (positions.length < maxPos) {
        for (const [symbol, symbolRates] of rateMap) {
          if (symbolRates.length < 2) continue;
          if (positions.find((p) => symbolMatch(p.symbol, symbol))) continue;
          if (positions.length >= maxPos) break;

          // Only consider exchanges we have adapters for
          const available = symbolRates.filter((r) => adapters.has(r.exchange));
          if (available.length < 2) continue;

          available.sort((a, b) => a.fundingRate - b.fundingRate);
          const lowest = available[0];
          const highest = available[available.length - 1];
          if (lowest.exchange === highest.exchange) continue;

          const annualSpread = computeAnnualSpread(highest.fundingRate, highest.exchange, lowest.fundingRate, lowest.exchange);

          if (annualSpread >= params.minSpread) {
            const longEx = lowest.exchange;
            const shortEx = highest.exchange;

            log(`[ARB] ENTRY signal: ${symbol} spread ${annualSpread.toFixed(1)}% — long ${longEx} (${(lowest.fundingRate * 100).toFixed(4)}%) / short ${shortEx} (${(highest.fundingRate * 100).toFixed(4)}%)`);

            if (params.autoExecute) {
              const longAdapter = adapters.get(longEx);
              const shortAdapter = adapters.get(shortEx);

              if (!longAdapter || !shortAdapter) {
                log(`[ARB] Skip: adapter not available for ${longEx} or ${shortEx}`);
                continue;
              }

              // Check orderbook liquidity & adjust size
              const requestedUsd = params.sizeUsd ?? Number(params.size) * highest.markPrice;
              const liq = await checkArbLiquidity(longAdapter, shortAdapter, symbol, requestedUsd, 0.5, log);
              if (!liq.viable) continue;

              // Compute matched size (same for both legs)
              const matched = computeMatchedSize(liq.adjustedSizeUsd, highest.markPrice, longEx, shortEx);
              if (!matched) {
                log(`[ARB] Skip ${symbol}: can't compute matched size (min notional or precision issue)`);
                continue;
              }

              // Check balances before trading
              if (balanceSnapshots) {
                if (!hasEnoughBalance(balanceSnapshots, longEx, matched.notional) ||
                    !hasEnoughBalance(balanceSnapshots, shortEx, matched.notional)) {
                  log(`[ARB] Skip ${symbol}: insufficient balance on ${longEx} or ${shortEx} (need ~$${matched.notional.toFixed(0)} per leg)`);
                  continue;
                }
              }

              try {
                log(`[ARB] Opening: ${matched.size} ${symbol} on both legs ($${matched.notional.toFixed(0)}/leg, slippage ~${liq.longSlippage.toFixed(2)}%/${liq.shortSlippage.toFixed(2)}%)...`);
                await Promise.all([
                  longAdapter.marketOrder(symbol, "buy", matched.size),
                  shortAdapter.marketOrder(symbol, "sell", matched.size),
                ]);

                // Verify fills match, correct if needed
                try {
                  const recon = await reconcileArbFills(longAdapter, shortAdapter, symbol, log);
                  if (!recon.matched) {
                    log(`[ARB] WARNING: fills not matched after correction attempt`);
                  }
                } catch { /* non-critical */ }

                positions.push({
                  symbol,
                  longExchange: longEx,
                  shortExchange: shortEx,
                  size: matched.size,
                  entrySpread: annualSpread,
                  openedAt: Date.now(),
                  entryPrices: { long: lowest.markPrice, short: highest.markPrice },
                });

                log(`[ARB] OPENED ${symbol} delta-neutral (${positions.length}/${maxPos})`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`[ARB] Entry error: ${msg}`);
              }
            }
          }
        }
      }

      // ── Update job state ──
      if (jobId) {
        updateJobState(jobId, {
          result: {
            cycle: cycleCount,
            activePositions: positions.length,
            positions: positions.map((p) => ({
              symbol: p.symbol,
              long: p.longExchange,
              short: p.shortExchange,
              size: p.size,
              entrySpread: p.entrySpread,
              hoursOpen: ((Date.now() - p.openedAt) / 3_600_000).toFixed(1),
            })),
            lastCheck: new Date().toISOString(),
          },
        });
      }

      // Periodic status log
      if (cycleCount % 10 === 0) {
        const posInfo = positions.length > 0
          ? positions.map((p) => `${p.symbol}(${p.entrySpread.toFixed(0)}%)`).join(", ")
          : "none";
        log(`[ARB] Cycle ${cycleCount} | ${positions.length} positions: ${posInfo} | ${rateMap.size} symbols`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[ARB] Cycle error: ${msg}`);
    }

    await sleep(params.intervalSec * 1000);
  }
}

async function closeAllPositions(
  positions: ArbPosition[],
  adapters: Map<string, ExchangeAdapter>,
  log: (msg: string) => void,
): Promise<void> {
  for (const pos of positions) {
    const longAdapter = adapters.get(pos.longExchange);
    const shortAdapter = adapters.get(pos.shortExchange);
    if (!longAdapter || !shortAdapter) continue;

    try {
      await Promise.all([
        longAdapter.marketOrder(pos.symbol, "sell", pos.size),
        shortAdapter.marketOrder(pos.symbol, "buy", pos.size),
      ]);
      log(`[ARB] Emergency closed ${pos.symbol}`);
    } catch (err) {
      log(`[ARB] Failed to close ${pos.symbol}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
