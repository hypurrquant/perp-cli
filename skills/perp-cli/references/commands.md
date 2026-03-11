# perp-cli Command Reference

All commands support `--json` for structured output. Always use `--json` when calling from an agent.

## Market Data (read-only, safe)
```bash
perp --json market list                    # all markets with prices, funding, volume
perp --json market prices                  # cross-exchange price comparison
perp --json market mid <SYMBOL>            # mid price (fast)
perp --json market info <SYMBOL>           # tick size, min order, max leverage
perp --json market book <SYMBOL>           # orderbook (bids/asks)
perp --json market trades <SYMBOL>         # recent trades
perp --json market funding <SYMBOL>        # funding rate history
perp --json market kline <SYM> <INTERVAL>  # OHLCV candles (1m,5m,15m,1h,4h,1d)
```

## Account (read-only, safe)
```bash
perp --json account info                   # balance, equity, margin, PnL
perp --json account positions              # open positions
perp --json account orders                 # open/pending orders
perp --json account history                # order history
perp --json account trades                 # trade fill history
perp --json account funding-history        # funding payments
perp --json account pnl                    # profit & loss
perp --json account margin <SYMBOL>        # position margin info
perp --json status                         # combined: balance + positions + orders
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
perp --json trade trailing-stop <SYMBOL>    # trailing stop with callback %
perp --json trade twap <SYMBOL> <SIDE> <SIZE> <DURATION>
perp --json trade pnl-track                 # real-time PnL tracker
```

## Deposit & Withdraw
```bash
perp --json deposit pacifica <AMOUNT>
perp --json deposit hyperliquid <AMOUNT>
perp --json deposit lighter ethereum <AMOUNT>         # L1 direct (min 1 USDC)
perp --json deposit lighter cctp arbitrum <AMOUNT>    # CCTP (min 5 USDC)
perp --json deposit lighter info                      # all Lighter deposit routes
perp --json withdraw pacifica <AMOUNT>
perp --json withdraw hyperliquid <AMOUNT>
perp --json deposit info                    # deposit instructions
perp --json withdraw info                   # withdrawal instructions
```

## Bridge (Cross-chain USDC)
```bash
perp --json bridge chains                   # supported chains
perp --json bridge quote --from <CHAIN> --to <CHAIN> --amount <AMT>
perp --json bridge send --from <CHAIN> --to <CHAIN> --amount <AMT>
perp --json bridge exchange --from <EX> --to <EX> --amount <AMT>
perp --json bridge status <ORDER_ID>
```

## Arbitrage
```bash
perp --json arb scan --min <BPS>            # find opportunities (>N bps spread) — PRIMARY command
perp --json arb funding                     # detailed funding analysis
perp --json arb dex                         # HIP-3 cross-dex arb (Hyperliquid)
perp --json gap show                        # cross-exchange price gaps
# NOTE: 'arb rates' is deprecated — use 'arb scan' instead
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
perp --json health                          # exchange connectivity & latency
perp --json analytics summary              # trading performance
perp --json analytics pnl                   # P&L breakdown
perp --json history list                    # execution audit trail
```

## Automated Strategies
```bash
perp --json run grid <SYMBOL> --range <PCT> --grids <N> --size <USD>
perp --json run dca <SYMBOL> <SIDE> <AMOUNT> <INTERVAL>
perp --json run funding-arb                 # auto funding arb
perp --json bot quick-grid <SYMBOL>         # quick grid bot
perp --json bot quick-arb                   # quick arb bot
perp --json jobs list                       # list running jobs
perp --json jobs stop <ID>                  # stop a job
```

## Alerts
```bash
perp --json alert add                       # add price/funding/pnl/liquidation alert
perp --json alert list                      # list active alerts
perp --json alert remove <ID>              # remove alert
```

## Command Discovery
```bash
perp schema                       # Full CLI schema as JSON
perp agent capabilities           # High-level capability list
perp agent plan "<goal>"          # Suggest command sequence for a goal
perp agent ping                   # Health check all exchanges
```
