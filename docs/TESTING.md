# perp-cli Testing Standard

> Canonical testing standard for perp-cli (CLI, MCP server, `perp-cli/ws` / `@hypurrquant/perp-ws`).
> Every venue, feature and PR must satisfy it. Reviewers cite this file by section number.
> Companion rules: [`docs/SSOT_RULES.md`](SSOT_RULES.md) (no fallback, single secret source),
> [`docs/QA_WORKFLOW.md`](QA_WORKFLOW.md) (agent QA guardrails).

**Why this exists.** perp-cli has 13 perp venues + Derive options, a CLI, an MCP server and a WS
library. Until 0.15.0 the tests were per-venue unit tests with hand-built mocks, and nothing made
every venue meet the same output contract. Live QA of the published 0.15.0 found bugs no test caught:
Ondo klines off the interval grid and in the future; Lighter funding "history" of one row; Pacifica
`market prices` printing raw venue rows; funding rows without `intervalHours` / `rateKind` on 9
venues; `arb scan` marking an unverified-funding venue `executable`; `--gaps` comparing KRW with USD;
`market list` without `-e` dropping 4 venues; MCP and CLI disagreeing; WS and CLI directories
disagreeing; server row caps silently truncating. Each of those is now a check in the conformance
suite (§3) with an id, and the ones still open are listed in `KNOWN_FAILURES` (§3.4).

---

## 1. Test layers and when each is required

| # | Layer | Where | Runs in | Required when |
|---|---|---|---|---|
| 1 | **Unit tests** | `src/__tests__/**` (not `integration/`, not `conformance/`) | `pnpm test` (CI) | Every change to logic. One behaviour per test, named after the behaviour. |
| 2 | **Recorded-fixture adapter tests** | `src/__tests__/exchanges/*.test.ts` + `src/__tests__/fixtures/<venue>/` | `pnpm test` | Every parser / mapping of venue data (markets, funding, book, trades, candles, errors). Fixtures are **real recorded responses** (§2), never hand-written shapes. |
| 3 | **Cross-venue conformance suite** | `src/__tests__/conformance/` + `src/__tests__/fixtures/conformance/` | `pnpm test` (offline replay) | **Mandatory for every venue.** A registered venue is included automatically; it fails without a capability-table entry and a recorded fixture (§3). |
| 4 | **CLI ⇄ MCP parity** | `conformance/cross.conformance.test.ts` | `pnpm test` | Any change to a read command or an MCP read tool (`get_markets`, `get_funding_rates`, `get_prices`, `health_check`). |
| 5 | **WS library gates** | `src/__tests__/ws/**`, `conformance/ws.conformance.test.ts`, `scripts/ws-gate/release-gate.mjs` | `pnpm test`; the gate before a WS release | Any change under `src/ws/` (codecs, stream, transport). The release gate (bundle purity, tarball, consumer typecheck, Next build, live smoke) before publishing `perp-cli/ws` / `@hypurrquant/perp-ws`. |
| 6 | **Opt-in live smoke** | the same conformance suite with `PERP_LIVE=1` (`pnpm test:conformance:live`); legacy `src/__tests__/integration/` (`pnpm test:integration`) | nightly workflow; locally on demand | Before re-recording fixtures; when a venue changes its API; nightly. Never part of `pnpm test`. Read-only public endpoints only. |
| 7 | **Pre-release live QA against the published tarball** | `scripts/release-qa/run.mjs` (`pnpm release-qa --version <v>`) | by the releaser; nightly against `latest` | **Required before every release is announced** (and for every `@hypurrquant/perp-ws` publish): install the published packages into a clean dir, run the read matrix (the conformance suite against the installed binary), the WS checks and the MCP checks. A failure not in `KNOWN_FAILURES` blocks the release announcement / requires a patch release. |

`pnpm test` = layers 1–5 offline (no network). `ci.yml` runs it on Node 20 / 22 / 24.

---

## 2. Fixtures

- **Only real responses.** A fixture is a recorded live response, trimmed and anonymized by a
  script. A hand-written JSON shape is a forbidden pattern (§9) — it encodes what the author
  *thinks* the venue sends, which is exactly what drifted in 0.15.0.
- **Anonymization:** private (account) data goes through `scripts/ws-probe/make-fixtures.ts`
  (addresses / account ids → dummies, ids and hashes remapped, amounts perturbed, timestamps
  shifted, secret fields dropped, a guard refuses to write a real id). Public market data goes
  through the same approach reduced to what public data carries
  (`src/__tests__/conformance/fixture-tools.ts`: secret fields dropped, trader identities and tx
  hashes remapped; prices and times are kept — the invariants check them).
