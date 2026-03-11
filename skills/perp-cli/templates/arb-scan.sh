#!/bin/bash
# Scan funding rate arbitrage opportunities
# Usage: ./arb-scan.sh [min-spread-bps]
# Example: ./arb-scan.sh 20

set -e

MIN_SPREAD="${1:-10}"

echo "=== Funding Rate Arbitrage Scanner ==="
echo "Minimum spread: ${MIN_SPREAD} bps"
echo ""

echo "1. Opportunities (>= ${MIN_SPREAD} bps):"
perp --json arb scan --min "$MIN_SPREAD"
