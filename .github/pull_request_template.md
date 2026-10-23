## What does this PR do?

<!-- Briefly describe your changes -->

Related issue: <!-- #issue-number (optional) -->

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm run build` compiles without errors
- [ ] No secrets, API keys, or private keys included
- [ ] Breaking change? If yes, described below

### Testing standard ([docs/TESTING.md](../docs/TESTING.md) §7)

- [ ] Tests for the behaviour (one behaviour per test); no `test.skip` / `.only`, no pass-through cache / limiter mocks, no mock of the unit under test
- [ ] New fixtures are **recorded** (`pnpm conformance:record` / `scripts/ws-probe`), anonymized, never hand-written
- [ ] Conformance suite green (`pnpm test`); every new `KNOWN_FAILURES` entry has a reason; a fixed known failure is removed
- [ ] JSON output change is additive, or listed under CHANGELOG **"JSON contract changes"** (and `contracts.ts` / TESTING.md §4 updated)
- [ ] Read command / MCP read tool changed → CLI ⇄ MCP parity holds; WS change → CLI ⇄ WS parity + `scripts/ws-gate/release-gate.mjs`
- [ ] Write path → refuses on read-only venues before any I/O or key load, also with `--dry-run`
- [ ] Row caps / intervals touched → measured live, `SERVER_CAPS` / `KLINE_INTERVALS` updated with the measurement date

**New venue** (TESTING.md §7.1): capability-table entry · `KLINE_INTERVALS` + caps measured or in `UNMEASURED_CAPS` · fixtures recorded (venue, ranges, ws, cross) · `pnpm test:conformance:live` output pasted below · README / skill / CHANGELOG.

**Release PR:** `pnpm release-qa --version <v>` report attached after `npm publish`.

### If applicable

- [ ] Updated `README.md` (new/changed commands)
- [ ] Updated `API_RESPONSE_SPEC.md` (changed `--json` output)
- [ ] Added/updated tests for new functionality
- [ ] MCP tool name or schema changed? Documented in description
- [ ] **Live ↔ Unit cross-validation table filled in below** (required when adding/changing a `--json` command or anything that can affect envelope shape)

## Live ↔ Unit Test Cross-Validation

<!--
이 섹션은 새/변경된 `--json` 명령 또는 envelope shape 영향이 있는 변경에서
필수. 한 라이브 호출의 응답을 캡처하고, 응답의 핵심 필드가 어떤 단위 테스트
case 와 1:1 매핑되는지 표로 채워라. v0.13.0 의 `outcome view` 가
단위 테스트 없이 라이브 검증만으로 들어왔던 패턴이 재발하지 않도록 하는
process gate.

해당 없음 (CLI flag-only 변경, envelope 영향 없음 등) → 사유 한 줄 적고
표는 비워둘 것.
-->

해당 사유 (없으면 비워두고 표 채우기):

| 라이브 필드 | 값 | 매핑되는 단위 테스트 |
|-----------|----|-------------------|
| | | |

## Breaking changes

<!-- If this is a breaking change, describe what breaks and migration steps -->

None

## Manual testing done

<!-- What commands did you run to verify? -->

```bash
# e.g.
# perp --json market mid BTC
# node dist/mcp-server.js
```
