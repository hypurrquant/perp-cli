#!/bin/bash
# Funding rate analysis across all exchanges
# Usage: ./funding-analysis.sh [--json] [--symbol ETH] [--top 10]
# Fetches current + historical funding data for comparison

set -euo pipefail

JSON_MODE=false
SYMBOL=""
TOP=10
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=true; shift ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --top) TOP="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -n "$SYMBOL" ]]; then
  # Single symbol detailed analysis
  FUNDING=$(perp --json market funding "$SYMBOL" 2>/dev/null || echo '{"ok":false}')
  SCAN=$(perp --json arb scan --min 0 2>/dev/null || echo '{"ok":false}')
  SPOT_SCAN=$(perp --json arb scan --mode spot-perp --min 0 2>/dev/null || echo '{"ok":false}')

  if $JSON_MODE; then
    cat <<EOF
{
  "ok": true,
  "symbol": "$SYMBOL",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "funding": $FUNDING,
  "perpPerpArb": $SCAN,
  "spotPerpArb": $SPOT_SCAN
}
EOF
  else
    echo "=== Funding Analysis: $SYMBOL ==="
    echo ""
    echo "--- Current Funding Rates ---"
    echo "$FUNDING" | jq -r '.data // empty' 2>/dev/null || echo "(unavailable)"
    echo ""
    echo "--- Perp-Perp Arb ---"
    echo "$SCAN" | jq -r '
      .data.opportunities // [] | map(select(.symbol == "'"$SYMBOL"'")) | .[] |
      "  \(.longExch // .longExchange)→\(.shortExch // .shortExchange): \(.netSpread // .spread)bps"
    ' 2>/dev/null || echo "  (no opportunity)"
    echo ""
    echo "--- Spot+Perp Arb ---"
    echo "$SPOT_SCAN" | jq -r '
      .data.opportunities // [] | map(select(.symbol == "'"$SYMBOL"'")) | .[] |
      "  \(.direction): \(.annualSpreadPct // .spread)% annual"
    ' 2>/dev/null || echo "  (no opportunity)"
  fi
else
  # All symbols scan
  SCAN=$(perp --json arb scan --mode all --min 0 2>/dev/null || echo '{"ok":false}')
  FUNDING_DETAIL=$(perp --json arb funding 2>/dev/null || echo '{"ok":false}')

  if $JSON_MODE; then
    cat <<EOF
{
  "ok": true,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "topN": $TOP,
  "allOpportunities": $SCAN,
  "fundingDetail": $FUNDING_DETAIL
}
EOF
  else
    echo "=== Funding Rate Overview (top $TOP) ==="
    echo ""
    echo "$SCAN" | jq -r "
      .data.opportunities // [] | .[0:$TOP] | .[] |
      \"  \(.symbol) | \(.mode // \"perp\") | \(.netSpread // .spread)bps | \(.longExch // .longExchange)→\(.shortExch // .shortExchange)\"
    " 2>/dev/null || echo "(no data)"
  fi
fi
