# Deep Interview Spec: Yield Agent Landing Page

## Metadata
- Interview ID: perpcli-yield-agent-004
- Rounds: 5
- Final Ambiguity Score: 18.0%
- Type: greenfield (new project, perp-cli as backend)
- Generated: 2026-03-18
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 40% | 0.360 |
| Constraint Clarity | 0.80 | 30% | 0.240 |
| Success Criteria | 0.75 | 30% | 0.225 |
| **Total Clarity** | | | **0.825** |
| **Ambiguity** | | | **17.5%** |

## Goal
perp-cli를 백엔드로 사용하는 **DeFi Yield Agent SaaS**의 랜딩페이지를 만들어 수요를 검증한다.
- 핵심 메시지: "DeFi yield, 자동 운용"
- 멀티 전략 포트폴리오 (펀딩아비, 델타뉴트럴, 스팟+퍼프 헤지)
- 3개 거래소 (Pacifica, Hyperliquid, Lighter) 자동 운용
- waitlist로 대기자 모집 → 수요 검증 후 본격 개발

## Constraints
- 랜딩페이지만 (실제 에이전트 개발은 아직)
- waitlist 수집 기능 필요 (이메일 또는 Telegram)
- perp-cli 레포 안에 만들 수도 있고 별도 레포도 가능
- 정적 사이트 (Vercel/Netlify 배포)

## Non-Goals
- 실제 yield 에이전트 개발
- 결제/구독 시스템
- 사용자 인증
- 대시보드 UI

## Acceptance Criteria
- [ ] 랜딩페이지: 히어로 섹션 + value prop + 전략 소개 + waitlist 폼
- [ ] "DeFi yield, 자동 운용" 메시지 명확히 전달
- [ ] 3개 거래소 + 멀티 전략(펀딩아비, 델타뉴트럴) 소개
- [ ] waitlist 이메일 수집 (또는 Telegram 링크)
- [ ] 모바일 반응형
- [ ] Vercel/Netlify 배포 가능한 정적 사이트

## Technical Context
### 관계
```
perp-cli (기존, 인프라)
  ├── CLI tool (거래, 분석, 아비)
  ├── MCP server (AI 연동)
  └── npm package

Yield Agent SaaS (새 프로젝트)
  ├── Phase 1: 랜딩페이지 + waitlist ← 지금 이거
  ├── Phase 2: 대시보드 + 전략 모니터링
  ├── Phase 3: 자동 실행 에이전트
  └── Backend: perp-cli / perp-mcp
```

### 기술 스택 (랜딩페이지)
- Next.js 또는 Astro (정적 사이트)
- Tailwind CSS
- waitlist: Resend, Loops, 또는 simple form → Google Sheets

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds)</summary>

### Round 1
**Q:** 에이전트 프로젝트 형태?
**A:** perp-cli는 yield 도구, 래핑해서 에이전트화 + 마케팅 동시에

### Round 2
**Q:** yield 에이전트의 핵심 전략?
**A:** 멀티 전략 포트폴리오

### Round 3
**Q:** 배포 형태?
**A:** SaaS 웹앱

### Round 4
**Q:** MVP 범위?
**A:** 랜딩페이지 + 대기자 모집 (수요 검증 먼저)

### Round 5
**Q:** 핵심 메시지?
**A:** "DeFi yield, 자동 운용"

</details>
