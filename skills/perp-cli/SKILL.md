---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to trade perps, check funding rates, bridge USDC, manage positions, scan arbitrage opportunities, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, or Lighter exchanges. Also use when user says 'set up perp trading', 'check my positions', 'buy BTC perps', 'funding rate arb', 'bridge USDC', or 'deposit to exchange'."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.3.9"
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

**If user needs a new wallet:**
```bash
perp --json wallet generate evm              # creates EVM wallet for Hyperliquid + Lighter
perp --json wallet generate solana           # creates Solana wallet for Pacifica
# IMPORTANT: Tell user the generated address so they can fund it with USDC!
```

### Hyperliquid setup
```bash
perp --json wallet set hl <EVM_PRIVATE_KEY>        # register EVM key → ready to trade immediately
perp --json wallet show                            # verify
perp --json -e hl account info                     # check balance
```
No extra steps. Key is saved as `HL_PRIVATE_KEY` in .env.

### Pacifica setup
```bash
perp --json wallet set pac <SOLANA_PRIVATE_KEY>    # register Solana key → ready to trade immediately
perp --json wallet show                            # verify
perp --json -e pac account info                    # check balance
```
No extra steps. Key is saved as `PACIFICA_PRIVATE_KEY` in .env.

### Lighter setup (API key auto-generated on registration)
```bash
perp --json wallet set lt <EVM_PRIVATE_KEY>        # register EVM key
#    → AUTOMATICALLY generates Lighter API key via on-chain tx
#    → Saves to .env: LIGHTER_PRIVATE_KEY, LIGHTER_API_KEY, LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_INDEX
#    → No manual API key creation needed. Do NOT ask the user to visit the Lighter website.
perp --json wallet show                            # verify
perp --json -e lighter account info                # check balance
```
Same EVM key can be used for both Hyperliquid and Lighter:
```bash
perp --json wallet set hl <KEY>                    # same key
perp --json wallet set lt <KEY>                    # same key, different exchange binding
```
If API key auto-setup fails (rare, e.g. no ETH for gas on Lighter chain):
```bash
perp --json -e lighter manage setup-api-key        # manual retry
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

### Symbol naming
Symbols are auto-resolved across exchanges. Use bare symbols (e.g., `BTC`, `SOL`, `ICP`) everywhere — the CLI handles exchange-specific naming:
- **Hyperliquid**: `ICP` → `ICP-PERP` (auto-resolved, `-PERP` suffix added)
- **Pacifica / Lighter**: bare symbols as-is
- `arb scan` returns bare symbols — pass them directly to any exchange command.

### Common operations
```bash
perp --json wallet show                      # check configured wallets
perp --json portfolio                        # unified multi-exchange view
perp --json arb scan --min 5                 # find funding arb opportunities (>5bps spread)
```

### Per-exchange commands (ALL 3 exchanges use the SAME commands)
Every command below works on ALL exchanges. Just change `-e`:
```bash
# Account
perp --json -e hl account info               # Hyperliquid balance & margin
perp --json -e pac account info              # Pacifica balance & margin
perp --json -e lighter account info          # Lighter balance & margin
perp --json -e <EX> account positions        # open positions

# Market data
perp --json -e <EX> market list              # available markets
perp --json -e <EX> market mid <SYM>         # mid price
perp --json -e <EX> market book <SYM>        # orderbook depth

# Trading (same syntax on ALL exchanges)
perp --json -e <EX> trade leverage <SYM> <N> --isolated   # set leverage
perp --json -e <EX> trade market <SYM> buy <SIZE>         # market buy
perp --json -e <EX> trade market <SYM> sell <SIZE>        # market sell
perp --json -e <EX> trade close <SYM>                     # close position
perp --json -e <EX> trade check <SYM> <SIDE> <SIZE> --leverage <L>  # pre-flight

