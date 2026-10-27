/**
 * TxFlow release switch (the RISEx pattern, risex-release.ts).
 *
 * TxFlow trading (agent-signed orders, cancels, amend, stops / TP / SL, leverage, agent approve /
 * import / revoke) is implemented but not yet verified against the venue, so it ships switched
 * OFF: the venue keeps market data and account reads (unsigned reads by the account address), and
 * every trading / agent write refuses with CAPABILITY_UNSUPPORTED through the role mechanism
 * (venue.ts roleUnsupported(), TXFLOW_TRADING_GATE). Turning it on is this one line.
 * The trading code and its tests stay; those tests enable the switch with
 * `vi.mock(".../venues/txflow-release.js", () => ({ TXFLOW_TRADING_ENABLED: true }))`.
 * Kept in its own module so tests can mock it without replacing the venue definition.
 */
export const TXFLOW_TRADING_ENABLED: boolean = false;
