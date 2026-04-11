#!/usr/bin/env node
/**
 * perp-guardrail — OWS Policy Engine custom executable.
 *
 * Protocol:
 *   stdin  → PolicyContext JSON (from OWS engine)
 *   stdout → PolicyResult JSON  {"allow": bool, "reason"?: string}
 *
 * All decision logic lives in `./policy.ts` (unit-testable). This file is a
 * thin CLI shim that reads stdin, calls `evaluate()`, and writes stdout.
 *
 * Validates:
 *   1. Contract address whitelist (per chain)
 *   2. Per-transaction USD amount limit
 *   3. Daily cumulative spending limit
 *   4. Withdrawal limits (per-tx and daily)
 *   5. Blocked function selectors (e.g. approve)
 *   6. Allowed trading symbols
 */

import { evaluate, deny, type PolicyContext } from "./policy.js";

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = Buffer.concat(chunks).toString("utf-8").trim();

  if (!input) {
    process.stdout.write(JSON.stringify(deny("empty stdin")));
    process.exit(0);
  }

  let ctx: PolicyContext;
  try {
    ctx = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify(deny("invalid JSON on stdin")));
    process.exit(0);
  }

  const result = evaluate(ctx);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify(deny(`internal error: ${e instanceof Error ? e.message : String(e)}`)));
  process.exit(0);
});
