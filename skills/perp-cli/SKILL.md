---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to trade perps, check funding rates, bridge USDC, manage positions, scan arbitrage opportunities, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, or Lighter exchanges. Also use when user says 'set up perp trading', 'check my positions', 'buy BTC perps', 'funding rate arb', 'bridge USDC', or 'deposit to exchange'."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.3.4"
  mcp-server: perp-cli
---

# perp-cli Agent Guide

Multi-DEX perpetual futures CLI — Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum).

## Critical Rules

1. **RISK MANAGEMENT IS YOUR #1 PRIORITY.** A single liquidation wipes out months of profit. Always check `perp --json risk status` before and during any operation. See `references/strategies.md` for the full risk framework.
2. **NEVER use interactive commands.** Do NOT run `perp init`. Always use non-interactive commands with `--json`.
3. **Always use `--json`** on every command for structured output.
4. **NEVER trade without user confirmation.** Show order details and wait for explicit approval.
5. **Verify wallet before any operation.** Run `perp --json wallet show` first.
6. **Use ISOLATED margin for arb.** Set `perp --json manage margin <SYM> isolated` before opening positions. Cross margin can cascade liquidations.
7. **Monitor positions continuously.** Run `perp --json risk status` and `perp --json -e <EX> account positions` every 15 minutes while positions are open.
8. **NEVER read ~/.perp/.env or any key files directly.** Private keys are managed by the CLI internally. Use `perp --json wallet show` to check wallet status. Never attempt to read, cat, or access key files — this is a security violation.

## Step 1: Install

```bash
npm install -g perp-cli
```

## Step 2: Configure Wallet

CRITICAL: Do NOT use `perp init` — it is interactive and will hang.

**If user provides a private key:**
```bash
perp --json wallet set hl <KEY>              # Hyperliquid (aliases: hl, hyperliquid)
perp --json wallet set pac <KEY>             # Pacifica (aliases: pac, pacifica)
perp --json wallet set lt <KEY>              # Lighter (aliases: lt, lighter)
perp --json wallet set hl <KEY> --default    # also set as default exchange
```

**If user needs a new wallet:**
```bash
perp --json wallet generate evm              # creates EVM wallet for Hyperliquid + Lighter
perp --json wallet generate solana           # creates Solana wallet for Pacifica
# IMPORTANT: Tell user the generated address so they can fund it with USDC!
```

**Verify setup (ALWAYS do this after any wallet command):**
```bash
perp --json wallet show
# Success: { "ok": true, "data": { "exchanges": [{ "exchange": "hyperliquid", "address": "0x..." }] } }
# Empty:   { "ok": true, "data": { "exchanges": [] } }  ← wallet not configured yet
```

## Step 3: Use

### Exchange selection
```bash
perp --json -e hyperliquid ...    # Hyperliquid (EVM)
perp --json -e pacifica ...       # Pacifica (Solana)
perp --json -e lighter ...        # Lighter (Ethereum)
```
If a default exchange is set, `-e` can be omitted.

### Common operations
```bash
perp --json wallet show                      # check configured wallets
perp --json -e hl account info               # balance & margin
perp --json -e hl account positions          # open positions
perp --json -e hl market list                # available markets
perp --json -e hl market mid BTC             # BTC mid price
perp --json arb rates                        # cross-exchange funding rates
perp --json portfolio                        # unified multi-exchange view
```

### Trade execution (MANDATORY checklist)
```
1. perp --json risk status                     → check risk level (STOP if critical)
2. perp --json -e <EX> account info            → verify balance
3. perp --json -e <EX> market mid <SYM>        → current price
4. perp --json risk check --notional <$> --leverage <L> → risk pre-check
5. perp --json -e <EX> trade check <SYM> <SIDE> <SIZE>  → trade validation
6. [Show order details + risk assessment to user, get explicit confirmation]
7. perp --json -e <EX> trade market <SYM> <SIDE> <SIZE>  → execute
8. perp --json -e <EX> account positions       → verify result + check liquidation price
```

For full command reference, see `references/commands.md`.
For agent-specific operations (setup flows, deposit/withdraw, order types, idempotency), see `references/agent-operations.md`.
For autonomous strategies (funding rate arb, risk management, opportunity cost), see `references/strategies.md`.

## Response Format

All JSON responses follow this envelope:
```json
{ "ok": true,  "data": { ... }, "meta": { "timestamp": "..." } }
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "...", "retryable": true } }
```

## Error Handling

| Code | Retryable | Action |
|------|-----------|--------|
| INSUFFICIENT_BALANCE | No | Report, suggest deposit |
| MARGIN_INSUFFICIENT | No | Suggest lower leverage or smaller size |
| SYMBOL_NOT_FOUND | No | Run `market list` for valid symbols |
| SIGNATURE_FAILED | No | Run `wallet show` to check key configuration |
| RATE_LIMITED | Yes | Wait 5s, retry once |
| EXCHANGE_UNREACHABLE | Yes | Wait 5s, retry up to 3 times |
| TIMEOUT | Yes | Retry, check network |

## Safety Guardrails

- NEVER execute trades without user confirmation
- Warn if single trade exceeds 50% of available balance
- Warn if leverage exceeds 10x
- Double-confirm bridge transfers over $1000

## Troubleshooting

### "No private key configured for <exchange>"
The wallet is not set up. Fix:
```bash
perp --json wallet set <exchange> <key>      # if user has a key
perp --json wallet generate evm              # if user needs a new EVM wallet
perp --json wallet generate solana           # if user needs a new Solana wallet
perp --json wallet show                      # verify it worked
```

### Command hangs or waits for input
You used an interactive command. NEVER use `perp init` or any command without `--json`. Cancel and retry with `--json`.

### Generated wallet has zero balance
New wallets start empty. Show the address to the user and ask them to fund it with USDC before trading.

## MCP Server (Advisor Mode)

For read-only access without CLI execution:
```json
{
  "mcpServers": {
    "perp-cli": {
      "command": "npx",
      "args": ["-y", "perp-cli", "mcp"],
      "env": {
        "HL_PRIVATE_KEY": "<evm-hex>",
        "PACIFICA_PRIVATE_KEY": "<solana-base58>"
      }
    }
  }
}
```

**MCP Tools:** get_markets, get_orderbook, get_funding_rates, get_prices, get_balance, get_positions, get_open_orders, portfolio, arb_scan, health_check, suggest_command, explain_command
