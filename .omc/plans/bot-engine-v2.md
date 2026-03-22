# Bot Engine v2 — Implementation Plan

**Date:** 2026-03-22
**Revised:** 2026-03-22 (Rev 3 — Critic feedback applied)
**Status:** APPROVED (v3)
**Branch:** feat/bot-engine-v2 (from main @ v0.7.0)
**Scope:** Strategy plugin architecture, 14 new strategies, APEX orchestrator, REFLECT analytics, CLI integration
**Estimated Complexity:** HIGH (7 phases, ~32 new/modified files)

---

## RALPLAN-DR Summary

### Principles (5)

1. **Strategy-as-Plugin** — Every strategy implements a common interface; the engine dispatches generically. No more if-else chains in engine.ts.
2. **Incremental Deployability** — Each phase ships independently. Phase 0 alone is a complete upgrade. Later phases build on top but never break what shipped before.
3. **Reuse Existing Infrastructure** — MarketSnapshot, ExchangeAdapter, jobs system, execution-log, conditions system all stay. New code composes with them, not replaces them.
4. **Safety-First for Live Trading** — Every strategy has dry-run mode, position limits, and kill-switch integration. No strategy can bypass risk controls.
5. **Testability Without Live Exchange** — All strategies accept injected adapters and log functions. Pure computation (indicators, signals, scoring) is separated from I/O for unit testing.

### Decision Drivers (Top 3)

1. **Engine extensibility** — The current engine hardcodes 3 strategies via if-else in startStrategy/manageStrategy/stopStrategy. Adding 14+ strategies this way is unmaintainable. A Strategy interface is the prerequisite for everything else.
2. **Indicator reuse** — Market making, momentum, mean-reversion, and APEX all need overlapping indicators (EMA, VWAP, Bollinger, ATR, volatility regimes). A shared indicator library prevents duplication and inconsistency.
3. **Execution risk** — Strategies that place and manage multiple concurrent orders (market making, grid-mm) carry real financial risk. The engine must enforce position limits, daily loss caps, and emergency shutdown at a level above any individual strategy.

### Viable Options

#### Option A: Strategy Interface + Registry (RECOMMENDED)

Define a `Strategy` interface with lifecycle methods (`init`, `onTick`, `onStop`). Each strategy is a class/object implementing this interface. The engine calls them generically. A strategy registry maps names to factory functions.

**Pros:**
- Clean separation of concerns; engine stays small
- Adding a strategy = one file + one registry entry
- Testable in isolation (mock adapter + snapshot)
- Aligns with existing exchange adapter registry pattern

**Cons:**
- Requires refactoring engine.ts (breaking change for existing bot configs if not careful)
- Slight overhead of abstraction for simple strategies

#### Option B: Strategy-as-Function (Current Pattern Extended)

Keep the current pattern where strategies are standalone `run*` functions, but add a dispatcher map instead of if-else. No interface, just a function signature convention.

**Pros:**
- Minimal refactoring of engine.ts
- Each strategy remains a simple function
- Lower learning curve

**Cons:**
- No lifecycle management (init/cleanup are ad-hoc)
- State management is inconsistent across strategies
- Harder to compose strategies (APEX needs to orchestrate multiple)
- No type safety on strategy capabilities

#### Option C: Event-Driven Architecture

Engine emits events (tick, fill, risk-breach). Strategies subscribe. Full pub-sub system.

**Pros:**
- Maximum flexibility for composition
- Natural fit for APEX multi-strategy orchestration

**Cons:**
- Massive over-engineering for current scope
- Debugging event-driven trading systems is notoriously difficult
- No existing event infrastructure in the codebase
- **Invalidated:** Complexity-to-value ratio is too high for a CLI tool. This pattern suits a trading server, not a CLI bot.

### ADR (Architectural Decision Record)

- **Decision:** Option A — Strategy Interface + Registry
- **Drivers:** Extensibility for 14+ strategies, testability, alignment with existing plugin patterns
- **Alternatives considered:** Function-based dispatch (too loose), Event-driven (over-engineered)
- **Why chosen:** Provides the right level of structure without over-engineering. The exchange adapter pattern already proves this approach works in this codebase. Lifecycle methods (init/onTick/onStop) map naturally to the bot engine's phase model.
- **Consequences:** engine.ts must be refactored to dispatch via interface. Existing Grid/DCA/FundingArb strategies need wrapper classes. Config system needs a generic strategy params type. BotState strategy-specific fields must be extracted to strategy-private state.
- **Follow-ups:** Consider async generator pattern for strategies that produce a stream of decisions rather than imperative order placement. Evaluate deprecation timeline for standalone `run*` functions.

---

## Phase 0 Decision: Dual Execution Path Resolution

**Context:** The codebase has two independent strategy execution paths that must be reconciled before proceeding.

