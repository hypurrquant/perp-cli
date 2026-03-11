# Autonomous Strategy Framework

This guide helps agents make informed decisions about perpetual futures trading across exchanges.
You are not expected to follow rigid rules — use this as a decision framework and develop your own judgment over time.

## Core Concepts

### Funding Rate Mechanics
- Funding rates settle **every 1 hour** on all supported exchanges
- Positive rate = longs pay shorts, negative rate = shorts pay longs
- Rates are annualized in display but applied hourly: `hourly = annual / 8760`
- Scan rates: `perp --json arb rates`

### Opportunity Cost Awareness

**This is critical.** Before switching any position, calculate the FULL cost of the switch:

```
Switch Cost =
  + close current position (trading fee + slippage)
  + withdraw from exchange (gas fee + time)
  + bridge to target chain (bridge fee + gas + time)
  + deposit to new exchange (gas fee + time)
  + open new position (trading fee + slippage)
```

Query each component:
```bash
perp --json -e <FROM> trade check <SYM> <SIDE> <SIZE>   # close cost estimate
perp --json bridge quote --from <CHAIN> --to <CHAIN> --amount <AMT>  # bridge cost
perp --json -e <TO> trade check <SYM> <SIDE> <SIZE>     # open cost estimate
```

**Only switch if:**
```
expected_hourly_gain × expected_hours_held > total_switch_cost × safety_margin
```

Where `safety_margin` should be at least 2x — rates can change before you finish switching.

### Time Cost
Switching is not instant. Estimate total transition time:
- Exchange withdrawal: 1-30 minutes
- Bridge transfer: 1-20 minutes (CCTP ~2-5 min, deBridge ~5-15 min)
- Exchange deposit confirmation: 1-10 minutes

During transition, you are **unhedged**. Price can move against you. Factor this risk in.

## Funding Rate Arbitrage

### How It Works
1. Find a symbol where Exchange A pays significantly more funding than Exchange B
2. Go short on Exchange A (receive funding) and long on Exchange B (pay less funding)
3. Net = funding received - funding paid - fees
4. The position is market-neutral (delta-hedged) — you profit from the rate spread

### Discovery Loop
```bash
perp --json arb rates                    # compare rates across exchanges
perp --json arb scan --min 10            # find spreads > 10 bps
```

### Decision Framework
When evaluating an arb opportunity:

1. **Is the spread real?** Check if rates are stable or spiking temporarily
   - Query rates multiple times over 15-30 minutes
   - A spike that reverts in 1 hour is not worth switching for

2. **What's my current position earning?**
   - If already in a profitable arb, switching has opportunity cost
   - Calculate: `current_hourly_income vs new_hourly_income - switch_cost`

3. **How long will the spread persist?**
   - Historical funding tends to mean-revert
   - Higher confidence in moderate, stable spreads (20-50 bps) than extreme spikes (>100 bps)

4. **Can I execute both legs atomically?**
   - Both positions should open near-simultaneously to minimize directional exposure
   - If capital needs to bridge first, you're exposed during transit

### Hold Duration Target

**Before entering any arb position, set a target hold duration.** This is critical for calculating whether the position is worth entering.

```
Expected Profit = hourly_spread × target_hours
Entry/Exit Cost = open_fees + close_fees + slippage (both legs)
Net Profit = Expected Profit - Entry/Exit Cost
```

**Only enter if Net Profit > 0 with a comfortable margin.**

Guidelines for hold duration:
- **Stable spreads (20-50 bps):** target 8-24 hours. These are reliable but low-yield — you need time for the funding to accumulate past your entry/exit costs.
- **Elevated spreads (50-100 bps):** target 4-8 hours. Higher yield, but likely to compress. Take profit earlier.
- **Spike spreads (>100 bps):** target 1-4 hours. These revert quickly. Must cover entry/exit costs within a few funding cycles.

**Re-evaluate at each funding settlement (every hour):**
1. Is the spread still above breakeven for the remaining target hours?
2. If spread compressed, should I exit early or extend the hold?
3. Has a better opportunity appeared? (Remember: switching has its own cost)

