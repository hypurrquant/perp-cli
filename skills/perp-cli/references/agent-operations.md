# Agent Operations Guide

Complete reference for non-interactive CLI operations. Every command here is safe for agents — no prompts, no hangs.

## Interactive vs Non-Interactive Commands

### NEVER use these (interactive, will hang):
```
perp init                    # interactive wizard — asks questions via stdin
perp wallet setup            # removed, but may appear in old docs
```

### ALWAYS use these (non-interactive, agent-safe):
```bash
perp --json wallet set <exchange> <key>     # set private key
perp --json wallet generate evm             # generate EVM wallet
perp --json wallet generate solana          # generate Solana wallet
perp --json wallet show                     # check configured wallets
perp --json wallet balance                  # on-chain USDC balances
perp --json -e <EX> account balance            # exchange account balance
perp --json -e <EX> account positions       # open positions
perp --json -e <EX> market list             # available markets
perp --json -e <EX> trade market ...        # execute trade
perp --json -e <EX> trade buy ...           # alias for market buy
perp --json -e <EX> trade sell ...          # alias for market sell
perp --json risk status                     # risk assessment
perp --json risk liquidation-distance       # % from liquidation for all positions
perp --json risk limits                     # view/set risk limits
perp --json risk check --notional <$> --leverage <L>  # pre-trade risk check
```

**Rule: every command MUST include `--json`.** Without it, output is human-formatted and harder to parse.

## Zero to Trading: Complete Setup Flow

### Single Exchange Setup
```bash
# 1. Install
npm install -g perp-cli

# 2. Register wallet (user provides key)
perp --json wallet set hl 0xUSER_PRIVATE_KEY

# 3. Verify
perp --json wallet show
# → check "ok": true and address appears

# 4. Check balance
perp --json -e hl account balance
# → if balance is 0, tell user to deposit USDC

# 5. Ready to trade
perp --json -e hl market list
```

### Multi-Exchange Setup (for Funding Rate Arb)
To run arb, you need wallets on AT LEAST 2 exchanges. Each exchange needs:
- A configured wallet with a private key
- USDC balance deposited on-exchange

```bash
# 1. Register both wallets
perp --json wallet set hl 0xEVM_KEY
perp --json wallet set pac SOLANA_BASE58_KEY

# 2. Verify both
perp --json wallet show
# → should show both exchanges with addresses

# 3. Check balances on both
perp --json -e hl account balance
perp --json -e pac account balance

# 4. If one side needs funding, bridge USDC
perp --json bridge quote --from solana --to arbitrum --amount 500
# → show quote to user, get confirmation
perp --json bridge send --from solana --to arbitrum --amount 500
perp --json bridge status <orderId>     # wait for completion

# 5. Verify both sides have balance, then start arb
perp --json arb scan --min 5
```

### Lighter API Key Setup
Lighter uses a separate API key for trading, but **this is handled automatically**.
When `LIGHTER_PRIVATE_KEY` is set (env var or `wallet set`), the CLI auto-generates and saves the API key on first use.

If auto-setup fails (e.g. no ETH for gas on Lighter chain), retry manually:
```bash
perp --json -e lighter manage setup-api-key
```

### Using the Same EVM Key for Multiple Exchanges
One EVM private key works for both Hyperliquid and Lighter:
```bash
perp --json wallet set hl 0xKEY
perp --json wallet set lt 0xKEY        # same key, different exchange binding
```

## Wallet Key Types

| Exchange | Chain | Key Format | Example |
|----------|-------|-----------|---------|
| Hyperliquid | EVM | Hex with 0x prefix, 66 chars | `0x4c0883a69102937d...` |
| Lighter | EVM | Hex with 0x prefix, 66 chars | `0x4c0883a69102937d...` |
| Pacifica | Solana | Base58 string | `5KQwrPbwdL6PhXu...` |

Aliases for exchange names:
- `hl` or `hyperliquid`
- `pac` or `pacifica`
- `lt` or `lighter`

## Deposit & Withdraw Flows

### Check On-Chain vs Exchange Balance
```bash
perp --json wallet balance               # on-chain USDC in your wallet
perp --json -e hl account balance           # USDC deposited on exchange
```

**On-chain balance ≠ exchange balance.** USDC in your wallet must be deposited to the exchange before trading.

### Deposit to Exchange
```bash
# Hyperliquid (from Arbitrum wallet)
perp --json funds deposit hyperliquid 100

# Pacifica (from Solana wallet)
perp --json funds deposit pacifica 100

# Lighter (multiple routes)
perp --json funds deposit lighter info         # show all available routes
perp --json funds deposit lighter cctp arbitrum 100 # via CCTP from Arbitrum
```

### Withdraw from Exchange
```bash
perp --json funds withdraw hyperliquid 100
perp --json funds withdraw pacifica 100
perp --json funds withdraw lighter 100
```

### Bridge Between Chains
When you need to move USDC between exchanges on different chains:
```bash
# 1. Withdraw from source exchange
perp --json funds withdraw pacifica 500

# 2. Quote the bridge
perp --json bridge quote --from solana --to arbitrum --amount 500

# 3. Send (after user confirmation)
perp --json bridge send --from solana --to arbitrum --amount 500

# 4. Wait for completion
perp --json bridge status <orderId>

# 5. Deposit to destination exchange
perp --json funds deposit hyperliquid 500
```

