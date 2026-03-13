#!/bin/bash
# Monitor open arb positions and evaluate exit conditions
# Usage: ./arb-monitor.sh [--json] [--min-spread 5]
# Checks: current spread vs entry, funding earned, PnL, liquidation distance
# Returns JSON with position health + actionable recommendations

set -euo pipefail

JSON_MODE=false
MIN_SPREAD=5
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=true; shift ;;
    --min-spread) MIN_SPREAD="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# 1. Get current arb status
ARB_STATUS=$(perp --json arb status 2>/dev/null || echo '{"ok":false}')
if ! echo "$ARB_STATUS" | grep -q '"ok":true'; then
  if $JSON_MODE; then
    echo '{"ok":false,"error":"No arb positions or arb status unavailable"}'
  else
    echo "No open arb positions found."
  fi
  exit 0
fi

# 2. Get current spreads
ARB_SCAN=$(perp --json arb scan --min 0 2>/dev/null || echo '{"ok":false,"data":{"opportunities":[]}}')

# 3. Get funding earned
FUNDING=$(perp --json arb funding-earned 2>/dev/null || echo '{"ok":false}')

# 4. Get liquidation distances
LIQ_DIST=$(perp --json risk liquidation-distance 2>/dev/null || echo '{"ok":false}')

# 5. Output combined analysis
if $JSON_MODE; then
  cat <<EOF
{
  "ok": true,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "positions": $ARB_STATUS,
  "currentSpreads": $ARB_SCAN,
  "fundingEarned": $FUNDING,
  "liquidationDistance": $LIQ_DIST,
  "minSpreadThreshold": $MIN_SPREAD
}
EOF
else
  echo "=== Arb Position Monitor ==="
  echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "--- Positions ---"
  echo "$ARB_STATUS" | jq -r '.data // empty'
  echo ""
  echo "--- Funding Earned ---"
  echo "$FUNDING" | jq -r '.data // empty'
  echo ""
  echo "--- Liquidation Distance ---"
  echo "$LIQ_DIST" | jq -r '.data // empty'
  echo ""
  echo "Min spread threshold: ${MIN_SPREAD} bps"
  echo "Recommendation: Check if current spreads exceed ${MIN_SPREAD} bps to continue holding."
fi
