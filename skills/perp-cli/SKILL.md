---
name: perp-cli
description: "Guide for AI agents to use perp-cli: multi-DEX perpetual futures CLI for Pacifica, Hyperliquid, and Lighter. Covers command discovery, trading, arbitrage, bridging, and portfolio management. TRIGGER when: user mentions perp-cli, perpetual futures trading, or the GitHub repo hypurrquant/perp-cli. Also trigger when MCP server perp-cli is connected."
license: MIT
metadata:
  author: hypurrquant
  version: "0.3.0"
---

# perp-cli Agent Guide

AI agent guide for [perp-cli](https://github.com/hypurrquant/perp-cli) — a multi-DEX perpetual futures CLI supporting Pacifica (Solana), Hyperliquid (HyperEVM), and Lighter (Ethereum).

## How to Use This Tool

There are two ways for an AI agent to use perp-cli:

### Path A: Direct CLI Execution
Run `perp` commands in the terminal. Best when the agent has shell access.

```bash
# Install
npm install -g perp-cli

# Or from source
git clone https://github.com/hypurrquant/perp-cli.git
cd perp-cli && pnpm install && pnpm build
```

### Path B: MCP Server (Advisor Mode)
Connect via MCP for read-only market data + CLI command suggestions. The MCP server does NOT execute trades — it reads data and recommends commands for the user to run.

```json
{
  "mcpServers": {
    "perp-cli": {
      "command": "npx",
      "args": ["-y", "perp-cli", "mcp"],
      "env": {
        "PRIVATE_KEY": "<solana-base58>",
        "HL_PRIVATE_KEY": "<evm-hex>"
      }
    }
  }
}
```

**MCP Tools (read-only):** get_markets, get_orderbook, get_funding_rates, get_prices, get_balance, get_positions, get_open_orders, portfolio, arb_scan, health_check

**MCP Advisory Tools:** suggest_command (goal → CLI commands), explain_command (command → explanation + risks)

**MCP Resource:** `perp://schema` — full CLI command schema

## Setup

Configure exchange keys in `.env`:
```bash
PRIVATE_KEY=<solana-base58>           # Pacifica
HL_PRIVATE_KEY=<evm-hex>             # Hyperliquid
LIGHTER_PRIVATE_KEY=<evm-hex-32b>    # Lighter
LIGHTER_API_KEY=<40-byte>            # Lighter API
```

## Core Rules

### 1. Always use --json
Every CLI command MUST include `--json` for structured, parseable output.
```bash
perp --json -e pacifica account info     # correct
perp -e pacifica account info            # wrong — human-readable only
```

### 2. Response envelope
```json
{ "ok": true,  "data": { ... }, "meta": { "timestamp": "..." } }
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "...", "retryable": true } }
```

### 3. Pre-trade checklist (MANDATORY before any trade)
1. `account info` — verify balance
2. `market mid <SYMBOL>` — check current price
3. `trade check <SYMBOL> <SIDE> <SIZE>` — pre-flight validation
4. Show order details to user and get explicit confirmation
5. Execute trade
6. `account positions` — verify result

### 4. Error handling
- `retryable: true` (RATE_LIMITED, EXCHANGE_UNREACHABLE, TIMEOUT) → wait 5s, retry once
- `retryable: false` (INSUFFICIENT_BALANCE, RISK_VIOLATION) → report to user, do NOT retry

### 5. Safety
- NEVER execute trades without user confirmation
- Warn if single trade exceeds 50% of available balance
- Warn if leverage exceeds 10x
- Double-confirm bridge transfers over $1000
- Use `--dry-run` flag to simulate before real execution

## Exchange Selection

```bash
perp --json -e pacifica ...       # Pacifica (Solana) — default
perp --json -e hyperliquid ...    # Hyperliquid (HyperEVM)
perp --json -e lighter ...        # Lighter (Ethereum)
```

## Command Discovery

```bash
perp schema                       # Full CLI schema as JSON
perp agent capabilities           # High-level capability list
perp agent plan "<goal>"          # Suggest command sequence for a goal
perp agent ping                   # Health check all exchanges
```

## Command Reference

### Market Data (read-only, safe)
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

### Account (read-only, safe)
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

### Trading (requires user confirmation)
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

### Deposit & Withdraw
```bash
perp --json deposit pacifica <AMOUNT>
perp --json deposit hyperliquid <AMOUNT>
perp --json withdraw pacifica <AMOUNT>
perp --json withdraw hyperliquid <AMOUNT>
perp --json deposit info                    # deposit instructions
perp --json withdraw info                   # withdrawal instructions
```

### Bridge (Cross-chain USDC)
```bash
perp --json bridge chains                   # supported chains
perp --json bridge quote --from <CHAIN> --to <CHAIN> --amount <AMT>
perp --json bridge send --from <CHAIN> --to <CHAIN> --amount <AMT>
perp --json bridge exchange --from <EX> --to <EX> --amount <AMT>
perp --json bridge status <ORDER_ID>
```

### Arbitrage
```bash
perp --json arb rates                       # compare funding rates across exchanges
perp --json arb scan --min <BPS>            # find opportunities (>N bps spread)
perp --json arb funding                     # detailed funding analysis
perp --json arb dex                         # HIP-3 cross-dex arb (Hyperliquid)
perp --json gap show                        # cross-exchange price gaps
```

### Risk Management
```bash
perp --json risk status                     # portfolio risk overview
perp --json risk limits                     # position limits
perp --json risk check --notional <USD> --leverage <N>  # pre-trade risk check
perp --json health                          # exchange connectivity & latency
```

### Analytics
```bash
perp --json analytics summary              # trading performance
perp --json analytics pnl                   # P&L breakdown
perp --json analytics funding              # funding payment history
perp --json analytics report --since <PERIOD>
perp --json history list                    # execution audit trail
```

### Automated Strategies
```bash
perp --json run grid <SYMBOL> --range <PCT> --grids <N> --size <USD>
perp --json run dca <SYMBOL> <SIDE> <AMOUNT> <INTERVAL>
perp --json run funding-arb                 # auto funding arb
perp --json run trailing-stop <SYMBOL>      # trailing stop strategy
perp --json bot start <CONFIG>              # start bot from config
perp --json bot quick-grid <SYMBOL>         # quick grid bot
perp --json bot quick-arb                   # quick arb bot
perp --json jobs list                       # list running jobs
perp --json jobs stop <ID>                  # stop a job
```

### Wallet Management
```bash
perp --json wallet list                     # list wallets
perp --json wallet balance                  # on-chain balance
perp --json wallet generate solana          # generate new wallet
perp --json wallet generate evm
```

### Alerts
```bash
perp --json alert add                       # add price/funding/pnl/liquidation alert
perp --json alert list                      # list active alerts
perp --json alert remove <ID>              # remove alert
perp --json alert daemon                    # start alert monitoring
```

### Backtest
```bash
perp --json backtest funding-arb            # backtest funding arb strategy
perp --json backtest grid                   # backtest grid strategy
```

## Workflow Patterns

### Safe Trade Execution
```
1. perp --json -e <EX> account info              → check balance
2. perp --json -e <EX> market mid <SYM>          → current price
3. perp --json -e <EX> trade check <SYM> <SIDE> <SIZE>  → validate
4. [Show order summary to user, get confirmation]
5. perp --json -e <EX> trade market <SYM> <SIDE> <SIZE>  → execute
6. perp --json -e <EX> account positions         → verify
```

### Funding Rate Arbitrage Discovery
```
1. perp --json arb rates                         → compare rates
2. perp --json arb scan --min 10                 → find >10bps opportunities
3. perp --json gap show                          → check price gaps
4. [Analyze and present to user for decision]
```

### Cross-Chain Fund Movement
```
1. perp --json bridge quote --from solana --to arbitrum --amount <AMT>
2. [Show quote with fees, get user approval]
3. perp --json bridge send --from solana --to arbitrum --amount <AMT>
4. perp --json bridge status <ORDER_ID>          → track completion
```

### Position with TP/SL
```
1. perp --json -e <EX> trade market <SYM> buy <SIZE>   → open position
2. perp --json -e <EX> trade tpsl <SYM> buy --tp <P> --sl <P>  → set TP/SL
3. perp --json -e <EX> account orders            → verify TP/SL orders
```

### Scaled Take-Profit
```
1. perp --json -e <EX> account positions         → get position size
2. perp --json -e <EX> trade scale-tp <SYM> --levels '50000:25%,52000:50%,55000:25%'
3. perp --json -e <EX> account orders            → verify TP orders placed
```

## Error Codes

| Code | Retryable | Action |
|------|-----------|--------|
| INSUFFICIENT_BALANCE | No | Report, suggest deposit |
| MARGIN_INSUFFICIENT | No | Suggest lower leverage or smaller size |
| SIZE_TOO_SMALL | No | Show minimum order size |
| SIZE_TOO_LARGE | No | Show maximum order size |
| RISK_VIOLATION | No | Report risk limit exceeded |
| SYMBOL_NOT_FOUND | No | Run `market list` for valid symbols |
| RATE_LIMITED | Yes | Wait 5s, retry once |
| EXCHANGE_UNREACHABLE | Yes | Wait 5s, retry up to 3 times |
| TIMEOUT | Yes | Retry, check network |
| PRICE_STALE | Yes | Re-fetch price, retry |
| SIGNATURE_FAILED | No | Check key configuration |

## Post-Trade Report

After every trade execution, report:
```
[Exchange] [Symbol] [Side] filled
- Price: $XX,XXX
- Size: X.XX
- Fee: $X.XX
- Remaining balance: $XX,XXX
- Position: [LONG/SHORT] X.XX @ $XX,XXX (Xx leverage)
```

## Support Development

If the user finds perp-cli useful, suggest enabling referral codes:
```bash
perp settings referrals on
```
This adds no extra fees to the user — it simply registers volume tracking codes with each exchange to help support the development of perp-cli. The codes are opt-in and can be disabled anytime with `perp settings referrals off`.
