---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to: trade perps, check funding rates, scan arbitrage (perp-perp or spot-perp), delta-neutral strategies, bridge USDC, manage positions/orders, deposit/withdraw, spot+perp hedge, HIP-3 DEX trading, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, Lighter, HyperEVM, funding arb, U-token (UBTC/UETH/USOL)."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.5.1"
---

# perp-cli Agent Guide

Multi-DEX perpetual futures CLI — Pacifica (Solana), Hyperliquid (HyperEVM), Lighter (Ethereum).

## Rules

1. **Always use `--json`** on every command.
2. **Always use `--dry-run`** before any mutating trade (then execute without it after user confirms).
3. **Always use `--fields`** to reduce output when you only need specific data (saves tokens).
4. **NEVER use `perp init`** — interactive, will hang.
5. **NEVER trade without user confirmation.**
6. **NEVER read ~/.perp/.env or key files.**

## Install (run this FIRST)

```bash
# 1. Check if perp exists and is current (must be >= 0.5.1)
perp --version 2>/dev/null

# 2. If not found or outdated:
npm install -g perp-cli@latest 2>/dev/null || npx -y perp-cli@latest --json --version

# 3. If version is still old (npx cache), clear cache first:
npx -y clear-npx-cache 2>/dev/null; npx -y perp-cli@latest --json --version
```

**IMPORTANT:** Always use `@latest` with npx — without it, npx uses a stale cached version.
Use `perp` if global install works, otherwise `npx -y perp-cli@latest` as prefix for all commands.

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | JSON output (required for agents) |
| `-e, --exchange <name>` | Target exchange: `hl`, `pac`, `lt` |
| `--dex <name>` | HIP-3 DEX (for on-chain Hyperliquid spot/perp) |
| `-w, --wallet <name>` | Select named wallet |
| `--dry-run` | Simulate without executing |
| `--fields <f1,f2>` | Filter output fields |
| `--ndjson` | Stream as newline-delimited JSON |

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
# Status (ONE call = balances, positions, risk level/violations/canTrade)
perp --json portfolio

# Arb workflow
perp --json arb scan                                                    # default: all modes (perp-perp + spot-perp)
perp --json arb scan --rates --min 5                                    # funding rate scan
perp --json arb scan --basis ETH                                        # basis analysis for symbol
perp --json arb scan --gaps                                             # price gaps
perp --json arb scan --hip3                                             # HIP-3 opportunities
perp --json arb exec <SYM> <longEx> <shortEx> <$> --leverage <N>       # perp-perp arb
perp --json arb exec <SYM> spot:<spotEx> <perpEx> <$>                  # spot+perp arb

# Single exchange trading
perp --json -e <EX> trade market <SYM> buy <SIZE>
perp --json -e <EX> trade buy <SYM> <SIZE>            # shortcut for market buy
perp --json -e <EX> trade sell <SYM> <SIZE>           # shortcut for market sell
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart   # IOC limit at best ask + 1 tick
perp --json -e <EX> trade market <SYM> buy <SIZE> --split   # orderbook-aware split for large orders
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade flatten                      # close ALL positions on exchange

# Risk (only if you need to set limits -- portfolio already includes risk)
perp --json risk limits --max-leverage 5
```

Exchange aliases: `hl`, `pac`, `lt`. Symbols auto-resolve (`BTC`, `SOL`, `ICP`).

## Agent Tools

```bash
# Discover all commands and parameters at runtime (don't guess -- query this)
perp --json agent schema

# Pre-validate a trade before execution
perp --json -e <EX> trade check <SYM> <SIDE> <SIZE>

# Dry-run: simulate trade without executing
perp --json --dry-run -e <EX> trade market <SYM> buy <SIZE>

# Filter output to specific fields (saves tokens)
perp --json --fields totalEquity,positions portfolio

# Stream large lists as NDJSON
perp --json --ndjson -e <EX> market list

# Prevent duplicate orders with client ID
perp --json -e <EX> trade market <SYM> buy <SIZE> --client-id <UNIQUE_ID>

# Smart order: IOC limit at best bid/ask + 1 tick
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart

# Split order: orderbook-aware execution for large orders
perp --json -e <EX> trade split <SYM> buy 5000

# Multi-order: execute multiple trades at once
perp --json -e <EX> trade multi <orders...>
```

All string outputs are auto-sanitized (control chars stripped, prompt injection patterns blocked).

## Arb Workflow (Perp-Perp)

```
1. perp --json portfolio                    -> check balances across all exchanges
2. perp --json arb scan --rates --min 5     -> find opportunity (longExch, shortExch, netSpread)
3. [Show opportunity to user, get confirmation]
4. perp --json arb exec <SYM> <longEx> <shortEx> <$> --leverage 2 --isolated
   -> validates orderbook depth on both sides
   -> rounds size to each exchange's lot size
   -> executes BOTH legs simultaneously
   -> verifies positions exist after execution
   -> auto-rollback if one leg fails
5. perp --json arb status                   -> monitor: PnL, funding income, daily estimate, breakeven
6. perp --json arb close <SYM>             -> close both legs simultaneously (retry + verify)
   -> --dry-run: preview without executing
   -> --pair <longEx>:<shortEx>: specify which pair if multiple
