# Changelog

All notable changes to `perp-cli`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

QA cycle `qa/2026-05-16-numeric-audit-test-followup` — 34 commits. The first numeric-validation block closes test-coverage gaps from the v0.13.0 / numeric-validation-audit cycles, adds a shared NaN/empty-string guard helper across all 4 adapters, and surfaces the missing `liquidationPrice` in `perp portfolio`; **verified end-to-end against mainnet** (60 read-only CLI commands inside `perp-qa` Docker container, 4 DEX, zero false positives). Later commits add sizing / utils / Lighter coverage, fix two latent arb-sizing / `symbolMatch` defects surfaced while adding those guards, and stop an abort-listener leak in the polling loops (these are unit + `tsc` verified, not part of the 60-command live run). Full QA report: `docs/qa-reports/2026-05-16-numeric-audit-test-followup.md`.

### Added
- **`parseFiniteVenueNumber()` shared helper** in `src/utils/numeric.ts` — consolidates the venue-payload coercion contract (undefined/null → default 0, `""`/NaN/±Infinity/non-numeric → throw `EXCHANGE_ERROR` tagged with `structured.details.exchange`). Replaces `LighterAdapter._toFiniteNumber` (removed) and is now used by all 4 adapters in `getBalance` / `getPositions`.
- **HL / Aster / Pacifica adapter NaN guards** — 25 venue-payload sites across `getBalance` + `getPositions` now reject NaN/empty payloads instead of silent $0 substitution. Closes the asymmetry where only Lighter had the guard (26d78d7).
- **Real-vault OWS integration test** at `src/__tests__/integration/wallet-ows-aware.integration.test.ts` — 7 cases creating a real OWS vault in an isolated `HOME`, spawning the real CLI subprocess, and asserting the JSON envelope + post-state of `settings.json` for `wallet balance` / `generate` / `use` / `remove`.
- **Cross-adapter envelope consistency test** at `src/__tests__/exchanges/cross-adapter-envelope.test.ts` — parameterized over all 4 DEX names; pins that NaN/`""` payloads produce identical envelope shape downstream.
- **Docker QA report** at `docs/qa-reports/2026-05-16-numeric-audit-test-followup.md` (Phase A–E, ~400 lines) — container-parity checks, 60-command live matrix, cross-validation findings, and a P1 dead-code finding (`startEventStream` has no production caller; guards retained as defensive contract).

### Changed (potentially breaking for SDK consumers)
- **Empty-string venue payload (`""`) is now corruption, not "stringified zero"** (qa/2026-05-16 strict policy). All 4 adapters, `src/rebalance.ts`, `src/event-stream.ts`, and `src/exchanges/hyperliquid-outcome.ts:getOrderbook` now throw `EXCHANGE_ERROR` for `""` instead of `Number("") === 0` silent coercion. Overrides the 26d78d7 design decision that allowed Lighter `""→0`. **Live QA: 60 commands across 4 adapters surfaced zero false positives** — venues do not return `""` for real balance/position fields.
- **`LighterAdapter._toFiniteNumber` static method removed** — callers (including the now-removed test file `lighter-toFinite.test.ts`) must migrate to `parseFiniteVenueNumber(...)` from `src/utils/numeric.js`. Same contract, different import.