**Path A — Engine-based (`src/bot/engine.ts` via `runBot()`):**
- Used by: `bot start`, `bot quick-grid`, `bot quick-dca`, `bot quick-arb`, `bot preset`
- Has: monitoring/entering/running phases, entry/exit conditions, risk management (drawdown, daily loss, pause), job system integration
- Dispatches via if-else on `config.strategy.type`

**Path B — Standalone (`src/strategies/*.ts` via `runGrid()`, `runDCA()`, etc.):**
- Used by: `bot grid`, `bot dca`, `bot trailing-stop`, `bot twap`, `bot funding-arb`
- Has: own event loops, own state management, own logging
- Called directly from `registerRunSubcommands()` in `bot.ts`

**Decision:** New strategies are engine-only (implement Strategy interface, dispatched by engine). Existing standalone `run*` commands (`bot grid`, `bot dca`, `bot trailing-stop`, `bot twap`, `bot funding-arb`) remain as-is with no changes. They are stable, tested, and serve a different UX purpose (quick one-off runs without YAML config). Future deprecation is deferred to a separate plan after v2 ships. The Strategy interface does NOT need to support standalone mode.

**Rationale:** Forcing standalone commands through the engine would break user workflows, add migration risk, and provide no value for v2 goals. The engine path is the only path that needs extensibility.

---

## Phase 0: Strategy Interface + Foundation (Foundation)

**Goal:** Establish the Strategy interface, indicator library, strategy registry, enriched market data, extracted BotState, and dry-run architecture. Refactor engine.ts to dispatch generically. Wrap existing 3 engine strategies as the first implementations.

**Files to create:**
- `src/bot/strategy-interface.ts` — Strategy interface + StrategyContext type + StrategyAction union
- `src/bot/strategy-registry.ts` — Registry mapping strategy names to factory functions
- `src/bot/indicators.ts` — Shared indicator library (EMA, SMA, VWAP, ATR, Bollinger Bands, volatility regime detector)

**Files to modify:**
- `src/bot/engine.ts` — Replace if-else dispatch with `strategy.onTick(context)` pattern; extract strategy-specific fields from BotState into strategy-private state
- `src/bot/conditions.ts` — Extend `MarketSnapshot` with enriched data fields (or create `EnrichedSnapshot` superset)
- `src/bot/config.ts` — Add generic `params: Record<string, unknown>` alongside typed unions for backward compat
- `src/bot/index.ts` — Re-export new modules

### Subtask 0a: BotState Extraction (Significant Refactor)

The current `BotState` interface at engine.ts:11-34 mixes engine-generic fields with strategy-specific fields that MUST be separated:

**Engine-generic (stays in BotState):**
- `phase`, `startTime`, `equity`, `peakEquity`, `dailyPnl`, `dailyStartEquity`, `dailyStartDate`, `fills`, `totalPnl`, `rebalanceCount`, `lastRebalance`, `strategyActive`

**Strategy-specific (moves to `StrategyContext.state: Map<string, unknown>`):**
- `gridOrders: Map<number, string>` — Grid strategy private state
- `gridUpper: number`, `gridLower: number` — Grid strategy private state
- `dcaOrdersPlaced: number`, `dcaLastOrder: number` — DCA strategy private state
- `arbRunning: boolean`, `arbPositions: number` — FundingArb strategy private state

Each wrapper class for existing strategies will migrate these fields into its own `state` map. The engine will pass `StrategyContext.state` (a `Map<string, unknown>`) to each strategy. The strategy owns its state lifecycle; the engine never reads or writes strategy-specific state.

**Acceptance criteria for 0a:**
- [ ] BotState no longer contains any grid/dca/arb fields
- [ ] Each wrapper strategy (GridStrategy, DCAStrategy, FundingArbStrategy) manages its own state via `ctx.state`
- [ ] Engine code has zero references to `gridOrders`, `dcaOrdersPlaced`, `arbRunning`, etc.

### Subtask 0b: MarketSnapshot Enrichment

Current `MarketSnapshot` (conditions.ts:4-13) only has: price, high24h, low24h, volume24h, fundingRate, volatility24h, rsi, spreadPct. This is insufficient for advanced strategies.

Add an `EnrichedSnapshot` type that extends `MarketSnapshot` with:

```
EnrichedSnapshot extends MarketSnapshot:
  klines: ExchangeKline[]          // Raw candle history (1h, configurable)
  orderbook: {                     // Top-of-book depth
    bids: [string, string][]       // [price, size][]
    asks: [string, string][]       // [price, size][]
  }
  openInterest: string             // From ExchangeMarketInfo.openInterest
```

The engine fetches enriched data once per tick and passes it to `strategy.onTick()`. Existing `MarketSnapshot` stays unchanged for backward compat with conditions.ts. The enrichment uses existing adapter methods: `adapter.getKlines()`, `adapter.getOrderbook()`, `adapter.getMarkets()` — no new adapter methods needed.

