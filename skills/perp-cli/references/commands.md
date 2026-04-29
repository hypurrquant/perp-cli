# perp-cli Command Reference

All commands support `--json` for structured output. Always use `--json` when calling from an agent.

## Market Data (read-only, safe)
```bash
perp --json market list                    # all markets with prices, funding, volume
perp --json market prices                  # cross-exchange price comparison
perp --json market mid <SYMBOL>            # mid price (fast)
perp --json market info <SYMBOL>           # mark/index price, funding, volume, OI, max leverage
perp --json market book <SYMBOL>           # orderbook (bids/asks)
perp --json market trades <SYMBOL>         # recent trades
perp --json market funding <SYMBOL>        # funding rate history
perp --json market kline <SYM> <INTERVAL>  # OHLCV candles (1m,5m,15m,1h,4h,1d)
perp --json market hip3                    # list HIP-3 deployed perp dexes (Hyperliquid only)
```

## Account (read-only, safe)
```bash
perp --json account balance                # perp balance + spot holdings + 24h funding (alias: account balance)
perp --json account positions              # open positions
perp --json account orders                 # open/pending orders
perp --json account history                # order history
perp --json account trades                 # trade fill history
perp --json account funding-history        # funding payments
perp --json account pnl                    # profit & loss
perp --json account margin <SYMBOL>        # position margin info
perp --json portfolio                      # cross-exchange unified view
```

## Trading (requires user confirmation)
```bash
# Market orders
perp --json trade market <SYMBOL> <buy|sell> <SIZE>
perp --json trade buy <SYMBOL> <SIZE>       # shorthand market buy
perp --json trade sell <SYMBOL> <SIZE>      # shorthand market sell

# Limit orders
perp --json trade limit <SYMBOL> <buy|sell> <PRICE> <SIZE>

# Stop orders
perp --json trade stop <SYMBOL> <SIDE> <STOP_PRICE> <SIZE>
perp --json trade tpsl <SYMBOL> <SIDE> --tp <PRICE> --sl <PRICE>

# Order management
perp --json trade edit <SYMBOL> <ORDER_ID> <PRICE> <SIZE>
perp --json trade cancel <SYMBOL> <ORDER_ID>
perp --json trade cancel-all
perp --json trade check <SYMBOL> <SIDE> <SIZE>    # pre-flight validation (no execution)
perp --json trade check <SYM> <SIDE> <SIZE> --leverage 3  # check with specific leverage
# NOTE: trade check does NOT read exchange-set leverage. Always pass --leverage explicitly.

# Position management
perp --json trade close <SYMBOL>            # close single position
perp --json trade close-all                 # close all positions
perp --json trade flatten                   # cancel all orders + close all positions
perp --json trade reduce <SYMBOL> <PCT>     # reduce position by percentage
perp --json trade leverage <SYMBOL> <N>     # set leverage

# Advanced orders
perp --json trade scale-tp <SYMBOL> --levels '<PRICE1>:<PCT>,<PRICE2>:<PCT>'
perp --json trade scale-in <SYMBOL> <SIDE> --levels '<PRICE1>:<SIZE>,<PRICE2>:<SIZE>'
perp --json trade pnl-track                 # real-time PnL tracker

# Split execution (orderbook-aware)
perp --json trade split <SYMBOL> <buy|sell> <USD>   # split large order into depth-based slices
perp --json trade split <SYM> buy 5000 --max-slippage 0.5 --max-slices 5 --delay 2000 --min-slice 200
perp --json trade market <SYM> buy <SIZE> --split   # split via market command flag
perp --json trade market <SYM> buy <SIZE> --split --max-slippage 0.5
```

## Funds (Deposit, Withdraw, Transfer, Bridge, Rebalance)

All fund movement lives under `perp funds`.

### Exchange in/out
```bash
perp --json funds deposit pacifica <AMOUNT>
perp --json funds deposit hyperliquid <AMOUNT>
perp --json funds deposit lighter ethereum <AMOUNT>         # L1 direct (min 1 USDC)
perp --json funds deposit lighter cctp arbitrum <AMOUNT>    # CCTP (min 5 USDC)
perp --json funds deposit lighter info                      # all Lighter deposit routes
perp --json funds withdraw pacifica <AMOUNT>
perp --json funds withdraw hyperliquid <AMOUNT>
perp --json funds withdraw lighter <AMOUNT>
perp --json funds transfer <AMOUNT> <ADDRESS>               # HL internal transfer (instant)
perp --json funds info                                      # combined routes & limits
```

### Cross-chain bridge (multi-provider router: cctp / relay / debridge — auto-cheapest)
```bash
perp --json funds bridge chains                   # supported chains
perp --json funds bridge quote --from <CHAIN> --to <CHAIN> --amount <AMT>
perp --json funds bridge send --from <CHAIN> --to <CHAIN> --amount <AMT>           # auto-cheapest
perp --json funds bridge send --from <CHAIN> --to <CHAIN> --amount <AMT> --provider cctp
perp --json funds bridge exchange --from <EX> --to <EX> --amount <AMT>             # between exchanges
perp --json funds bridge status <ORDER_ID>
```

### Inter-exchange rebalance (orchestrated withdraw → bridge → deposit)
```bash
perp --json funds rebalance check                            # balances across exchanges
perp --json funds rebalance plan                             # compute optimal moves
perp --json funds rebalance execute --auto-bridge            # withdraw → bridge → deposit
perp --json funds rebalance execute --withdraw-only          # only withdraw, manual rest
```