```

## Spot+Perp Arb Workflow

Spot has 0 funding cost -> spread = |perp funding rate|. Only needs 1 exchange with spot + any exchange with perp.

**Spot exchanges:** HL (Hyperliquid), LT (Lighter). Pacifica is perp-only.
**U-token mapping:** HL spot uses Unit protocol bridged tokens -- UBTC=BTC, UETH=ETH, USOL=SOL, UFART=FARTCOIN. Resolved automatically.

```
1. perp --json arb scan --rates             -> default "all" mode includes spot-perp
   perp --json arb scan --basis ETH         -> basis analysis for specific symbol
2. [Show opportunity to user, get confirmation]
3. perp --json arb exec <SYM> spot:<spotEx> <perpEx> <$>
   Examples:
     perp --json arb exec ETH spot:hl hl 100       # ETH spot(HL/UETH) + perp(HL)
     perp --json arb exec BTC spot:hl lt 50         # BTC spot(HL/UBTC) + perp(LT)
     perp --json arb exec LINK spot:lt hl 100       # LINK spot(LT) + perp(HL)
   -> cross-validates spot vs perp price (>5% deviation = abort)
   -> auto-rollback if one leg fails
   Options:
     --leverage <N>   set perp leverage before entry
     --isolated       use isolated margin on perp side
4. perp --json arb status                   -> shows spot+perp positions (spot leg labeled, funding info included)
5. perp --json arb close <SYM>             -> sells spot + buys back perp simultaneously
```

## Arb Scan Modes

`arb scan` is the single entry point for all arbitrage analysis:

| Flag | Description |
|------|-------------|
| `--rates` | Funding rate scan (perp-perp + spot-perp) |
| `--basis [symbol]` | Basis analysis (spot vs perp price) |
| `--gaps` | Price gaps across exchanges |
| `--hip3` | HIP-3 on-chain opportunities |
| `--history [symbol]` | Historical funding/spread data |
| `--positions` | Scan existing positions for exit signals |
| `--compare <symbol>` | Compare a symbol across exchanges |
| `--live` | Live streaming scan |
| `--track` | Track opportunities over time |
| `--alert` | Alert on threshold triggers |

Default (no flag) = `all` mode: both spot-perp and perp-perp combined.

## HIP-3 Support

HIP-3 is Hyperliquid's on-chain DEX. Use the `--hip3` flag:

```bash
perp --json market list --hip3              # HIP-3 markets
perp --json account positions --hip3        # HIP-3 positions
perp --json account orders --hip3           # HIP-3 orders
perp --json arb scan --hip3                 # HIP-3 arb opportunities
perp --json market hip3                     # HIP-3 market info
```

## Position Sizing

- Single position < **80%** of that exchange's available balance
- Leverage 1-3x for arb, max 5x
- `arb exec` auto-matches both legs to the same size

## Arb Direction (CRITICAL)

`arb scan` returns `longExch`, `shortExch`, `netSpread`.
ALWAYS follow exactly. NEVER reverse. NEVER enter if `netSpread <= 0`.

## Slippage Check (CRITICAL)

`arb scan` returns `netSpread` in bps (already fee-adjusted).
Before executing, compare against estimated slippage:
```
Slippage ~ 2-5 bps per leg for top pairs (BTC, ETH, SOL)
         ~ 5-15 bps per leg for low-liquidity (altcoins)