## Order Types & Execution

### Market Orders (immediate execution)
```bash
perp --json -e hl trade market BTC buy 0.01       # market buy
perp --json -e hl trade market BTC sell 0.01      # market sell
perp --json -e hl trade buy BTC 0.01              # shorthand
perp --json -e hl trade sell BTC 0.01             # shorthand
```

### Split Orders (orderbook-aware, for large orders)
```bash
perp --json -e hl trade split BTC buy 5000        # split $5000 into depth-based slices
perp --json -e hl trade split BTC sell 10000 --max-slippage 0.5 --max-slices 5
perp --json -e hl trade market BTC buy 0.5 --split   # split via market command flag
```
Returns `{ slices[], filledUsd, avgPrice, totalSlippagePct, status }`.
Status: `complete` (all filled), `partial` (some filled), `failed` (none filled).

### Limit Orders (execute at specific price)
```bash
perp --json -e hl trade buy BTC 0.01 -p 60000    # buy at $60,000
perp --json -e hl trade sell BTC 0.01 -p 70000   # sell at $70,000
```

### Close Position
```bash
perp --json -e hl trade close BTC                 # close entire position
```

### Stop Loss / Take Profit
```bash
perp --json -e hl trade sl BTC 58000              # stop loss at $58k
perp --json -e hl trade tp BTC 65000              # take profit at $65k
```

### Cancel Orders
```bash
perp --json -e hl account orders                  # list open orders
perp --json -e hl trade cancel <orderId>          # cancel specific order
```

### Pre-Flight Validation
ALWAYS run before executing a trade:
```bash
perp --json -e hl trade check BTC buy 0.01
```
This returns estimated fees, slippage, and whether the trade can execute.

## Parsing JSON Output

Every command returns this envelope:
```json
{
  "ok": true,
  "data": { ... },
  "meta": { "timestamp": "2026-03-11T..." }
}
```

Error case:
```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Not enough USDC",
    "retryable": false
  }
}
```

**Always check `ok` field first.** If `ok` is `false`, read `error.code` to decide next action. If `error.retryable` is `true`, wait 5 seconds and retry once.

## Idempotency & Safety

### Safe to retry (idempotent):
- `wallet show`, `wallet balance` — read-only
- `account balance`, `account positions`, `account orders` — read-only
- `market list`, `market mid`, `market book` — read-only
- `arb scan` — read-only (`arb rates` is deprecated)
- `portfolio`, `risk overview` — read-only
- `bridge quote` — read-only
- `bridge status` — read-only

### NOT safe to retry blindly:
- `trade market`, `trade buy`, `trade sell` — will open duplicate positions
- `trade close` — may error if already closed, but harmless
- `bridge send` — will send duplicate transfers
- `funds deposit`, `funds withdraw` — will move funds twice

**For non-idempotent commands:** always verify the result before retrying. Check positions or balances to confirm whether the first attempt succeeded.

## Symbol Naming Across Exchanges

Symbols are auto-resolved by the CLI. **Always use bare symbols** (e.g., `BTC`, `SOL`, `ICP`) — the CLI handles exchange-specific naming automatically:

| Input | Hyperliquid | Pacifica | Lighter |
|-------|-------------|----------|---------|
| `ICP` | → `ICP-PERP` | → `ICP` | → `ICP` |
| `BTC` | → `BTC` | → `BTC` | → `BTC` |
| `SOL` | → `SOL` | → `SOL` | → `SOL` |

- `arb scan` returns bare symbols — pass them directly to trade/leverage commands on any exchange.
- Do NOT manually add `-PERP` suffix — the CLI resolves this automatically.

## Exchange-Specific Constraints

| Exchange | Min Order (notional) | Notes |
|----------|---------------------|-------|
| Hyperliquid | **$10** | Rejects orders below $10 notional |
| Pacifica | ~$1 (varies by symbol) | Lower minimums |
| Lighter | Varies by symbol | Check market info |

**`trade check` is advisory only** — it returns `valid: true/false` but does NOT block execution. The exchange itself enforces minimums and will reject with an error if the order is too small.

## Common Agent Mistakes

1. **Using `perp init`** — interactive, will hang forever. Use `wallet set` instead.
2. **Forgetting `--json`** — output becomes unparseable human text.
3. **Trading with zero balance** — check `account balance` first, tell user to deposit.
4. **Retrying a trade without checking** — leads to double positions. Always check `account positions` after a trade, even if it seemed to fail.
5. **Bridging without quoting** — always run `bridge quote` first to show the user fees and estimated time.
6. **Assuming deposit is instant** — after `bridge send`, wait for `bridge status` to confirm completion before depositing to the destination exchange.
7. **Manually adding `-PERP` suffix** — the CLI auto-resolves symbols. Just use bare names like `ICP`, `SOL`, `BTC`.
8. **Order below exchange minimum** — Hyperliquid requires $10+ notional. Compute `size × price` before submitting.
