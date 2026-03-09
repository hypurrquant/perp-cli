# perp-cli JSON Response Specification

Agent-friendly structured output standard for `perp` CLI.
All responses when `--json` flag is set follow this spec.

## Envelope

Every response is a single JSON object on stdout.

```typescript
interface ApiResponse<T> {
  ok: boolean;
  data?: T;                    // present when ok=true
  error?: {                    // present when ok=false
    code: string;              // machine-readable error code
    message: string;           // human-readable description
    status?: number;           // HTTP-like status (400, 404, 429, 500...)
    retryable?: boolean;       // true = safe to retry
    retryAfterMs?: number;     // suggested wait before retry
    details?: Record<string, unknown>;
  };
  meta?: {
    timestamp: string;         // ISO 8601 (always present)
    exchange?: string;         // "pacifica" | "hyperliquid" | "lighter"
    duration_ms?: number;      // execution time
  };
}
```

### Rules

1. **stdout = JSON only**. No chalk, no logs, no warnings.
2. **One JSON object per invocation**. Never multiple JSON lines (except daemon `printJson` per cycle).
3. **`ok: true`** = success. Parse `data`.
4. **`ok: false`** = error. Parse `error.code` for branching.
5. **All numbers as strings** in market/account data (avoids float precision loss).
6. **Timestamps**: `meta.timestamp` = ISO 8601. Data-level timestamps = unix ms (`number`).

---

## Error Codes

| Code | Status | Retryable | Description |
|------|--------|-----------|-------------|
| `INVALID_PARAMS` | 400 | no | Bad arguments, missing required fields |
| `SYMBOL_NOT_FOUND` | 404 | no | Market/symbol doesn't exist |
| `ORDER_NOT_FOUND` | 404 | no | Order ID doesn't exist |
| `POSITION_NOT_FOUND` | 404 | no | No open position for symbol |
| `INSUFFICIENT_BALANCE` | 400 | no | Not enough balance/equity |
| `MARGIN_INSUFFICIENT` | 400 | no | Not enough margin for operation |
| `SIZE_TOO_SMALL` | 400 | no | Below minimum order size |
| `SIZE_TOO_LARGE` | 400 | no | Exceeds maximum order size |
| `RISK_VIOLATION` | 403 | no | Risk limit exceeded |
| `DUPLICATE_ORDER` | 409 | no | Order already submitted (idempotency) |
| `EXCHANGE_UNREACHABLE` | 503 | yes | Network/connection failure |
| `RATE_LIMITED` | 429 | yes | Too many requests (check `retryAfterMs`) |
| `PRICE_STALE` | 503 | yes | Price data outdated |
| `SIGNATURE_FAILED` | 500 | no | Signing/authentication error |
| `EXCHANGE_ERROR` | 502 | yes | Exchange returned unexpected error |
| `TIMEOUT` | 504 | yes | Request timed out |
| `CLI_ERROR` | 400 | no | Commander parse error (unknown command, etc.) |
| `FATAL` | 500 | no | Unrecoverable internal error |
| `UNKNOWN` | 500 | no | Unclassified error |

### Agent Retry Logic

```python
if not response["ok"]:
    err = response["error"]
    if err.get("retryable"):
        wait = err.get("retryAfterMs", 1000) / 1000
        time.sleep(wait)
        # retry same command
    else:
        # handle error by code
        raise PerpError(err["code"], err["message"])
```

---

## Data Types

### Market

