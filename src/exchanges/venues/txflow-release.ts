/**
 * TxFlow release switch (the RISEx pattern, risex-release.ts).
 *
 * Trading on (owner request 2026-10-28): agent-signed orders, cancels, amend, stops / TP / SL,
 * leverage, agent approve / import / revoke — verified on testnet 2026-10-27/28; no mainnet TxFlow
 * order has been run yet (mainnet needs a whitelisted account; see docs/verification.md).
 *
 * false removes the "trading" role from the TxFlow venue definition (txflow.ts): every trading /
 * agent write refuses with CAPABILITY_UNSUPPORTED through the role mechanism (venue.ts
 * roleUnsupported(), TXFLOW_TRADING_GATE), and market data and account reads keep working.
 * The gate stays tested: txflow.test.ts mocks the switch off; the trading tests mock it on.
 * Kept in its own module so tests can mock it without replacing the venue definition.
 */
export const TXFLOW_TRADING_ENABLED: boolean = true;
