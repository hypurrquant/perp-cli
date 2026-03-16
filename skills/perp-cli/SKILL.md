---
name: perp-cli
description: "Multi-DEX perpetual futures trading CLI for Pacifica (Solana), Hyperliquid (EVM), and Lighter (Ethereum). Use when user asks to: trade perps, check funding rates, scan arbitrage (perp-perp or spot-perp), delta-neutral strategies, bridge USDC, manage positions/orders, deposit/withdraw, spot+perp hedge, or mentions perp-cli, hypurrquant, Pacifica, Hyperliquid, Lighter, HyperEVM, funding arb, U-token (UBTC/UETH/USOL)."
allowed-tools: "Bash(perp:*), Bash(npx perp-cli:*), Bash(npx -y perp-cli:*)"
license: MIT
metadata:
  author: hypurrquant
  version: "0.4.9"
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
# 1. Check if perp exists and is current (must be ≥ 0.3.19)
perp --version 2>/dev/null

# 2. If not found or outdated:
npm install -g perp-cli@latest 2>/dev/null || npx -y perp-cli@latest --json --version

# 3. If version is still old (npx cache), clear cache first:
npx -y clear-npx-cache 2>/dev/null; npx -y perp-cli@latest --json --version
```

**IMPORTANT:** Always use `@latest` with npx — without it, npx uses a stale cached version.
Use `perp` if global install works, otherwise `npx -y perp-cli@latest` as prefix for all commands.

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
perp --json arb scan --min 5                                    # find opportunities
perp --json arb exec <SYM> <longEx> <shortEx> <$> --leverage <N> --isolated  # execute

# Single exchange trading (when not doing arb)
perp --json -e <EX> trade market <SYM> buy <SIZE>
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart  # IOC limit at best ask + 1 tick (less slippage)
perp --json -e <EX> trade market <SYM> buy <SIZE> --split  # orderbook-aware split for large orders
perp --json -e <EX> trade split <SYM> buy 5000             # dedicated split command (USD notional)
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade close <SYM> --smart              # smart close at best bid/ask

# Risk (only if you need to set limits — portfolio already includes risk)
perp --json risk limits --max-leverage 5
```

Exchange aliases: `hl`, `pac`, `lt`. Symbols auto-resolve (`BTC`, `SOL`, `ICP`).

## Agent Tools

```bash
# Discover all commands and parameters at runtime (don't guess — query this)
perp --json agent schema

# Pre-validate a trade before execution (checks balance, liquidity, risk limits)
perp --json -e <EX> trade check <SYM> <SIDE> <SIZE>

# Dry-run: simulate trade without executing
perp --json --dry-run -e <EX> trade market <SYM> buy <SIZE>

# Filter output to specific fields (saves tokens)
perp --json --fields totalEquity,positions portfolio

# Stream large lists as NDJSON (one JSON per line, no buffering)
perp --json --ndjson -e <EX> market list

# Prevent duplicate orders with client ID
perp --json -e <EX> trade market <SYM> buy <SIZE> --client-id <UNIQUE_ID>

# Smart order: IOC limit at best bid/ask + 1 tick instead of raw market order
# Fills only at top-of-book price — no multi-level sweep slippage
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart
perp --json -e <EX> trade close <SYM> --smart
perp --json arb exec <SYM> <longEx> <shortEx> <$> --smart   # smart arb entry
perp --json arb close <SYM> --smart                          # smart arb close

# Split order: orderbook-aware execution for large orders
# Reads depth before each slice, IOC limit within slippage tolerance
perp --json -e <EX> trade split <SYM> buy 5000               # split $5000 into depth-based slices
perp --json -e <EX> trade split <SYM> sell 10000 --max-slices 5 --delay 2000
perp --json -e <EX> trade market <SYM> buy <SIZE> --split     # split via market command flag
```

All string outputs are auto-sanitized (control chars stripped, prompt injection patterns blocked).

## Arb Workflow (Perp-Perp)

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
5. perp --json arb status                   → monitor: PnL, funding income, daily estimate, breakeven
6. perp --json arb funding-earned           → actual funding payments received/paid + APR
7. perp --json arb close <SYM>             → close both legs simultaneously (retry + verify)
   → --dry-run: preview without executing
   → --pair <longEx>:<shortEx>: specify which pair if multiple
```

## Spot+Perp Arb Workflow

Spot has 0 funding cost → spread = |perp funding rate|. Only needs 1 exchange with spot + any exchange with perp.

**Spot exchanges:** HL (Hyperliquid), LT (Lighter). Pacifica is perp-only.
**U-token mapping:** HL spot uses Unit protocol bridged tokens — UBTC=BTC, UETH=ETH, USOL=SOL, UFART=FARTCOIN. Resolved automatically.

```
1. perp --json arb scan --mode spot-perp    → find spot+perp opportunities
   perp --json arb scan --mode all          → perp-perp + spot-perp combined