```typescript
// perp --json market list
interface MarketInfo {
  symbol: string;          // "BTC", "ETH-PERP", "km:GOOGL"
  markPrice: string;       // "42150.50"
  indexPrice: string;      // "42148.20"
  fundingRate: string;     // "0.0001" (hourly, raw decimal)
  volume24h: string;       // "1234567890.50"
  openInterest: string;    // "987654321.00"
  maxLeverage: number;     // 50
}

// perp --json market mid BTC
interface MidPrice {
  symbol: string;          // "BTC"
  mid: string;             // "42149.35"
  bid: string | null;      // "42148.20"
  ask: string | null;      // "42150.50"
  spread: string;          // "0.005456" (percentage)
}

// perp --json market info BTC
// data: MarketInfo (single object)

// perp --json market book BTC
interface Orderbook {
  bids: [string, string][];  // [[price, size], ...]
  asks: [string, string][];  // [[price, size], ...]
}

// perp --json market trades BTC
interface Trade {
  time: number;            // unix ms
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  fee: string;
}

// perp --json market funding BTC
interface FundingRecord {
  time: number;            // unix ms
  rate: string;            // hourly rate
  price: string;           // oracle price
}

// perp --json market kline BTC 1h
interface Kline {
  time: number;            // unix ms
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}
```

### Account

```typescript
// perp --json account info
// perp --json account balance
interface Balance {
  equity: string;          // total account value
  available: string;       // withdrawable / free margin
  marginUsed: string;      // margin in use
  unrealizedPnl: string;  // open position PnL
}

// perp --json account positions
interface Position {
  symbol: string;
  side: "long" | "short";
  size: string;            // absolute size
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string; // "N/A" if not applicable
  unrealizedPnl: string;
  leverage: number;
}

// perp --json account orders
interface Order {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  filled: string;
  status: string;          // "open", "filled", "cancelled", ...
  type: string;            // "limit", "market", "trigger", ...
}

// perp --json account margin BTC
interface MarginDetail {
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice: string;
  leverage: number;
  notional: string;          // position notional value
  marginRequired: string;    // margin allocated to this position
  marginPctOfEquity: string; // % of account equity used
  liquidationPrice: string;
  unrealizedPnl: string;
  accountEquity: string;
  accountAvailable: string;
}

// perp --json account trades
// data: Trade[] (same as market trades)

// perp --json account funding-history
interface FundingPayment {
  time: number;
  symbol: string;
  payment: string;         // positive = received, negative = paid
}

// perp --json account pnl
interface PnlReport {
  period: string;          // "all", "today", "7d", "30d"
  realizedPnl: number;
  unrealizedPnl: number;
  funding: number;
  fees: number;
  netPnl: number;
  equity: number;
  trades: number;
  positions: number;
  fundingPayments: number;
}
```

### Trading

```typescript
// perp --json trade market BTC buy 0.1
// perp --json trade buy BTC 0.1
// data: exchange-native order response (varies by exchange)
// may include: { clientOrderId: string, ...response }

// Duplicate detection (idempotent)
// data: { duplicate: true, clientOrderId: string, message: string }

// perp --json trade cancel BTC <orderId>
// data: exchange-native cancel response

// perp --json trade close BTC
// data: { closed: boolean, reason?: string } | exchange response

// perp --json trade close-all
// data: { closed: number, results: unknown[] }

// perp --json trade flatten
// data: { ordersCancelled: unknown, positionsClosed: number, closeResults: unknown[] }

// perp --json trade reduce BTC 50
// data: { reduced: boolean, percent: number, sizeReduced: string, originalSize: string, result: unknown }

// perp --json trade check BTC buy 0.1
// data: { valid: boolean, checks: { name: string, passed: boolean, value?: string }[] }

// perp --json trade status <orderId>
// data: Order (generic) or exchange-native order object (HL)
// error: ORDER_NOT_FOUND if not found

// perp --json trade fills [symbol]
// data: Trade[] (filtered by symbol if provided)
```

### Status

```typescript
// perp --json status
interface StatusResponse {
  exchange: string;
  balance: Balance;
  positions: Position[];
  orders: Order[];
}
```

### Arbitrage

