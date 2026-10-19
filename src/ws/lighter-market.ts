/**
 * Lighter / Lighter RH market eligibility — the ONE rule for every Lighter surface (WS directory,
 * CLI adapter `market list|prices|info`, public data `tradable`): a market is live when its
 * `/api/v1/orderBooks` / `/api/v1/orderBookDetails` row has `status: "active"` (OpenAPI enum
 * "active" | "inactive") and is not `is_frozen`.
 *
 * Live 2026-10-19 (mainnet): orderBookDetails lists 239 perps (213 active, 26 inactive) and
 * orderBooks 235 (213 active, 22 inactive). The four perps only in orderBookDetails (MYX, RESOLV,
 * MKR, DOLO) are all inactive, so both endpoints give the same 213 live perps under this rule.
 */
export function isLighterMarketLive(row: { status?: unknown; is_frozen?: unknown }): boolean {
  return row.status === "active" && row.is_frozen !== true;
}
