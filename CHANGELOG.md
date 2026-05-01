# Changelog

All notable changes to `perp-cli`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `perp wallet manage account-mode <unified|standard|portfolio>` — set HL account abstraction mode via `userSetAbstraction` action (master-signed)
- `perp account balance` redirect — friendly pointer to `perp portfolio` (renamed in v0.12)
- `CHANGELOG.md` (this file)

### Changed
- TBD per pending v0.12.8 commits

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

[Unreleased]: https://github.com/hypurrquant/perp-cli/compare/v0.12.7...HEAD
[0.12.7]: https://github.com/hypurrquant/perp-cli/compare/v0.12.6...v0.12.7
[0.12.6]: https://github.com/hypurrquant/perp-cli/compare/v0.12.5...v0.12.6
[0.12.5]: https://github.com/hypurrquant/perp-cli/compare/v0.12.3...v0.12.5
[0.12.3]: https://github.com/hypurrquant/perp-cli/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/hypurrquant/perp-cli/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/hypurrquant/perp-cli/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/hypurrquant/perp-cli/compare/v0.11.0...v0.12.0
