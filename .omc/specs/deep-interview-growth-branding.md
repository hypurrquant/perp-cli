# Deep Interview Spec: Growth — CLI Branding & Distribution

## Metadata
- Interview ID: perpcli-growth-003
- Rounds: 8 + 1 correction
- Final Ambiguity Score: 15.0%
- Type: brownfield
- Generated: 2026-03-18
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 35% | 0.322 |
| Constraint Clarity | 0.82 | 25% | 0.205 |
| Success Criteria | 0.82 | 25% | 0.205 |
| Context Clarity | 0.78 | 15% | 0.117 |
| **Total Clarity** | | | **0.849** |
| **Ambiguity** | | | **15.1%** |

## Goal
perp-cli의 첫인상을 압도적으로 만들어 사용자/에이전트 성장을 유도한다:
1. **CLI 브랜딩** — `perp` 실행 시 ASCII 로고 + 거래소 상태 + 포트폴리오 요약 대시보드
2. **README 배지** — npm, build, license 배지 추가 (GIF 제외)
3. **Skill npm 배포** — `skills/perp-cli/` 를 별도 npm 패키지로 배포
4. **MCP 디렉토리 등록 준비** — Anthropic MCP 디렉토리 등록을 위한 메타데이터 정비

## Constraints
- chalk만 사용 (TUI 프레임워크 불필요 — ink/blessed 등 추가 의존성 X)
- 기존 CLI 패턴 유지 — `--json` 모드에서는 브랜딩 출력하지 않음
- GIF 제외 — README에 데모 GIF 불필요
- 기존 `perp` 인수 없이 실행 시 동작을 브랜딩 대시보드로 변경

## Non-Goals
- TUI 프레임워크 (ink, blessed, terminal-kit)
- 데모 GIF / 스크린샷 제작
- REST API 서버
- 새로운 기능 추가

## Acceptance Criteria
- [ ] `perp` (인수 없음) 실행 시 ASCII 로고 + 버전 + 거래소 연결 상태 표시
- [ ] `perp` 실행 시 연결된 거래소의 밸런스/포지션 요약 표시
- [ ] `perp` 실행 시 아래에 주요 커맨드 그룹 help 표시
- [ ] `perp --json` 은 기존 동작 유지 (브랜딩 없음)
- [ ] README.md 상단에 npm/build/license 배지 추가
- [ ] Skill을 별도 npm 패키지로 배포 가능한 구조 (package.json, README)
- [ ] 테스트: 기존 977 테스트 통과 유지

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 4개 채널 동시에 해야 | Contrarian: 하나만 고르면? | 첫인상 최적화가 가장 중요 |
| TUI 프레임워크 필요 | Simplifier: chalk으로 충분? | chalk + 기존 CLI 패턴으로 충분 |
| 데모 GIF 필요 | 유저 수정 | GIF 불필요, 배지만 추가 |
| Skill은 perp-cli에 포함 | 유저 추가 | 별도 npm 배포 |

## Technical Context
### 기존 코드
- `src/index.ts` — CLI 진입점, commander 기반
- `src/commands/account.ts` — 포트폴리오/밸런스 로직 (재사용 대상)
- `skills/perp-cli/SKILL.md` — AI agent skill 가이드
- `package.json` — npm 배포 설정

### 변경 계획
```
src/index.ts
  └── perp (인수 없음) → 기존 help 대신 브랜딩 대시보드 출력
      ├── ASCII 로고 + 버전
      ├── 거래소 연결 상태 (ping)
      ├── 밸런스/포지션 요약 (연결된 거래소만)
      └── 주요 커맨드 help

README.md
  └── 상단에 배지 추가 (npm version, build, license)

skills/perp-cli/
  └── 별도 package.json 추가 → npm 배포 준비
```

## Interview Transcript
<details>
<summary>Full Q&A (8 rounds + 1 correction)</summary>

### Round 1
**Q:** 성장을 어떻게 측정?
**A:** 유저가 사용하고 에이전트가 사용하는 것

### Round 2
**Q:** 유입 경로는?
**A:** 아직 유입 경로가 없음

### Round 3
**Q:** 코드 vs 컨텐츠?
**A:** 컨텐츠/마케팅도 할 수 있음

### Round 4
**Q:** 어떤 채널?
**A:** MCP 디렉토리, npm SEO, 커뮤니티 포스팅, 데모 컨텐츠 (전부)

### Round 5 [Contrarian]
**Q:** 하나만 골라야 한다면?
**A:** README + 멋진 터미널

### Round 6
**Q:** 멋진 터미널이란?
**A:** 브랜딩 + 상태 대시보드

### Round 7 [Simplifier]
**Q:** TUI 프레임워크 필요?
**A:** chalk + 기존 CLI면 충분

### Round 8
**Q:** README 개선 방향?
**A:** 데모 GIF + 배지

### Correction
**A:** GIF 안 넣어도 됨 + Skill도 npm에 배포

</details>