- **Small but real:** lists are trimmed to keep-symbols (BTC / ETH / SOL, …) with the ids they join
  on, positional arrays keep matching indices, long series keep their first and last rows. Cells
  whose point is a full set (CLI ⇄ MCP / WS directory parity, eligibility) or a full server page
  (row caps) are recorded whole and stored gzipped (`<name>.json.gz`) — a trimmed directory would make
  every count agree (the first live run of this suite caught exactly that), so parity is never judged
  on trimmed data.
- **Re-record, don't edit.** `pnpm conformance:record --venue <id>` (§3.2). Commit a fixture only
  after reading the replay result.

---

## 3. The conformance suite

`src/__tests__/conformance/`:

| File | What |
|---|---|
| `harness.ts` | Record / replay of `fetch` and `ws`; `runCli()` runs the real `perp --json …` command tree in-process (or an installed binary, §3.8). |
| `contracts.ts` | The one shared output contract (zod schemas, §4). |
| `capabilities.ts` | The one capability table: per venue, `ok` / `alt` (a labelled alternate contract) / `unsupported` / `credentials` per read command, with reasons; `OPT_OUT`. |
| `checks.ts` | Per-cell invariants with stable ids. |
| `known-failures.ts` | `KNOWN_FAILURES` (§3.4). |
| `server-caps.ts` | Measured server row caps and supported candle intervals (§5.4). |
| `venues.conformance.test.ts` | Every venue × every read command + unknown-symbol cells + cross-venue price agreement. |
| `cross.conformance.test.ts` | `market list/prices` without `-e`, `health`, `arb scan` variants (fixture `cross`), CLI ⇄ MCP parity (untrimmed fixture `parity`). |
| `ranges.conformance.test.ts` | Limits, row caps, no silent empty, interval spacing, unsupported-interval refusal. |
| `ws.conformance.test.ts` | Every exported WS codec through the real stream; CLI ⇄ WS directory parity and eligibility. |
| `refusals.conformance.test.ts` | Registry-driven write-refusal table for every venue lacking the trading / account role. |

### 3.1 Modes

| Mode | How | Network |
|---|---|---|
| replay (default) | `pnpm test` | none: fetch + ws are served from the fixture; an unrecorded request fails the cell |
| live | `pnpm test:conformance:live` (`PERP_LIVE=1`, `vitest.conformance.live.config.ts`) | public mainnet reads |
| record | `pnpm conformance:record …` (`PERP_RECORD=1`, then prune, then replay) | public mainnet reads |
| installed binary | `PERP_LIVE=1 PERP_CONFORMANCE_BIN=<…/perp-cli/dist/index.js>` (release QA) | public mainnet reads |

Only the transport is replaced. Commands, adapters, caches and rate limiters are the real code. In
replay the `Date` clock starts at the fixture's capture time and advances in real time, so
"now"-relative requests (kline windows) and checks (no future candle) see the recorded now. The
suite runs with an isolated HOME (no keys exist), so every read is keyless.

### 3.2 Recording fixtures

```bash
pnpm conformance:record --venue ondo        # one venue (comma list allowed): venues + ranges + ws files
pnpm conformance:record --all               # every registered venue
pnpm conformance:record --cross             # cross-venue / CLI ⇄ MCP fixture
```

1. record (live, captured, trimmed, anonymized) → 2. prune (replay, keep only the exchanges used;
row-cap evidence is never pruned) → 3. verify (plain replay; read it before committing).

### 3.3 Capability table and opt-out

Every `listVenues()` entry needs a `VENUE_CONFORMANCE` entry and a fixture. A cell that is not
`ok` is declared with a reason and asserted: `unsupported` → `CAPABILITY_UNSUPPORTED` + remediation;
`credentials` → `NO_SIGNER_AVAILABLE` + remediation (keyless suite); `alt` → the labelled
alternate contract (`kind: "currentFunding"`, `kind: "rfqQuotes"`). An `ok` cell that answers an
alternate contract fails (`default-contract`), so the table cannot go stale. `OPT_OUT` excludes a
venue only with a documented reason.

### 3.4 Known failures