**Acceptance criteria for 0b:**
- [ ] `EnrichedSnapshot` type exists with klines, orderbook, openInterest fields
- [ ] Engine fetches enriched data each tick (with error handling — partial data is acceptable)
- [ ] Existing condition evaluation still works with base `MarketSnapshot`

### Subtask 0c: Strategy Interface + Registry + Wrappers

**Detailed Design:**

```
Strategy Interface:
  - name: string
  - init(ctx: StrategyContext): Promise<void>
  - onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]>
  - onStop(ctx: StrategyContext): Promise<void>
  - describe(): { params: ParamDef[]; description: string }

StrategyContext:
  - adapter: ExchangeAdapter
  - config: BotConfig
  - state: Map<string, unknown>  // strategy-private state
  - log: BotLog
  - extraAdapters?: Map<string, ExchangeAdapter>

StrategyAction (discriminated union):
  - { type: "place_order", side, price, size, orderType }
  - { type: "cancel_order", orderId }
  - { type: "cancel_all" }
  - { type: "market_order", side, size }
  - { type: "edit_order", orderId, price, size }   // <-- in-place modification
  - { type: "set_leverage", leverage }
  - { type: "log", message }
  - { type: "stop", reason }
```

Note on `edit_order`: Market making strategies need in-place order modification (not cancel+replace) for efficiency and to avoid losing queue position. The adapter already supports this via `adapter.editOrder()` at interface.ts:94. The engine's action executor maps `edit_order` actions to `adapter.editOrder(symbol, orderId, price, size)`.

**Phase 0 Strategy Approach:** Phase 0 strategy wrappers MUST return `StrategyAction[]` from `onTick()`. The existing grid/dca/funding-arb logic is adapted to return actions (place_order, cancel_order, etc.) instead of calling adapter methods directly. This ensures dry-run mode works correctly from Phase 0 — the engine's action executor intercepts all trading operations. This is more work upfront (~0.5 day additional) but prevents the silent failure mode where dry-run misses adapter-direct calls.

Note: Phase 0 modifies engine.ts dispatch, BotState, config.ts parsing, and MarketSnapshot — this is significant change despite Principle 3 (Reuse Existing Infrastructure). The tension is managed by wrapping rather than rewriting: existing strategy code moves into wrapper classes, and existing standalone commands remain untouched.

### Subtask 0d: Indicator Library

```
Indicator Library:
  - ema(closes: number[], period: number): number
  - sma(closes: number[], period: number): number
  - vwap(candles: ExchangeKline[]): number
  - atr(candles: ExchangeKline[], period: number): number
  - bollingerBands(closes: number[], period: number, stddev: number): { upper, middle, lower }
  - detectRegime(candles: ExchangeKline[]): "low_vol_trend" | "low_vol_range" | "high_vol_trend" | "high_vol_range"
  - calculateRSI() — re-export from conditions.ts for backward compat
```

### Subtask 0f: Config System Extension

- `parseStrategy()` in config.ts:149-187 throws on unknown strategy types (line 184-185). Add a generic fallback: for unknown types, return `{ type: stratType, ...raw }` instead of throwing.
- Add `GenericStrategyParams = { type: string; [key: string]: unknown }` to the `StrategyParams` union.
- Each Strategy class validates its own params in `describe().params` — the engine passes raw params through.
- Acceptance: `parseStrategy('simple-mm', {...})` returns the params without throwing.

### Subtask 0e: Dry-Run Architecture

All strategies support dry-run mode. Design:
- `BotConfig` gains `dryRun: boolean` (default: false)
- When `dryRun` is true, the engine's action executor logs all actions but does NOT call adapter trading methods (`marketOrder`, `limitOrder`, `editOrder`, `cancelOrder`, etc.)
- Read-only adapter calls (getMarkets, getOrderbook, getKlines, getBalance, getPositions) still execute normally — strategies see real market data
- Dry-run fills are simulated: limit orders "fill" when price crosses the order price in subsequent ticks
- All dry-run activity is logged with a `[DRY-RUN]` prefix
- CLI flag: `perp bot start config.yaml --dry-run`

**Acceptance Criteria (Phase 0 overall):**
- [ ] Strategy interface is defined and exported from `src/bot/index.ts`
- [ ] `edit_order` action type exists in StrategyAction union
- [ ] BotState contains only engine-generic fields (Subtask 0a complete)
- [ ] EnrichedSnapshot provides klines, orderbook, openInterest (Subtask 0b complete)
- [ ] Existing Grid, DCA, FundingArb strategies work unchanged via wrapper classes
- [ ] Engine.ts dispatches via `strategy.onTick()` instead of if-else chains
- [ ] `perp bot start config.yaml` works identically to current behavior for all 3 strategy types
- [ ] Standalone commands (`bot grid`, `bot dca`, `bot trailing-stop`, `bot twap`, `bot funding-arb`) are completely untouched
- [ ] All 11 presets continue to work
- [ ] Indicator library has unit tests for EMA, SMA, ATR, Bollinger, RSI
- [ ] `perp bot preset-list` shows existing presets unchanged
- [ ] Dry-run mode logs actions without executing trades
- [ ] `perp bot start config.yaml --dry-run` flag works
- [ ] Existing bot YAML configs (strategy.type: grid/dca/funding-arb) parse and work identically
- [ ] Integration test: mock adapter + mock strategy verify engine dispatch flow