## Arbitrage
```bash
# Perp-Perp arb
perp --json arb scan --min <BPS>            # find opportunities (>N bps spread) — PRIMARY command
perp --json arb exec <SYM> <longEx> <shortEx> <$>  # execute perp-perp arb
perp --json arb close <SYM>                 # close perp-perp arb
perp --json arb status                      # monitor open arb positions
perp --json arb funding-earned              # actual funding payments

# Spot+Perp arb (spot funding = 0, spread = |perp funding|)
perp --json arb scan --mode spot-perp       # scan spot+perp opportunities
perp --json arb scan --mode all             # both perp-perp + spot-perp
perp --json arb spot-exec <SYM> <spotEx> <perpEx> <$>  # execute spot+perp arb
perp --json arb spot-close <SYM> --spot-exch <hl|lt>   # close spot+perp arb
# spotEx: hl (Hyperliquid) or lt (Lighter). perpEx: hl, lt, pac.
# HL spot uses U-tokens: BTC→UBTC, ETH→UETH, SOL→USOL (auto-resolved)

# Other arb tools
perp --json arb rates                       # funding rates across all DEXs (detailed)
perp --json arb prices                      # cross-exchange price gaps
perp --json arb dex                         # HIP-3 cross-dex arb (Hyperliquid)
# Deprecated: 'gap show' → use 'arb prices'; 'funding rates/spread' → use 'arb rates/scan'
```

## Wallet Management
```bash
perp --json wallet set hl <KEY>             # set Hyperliquid key
perp --json wallet set pac <KEY>            # set Pacifica key
perp --json wallet set lt <KEY>             # set Lighter key
perp --json wallet set hl <KEY> --default   # set key + make default exchange
perp --json wallet show                     # show configured wallets (public addresses)
perp --json wallet generate evm             # generate new EVM wallet
perp --json wallet generate solana          # generate new Solana wallet
perp --json wallet balance                  # on-chain balance
```

## Risk & Analytics
```bash
perp --json risk status                     # portfolio risk overview (level, violations, canTrade)
perp --json risk liquidation-distance       # % distance from liquidation for ALL positions
perp --json risk limits                     # view current risk limits
perp --json risk limits --min-liq-distance 30 --max-leverage 5  # set risk limits
perp --json risk check --notional 1000 --leverage 3  # pre-trade risk check
perp --json history summary                 # trading performance
perp --json history pnl                     # P&L breakdown by exchange
perp --json history funding                 # funding payment aggregation
perp --json history report                  # full performance report (summary + pnl + funding)
perp --json history perf --period daily     # daily PnL breakdown (replaces daily-pnl)
perp --json history perf --period weekly    # weekly PnL breakdown (replaces weekly-pnl)
perp --json history perf --period summary   # performance summary stats
perp --json history list                    # execution audit trail
```

## Automated Strategies (strategy — 19 algorithms + nested scripted plans)
```bash
perp --json strategy list-strategies                         # list all 19 strategies
perp --json strategy run <STRATEGY> [SYMBOL]                 # run any registered strategy
perp --json strategy run funding-auto                        # multi-exchange funding arb (no symbol needed)
perp --json strategy apex [SYMBOL]                           # APEX autonomous orchestrator (Radar+Pulse+Guard)
perp --json strategy reflect                                 # trading performance analysis (win rate, fees, PnL)
perp --json strategy preset-list                             # list strategy presets
perp --json strategy preset <NAME> [SYMBOL]                  # run from preset
perp --json strategy twap <SYMBOL> <SIDE> <SIZE> <DURATION>  # TWAP execution
perp --json strategy grid <SYMBOL> --range <PCT> --grids <N> --size <USD>
perp --json strategy dca <SYMBOL> <SIDE> <AMOUNT> <INTERVAL>
perp --json strategy trailing-stop <SYMBOL>                  # trailing stop with callback %
perp --json strategy funding-arb                             # auto funding arb
perp --json strategy quick-grid <SYMBOL>                     # quick grid bot
perp --json strategy quick-arb                               # quick arb bot

# Scripted execution plans (one-shot multi-step)
perp --json strategy plan example                            # show plan format
perp --json strategy plan validate <FILE>                    # validate plan
perp --json strategy plan execute <FILE> --dry-run           # dry-run plan

# Background process supervisor (tmux)
perp --json background list                                  # list running jobs
perp --json background stop <ID>                             # stop a job
perp --json background logs <ID>                             # view job logs
perp --json background remove <ID>                           # remove a job entry
perp --json background clean                                 # remove all stopped/done jobs
```

### Available Strategies
Market Making: `simple-mm`, `engine-mm`, `avellaneda-mm`, `regime-mm`, `grid-mm`, `liquidation-mm`
Signal/Directional: `momentum-breakout`, `mean-reversion`, `aggressive-taker`
Arbitrage: `funding-arb`, `funding-auto`, `basis-arb`
Infrastructure: `hedge-agent`, `rfq-agent`, `claude-agent`
Classic: `grid`, `dca`, `twap`, `apex`

## Agent Wallet Management
```bash
perp wallet agent approve <exchange> [--master <name>]   # Register an agent wallet
perp wallet agent list [exchange]                        # List registered agents
perp wallet agent revoke <exchange> <agentName>          # Revoke an agent
perp wallet agent rotate <exchange> [agentName]          # Revoke + re-approve same name
perp wallet agent verify [exchange] [agentName]          # Verify via DEX query API
```
