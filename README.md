# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

Multi-DEX perpetual futures CLI — **Pacifica** (Solana), **Hyperliquid** (HyperEVM), **Lighter** (Ethereum), **Aster** (BNB Chain), **Lighter RH** (Robinhood chain), **Ondo Perps** (off-chain), **Arcus** (Robinhood chain), **QFEX** (off-chain, TradFi perps), **RISEx** (RISE chain — read-only; trading planned, not yet available), **TxFlow** (market data only — unofficial API), **Variational Omni** (market data only — official API, RFQ venue), **GRVT** (market data only — official API; trading planned, not yet available), **Extended** (Starknet, market data only — official API; trading planned, not yet available), and **Derive** options data (read-only).

```bash
npm install -g perp-cli       # global install
perp --json portfolio

# Or without global install (restricted environments)
npx -y perp-cli --json portfolio
```

The package ships **three** executables (`package.json` `bin`):

| Binary | What it is | Docs |
|---|---|---|
| `perp` | the CLI | [Command Groups](#command-groups), [Core Commands](#core-commands) |
| `perp-mcp` | the MCP server (stdio) for Claude Desktop, Cursor and other MCP clients | [MCP Server](#mcp-server) |
| `perp-guardrail` | the OWS Policy Engine checker that approves or denies an agent key's signature requests | [Signing guardrail](#signing-guardrail-perp-guardrail) |

## Features

- **13 perp venues** — trade on 8: Pacifica, Hyperliquid, Lighter, Aster, Lighter RH, Ondo Perps, Arcus, QFEX (bridge / perp-perp arb cover the original four); market data on RISEx (read-only; trading planned, not yet available) TxFlow (unofficial API, read-only), Variational (official API, read-only — no public trading API yet) GRVT (official API, read-only — trading planned, not yet available) and Extended (official API, read-only — trading planned, not yet available); plus **Derive** options data (read-only). See the [support matrix](#support-matrix)
- **Funding Rate Arb** — perp-perp + spot-perp scan & one-command dual-leg execution
- **Portfolio** — single call returns balances, positions, risk level across all exchanges
- **Funds** — deposit, withdraw, transfer, multi-provider bridge (cctp/relay/debridge), inter-exchange rebalance — all in one group
- **Bots** — TWAP, grid, DCA, trailing-stop with background job management
- **Agent-First Design** — `--json`, `--fields`, `--ndjson`, `--dry-run`, runtime schema introspection
- **Safety** — pre-trade validation, response sanitization, client-id deduplication

## Support matrix

What each venue supports in this release, derived from the code (venue definitions in `src/exchanges/venues/*.ts`, `perp-cli/ws` codecs in `src/ws/codecs/`, the `funds deposit|withdraw` commands, the options registry). ✅ = implemented and available; — = not available. This says what perp-cli **offers**, not what was run with real money — for that see [What works — mainnet verification](#what-works--mainnet-verification-2026-10-13).

| Venue | Market data (CLI) | Funding | WS stream (`perp-cli/ws`) | Positions by address (`--address`) | Trading | Deposit via perp-cli | Withdraw via perp-cli | Extras | API |
|---|---|---|---|---|---|---|---|---|---|
| Hyperliquid (incl. HIP-3 via `--dex`) | ✅ | ✅ hourly | ✅ public + user (HIP-3 dexes opt-in) | ✅ (native + every HIP-3 dex) | ✅ | ✅ (USDC from Arbitrum) | ✅ (CCTP) | spot, outcomes (HIP-4), native TWAP | official |
| Pacifica | ✅ | ✅ hourly | ✅ public + user | ✅ (Solana address) | ✅ | ✅ | ✅ | spot (unified margin), native TWAP (master-signed only); Print (`perp print`), Vaults (`perp vault`; deposit master-only) and Atomic basket (`trade atomic`) — each not yet verified live; legacy `wallet manage lake`: `create` still works, `deposit` / `withdraw` refuse and point to `perp vault` | official |
| Lighter | ✅ | ✅ hourly | ✅ public + user | ✅ (every sub-account) | ✅ | ✅ (L1 or CCTP) | ✅ | spot, client-side TWAP | official |
| Lighter RH | ✅ | ✅ hourly | ✅ public + user (mainnet; testnet WS → HTTP 403) | ✅ (every sub-account) | ✅ | ✅ (USDG, mainnet) | ✅ (`-e lighter-rh funds withdraw lighter`) | spot, client-side TWAP | official |
| Aster | ✅ | ✅ per symbol | ✅ public only (user channels: known gap) | — | ✅ | ✅ (USDT / USDC, mainnet) | ✅ (agent with `--can-withdraw --ip-whitelist`) | spot, client-side TWAP | official |
| Ondo Perps | ✅ | ✅ hourly | — | — | ✅ | ✅ (USDC, mainnet) | — (the API allows none; web app)⁴ | spot, client-side TWAP | official |
| Arcus | ✅ | ✅ hourly | ✅ public + user | — | ✅ | — (web app) | ✅ (to the account owner) | spot (on-chain swaps), client-side TWAP | official |
| QFEX | ✅ | unverified (display only, `--include-unverified`) | — | — | ✅ (no resting reduce-only, no automation — see [QFEX](#qfex)) | address only | — (disabled for now; web app)⁵ | — | official |
| RISEx | ✅ | ✅ hourly | — | ✅ | — (**read-only**; trading planned, not yet available) | — (app only) | — (app only) | account reads by address | official |
| TxFlow | ✅ | unverified (display only, `--include-unverified`) | — | — | — (market data only) | — | — | — | **unofficial** |
| Variational | ✅ (`market book` = RFQ quotes, not an order book) | unverified (display only, `--include-unverified`); interval per market (1h / 4h / 8h) | — | — | — (market data only) | — | — | equities / ETFs / commodities; pre-IPO (not matched) | official |
| GRVT | ✅ | unverified (display only, `--include-unverified`); interval per market (4h / 8h) | — (per-instrument streams only) | — | — (market data only in this version; trading planned, not yet available) | — | — | equities / ETFs, commodities; pre-IPO not matched | official |
| Extended | ✅ (crypto plus equities / ETFs / commodities / indices / FX) | unverified (display only, `--include-unverified`), hourly; `_24_5` equities print 0 off-hours | — (one socket per stream; not supported yet) | — | — (read-only) | — | — | asset-class column; pre-IPO and ambiguous tickers not matched | official |
| Derive | options only (`perp -e derive options …`) | — | — | — | — (**read-only**; trading planned, not yet available) | — | — | options: underlyings, expiries, chain (IV, greeks), quote | official |

- **Funding** ✅ = the rate's unit is verified against settled payments (`fundingVerified`), so the venue takes part in `arb scan` and funding strategies; unverified venues are shown only with `--include-unverified`, never ranked or traded.
- **WS stream** = `perp-cli/ws` / `@hypurrquant/perp-ws` channels: public = all-market / per-market state and `bbo`; user = account, positions, orders, fills. `book` / `trades` channels are not available yet on any venue.
- **Positions by address** = `perp -e <venue> account positions --address <addr>` (no `-e`: every venue below) and MCP `get_positions_by_address`: the open positions of ANY account from public venue data — keyless, nothing signed. 0x address except Pacifica (base58 Solana); other venues refuse with `CAPABILITY_UNSUPPORTED`.
- **Client-side TWAP** = `trade twap` / `strategy twap` slicing on venues without a native TWAP (refused on QFEX by its automation gate).

## Setup

```bash
# Import an exchange key into the encrypted OWS vault and make it the active wallet.
# The key is read from a hidden prompt or stdin — never argv (shell history), never ~/.perp/.env.
perp wallet set hl                   # Hyperliquid (EVM) — hidden prompt
pbpaste | OWS_PASSPHRASE="$PP" perp wallet set pac --name pac   # Pacifica (Solana) — piped
# The active wallet serves every venue; one EVM key covers HL / Lighter / Aster.
# Lighter trading also needs: perp wallet agent approve lighter

# Or the interactive setup wizard (every trading venue): picks / creates / imports an OWS
# vault wallet, network, venues, registers agent wallets (y/N confirmation before
# any signature — never moves funds), explains + sets the slippage bound, and the
# default venue. It never writes keys to ~/.perp/.env.
perp setup

# Scriptable (CI / agents) — writes settings only, signs nothing:
perp --json setup --non-interactive --wallet <ows-wallet> --venues hyperliquid,aster \
  --network testnet --default-venue hyperliquid --slippage-bps 50 --slippage aster=80
# Add agent registration explicitly (Ondo key id + secret via stdin only):
OWS_PASSPHRASE=<pp> perp --json setup --non-interactive --wallet <ows-wallet> \
  --venues hyperliquid,arcus --approve-agents --yes --arcus-account-index 0

# Verify
perp wallet show
```

Same EVM key works for both Hyperliquid and Lighter.

> **Lighter API Key Index:** Indexes 0–3 are reserved by Lighter's frontend (web/mobile). perp-cli defaults to index `4`. Override with `LIGHTER_API_KEY_INDEX` env var, or use `perp wallet agent approve lighter --api-key-index <n>` for managed agent slots. Valid range: 4–254.

### Lighter RH, Ondo Perps, Arcus

These venues have no `wallet set` private-key path — register an agent / API key instead:

```bash
perp wallet agent approve lighter-rh                  # Lighter RH L2 slot key (USDG collateral, Robinhood chain)
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent approve ondo   # Ondo HMAC key id + secret, stdin only
perp wallet agent approve arcus --master <ows-wallet> # Arcus Ed25519 API key (OWS wallet agent-arcus-<master>)
perp wallet agent verify [lighter-rh|ondo|arcus]      # no venue = verify every configured venue
```

### No master wallet on this computer — import a key created on the exchange website

Create the agent / API key on the venue's website, then import it. The master wallet never has to be
on this machine; it is identified only by its public address. The key is read from a hidden prompt or
stdin (never argv) and **checked against the venue before anything is stored** — a refused check stores
nothing; a venue that cannot be checked without the master is reported as `unverified`, never as verified.

```bash
perp -n testnet wallet agent import hyperliquid                    # API wallet key; master read from HL (userRole)
pbpaste | perp wallet agent import aster --master-address 0xYOU     # signer key; signed /fapi/v3/balance check (works on Aster testnet too)
perp wallet agent import pacifica --master-address <SOL account>   # agent key; UNVERIFIED (Pacifica lists bindings only master-signed)
perp wallet agent import lighter --account-index 123 --api-key-index 5   # slot key; auth token accepted for that slot
perp wallet agent import arcus --master-address 0xOWNER            # Ed25519 key; public key listed ACTIVE for the owner
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent import ondo
printf '%s\n%s\n' "$PUBLIC_KEY" "$SECRET" | perp wallet agent import qfex --account-id <uuid>   # QFEX: import only (keys are created on the website, 2FA)
perp wallet agent list                                              # SOURCE column: approved | imported

# Setup without any master wallet: one stdin line per --import-agents venue, in order (ondo: 2 lines)
printf '%s\n%s\n' "$HL_AGENT_KEY" "$LT_KEY" | perp --json setup --non-interactive \
  --venues hyperliquid,lighter --import-agents hyperliquid,lighter --yes \
  --lighter-account-index 123 --lighter-api-key-index 5
```

Trading works with the imported key. **Deposits, withdrawals, transfers, bridge, referral set and agent
approvals need the master**: without it they fail with `NO_SIGNER_AVAILABLE` ("do it on the exchange
website, or add the master with `perp wallet import`"). The CLI cannot revoke or rotate an imported key —
revoke it on the website; `perp wallet agent revoke <venue> <name> --local-only` removes the local copy,
and `wallet agent import <venue> --agent-name <name> --replace` swaps in a new website-created key.
`perp setup` offers the same choice per venue: approve with this computer's master wallet, or import a
website-created key (Step 1 can skip the master wallet).

Secrets are stored once (see `docs/SSOT_RULES.md` Rule #3): Lighter RH → `~/.perp/lighter-rh-agents/`, Ondo → `~/.perp/ondo-agents/<keyId>.json`, Arcus → OWS wallet `agent-arcus-<master>`; imported EVM / Solana / Ed25519 keys → OWS wallet `agent-{hl,aster,pac,arcus}-import-<name>` (empty passphrase, like approved agent wallets), imported Lighter keys → the network-tagged Lighter keystore. A missing wallet/key now fails with `KEY_NOT_FOUND` / `NO_SIGNER_AVAILABLE` instead of silently falling back to read-only.

## Venues

| Venue | `-e` id (aliases) | Trading | Notes |
|-------|-------------------|---------|-------|
| Pacifica | `pacifica` (`pac`) | yes | Solana |
| Hyperliquid | `hyperliquid` (`hl`) | yes | HyperEVM; HIP-3 dexes via `--dex` |
| Lighter | `lighter` (`lt`) | yes | Ethereum L2 |
| Aster | `aster` (`ast`) | yes | BNB Chain; funding interval is per symbol |
| Lighter RH | `lighter-rh` (`lrh`, `rh`) | yes | Lighter engine on the Robinhood chain, USDG collateral |
| Ondo Perps | `ondo` (`ondo-perps`) | yes | Off-chain engine; limit TIF GTC (default) / IOC / ALO; restricted: US, PA |
| QFEX | `qfex` (`qf`) | yes (see **QFEX** below) | Custodial, off-chain engine; equities / indices / commodities, cross margin, USDC; limit TIF GTC (default) / IOC / FOK / ALO; testnet = QFEX UAT; restricted: US, GB, ES and others |
| Arcus | `arcus` | yes | Robinhood chain, USDG collateral; limit TIF GTC (default, sent as GTT) / IOC / FOK / ALO; restricted: US, CA, GB; **access whitelist** — unlisted addresses are rejected (request access at arcus.xyz) |
| RISEx | `risex` (`rise`) | **no — read-only** (trading planned, not yet available; see **RISEx** below) | Fully on-chain order book on RISE chain, USDC; official API. Market data, funding and account reads by address; every trade / agent / bot path → `CAPABILITY_UNSUPPORTED`; deposits / withdrawals in the RISEx app only |
| Variational | `variational` (`var`, `omni`) | **no — market data only** (see **Variational** below) | Variational Omni, an RFQ venue (one market maker, no order book); official read-only API, no public trading API yet. Funding is unverified (shown only with `--include-unverified`); restricted: US, CA and others |
| GRVT | `grvt` (`grv`) | **no — market data only in this version** (trading planned, not yet available; see **GRVT** below) | Hybrid perps exchange, USDT collateral; official Market Data API. Funding is unverified (shown only with `--include-unverified`); testnet = `-n testnet`; trading needs KYC; restricted: US, CA, SG, HK and others |
| Extended | `extended` (`ext`, `x10`) | **no — market data only in this version** (trading planned, not yet available; see **Extended** below) | Perps order book on Starknet (formerly X10), USD collateral; official public API. Crypto plus RWA (equities, ETFs, indices, commodities, FX). Funding is unverified (shown only with `--include-unverified`); testnet = Sepolia (`-n testnet`); restricted: US, GB, CA, HK and others |
| TxFlow | `txflow` (`txf`) | **no — market data only** | **UNOFFICIAL API**: TxFlow has no official API yet; perp-cli reads the undocumented API its web app uses. It may change or break without notice. Funding is unverified (shown only with `--include-unverified`) |

- **Time in force:** `trade limit` defaults to `GTC` on every venue (common names `GTC | IOC | FOK | ALO`; a TIF the venue does not offer → `CAPABILITY_UNSUPPORTED`). Lighter post-only (`ALO`) is disabled until verified on the venue.
- **TP/SL on an entry:** `trade market|buy|sell|limit ... --tp <px> --sl <px>` means the same on every venue — *protect this entry's verified fill*. The direction is checked before anything is sent (long: tp > reference > sl; short: the reverse; reference = mark for market entries, the limit price for limit entries). Ondo attaches the legs to the order; Arcus sends an entry+TP/SL batch; Hyperliquid / Lighter / Aster verify the entry fill, then place reduce-only TP/SL trigger orders sized to it (only market or `--tif IOC` entries — a resting entry → `CAPABILITY_UNSUPPORTED`); Pacifica verifies the fill, then sets position TP/SL (refused if the symbol already has a position or TP/SL — never overwritten). Entry outcome unknown → `ORDER_PENDING` and **no** TP/SL (the position may be unprotected); entry filled but a leg failed → `ORDER_PARTIAL` (not retryable) with the entry result and which legs were placed — do not re-enter, finish with `trade tpsl`.
- **TP/SL on a position:** `trade tpsl <SYM> <long|short> --tp <px> --sl <px> [--tp-limit <px>] [--size <n>]` — the argument is the **position's** side (buy/sell no longer accepted), checked against the live position; legs are reduce-only and sized to the live position (or `--size`).
- **Stop orders are reduce-only by default** on every venue (`trade stop`); pass `--no-reduce-only` to let a stop open or flip a position (refused on Ondo and QFEX, whose stops are always reduce-only). Lighter / Arcus market triggers execute as a limit at trigger ± the slippage bound (`--slippage-bps` or settings) and may stay unfilled in a fast move; other venues use native market triggers (`--slippage-bps` → `CAPABILITY_UNSUPPORTED`).
- **Order edit:** `trade edit` keeps the order's TIF. Pacifica: post-only (ALO) orders are edited natively; GTC / TOB orders placed by perp-cli (TIF recorded in the client order id) are cancelled and replaced with the remaining open size; orders whose TIF is unknown → `CAPABILITY_UNSUPPORTED` (pass `--tif`).
- **Slippage bound:** every market-type order (entry, close, spot) is bounded by one value: `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps` (shipped default 50, shown in `perp settings show`; change with `perp settings set defaultSlippageBps <n>`). Values outside 1..venue max (Arcus 1000) are rejected before sending.
- **Restricted regions:** creating a signing adapter for a venue with restricted regions (Ondo, Arcus, QFEX) prints a one-time stderr notice; it never blocks — check the venue terms yourself.
- **Aggregate views** (`portfolio`, `account positions/orders`, `risk`, `history`, `wallet agent verify`, MCP `portfolio`) cover every account venue with configured credentials.

### What works — mainnet verification (2026-10-13)

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

### QFEX

QFEX is custodial: there is no wallet signature. The only credential is an **API key created on the QFEX website** (Developer Settings, 2FA), imported with `perp wallet agent import qfex` (public key + secret via hidden prompt / stdin; stored encrypted in `~/.perp/qfex-agents/`). The import resolves the **one account UUID** the key trades (primary, or `--account-id <uuid>`), shows it and stores nothing until you confirm it (piped: pass `--account-id` equal to it). Create the trading key **without** the "Deposit and withdraw" permission.

```bash
perp -n testnet wallet agent import qfex              # QFEX UAT (api.qfex.io); y/N on the resolved account
perp -e qfex market list                              # public: /refdata + market-data snapshot
perp -e qfex trade limit AAPL buy 320 0.01            # GTC: "accepted" after the ACK; "open" once listed (trade status)
perp -e qfex trade market AAPL buy 0.01               # IOC LIMIT at mark ± slippage (never the venue's unbounded MARKET)
perp -e qfex trade status c:<id> --symbol AAPL        # by the generated client order id
perp funds deposit qfex                               # prints the USDC / Arbitrum One deposit address; you send the funds
```

Verified on QFEX production (2026-10-13): `trade close` / `close-all` / `flatten` / `reduce` (sent as reduce-only **IOC**), `trade stop`, `trade tpsl` (both legs), market entry with `--sl`, `trade edit` (native modify — a new order id, the client id is kept, so `c:<id>` keeps working), cancel / status by `c:<id>`.

What perp-cli **still refuses on QFEX** (uniform `CAPABILITY_UNSUPPORTED`, before anything is sent):

| Refused | Why | Do instead |
|---|---|---|
| Resting reduce-only orders (`trade limit --reduce-only` with GTC / ALO, `trade scale-tp`) | Live: a resting reduce-only order **stays open after the position goes flat**; how the venue treats it if it later matches is unverified | Reduce-only IOC (`trade close` / `reduce`), or `trade stop` / `trade tpsl` |
| Stop-limit (`--tp-limit`, `trade stop` with a limit price) | The venue's stop orders convert to market orders when triggered | Stop-market |
| Stops that open or flip a position (`trade stop --no-reduce-only`) | QFEX stop orders only reduce a position | Reduce-only stops |
| `trade edit` of a reduce-only order | A reduce-only order is sized against the live position when placed; a modify would skip that check | `trade cancel`, then place again |
| `--client-id` | Client ids are not unique on the venue; perp-cli only trusts ids it generates | Omit it (the generated id is reported) |
| Markets not quoted in USD (`SKHYNIX-KRW`, …) | Sizing, risk limits and notionals assume USD | QFEX web app |
| Unattended automation on QFEX: bots, plans, TWAP, DCA, grid, funding arb, trailing stop, background jobs; QFEX in `arb scan` rankings | Automation is gated until verified (`QFEX_AUTOMATION_VERIFIED`); the funding rate's unit is unverified and equity funding accrues only part of the week (Q4) | Trade QFEX by hand; view funding only: `perp arb scan --rates --include-unverified` |

Known caveat: cancelling a stop / TP right after its position was closed can answer "unexpected error" while the venue removes the stop itself. QFEX keeps no record of stop orders, so perp-cli cannot prove the cancel and reports `ORDER_PARTIAL` (pending) — check `perp -e qfex account orders`; if it lists nothing, the stop is gone.

Order outcomes are never guessed: an IOC / market order is final only on a venue terminal frame (nothing filled → `ORDER_REJECTED`, `reason: iocNoFill`); anything unclear after the order was sent is `ORDER_PENDING` with the `c:<id>` to check — never resubmit. perp-cli never enables QFEX cancel-on-disconnect, but **another connection of the same user that enabled it (e.g. the official QFEX CLI) cancels all of the account's orders when that connection drops**.

**Withdrawals** are disabled in perp-cli for now (`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`, also under `--dry-run`); withdraw in the QFEX web app. Subaccounts: `perp -e qfex funds transfer <amount> primary --from <account uuid>`.

### RISEx (read-only — trading planned, not yet available)

RISEx is a fully on-chain perps order book on RISE chain (USDC collateral), reached through its **official** API. New venues ship in phases: in this release perp-cli reads RISEx data only; trading comes in a later release.

```bash
perp -e risex market list                     # public; funding = last settled hourly rate (verified)
perp -e risex market book BTC                 # also: prices | info | trades | kline | funding
perp arb scan --rates                         # RISEx rows in the funding comparison
perp health                                   # RISEx is probed as an official venue
perp -e risex account positions --ows <master>   # account reads are public by address — nothing is signed
```

- **Refused in this release** (`CAPABILITY_UNSUPPORTED`, "RISEx trading is planned for a later perp-cli release", before any key is read or request is sent — also under `--dry-run`): every `perp -e risex trade …` write, `trade multi` / `arb exec` / `arb auto` legs, every `strategy …` command (bots, plans, TWAP / grid / DCA, `--exchanges` legs), `wallet agent approve|import|revoke|rotate risex` (`revoke --force` only clears the local record), `perp setup --venues risex`, `funds faucet risex`, and the MCP `trade_preview` / `trade_execute` / `trade_close` tools. `arb scan --basis` covers trading venues only, so RISEx is not in it; in `arb scan` a pair with a RISEx leg is marked `executable: false` / "(read-only)".
- **Funds:** deposits and withdrawals are done in the RISEx app (app.rise.trade). `funds deposit|withdraw risex`, `funds transfer -e risex` and `funds rebalance execute` with risex refuse with `CAPABILITY_UNSUPPORTED` (also under `--dry-run`).
- The trading code (session signer restricted on-chain to trading only, EIP-712 permits) ships with its tests but is switched off by one flag (`RISEX_TRADING_ENABLED` in `src/exchanges/venues/risex-release.ts`).

### TxFlow (market data only — UNOFFICIAL API)

TxFlow publishes no official API yet. perp-cli reads the **undocumented** API that app.txflow.com uses — read-only, and it may change or be blocked at any time. Every JSON row carries `venueApi: "unofficial"` (`apiStatus` in mixed tables and MCP output); human output adds a footnote.

```bash
perp -e txflow market list | info <SYM> | book <SYM> | trades <SYM> | kline <SYM> 1h
perp arb scan --rates --include-unverified                  # TxFlow funding (percent per hour on the venue, shown as a fraction), display only
```

Every trade / account / portfolio / funds (deposit, withdraw, transfer, rebalance) / agent / builder / strategy / arb exec command and every MCP account or trading tool refuses TxFlow with `CAPABILITY_UNSUPPORTED` before any request. There is no funding history and no testnet; a market whose funding interval cannot be proven to be 1 hour shows funding as unknown.

### Variational (market data only — official API)

Variational Omni is an RFQ venue: its single market maker (the OLP) quotes every trade, so there is no order book. perp-cli reads its **official**, documented read-only API (one `GET /metadata/v2/stats` call for every market, shared for 5 s; venue limit 10 requests / 10 s per IP). Variational has no public trading API yet.

```bash
perp -e variational market list | prices | info <SYM>   # perps by base (BTC), swaps keep the suffix (XAU-SWAP)
perp -e variational market book BTC                      # the OLP's indicative RFQ quotes at fixed sizes — not an order book
perp -e variational market funding BTC                   # current terms: per interval (1h / 4h / 8h per market), hourly, APR
perp arb scan --rates --include-unverified               # Variational funding rows, display only
perp health                                              # probed as an official venue
```

- **Funding is unverified:** the published rate is a moving prediction for the next payment and cannot be checked against settled payments (no public account API), so it is shown only with `--include-unverified` — never ranked, traded or saved to funding history. There is no funding history endpoint.
- **Symbols:** TradFi perps (equities, ETFs, commodities) are classified explicitly; `US500-PERP` is the SPDR S&P 500 ETF (compared as `SPY`); pre-IPO markets, swaps, `SPX` (SPX6900) and `QNT` (Quant) are never matched across venues. No index price, tick, lot, leverage or base-unit open interest is published (shown as `-` / null).
- **Refused** (`CAPABILITY_UNSUPPORTED`, before any request — also under `--dry-run`): every trade / account / portfolio / funds / agent / builder / strategy / arb exec command and every MCP account or trading tool. No testnet, no WebSocket.

### GRVT (market data only — official API)

GRVT is a hybrid perps exchange (off-chain matching, USDT collateral). perp-cli reads its **official**, keyless Market Data API (`POST https://market-data.grvt.io/full/v1/…`; testnet `-n testnet`). In this version GRVT is read-only; trading is planned for a later release.

```bash
perp -e grvt market list | prices | info <SYM>   # base tickers (BTC, KPEPE, XAU, AAPL); BTC_USDT_Perp also accepted
perp -e grvt market book BTC                      # order book (10 / 50 / 100 / 500 levels served)
perp -e grvt market funding BTC                   # settled funding history (per 4h / 8h interval)
perp -e grvt market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified        # GRVT funding rows, display only
perp health                                       # probed as an official venue
```

- **Funding is unverified:** the interval is per market (4h or 8h); market rows carry GRVT's indicative rate for the running interval (`fundingRateKind: "predicted"`), converted from percent to a fraction per interval. It has not been checked against settled payments, so it is shown only with `--include-unverified` — never ranked or traded.
- **Symbols:** crypto by ticker; equities / ETFs by ticker from a reviewed list; XAU / XAG / CL / BZ → GOLD / SILVER / WTI / Brent; pre-IPO markets (OPENAI, ANTHROPIC, SPACEX) and ambiguous tickers are never matched across venues. No lot step is published (`stepSize` null); max leverage comes from GRVT's margin rules (`market list|prices|info`, cached up to 6 h — `leverageAsOf`).
- **Requests:** GRVT has no bulk ticker, so a full market read is one ticker per market (~185 requests, ~5 s), reused for 15 s; documented limits (1500 / min for tickers, 500 / min otherwise) are enforced by the venue limiter.
- **Refused** (`CAPABILITY_UNSUPPORTED`, "GRVT is read-only (market data) in this version; trading is planned for a later release", before any request — also under `--dry-run`): every trade / account / portfolio / funds / agent / builder / strategy / arb exec command, `setup --venues grvt`, and every MCP account or trading tool. No `perp-cli/ws` codec (GRVT streams are per instrument, capped below its market count).

### Extended (market data only — official API)

Extended (formerly X10) is a perps order book on Starknet (USD collateral) listing crypto and RWA markets (equities, ETFs, indices, commodities, FX). perp-cli reads its **official**, keyless public API (`https://api.starknet.extended.exchange/api/v1`; testnet Sepolia `-n testnet`). In this version Extended is read-only; trading is planned for a later release.

```bash
perp -e extended market list | prices | info <SYM>   # base tickers (BTC, TSLA, SPX500M); wire names (TSLA_24_5-USD) also accepted
perp -e extended market book TSLA                     # order book (RFQ markets: the indicative book)
perp -e extended market funding ETH                   # applied hourly funding prints
perp -e extended market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified            # Extended funding rows, display only
perp health                                           # probed as an official venue
```

- **Funding is unverified:** applied once per hour, a fraction per hour rounded to 6 decimals. Market rows carry the current hour's accruing rate (`fundingRateKind: "accruing"`); `market funding` shows the applied prints. It has not been checked against an account's funding payments, and `_24_5` equities print 0 while their underlying is closed, so it is shown only with `--include-unverified` — never ranked or traded.
- **Symbols:** the asset name without the `_24_5` suffix (`TSLA_24_5-USD` → `TSLA`); `market list` shows an asset-class column. Crypto by ticker; equities / ETFs by ticker; XAU / XAG / WTI / XBR → GOLD / SILVER / WTI / Brent, SPX500M / TECH100M → SPX / NDX. Pre-IPO markets, RWA tickers that are crypto tickers elsewhere (PURR, QNT, BB, ON, ADI, BOT), XIAOMI and the crypto `SPX` (SPX6900) are never matched across venues.
- **Refused** (`CAPABILITY_UNSUPPORTED`, "Extended is read-only (market data) in this version; trading is planned for a later release", before any request — also under `--dry-run`): every trade / account / portfolio / funds / agent / builder / strategy / arb exec command, `setup --venues extended`, and every MCP account or trading tool. No `perp-cli/ws` codec (Extended streams are one socket per stream URL, with no subscribe frame).

### Options market data — Derive (read-only)

Derive (derive.xyz) options through its official public API — keyless; no orders, no account, no signing (trading planned, not yet available). Derive is not a perp venue: `-e derive` works only with `perp options`.

```bash
perp --json -e derive options underlyings
perp --json -e derive options expiries ETH
perp --json -e derive options chain ETH --expiry 2026-12-25 --strikes 10   # bid/ask, mark, IV, greeks, OI per strike
perp --json -e derive options quote ETH-20261225-3500-P
```

### Spot trading

Spot support is declared per venue (`VenueDefinition.spot`) and every spot command, portfolio view and bot goes through one factory. Symbols are `BASE/QUOTE`; a bare base (`ETH`) uses the venue's first quote asset.

| Venue | Account model | Quote | Limit / book / cancel | Spot↔perp transfer |
|-------|---------------|-------|-----------------------|--------------------|
| Hyperliquid | runtime (unified accounts share USDC with perp; standard accounts are separate) | USDC | yes | yes (no-op on unified accounts) |
| Lighter / Lighter RH | separate | USDC / USDG | yes | yes |
| Aster | separate (`sapi` spot account) | USDT, USD1 (bare base → USDT) | yes | yes |
| Pacifica | **unified** — spot shares the perp account | USDC | yes | no (not needed) |
| Ondo Perps | separate (spot wallet ↔ margin) | USDC | yes | yes |
| Arcus | **wallet** — on-chain swaps from your master EVM wallet (router, Permit2) | USDG | no (market swaps only) | no |

```bash
perp --json -e <EX> trade spot-buy <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-sell <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-limit <SYM> <buy|sell> <PRICE> <SIZE> [--tif GTC|IOC|ALO]
perp --json -e <EX> trade spot-cancel <SYM> <ORDER_ID>
perp --json -e <EX> trade spot-orders [SYM]
perp --json -e <EX> trade spot-transfer <to-spot|to-perp> <AMOUNT>   # moves the venue's first quote asset
perp --json -e <EX> trade spot-balance
```

- **Unsupported operations fail loudly** with `CAPABILITY_UNSUPPORTED` (e.g. `spot-limit` / `spot-cancel` / `spot-orders` / `spot-transfer` on Arcus).
- **`spot-transfer` on a shared-balance account** (Pacifica, Hyperliquid unified) succeeds as a no-op with `execution.method: "sharedAccount"` (nothing needs to move); a real move reports `execution.method: "transfer"`.
- **Slippage:** same rule as perps — `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps` (shipped 50).
- **Pacifica:** spot buys spend the shared USDC perp margin and reduce perp available margin (a warning is printed before the first buy). Pacifica `getMarkets()` (perp) no longer lists the `SOL-USDC` spot market.
- **Aster:** an agent signer needs spot permission — `perp wallet agent rotate aster --can-spot` (or `perp wallet agent approve aster --can-spot`); otherwise spot orders fail with `POLICY_DENIED`.
- **Arcus:** swaps go through `router.spot.arcus.xyz` and settle on the Robinhood chain from the master EVM wallet (`--ows` / active OWS wallet; none → `NO_SIGNER_AVAILABLE`). Spot needs only the master wallet — no Arcus perp agent key; perp orders / account reads without one fail with `AGENT_NOT_REGISTERED` (`perp wallet agent approve arcus`). Listing Arcus spot markets is slow (~80 s, one router `/price` per token) — use `spot-buy` / `spot-sell` directly. Tokens without EIP-2612 permit need a one-time on-chain `approve(Permit2)` that costs Robinhood Chain ETH gas — pass `--yes` to allow it. Results show `status`, `finality`, `receivedToken` and a remediation; a `pending` result means the swap was submitted — **do not resubmit**.
- **Results:** spot orders print the normalized result (status, finality, filled size, average price, received token, remediation). `spot-buy` / `spot-sell` add an `execution` record on every venue (method, slippage bps + source, protection price and reference where the venue path computes one). `spot-cancel` returns one `SpotOrderResult` shape on every venue (a Lighter cancel is `pending` until `spot-orders` confirms it); `spot-orders` lists the same columns on every venue (Hyperliquid included).
- **Portfolio / landing:** spot value is added on top of perp equity except balances marked `shared` (Pacifica USDC, Hyperliquid unified USDC). Tokens without a spot price are excluded from totals with a stderr warning (never valued at 0).
- **Bots and arb** (`funding-arb`, `spot-perp-arb`, `arb exec spot:<venue>`, `arb close`, `arb scan --mode spot-perp`) only use spot venues with a separate (or runtime) spot balance **and** a spot↔perp transfer: hyperliquid, lighter, lighter-rh, aster, ondo. Pacifica (shared margin) and Arcus (on-chain swaps) are refused with `CAPABILITY_UNSUPPORTED`; trade them manually with `trade spot-*`.

## Command Groups

| Group | Description |
|-------|-------------|
| `market` | Prices, orderbook, funding, klines, HIP-3 dexes |
| `account` | Balance, positions, orders, margin |
| `trade` | Market/limit/stop orders, close, scale, split execution |
| `outcome` | Hyperliquid Outcome (HIP-4) — binary/range contracts, quoted per outcome (outcomeMeta `quoteToken`, USDC today), no leverage |
| `options` | Options market data, read-only (Derive: `-e derive options underlyings / expiries / chain / quote`) |
| `print` | Pacifica Print — strike orders earning a premium per cycle: games, quote, positions, history, events, deposit / cancel (`--dry-run`) |
| `vault` | Pacifica vaults (API: lakes) — list, info, positions, deposit (master wallet only) / withdraw (`--dry-run`) |
| `arb` | Funding rate arb — scan, exec, close, monitor (perp-perp & spot-perp) |
| `strategy` | 19 bot algorithms (grid, dca, twap, APEX, REFLECT, presets) + nested scripted plans |
| `funds` | Deposit, withdraw, transfer, cross-chain bridge (multi-provider), inter-exchange rebalance |
| `risk` | Risk limits, liquidation distance, guardrails |
| `wallet` | Multi-wallet management, agent wallets (`wallet agent ...`), builder fees (`wallet builder ...`, off by default), margin mode / subaccount / API keys (`wallet manage ...`), on-chain balances |
| `history` | Execution log, PnL, performance breakdown |
| `portfolio` | Cross-exchange unified overview (replaces former `account balance` / `status` / `dashboard`) |
| `health` | Adapter health check: ping every venue's REST endpoint (connectivity + latency) |
| `settings` | CLI settings (referrals, defaults, fees, builder fees, deBridge affiliate) |
| `backtest` | Strategy backtesting |
| `background` | Background process supervisor (tmux sessions for strategies, alerts, etc.) |
| `alerts` | Funding rate alerts (Telegram / Discord) with background daemon |
| `setup` | Setup wizard: OWS wallet, venues, agent wallets, slippage, default venue (alias: `init`; `--non-interactive` for scripts) |

### Builder fees (off by default)

perp-cli attaches **no** builder fee unless you configure one and the venue approval is confirmed:

```bash
perp settings set builder.hyperliquid 0xBuilder…,1   # <address|code>,<feeBps> — strict: format, venue cap; asks y/N (or --yes)
perp wallet builder status                            # per venue: supported? configured? approved? attached?
perp --dry-run wallet builder approve hyperliquid     # plan only
perp wallet builder approve hyperliquid               # master-signed, asks y/N (or --yes)
perp --no-builder trade market BTC buy 0.1            # skip it for one command
perp settings unset builder.hyperliquid               # off again
```

Supported: hyperliquid (≤ 10 bps, not on HIP-3 dexes), pacifica (≤ 10 bps max, not on spot), aster (≤ 10 bps, mainnet), ondo (≤ 10 bps, no approval step), qfex (`perp settings set builder.qfex <uuid>` — a **fee share**: your fills are attributed to the builder code and you pay the normal fee, nothing extra; the code rides on the trading connection; mainnet only). Lighter / Lighter RH / Arcus: unsupported. If the approval is missing or cannot be read, the order is sent **without** the fee and the result's `execution.notes` says why; `execution.builderFee` shows what was attached.

## Core Commands

```bash
# Portfolio (balances + positions + risk across all exchanges)
perp --json portfolio

# Market data
perp --json -e <EX> market list
perp --json -e <EX> market book <SYM>
perp --json -e <EX> market mid <SYM>              # fast mid-price lookup
perp --json -e <EX> market funding <SYM>
perp --json -e <EX> market kline <SYM> 1h          # candlestick data
perp --json -e hl market hip3                       # list HIP-3 deployed dexes

# Trading
perp --json -e <EX> trade buy <SYM> <SIZE>          # shortcut for market buy
perp --json -e <EX> trade sell <SYM> <SIZE>         # shortcut for market sell
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart  # IOC limit (less slippage)
perp --json -e <EX> trade split <SYM> buy 5000      # orderbook-aware split (large orders)
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade flatten                    # close ALL positions on exchange
perp --json -e <EX> trade reduce <SYM> 50            # reduce position by 50%
perp --json -e <EX> trade cancel <SYM>               # cancel by symbol (or orderId)
perp --json -e <EX> trade buy <SYM> <SIZE> --tp <PX> --sl <PX>  # entry protected by TP/SL
perp --json -e <EX> trade tpsl <SYM> long --tp <PX> --sl <PX>   # TP/SL on an open position (long|short)
perp --json -e <EX> trade stop <SYM> sell <SIZE> <PX>            # reduce-only stop (default)
perp --json -e <EX> trade leverage <SYM> <N>

# Account
perp --json portfolio -e <EX>                        # balance + spot + positions (account balance was renamed in v0.12)
perp --json -e <EX> account positions
perp --json -e <EX> account pnl                      # realized + unrealized + funding
perp --json -e <EX> account funding                  # personal funding payment history
perp --json -e <EX> account settings                 # per-market leverage & margin mode

# Outcome markets (Hyperliquid HIP-4 — fully-collateralized binary contracts, quote token per outcome (USDC today), min 10 quote tokens)
perp --json outcome list                                       # active markets + Yes/No mid prices
perp --json outcome view <outcome>                             # symmetric Yes/No book + underlying gap + expiry
perp --json outcome book <outcome> <side>                      # one-side orderbook (e.g. '1 yes' or '1 0')
perp --json outcome positions                                  # open outcome holdings
perp --json outcome orders                                     # open outcome orders
perp --json outcome buy <outcome> <side> <usd> --dry-run       # validate before submit
perp --json outcome buy <outcome> <side> <usd>                 # market buy, notional in the outcome's quote token
perp --json outcome sell <outcome> <side> <usd> --limit <px> --tif gtc
perp --json outcome cancel <outcome> <side> <oid>

# Funding rate arbitrage
perp --json arb scan --min 5                         # perp-perp opportunities
perp --json arb scan --mode spot-perp                # spot+perp opportunities
perp --json arb scan --rates                         # funding rates across all exchanges
perp --json arb scan --basis                         # cross-exchange basis opportunities
perp --json arb scan --gaps                          # cross-exchange price gaps
perp --json arb scan --hip3                          # HIP-3 cross-dex funding spreads
perp --json arb scan --live                          # continuous live monitoring
perp --json arb exec <SYM> <longEx> <shortEx> <$>   # perp-perp dual-leg entry
perp --json arb exec <SYM> spot:<exch> <perpEx> <$>  # spot+perp entry
perp --json arb config                               # show arb defaults
perp --json arb history                              # past arb trade performance (alias: log)

# Funds (deposit, withdraw, transfer, bridge, rebalance)
perp --json funds deposit hyperliquid 100
perp --json funds withdraw pacifica 50
perp --json funds deposit lighter-rh 10                # USDG on Robinhood Chain (approve + deposit, mainnet)
perp --json -e lighter-rh funds withdraw lighter 10    # USDG → Robinhood Chain
perp --json funds deposit aster 8                      # USDT → Aster vault on BNB Chain (--chain arbitrum / --asset USDC; mainnet)
perp --json funds withdraw aster 8 --chain bsc         # USDT → your own address (agent needs --can-withdraw --ip-whitelist)
perp --json funds deposit ondo 12 --probe 2            # USDC transfer to your Ondo funding address (Arbitrum; --chain ethereum)
perp --json funds withdraw arcus 10                   # to the Arcus account owner
perp --json funds transfer 100 <ADDRESS>             # HL internal transfer (instant)
perp --json funds bridge quote --from solana --to arbitrum --amount 100
perp --json funds bridge send --from solana --to arbitrum --amount 100   # auto-cheapest provider
perp --json --dry-run funds bridge send --from robinhood --to solana --from-asset USDG --to-asset SOL --amount 15   # Relay quote only
perp --json funds bridge send --from robinhood --to bsc --from-asset USDG --to-asset USDT --amount 15               # Relay swap, OWS master signs
perp --json funds bridge exchange --from pacifica --to hyperliquid --amount 100
perp --json funds rebalance check                    # balances across exchanges
perp --json funds rebalance plan                     # compute optimal moves
perp --json funds rebalance execute --auto-bridge    # withdraw → bridge → deposit
perp --json funds info                               # all routes & limits

# Risk
perp --json risk limits --max-leverage 5
perp --json risk liquidation-distance

# Strategies (19 bot algorithms + nested scripted plans)
perp strategy list-strategies                        # list all available strategies
perp strategy run <strategy> [symbol]                # run any strategy
perp strategy apex [symbol]                          # APEX autonomous orchestrator
perp strategy reflect                                # trading performance analysis
perp strategy preset-list                            # list strategy presets
perp --json strategy twap <SYM> buy <SIZE> 30m
perp --json strategy grid <SYM> --range 5 --grids 10 --size 100
perp strategy plan example                           # scripted multi-step plan format
perp --json strategy plan validate <FILE>            # validate scripted plan
perp --json strategy plan execute <FILE> --dry-run   # dry-run scripted plan

# Background process supervisor (tmux)
perp background list                                 # list running jobs
perp background stop <ID>                            # stop a job
perp background logs <ID> -f                         # follow logs
# Jobs inherit -n, --dry-run, -e, --ows, -w, --no-agent, --dex and never receive keys via argv/env:
# they read the OWS vault / agent keystores / ~/.perp/.env themselves. -k, --passphrase, --ows-key or a
# shell-exported key / OWS_PASSPHRASE is refused — register an agent (perp wallet agent approve <venue>).

```

## Telegram Alerts

Funding rate alerts via Telegram with background daemon support.

```bash
# Interactive setup (BotFather token + chat ID auto-detection)
perp alerts setup

# Add alert rules
perp alerts add ETH 30              # alert when ETH funding > 30% annualized
perp alerts add --all 50            # alert for any symbol > 50%

# Test & manage
perp alerts test                    # send test message
perp alerts list                    # show active rules

# Run daemon
perp alerts start                   # foreground
perp alerts start --background      # tmux background daemon
perp alerts stop                    # stop background daemon
```

Setup flow: BotFather token → bot validation → send `/start` to bot → auto-detect chat ID → test message.

Exchange flag: `-e hyperliquid` / `-e pacifica` / `-e lighter` / `-e aster` (aliases: `hl`, `pac`, `lt`).

Global flags: `--json`, `--fields <f>`, `--ndjson`, `--dry-run`, `--dex <name>` (HIP-3), `-w, --wallet <name>`.

## MCP Server

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

perp-cli includes a full-featured MCP server (29 tools, 3 resources, 2 prompts) for Claude Desktop, Cursor, and other MCP clients.

**No API keys required for market data** — explore prices, orderbooks, funding rates, and arb opportunities without any setup. Add keys only when you want to trade.

**Network:** set `PERP_NETWORK=testnet` in the server env to serve testnet (validated; unset = mainnet); every result reports `meta.network`. `trade_execute` / `trade_close` place real orders through the same local risk gate as `perp trade` (no override over MCP), refuse non-reduce-only orders on quarantined symbols, and are written to the execution log.

```json
{
  "mcpServers": {
    "perp-cli": {
      "command": "npx",
      "args": ["-y", "-p", "perp-cli", "perp-mcp"]
    }
  }
}
```

For trading and account data, run `perp setup` first: the MCP server reads the same OWS vault wallet and agent keystores as the CLI. Never put private keys in the MCP config. Select the network with `PERP_NETWORK` (`mainnet` | `testnet`; unset = mainnet, invalid values stop the server):
```json
{
  "env": {
    "PERP_NETWORK": "testnet"
  }
}
```

**Read-only tools (no keys):** `get_markets`, `get_orderbook`, `get_funding_rates`, `get_prices`, `get_positions_by_address` (any account's open positions by public address — hyperliquid incl. HIP-3, lighter, lighter-rh, pacifica, risex), `get_outcome_markets`, `get_outcome_view`, `get_outcome_book`, `get_option_expiries`, `get_option_chain`, `get_option_quote` (Derive options), `pacifica_print_products`, `pacifica_print_quote`, `pacifica_print_positions`, `pacifica_vaults` (Pacifica Print / vaults; writes are CLI-only), `arb_scan`, `health_check`

**Advisor tools (no keys):** `suggest_command`, `explain_command`

**Account & trading tools (keys required):** `get_balance`, `get_positions`, `get_open_orders`, `get_outcome_positions`, `portfolio`, `trade_preview`, `trade_execute`, `trade_close`, `get_funding_analysis`, `get_pnl_analysis`, `get_arb_compare`

- `get_markets` / `get_orderbook` add `meta.apiStatus` (`"unofficial"` + `apiNote` for TxFlow); `get_prices` lists `meta.unofficialApiVenues`; `health_check` rows carry `apiStatus`. Account / trading tools refuse TxFlow with `CAPABILITY_UNSUPPORTED`; `trade_preview` / `trade_execute` / `trade_close` refuse RISEx (read-only) before any credential is read.

**Resources:** `market://prices`, `market://funding-rates`, `perp://schema`

**Prompts:** `trading-guide`, `arb-strategy`

## Signing guardrail (`perp-guardrail`)

The third shipped binary. It is **not** a command you run by hand: it is the custom policy executable
the [OWS](https://github.com/open-wallet-standard) Policy Engine spawns before an agent API key signs
anything. OWS writes a `PolicyContext` JSON document to its stdin; it answers one JSON document on
stdout, `{"allow": true}` or `{"allow": false, "reason": "..."}`. A denied request is never signed.

What it checks, from the `policy_config` the policy carries (`src/guardrail/perp-guardrail.ts`):

- the **chain** and the **destination contract** against the per-chain whitelist (Pacifica programs on
  Solana mainnet / devnet, the Hyperliquid bridge + CCTP v2 + USDC on Arbitrum / Base / Ethereum, the
  signing-only chains for Hyperliquid typed data and Lighter — `src/guardrail/contracts.ts`);
- the **per-transaction** and **daily cumulative** USD amount (`max_tx_usd`, `max_daily_usd`);
- the **per-withdrawal** and **daily withdrawal** USD amount (`max_withdraw_usd`,
  `max_daily_withdraw_usd`);
- **blocked function selectors** (`block_selectors`, e.g. `approve` / `transferFrom`).

`policy_config.allowed_symbols` is accepted by the input type but **no check reads it** — it enforces
nothing today. `policy_config` is required: a context without it is denied
("policy_config missing from PolicyContext"), never allowed by baked-in defaults. USD amounts are derived from the transaction's native `value` with
`eth_price_usd` (default 3500 when the policy states none), so a non-ETH-denominated chain or a token
transfer whose amount lives in calldata is not amount-checked.

Wire it up through the CLI — the `--perp-defaults` / `wallet setup` paths point the policy at this
binary inside the installed package and fill the limits in, so you never write the path yourself:

```bash
# One-click: OWS vault wallet + guardrail policy + agent API key
perp wallet setup --name perp-trading --max-tx-usd 1000 --max-daily-usd 5000

# Or create the policy explicitly, with perp-cli's chain whitelist and this binary as the executable
perp wallet policy create --id perp-main --name "perp-cli guardrail" --perp-defaults \
  --max-tx-usd 1000 --max-daily-usd 5000 --max-withdraw-usd 500 --max-daily-withdraw-usd 2000 \
  --block-approve

# Point a policy at it by hand instead (any OWS policy executable path)
perp wallet policy create --id custom --name custom --executable "$(command -v perp-guardrail)"
```

Defaults when `--perp-defaults` fills them in: `max_tx_usd` 1000, `max_daily_usd` 5000,
`max_withdraw_usd` 500, `max_daily_withdraw_usd` 2000 (`DEFAULT_LIMITS`). The guardrail is a second
line of defence on the OWS side; it does not replace perp-cli's own pre-trade risk gate.

## AI Agent Skill

Drop-in skill for Claude Code, Cursor, Codex, Gemini CLI, and other agent CLIs. Bundles a non-interactive command guide, ops playbook, strategy framework, and reusable shell scripts (preflight, arb monitor, validation) so your agent stops at the right confirmation points and never wedges on interactive wizards.

### Install

```bash
# Claude Code — slash command
/install-skill hypurrquant/perp-cli

# Cursor / Codex / generic agent CLIs — via npx
npx skills add hypurrquant/perp-cli

# Manual install (any agent that reads a Skills directory)
git clone https://github.com/hypurrquant/perp-cli.git
cp -R perp-cli/skills/perp-cli ~/.claude/skills/        # or your CLI's skills dir
```

The skill ships inside the npm package (`perp-cli/skills/perp-cli`), so a global install also makes it available locally:

```bash
npm install -g perp-cli@latest
ls "$(npm root -g)/perp-cli/skills/perp-cli"
```

### What's in the skill

| File | Purpose |
|------|---------|
| `SKILL.md` | Top-level agent guide — rules, workflows, examples |
| `references/commands.md` | Full non-interactive command reference (every group) |
| `references/agent-operations.md` | Setup flows, idempotency, error handling, common mistakes |
| `references/strategies.md` | Funding-arb decision framework + risk management |
| `scripts/preflight.sh` | Install + wallet + connectivity + risk readiness check |
| `scripts/arb-monitor.sh` | Live monitor for open arb positions |
| `scripts/spot-perp-scan.sh` | Scan spot+perp opportunities with balance context |
| `scripts/funding-analysis.sh` | Cross-exchange funding overview / per-symbol drilldown |
| `scripts/validate-arb.sh` | Pre-execution validation (price / balance / risk / dry-run) |

See [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md) for the full agent guide.

## Agent-First CLI Design

Built following [agent-first CLI principles](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/):

```bash
# Every command returns structured JSON envelope
perp --json portfolio
# → { "ok": true, "data": {...}, "meta": { "timestamp": "..." } }

# Filter output to specific fields (saves tokens)
perp --json --fields totalEquity,risk portfolio

# Stream large lists as NDJSON (one JSON per line)
perp --json --ndjson -e hl market list

# Pre-validate before executing
perp --json -e hl trade check BTC buy 0.01
perp --json --dry-run -e hl trade market BTC buy 0.01

# Idempotent orders with client ID (Hyperliquid: a 128-bit cloid, 0x + 32 hex; --auto-id generates one)
perp --json -e hl trade market BTC buy 0.01 --client-id 0x1234567890abcdef1234567890abcdef
perp --json -e hl trade status c:0x1234567890abcdef1234567890abcdef
```

All responses are auto-sanitized (control chars stripped, prompt injection patterns blocked).
Errors include `retryable` flag — only retry when `true`.

## License

MIT