**Effort:** 5-7 days (BotState extraction ~1.5d, MarketSnapshot enrichment ~1d, interface+registry+wrappers ~1.5d, indicators ~0.5d, dry-run ~0.5d, testing+integration ~1d)

---

## Phase 1: Market Making Strategies (6 strategies)

**Goal:** Implement the 6 market making strategies as Strategy interface implementations. This is where the full StrategyAction return-type pattern is validated — if MM strategies can express all their needs as actions, it proves the pattern for all subsequent phases.

**Files to create:**
- `src/strategies/simple-mm.ts` — Symmetric bid/ask at fixed spread around mid
- `src/strategies/engine-mm.ts` — Production quoting with composite fair value, dynamic spreads, inventory skew, multi-level ladder
- `src/strategies/avellaneda-mm.ts` — Avellaneda-Stoikov optimal market making model
- `src/strategies/regime-mm.ts` — 4-regime detector with adaptive spread/inventory
- `src/strategies/grid-mm.ts` — Enhanced grid with auto-rebalance and per-level profit tracking
- `src/strategies/liquidation-mm.ts` — Liquidity provision during cascade events

**Implementation Priority (build order):**

1. **simple-mm.ts** (baseline) — Fixed spread, symmetric quotes. This is the "hello world" of market making and validates the Strategy interface works for order management. First strategy to use `edit_order` action for quote updates.
2. **engine-mm.ts** (core) — Builds on simple-mm with: composite fair value (VWAP + EMA + mid + oracle), volatility-based spread widening, inventory skew (tilt quotes away from accumulated inventory), 3-5 level ladder. Requires `orderbook` from EnrichedSnapshot for fair value calculation.
3. **grid-mm.ts** — Enhance existing grid.ts: add per-level PnL tracking, auto-rebalance on drift, configurable level spacing (linear, geometric).
4. **avellaneda-mm.ts** — Implements the A-S model: optimal_spread = gamma * sigma^2 * (T-t) + (2/gamma) * ln(1 + gamma/kappa). Requires volatility estimation from indicators.ts.
5. **regime-mm.ts** — Uses `detectRegime()` from indicators.ts to select spread width and inventory limits per regime state. Requires `klines` from EnrichedSnapshot.
6. **liquidation-mm.ts** — Monitors OI changes and spread widening to detect liquidation cascades, then widens quotes to provide liquidity at favorable prices. Requires `openInterest` and `orderbook` from EnrichedSnapshot.

**Acceptance Criteria:**
- [ ] Each strategy implements the Strategy interface
- [ ] Each strategy is registered in the strategy registry
- [ ] `perp bot start --strategy simple-mm` launches simple-mm via the engine
- [ ] simple-mm places symmetric bid/ask orders and refreshes them each tick using `edit_order` actions
- [ ] engine-mm adjusts spread based on volatility (wider in high vol)
- [ ] engine-mm skews inventory (reduces bid size when long-heavy, vice versa)
- [ ] liquidation-mm uses `openInterest` from EnrichedSnapshot for cascade detection
- [ ] All MM strategies respect risk limits from BotConfig
- [ ] Unit tests for: fair value computation, inventory skew calculation, A-S spread formula

**Effort:** 5-7 days

---

## Phase 2: Signal/Directional + Arbitrage Strategies (5 strategies)

**Goal:** Implement directional and arbitrage strategies.

**Files to create:**
- `src/strategies/momentum-breakout.ts` — Volume spike + N-period high/low breakout with ATR stops
- `src/strategies/mean-reversion.ts` — Bollinger Band deviation entry, mean return exit
- `src/strategies/aggressive-taker.ts` — Directional spread crossing with size modulation
- `src/strategies/funding-arb-v2.ts` — Enhanced funding arb: multi-exchange scanning, auto position management, convergence close
- `src/strategies/basis-arb.ts` — Implied basis trading from funding rate annualization

**Implementation Notes:**

- **momentum-breakout**: Uses ATR from indicators.ts for stop placement. Entry when price breaks N-period high/low AND volume exceeds 2x average. Exit on trailing stop (reuse trailing-stop logic). Requires `klines` from EnrichedSnapshot for historical price/volume.
- **mean-reversion**: Uses bollingerBands from indicators.ts. Enter when price > upper band (short) or < lower band (long). Exit on mean return (middle band). Requires `klines` for close prices.
- **aggressive-taker**: Market orders with directional bias. Size modulated by signal strength. Simplest directional strategy.
- **funding-arb-v2**: Wraps existing funding-arb.ts logic into Strategy interface. Adds: auto-scanning all symbols, position sizing based on available balance, convergence-based exit (not just spread threshold).
- **basis-arb**: Calculates annualized basis from funding rates. Enters when basis exceeds threshold (e.g., >30% annualized). Essentially a specialized funding-arb variant.

