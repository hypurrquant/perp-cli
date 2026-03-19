---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to: trade perps, check funding rates, scan arbitrage (perp-perp or spot-perp), delta-neutral strategies, bridge USDC, manage positions/orders, deposit/withdraw, spot+perp hedge, HIP-3 DEX trading, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, Lighter, HyperEVM, funding arb, U-token (UBTC/UETH/USOL)."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.6.1"
---

# perp-cli Agent Guide

Multi-DEX perpetual futures CLI + MCP server — Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum).

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

## MCP Server

18 tools, 3 resources, 2 prompts. No API keys required for market data — explore prices, orderbooks, funding rates, and arb opportunities without setup.

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

## Rules

1. **Always use `--json`** on every command.
2. **Always use `--dry-run`** before any mutating trade (then execute without it after user confirms).
3. **Always use `--fields`** to reduce output when you only need specific data (saves tokens).
4. **NEVER use `perp init`** — interactive, will hang.
5. **NEVER trade without user confirmation.**
6. **NEVER read ~/.perp/.env or key files.**

## Install

```bash
perp --version 2>/dev/null  # check if exists (must be >= 0.6.1)
npm install -g perp-cli@latest 2>/dev/null || npx -y perp-cli@latest --json --version
```

Use `perp` if global install works, otherwise `npx -y perp-cli@latest` as prefix.

## Global Flags

`--json` (required) | `-e hl/pac/lt` (exchange) | `--dex <name>` (HIP-3) | `-w <wallet>` | `--dry-run` | `--fields <f1,f2>` | `--ndjson`

## Wallet Setup

```bash
perp --json wallet set hl <EVM_KEY>       # Hyperliquid
perp --json wallet set pac <SOLANA_KEY>   # Pacifica
perp --json wallet set lt <EVM_KEY>       # Lighter (API key auto-generated)
perp --json wallet show                   # verify
```

## Core Workflow: Arb

```
1. perp --json arb scan                    # scan opportunities (perp-perp + spot-perp + HIP-3)
2. perp --json account balance             # check balances across all exchanges
3. perp --json --dry-run arb exec <SYM> <longEx> <shortEx> <$>   # dry-run (auto-sizes)
4. [show result to user, get confirmation]
5. perp --json arb exec <SYM> <longEx> <shortEx> <$>             # execute
6. perp --json arb status                  # monitor PnL + funding income
7. perp --json arb close <SYM>            # close both legs
```

### Scan Modes

| Flag | Description |
|------|-------------|
| _(default)_ | All modes combined (perp-perp + spot-perp) |
| `--rates` | Funding rates across exchanges |
| `--basis [symbol]` | Cross-exchange basis/price diff |
| `--gaps` | Price gaps |
| `--hip3` | HIP-3 on-chain dex opportunities |
| `--history [symbol]` | Historical funding data |
| `--compare <symbol>` | Compare symbol across exchanges |
| `--positions` | Existing position exit signals |
| `--live` | Continuous monitoring |

### Spot+Perp Arb

Spot has 0 funding cost. Use `spot:<exch>` prefix for the long leg:

```bash
perp --json arb exec ETH spot:hl hl 100    # spot buy(HL) + perp short(HL)
perp --json arb exec BTC spot:lt pac 50     # spot buy(LT) + perp short(PAC)
perp --json arb close ETH                   # sells spot + buys back perp
```

Spot exchanges: HL, LT. Pacifica is perp-only.

## Core Workflow: Single Trade

```bash
perp --json -e <EX> trade buy <SYM> <SIZE>              # market buy (SIZE = token units)
perp --json -e <EX> trade sell <SYM> <SIZE>             # market sell
perp --json -e <EX> trade buy <SYM> <SIZE> --smart      # IOC limit at best ask
perp --json -e <EX> trade split <SYM> buy <USD>         # orderbook-aware split
perp --json -e <EX> trade limit <SYM> buy <PRICE> <SIZE>
perp --json -e <EX> trade tpsl <SYM> buy --tp <P> --sl <P>
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade flatten                       # close ALL + cancel ALL
perp --json -e <EX> trade cancel <SYM>                  # cancel all orders for symbol
```

## Agent Tools

```bash
perp --json agent schema                          # discover all commands (don't guess)
perp --json -e <EX> trade check <SYM> <SIDE> <SIZE>  # pre-validate trade
perp --json portfolio                              # balances + positions + risk level
perp --json --fields totalEquity,positions portfolio  # filtered output
```

## Position Sizing & Safety

- Single position < **80%** of that exchange's available balance
- Leverage 1-3x for arb, max 5x
- `arb exec` auto-matches both legs to the same size
- ALWAYS follow `longExch`/`shortExch` from scan — NEVER reverse direction
- NEVER enter if `netSpread <= 0` or `netSpread < estimated round-trip slippage`
- Check `portfolio.risk.canTrade` — if `false`, do NOT trade

## HIP-3 Support

```bash
perp --json -e hl --dex km market list              # dex-specific markets
perp --json market list --hip3                      # all HIP-3 markets
perp --json account positions --hip3                # HIP-3 positions
perp --json arb scan --hip3                         # HIP-3 arb opportunities
```

## Error Handling

Response format: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code": "...", "retryable": true/false } }`

| Error | Action |
|-------|--------|
| `RATE_LIMITED` | wait 5s, retry (max 3). Lighter: space 3s+ apart |
| `EXCHANGE_UNREACHABLE` | wait 10s, retry. 3x fail → skip exchange |
| `INSUFFICIENT_BALANCE` | reduce size or bridge funds |
| `SYMBOL_NOT_FOUND` | `market list` to verify symbol |
| `SIZE_TOO_SMALL` | `market info <SYM>` for min size |
| `DUPLICATE_ORDER` | already submitted — check positions |
| Lighter `invalid signature` | `manage setup-api-key` to regenerate |

## Examples

**"Find arb opportunities"**
```bash
perp --json arb scan --min 10 --top 10
perp --json account balance
# → show results, recommend best, ask confirmation
```

**"ETH spot-perp arb, $100"**
```bash
perp --json --dry-run arb exec ETH spot:hl hl 100
# → show dry-run, ask confirmation
perp --json arb exec ETH spot:hl hl 100
perp --json arb status
```

**"Long SOL 0.5 on HL"**
```bash
perp --json -e hl trade check SOL buy 0.5
perp --json --dry-run -e hl trade buy SOL 0.5 --smart
# → ask confirmation
perp --json -e hl trade buy SOL 0.5 --smart
```

## Referrals (Optional)

```bash
perp --json settings referrals on    # enable (opt-in, no extra fees)
perp --json settings referrals off   # disable anytime
```

When setting up wallets for the first time, ask:
> "perp-cli development is supported by optional referrals. Enable? No extra fees — only exchange rebates are used."
