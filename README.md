# perp-cli

Multi-DEX perpetual futures CLI — **Pacifica** (Solana), **Hyperliquid** (HyperEVM), **Lighter** (Ethereum).

```bash
npm install -g perp-cli       # global install
perp --json portfolio

# Or without global install (restricted environments)
npx -y perp-cli --json portfolio
```

## Features

- **3 Exchanges** — trade, bridge, arbitrage across Pacifica, Hyperliquid, Lighter
- **Funding Rate Arb** — perp-perp + spot-perp scan & one-command dual-leg execution
- **Portfolio** — single call returns balances, positions, risk level across all exchanges
- **Funds** — deposit, withdraw, CCTP bridge, internal transfer in one group
- **Bots** — TWAP, grid, DCA, trailing-stop with background job management
- **Agent-First Design** — `--json`, `--fields`, `--ndjson`, `--dry-run`, runtime schema introspection
- **Safety** — pre-trade validation, response sanitization, client-id deduplication

## Setup

```bash
# Set exchange keys
perp wallet set hl <EVM_KEY>         # Hyperliquid
perp wallet set pac <SOLANA_KEY>     # Pacifica
perp wallet set lt <EVM_KEY>         # Lighter (API key auto-generated)

# Verify
perp wallet show
```

Same EVM key works for both Hyperliquid and Lighter.

> **Lighter API Key Index:** Indexes 0–3 are reserved by Lighter's frontend (web/mobile). perp-cli defaults to index `4`. Override with `LIGHTER_API_KEY_INDEX` env var or `--key-index` flag on `manage setup-api-key`. Valid range: 4–254.

## Command Groups

| Group | Description |
|-------|-------------|
| `market` | Prices, orderbook, funding, klines, HIP-3 dexes |
| `account` | Balance, positions, orders, margin |
| `trade` | Market/limit/stop orders, close, scale, split execution |
| `arb` | Funding rate arb — scan, exec, close, monitor (perp-perp & spot-perp) |
| `bot` | TWAP, grid, DCA, trailing-stop bots |
| `funds` | Deposit, withdraw, transfer, CCTP bridge |
| `bridge` | Cross-chain USDC bridge (deBridge DLN) |
| `risk` | Risk limits, liquidation distance, guardrails |
| `wallet` | Multi-wallet management & on-chain balances |
| `history` | Execution log, PnL, performance breakdown |
| `manage` | Margin mode, subaccount, API keys, builder |
| `portfolio` | Cross-exchange unified overview |
| `dashboard` | Live web dashboard |
| `settings` | CLI settings (referrals, defaults) |
| `backtest` | Strategy backtesting |
| `plan` | Multi-step composite execution plans |
| `rebalance` | Cross-exchange balance management |
| `jobs` | Background job management (tmux) |
| `agent` | Schema introspection, capabilities, health check |

## Core Commands

```bash
# Portfolio (balances + positions + risk across all exchanges)
perp --json portfolio

# Market data
perp --json -e <EX> market list
perp --json -e <EX> market book <SYM>
perp --json -e <EX> market funding <SYM>

# Trading
perp --json -e <EX> trade market <SYM> buy <SIZE>
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart      # IOC limit at best bid/ask (less slippage)
perp --json -e <EX> trade split <SYM> buy 5000                 # orderbook-aware split (large orders)
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade leverage <SYM> <N>

# Funding rate arbitrage
perp --json arb scan --min 5                                              # perp-perp opportunities
perp --json arb scan --mode spot-perp                                     # spot+perp opportunities
perp --json arb exec <SYM> <longEx> <shortEx> <$> --leverage 2 --isolated # execute both legs
perp --json arb spot-exec <SYM> <spotEx> <perpEx> <$>                     # spot+perp entry

# Funds (deposit, withdraw, transfer)
perp --json funds deposit hyperliquid 100
perp --json funds withdraw pacifica 50
perp --json funds transfer 100 <ADDRESS>          # HL internal transfer
perp --json funds info                            # all routes & limits

# Risk
perp --json risk limits --max-leverage 5
perp --json risk liquidation-distance

# Bots
perp --json bot twap <SYM> buy <SIZE> 30m
perp --json bot grid <SYM> --range 5 --grids 10 --size 100

# Bridge (cross-chain USDC)
perp --json bridge quote --from solana --to arbitrum --amount 100
perp --json bridge send --from solana --to arbitrum --amount 100
```

Exchange flags: `-e hyperliquid`, `-e pacifica`, `-e lighter` (aliases: `hl`, `pac`, `lt`).

## AI Agent Skill

Install as a skill for Claude Code, Cursor, Codex, Gemini CLI, etc.:

```bash
# Using npx (recommended)
npx skills add hypurrquant/perp-cli

# Or via Claude Code slash command
/install-skill hypurrquant/perp-cli
```

See [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md) for the full agent guide.

## Agent-First CLI Design

Built following [agent-first CLI principles](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/):

```bash
# Every command returns structured JSON envelope
perp --json portfolio
# → { "ok": true, "data": {...}, "meta": { "timestamp": "..." } }

# Runtime schema introspection (don't guess commands — query this)
perp --json agent schema

# Filter output to specific fields (saves tokens)
perp --json --fields totalEquity,risk portfolio

# Stream large lists as NDJSON (one JSON per line)
perp --json --ndjson -e hl market list

# Pre-validate before executing
perp --json -e hl trade check BTC buy 0.01
perp --json --dry-run -e hl trade market BTC buy 0.01

# Idempotent orders with client ID
perp --json -e hl trade market BTC buy 0.01 --client-id my-unique-id
```

All responses are auto-sanitized (control chars stripped, prompt injection patterns blocked).
Errors include `retryable` flag — only retry when `true`.

## License

MIT