`KNOWN_FAILURES` (`known-failures.ts`) is the one explicit list of checks that fail today, each with
a reason. A listed check still runs and is **asserted to fail**: the fix makes the assertion fail and
forces the entry's removal in the same PR. An entry that no check evaluates fails the suite (stale).
Nothing is skipped. In live mode a data-dependent known failure that passes is a warning.

### 3.5 CLI ⇄ MCP parity

For the same fixture, `get_markets(v)` ⇔ `perp -e v market list` (both ok, same count, same base
symbols and marks, MCP rows carry the CLI row contract), `get_funding_rates` ⇔ `arb scan --rates`
(same symbols, same venues per symbol, rate-row fields), `get_prices` ⇔ `market prices` without `-e`
(same venues per symbol), `health_check` ⇔ `perp health` (same venues, same `allHealthy`).

### 3.6 WS library

For every exported codec, through the real `createVenueStream` with a fake `WsFactory`:

- recorded frames (`src/__tests__/fixtures/ws/`, ws-probe) and a recorded live session
  (`fixtures/conformance/ws-<venue>.json`): every event `schema: 1`; every `Dec` a decimal string or
  `null` (never `NaN`, `undefined`, or `"0"` for "no data" on mark / index / bid / ask / last);
  `funding.rateKind` and `predictedRate` per the documented table (`skills/perp-cli/references/ws-library.md`);
  bbo `bid < ask`; state sequence `idle → connecting → live → closed`; `close()` leaves no timer;
  a rejected `ready` exposes `.code`.
- **CLI ⇄ WS directory parity (hard invariant):** the canonical set of `stream.markets()` equals the
  CLI `market list` set built from the same recorded responses — compared by venue symbol when the
  CLI rows carry `venueSymbol` (Aster: one row per venue market, any quote); any difference must be
  in `WS_DIRECTORY_ALLOWLIST` with a reason. Every USD-quoted / dex WS entry has a canonical (a
  non-USD quote, Aster "U", is canonical null by contract); CLI market rows carry the same
  `rateKind` the WS stream reports.
- **CLI ⇄ MCP parity:** keyless `get_markets` lists the same markets as `market list` (ambiguous
  tickers included, `assetClass: "unclassified"`, canonical null) in the same row shape
  (`venueMarketRow`).

`scripts/ws-gate/release-gate.mjs` stays the release gate for the WS packages (bundle purity,
tarball contents, consumer typecheck, Next build, live smoke).

### 3.7 Live mode and the nightly workflow

`.github/workflows/conformance-nightly.yml` runs daily (and on demand): the live conformance suite
(read-only public mainnet) and the release QA of the published `latest` (§3.8). On failure it opens
or updates one issue labelled `conformance-nightly` with the report. A live failure means: the venue
changed (re-record + fix), a new bug (fix or register), or an outage (note it on the issue).

### 3.8 Pre-release live QA against the published tarball (required)

```bash
pnpm release-qa --version 0.15.1          # after `npm publish`, before announcing
pnpm release-qa --tarball perp-cli-0.15.1.tgz --tarball hypurrquant-perp-ws-0.15.1.tgz   # a local RC, before publishing
```

Installs `perp-cli@<v>` + `@hypurrquant/perp-ws@<v>` into a temp dir (empty HOME, no keys),
checks the versions, runs the conformance suite (venues + ranges) against the INSTALLED binary, the
WS checks against the installed `@hypurrquant/perp-ws` (directory, live stream, decimals, `"0"`
stand-ins, rateKind, bbo, state sequence, `ready.code`, no handle left after `close()`), and the MCP
checks against the installed `perp-mcp` (every read tool ok, `get_markets` count = CLI count).
Report: `<out>/release-qa.md`. A failure not in `KNOWN_FAILURES` blocks the announcement.

---

## 4. Universal output contracts (read commands, `--json`)

Envelope: `{ ok: true, data, meta: { timestamp } }` or `{ ok: false, error: { code, message,
remediation?, … }, meta }` — exactly **one** JSON document on stdout. Units: venue quantities are
**decimal strings** (exact, as published); times are **unix milliseconds** (integers); funding rates
are **fractions per `intervalHours`** (never percent, never pre-annualized; `annualizedPct` is a
percent number); computed analytics of `arb scan` are JSON numbers. **Unknown = `null`** — never
`0`, `""` or an omitted field. Objects are open: a venue may add fields (additive change).