**Acceptance Criteria:**
- [ ] Each strategy implements Strategy interface and is registered
- [ ] momentum-breakout enters on breakout, exits on ATR-based trailing stop
- [ ] mean-reversion enters on 2-sigma deviation, exits on mean return
- [ ] funding-arb-v2 backward-compatible with existing arb configs
- [ ] Directional strategies track position side and size correctly
- [ ] Unit tests for: breakout detection, Bollinger entry/exit logic, basis calculation

**Effort:** 4-5 days

---

## Phase 3: Infrastructure Agents (3 strategies)

**Goal:** Implement hedge-agent, rfq-agent, and claude-agent.

**Files to create:**
- `src/strategies/hedge-agent.ts` — Portfolio exposure monitor with auto-hedging
- `src/strategies/rfq-agent.ts` — Large order execution with iceberg-style splitting
- `src/strategies/claude-agent.ts` — LLM-driven trading decisions from market snapshots

**Implementation Notes:**

- **hedge-agent**: Monitors total notional exposure across all positions. When exposure exceeds threshold, places hedging orders on the opposite side. Uses `adapter.getPositions()` to calculate net exposure.
- **rfq-agent**: Wraps existing split-order.ts logic into Strategy interface. Adds: configurable iceberg sizing, wider spread tolerance for large orders, time-based slice scheduling.
- **claude-agent**: Sends JSON market snapshots to Claude/OpenAI API. Parses structured response (JSON) for trading decisions. Configurable: model, system prompt, decision interval, max actions per response. Safety: all LLM decisions pass through risk controls before execution. Requires API key configuration.

**Acceptance Criteria:**
- [ ] hedge-agent reduces net exposure when threshold exceeded
- [ ] rfq-agent executes large orders without excessive market impact
- [ ] claude-agent sends snapshots and parses LLM responses into StrategyActions
- [ ] claude-agent respects rate limits and handles API errors gracefully
- [ ] All agents respect bot risk limits
- [ ] claude-agent has dry-run mode that logs proposed actions without executing

**Effort:** 3-4 days

---

## Phase 4: APEX Orchestrator

**Goal:** Build the APEX multi-strategy orchestrator as a higher-level system that manages multiple strategy slots concurrently.

**Directory:** `src/bot/apex/`

**Files to create:**
- `src/bot/apex/radar.ts` — 4-stage funnel scoring (market structure 35%, technicals 30%, funding 20%, BTC macro 15%)
- `src/bot/apex/pulse.ts` — 5-tier momentum signal detection with priority ranking
- `src/bot/apex/guard.ts` — 2-phase trailing stop (wide Phase 1 while building, tiered Phase 2 profit floors)
- `src/bot/apex/orchestrator.ts` — Multi-slot position manager with entry priority system
- `src/bot/apex/index.ts` — Barrel exports + preset configs (default/conservative/aggressive)

**Detailed Design:**

```
Radar Scoring (0-400 total):
  Stage 1 - Market Structure (0-140): OI trend, volume profile, bid/ask depth ratio
    Requires: openInterest, orderbook from EnrichedSnapshot
  Stage 2 - Technicals (0-120): EMA crossovers, RSI divergence, MACD histogram
    Requires: klines from EnrichedSnapshot + indicators.ts
  Stage 3 - Funding (0-80): Funding rate extremes, rate acceleration
    Requires: fundingRate from MarketSnapshot
  Stage 4 - BTC Macro (0-60): BTC correlation, BTC dominance trend
    Requires: separate BTC kline fetch

Pulse Signal Tiers:
  FIRST_JUMP(100): First significant move in a quiet market
  CONTRIB_EXPLOSION(95): Volume explosion with directional consensus
  IMMEDIATE_MOVER(80): Strong momentum with follow-through
  NEW_ENTRY_DEEP(65): Fresh entry point in established trend
  DEEP_CLIMBER(55): Gradual accumulation pattern

Guard (2-Phase Trailing):
  Phase 1 (Building): Wide trail (e.g., 5%) while position is accumulating
  Phase 2 (Protecting): Tiered profit floors that ratchet up:
    - 2% profit -> floor at breakeven
    - 5% profit -> floor at 2%
    - 10% profit -> floor at 6%
    - 20% profit -> floor at 14%

Orchestrator:
  - 2-3 concurrent position slots
  - Entry priority: Radar score > 280 + Pulse tier >= IMMEDIATE_MOVER
  - Slot allocation: best signal gets largest allocation
  - Position sizing: fixed fraction of equity per slot
  - Preset configs: default (balanced), conservative (higher thresholds), aggressive (lower thresholds)
```