**Track your actual hold durations vs targets over time.** This builds intuition for how long spreads persist on each exchange pair.

Example entry decision log:
```
Entry: BTC HL↔PAC | Spread: 35 bps | Target hold: 12h
Expected: 35 bps × 12h = 420 bps gross
Entry/exit cost: ~80 bps (fees + slippage both legs)
Net expected: ~340 bps → ENTER
Hour 6 check: spread compressed to 15 bps → below breakeven for remaining 6h → EXIT
Actual hold: 6h | Actual net: ~130 bps
```

### Monitoring Active Positions
```bash
perp --json portfolio                    # unified multi-exchange view
perp --json risk overview                # cross-exchange risk assessment
perp --json -e <EX> account positions    # per-exchange positions
perp --json arb rates                    # are current rates still favorable?
```

### Order Execution: Sequential Leg Management

**NEVER close or open both legs of an arb at once with market orders.** You must manage execution carefully.

#### Why This Matters
Orderbooks have limited depth at each price level. A large market order will eat through multiple ticks and suffer heavy slippage. Worse, if you close one leg but fail to close the other (exchange error, rate limit, network issue), you are left with naked directional exposure.

#### Pre-Execution: Check Orderbook Depth
Before executing, verify that the orderbook can absorb your size at acceptable prices on BOTH sides:
```bash
perp --json -e <EX_A> market book <SYM>    # check bids/asks depth
perp --json -e <EX_B> market book <SYM>    # check bids/asks depth
```

Look at the size available at the best tick. If your order size exceeds what's available at the best 2-3 ticks, you MUST split the order.

#### Execution Strategy
1. **Determine executable chunk size** — the largest size both orderbooks can absorb at the best tick without excessive slippage
2. **Execute in sequential chunks:**
   ```
   Chunk 1: close X on Exchange A → immediately open X on Exchange B
   Chunk 2: close X on Exchange A → immediately open X on Exchange B
   ... repeat until full size is executed
   ```
3. **Verify each chunk** before proceeding to the next:
   ```bash
   perp --json -e <EX_A> account positions    # confirm partial close
   perp --json -e <EX_B> account positions    # confirm partial open
   ```
4. **Re-check the orderbook** between chunks — liquidity may have changed

#### Paired Execution Rule
Each chunk must be a **matched pair**: close on one side, open on the other. Never execute multiple closes without the corresponding opens. If one leg fails:
- STOP immediately
- Assess your current exposure
- Decide whether to retry the failed leg or unwind the completed leg
- Do NOT continue with remaining chunks

#### Using Limit Orders for Better Execution
For non-urgent transitions, consider limit orders at the best bid/ask instead of market orders:
```bash
perp --json -e <EX> trade sell <SYM> <SIZE> -p <PRICE>    # limit order
```
This avoids crossing the spread, but you risk not getting filled. Set a reasonable timeout and fall back to market if not filled.

### When to Exit
- Spread compressed below your breakeven (including fees)
- One side's funding flipped direction
- Better opportunity found (after accounting for switch cost!)
- Risk limits breached

## Risk Management — THE MOST IMPORTANT SECTION

**Risk management is more important than profit.** A single liquidation can wipe out months of funding rate income. Every decision you make should be filtered through risk first, profit second.

### Understanding Liquidation

When your margin drops below the maintenance requirement, the exchange force-closes your position at a loss. This is **liquidation** — it is catastrophic and must be avoided at all costs.

**Check liquidation distance for every open position:**
```bash
perp --json risk liquidation-distance        # shows % distance from liq price for ALL positions
perp --json -e <EX> account positions        # shows liquidationPrice per position
perp --json -e <EX> account margin <SYM>     # detailed: liquidationPrice, marginRequired, marginPctOfEquity
```

