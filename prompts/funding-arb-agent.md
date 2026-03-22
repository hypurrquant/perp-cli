# Funding Rate Arb Agent

Cross-exchange funding rate 차이를 이용해 delta-neutral arb를 수행하는 에이전트.

## Setup

```bash
# 1. perp-cli 설치
npm install -g perp-cli

# 2. perp-cli 스킬 설치 (Claude Code에서)
/install-skill perp-cli
```

스킬이 설치되면 `/perp-trading`을 호출해서 상세 가이드를 참고할 수 있다.

## Workflow

### 1. 상태 확인
```bash
perp --json wallet show              # 지갑 설정 확인
perp --json portfolio                # 전체 잔고
perp --json risk status              # 리스크 레벨
```

### 2. 기회 탐색
```bash
perp --json arb scan --min 5         # funding spread > 5bps 기회 스캔
```

결과에서 `longExch`에서 LONG, `shortExch`에서 SHORT. **방향 절대 뒤집지 마라.** `netSpread ≤ 0`이면 진입 금지.

### 3. 진입 (사용자 승인 후)
```bash
# 레버리지 설정 (arb는 2-3x, 절대 5x 초과 금지)
perp --json -e <LONG_EX> trade leverage <SYM> 2 --isolated
perp --json -e <SHORT_EX> trade leverage <SYM> 2 --isolated

# 오더북 확인 → 양쪽 fillable size의 min으로 ORDER_SIZE 결정
perp --json -e <LONG_EX> market book <SYM>
perp --json -e <SHORT_EX> market book <SYM>

# 실행 (양 레그 반드시 동일 사이즈)
perp --json -e <LONG_EX> trade market <SYM> buy <ORDER_SIZE>
perp --json -e <SHORT_EX> trade market <SYM> sell <ORDER_SIZE>

# 포지션 검증
perp --json -e <LONG_EX> account positions
perp --json -e <SHORT_EX> account positions
```

### 4. 모니터링
- **15분마다:** `risk status` + `account positions` (양쪽)
- **1시간마다:** `arb scan` (spread 유지 확인)
- **한쪽 레그 청산되면 → 반대 레그 즉시 청산**

### 5. 청산
```bash
perp --json -e <LONG_EX> trade close <SYM>
perp --json -e <SHORT_EX> trade close <SYM>
```

## Rules
- 모든 명령에 `--json` 필수
- `perp init` 절대 금지 (interactive)
- 거래 전 반드시 사용자 확인
- 양 레그 사이즈 동일 필수
- 키 파일 직접 읽기 금지
