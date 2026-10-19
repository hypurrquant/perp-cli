/**
 * Aster GET /fapi/v3/exchangeInfo market eligibility — the one rule for every Aster surface (WS
 * directory, CLI adapter, public market data / funding / arb, MCP): a market is listed only while
 * `contractType` is "PERPETUAL" and `status` is "TRADING". Live 2026-10-19: TRADING/PERPETUAL 605,
 * SETTLING/PERPETUAL 23 (being delisted: TONUSDT, IRUSDT, …), PENDING_TRADING with contractType ""
 * 6 (MBLUSDT, AFEEUSDT, …) — neither of the latter two streams or trades.
 *
 * The quote asset is NOT part of eligibility: USD1 / U quoted perps are live markets, listed by
 * every surface (asterCliSymbol / asterListedCanonical give their CLI symbol and canonical).
 */
export function isAsterListedPerpetual(row: { contractType?: unknown; status?: unknown }): boolean {
  return row.contractType === "PERPETUAL" && row.status === "TRADING";
}

/**
 * CLI symbol of a listed Aster perpetual: the base for the USDT-quoted market (ETHUSDT → ETH, the
 * venue's main listing), the venue symbol for any other quote (BTCUSD1, BTCU) — unique per market
 * and passed to the venue as is.
 */
export function asterCliSymbol(row: { symbol: string; baseAsset: string; quoteAsset?: unknown }): string {
  return row.quoteAsset === "USDT" ? row.baseAsset : row.symbol;
}

/** Quotes a USD-quoted canonical may come from (Aster "U" is not one: its markets are canonical null). */
const ASTER_USD_QUOTES: ReadonlySet<string> = new Set(["USDT", "USD1"]);

/**
 * Whether a listed Aster market may carry a cross-venue canonical (then `base`): its quote is USD
 * (USDT / USD1) and it is the only such listing of its base, the USDT one first (BTCUSD1 next to
 * BTCUSDT → not matchable, so a base is never two rows of one venue in a comparison).
 */
export function asterMatchable(row: { baseAsset: string; quoteAsset?: unknown }, listed: ReadonlyArray<{ baseAsset: string; quoteAsset?: unknown }>): boolean {
  if (typeof row.quoteAsset !== "string" || !ASTER_USD_QUOTES.has(row.quoteAsset)) return false;
  if (row.quoteAsset === "USDT") return true;
  return !listed.some(o => o.baseAsset === row.baseAsset && o.quoteAsset === "USDT");
}