2. [Show opportunity to user, get confirmation]
3. perp --json arb spot-exec <SYM> <spotEx> <perpEx> <$>
   Examples:
     perp --json arb spot-exec ETH hl hl 100        # ETH spot(HL/UETH) + perp(HL)
     perp --json arb spot-exec BTC hl lt 50          # BTC spot(HL/UBTC) + perp(LT)
     perp --json arb spot-exec LINK lt hl 100        # LINK spot(LT) + perp(HL)
   → cross-validates spot vs perp price (>5% deviation = abort, wrong token)
   → sequential execution if same exchange (nonce collision avoidance)
   → parallel execution if different exchanges
   → auto-rollback if one leg fails
   Options:
     --leverage <N>   set perp leverage before entry
     --isolated       use isolated margin on perp side
4. perp --json arb status                   → shows spot-perp positions (spot leg labeled)
5. perp --json arb spot-close <SYM> --spot-exch <hl|lt>
   → sells spot + buys back perp simultaneously
```

**Available spot+perp pairs (13):**
- HL spot: BTC (UBTC), ETH (UETH), SOL (USOL), FARTCOIN (UFART), HYPE, AZTEC, STABLE
- LT spot: ETH, AZTEC, AAVE, LINK, UNI, LIT, LDO, SKY
- All have perps on HL and LT. Pacifica perps available when API is up.

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
Slippage ≈ 2-5 bps per leg for top pairs (BTC, ETH, SOL)
         ≈ 5-15 bps per leg for low-liquidity (altcoins)
Total round-trip slippage = (entry + exit) × 2 legs
```
**NEVER enter if:** `netSpread < total round-trip slippage`
Example: netSpread=12 bps, estimated slippage=4 bps/leg × 4 = 16 bps → SKIP.

## Portfolio Response

`portfolio` includes `risk: { level, canTrade, violations[] }` — no need for separate `risk status`.
Check `canTrade` before any order. If `false`, do NOT trade.

## Monitoring (while positions open)

```
Every 15 min: perp --json arb status               → PnL, daily income, breakeven analysis
Every 1 hour: perp --json arb scan --min 5          → check if spread still profitable
Daily:        perp --json arb funding-earned         → verify actual funding payments
Exit if: spread < breakeven or one leg closed unexpectedly.
Close:        perp --json arb close <SYM>            → close both legs with retry + verification
```

## Error Handling

Responses: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code": "...", "retryable": true/false } }`

If `error.retryable` is `false`, do NOT retry — fix the cause first.

| Error | Action |
|-------|--------|
| `RATE_LIMITED` | wait 5-10s, retry (max 3). Lighter rate limits are strict — space commands 3s+ apart |
| `EXCHANGE_UNREACHABLE` | wait 10s, retry. 3x fail → skip that exchange |
| `TIMEOUT` | wait 5s, retry (max 3) |
| `INSUFFICIENT_BALANCE` | reduce size or bridge funds to that exchange |
| `SYMBOL_NOT_FOUND` | `perp --json -e <EX> market list` to verify symbol |
| `RISK_VIOLATION` | check `risk limits`, ask user to adjust if needed |
| `SIZE_TOO_SMALL` | `perp --json -e <EX> market info <SYM>` for min order size |
| `MARGIN_INSUFFICIENT` | reduce leverage or close existing positions |
| `DUPLICATE_ORDER` | already submitted — check positions, don't retry |
| Lighter `invalid signature` | check ~/.perp/.env or `perp --json -e lighter manage setup-api-key` |
| Lighter `invalid account index` | rate limit caused init failure — wait 10s and retry the command |
| Lighter `--smart` not filling | Lighter IOC limit orders may not fill — use regular market order (without `--smart`) |

## Examples

**User: "펀딩레이트 아비트라지 기회 찾아줘"**
```bash
perp --json portfolio                         # check balances
perp --json arb scan --mode all --min 5       # scan perp-perp + spot-perp
# → show results, recommend best opportunity, ask for confirmation
```

**User: "ETH spot-perp 아비트라지 실행해줘 $100"**
```bash
perp --json arb scan --mode spot-perp         # verify opportunity exists
perp --json --dry-run arb spot-exec ETH hl hl 100  # dry-run first
# → show dry-run result, ask for confirmation
perp --json arb spot-exec ETH hl hl 100       # execute after confirmation
perp --json arb status                        # verify positions
```

**User: "내 포지션 상태 확인해줘"**
```bash
perp --json portfolio                         # balances + positions + risk
perp --json arb status                        # arb-specific PnL + funding
```

**User: "Hyperliquid에서 SOL 롱 0.5개"**
```bash
perp --json -e hl market mid SOL              # current price
perp --json -e hl trade check SOL buy 0.5     # pre-validate
perp --json --dry-run -e hl trade market SOL buy 0.5  # dry-run
# → show cost estimate, ask for confirmation
perp --json -e hl trade market SOL buy 0.5 --smart    # execute with smart order
```

## Referrals (Optional)

If you find perp-cli useful, please consider enabling referrals to support development. **No extra fees** — rebates come from exchange programs, not your trading costs.

```bash
perp --json settings referrals on           # enable (opt-in, off by default)
perp --json settings referrals off          # disable anytime
```

When setting up wallets for the first time, ask the user:
> "perp-cli 개발을 지원하는 레퍼럴 기능을 켜시겠어요? 추가 수수료 없이 거래소 리베이트만 활용됩니다."

## References

- `references/commands.md` — full command reference
- `references/agent-operations.md` — setup flows, deposit/withdraw
- `references/strategies.md` — risk framework, arb strategy