### Fixed
- **`perp portfolio` positions[] now surfaces `liquidationPrice`** (`src/commands/portfolio.ts:50-54, 390-398`). Pre-fix the field was stripped from the `.map()` projection even though the adapter populated it — a user who relied on `portfolio` alone could not see liquidation distance and had to re-fetch via `perp account positions -e <ex>`. Live verified on Lighter SKHYNIXUSD short ($1892.93 liq price now visible end-to-end).
- **`getPositionStats` NaN propagation** (`src/position-history.ts:170-179, 211-213`). A corrupt history row with non-finite `realizedPnl` previously propagated NaN into `stats.totalPnl` / averages / `bestTrade` / `worstTrade`, poisoning the entire stats report. The row is now skipped from PnL math (still counted in `totalTrades` for visibility) with a stderr warn naming the symbol/exchange.
- **`outcome book.time` empty-string + non-finite** (`src/exchanges/hyperliquid-outcome.ts:439-457`). Pre-fix `Number("") === 0` or `Number("abc") = NaN` was silently masked as a 1970-epoch timestamp; now throws `EXCHANGE_ERROR` for both. Includes a TypeScript type-narrowing fix (`book.time as unknown`) so the runtime guard compiles under `tsconfig strict`.
- **`event-stream` non-finite mark / liq / balance** (`src/event-stream.ts:131-136, 201-203`). Pre-fix a NaN/`""` mark price silently failed the `> 0` distance check and suppressed `liquidation_warning` / `margin_call` events. Now logs to stderr and skips the affected branch instead of laundering corruption as "no alert".
- **`rebalance` non-finite balance partial-result** (`src/rebalance.ts:51-77`). `fetchAllBalances` now rejects the affected adapter's `Promise.allSettled` branch on NaN/`""` so the plan never sums corrupt inputs. User sees a partial result instead of a phantom $0 balance.
- **arb sizing round-up could emit a venue-rejectable size** (`src/arb/sizing.ts`, `computeMatchedSize` / `computeSpotPerpMatchedSize`). The round-up fallback checked only the 20% overshoot bound, so a `ceil` size that was still below the venue `minNotional` was returned and then rejected by the venue. Now also requires `notionalUp >= minNotional` — SSOT Rule #2: fail with `null` rather than emit a size the venue will reject. Surfaced while adding the b420788 coverage guards.
- **`symbolMatch` was one-directional** (`src/utils.ts`). A user typing `BTC-PERP` against a venue position reported as `BTC` failed to match (only `candidate → target` was normalized). Now strips a trailing `-PERP` from **both** sides before comparing, so match no longer depends on which side carries the suffix.
- **abort-listener leak in polling loops** (`src/event-stream.ts`, `src/commands/history.ts`). `startEventStream()` and the `history track` PnL loop attached a fresh `abort` listener to a long-lived `AbortSignal` every iteration but relied only on `{ once: true }` to clean it up — which fires on abort, never on the timer branch that wins each normal cycle. Listeners leaked for the stream's lifetime and Node emitted `MaxListenersExceededWarning` past 10 cycles. The timer branch now detaches its listener so each iteration leaves the signal clean.

### Test
- **Unit suite**: 1400 → **1526 passed** (+126 across 81 files).
- **Integration suite**: +7 new OWS-vault cases (`pnpm test:integration`). Two pre-existing bridge suites fail in this environment, unrelated to this cycle — see "Outstanding" below.
- **New venue-payload coverage**: 50 dedicated cases across `numeric.test.ts` (11), `hyperliquid-toFinite.test.ts` (16, incl. supplementary `unified` / `portfolio` mode guards), `aster-toFinite.test.ts` (7), `pacifica-toFinite.test.ts` (7), `cross-adapter-envelope.test.ts` (9).
- **Additional coverage**: +36 sizing / utils / dex-asset-map regression guards (`arb-sizing.test.ts`, `utils.test.ts`, `dex-asset-map.test.ts`); +17 Lighter pure-surface units (`lighter-adapter.test.ts` — `getMarketIndex` / `toTicks` / signer-tier resolution, lifting `lighter.ts` line coverage 5.09% → ~10.5%); +1 abort-listener leak guard (`event-stream.test.ts`).

### Verified live (qa/2026-05-16 Docker QA, 4 DEX)
- **Phase A** — container parity: 1469 unit + 7 integration pass identically to host build.
- **Phase B** — 15 live mainnet commands across `portfolio`, `account positions`, `funds rebalance check/plan`, `arb scan`, `wallet balance` (incl. OWS-aware path, `--testnet`).
- **Phase E** — 45 additional live commands across `outcome` (HIP-4 view/book/list — verifies `book.time` guard against real venue), `market` (info/prices/funding/book/trades/kline per-DEX), `account`, `arb`, `risk`, `history`, `settings`, `alerts`, `funds info`, `strategy` (list-only), `background list`.
- **Total**: 60 live commands, 0 new-guard false positives, 198f196 error envelope (`INVALID_PARAMS` + remediation for `market hip3` without `-e hyperliquid`) confirmed end-to-end.
- **Cross-validation**: BTC mark price across 4 DEX agreed to within 0.032% (max-min spread $25 on $77.9k); Lighter SKHYNIXUSD position shape identical across `portfolio`, `account positions`, `account margin` (single source of truth in adapter).