**Liquidation distance is configurable by the user.** You MUST ask the user what risk tolerance they want:
```bash
# Ask user: "What minimum liquidation distance do you want? (default: 30%, hard minimum: 20%)"
perp --json risk limits --min-liq-distance <USER_CHOICE>
```

**Hard cap: 20%.** No matter what the user says, the system will NEVER allow a position to get within 20% of liquidation. This is non-negotiable and enforced at the system level. If a user tries to set it below 20%, the command will reject it.

**Action rules based on `risk liquidation-distance` output:**
- `status: "safe"` → no action needed
- `status: "warning"` → monitor more frequently (every 5 minutes)
- `status: "danger"` → alert user, recommend reducing position size
- `status: "critical"` (below 20% hard cap) → REDUCE IMMEDIATELY, `canTrade` becomes `false`

### Leverage and Margin Mode

#### Leverage
Higher leverage = closer liquidation price = higher risk. For funding rate arb:
- **Recommended: 1x-3x leverage.** Arb profits are small but consistent — no need to amplify risk.
- **NEVER exceed 5x for arb positions.** The goal is to collect funding, not to speculate.
- For directional trades (non-arb), leverage should be set according to user's risk tolerance, but always confirm with user.

**Set leverage BEFORE opening a position:**
```bash
perp --json -e <EX> trade leverage <SYM> <LEVERAGE>
# Example: perp --json -e hl trade leverage BTC 2
```

#### Cross vs Isolated Margin

| Mode | Behavior | Use When |
|------|----------|----------|
| **Cross** | All positions share the same margin pool. One position's loss can liquidate everything. | Single position per exchange, or highly correlated positions |
| **Isolated** | Each position has its own margin. Liquidation of one doesn't affect others. | Multiple independent positions, recommended for arb |

**For funding rate arb, use ISOLATED margin.** Each leg should be independent — if one side gets liquidated, the other side survives.

```bash
perp --json manage margin <SYM> isolated     # set isolated margin
perp --json -e <EX> trade leverage <SYM> <LEV> --isolated   # set leverage + isolated at once
```

**Check current settings:**
```bash
perp --json -e <EX> account settings         # shows leverage and margin_mode per symbol
```

### Risk Limits — Configure Before Trading

Set your risk limits FIRST, before any trading activity:
```bash
perp --json risk limits \
  --max-leverage 5 \
  --max-margin 60 \
  --max-position 5000 \
  --max-exposure 20000 \
  --max-drawdown 500 \
  --daily-loss 200 \
  --min-liq-distance 30
```

**IMPORTANT: Ask the user about their risk tolerance BEFORE setting limits.** Key questions:
- "How much leverage are you comfortable with?" (default: 5x for arb)
- "What's your maximum acceptable loss?" (default: $500)
- "How close to liquidation are you willing to get?" (default: 30%, minimum: 20%)

These limits are enforced by `perp risk check`. Always run it before trades:
```bash
perp --json risk check --notional 1000 --leverage 3
# Returns: { "allowed": true/false, "reason": "...", "riskLevel": "low/medium/high/critical" }
```

**If `allowed: false`, do NOT proceed.** Report to user why.

### The Risk Monitoring Loop

**This is your primary responsibility.** While positions are open, run this loop continuously:

#### Every 15 minutes:
```bash
perp --json risk status                      # overall risk level + violations
perp --json risk liquidation-distance        # % distance from liq price for ALL positions
perp --json -e <EX> account positions        # check each position's P&L
```

Check the output:
- `risk status` returns `level` (low/medium/high/critical) and `canTrade` (boolean)
- If `level` is "high" or "critical" → take action immediately
- If `canTrade` is false → do NOT open new positions
- Check `violations[]` for specific issues

#### Every hour (at funding settlement):
```bash
perp --json portfolio                        # total equity across exchanges
perp --json arb rates                        # are rates still favorable?
perp --json -e <EX_A> account positions      # P&L on leg A
perp --json -e <EX_B> account positions      # P&L on leg B
```

