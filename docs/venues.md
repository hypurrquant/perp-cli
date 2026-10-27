# Venues

[← README](../README.md) · What each venue supports, venue ids and per-venue details.

## Support matrix

What each venue supports in this release, derived from the code (venue definitions in `src/exchanges/venues/*.ts`, `perp-cli/ws` codecs in `src/ws/codecs/`, the `funds deposit|withdraw` commands, the options registry). ✅ = implemented and available; — = not available. This says what perp-cli **offers**, not what was run with real money — for that see [What works — mainnet verification](verification.md).

| Venue | Market data (CLI) | Funding | WS stream (`perp-cli/ws`) | Positions by address (`--address`) | Balance by address (`account balance --address`) | Trading | Deposit via perp-cli | Withdraw via perp-cli | Extras | API |
|---|---|---|---|---|---|---|---|---|---|---|
| Hyperliquid (incl. HIP-3 via `--dex`) | ✅ | ✅ hourly | ✅ public + user (HIP-3 dexes opt-in) | ✅ (native + every HIP-3 dex) | ✅ (native, by account mode, + HIP-3 dexes; spot) | ✅ | ✅ (USDC from Arbitrum) | ✅ (CCTP) | spot, outcomes (HIP-4), native TWAP | official |
| Pacifica | ✅ | ✅ hourly | ✅ public + user | ✅ (Solana address) | ✅ (incl. spot) | ✅ | ✅ | ✅ | spot (unified margin), native TWAP (master-signed only); Print (`perp print`), Vaults (`perp vault`; deposit master-only) and Atomic basket (`trade atomic`) — each not yet verified live; legacy `wallet manage lake`: `create` still works, `deposit` / `withdraw` refuse and point to `perp vault` | official |
| Lighter | ✅ | ✅ hourly | ✅ public + user | ✅ (every sub-account) | ✅ (every sub-account; spot) | ✅ | ✅ (L1 or CCTP) | ✅ | spot, client-side TWAP | official |
| Lighter RH | ✅ | ✅ hourly | ✅ public + user (mainnet; testnet WS → HTTP 403) | ✅ (every sub-account) | ✅ (every sub-account; spot) | ✅ | ✅ (USDG, mainnet) | ✅ (`-e lighter-rh funds withdraw lighter`) | spot, client-side TWAP | official |
| Aster | ✅ | ✅ per symbol | ✅ public only (user channels: known gap) | — | — | ✅ | ✅ (USDT / USDC, mainnet) | ✅ (agent with `--can-withdraw --ip-whitelist`) | spot, client-side TWAP | official |
| Ondo Perps | ✅ | ✅ hourly | — | — | — | ✅ | ✅ (USDC, mainnet) | — (the API allows none; web app)⁴ | spot, client-side TWAP | official |
| Arcus | ✅ | ✅ hourly | ✅ public + user | — | — | ✅ | — (web app) | ✅ (to the account owner) | spot (on-chain swaps), client-side TWAP | official |
| QFEX | ✅ | unverified (display only, `--include-unverified`) | — | — | — | ✅ (no resting reduce-only, no automation — see [QFEX](#qfex)) | address only | — (disabled for now; web app)⁵ | — | official |
| RISEx | ✅ | ✅ hourly | — | ✅ | ✅ | ✅ (manual only, no TP/SL / amend; not yet verified on mainnet — see [RISEx](#risex)) | — (app only) | — (app only) | account reads by address; testnet faucet | official |
| TxFlow | ✅ | unverified (display only, `--include-unverified`) | — | — | — | — (market data only) | — | — | — | **unofficial** |
| Variational | ✅ (`market book` = RFQ quotes, not an order book) | unverified (display only, `--include-unverified`); interval per market (1h / 4h / 8h) | — | — | — | — (market data only) | — | — | equities / ETFs / commodities; pre-IPO (not matched) | official |
| GRVT | ✅ | unverified (display only, `--include-unverified`); interval per market (4h / 8h) | — (per-instrument streams only) | — | — | — (market data only in this version; trading planned, not yet available) | — | — | equities / ETFs, commodities; pre-IPO not matched | official |
| Extended | ✅ (crypto plus equities / ETFs / commodities / indices / FX) | unverified (display only, `--include-unverified`), hourly; `_24_5` equities print 0 off-hours | — (one socket per stream; not supported yet) | — | — | — (read-only) | — | — | asset-class column; pre-IPO and ambiguous tickers not matched | official |
| Derive | options only (`perp -e derive options …`) | — | — | — | — | — (**read-only**; trading planned, not yet available) | — | — | options: underlyings, expiries, chain (IV, greeks), quote | official |

- **Funding** ✅ = the rate's unit is verified against settled payments (`fundingVerified`), so the venue takes part in `arb scan` and funding strategies; unverified venues are shown only with `--include-unverified`, never ranked or traded.
- **WS stream** = `perp-cli/ws` / `@hypurrquant/perp-ws` channels: public = all-market / per-market state and `bbo`; user = account, positions, orders, fills. `book` / `trades` channels are not available yet on any venue.
- **Positions by address** = `perp -e <venue> account positions --address <addr>` (no `-e`: every venue below) and MCP `get_positions_by_address`: the open positions of ANY account from public venue data — keyless, nothing signed. 0x address except Pacifica (base58 Solana); other venues refuse with `CAPABILITY_UNSUPPORTED`.
- **Balance by address** = `perp -e <venue> account balance --address <addr>` (no `-e`: every venue above) and MCP `get_balance_by_address`: the balances of ANY account from public venue data — keyless, nothing signed. Same math as your own balance (Hyperliquid: the equity source follows the account's abstraction mode); spot token balances where the venue publishes them by address; Lighter: one row per account of the address (`--account-index` narrows); Hyperliquid: HIP-3 dexes with a non-zero account value (a dex that fails is a warning — unknown, not zero). Other venues refuse with `CAPABILITY_UNSUPPORTED`.
- **Client-side TWAP** = `trade twap` / `strategy twap` slicing on venues without a native TWAP (refused on QFEX by its automation gate).

## Venue ids and notes

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
| RISEx | `risex` (`rise`) | yes — manual only (see **RISEx** below) | Fully on-chain order book on RISE chain, USDC; official API. Orders through a session signer restricted on-chain to trading only; limit TIF GTC / IOC / FOK / ALO; no TP/SL, amend or bots yet; deposits / withdrawals in the RISEx app only; mainnet trading not yet verified with real funds |
| Variational | `variational` (`var`, `omni`) | **no — market data only** (see **Variational** below) | Variational Omni, an RFQ venue (one market maker, no order book); official read-only API, no public trading API yet. Funding is unverified (shown only with `--include-unverified`); restricted: US, CA and others |
| GRVT | `grvt` (`grv`) | **no — market data only in this version** (trading planned, not yet available; see **GRVT** below) | Hybrid perps exchange, USDT collateral; official Market Data API. Funding is unverified (shown only with `--include-unverified`); testnet = `-n testnet`; trading needs KYC; restricted: US, CA, SG, HK and others |
| Extended | `extended` (`ext`, `x10`) | **no — market data only in this version** (trading planned, not yet available; see **Extended** below) | Perps order book on Starknet (formerly X10), USD collateral; official public API. Crypto plus RWA (equities, ETFs, indices, commodities, FX). Funding is unverified (shown only with `--include-unverified`); testnet = Sepolia (`-n testnet`); restricted: US, GB, CA, HK and others |
| TxFlow | `txflow` (`txf`) | **no — market data only** | **UNOFFICIAL API**: TxFlow has no official API yet; perp-cli reads the undocumented API its web app uses. It may change or break without notice. Funding is unverified (shown only with `--include-unverified`) |

- **Restricted regions:** creating a signing adapter for a venue with restricted regions (Ondo, Arcus, QFEX) prints a one-time stderr notice; it never blocks — check the venue terms yourself.
- **Aggregate views** (`portfolio`, `account positions/orders`, `risk`, `history`, `wallet agent verify`, MCP `portfolio`) cover every account venue with configured credentials.

## QFEX

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

## RISEx

RISEx is a fully on-chain perps order book on RISE chain (USDC collateral), reached through its **official** API. Trading is on since 2026-10-27 (shipped switched off in 0.15.0). It was verified on **testnet** (2026-10-14); no mainnet RISEx order has been run yet.

```bash
perp -e risex market list                     # public; funding = last settled hourly rate (verified)
perp -e risex market book BTC                 # also: prices | info | trades | kline | funding
perp arb scan --rates                         # RISEx rows in the funding comparison
perp health                                   # RISEx is probed as an official venue
perp -e risex account positions --ows <master>   # account reads are public by address — nothing is signed
perp -e risex wallet agent approve risex --master <ows-wallet>   # session signer, restricted on-chain to trading only
perp -e risex trade limit BTC buy <price> <size> --tif ALO
perp -n testnet funds faucet risex            # testnet only: 1000 test USDC, once
```

- **Signer:** `wallet agent approve risex --master <w>` registers a session signer (default `--expires-in 30d`). The signer is then restricted ON-CHAIN to trading only: the master sends the DisablePermission transactions and needs a little RISE-chain ETH for gas. Never interrupt the approve: until the last DisablePermission lands, the signer briefly holds full permissions. `wallet agent import risex` is refused, because an app-created signer keeps fund-movement permissions. Trading-only is re-proven from the on-chain permission bitmap and the reviewed contract versions before signed actions. After a contract upgrade or a new permission id, every signed action is refused (`POLICY_DENIED`) until perp-cli is updated.
- **Orders:** market (IOC within the market's match price band, 2 % on mainnet today), limit GTC / IOC / FOK / ALO, reduce-only, cancel, cancel-all, leverage, margin mode (refused while a position is open), `trade status c:<id>`. Sizes and prices must sit on the step / tick grid (`INVALID_TICK`, never rounded).
- **Not yet** (`CAPABILITY_UNSUPPORTED`): TP/SL / stops, amend, builder fee. Bots, TWAP, grid, background jobs and `strategy …` on RISEx are refused too ("unattended trading on RISEx is not enabled until its trading path is verified on mainnet").
- **Funds:** deposits and withdrawals are done in the RISEx app (app.rise.trade). `funds deposit|withdraw risex`, `funds transfer -e risex` and `funds rebalance execute` with risex refuse with `CAPABILITY_UNSUPPORTED` (also under `--dry-run`).
- One flag still switches trading off again (`RISEX_TRADING_ENABLED` in `src/exchanges/venues/risex-release.ts`): with it false, every trade / agent / bot path refuses with `CAPABILITY_UNSUPPORTED` before any key is read.

## TxFlow (market data only — UNOFFICIAL API)

TxFlow publishes no official API yet. perp-cli reads the **undocumented** API that app.txflow.com uses — read-only, and it may change or be blocked at any time. Every JSON row carries `venueApi: "unofficial"` (`apiStatus` in mixed tables and MCP output); human output adds a footnote.

```bash
perp -e txflow market list | info <SYM> | book <SYM> | trades <SYM> | kline <SYM> 1h
perp arb scan --rates --include-unverified                  # TxFlow funding (percent per hour on the venue, shown as a fraction), display only
```

Every trade / account / portfolio / funds (deposit, withdraw, transfer, rebalance) / agent / builder / strategy / arb exec command and every MCP account or trading tool refuses TxFlow with `CAPABILITY_UNSUPPORTED` before any request. There is no funding history and no testnet; a market whose funding interval cannot be proven to be 1 hour shows funding as unknown.

## Variational (market data only — official API)

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

## GRVT (market data only — official API)

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

## Extended (market data only — official API)

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

## Options market data — Derive (read-only)

Derive (derive.xyz) options through its official public API — keyless; no orders, no account, no signing (trading planned, not yet available). Derive is not a perp venue: `-e derive` works only with `perp options`.

```bash
perp --json -e derive options underlyings
perp --json -e derive options expiries ETH
perp --json -e derive options chain ETH --expiry 2026-12-25 --strikes 10   # bid/ask, mark, IV, greeks, OI per strike
perp --json -e derive options quote ETH-20261225-3500-P
```
