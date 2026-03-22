#!/bin/bash
# PostToolUse:Bash hook — detect errors and commits for lesson learned tracking

INPUT=$(cat)
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // ""' 2>/dev/null)
TOOL_STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // ""' 2>/dev/null)
COMBINED="$TOOL_OUTPUT $TOOL_STDERR"

# --- Error detection ---
if echo "$COMBINED" | grep -qiE "sendTx failed|invalid signature|not enough.*balance|ELIFECYCLE|error TS|precision loss|MAX_SAFE_INTEGER|min_quote_amount|min_base_amount"; then
  ERROR_TYPE=$(echo "$COMBINED" | grep -oiE "sendTx failed[^\"]*|invalid signature|not enough.*balance|error TS[0-9]+|min_quote_amount|min_base_amount" | head -1)
  echo "⚠️ Error detected: \"$ERROR_TYPE\". If this reveals a new exchange constraint, update memory/exchange_specs.md or memory/funding_lessons.md after fixing."
  exit 0
fi

# --- Commit detection ---
if echo "$COMBINED" | grep -qE "\] (feat|fix|refactor|chore):"; then
  COMMIT_MSG=$(echo "$COMBINED" | grep -oE "\[.*\] (feat|fix|refactor|chore):.*" | head -1 | cut -c1-80)
  echo "📝 Commit: $COMMIT_MSG — If this involved a new lesson, update the relevant memory file."
  exit 0
fi

exit 0
