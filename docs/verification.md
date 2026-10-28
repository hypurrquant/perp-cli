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

RISEx, Variational, GRVT and Extended are not in this table: none trades in this release. RISEx trading (shipped but disabled since 0.15.0) was exercised on **testnet** only (2026-10-14); no mainnet RISEx order has been run.

**TxFlow** trading is on since 2026-10-28 and was verified on **testnet** only (2026-10-27, `-n testnet`):

- `wallet agent approve txflow`;
- limit order, read back by client id, `trade edit` (modify2), cancel, cancel-all;
- market order (IOC), `trade close`, `flatten`;
- `trade leverage` with cross ↔ isolated (read back with `activeAssetData`), and an isolated position opened and closed;
- stops (market, limit, and a stop that opens a position) and their cancel;
- the TP/SL pair (`trade tpsl`: one `positionTpsl` action, cancelled as a pair) and an entry with `--tp` / `--sl`;
- the price-band refusal (300 bps refused; the error names the largest slippage bound that fits, 200 bps);
- orders without a builder code (none is required).

No mainnet TxFlow order has been run: mainnet `/exchange` is open to whitelisted accounts only (apply at txflow.com/apply).

The original TxFlow testnet checklist, kept for the mainnet run:

1. `wallet agent approve txflow`: the label is accepted, `agentOwner` shows the agent; `--rotate` rebinds the label; `revoke` frees it.
2. Where the `/exchange` reply echoes `confirm: "executed"` (top level or `data.confirm`; without it every write reads as unknown).
3. The order's client id (`cloid`) and `timestamp` come back on `frontendOpenOrders` / `historicalOrders`, within 30 s of the local clock.
4. A market trigger: is `p` (trigger ± slippage bound) the limit of the fired market order?
5. `normalTrigger` takes a single trigger; triggers are listed in `frontendOpenOrders` or `triggerOrders`; cancel with `grouping: trigger` / `tpsl`.
6. Record a `historicalTriggerOrders` row and check that it has `timestamp` / `createTime` (the client-id match window needs one) and the `triggerState` strings.
7. `m` (`cross` / `isolated`) is accepted as sent; `orderDetails` covers cancelled orders.
8. Market IOC inside the 5% oracle band; `modify2`; `updateLeverage` / `updateMarginMode` (and the `activeAssetData` casing).
9. The HTTP status and text of a rejection (e.g. off-tick), the mainnet whitelist refusal and "deposit first"; an `err` body below HTTP 500 is treated as a definite refusal.
10. `frontendOpenOrders` paging: the page size the server really serves for `limit: 500`.
11. Whether `approveBuilderFee` is required before trading (perp-cli attaches no builder).

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
