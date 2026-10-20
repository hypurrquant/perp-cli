/**
 * Unknown-symbol handling shared by the adapters' public market-data reads.
 *
 * Several venues answer a read for a market they do not list with an empty success
 * (Pacifica /trades, /kline, /funding_rate/history; Ondo /v1/perps/trades and candles; Aster
 * /fapi/v3/fundingRate — all `200 []`, live 2026-10-14). An empty list must not stand for
 * "no such market": after an empty answer the symbol is checked against the venue's own market
 * directory (getMarkets) — SYMBOL_NOT_FOUND when it is not listed, the empty list when it is
 * (a listed market with no trades / candles in the window is a real empty result).
 */

import { PerpError, classifyError } from "../errors.js";
import type { ExchangeMarketInfo } from "./interface.js";

/** SYMBOL_NOT_FOUND for `symbol` on `venue`, with the listing command as remediation. */
export function symbolNotFound(venue: string, symbol: string, message?: string): PerpError {
  return new PerpError("SYMBOL_NOT_FOUND", message ?? `${venue} has no market ${symbol.toUpperCase()}`, {
    exchange: venue,
    remediation: `List markets: perp -e ${venue} market list`,
  });
}

/**
 * Directory match on the exact wire symbol (case-sensitive), a "-PERP" display suffix ignored on
 * either side. Case-sensitive on purpose: the venues are (Pacifica `KPEPE` answers `200 []` where
 * `kPEPE` has rows), so a casing miss must be SYMBOL_NOT_FOUND, never "no data". The adapter
 * resolves the typed symbol to the venue's spelling before the request.
 */
export function listsSymbol(markets: readonly Pick<ExchangeMarketInfo, "symbol">[], symbol: string): boolean {
  const norm = (s: string) => s.replace(/-PERP$/i, "");
  const want = norm(symbol);
  return markets.some(m => norm(m.symbol) === want);
}

/**
 * `rows` as returned by the venue, unless they are empty and the market is not in the venue's
 * market directory — then SYMBOL_NOT_FOUND. The directory is read only for an empty answer.
 *
 * `directorySymbol` is the symbol in the directory's form, derived by the adapter from what the
 * user typed (Ondo "TSLA-USD.P" → "TSLA", Aster "BTCUSDT" → "BTC"); `symbol` is kept for messages.
 * A failed directory read is re-thrown with its code (and so its retryable flag), saying what was
 * being checked — never turned into SYMBOL_NOT_FOUND or an empty result.
 */
export async function nonEmptyOrListed<T>(
  adapter: { readonly name: string; getMarkets(): Promise<Pick<ExchangeMarketInfo, "symbol">[]> },
  symbol: string,
  rows: T[],
  directorySymbol: string = symbol,
): Promise<T[]> {
  if (rows.length > 0) return rows;
  let markets: Pick<ExchangeMarketInfo, "symbol">[];
  try {
    markets = await adapter.getMarkets();
  } catch (e) {
    const c = classifyError(e, adapter.name);
    throw new PerpError(c.code, `${adapter.name}: ${symbol} returned no rows and the market list could not be read to check the symbol — ${c.message}`, {
      exchange: adapter.name,
      ...(c.remediation !== undefined ? { remediation: c.remediation } : {}),
    });
  }
  if (!listsSymbol(markets, directorySymbol)) throw symbolNotFound(adapter.name, symbol);
  return rows;
}