| Command | `data` | Fields (type, nullability) |
|---|---|---|
| `market list` / `prices` / `info` (`-e v`) | `MarketRow[]` / `MarketRow` | `symbol` string · `markPrice` dec > 0 · `indexPrice` dec > 0 \| null · `fundingRate` dec \| null (per `fundingHours`, else the venue basis) · `volume24h` dec (USD notional) \| null · `openInterest` dec (**base units**) \| null · `maxLeverage` number > 0 \| null · `sizeDecimals` int ≥ 0 \| null · `stepSize` dec > 0 \| null · `fundingHours` number > 0 \| null · `marginTiers` `{lowerBound, maxLeverage}[]` \| null · additive: `fundingRateKind`, `predictedFundingRate` (same unit as `fundingRate`), `tradable`, `status`, `quoteAsset` |
| `market list` / `prices` (no `-e`) | `{ exchanges: Record<venue, MarketRow[]>, errors?: Record<venue, string> }` | every market-data venue is a key of `exchanges` or `errors` |
| `market funding` (history) | `FundingRow[]`, newest first | `time` ms · `rate` dec (fraction per interval) \| null only with `marketClosed: true` · `price` dec > 0 \| null · `intervalHours` number > 0 · `rateKind` `"lastSettled" \| "accruing" \| "predicted"` (null only with `marketClosed: true`) · `marketClosed` boolean, optional (QFEX: the window fell outside market hours — no funding, not a 0 rate) |
| `market funding` (no history API) | `CurrentFundingTerms` | `kind: "currentFunding"`, `venue`, `symbol`, `ticker`, `contractType`, `rateKind` (`"predicted"` \| null), `intervalRate` dec \| null, `intervalHours` \| null, `hourlyRate` \| null, `annualizedPct` \| null, `venueAnnualizedRate` dec \| null, `nextFundingTime` ms \| null, `swap`, `note` |
| `market book` | `{ bids, asks }` | `[price dec > 0, size dec > 0][]`; bids strictly descending, asks strictly ascending (aggregated levels), best bid < best ask |
| `market book` (RFQ venue) | `RfqQuotes` | `kind: "rfqQuotes"`, `markPrice`, `updatedAt` \| null, `baseSpreadBps` \| null, `quotes[{tier, notionalUsd \| null, bid, ask}]`, `note` |
| `market trades` | `PublicTrade[]`, newest first | `time` ms · `symbol` · `side` `"buy" \| "sell"` · `price` dec > 0 · `size` dec > 0 · `fee` **null** (the public tape has no fee) |
| `market kline` | `Kline[]` | `time` ms (candle open) · `open/high/low/close` dec > 0 · `volume` dec (base) \| null · `quoteVolume` dec \| null · `trades` int \| null; ascending |
| `health` | `{ allHealthy, network, exchanges[], unofficial[], skipped[] }` | probe: `exchange`, `status` `"ok" \| "down"`, `latency_ms` \| null, `error` \| null, `probe`, `apiStatus` |
| `arb scan` | opportunity[] | `mode: "perp-perp"`: `symbol, longExch, shortExch, markPrice, grossSpread, netSpread, estFeesPct, priceGapPct \| null`; `mode: "spot-perp"`: `perpExchange, spotExchanges[], perpFundingRate, direction, breakEvenDays \| null` + the common fields |
| `arb scan --rates` / `--compare <s>` | `{ symbols: RateSymbol[], exchangeStatus }` / `RateSymbol` | RateSymbol: `symbol, rates[], maxSpreadAnnual, longExchange, shortExchange, executable, readOnlyLegs[]`; rate: `exchange, symbol, canonical \| null, fundingRate, basis, hourlyRate, annualizedPct, markPrice \| null, nextFundingTime \| null, fundingVerified, apiStatus` |
| `arb scan --gaps` / `--basis` | rows | gaps: `symbol, maxGap, maxGapPct, cheapest, expensive`; basis: `symbol, prices: Record<venue, number>, priceDiff, pctDiff, buyOn, sellOn` |

Errors: unknown symbol → `SYMBOL_NOT_FOUND` + remediation; unsupported feature →
`CAPABILITY_UNSUPPORTED` + remediation; credential-gated read without a key → `NO_SIGNER_AVAILABLE`
+ remediation.

---

## 5. Invariants (check ids in brackets)

1. **Unknown is null, never 0** — no column whose every row is `0` (`null-not-zero`); prices > 0; WS
   `"0"` for mark / index / bid / ask / last is a stand-in (`no-zero-placeholder`).
2. **Same symbol, same meaning** — a canonical symbol means the same instrument on every venue: BTC
   and ETH market-list marks agree within 2 % (`agreement:<s>:mark`); `--gaps` / `--basis` never
   exceed 50 % (`same-quote`: KRW vs USD); MCP and CLI agree (§3.5).
