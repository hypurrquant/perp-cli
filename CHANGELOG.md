# Changelog

All notable changes to `perp-cli`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/hypurrquant/perp-cli/compare/v0.12.15...HEAD
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
