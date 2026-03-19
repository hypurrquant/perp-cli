import type { ExchangeAdapter } from "./exchanges/index.js";
import { symbolMatch } from "./utils.js";
import { logExecution } from "./execution-log.js";
import { randomUUID } from "crypto";

export type PlanAction =
  | "market_order" | "limit_order" | "stop_order"
  | "cancel_order" | "cancel_all"
  | "set_leverage" | "close_position"
  | "wait" | "check_balance" | "check_position";

export interface PlanStep {
  id: string;
  action: PlanAction;
  params: Record<string, unknown>;
  onFailure?: "abort" | "skip" | "rollback";
  dependsOn?: string;
  clientId?: string;
}

export interface ExecutionPlan {
  version: "1.0";
  exchange?: string;
  description?: string;
  steps: PlanStep[];
}

export interface StepResult {
  stepId: string;
  action: PlanAction;
  status: "success" | "failed" | "skipped" | "rolled_back" | "dry_run";
  result?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
}

export interface PlanResult {
  planId: string;
  status: "completed" | "partial" | "failed" | "dry_run";
  steps: StepResult[];
  totalDurationMs: number;
  timestamp: string;
}

/**
 * Validate a plan structure without executing it.
 */
export function validatePlan(plan: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!plan || typeof plan !== "object") { errors.push("Plan must be an object"); return { valid: false, errors }; }
  const p = plan as Record<string, unknown>;

  if (p.version !== "1.0") errors.push(`Unsupported version: ${p.version} (expected "1.0")`);
  if (!Array.isArray(p.steps)) { errors.push("steps must be an array"); return { valid: false, errors }; }
  if (p.steps.length === 0) errors.push("Plan has no steps");

  const validActions = new Set<string>(["market_order", "limit_order", "stop_order", "cancel_order", "cancel_all", "set_leverage", "close_position", "wait", "check_balance", "check_position"]);
  const ids = new Set<string>();

  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i] as Record<string, unknown>;
    if (!step.id) errors.push(`Step ${i}: missing id`);
    if (ids.has(String(step.id))) errors.push(`Step ${i}: duplicate id "${step.id}"`);
    ids.add(String(step.id));
    if (!step.action || !validActions.has(String(step.action))) errors.push(`Step ${i}: invalid action "${step.action}"`);
    if (step.onFailure && !["abort", "skip", "rollback"].includes(String(step.onFailure))) {
      errors.push(`Step ${i}: invalid onFailure "${step.onFailure}"`);
    }
    if (step.dependsOn && !ids.has(String(step.dependsOn))) {
      // dependsOn might reference a later step or non-existent
      // Check if any step has that id
      const found = (p.steps as Array<Record<string, unknown>>).some(s => s.id === step.dependsOn);
      if (!found) errors.push(`Step ${i}: dependsOn "${step.dependsOn}" not found`);
    }
    // Validate params per action
    const params = (step.params || {}) as Record<string, unknown>;
    const action = String(step.action);
    if (["market_order", "limit_order", "stop_order"].includes(action)) {
      if (!params.symbol) errors.push(`Step ${i} (${action}): missing params.symbol`);
      if (!params.side) errors.push(`Step ${i} (${action}): missing params.side`);
      if (!params.size) errors.push(`Step ${i} (${action}): missing params.size`);
    }
    if (action === "limit_order" && !params.price) errors.push(`Step ${i} (limit_order): missing params.price`);
    if (action === "stop_order" && !params.triggerPrice) errors.push(`Step ${i} (stop_order): missing params.triggerPrice`);
    if (action === "cancel_order" && (!params.symbol || !params.orderId)) errors.push(`Step ${i} (cancel_order): missing params.symbol or params.orderId`);
    if (action === "set_leverage" && (!params.symbol || !params.leverage)) errors.push(`Step ${i} (set_leverage): missing params.symbol or params.leverage`);
    if (action === "wait" && !params.ms) errors.push(`Step ${i} (wait): missing params.ms`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Execute a plan step by step.
 */
export async function executePlan(
  adapter: ExchangeAdapter,
  plan: ExecutionPlan,
  opts?: { dryRun?: boolean; log?: (msg: string) => void },
): Promise<PlanResult> {
  const planId = randomUUID().slice(0, 8);
  const startTime = Date.now();
  const results: StepResult[] = [];
  const completedSteps = new Map<string, StepResult>();
  const dryRun = opts?.dryRun ?? false;
  const log = opts?.log ?? (() => {});

  log(`[plan:${planId}] Starting ${plan.steps.length} steps (${dryRun ? "DRY RUN" : "LIVE"})`);

  for (const step of plan.steps) {
    const stepStart = Date.now();

    // Check dependency
    if (step.dependsOn) {
      const dep = completedSteps.get(step.dependsOn);
      if (!dep || dep.status === "failed") {
        const result: StepResult = {
          stepId: step.id,
          action: step.action,
          status: "skipped",
          error: { code: "DEPENDENCY_FAILED", message: `Depends on ${step.dependsOn} which failed/missing` },
          durationMs: 0,
        };
        results.push(result);
        completedSteps.set(step.id, result);
        continue;
      }
    }

    if (dryRun) {
      const result: StepResult = {
        stepId: step.id,
        action: step.action,
        status: "dry_run",
        result: { params: step.params, wouldExecute: true },
        durationMs: Date.now() - stepStart,
      };
      results.push(result);
      completedSteps.set(step.id, result);
      log(`[plan:${planId}] Step ${step.id} (${step.action}): dry run OK`);
      continue;
    }

    try {
      const result = await executeStep(adapter, step, log);
      const stepResult: StepResult = {
        stepId: step.id,
        action: step.action,
        status: "success",
        result,
        durationMs: Date.now() - stepStart,
      };
      results.push(stepResult);
      completedSteps.set(step.id, stepResult);
      log(`[plan:${planId}] Step ${step.id} (${step.action}): success (${stepResult.durationMs}ms)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const onFailure = step.onFailure ?? "abort";

      log(`[plan:${planId}] Step ${step.id} (${step.action}): FAILED — ${message}`);

      if (onFailure === "skip") {
        results.push({
          stepId: step.id,
          action: step.action,
          status: "skipped",
          error: { code: "STEP_FAILED", message },
          durationMs: Date.now() - stepStart,
        });
        completedSteps.set(step.id, results[results.length - 1]);
        continue;
      }

      if (onFailure === "rollback") {
        log(`[plan:${planId}] Rolling back completed steps...`);
        await rollbackSteps(adapter, results.filter(r => r.status === "success"), log);
        results.push({
          stepId: step.id,
          action: step.action,
          status: "rolled_back",
          error: { code: "STEP_FAILED", message },
          durationMs: Date.now() - stepStart,
        });
        return {
          planId,
          status: "failed",
          steps: results,
          totalDurationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // abort
      results.push({
        stepId: step.id,
        action: step.action,
        status: "failed",
        error: { code: "STEP_FAILED", message },
        durationMs: Date.now() - stepStart,
      });
      return {
        planId,
        status: results.some(r => r.status === "success") ? "partial" : "failed",
        steps: results,
        totalDurationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  return {
    planId,
    status: dryRun ? "dry_run" : "completed",
    steps: results,
    totalDurationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };
}

async function executeStep(
  adapter: ExchangeAdapter,
  step: PlanStep,
  log: (msg: string) => void,
): Promise<unknown> {
  const p = step.params;
  const symbol = String(p.symbol ?? "").toUpperCase();
  const side = String(p.side ?? "") as "buy" | "sell";
  const size = String(p.size ?? "");

  switch (step.action) {
    case "market_order": {
      const result = await adapter.marketOrder(symbol, side, size);
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side, size, status: "success", dryRun: false, meta: { planStep: step.id, clientId: step.clientId } });
      return result;
    }
    case "limit_order": {
      const price = String(p.price ?? "");
      const result = await adapter.limitOrder(symbol, side, price, size);
      logExecution({ type: "limit_order", exchange: adapter.name, symbol, side, size, price, status: "success", dryRun: false, meta: { planStep: step.id, clientId: step.clientId } });
      return result;
    }
    case "stop_order": {
      const triggerPrice = String(p.triggerPrice ?? "");
      const limitPrice = p.limitPrice ? String(p.limitPrice) : undefined;
      return adapter.stopOrder(symbol, side, size, triggerPrice, { limitPrice, reduceOnly: !!p.reduceOnly });
    }
    case "cancel_order": {
      return adapter.cancelOrder(symbol, String(p.orderId ?? ""));
    }
    case "cancel_all": {
      return adapter.cancelAllOrders(symbol || undefined);
    }
    case "set_leverage": {
      const lev = Number(p.leverage);
      const mode = (p.marginMode as "cross" | "isolated") ?? "cross";
      return adapter.setLeverage(symbol, lev, mode);
    }
    case "close_position": {
      const positions = await adapter.getPositions();
      const pos = positions.find(pp => symbolMatch(pp.symbol, symbol));
      if (!pos) throw new Error(`No position found for ${symbol}`);
      const closeSide = pos.side === "long" ? "sell" : "buy";
      const result = await adapter.marketOrder(pos.symbol, closeSide as "buy" | "sell", pos.size);
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side: closeSide, size: pos.size, status: "success", dryRun: false, meta: { planStep: step.id, action: "close_position" } });
      return result;
    }
    case "wait": {
      const ms = Number(p.ms ?? 1000);
      log(`[wait] ${ms}ms`);
      await new Promise(r => setTimeout(r, ms));
      return { waited: ms };
    }
    case "check_balance": {
      const balance = await adapter.getBalance();
      const minAvailable = Number(p.minAvailable ?? 0);
      if (minAvailable > 0 && Number(balance.available) < minAvailable) {
        throw new Error(`Balance check failed: $${balance.available} available < $${minAvailable} required`);
      }
      return balance;
    }
    case "check_position": {
      const positions = await adapter.getPositions();
      const pos = positions.find(pp => symbolMatch(pp.symbol, symbol));
      if (p.mustExist && !pos) throw new Error(`Position ${symbol} not found`);
      if (p.mustNotExist && pos) throw new Error(`Position ${symbol} exists but should not`);
      return pos ?? { symbol, exists: false };
    }
    default:
      throw new Error(`Unknown action: ${step.action}`);
  }
}

/**
 * Attempt to rollback completed steps by performing inverse operations.
 */
async function rollbackSteps(
  adapter: ExchangeAdapter,
  completedSteps: StepResult[],
  log: (msg: string) => void,
): Promise<void> {
  // Rollback in reverse order
  for (let i = completedSteps.length - 1; i >= 0; i--) {
    const step = completedSteps[i];
    try {
      switch (step.action) {
        case "market_order":
        case "limit_order": {
          // Close the position that was opened
          // This is best-effort — market conditions may have changed
          log(`[rollback] Attempting to reverse ${step.action} ${step.stepId}`);
          // We'd need position info; just cancel any pending orders as safety measure
          await adapter.cancelAllOrders().catch(() => {});
          break;
        }
        case "cancel_order":
        case "cancel_all":
          // Can't un-cancel, skip
          break;
        default:
          break;
      }
    } catch (err) {
      log(`[rollback] Failed to rollback step ${step.stepId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
