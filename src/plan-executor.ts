import { assertCanClosePositions } from "./exchanges/trading-v2.js";
import type { ExchangeAdapter } from "./exchanges/index.js";
import { symbolMatch } from "./utils.js";
import { logExecution } from "./execution-log.js";
import { randomUUID } from "crypto";
import { invalidateCache } from "./cache.js";
import { PerpError, extractErrorMessage, isDefiniteOrderFailure, orderOutcomeUnknown } from "./errors.js";
import { closePerpVerified, isOutcomeUnknown, placePerpVerified } from "./bot/perp-order.js";
import { fillSizeString, sizeDecimalsOf } from "./exchanges/spot-result.js";
import { quarantineSymbol } from "./bot/quarantine.js";
import { resolveAdapterSlippage } from "./exchanges/slippage.js";

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
  /**
   * pending = an order step whose outcome is unknown (ORDER_PENDING): the plan stopped, the
   * symbol is quarantined, the step is never rolled back. rollback_failed = a completed step
   * whose reversal was rejected / unconfirmed / partial (symbol quarantined).
   */
  status: "success" | "failed" | "skipped" | "rolled_back" | "cancelled" | "rollback_failed" | "pending" | "dry_run";
  result?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
}

export interface PlanResult {
  planId: string;
  /** pending = an order step's outcome is unknown; quarantined = a rollback left exposure (see `quarantined`). */
  status: "completed" | "partial" | "failed" | "pending" | "quarantined" | "dry_run";
  steps: StepResult[];
  /** Symbols quarantined by this run (unknown order outcome or failed rollback). */
  quarantined: string[];
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
/** Plan actions that place orders (open or close positions). */
const PLAN_ORDER_ACTIONS: ReadonlySet<string> = new Set(["market_order", "limit_order", "stop_order", "close_position"]);

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
  // A plan that places orders must be able to close them (rollback / close_position are
  // reduce-only): refuse before the first step on a venue that cannot.
  if (!dryRun && plan.steps.some(s => PLAN_ORDER_ACTIONS.has(s.action))) {
    assertCanClosePositions(adapter, `Plan on ${adapter.name}`);
  }
  /** Order steps that completed, with their measured fill (market orders) for rollback. */
  const placed = new Map<string, PlacedOrder>();
  const quarantined = new Set<string>();
  const finish = (status: PlanResult["status"]): PlanResult => ({
    planId,
    status: quarantined.size > 0 && status !== "pending" ? "quarantined" : status,
    steps: results,
    quarantined: [...quarantined],
    totalDurationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
  const quarantine = (symbol: string, reason: string) => {
    quarantineSymbol("plan-execute", symbol, `plan ${planId}: ${reason}`,
      `Check the ${symbol} position and open orders on ${adapter.name} (perp -e ${adapter.name} account positions / trade orders); fix by hand, then: perp strategy quarantine-clear ${symbol}`, log);
    quarantined.add(symbol.toUpperCase());
  };

  log(`[plan:${planId}] Starting ${plan.steps.length} steps (${dryRun ? "DRY RUN" : "LIVE"})`);

  for (const step of plan.steps) {
    const stepStart = Date.now();

    // Check dependency
    if (step.dependsOn) {
      const dep = completedSteps.get(step.dependsOn);
      // Only a dependency that actually succeeded (or was dry-run) lets the step run:
      // failed / skipped / pending / rolled-back / missing all block it.
      if (!dep || (dep.status !== "success" && dep.status !== "dry_run")) {
        const result: StepResult = {
          stepId: step.id,
          action: step.action,
          status: "skipped",
          error: { code: "DEPENDENCY_FAILED", message: `Depends on ${step.dependsOn} which is ${dep ? dep.status : "missing"}` },
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
      const result = await executeStep(adapter, step, log, placed);
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
      const message = extractErrorMessage(err);
      const onFailure = step.onFailure ?? "abort";

      if (ORDER_ACTIONS.has(step.action) && isOutcomeUnknown(err)) {
        // The order may have been placed: never treat it as failed, never resubmit or roll it
        // back. Stop the plan and quarantine the symbol.
        const sym = String(step.params.symbol ?? "").toUpperCase();
        log(`[plan:${planId}] Step ${step.id} (${step.action}): OUTCOME UNKNOWN — ${message}`);
        quarantine(sym, `step ${step.id} (${step.action}) outcome unknown: ${message}`);
        results.push({
          stepId: step.id,
          action: step.action,
          status: "pending",
          error: { code: "ORDER_PENDING", message },
          durationMs: Date.now() - stepStart,
        });
        if (onFailure === "rollback") {
          // Reverse completed steps on OTHER symbols only — the pending order's symbol is
          // quarantined and left untouched (a reversal there could not be measured).
          await rollbackSteps(adapter, results.filter(r => r.status === "success"), placed, sym, quarantine, log);
        }
        return finish("pending");
      }

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
        await rollbackSteps(adapter, results.filter(r => r.status === "success"), placed, null, quarantine, log);
        results.push({
          stepId: step.id,
          action: step.action,
          status: "rolled_back",
          error: { code: "STEP_FAILED", message },
          durationMs: Date.now() - stepStart,
        });
        return finish("failed");
      }

      // abort
      results.push({
        stepId: step.id,
        action: step.action,
        status: "failed",
        error: { code: "STEP_FAILED", message },
        durationMs: Date.now() - stepStart,
      });
      return finish(results.some(r => r.status === "success") ? "partial" : "failed");
    }
  }

  return finish(dryRun ? "dry_run" : "completed");
}

/** Steps that send an order (a thrown non-definite error = outcome unknown). */
const ORDER_ACTIONS: ReadonlySet<PlanAction> = new Set<PlanAction>(["market_order", "limit_order", "stop_order", "close_position"]);

/** A completed order step: market orders carry the MEASURED fill (rollback size); limit / stop orders null. */
interface PlacedOrder {
  symbol: string;
  side: "buy" | "sell";
  filledSize: number | null;
  decimals: number;
  /** Venue order id of a resting (limit/stop) order; null when the venue response carried none. */
  orderId: string | null;
}

/**
 * Order id from a venue placement response: TradingV2 OrderResult.orderId, Aster/Binance
 * `orderId`, Pacifica `order_id`, HL `response.data.statuses[0].resting.oid`, generic `id`.
 * null when none is present (the rollback then refuses to guess).
 */
function extractOrderId(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const k of ["orderId", "order_id", "oid", "id"]) {
    const v = r[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  const data = (r.data ?? (r.response as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined;
  const statuses = data?.statuses as Array<Record<string, unknown>> | undefined;
  for (const k of ["resting", "filled"]) { // HL: resting order, or a limit that filled immediately
    const st = statuses?.[0]?.[k] as Record<string, unknown> | undefined;
    if (st && (typeof st.oid === "number" || typeof st.oid === "string")) return String(st.oid);
  }
  if (data) return extractOrderId(data);
  return null;
}

/** Limit / stop placement: a typed definite failure stays; anything else may have placed the order → ORDER_PENDING. */
async function sendRestingOrder(adapter: ExchangeAdapter, what: string, send: () => Promise<unknown>): Promise<unknown> {
  try {
    return await send();
  } catch (e) {
    throw isDefiniteOrderFailure(e) ? e : orderOutcomeUnknown(adapter.name, what, e);
  }
}

async function executeStep(
  adapter: ExchangeAdapter,
  step: PlanStep,
  log: (msg: string) => void,
  placed: Map<string, PlacedOrder>,
): Promise<unknown> {
  const p = step.params;
  const symbol = String(p.symbol ?? "").toUpperCase();
  const side = String(p.side ?? "") as "buy" | "sell";
  const size = String(p.size ?? "");

  switch (step.action) {
    case "market_order": {
      // Fill MEASURED as the position delta (ORDER_PENDING when unconfirmed) — the rollback
      // reverses exactly this size.
      const fill = await placePerpVerified(adapter, adapter.name, symbol, side, size);
      placed.set(step.id, { symbol, side, filledSize: fill.filledSize, decimals: sizeDecimalsOf(size), orderId: null });
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side, size, status: "success", dryRun: false, meta: { planStep: step.id, clientId: step.clientId, filledSize: fill.filledSize } });
      return fill.raw;
    }
    case "limit_order": {
      const price = String(p.price ?? "");
      const result = await sendRestingOrder(adapter, `limit ${side} ${size} ${symbol} @ ${price}`, () => adapter.limitOrder(symbol, side, price, size));
      placed.set(step.id, { symbol, side, filledSize: null, decimals: sizeDecimalsOf(size), orderId: extractOrderId(result) });
      logExecution({ type: "limit_order", exchange: adapter.name, symbol, side, size, price, status: "success", dryRun: false, meta: { planStep: step.id, clientId: step.clientId } });
      return result;
    }
    case "stop_order": {
      const triggerPrice = String(p.triggerPrice ?? "");
      const limitPrice = p.limitPrice ? String(p.limitPrice) : undefined;
      const result = await sendRestingOrder(adapter, `stop ${side} ${size} ${symbol} @ ${triggerPrice}`, () => adapter.stopOrder(symbol, side, size, triggerPrice, {
        limitPrice, reduceOnly: !!p.reduceOnly,
        // Market triggers carry the resolved bound (protection-priced on Lighter / Arcus; native triggers ignore it).
        ...(limitPrice === undefined ? { slippage: resolveAdapterSlippage(adapter, null) } : {}),
      }));
      placed.set(step.id, { symbol, side, filledSize: null, decimals: sizeDecimalsOf(size), orderId: extractOrderId(result) });
      return result;
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
      invalidateCache("acct"); // size the reduce-only close from a fresh read, never a cached position
      const positions = await adapter.getPositions();
      const pos = positions.find(pp => symbolMatch(pp.symbol, symbol));
      if (!pos) throw new Error(`No position found for ${symbol}`);
      const closeSide = pos.side === "long" ? "sell" : "buy";
      // Size from the live position (abs), reduce-only: a stale / repeated close can never open
      // or flip a position — the venue rejects it instead. Fill measured (ORDER_PENDING when unconfirmed).
      // A partial close (venue-final IOC partial fills are accepted) gets ONE residual
      // close (closePerpVerified); a residual still open fails the step with ORDER_PARTIAL.
      const liveSize = pos.size.replace(/^-/, "");
      const c = await closePerpVerified(adapter, adapter.name, pos.symbol, closeSide, liveSize);
      logExecution({ type: "market_order", exchange: adapter.name, symbol, side: closeSide, size: liveSize, status: c.residual > 0 ? "failed" : "success", dryRun: false, meta: { planStep: step.id, action: "close_position", reduceOnly: true, filledSize: c.closed, residual: c.residual } });
      if (c.residual > 0) {
        throw new PerpError("ORDER_PARTIAL", `close_position ${pos.symbol}: closed ${c.closed} of ${liveSize}, ${c.residual} still open${c.note !== null ? ` (${c.note})` : ""}`, { exchange: adapter.name });
      }
      return { symbol: pos.symbol, side: closeSide, size: liveSize, closed: c.closed };
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
 * Reverse completed steps (reverse order). A filled market order is closed reduce-only for
 * its MEASURED fill (closePerpVerified, residual handled); a limit / stop order's resting
 * orders are cancelled on that step's symbol only. A reversal that is rejected, unconfirmed
 * or partial marks the step rollback_failed and quarantines the symbol. Steps on
 * `skipSymbol` (an order whose outcome is unknown) are left untouched.
 */
async function rollbackSteps(
  adapter: ExchangeAdapter,
  completedSteps: StepResult[],
  placed: Map<string, PlacedOrder>,
  skipSymbol: string | null,
  quarantine: (symbol: string, reason: string) => void,
  log: (msg: string) => void,
): Promise<void> {
  for (let i = completedSteps.length - 1; i >= 0; i--) {
    const step = completedSteps[i];
    const order = placed.get(step.stepId);
    if (order === undefined) continue; // not an order step (cancel / leverage / checks / close_position): nothing to reverse
    if (skipSymbol !== null && order.symbol === skipSymbol) {
      log(`[rollback] Leaving ${step.stepId} (${order.symbol}) — the symbol has an order with unknown outcome (quarantined)`);
      continue;
    }
    try {
      if (order.filledSize !== null) {
        const size = fillSizeString(order.filledSize, order.decimals);
        if (!(Number(size) > 0)) continue;
        const closeSide = order.side === "buy" ? "sell" : "buy";
        log(`[rollback] Reversing ${step.stepId}: reduce-only ${closeSide} ${size} ${order.symbol}`);
        const c = await closePerpVerified(adapter, adapter.name, order.symbol, closeSide, size, { decimals: order.decimals });
        if (c.residual > 0) throw new Error(`closed ${c.closed}; ${c.residual} still open${c.note !== null ? ` (${c.note})` : ""}`);
      } else {
        // Resting limit / stop: cancel ONLY this step's order (never the user's other orders
        // on the symbol). Any fill before the cancel is not reversed — the step is marked
        // "cancelled" (not "rolled_back") and the log says to check the position.
        if (order.orderId === null) {
          throw new Error(`no order id was returned for ${step.stepId}; cancel it manually (perp trade cancel ${order.symbol} <orderId>)`);
        }
        log(`[rollback] Cancelling ${step.stepId} order ${order.orderId} on ${order.symbol}`);
        await adapter.cancelOrder(order.symbol, order.orderId);
        log(`[rollback] ${step.stepId}: any partial fill before the cancel is NOT reversed — check ${order.symbol} position`);
        step.status = "cancelled";
        continue;
      }
      step.status = "rolled_back";
    } catch (err) {
      const message = extractErrorMessage(err);
      log(`[rollback] Failed to rollback step ${step.stepId}: ${message}`);
      step.status = "rollback_failed";
      step.error = { code: isOutcomeUnknown(err) ? "ORDER_PENDING" : "ROLLBACK_FAILED", message };
      quarantine(order.symbol, `rollback of step ${step.stepId} (${step.action} ${order.side} ${order.symbol}) ${isOutcomeUnknown(err) ? "unconfirmed" : "failed"}: ${message}`);
    }
  }
}
