/**
 * Aster GET /fapi/v3/exchangeInfo market eligibility — the one rule for every Aster surface (WS
 * directory, CLI adapter, public market data / funding / arb, MCP): a market is listed only while
 * `contractType` is "PERPETUAL" and `status` is "TRADING". Live 2026-10-19: TRADING/PERPETUAL 605,
 * SETTLING/PERPETUAL 23 (being delisted: TONUSDT, IRUSDT, …), PENDING_TRADING with contractType ""
 * 6 (MBLUSDT, AFEEUSDT, …) — neither of the latter two streams or trades.
 *
 * The quote asset is NOT part of eligibility: USD1 / U quoted perps are live markets. The CLI
 * adapter and the public directory additionally list only USDT-quoted ones because the CLI symbol
 * mapping (ETH ↔ ETHUSDT) cannot address the others; the WS directory streams them with
 * canonical null.
 */
export function isAsterListedPerpetual(row: { contractType?: unknown; status?: unknown }): boolean {
  return row.contractType === "PERPETUAL" && row.status === "TRADING";
}