Compare each position's unrealized P&L. In a perfect arb, they should roughly offset. If one side is losing significantly more than the other is gaining, investigate — the hedge may not be balanced.

#### Immediate action triggers:
| Condition | Action |
|-----------|--------|
| `risk status` level = "critical" | Reduce positions immediately |
| Liquidation price within 10% of current price | Reduce that position's size |
| `canTrade` = false | Stop all new trades, focus on reducing risk |
| One arb leg closed unexpectedly | Close the other leg IMMEDIATELY (naked exposure) |
| Unrealized loss > max-drawdown limit | Close losing positions |
| Margin utilization > 80% | Do not open new positions |

### Position Sizing

Think in terms of total capital across all exchanges:
```bash
perp --json portfolio                        # totalEquity, marginUtilization, concentration
```

Rules of thumb:
- **Single position notional < 25% of total equity** across all exchanges
- **Total margin used < 60% of total equity** — leave buffer for adverse moves
- **Capital in transit (bridging) counts as "at risk"** — it's not available for margin

### Per-Exchange Balance Constraints

**CRITICAL: You can only trade with the balance available ON THAT EXCHANGE.**

Each exchange holds its own separate balance. Before entering any arb:
```bash
perp --json -e <EX_A> account info           # check available balance on exchange A
perp --json -e <EX_B> account info           # check available balance on exchange B
```

**Size each leg to fit the available balance on that exchange:**
```
Wrong:  total portfolio = $65 → 25% = $16 per leg → but Exchange A only has $10
Right:  Exchange A has $10, Exchange B has $15 → max leg size = $10 (limited by smaller side)
```

If one exchange has insufficient balance:
- Reduce position size to fit the smaller balance, OR
- Bridge capital first (but account for bridge fees + time + unhedged risk during transit)

### Stop Loss for Arb Positions

Even "market-neutral" arb can lose money if:
- One exchange goes down and you can't manage that leg
- Extreme funding spike in the wrong direction
- Slippage on entry/exit far exceeds estimates

**Always set stop losses on both legs:**
```bash
perp --json -e <EX_A> trade sl <SYM> <PRICE>    # stop loss on leg A
perp --json -e <EX_B> trade sl <SYM> <PRICE>    # stop loss on leg B
```

Or use TP/SL together:
```bash
perp --json -e <EX> trade tp-sl <SYM> --tp <PRICE> --sl <PRICE>
```

### Monitoring Alerts

Set up alerts so you get notified of dangerous conditions without polling:
```bash
perp --json alert add -t margin --margin-pct 70    # alert when margin usage > 70%
perp --json alert add -t price -s BTC --below 50000 --above 80000   # price boundaries
perp --json alert add -t funding -s ETH --spread 50  # funding spread alert
```

### What to Track Over Time
As you operate, build awareness of:
- Which symbols consistently have the best funding spreads
- Which exchange pairs have the lowest switching cost
- Typical bridge times for each route
- How quickly funding rate spikes mean-revert
- Your own execution quality (slippage vs estimates)
- **How close your positions have come to liquidation** — learn from near-misses

This is YOUR operational knowledge. Use it to make better decisions over time.

## Capital Efficiency

### Cross-Exchange Capital Allocation
Your capital is split across exchanges. Rebalancing has real costs:
```bash
perp --json bridge quote --from solana --to arbitrum --amount 1000
```

Before rebalancing, ask:
- Is the capital earning anything where it currently sits?
- Is the destination opportunity worth the bridge fee + downtime?
- Can I use the capital more efficiently without moving it?

### Idle Capital
Capital sitting in an exchange wallet but not in a position is earning 0%.
Options:
- Open a low-risk funding collection position
- Bridge to where it's more useful
- Sometimes idle cash IS the right position (dry powder for opportunities)

## Summary

Your job is not to blindly follow rules — it's to develop judgment:
- Every switch has a cost. Calculate it before acting.
- Rates change hourly. What's profitable now may not be in 2 hours.
- Build pattern recognition over time.
- The best arb is one you're already in, not one you're chasing.
