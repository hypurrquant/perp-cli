# Commands

[← README](../README.md) · Every command group with examples. All commands accept `--json`.

## Core commands

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
perp --json portfolio -e <EX>                        # balance + spot + positions (your own balance: account balance was renamed in v0.12)
perp --json -e <EX> account positions
perp --json -e <EX> account positions --address <ADDR>   # ANY account's positions, keyless (no -e: every supporting venue)
perp --json -e <EX> account balance --address <ADDR>     # ANY account's balances (+ spot, HL HIP-3 dexes, Lighter sub-accounts), keyless
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
