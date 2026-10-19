/**
 * Aster GET /fapi/v3/exchangeInfo market eligibility — the one rule for every Aster surface (WS
 * directory, CLI adapter, public market data / funding / arb, MCP): a market is listed only while
 * `contractType` is "PERPETUAL" and `status` is "TRADING". Live 2026-10-19: TRADING/PERPETUAL 605,
 * SETTLING/PERPETUAL 23 (being delisted: TONUSDT, IRUSDT, …), PENDING_TRADING with contractType ""
 * 6 (MBLUSDT, AFEEUSDT, …) — neither of the latter two streams or trades.
 *
 * The quote asset is NOT part of eligibility: USD1 / U quoted perps are live markets, listed by
 * every surface (asterCliSymbol gives the CLI symbol, asterMatchable whether it gets a canonical).
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

/**
 * Whether a listed Aster market may carry a cross-venue canonical (then `base`): only its USDT
 * market. USD1 / U quoted ones (BTCUSD1, GPROUSD1, BTCU) are listed but never matched across
 * venues — so `arb` (scan / auto / exec) never takes one as a leg: Aster arb sizing, margin checks
 * and transfers are USDT-collateral, and a USD1 / U margined leg is not handled.
 */
export function asterMatchable(row: { quoteAsset?: unknown }): boolean {
  return row.quoteAsset === "USDT";
}
