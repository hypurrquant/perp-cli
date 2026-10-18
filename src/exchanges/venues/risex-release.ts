/**
 * RISEx release switch (owner decision 2026-10-19: new venues ship in phases).
 *
 * Phase 1 (0.15.0): RISEx is read-only — market data and public-by-address account reads.
 * Phase 2 (a later release): trading. Flip this to `true`; nothing else needs to change.
 *
 * false removes the "trading" role from the RISEx venue definition (risex.ts), so every trading /
 * signer / agent / bot / MCP-write path refuses with CAPABILITY_UNSUPPORTED through the role
 * mechanism (venue.ts roleUnsupported()), and the adapter refuses writes itself as well.
 * The trading code and its tests stay; those tests enable the switch with
 * `vi.mock(".../venues/risex-release.js", () => ({ RISEX_TRADING_ENABLED: true }))`.
 * Kept in its own module so tests can mock it without replacing the venue definition.
 */
export const RISEX_TRADING_ENABLED: boolean = false;