3. **Klines** — opens aligned to the interval (`alignment`), never in the future (`not-future`),
   ascending + distinct (`sorted`), within the requested window (`window`), `low ≤ open, close ≤ high`
   (`ohlc`; RISEx: `low ≤ close ≤ high` only — the venue opens a bar at the previous close, passed through).
4. **Funding history** — newest first (`sorted`), distinct timestamps, honours `--limit`,
   ≥ 2 prints for a listed market (`history`), every row `intervalHours` + `rateKind` (`fields`).
   One history order on every venue since 0.15.1 (enforced in `perp market` after the adapter
   call): `trades` and `funding` newest first, `kline` oldest first.
5. **Limits, ranges, caps, intervals** (`ranges.conformance.test.ts`):
   1. **limit honoured** — a `--limit` / range the venue holds data for returns exactly `limit` rows /
      the full range; a response at a server cap must trigger paging; silent truncation fails
      (`cap:…:limit-honoured`).
   2. **no silent empty** — `[]` for a range / interval that has data fails; throw a typed error, or
      let the fixture prove the venue has no data (`no-silent-empty`).
   3. **interval verified** — every interval of `KLINE_INTERVALS` has a recorded cell whose bars are
      spaced by exactly that interval (`spacing`); an unsupported interval is refused before any I/O
      (`refused-before-io`) — beyond the adapter's own start-up requests (those the warm `market info`
      cell makes too, e.g. Hyperliquid `meta`, Aster `/time`).
   4. **documented caps** — `SERVER_CAPS` is the one table of measured caps; tests reference it.
      Caps that cannot be paged (`REFUSED_CAPS`: `BOOK_DEPTH_MAX`, `FUNDING_HISTORY_CAP`, trade
      caps) are imported from the code, and `CAP_TABLE_AGREEMENT` holds the CLI tables to the adapter
      constants.
      **Documented limits are not trusted until measured live; record the measurement date** (and
      how) in the table. Unmeasured endpoints are listed in `UNMEASURED_CAPS` and get no paging claim.
6. **Unknown symbol** → `SYMBOL_NOT_FOUND` with remediation on `info / funding / book / trades / kline`
   — never `ok: true` with `[]`.
7. **Unsupported feature** → `CAPABILITY_UNSUPPORTED` with remediation, declared in the capability table.
8. **Never executable** — a row whose long or short leg is a venue without the trading role or with
   `fundingVerified: false` is `executable: false`; without `--include-unverified` no unverified row
   appears (`never-executable`, `verified-only`).
9. **Read-only refusal** — every write / account path of a venue lacking the role refuses with
   `CAPABILITY_UNSUPPORTED` + remediation, one JSON document, **before any I/O or key load**
   (`create()` never called, zero fetch), also under `--dry-run` (`refusals.conformance.test.ts`).
10. **Eligibility** — a market whose venue status is not tradable (SETTLING, PENDING, OFFLINE,
    inactive, delisted) appears in none of `list`, `prices`, `funding` or the WS directory unless the
    command explicitly asks for it (`eligibility-cli`, `eligibility-ws`).
11. **CLI ⇄ WS directory parity** — §3.6 (`directory-parity`, `canonical-parity`, `ratekind-parity`).
12. **JSON contract changes are additive** — or listed under the CHANGELOG heading
    **"JSON contract changes"** of the release (with migration notes). Removing / renaming / retyping
    a field in §4 without that entry is a review blocker.

---

## 6. SSOT rules as testable rules ([`SSOT_RULES.md`](SSOT_RULES.md))

| Rule | Testable form |
|---|---|
| #2 no fallback | Every unknown is `T \| null` (schema: `nullable`, never optional); a live failure surfaces as a typed error, never as cache-as-live or a default (`null-not-zero`, `no-silent-empty`); a test exists that the failure path throws with remediation. |
| #2 shipped defaults | A default lives in `settings.ts DEFAULTS`, is resolved in one function, shown by `settings show`, and its result records `source`; a test pins each. |
| #2 no stopgap | No `TODO: proper fix later`; no `test.skip` / `.only` (§9). |
| #3 single secret source | Each venue's secret storage is in the venue definition (`secretStorage`) and SSOT_RULES #3 table; tests assert no secret on argv / env / settings / logs and no key load on refused paths (§5.9). |
| Venue definition is the SSOT | Roles, capabilities, intervals, caps come from the registry / adapter tables and are imported by tests, not copied (`server-caps.ts` imports adapter interval tables). |