**Acceptance Criteria:**
- [ ] Radar produces 0-400 score from market data (uses openInterest + orderbook from EnrichedSnapshot)
- [ ] Pulse classifies momentum into 5 tiers
- [ ] Guard manages 2-phase trailing stops with ratcheting floors
- [ ] Orchestrator manages 2-3 concurrent slots
- [ ] `perp bot apex ETH` starts APEX orchestrator on ETH
- [ ] Preset configs (default/conservative/aggressive) produce different behavior
- [ ] Unit tests for: radar scoring, pulse classification, guard phase transitions

**Effort:** 5-7 days

---

## Phase 5: REFLECT System (Analytics + Journal)

**Goal:** Build the performance analysis system and trade journal. This phase depends only on Phase 0 (journal format and engine integration) and can start as soon as Phase 0 ships.

**Files to create:**
- `src/bot/reflect.ts` — Performance analysis engine (win rate, fee drag, direction split, holding periods)
- `src/bot/trade-journal.ts` — Trade journal persistence (JSON in ~/.perp/journal/)

**Files to modify:**
- `src/bot/engine.ts` — Integrate trade journal recording on every fill
- `src/bot/index.ts` — Re-export reflect and journal modules

**REFLECT Design:**

```
Analysis Outputs:
  - Win rate (% of trades that were profitable)
  - Fee drag ratio (fees / gross profit)
  - Direction split (% long vs short entries)
  - Avg holding period per trade
  - Sharpe ratio (if enough data)
  - Max drawdown (actual, from journal data)
  - Best/worst trade
  - Daily PnL histogram

Auto-Parameter Adjustment (within guardrails):
  - If win rate < 40%: widen entry thresholds by 10%
  - If fee drag > 30%: increase min spread
  - If holding period too short: increase exit patience
  - Guardrails: no parameter moves > 20% from baseline per adjustment

Trade Journal Format (JSON):
  {
    "id": "uuid",
    "strategy": "engine-mm",
    "symbol": "ETH",
    "exchange": "hyperliquid",
    "side": "buy",
    "size": "0.1",
    "entryPrice": "2500.00",
    "exitPrice": "2510.00",  // null if still open
    "pnl": "1.00",
    "fees": "0.25",
    "entryTime": 1711100000000,
    "exitTime": 1711103600000,
    "holdingPeriodSec": 3600,
    "tags": ["mm", "auto"]
  }

Daily Reset:
  - PnL counter resets at UTC midnight
  - Daily summary written to journal
  - execution-log.ts already exists; journal adds strategy-level context
```

**Acceptance Criteria:**
- [ ] Trade journal records every fill with strategy context
- [ ] Daily PnL reset works at UTC midnight
- [ ] `reflect.ts` computes win rate, fee drag, Sharpe, max drawdown from journal data
- [ ] Auto-parameter adjustment stays within guardrail bounds
- [ ] Journal file rotation (new file per day) prevents unbounded file growth

**Effort:** 3-4 days

---

## Phase 6: CLI Integration

**Goal:** Complete CLI integration for all new strategies, APEX, and REFLECT. This is the final integration phase and depends on all previous phases.

**Files to modify:**
- `src/commands/bot.ts` — Add new subcommands for all strategies + APEX + REFLECT
- `src/bot/presets.ts` — Add presets for new strategies (at least MM and APEX presets)
- `src/bot/index.ts` — Re-export all new modules

**New CLI Commands:**

```
perp bot start <strategy> [symbol] [--params key=value ...] [--dry-run]
  Start any registered strategy by name. Params passed as key=value pairs.

perp bot apex [symbol]
  Start APEX orchestrator. Default symbol: ETH.
  Options: --preset default|conservative|aggressive

perp bot reflect [--days 7] [--strategy <name>]
  Run performance analysis on trade journal data.
  Outputs: win rate, fee drag, Sharpe, daily PnL.

perp bot strategies
  List all registered strategies with descriptions and param schemas.

perp bot backtest <strategy> <symbol> --from <date> --to <date>
  Basic backtesting using historical kline data.
  (Minimal viable: replay candles through strategy.onTick)
```

**Acceptance Criteria:**
- [ ] `perp bot strategies` lists all registered strategies (existing + new)
- [ ] `perp bot start engine-mm ETH` starts engine-mm strategy
- [ ] `perp bot start engine-mm ETH --dry-run` starts in dry-run mode
- [ ] `perp bot apex ETH` starts APEX orchestrator
- [ ] `perp bot reflect` outputs performance analysis from journal data
- [ ] Backward compatibility: all existing `perp bot` commands work unchanged (including standalone Path B commands)
- [ ] At least 3 new presets added (simple-mm, engine-mm, apex-default)

