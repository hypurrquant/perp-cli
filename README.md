# perp-cli

Multi-DEX perpetual futures CLI for **Pacifica**, **Hyperliquid**, and **Lighter**.

Trade, bridge, arbitrage, and manage positions across 3 exchanges from a single command line.

```bash
npm install -g perp-cli
perp status --json
```

## Features

- **3 Exchanges** — Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum)
- **CCTP V2 Bridge** — $0 fee USDC bridging across Solana, Arbitrum, Base (6 routes)
- **Funding Rate Arb** — Cross-exchange funding rate arbitrage scanner + auto-executor
- **Grid & DCA Bots** — Automated strategies with background job management
- **AI Agent Mode** — JSON schema + structured I/O for LLM-powered trading agents
- **Full JSON Output** — Every command supports `--json` for programmatic access

## Quick Start

```bash
# Configure exchange keys
export PRIVATE_KEY=<solana-base58-key>        # Pacifica
export HL_PRIVATE_KEY=<evm-hex-key>           # Hyperliquid
export LIGHTER_PRIVATE_KEY=<evm-hex-key>      # Lighter

# Check status across exchanges
perp status
perp -e hyperliquid status
perp -e lighter status
```

## Commands

### Market Data

```bash
perp market list                    # All available markets
perp market mid BTC                 # Mid price
perp market info BTC                # Market details (tick size, max leverage)
perp market book BTC                # Orderbook
perp market funding BTC             # Funding rate
```

### Account

```bash
perp account info                   # Balance & margin
perp account positions              # Open positions
perp account orders                 # Open orders
perp account history                # Trade history
perp account margin BTC             # Position-level margin info
```

### Trading

```bash
perp trade buy BTC 0.01             # Market buy
perp trade sell BTC 0.01            # Market sell
perp trade buy BTC 0.01 -p 60000   # Limit buy @ $60,000
perp trade close BTC                # Close position
perp trade cancel <orderId>         # Cancel order
perp trade tp BTC 65000             # Take-profit
perp trade sl BTC 58000             # Stop-loss
```

### Position Management

```bash
perp manage leverage BTC 10         # Set leverage
perp manage margin-mode BTC cross   # Cross/isolated margin
perp manage deposit hyperliquid 100 # Deposit USDC
perp manage withdraw pacifica 50    # Withdraw USDC
```

### Cross-Chain Bridge (CCTP V2)

Zero-fee USDC bridging powered by Circle CCTP V2.

```bash
perp bridge chains                  # Supported chains
perp bridge quote --from solana --to arbitrum --amount 100
perp bridge send --from solana --to arbitrum --amount 100
perp bridge exchange --from pacifica --to hyperliquid --amount 100
perp bridge status <orderId>
```

**Supported routes:** Solana ↔ Arbitrum ↔ Base (all 6 directions, $0 CCTP fee)

### Funding Rate Arbitrage

```bash
perp arb rates                      # Compare rates across exchanges
perp arb scan --min 10              # Find opportunities (>10 bps spread)
perp arb auto --min-spread 30      # Auto-execute arb (daemon mode)
```

### Automated Strategies

```bash
# Grid trading
perp run grid BTC --range 5 --grids 10 --size 100

# DCA (Dollar Cost Average)
perp run dca BTC --interval 1h --size 50 --side buy

# Funding arb bot
perp run arb --min-spread 20
```

### Real-Time Streams

```bash
perp stream book BTC                # Live orderbook
perp stream trades BTC              # Live trades
perp stream funding                 # Live funding rates
```

### Cross-Exchange Tools

```bash
perp gap show                       # Price gaps between exchanges
perp gap watch --min 0.05           # Live gap monitor
perp portfolio                      # Unified portfolio view
perp risk overview                  # Cross-exchange risk assessment
perp analytics pnl                  # P&L analytics
```

### Background Jobs

```bash
perp jobs list                      # Running background jobs
perp jobs start arb                 # Start arb in background (tmux)
perp jobs stop <id>                 # Stop a job
perp jobs logs <id>                 # View job logs
```

### Alerts

```bash
perp alert add -t price -s BTC --above 100000 --telegram
perp alert add -t funding -s ETH --spread 30
perp alert daemon --interval 30
```

## AI Agent Integration

Every command supports `--json` for structured output:

```bash
# Discover capabilities
perp api-spec --json                # Full command spec for agent discovery
perp schema --json                  # CLI schema with error codes

# Machine-readable trading
perp --json -e hyperliquid market mid BTC
perp --json trade buy ETH 0.1
perp --json account positions
```

All JSON responses follow a consistent envelope:

```json
{
  "ok": true,
  "data": { ... },
  "meta": { "timestamp": "2026-03-08T..." }
}
```

Error responses:

```json
{
  "ok": false,
  "error": { "code": "INSUFFICIENT_BALANCE", "message": "...", "retryable": false },
  "meta": { "timestamp": "..." }
}
```

### Composite Plans

Multi-step atomic operations for agents:

```bash
perp plan example                   # Example plan JSON
perp plan validate plan.json        # Validate a plan
perp plan execute plan.json         # Execute multi-step plan
```

## Configuration

### Environment Variables

```bash
# Exchange keys
PRIVATE_KEY=                        # Default key (Solana base58 or EVM hex)
PACIFICA_PRIVATE_KEY=               # Pacifica (Solana)
HL_PRIVATE_KEY=                     # Hyperliquid (EVM)
LIGHTER_PRIVATE_KEY=                # Lighter (EVM)
LIGHTER_API_KEY=                    # Lighter API key (40-byte)

# Optional
DEBRIDGE_REFERRAL_CODE=             # deBridge referral
HL_REFERRAL_CODE=                   # Hyperliquid referral
```

### Settings

```bash
perp settings show                  # Current settings
perp settings referrals on          # Enable referral codes
perp settings set referralCodes.hyperliquid MYCODE
```

## Tech Stack

- **TypeScript** + Node.js (ESM)
- **Solana**: `@solana/web3.js`, `tweetnacl`, `bs58`
- **EVM**: `ethers` v6
- **Exchanges**: `hyperliquid` SDK, `lighter-sdk` (WASM), `@pacifica/sdk`
- **Bridge**: Circle CCTP V2 (Solana ↔ EVM), deBridge DLN (fallback)
- **Testing**: Vitest (780+ tests)

## License

MIT