### Outstanding (P1, deferred to next cycle)
- `src/event-stream.ts:startEventStream()` is **dead code** — production grep shows no callers; only `src/position-history.ts:8` imports the `StreamEvent` type. The venue-guard unit tests remain valid as defensive contracts but the runtime path is unreachable from the current CLI. Three handling options recorded in the QA report (keep / remove / re-add `perp events --tail` CLI). No action taken on the dead-code question; awaits user direction. (Its polling-loop abort-listener leak was still fixed this cycle — see Fixed — because the test suite drives the function directly.)
- **Two pre-existing bridge integration suites fail locally, unrelated to this cycle** (neither file touched since 2026-03; both independent of the numeric / listener work). Test-hygiene issues, not product defects:
  - `bridge.integration.test.ts > "CCTP same-chain doesn't throw"` — the `edge cases (offline)` block actually calls `getCctpQuote → fetch(CCTP_FEE_API/3/3)`; Circle's API now returns **HTTP 400** for same-chain (domain 3→3). `bridge-engine.ts` correctly throws (Rule #2, no hardcoded fee fallback) — the test's expectation depends on the external API tolerating same-chain and is stale; the block is also mislabeled "offline".
  - `bridge-strict.integration.test.ts` — `beforeAll` throws `Missing 'pk' / 'HL_PRIVATE_KEY' in .env`; all 98 cases skip but the file is marked failed. Expected when mainnet keys are absent (Section 7 forbids storing PKs on the host); a `describe.skipIf` guard would report this as skipped rather than failed.

## [0.13.0] — 2026-05-03

Adds Hyperliquid Outcome markets (HIP-4) support — a new asset class. Verified end-to-end against mainnet (place + cancel real order against asset id `100,000,010`). Two rounds of independent Codex review closed before release.

### Added
- **`perp outcome` command tree** — `list`, `book`, `positions`, `orders`, `buy`, `sell`, `cancel`. USDH-quoted, fully collateralized binary/range contracts; no leverage / no liquidation. $10 USDH min order. Currently 1 live market on mainnet (BTC binary daily settling at 06:00 UTC).
- **`HyperliquidOutcomeAdapter`** — composes with `HyperliquidAdapter` for signing. Asset id formula `100_000_000 + (10 * outcome + side)`. Bypasses HL's cached spot-state for fresh post-fill positions, then invalidates the `acct:` cache after place/cancel for downstream readers.
- **`OutcomeAdapter` interface** in `src/exchanges/outcome-interface.ts` (mirrors the SpotAdapter shape; ready for additional venues if HIP-4 pattern spreads).
- **Probe scripts** under `scripts/probe-outcome-{ws,order}.ts` documenting the WebSocket and exchange-action shapes that informed this implementation.
- **+16 unit tests** covering encoding (`10*outcome+side`), coin name conventions (`#<enc>`/`+<enc>`), description parsing, venue-rejection assertion helpers, and cancel-status validation. Total: 1305 → 1323.

### SSOT compliance
- **Rule #2 (No Fallback):** venue rejections embedded in `status:"ok"` + `statuses[0].error` are now thrown as `EXCHANGE_ERROR` (not silently masked); unknown outcome → `SYMBOL_NOT_FOUND`; out-of-range side / encoding overflow → `INVALID_PARAMS`. `_resolveUserAddress()` prefers `_hl.address`, falls back to OWS-stored agent meta `userEvmAddress`, and throws `NO_SIGNER_AVAILABLE` only if both are absent (no silent zero-balance substitution).
- **Rule #3 (Single Secret Source):** no new env vars; reuses existing HL agent.

### UX
- **`--dry-run`** uses `command.optsWithGlobals()` so the parent program's flag is not shadowed; pre-validates min-notional so the dry-run output cannot lie about a viable order.
- **Encoded-side mismatch detection** — `outcome buy 2 #10` (where `#10` encodes outcome 1) throws `INVALID_PARAMS` with guidance instead of silently routing to outcome 2.
- **Pre-checks spot USDH balance** on buy and surfaces `INSUFFICIENT_BALANCE` with a "bridge USDC→USDH" remediation instead of an opaque venue error.
- **`outcome orders`** uses the normalised lowercase `buy`/`sell` from the HL adapter (was rendering all buys as SELL).