**Effort:** 3-4 days

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| BotState extraction breaks existing engine behavior | Medium | High | Comprehensive test coverage before and after extraction. Run all 11 presets in dry-run mode as regression gate. |
| Strategy interface too rigid for diverse strategies | Medium | High | Design onTick to return actions (not execute directly); strategies can return any combination of actions. All wrappers must return StrategyAction[] — adapter-direct calls are not permitted. |
| MarketSnapshot enrichment adds latency per tick | Medium | Medium | Fetch enriched data in parallel (Promise.all for klines, orderbook, markets). Cache with TTL for data that changes slowly (openInterest). |
| Market making on low-liquidity DEXes causes self-trading | High | Medium | Add min-spread floor, max order size cap, self-trade prevention check |
| APEX Radar scoring is inaccurate | Medium | Medium | Start with conservative thresholds; REFLECT system auto-adjusts over time |
| claude-agent LLM latency causes stale decisions | Medium | Low | Configurable decision interval (default 60s); cache last decision if API slow |
| Backward compatibility break in engine.ts refactor | Low | High | Phase 0 wraps existing strategies; all existing tests must pass before proceeding. Standalone Path B commands are NOT touched. |
| Too many strategies overwhelm users | Low | Medium | Group by category in CLI; recommend simple-mm and grid-standard as starting points |

## Dependency Graph

```
Phase 0 (Foundation: Interface + BotState + EnrichedSnapshot + Indicators + Dry-run)
  |
  +-- Phase 1 (Market Making) -- depends on indicators.ts + Strategy interface + EnrichedSnapshot + edit_order
  |
  +-- Phase 2 (Signal/Arb) -- depends on indicators.ts + Strategy interface + EnrichedSnapshot (klines)
  |
  +-- Phase 3 (Infrastructure) -- depends on Strategy interface only
  |
  +-- Phase 4 (APEX) -- depends on indicators.ts + EnrichedSnapshot (openInterest, orderbook)
  |       |
  |       +-- uses strategies from Phase 1-2 as sub-strategies (optional)
  |
  +-- Phase 5 (REFLECT) -- depends on Phase 0 only (journal format + engine integration)
  |       |
  |       +-- can start immediately after Phase 0 (no dependency on Phase 1-4)
  |
  +-- Phase 6 (CLI) -- depends on all phases for full integration (last)
```

Phases 1, 2, 3, 5 can be worked in parallel after Phase 0 is complete.
Phase 4 can start after Phase 0 but benefits from Phase 1-2 strategies being available.
Phase 6 is the integration phase and must come last.

## Total Effort Estimate

| Phase | Effort | Cumulative |
|-------|--------|------------|
| Phase 0: Foundation (Interface + BotState + Enrichment + Indicators + Dry-run) | 5-7 days | 5-7 days |
| Phase 1: Market Making | 5-7 days | 10-14 days |
| Phase 2: Signal/Arb | 4-5 days | 14-19 days |
| Phase 3: Infrastructure | 3-4 days | 17-23 days |
| Phase 4: APEX | 5-7 days | 22-30 days |
| Phase 5: REFLECT | 3-4 days | 25-34 days |
| Phase 6: CLI | 3-4 days | 28-38 days |

**Total: 28-38 working days** (with Phases 1-3+5 parallelizable, critical path is ~22 days)

Note: Phase 0 increased from 3-4 to 5-7 days to account for BotState extraction (~1.5d), MarketSnapshot enrichment (~1d), and dry-run architecture (~0.5d). These are non-trivial refactoring tasks that touch the core engine loop.

## File Inventory (New Files)

```
src/bot/strategy-interface.ts       (Phase 0)
src/bot/strategy-registry.ts        (Phase 0)
src/bot/indicators.ts               (Phase 0)
src/strategies/simple-mm.ts         (Phase 1)
src/strategies/engine-mm.ts         (Phase 1)
src/strategies/avellaneda-mm.ts     (Phase 1)
src/strategies/regime-mm.ts         (Phase 1)
src/strategies/grid-mm.ts           (Phase 1)
src/strategies/liquidation-mm.ts    (Phase 1)
src/strategies/momentum-breakout.ts (Phase 2)
src/strategies/mean-reversion.ts    (Phase 2)
src/strategies/aggressive-taker.ts  (Phase 2)
src/strategies/funding-arb-v2.ts    (Phase 2)
src/strategies/basis-arb.ts         (Phase 2)
src/strategies/hedge-agent.ts       (Phase 3)
src/strategies/rfq-agent.ts         (Phase 3)
src/strategies/claude-agent.ts      (Phase 3)
src/bot/apex/radar.ts               (Phase 4)
src/bot/apex/pulse.ts               (Phase 4)
src/bot/apex/guard.ts               (Phase 4)
src/bot/apex/orchestrator.ts        (Phase 4)
src/bot/apex/index.ts               (Phase 4)
src/bot/reflect.ts                  (Phase 5)
src/bot/trade-journal.ts            (Phase 5)
```

