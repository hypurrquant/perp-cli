# Open Questions

## plugin-architecture - 2026-03-19

- [ ] Should `TpSlCapable` be a unified interface or should TP/SL remain exchange-specific? -- Pacifica uses `sdk.setTPSL()` with a unique params shape, HL uses `triggerOrder()` with grouping. Unifying may lose exchange-specific options (like HL's `positionTpsl` grouping).
- [ ] Should the registry factory functions handle full adapter construction (including referral codes, dex config, lazy imports) or should `index.ts` keep that logic? -- Moving everything to registry makes it self-contained but tightly couples registry to settings/env. Keeping construction in index.ts is pragmatic but means the switch statement stays.
- [ ] The `adapter.sdk` access pattern (PacificaAdapter exposes the raw PacificaClient) is used in 20+ places in commands. Should the plan include wrapping these SDK calls behind adapter methods (e.g., `adapter.createTWAP()` instead of `adapter.sdk.createTWAP()`) or is the `PacificaSdkCapable` type guard sufficient? -- Wrapping is cleaner but significantly more work.
- [ ] Lighter's `withdraw(amount: number, ...)` takes a number while the unified interface uses string. Should we also update the `funds.ts` command to use the unified `withdraw()` method, or keep the existing sub-command pattern (each exchange has its own `withdraw` sub-command)? -- The sub-command pattern is actually user-friendly since each exchange has different withdrawal semantics.
- [ ] Should the `_dexAdapters` Map in index.ts (line 302) for HIP-3 dex adapters also use the registry, or is it fine as-is since it's HL-specific? -- Registry is for exchange-level, dex variants are exchange-internal.
- [ ] Are there any downstream consumers (scripts, CI, other tools) that import concrete adapter classes directly from the barrel? If so, removing those exports would be a breaking change. -- Need to verify before Step 6.

## bot-engine-v2 - 2026-03-22

- [x] **Strategy action execution model: synchronous or queued?** — RESOLVED (Rev 2): Phase 0 wrappers call adapter methods directly. Full StrategyAction return pattern deferred to Phase 1 for validation. If MM strategies can express all needs as actions, pattern is proven for all phases.
- [x] **Dual execution path resolution** — RESOLVED (Rev 2): New strategies are engine-only. Standalone `run*` commands (bot grid/dca/trailing-stop/twap/funding-arb) remain untouched. Deprecation deferred to post-v2 plan.
- [ ] **claude-agent API key configuration** — Where should the Claude/OpenAI API key be stored? Options: env var (CLAUDE_API_KEY), ~/.perp/config.yaml, or passed via CLI flag. Impacts Phase 3 claude-agent.ts.
- [ ] **APEX BTC macro data source** — Radar Stage 4 needs BTC price and dominance data. Current adapters may not expose BTC if not traded on the DEX. Options: add a lightweight BTC price feed (CoinGecko API), require BTC to be available on the exchange, or make Stage 4 optional. Impacts Phase 4 radar.ts scoring accuracy.
- [ ] **Backtest data source and fidelity** — `perp bot backtest` needs historical kline data. Current `adapter.getKlines()` may have limited history (e.g., Pacifica 48h). Options: use exchange API history (limited), download from external source, or accept low-fidelity replay of available data. Impacts Phase 6 backtest command.
- [ ] **Strategy hot-reload** — Should running bots support changing strategy parameters without restart? Current engine has no mechanism for this. Low priority but worth deciding before Phase 0 interface design is finalized.
- [ ] **Multi-symbol strategies** — Some strategies (funding-arb, hedge-agent, APEX) operate across multiple symbols. The current BotConfig has a single `symbol` field. Options: allow `symbols: string[]` in config, or have multi-symbol strategies ignore the config symbol and scan all. Impacts config.ts schema design in Phase 0.
- [x] **Trade journal storage limits** — RESOLVED (Rev 2): Phase 5 acceptance criteria now includes "Journal file rotation (new file per day) prevents unbounded file growth."
- [ ] **EnrichedSnapshot performance budget** — Fetching klines + orderbook + openInterest every tick adds latency. Need to decide: what TTL for cached enriched data? Should kline fetch be configurable interval (e.g., every 5th tick)? Impacts Phase 0 Subtask 0b.
- [ ] **Dry-run fill simulation fidelity** — Dry-run mode simulates fills when price crosses order price. Should it also simulate partial fills, slippage, or fees? Higher fidelity = more useful but more complex. Impacts Phase 0 Subtask 0e.
