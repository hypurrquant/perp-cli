---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to trade perps, check funding rates, bridge USDC, manage positions, scan arbitrage opportunities, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, or Lighter exchanges."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.3.16"
---

# perp-cli Agent Guide

Multi-DEX perpetual futures CLI — Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum).

## Rules

1. **Always use `--json`** on every command.
2. **NEVER use `perp init`** — interactive, will hang.
3. **NEVER trade without user confirmation.**
4. **NEVER read ~/.perp/.env or key files.**

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
Same EVM key works for both HL and Lighter.

## Key Commands

```bash
# Status (ONE call = all exchanges, balances, positions, risk)
perp --json portfolio

# Arb workflow
perp --json arb scan --min 5                                    # find opportunities
perp --json arb exec <SYM> <longEx> <shortEx> <$> --leverage <N> --isolated  # execute

# Single exchange trading (when not doing arb)
perp --json -e <EX> trade market <SYM> buy <SIZE>
perp --json -e <EX> trade close <SYM>

# Risk
perp --json risk status
```

Exchange aliases: `hl`, `pac`, `lt`. Symbols auto-resolve (`BTC`, `SOL`, `ICP`).

## Arb Workflow

```
1. perp --json portfolio                    → check balances across all exchanges
2. perp --json arb scan --min 5             → find opportunity (longExch, shortExch, netSpread)
3. [Show opportunity to user, get confirmation]
4. perp --json arb exec <SYM> <longEx> <shortEx> <$> --leverage 2 --isolated
   → validates orderbook depth on both sides
   → rounds size to each exchange's lot size
   → executes BOTH legs simultaneously
   → verifies positions exist after execution
   → auto-rollback if one leg fails
5. perp --json portfolio                    → verify positions
```

## Position Sizing

- Single position < **80%** of that exchange's available balance
- Leverage 1-3x for arb, max 5x
- `arb exec` auto-matches both legs to the same size

## Arb Direction (CRITICAL)

`arb scan` returns `longExch`, `shortExch`, `netSpread`.
ALWAYS follow exactly. NEVER reverse. NEVER enter if `netSpread <= 0`.

## Monitoring (while positions open)

```
Every 15 min: perp --json portfolio
Every 1 hour: perp --json arb scan --min 5
Exit if: spread < breakeven or one leg closed unexpectedly.
Close both: perp --json -e <EX1> trade close <SYM> & perp --json -e <EX2> trade close <SYM>
```

## Error Handling

Responses: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code": "...", "retryable": true/false } }`

Retryable (wait 5s): `RATE_LIMITED`, `EXCHANGE_UNREACHABLE`, `TIMEOUT`
**Lighter `invalid signature`**: `perp --json -e lighter manage setup-api-key`

## References

- `references/commands.md` — full command reference
- `references/agent-operations.md` — setup flows, deposit/withdraw
- `references/strategies.md` — risk framework, arb strategy
