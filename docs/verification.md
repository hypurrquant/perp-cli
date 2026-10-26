# Mainnet verification (2026-10-13)

[← README](../README.md) · What has actually been run with real money. For what perp-cli *offers*, see the [support matrix](venues.md#support-matrix).

Every mark below comes from a real-money mainnet run, not from code reading — at the venue minimum, with the per-venue cap raised to about $25–30 for multi-slice / multi-level checks and about $110 for the Hyperliquid TWAP.

✅ verified live · ⛔ not supported (refused before anything is sent) · ❌ implemented but not run on mainnet yet · — not offered by the venue

| Feature | HL | HIP-3 `xyz` | Pacifica | Lighter | Lighter RH | Aster | Ondo | Arcus | QFEX |
|---|---|---|---|---|---|---|---|---|---|
| Market / limit (GTC, ALO, IOC), cancel, edit, close, reduce, flatten, status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Entry `--tp/--sl`, `trade tpsl`, `trade stop` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stop-limit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ |
| Resting reduce-only limit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ (IOC only) |
| Client order id (place / status / cancel) | ✅ | ✅ | ✅³ (UUID) | ✅ (numeric) | ✅ (numeric) | ✅ | ✅ | ✅ | generated ids only |
| Isolated margin (set, read back with a position, revert) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (venue rejected with `-4050`, condition unknown) | ⛔ | ✅ | ⛔ |
| `trade scale-in` / `scale-tp` | ✅ | ✅ (position ≥ $20.5) | ✅ | ✅ | ✅ | ✅ | scale-in ✅ / scale-tp ⛔ — use partial `trade tpsl --size` ✅ | ✅ | scale-in ✅ / scale-tp ⛔ |
| `trade split` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `trade multi` (legs on several venues) | ✅ | ✅ (global `--dex xyz`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Native TWAP (`trade twap`) | ✅ | ❌ (HL minimum $100) | ✅ master-signed / ⛔ agent-signed | —² | —² | —² | —² | —² | —² |
| Client-side TWAP (`trade twap` on other venues, `strategy twap`, `--background`) | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ (automation gate) |
| `account margin` with a position | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Spot (`trade spot-*`) | ✅ | — | ✅ | ✅ | ✅ | ❌ (needs USDT) | ✅ | ❌ (needs an Arcus-issued key) | — |
| Deposit via perp-cli | ✅ | (HL) | ✅ | ✅ | ✅ | ✅ | ✅ | — (web app) | — (address only) |
| Withdraw (to your own address)⁶ | ✅ | (HL) | ✅ | ✅ | ✅ | ✅ (`--asset USDC`) | ⛔⁴ | ✅ | ⛔⁵ |

RISEx, TxFlow, Variational, GRVT and Extended are not in this table: none trades in this release. RISEx trading (shipped but disabled since 0.15.0) was exercised on **testnet** only (2026-10-14); no mainnet RISEx order has been run.

² perp-cli has no native TWAP for this venue: `trade twap` runs the client-side TWAP (slices) instead. Whether the venue's API offers one is not checked.  
³ Verified in the session; no saved log file.  
⁴ Not available: the Ondo Perps API does not allow withdrawals (`funds withdraw ondo` → `CAPABILITY_UNSUPPORTED`). Withdraw in the Ondo web app.  
⁵ Disabled in perp-cli for now (`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`). Withdraw in the QFEX web app.  
⁶ Mainnet, 2026-10-13: one withdrawal per venue to the account's own address, received amount checked on the destination chain — `funds withdraw hyperliquid 12.22` (Arbitrum USDC), `funds withdraw pacifica 12.98` (Solana USDC), `-e lighter funds withdraw lighter 15.95` (Ethereum USDC), `-e lighter-rh funds withdraw lighter 12.96` and `funds withdraw arcus 9.94` (Robinhood Chain USDG), `funds withdraw aster 8.74 --chain arbitrum --asset USDC` (Arbitrum USDC).

Automation, verified live (bounded runs at minimum size, stopped and flattened afterwards):

| Area | Verified |
|---|---|
| Arbitrage | `arb exec` / `status` / `close` on Aster–Arcus, Lighter–Arcus; `arb auto` (Lighter–HL); spot-perp `arb exec <sym> spot:hl pacifica` and `arb close`; `strategy funding-arb`, `quick-arb`, `funding-auto` (Pacifica–HL); `strategy delta-neutral` (HL spot + Pacifica perp) |
| Bots | `strategy grid` / `dca` / `trailing-stop` / `quick-grid` / `quick-dca` / `preset` (Aster); all 12 engine strategies via `strategy start <config>` (Aster); `strategy apex` (Aster) |
| Execution helpers | `strategy twap` (Aster), `trade twap --background` (Arcus), `strategy plan execute` (9 of 10 action types — `cancel_order` not run), `perp background stop` (graceful: orders cancelled, positions listed) |
| Hyperliquid HIP-4 outcomes | GTC place / cancel, IOC buy, `outcome sell --all` / `--size` |

Funds and bridge, verified live (mainnet, 2026-10-13 — `funds bridge send` runs, `funds rebalance plan` + `execute --withdraw-only` after a $11 HL deposit, alerts rule commands without a channel):

| Area | Verified | Not verified |
|---|---|---|
| `funds bridge send` | deBridge Arbitrum → Solana USDC (OWS-signed); Relay swaps Arbitrum ETH → Robinhood ETH, Robinhood USDG → Solana SOL / USDC, Robinhood USDG → Arbitrum USDC | CCTP routes; any **Solana-source** bridge (the OWS Solana signing path is covered by mocked tests only) |
| `funds bridge exchange` | — | everything; the HyperCore → Solana CCTP route (`--from hyperliquid --to pacifica`) is suspected broken (Solana recipient encoding) |
| `funds rebalance` | `plan`; `execute --withdraw-only` (HL → Arbitrum) | `execute --auto-bridge` (no gas pre-check yet) |
| `funds transfer` | — | HL `usdSend`, QFEX account transfer (need a receiving account) |
| alerts | rule `add` / `list` / `remove`; `test` / `start` refuse without a channel | Telegram / Discord delivery (needs a bot token) |

Not run on mainnet yet: subaccounts, builder fees, `strategy claude-agent` (needs an Anthropic key), dashboard.