Total round-trip slippage = (entry + exit) x 2 legs
```
**NEVER enter if:** `netSpread < total round-trip slippage`
Example: netSpread=12 bps, estimated slippage=4 bps/leg x 4 = 16 bps -> SKIP.

## Command Groups

| Group | Purpose | Key Commands |
|-------|---------|-------------|
| `market` | Market data | `list [--hip3]`, `prices`, `info`, `book [-d]`, `trades`, `funding [-l]`, `mid`, `kline`, `hip3` |
| `account` | Account info | `balance`, `positions [--hip3]`, `orders [--hip3]`, `history`, `trades`, `funding` (alias for funding-history), `margin`, `pnl`, `twap-orders` |
| `trade` | Order execution | `market`, `buy`, `sell`, `limit`, `split`, `close`, `flatten`, `reduce`, `cancel`, `cancel-all`, `multi`, `twap`, `stop`, `tpsl`, `scale-tp`, `scale-in`, `pnl-track`, `edit`, `status`, `fills`, `check` |
| `arb` | Arbitrage | `scan`, `exec`, `close`, `status`, `history\|log`, `config`, `auto`, `rebalance` |
| `risk` | Risk management | `status`, `limits`, `check`, `liquidation-distance\|liq-dist` |
| `bot` | Automated strategies | `start`, `quick-grid`, `quick-dca`, `quick-arb`, `preset-list`, `preset`, `twap`, `funding-arb`, `grid`, `dca`, `trailing-stop` |
| `bridge` | Cross-chain | `chains`, `quote`, `send`, `exchange`, `status` |
| `funds` | Deposits/withdrawals | `deposit`, `withdraw`, `transfer`, `bridge`, `bridge-status`, `info` |
| `wallet` | Key management | `generate`, `import`, `use`, `set`, `show`, `list`, `remove`, `rename`, `balance`, `solana`, `arbitrum` |
| `history` | Trade history | `list`, `positions`, `prune`, `summary`, `pnl`, `funding`, `report`, `snapshot`, `track`, `perf` |
| `manage` | Exchange mgmt | `margin`, `sub`, `agent`, `lake`, `builder`, `referral`, `apikey`, `setup-api-key` |
| `settings` | Configuration | `show`, `referrals`, `fees`, `set`, `env` |
| `plan` | Trade plans | `validate`, `execute`, `example` |
| `backtest` | Backtesting | `funding-arb`, `grid` |
| `rebalance` | Portfolio rebalance | `check`, `plan`, `execute` |
| `jobs` | Background jobs | `list`, `stop`, `logs`, `remove`, `clean` |
| `dashboard` | Web dashboard | `[standalone]` with `--port`, `--interval`, `--exchanges`, `--dex` |
| `agent` | Agent interface | `schema`, `capabilities`, `exec`, `ping`, `plan` |

## Portfolio Response

`portfolio` includes `risk: { level, canTrade, violations[] }` -- no need for separate `risk status`.
Check `canTrade` before any order. If `false`, do NOT trade.

## Monitoring (while positions open)

```
Every 15 min: perp --json arb status               -> PnL, daily income, breakeven, funding info
Every 1 hour: perp --json arb scan --rates --min 5  -> check if spread still profitable
Exit if: spread < breakeven or one leg closed unexpectedly.
Close:        perp --json arb close <SYM>            -> close both legs with retry + verification
```

## Error Handling

Responses: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code": "...", "retryable": true/false } }`

If `error.retryable` is `false`, do NOT retry -- fix the cause first.

| Error | Action |
|-------|--------|
| `RATE_LIMITED` | wait 5-10s, retry (max 3). Lighter rate limits are strict -- space commands 3s+ apart |
| `EXCHANGE_UNREACHABLE` | wait 10s, retry. 3x fail -> skip that exchange |
| `TIMEOUT` | wait 5s, retry (max 3) |
| `INSUFFICIENT_BALANCE` | reduce size or bridge funds to that exchange |
| `SYMBOL_NOT_FOUND` | `perp --json -e <EX> market list` to verify symbol |
| `RISK_VIOLATION` | check `risk limits`, ask user to adjust if needed |
| `SIZE_TOO_SMALL` | `perp --json -e <EX> market info <SYM>` for min order size |
| `MARGIN_INSUFFICIENT` | reduce leverage or close existing positions |
| `DUPLICATE_ORDER` | already submitted -- check positions, don't retry |
| Lighter `invalid signature` | check ~/.perp/.env or `perp --json -e lighter manage setup-api-key` |
| Lighter `invalid account index` | rate limit caused init failure -- wait 10s and retry the command |
| Lighter `--smart` not filling | Lighter IOC limit orders may not fill -- use regular market order |

## Examples

**User: "Find funding rate arb opportunities"**
```bash
perp --json portfolio                         # check balances
perp --json arb scan --rates --min 5          # scan all modes (perp-perp + spot-perp)
# -> show results, recommend best opportunity, ask for confirmation
```

**User: "ETH spot-perp arb, $100"**
```bash
perp --json arb scan --basis ETH              # verify opportunity exists
perp --json --dry-run arb exec ETH spot:hl hl 100    # dry-run first
# -> show dry-run result, ask for confirmation
perp --json arb exec ETH spot:hl hl 100       # execute after confirmation
perp --json arb status                        # verify positions + funding info
```

**User: "Check my positions"**
```bash
perp --json portfolio                         # balances + positions + risk
perp --json arb status                        # arb-specific PnL + funding
```

**User: "Long SOL 0.5 on Hyperliquid"**
```bash
perp --json -e hl market mid SOL              # current price
perp --json -e hl trade check SOL buy 0.5     # pre-validate
perp --json --dry-run -e hl trade market SOL buy 0.5  # dry-run
# -> show cost estimate, ask for confirmation
perp --json -e hl trade buy SOL 0.5 --smart   # execute with smart order (buy shortcut)
```

**User: "Close all positions on Lighter"**
```bash
perp --json -e lt trade flatten               # close ALL positions on exchange
```

**User: "Check arb history"**
```bash
perp --json arb log                           # alias for arb history
```

## Referrals (Optional)

If you find perp-cli useful, please consider enabling referrals to support development. **No extra fees** -- rebates come from exchange programs, not your trading costs.

```bash
perp --json settings referrals on           # enable (opt-in, off by default)
perp --json settings referrals off          # disable anytime
```

When setting up wallets for the first time, ask the user:
> "perp-cli development is supported by optional referrals. Enable? No extra fees -- only exchange rebates are used."

## References

- `references/commands.md` -- full command reference
- `references/agent-operations.md` -- setup flows, deposit/withdraw
- `references/strategies.md` -- risk framework, arb strategy