**Modified Files:**
```
src/bot/engine.ts                   (Phase 0 + Phase 5)
src/bot/conditions.ts               (Phase 0 — EnrichedSnapshot)
src/bot/config.ts                   (Phase 0)
src/bot/index.ts                    (Phase 0 + Phase 5 + Phase 6)
src/bot/presets.ts                  (Phase 6)
src/commands/bot.ts                 (Phase 6 only — standalone commands NOT touched)
src/strategies/index.ts             (Phase 1-3)
```

## Guardrails

### Must Have
- Strategy interface with lifecycle methods (init/onTick/onStop)
- `edit_order` action type for in-place order modification
- EnrichedSnapshot with klines, orderbook, openInterest
- BotState contains only engine-generic fields (no strategy-specific leakage)
- All strategies go through engine risk controls (max drawdown, daily loss, position limits)
- Backward compatibility with existing bot configs, presets, AND standalone commands
- Unit tests for indicator library and strategy-specific logic
- Dry-run mode for all new strategies (log-only, no real trades)

### Must NOT Have
- No breaking changes to ExchangeAdapter interface
- No modifications to standalone Path B commands (bot grid, bot dca, bot trailing-stop, bot twap, bot funding-arb)
- No direct API calls from strategies (all through adapter)
- No hardcoded exchange-specific logic in strategies (use capability interfaces)
- No unbounded position accumulation (all strategies must respect max_position_usd)
- No auto-parameter adjustment beyond 20% guardrail bounds in REFLECT

---

## Revision Log

### Rev 3 (2026-03-22) — Critic feedback

v3 (Critic feedback): parseStrategy generic fallback, action pattern consistency, infrastructure tension acknowledged.

1. **Config system gap (Major 1):** Added Subtask 0f. `parseStrategy()` now has a generic fallback for unknown strategy types — returns `{ type, ...raw }` instead of throwing. Added `GenericStrategyParams` to `StrategyParams` union. Each Strategy class validates its own params.

2. **Action pattern contradiction resolved (Major 2):** Phase 0 strategy wrappers MUST return `StrategyAction[]` — adapter-direct calls in `onTick()` are no longer permitted. This ensures dry-run mode is correct from day one. Effort note added (~0.5 day additional).

3. **Infrastructure tension acknowledged:** Added note in Subtask 0c that Phase 0's scope (engine.ts, BotState, config.ts, MarketSnapshot) is significant vs Principle 3. Tension managed by wrapping rather than rewriting.

4. **Phase 0 acceptance criteria expanded:** Added "Existing bot YAML configs parse and work identically" and "Integration test: mock adapter + mock strategy verify engine dispatch flow".

### Rev 2 (2026-03-22) — Architect REVISE feedback

Applied all 6 items from Architect review:

1. **Dual execution path resolved (Issue #1):** Added explicit "Phase 0 Decision" section documenting Path A (engine.ts/runBot) vs Path B (strategies/run*). Decision: new strategies engine-only, standalone commands untouched, deprecation deferred. Added to Guardrails "Must NOT Have" list.

2. **MarketSnapshot enrichment added (Issue #2):** Created Subtask 0b. `EnrichedSnapshot` extends `MarketSnapshot` with `klines: ExchangeKline[]`, `orderbook: { bids, asks }`, `openInterest: string`. Uses existing adapter methods. Phases 1/2/4 updated to reference specific EnrichedSnapshot fields they depend on.

3. **`edit_order` added to StrategyAction (Issue #3):** Added `{ type: "edit_order", orderId, price, size }` to the discriminated union. Noted that adapter.editOrder() already exists at interface.ts:94. Phase 1 simple-mm explicitly noted as first user of edit_order for quote updates.

4. **BotState extraction made explicit (Issue #4):** Created Subtask 0a with detailed breakdown of which fields stay in BotState (engine-generic) vs which move to strategy-private state (grid/dca/arb fields). Specific acceptance criteria for zero strategy-specific references in engine code.

5. **Phase 5 split into Phase 5 (REFLECT) + Phase 6 (CLI) (Issue #5):** REFLECT (trade-journal.ts + reflect.ts) now Phase 5, depends only on Phase 0. CLI integration now Phase 6, depends on all phases. Phase 5 can start in parallel with Phases 1-4. Dependency graph updated.

6. **Effort estimates revised (Issue #6):** Phase 0 increased from 3-4 to 5-7 days. Total increased from 24-32 to 28-38 days. Detailed effort breakdown added for Phase 0 subtasks. Phase 0 now accounts for BotState extraction (~1.5d), enrichment (~1d), dry-run (~0.5d).

**Architect synthesis applied:**
- Phase 0 strategies originally allowed adapter-direct calls (Rev 2); superseded by Rev 3 — all wrappers must return StrategyAction[]
- Dry-run architecture description added as Subtask 0e
- ADR "Consequences" updated to include BotState extraction
- ADR "Follow-ups" updated to include standalone deprecation timeline