---

## 7. Definition of done

### 7.1 Adding a venue

- [ ] `VenueDefinition` registered (roles, `fundingVerified`, `apiStatus`, `readOnlyRemediation` when read-only).
- [ ] `VENUE_CONFORMANCE` entry (symbol, keep-symbols, non-`ok` cells with reasons).
- [ ] `KLINE_INTERVALS` entry, and caps measured (`SERVER_CAPS`, with date + how) or listed in `UNMEASURED_CAPS`.
- [ ] Fixtures recorded: `pnpm conformance:record --venue <id>` (venue + ranges; `ws-<id>` if it has a WS codec; re-record `--cross`).
- [ ] `pnpm test` green with no new `KNOWN_FAILURES` entry — or each new entry justified in the PR.
- [ ] Recorded-fixture adapter tests for parsing edge cases (layer 2).
- [ ] Read-only venue: covered by the refusal table automatically — verify it lists the venue.
- [ ] `pnpm test:conformance:live` run once, result pasted in the PR.
- [ ] Docs: README venue table, skill docs, CHANGELOG.

### 7.2 Adding or changing a feature

- [ ] Unit tests for the behaviour (one behaviour per test).
- [ ] A read command / MCP read tool change: contract in `contracts.ts` + §4 updated; parity (§3.5) holds.
- [ ] JSON output change additive, or listed under CHANGELOG "JSON contract changes".
- [ ] Write path: refuses on read-only venues before I/O (refusal table green).
- [ ] WS change: codec checks + `release-gate.mjs` before publishing.
- [ ] Fixed a known failure: its `KNOWN_FAILURES` entry removed in the same PR.

### 7.3 Reviewer checklist

- [ ] No forbidden pattern (§9) in the diff.
- [ ] New fixtures are recorded (header `recordedWith`), not hand-written; no secrets / real ids.
- [ ] No new `KNOWN_FAILURES` entry without a reason and an owner.
- [ ] Contract change listed in the CHANGELOG.
- [ ] Release PR: `pnpm release-qa --version <v>` report attached after publishing.

---

## 8. Commands

```bash
pnpm test                                  # unit + fixture + conformance (offline) + WS
pnpm test:conformance                      # the conformance suite only (offline)
pnpm test:conformance:live                 # the same suite, live public mainnet (read-only)
PERP_CONFORMANCE_VENUES=ondo pnpm test:conformance:live   # one venue
pnpm conformance:record --venue <id>       # re-record (live → trim/anonymize → prune → replay)
pnpm release-qa --version <v>              # pre-release QA of the published packages
node scripts/ws-gate/release-gate.mjs      # WS package release gate
```

---

## 9. Forbidden patterns

- **Mocking the unit under test** (stubbing the adapter method the test claims to test).
- **Pass-through mocks of caches or limiters** (`withCache: (_k, _t, fn) => fn()`): they hide real
  behaviour — that is how a cache storing a `Set` (which JSON-serializes to `{}`) slipped through.
  Use the real cache in an isolated HOME / TMPDIR; the conformance harness replaces only the transport.
- **`test.skip`, `it.only`, `describe.skip`, `.todo` as a parking place** — register a known failure
  instead (§3.4).
- **Fixture shapes not taken from real responses** (hand-written JSON, "minimal" objects typed with
  `as never`). Legacy hand-built directories in `src/__tests__/ws/helpers.ts` are grandfathered for
  the frame-decoding tests only; new tests use recorded responses.
- **Asserting a bug** (pinning a wrong value so the test passes) — register it as a known failure.
- **Silent network in unit tests** — `pnpm test` makes no network call; a test that needs one belongs
  in live mode.

---

## 10. Known gaps of the suite

- Ondo candles need an API key (HMAC-signed read); the keyless suite asserts the typed
  `NO_SIGNER_AVAILABLE` refusal, so Ondo kline alignment / future-candle checks run only in a
  credentialed live QA. Do not record signed requests into fixtures.
- Caps of most endpoints are unmeasured (`UNMEASURED_CAPS`).
- Derive (options) has its own recorded-fixture tests (`exchanges/derive-options.test.ts`,
  `derive-options-mcp.test.ts`) and is not in the perp read matrix.
- Eligibility is checked on the full recorded directories of the WS venues; other venues are checked
  on their trimmed fixtures only.
