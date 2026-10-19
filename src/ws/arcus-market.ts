/**
 * Arcus GET /v1/markets eligibility — the one rule for every Arcus surface (WS directory, CLI
 * adapter market-data reads, public market data / funding / arb, MCP): a market is listed only
 * while `status` is "ONLINE". OFFLINE markets (live 2026-10-19: F, BAC, CCL, VT, SGOV, RVI-USD —
 * 6 of 70) publish placeholder zeros for mark / index / rate / OI / volume, never real values.
 */
export function isArcusOnlineMarket(row: { status?: unknown }): boolean {
  return row.status === "ONLINE";
}
