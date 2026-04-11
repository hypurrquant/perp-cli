/**
 * Pure policy-evaluation logic for perp-guardrail.
 *
 * Split out from `perp-guardrail.ts` so it can be unit-tested without spawning
 * the CLI or touching stdin/stdout. The CLI shim at `perp-guardrail.ts` imports
 * `evaluate()` from here and wires stdin → PolicyContext → PolicyResult → stdout.
 */

import { ALLOWED_CONTRACTS, ALLOWED_CHAINS, DEFAULT_LIMITS } from "./contracts.js";

export interface PolicyContext {
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
    max_withdraw_usd?: number;
    max_daily_withdraw_usd?: number;
    allowed_symbols?: string[];
    block_selectors?: string[];     // 4-byte hex selectors to block (e.g. "0x095ea7b3" = approve)
    allowed_contracts?: Record<string, string[]>;
    allowed_chains?: string[];
    eth_price_usd?: number;
  };
}

export interface PolicyResult {
  allow: boolean;
  reason?: string;
}

export function deny(reason: string): PolicyResult {
  return { allow: false, reason };
}

export function allow(): PolicyResult {
  return { allow: true };
}

export function weiToUsd(weiStr: string, ethPriceUsd: number): number {
  const wei = BigInt(weiStr || "0");
  const ethValue = Number(wei) / 1e18;
  return ethValue * ethPriceUsd;
}

// Well-known EVM function selectors (for human-readable deny reasons)
export const KNOWN_SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve",
  "0x23b872dd": "transferFrom",
  "0xa9059cbb": "transfer",
  "0x3ccfd60b": "withdraw",
  "0x2e1a7d4d": "withdraw(uint256)",
  "0xd0e30db0": "deposit",
};

export function isWithdrawTx(data?: string): boolean {
  if (!data || data === "0x") return false;
  const selector = data.slice(0, 10).toLowerCase();
  return selector === "0x3ccfd60b" || selector === "0x2e1a7d4d";
}

/**
 * Evaluate a PolicyContext against the guardrail rules.
 * Returns allow/deny with a human-readable reason on deny.
 */
export function evaluate(ctx: PolicyContext): PolicyResult {
  const config = ctx.policy_config ?? {};
  const maxTxUsd = config.max_tx_usd ?? DEFAULT_LIMITS.max_tx_usd;
  const maxDailyUsd = config.max_daily_usd ?? DEFAULT_LIMITS.max_daily_usd;
  const maxWithdrawUsd = config.max_withdraw_usd ?? maxTxUsd;
  const maxDailyWithdrawUsd = config.max_daily_withdraw_usd ?? maxDailyUsd;
  const contracts = config.allowed_contracts ?? ALLOWED_CONTRACTS;
  const chains = config.allowed_chains ?? ALLOWED_CHAINS;
  const ethPrice = config.eth_price_usd ?? 3500;
  const blockSelectors = config.block_selectors ?? [];

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

  // 3. Blocked function selectors (e.g. approve, transferFrom)
  if (blockSelectors.length > 0 && ctx.transaction.data && ctx.transaction.data !== "0x") {
    const selector = ctx.transaction.data.slice(0, 10).toLowerCase();
    if (blockSelectors.map(s => s.toLowerCase()).includes(selector)) {
      const name = KNOWN_SELECTORS[selector] || selector;
      return deny(`function ${name} is blocked by policy`);
    }
  }

  // 4. Per-transaction amount
  if (ctx.transaction.value && ctx.transaction.value !== "0") {
    const txUsd = weiToUsd(ctx.transaction.value, ethPrice);
    if (txUsd > maxTxUsd) {
      return deny(`tx value $${txUsd.toFixed(2)} exceeds limit $${maxTxUsd}`);
    }
  }

  // 5. Withdrawal-specific limits
  if (isWithdrawTx(ctx.transaction.data)) {
    if (ctx.transaction.value && ctx.transaction.value !== "0") {
      const withdrawUsd = weiToUsd(ctx.transaction.value, ethPrice);
      if (withdrawUsd > maxWithdrawUsd) {
        return deny(`withdrawal $${withdrawUsd.toFixed(2)} exceeds per-tx limit $${maxWithdrawUsd}`);
      }
    }
    // Daily withdrawal check uses same daily_total (OWS tracks cumulative)
    if (ctx.spending.daily_total && ctx.spending.daily_total !== "0") {
      const dailyUsd = weiToUsd(ctx.spending.daily_total, ethPrice);
      if (dailyUsd > maxDailyWithdrawUsd) {
        return deny(`daily withdrawals $${dailyUsd.toFixed(2)} exceeds limit $${maxDailyWithdrawUsd}`);
      }
    }
  }

  // 6. Daily spending limit (all operations)
  if (ctx.spending.daily_total && ctx.spending.daily_total !== "0") {
    const dailyUsd = weiToUsd(ctx.spending.daily_total, ethPrice);
    if (dailyUsd > maxDailyUsd) {
      return deny(`daily spending $${dailyUsd.toFixed(2)} exceeds limit $${maxDailyUsd}`);
    }
  }

  return allow();
}