```typescript
// perp --json arb scan
interface ArbOpportunity {
  symbol: string;
  spread: number;          // annualized %
  longExch: string;        // exchange to go long
  shortExch: string;       // exchange to go short
  pacRate: number;         // pacifica funding rate
  hlRate: number;          // hyperliquid funding rate
  ltRate: number;          // lighter funding rate
  markPrice: number;
}

// perp --json arb dex-auto --dry-run (daemon cycle output)
interface DexAutoStatus {
  timestamp: string;
  openPositions: DexArbPosition[];
  availablePairs: number;
}

interface DexArbPosition {
  underlying: string;      // "GOOGL"
  longDex: string;         // "km"
  longSymbol: string;      // "km:GOOGL"
  shortDex: string;        // "cash"
  shortSymbol: string;     // "cash:GOOGL"
  size: string;
  entrySpread: number;     // annualized %
  entryTime: string;       // ISO 8601
  longPrice: number;
  shortPrice: number;
}
```

### Health

```typescript
// perp --json health
interface HealthResponse {
  healthy: boolean;
  exchanges: {
    exchange: string;
    status: "ok" | "degraded" | "down";
    latency_ms: number;
    error?: string;
  }[];
}
```

### Portfolio

```typescript
// perp --json portfolio
interface PortfolioSummary {
  totalEquity: number;
  totalAvailable: number;
  totalMarginUsed: number;
  totalUnrealizedPnl: number;
  exchanges: {
    name: string;
    equity: number;
    available: number;
    marginUsed: number;
    unrealizedPnl: number;
    positionCount: number;
  }[];
  positions: Position[];
  riskMetrics: {
    totalExposure: number;
    portfolioLeverage: number;
    largestPosition: { symbol: string; notional: number; pctOfEquity: number } | null;
    marginUtilization: number;
  };
}
```

### Risk

```typescript
// perp --json risk status
interface RiskAssessment {
  level: "low" | "medium" | "high" | "critical";
  canTrade: boolean;
  metrics: {
    marginUtilization: number;
    portfolioLeverage: number;
    largestPositionPct: number;
    unrealizedPnlPct: number;
    openOrderExposure: number;
  };
  violations: string[];
}
```

---

## Usage Examples

### Python Agent

```python
import subprocess, json

def perp(args: list[str]) -> dict:
    result = subprocess.run(
        ["perp", "--json"] + args,
        capture_output=True, text=True, timeout=30
    )
    response = json.loads(result.stdout)
    if not response["ok"]:
        err = response["error"]
        if err.get("retryable"):
            time.sleep(err.get("retryAfterMs", 1000) / 1000)
            return perp(args)  # retry once
        raise Exception(f"[{err['code']}] {err['message']}")
    return response["data"]

# Get balance
balance = perp(["account", "info"])
print(f"Equity: ${balance['equity']}")

# Place order
result = perp(["trade", "buy", "BTC", "0.001"])

# Check positions
positions = perp(["account", "positions"])
for p in positions:
    print(f"{p['symbol']} {p['side']} {p['size']} PnL: {p['unrealizedPnl']}")
```

### TypeScript/Node Agent

```typescript
import { execSync } from "child_process";

function perp<T>(args: string[]): T {
  const out = execSync(`perp --json ${args.join(" ")}`, { encoding: "utf8" });
  const res = JSON.parse(out);
  if (!res.ok) throw new Error(`[${res.error.code}] ${res.error.message}`);
  return res.data as T;
}

const balance = perp<Balance>(["account", "info"]);
const markets = perp<MarketInfo[]>(["market", "list"]);
```

### Shell / jq

```bash
# Get equity
perp --json account info | jq -r '.data.equity'

# List profitable positions
perp --json account positions | jq '.data[] | select(.unrealizedPnl | tonumber > 0)'

# Check if healthy
perp --json health | jq '.data.healthy'

# Error handling
result=$(perp --json trade buy BTC 0.001 2>/dev/null)
if echo "$result" | jq -e '.ok' > /dev/null; then
  echo "Order placed"
else
  code=$(echo "$result" | jq -r '.error.code')
  echo "Failed: $code"
fi
```

---

## Implementation

Source files:
- `src/utils.ts` — `jsonOk()`, `jsonError()`, `printJson()`, `withJsonErrors()`
- `src/errors.ts` — `ERROR_CODES`, `classifyError()`, `PerpError`
- `src/exchanges/interface.ts` — Canonical data type definitions
