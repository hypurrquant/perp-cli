---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to trade perps, check funding rates, bridge USDC, manage positions, scan arbitrage opportunities, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, or Lighter exchanges."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.3.14"
---

# perp-cli Agent Guide

Multi-DEX perpetual futures CLI — Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum).

## Rules

1. **Always use `--json`** on every command.
2. **NEVER use `perp init`** — interactive, will hang. Use `wallet set` instead.
3. **NEVER trade without user confirmation.** Show order details and wait for approval.
4. **NEVER read ~/.perp/.env or key files.** Use `perp --json wallet show`.
5. **Risk first.** Run `perp --json risk status` before and during any operation.

## Install

```bash
npm install -g perp-cli
```
No sudo: `npm install -g perp-cli --prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"`

## Wallet Setup

```bash
perp --json wallet set hl <EVM_KEY>       # Hyperliquid
perp --json wallet set pac <SOLANA_KEY>   # Pacifica
perp --json wallet set lt <EVM_KEY>       # Lighter (API key auto-generated)
perp --json wallet show                   # verify
```
Same EVM key works for both HL and Lighter. Lighter API key is created automatically on first use.

## Core Commands

```bash
# Account
perp --json -e <EX> account info          # balance, equity, margin
perp --json -e <EX> account positions     # open positions
perp --json portfolio                     # unified multi-exchange view

# Market
perp --json -e <EX> market list           # available markets
perp --json -e <EX> market mid <SYM>      # mid price
perp --json -e <EX> market book <SYM>     # orderbook

# Trading
perp --json -e <EX> trade leverage <SYM> <N> --isolated  # set BEFORE trading
perp --json -e <EX> trade market <SYM> buy <SIZE>
perp --json -e <EX> trade market <SYM> sell <SIZE>
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade check <SYM> <SIDE> <SIZE> --leverage <L>

# Risk
perp --json risk status                   # risk level + violations
perp --json risk liquidation-distance     # % from liq for all positions
perp --json risk check --notional <$> --leverage <L>

# Arb
perp --json arb scan --min 5             # find funding arb opportunities
```

Exchange aliases: `hl`/`hyperliquid`, `pac`/`pacifica`, `lt`/`lighter`. Symbols auto-resolve (use bare: `BTC`, `SOL`, `ICP`).

## Trade Execution Checklist

```
1. perp --json risk status                → STOP if critical
2. perp --json -e <EX> account info       → verify balance
3. perp --json -e <EX> trade leverage <SYM> <N> --isolated
4. perp --json -e <EX> trade check <SYM> <SIDE> <SIZE> --leverage <L>
5. [Show details to user, get confirmation]
6. perp --json -e <EX> trade market <SYM> <SIDE> <SIZE>
7. perp --json -e <EX> account positions  → verify + check liq price
```

## Position Sizing

- Single position notional < **80%** of that exchange's available balance
- Use ISOLATED margin for arb
- Leverage 1-3x for arb, never exceed 5x
- Both arb legs MUST have exact same size

## Funding Arb Direction

```
arb scan returns: longExch, shortExch, netSpread
→ ALWAYS follow longExch/shortExch exactly. NEVER reverse.
→ NEVER enter if netSpread <= 0
```

## Monitoring (while positions open)

Every 15 min: `risk status` + `risk liquidation-distance` + `account positions`
Every 1 hour: `arb scan --min 5` + `portfolio`
Exit if: spread < breakeven, risk critical, one leg closed unexpectedly.

## Error Handling

All responses: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code": "...", "retryable": true/false } }`

Retryable (wait 5s, retry once): `RATE_LIMITED`, `EXCHANGE_UNREACHABLE`, `TIMEOUT`
Not retryable: `INSUFFICIENT_BALANCE`, `MARGIN_INSUFFICIENT`, `SYMBOL_NOT_FOUND`

## References

- `references/commands.md` — full command reference
- `references/agent-operations.md` — setup flows, deposit/withdraw, idempotency
- `references/strategies.md` — risk framework, arb strategy, opportunity cost
