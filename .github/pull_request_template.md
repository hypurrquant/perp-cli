## What does this PR do?

<!-- Briefly describe your changes -->

Related issue: <!-- #issue-number (optional) -->

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm run build` compiles without errors
- [ ] No secrets, API keys, or private keys included
- [ ] Breaking change? If yes, described below

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
