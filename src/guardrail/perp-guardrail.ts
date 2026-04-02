#!/usr/bin/env node
/**
 * perp-guardrail — OWS Policy Engine custom executable.
 *
 * Protocol:
 *   stdin  → PolicyContext JSON (from OWS engine)
 *   stdout → PolicyResult JSON  {"allow": bool, "reason"?: string}
 *
 * Validates:
 *   1. Contract address whitelist (per chain)
 *   2. Per-transaction USD amount limit
 *   3. Daily cumulative spending limit
 *
 * Configuration is read from PolicyContext.policy_config:
 *   { max_tx_usd, max_daily_usd, allowed_contracts?, allowed_chains? }
 */

import { ALLOWED_CONTRACTS, ALLOWED_CHAINS, DEFAULT_LIMITS } from "./contracts.js";

interface PolicyContext {
  chain_id: string;
  wallet_id: string;
  api_key_id: string;
  transaction: {
    to?: string;
    value?: string;
    data?: string;
    raw_hex?: string;
  };
  spending: {
    daily_total: string;
    date: string;
  };
  timestamp: string;
  policy_config?: {
    max_tx_usd?: number;
    max_daily_usd?: number;
    allowed_contracts?: Record<string, string[]>;
    allowed_chains?: string[];
    eth_price_usd?: number;  // fallback price if no oracle
  };
}

interface PolicyResult {
  allow: boolean;
  reason?: string;
}

function deny(reason: string): PolicyResult {
  return { allow: false, reason };
}

function allow(): PolicyResult {
  return { allow: true };
}

function weiToUsd(weiStr: string, ethPriceUsd: number): number {
  const wei = BigInt(weiStr || "0");
  const ethValue = Number(wei) / 1e18;
  return ethValue * ethPriceUsd;
}

function evaluate(ctx: PolicyContext): PolicyResult {
  const config = ctx.policy_config ?? {};
  const maxTxUsd = config.max_tx_usd ?? DEFAULT_LIMITS.max_tx_usd;
  const maxDailyUsd = config.max_daily_usd ?? DEFAULT_LIMITS.max_daily_usd;
  const contracts = config.allowed_contracts ?? ALLOWED_CONTRACTS;
  const chains = config.allowed_chains ?? ALLOWED_CHAINS;
  const ethPrice = config.eth_price_usd ?? 3500;  // conservative fallback

  // 1. Chain check
  if (!chains.includes(ctx.chain_id)) {
    return deny(`chain ${ctx.chain_id} not in allowed list`);
  }

  // 2. Contract whitelist (skip for signing-only chains like eip155:1337, eip155:304)
  const chainContracts = contracts[ctx.chain_id];
  if (chainContracts && chainContracts.length > 0 && ctx.transaction.to) {
    const target = ctx.transaction.to.toLowerCase();
    const allowed = chainContracts.map(a => a.toLowerCase());
    if (!allowed.includes(target)) {
      return deny(`contract ${ctx.transaction.to} not whitelisted for ${ctx.chain_id}`);
    }
  }

  // 3. Per-transaction amount (EVM value field — native token transfer)
  if (ctx.transaction.value && ctx.transaction.value !== "0") {
    const txUsd = weiToUsd(ctx.transaction.value, ethPrice);
    if (txUsd > maxTxUsd) {
      return deny(`tx value $${txUsd.toFixed(2)} exceeds limit $${maxTxUsd}`);
    }
  }

  // 4. Daily spending limit
  if (ctx.spending.daily_total && ctx.spending.daily_total !== "0") {
    const dailyUsd = weiToUsd(ctx.spending.daily_total, ethPrice);
    if (dailyUsd > maxDailyUsd) {
      return deny(`daily spending $${dailyUsd.toFixed(2)} exceeds limit $${maxDailyUsd}`);
    }
  }

  return allow();
}

// ── Main: read stdin, evaluate, write stdout ──
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