### Out of scope (deferred)
- Portfolio aggregation of outcome holdings (roll into `perp portfolio`).
- Landing page outcome line.
- `outcome close <outcome> <side>` shortcut (use `outcome sell <outcome> <side> <usd>` for now).
- HIP-4 builder/deployer mechanics for creating new outcomes/questions.

## [0.12.18] — 2026-05-02

Closes Codex independent review of v0.12.17. 1 HIGH regression + 1 MEDIUM Rule #2 gap.

### Fixed
- **`account twap-orders` over-broad catch (HIGH, v0.12.17 regression)** — `src/commands/account.ts` catch wrapped both `getAdapter()` and `pac()`, then unconditionally returned `NOT_SUPPORTED` + Pacifica remediation in JSON mode. This mislabeled unrelated failures (network errors, locked wallets, missing PK, other typed `PerpError`s). Now uses an explicit `hasPacificaSdk()` guard so only the actual Pacifica-only assertion is rewritten; other errors propagate to the standard classifier untouched.
- **Landing page Aster agent-required false-positive (MED)** — `LandingExchangeStatus` now carries `errorCode` and the agent-required hint requires both (a) local Aster agent absent AND (b) the failure was actually `NOT_IMPLEMENTED` / `NO_SIGNER_AVAILABLE` / `AGENT_EXPIRED`. Generic Aster outages no longer render "agent required" — they fall through to the red dash (Rule #2: no silent classification fallback). Tests 1305 → 1307 (+2 regression cases).

## [0.12.17] — 2026-05-02

### Fixed
- **`account twap-orders` HL/LT/Aster generic error** — non-Pacifica venues surfaced "Market settings are only available on Pacifica" via the shared `pac()` helper, leaking an internal helper name. Now returns a TWAP-specific `NOT_SUPPORTED` envelope with `remediation: "Use 'perp -e pacifica account twap-orders'"`.
- **Landing page Aster agent-missing detection** — tightened detection so only the `NOT_IMPLEMENTED` "agent required" path renders the agent-required hint; other failure modes still fall through to the red dash (Rule #2 — no silent fallback).

### Docs
- **Skill bundle alignment** — `skills/perp-cli/SKILL.md` now reflects v0.12.16 commands and follows the Anthropic skill-authoring guide.

## [0.12.16] — 2026-05-02

### Fixed
- **Landing page Aster status clarity** — `perp` no-arg landing page rendered `Aster: —` (generic dash) for users with env-PK but no registered Aster agent, indistinguishable from a venue outage. Aster venue ships only signed account endpoints (no public address-based balance query exists, unlike HL/PAC/LT confirmed via v3 docs). Now renders `⚙ Aster  agent required → perp wallet agent approve aster` when agent missing; other failure modes still fall through to the red dash.

## [0.12.15] — 2026-05-02

### Fixed
- **Top-level catch preserves PerpError code + remediation** — `index.ts` program-level catch was the last spot where typed errors got downgraded to `code:"FATAL"` even after v0.12.13's classifyError fix. Now branches on `err instanceof PerpError` and forwards the full structured payload (status, retryable, retryAfterMs, remediation) into the JSON envelope. Aster's NOT_IMPLEMENTED for missing agent now surfaces with the correct typed code and actionable remediation. Verified live in Docker.

## [0.12.14] — 2026-05-02

Release follow-up for v0.12.13. Closes remaining MCP surface drift and fixes invalid-symbol trade validation ordering.

### Fixed
- **MCP server stale v0.12.x surfaces** (MED) — closed 10 leftover stale user-facing references in `mcp-server.ts`: 4-DEX lists now include Aster, and advisor/schema/prompt output no longer points at removed `status` / `account balance` commands.
- **Trade validator invalid-symbol flow** (MED) — `validateTrade()` now checks `getMarkets()` membership before `getOrderbook()`, so invalid symbols return `symbol_valid=false` instead of surfacing venue orderbook errors. Added a regression test.

## [0.12.13] — 2026-05-01

Release-stable target. Fixes 2 BLOCKERS + 2 MEDIUM identified in Codex final QA of v0.12.12. Tests 1282 → 1301 (+19).

### Fixed
- **HL standard/default mode portfolio undercount** (BLOCKER) — `HyperliquidAdapter.isUnifiedAccount` was a hardcoded `true`, causing `portfolio.ts` to drop spot USDC from `totalAccountValueUsd` for standard/default-mode users. Replaced with dynamic getter from `_getAbstractionMode()`. Updates 3 call sites: portfolio.ts, spot-perp-arb-strategy.ts, funding-arb-v2-strategy.ts.
- **PerpError → JSON envelope semantic loss** (BLOCKER) — `classifyError()` ignored `err instanceof PerpError` and re-derived from message text; `withJsonErrors()` dropped `code` and `remediation`. Now `PerpError` is the source of truth: typed code preserved, remediation surfaced at top level. Aster `NOT_IMPLEMENTED` for missing agent now correctly surfaces with remediation.
- **Aster 429 retry — 8s backoff reachable** (MED) — `MAX_ATTEMPTS=3` made the documented 8s wait unreachable. Bumped to 4 (initial + 3 retries with 2s/4s/8s).
- **MCP server v0.12.x alignment** (MED) — added Aster support, portfolio queries 4 exchanges, drops references to renamed commands (`status` / `account balance`).

## [0.12.12] — 2026-05-01

Discovered via HypurrQuant_FE reference comparison: Aster venue rejects master self-signing entirely. Codex's v0.12.11 user/signer split was correct syntax but didn't address the venue rule.

### Changed
- **Aster requires agent for Tier 2/3** (HIGH) — `aster.ts:_resolveSigner()` now throws `NOT_SUPPORTED` for master/PK self-signing with remediation `perp wallet agent approve aster --master <wallet>`. Per Aster V3 spec, `signer` MUST be a registered API_WALLET (agent); master is never a valid signer. Reference: HypurrQuant_FE `AsterPerpAdapter.ts:773-775`.

### Fixed
- **Aster signed GET/DELETE 429 retry loop restored** (regression from v0.12.11 dd85a96) — up to 3 attempts with exponential backoff (2s/4s/8s) and fresh nonce/signature per attempt. Non-429 errors still throw immediately.
- **`alerts.ts:303` env passthrough** — `ASTER_PRIVATE_KEY` was missing from the alerts daemon spawn env list. Fixed (Codex v0.12.11 re-review #5 follow-up).

### Deferred
- HL portfolio non-USDC collateral math (sum HYPE/BTC/USDH at mark prices) — Codex v0.12.11 re-review #3 PARTIAL. v0.12.11 stderr warning preserved; full math deferred to a separate change once spotMetaAndAssetCtxs pricing logic is in place.

## [0.12.11] — 2026-05-01

Aggregate fix from Codex independent review of v0.12.0→v0.12.10. 7 commits, +21 tests (1260 → 1281).

### Fixed
- **Aster Tier 2/3 signer model** (HIGH) — master/PK paths now emit `user` and `signer` as separate query fields per V3 spec, even when values are identical. Was the actual root cause of "Signature check failed" on `/fapi/v3/accountWithJoinMargin`.
- **Aster signed GET/DELETE error code validation** (HIGH) — unified `_handleAsterResponse()` validates HTTP status AND venue JSON error envelope. Previously HTTP 200 + `{code, msg:"..."}` was silently cached as zero balance (Rule #2 violation).
- **HL `dexAbstraction` mode** (MED) — was throwing INVALID_PARAMS; now mapped to unified semantics (spot pool = collateral). Eliminates a venue-side state that blocked legacy users.
- **HL portfolio non-USDC collateral** (MED) — getBalance() emits stderr note when portfolio-margin user has non-USDC eligible collateral (HYPE/BTC/USDH) so undercount is visible.
- **`wallet key create --passphrase` shadow** (MED) — applied `optsWithGlobals()` fix from v0.12.3 to this missed subcommand.
- **Setup landing-page Aster check** (LOW) — recognizes `ASTER_PRIVATE_KEY` (missed by v0.12.10 envMap restore).
- **Aster testnet support** (LOW) — `aster-typed-data.ts` now branches Domain B chainId by `_testnet` flag (1666 mainnet, 714 testnet).

### Removed
- Stale "env-key fallback" comment in `manage.ts:315` (no longer accurate post-keystore migration).

## [0.12.10] — 2026-05-01

### Fixed
- `tryLoadPrivateKey("aster")` now reads `ASTER_PRIVATE_KEY` env var. v0.12.4 cleared the entry (legacy HMAC removal) and v0.12.6 only restored the `EXCHANGE_ENV_MAP` half — the `config.ts` `envMap` used by adapter init was missed, so Aster Tier 3 PK direct path returned "No signing path configured" even with a valid env-PK set. Discovered during v0.12.9 Docker QA: PAC/HL/LT routed via env, Aster blocked.

## [0.12.9] — 2026-05-01

### Fixed
- `_getAbstractionMode()` now maps HL's implicit `"default"` response (returned when a user has never invoked `userSetAbstraction`) to `"standard"`. Previously threw `INVALID_PARAMS` UNKNOWN_ACCOUNT_MODE for unset accounts, blocking `getBalance()` for any new HL user. Discovered during v0.12.8 Docker QA on a fresh wallet.

## [0.12.8] — 2026-05-01

### Added
- `perp wallet manage account-mode [<unified|standard|portfolio>]` — set or query HL account abstraction mode via `userSetAbstraction` action (master-signed). No-arg form prints current mode without changing it.
- `perp account balance` redirect — friendly pointer to `perp portfolio` (renamed in v0.12), exits 1 with remediation instead of "unknown command".
- `CHANGELOG.md` — Keep a Changelog format; v0.12.0 onward documented.

### Changed
- `HyperliquidAdapter.setAddress(address)` — read-only path lets the show branch query `userAbstraction` without unlocking the master key.

## [0.12.7] — 2026-05-01

### Added
- `HyperliquidAdapter._getAbstractionMode()` — explicit query to HL info `userAbstraction`. Returns `"unified" | "standard" | "portfolio"`. Cached via `TTL_ACCOUNT`.

### Fixed
- `getBalance()` now branches by actual account abstraction mode instead of the `!_dex` heuristic. Standard-mode users (required for builder fee accrual) no longer receive unified accounting by mistake.
- Removed silent catch fallback in `getBalance()` (SSOT Rule #2): spot fetch errors propagate with remediation instead of falling back to perp values silently.

## [0.12.6] — 2026-05-01

### Fixed
- Restored Aster as a normal EVM exchange in `EXCHANGE_ENV_MAP`. v0.12.4 over-corrected by removing Aster entirely; users importing an EVM key got HL/LT/PAC configured but not Aster despite Plan v3.0 retaining `ASTER_PRIVATE_KEY` Tier 3 path.
- `wallet set aster <evm-pk>` now validates as EVM (32-byte secp256k1) — same as HL/LT.

## [0.12.5] — 2026-05-01

### Added
- `scripts/sync-skill-version.mjs` — auto-syncs `skills/perp-cli/SKILL.md` `metadata.version` to `package.json` version on every release. Wired into `prepublishOnly`.
- `pnpm sync-skill-version` script for manual runs.

### Fixed
- SKILL.md `metadata.version` was stuck at `"0.7.7"` for 5 major version cycles. Synced to current package version.

## [0.12.4] — orphan tag (npm not published)

Tagged but never published to npm — paused for the SKILL.md version-sync finding from clean-state Docker QA. Contents folded into v0.12.5.

## [0.12.3] — 2026-05-01

### Added
- `--non-interactive` flag for `perp setup` — full scripted onboarding via `--wallet-name`, `--passphrase`, `--default-exchange` (CI / Docker / agent-driven init).
- `wallet generate` and `wallet import` now accept `--passphrase` flag and respect `OWS_PASSPHRASE` env via the standard 3-path resolver.

### Fixed
- Auto-rollback orphan local OWS wallet on pre-venue failure of `agent approve` (HL / PAC / Aster). Retry no longer hits "wallet name already exists".
- Improved remediation strings for `APPROVE_PARTIAL` errors.

### Removed
- Aster legacy HMAC path: `EXCHANGE_ENV_MAP.aster` (chain: "apikey"), `EXCHANGE_PK_ENV_VARS.aster`, setup wizard's `ASTER_API_KEY` prompt. (Note: over-corrected — restored as EVM in v0.12.6.)

## [0.12.2] — 2026-05-01

### Fixed
- Pinned `lighter-ts-sdk` to exact `1.0.10`. SDK 1.0.11 shipped a breaking change to `signChangePubKey` (object-args → positional-args) under a patch version bump (SemVer violation).
- `--passphrase` flag on subcommands (`wallet generate/import`, `wallet agent *`, `setup`) now uses `command.optsWithGlobals()` to break the parent program's same-named flag shadow. Previously `--passphrase X` on subcommand was silently ignored, causing `wallet generate` to encrypt with empty string.

## [0.12.1] — 2026-05-01

### Fixed
- Lighter agent wiring in `_initWithOws` code path. The OWS-active flow skipped Tier 1 (agent) wiring for Lighter, falling through to auto-setup-at-slot-4 and breaking under SDK 1.0.11.

## [0.12.0] — 2026-05-01

### Added
- **SSOT Rule #3** (Single Secret Source per Key) — see `docs/SSOT_RULES.md`.
- Lighter L2 keystore at `~/.perp/lighter-agents/<account>-<slot>.json` (AES-256-GCM, mode 0600). Replaces plaintext env storage.
- One-time auto-migration of legacy `LIGHTER_API_KEY` env to encrypted keystore.
- `wallet show --json` now exposes `owsActive: { name, evmAddress, solanaAddress }` so agents can discover the master EVM/Solana address without env-derived fallbacks.
- Lighter referral apply is now L2-signed (works via agent path; previously gated by master `pk`).

### Changed
- Referral codes are now mandatory — `settings.referrals` field and `settings referrals on/off` command removed. Pacifica's builder code was already always-on; HL/LT aligned.
- `~/.perp/.env` is the only auto-loaded env file. CWD `.env` auto-load removed (was a Rule #3 violation surface).

### Fixed
- Referral apply `.catch` no longer marks `applied=true` on failure (SSOT Rule #2). Failures propagate to stderr; `referralApplied` stays false until next try.

### Security
- Lighter L2 slot key is no longer stored in `.env` plaintext. Aligned with Aster/HL/PAC agents which were already in OWS vault.

[Unreleased]: https://github.com/hypurrquant/perp-cli/compare/v0.12.16...HEAD
[0.12.16]: https://github.com/hypurrquant/perp-cli/compare/v0.12.15...v0.12.16
[0.12.15]: https://github.com/hypurrquant/perp-cli/compare/v0.12.14...v0.12.15
[0.12.14]: https://github.com/hypurrquant/perp-cli/compare/v0.12.13...v0.12.14
[0.12.13]: https://github.com/hypurrquant/perp-cli/compare/v0.12.12...v0.12.13
[0.12.12]: https://github.com/hypurrquant/perp-cli/compare/v0.12.11...v0.12.12
[0.12.11]: https://github.com/hypurrquant/perp-cli/compare/v0.12.10...v0.12.11
[0.12.10]: https://github.com/hypurrquant/perp-cli/compare/v0.12.9...v0.12.10
[0.12.9]: https://github.com/hypurrquant/perp-cli/compare/v0.12.8...v0.12.9
[0.12.8]: https://github.com/hypurrquant/perp-cli/compare/v0.12.7...v0.12.8
[0.12.7]: https://github.com/hypurrquant/perp-cli/compare/v0.12.6...v0.12.7
[0.12.6]: https://github.com/hypurrquant/perp-cli/compare/v0.12.5...v0.12.6
[0.12.5]: https://github.com/hypurrquant/perp-cli/compare/v0.12.3...v0.12.5
[0.12.3]: https://github.com/hypurrquant/perp-cli/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/hypurrquant/perp-cli/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/hypurrquant/perp-cli/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/hypurrquant/perp-cli/compare/v0.11.0...v0.12.0
