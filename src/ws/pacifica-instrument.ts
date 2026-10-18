/**
 * Pacifica GET /info `instrument_type` (docs.pacifica.fi get-market-info; live: "perpetual" / "spot").
 * The one perp rule for every Pacifica surface (WS directory, CLI adapter, funding, arb): only
 * "perpetual" rows are perps — spot (SOL-USDC) and any other / future type are not.
 */
export function isPacificaPerpetual(row: { instrument_type?: unknown }): boolean {
  return row.instrument_type === "perpetual";
}