# Deposit / Withdraw
perp --json deposit hyperliquid <AMOUNT>     # deposit to HL
perp --json deposit pacifica <AMOUNT>        # deposit to Pacifica
perp --json deposit lighter info             # show Lighter deposit routes
perp --json deposit lighter cctp arb <AMOUNT>  # deposit to Lighter via CCTP
perp --json withdraw <EX> <AMOUNT>           # withdraw from exchange
```
**All 3 exchanges are fully operational.** Do NOT say any exchange "requires additional setup" or "is not available" — if `wallet show` shows it configured, it's ready to trade.

### Funding arb direction (CRITICAL — do NOT reverse)
```
arb scan returns: longExch, shortExch, netSpread
→ ALWAYS follow longExch/shortExch exactly. NEVER reverse the direction.
→ NEVER enter if netSpread ≤ 0 (= loss after fees)
→ Positive funding = longs pay shorts → be SHORT to receive
→ Negative funding = shorts pay longs → be LONG to receive
```

### Trade execution (MANDATORY checklist)
```
BEFORE ANY TRADE:
0. perp --json portfolio                       → check TOTAL equity + per-exchange balances
   - Single position notional < 25% of TOTAL equity
   - Each exchange MUST have sufficient balance for its leg
   - Notional ≠ margin required. Check available balance on EACH exchange.
   - If balance is insufficient, bridge first or reduce size.

1. perp --json risk status                     → check risk level (STOP if critical)
2. perp --json -e <EX> account info            → verify EXCHANGE-SPECIFIC balance
3. perp --json -e <EX> market mid <SYM>        → current price
4. perp --json -e <EX> trade leverage <SYM> <N> --isolated → set leverage + isolated margin FIRST
5. perp --json risk check --notional <$> --leverage <L> → risk pre-check
6. perp --json -e <EX> trade check <SYM> <SIDE> <SIZE> --leverage <L> → trade validation
   ⚠ trade check does NOT read exchange-set leverage. ALWAYS pass --leverage explicitly.
7. [Show order details + risk assessment to user, get explicit confirmation]
8. perp --json -e <EX> trade market <SYM> <SIDE> <SIZE>  → execute
9. perp --json -e <EX> account positions       → verify result + check liquidation price
```

### Exchange-specific constraints
```
Minimum order values (notional, enforced by exchange):
  - Hyperliquid: $10 minimum per order
  - Pacifica: varies by symbol (usually ~$1)
  - Lighter: varies by symbol

If your calculated size falls below the minimum, increase to meet it or skip the opportunity.
trade check returns valid: true/false but is ADVISORY — it does NOT block execution.
The exchange itself will reject orders below its minimum.
```

### Arb order sizing (CRITICAL — both legs MUST match)
```
For funding arb, BOTH legs must have the EXACT SAME SIZE. Size mismatch = directional exposure.

1. Check orderbook depth on BOTH exchanges:
   perp --json -e <LONG_EX> market book <SYM>    → asks (you're buying)
   perp --json -e <SHORT_EX> market book <SYM>   → bids (you're selling)

2. Compute ORDER_SIZE:
   - fillable_long = sum of ask sizes at best 2-3 levels
   - fillable_short = sum of bid sizes at best 2-3 levels
   - ORDER_SIZE = min(fillable_long, fillable_short, desired_size)
   - Must be ≥ BOTH exchanges' minimum order value (e.g. HL requires ≥$10 notional)

3. Execute BOTH legs with the SAME ORDER_SIZE:
   perp --json -e <LONG_EX> trade market <SYM> buy <ORDER_SIZE>
   → verify fill via account positions
   perp --json -e <SHORT_EX> trade market <SYM> sell <ORDER_SIZE>
   → verify fill via account positions

4. Confirm matched: both positions must show identical size.
   If mismatch (partial fill), adjust the larger to match the smaller.
```
See `references/strategies.md` for detailed execution strategy (chunked orders, limit orders, failure handling).

### Post-entry monitoring (MANDATORY while positions are open)
```
Every 15 minutes:
  perp --json risk status                      → overall risk level + violations
  perp --json risk liquidation-distance        → % from liq price for ALL positions
  perp --json -e <EX> account positions        → check each position P&L

Every 1 hour (at funding settlement):
  perp --json arb scan --min 5                  → is spread still profitable?
  perp --json portfolio                        → total equity across exchanges
  Compare both legs' unrealized P&L — they should roughly offset

Exit triggers:
  - Spread below breakeven (including fees) → show exit plan, get user approval
  - risk status level = "critical" or canTrade = false → reduce immediately
  - One leg closed unexpectedly → close the other leg IMMEDIATELY
  - Target hold duration reached → re-evaluate or exit
```

### Knowing your capital (CHECK BEFORE ANY DECISION)
```
perp --json wallet show                        → configured wallets + addresses
perp --json wallet balance                     → on-chain USDC (in wallet, NOT on exchange)
perp --json -e <EX> account info               → exchange balance (available for trading)
perp --json portfolio                          → unified view: equity, margin, P&L per exchange
```
**On-chain balance ≠ exchange balance.** Always check both. Capital must be deposited to exchange before trading.

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
