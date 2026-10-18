/**
 * Pacifica Print — yield-earning strike orders (docs.pacifica.fi/print.md and pages under it).
 *
 * Product (docs + live API, 2026-10-19):
 *  - A Print order locks a USDC deposit (min 10) as margin and names a target ("strike") price:
 *    long = target BELOW mark, short = target ABOVE mark, 0.5% … 10% / 20% / 40% from mark for a
 *    24-hour / 7-day / 30-day cycle. Leverage 1× … the product's max (live /game/config).
 *  - Each cycle the Print pool pays a premium ("yield") at the START of the cycle; it is added to
 *    the order's locked margin. WHILE RESTING (before a fill) the order is evaluated only at the
 *    END of each cycle: mark at/through the target → it fills AT the target; otherwise it rolls to
 *    a new target at the same % distance from the new mark; mark beyond the liquidation level at
 *    that checkpoint → liquidated, the margin (deposit + premiums) is lost.
 *  - AFTER a fill it is an ordinary perp position in the main account (size = deposit × leverage
 *    / target): continuous mark-price liquidation, it nets with an existing position in the same
 *    market and may be cross-margined — read it with `perp -e pacifica account positions`.
 *  - Max loss of the resting order = deposit + premiums.
 *  - `total_segments` 1 … 1000 caps the number of cycles; omitted = rolls until ended.
 *  - Ending ("cancel", signing type `end_game`, POST /game/end) takes effect only at the end of
 *    the current cycle; funds return to the trading balance then. No in-place edit.
 *
 * Endpoints (unauthenticated GET; writes are signed):
 *   GET  /game/config                          products (game ids, cycle, caps, max leverage)
 *   GET  /game/accounts?account=               the account's current Print orders
 *   GET  /game/history_summary?account=        every Print order of the account (paginated)
 *   GET  /game/history?game_account=           event log of one Print order (paginated)
 *   POST /game/deposit   type deposit_to_game  create (documented)
 *   POST /game/end       type end_game         end at the cycle's close — UNOFFICIAL: not in the API docs,
 *                                              shape captured from app.pacifica.fi (fixture app-end-game-request.json)
 * `preview_game_account` (POST /game/preview, the app's premium quote) is a SIGNED request; read
 * paths never sign, so the premium of a new order is not quoted here (estimatedPremium: null).
 */
import { PerpError } from "../errors.js";
import { USDC_DECIMALS } from "../pacifica/constants.js";
import type { PacificaClient } from "../pacifica/client.js";
import { exactUnits, mulDecimal, subDecimal, formatComputedPrice } from "./precision.js";
import { cmpDecimal, divDecimal, fractionDigits, isPlainDecimal, trimDecimal } from "./pacifica-decimal.js";
import { buildPresigned, type PresignedIdentity, type PresignedRequest } from "./pacifica-presigned.js";

// ── Documented limits ───────────────────────────────────────────────────

/** docs print/placing-and-managing-orders: "Deposit — your locked margin, minimum $10". */
export const PRINT_MIN_DEPOSIT_USDC = "10";
/** docs: target "at least 0.5% away from the current mark price". */
export const PRINT_MIN_TARGET_DISTANCE_PCT = "0.5";
/** docs: "at most 10% on a 24-hour cycle, 20% on 7 days, or 40% on 30 days" (keyed by cycle days). */
export const PRINT_MAX_TARGET_DISTANCE_PCT: Readonly<Record<number, string>> = { 1: "10", 7: "20", 30: "40" };
/** API create-print-order: "total_segments … 1 to 1000". */
export const PRINT_MAX_CYCLES = 1000;

const DAY_MS = 86_400_000;

/**
 * The docs formula (target ∓ (deposit + yield) × target / (leverage × deposit)) is where the margin
 * is fully lost. A liquidation was observed earlier than that in one live case (mainnet 2026-10-16:
 * a ZEC_24H short, strike 1150.95, 10×, deposit 922.93, premium 23.80, liquidated at the checkpoint
 * with mark 1216.836 while the formula gives ≈ 1269.0). The venue's trigger is unpublished; its own
 * figure comes only from the signed preview (preview_game_account), not called here.
 */
export const PRINT_LIQUIDATION_NOTE = "docsLiquidationPrice is the docs formula (margin fully lost) — an outer bound, not the trigger: a liquidation was observed earlier in one live case (2026-10-16); the venue's trigger is unpublished. After a fill the position follows ordinary perp liquidation (continuous mark price, main account).";

// ── Models ──────────────────────────────────────────────────────────────

export type PrintDirection = "long" | "short";

export interface PrintGame {
  schema: 1;
  /** Product id sent as `game` (e.g. BTC_24H, BTC_7D, BTC_1M). */
  game: string;
  asset: string;
  /** Cycle length in days (segment_kind fixed_days), null when the venue reports another kind. */
  cycleDays: number | null;
  maxLeverage: string | null;
  /** Cap on the TOTAL open deposits of this product across all users (USDC) — not a per-order limit. */
  productDepositCap: string | null;
  /** Cap on open deposits of the whole Print pool (USDC). */
  poolDepositCap: string | null;
  capScope: string | null;
  /** Vault ("lake") that pays the premiums. */
  poolAddress: string | null;
  minDeposit: string;
  targetDistancePct: { min: string; max: string | null };
}

export type PrintStatus = "printing" | "cancelling" | "filled" | "liquidated" | "cancelled" | "completed" | "ended";

export interface PrintPosition {
  schema: 1;
  /** Print order account address (`game_account`). */
  address: string;
  game: string;
  asset: string | null;
  direction: PrintDirection;
  deposit: string;
  strikePrice: string;
  leverage: string;
  entryMarkPrice: string | null;
  /** Premiums credited so far (USDC). */
  premiumPaid: string | null;
  /** deposit × leverage. */
  notional: string;
  /** Size opened on a fill: notional ÷ strike. */
  size: string | null;
  /**
   * docs formula (margin fully lost) with the premiums paid; null when ≤ 0 or unknown. NOT the
   * venue's trigger: it liquidates earlier, at maintenance margin (PRINT_LIQUIDATION_NOTE).
   */
  docsLiquidationPrice: string | null;
  /** deposit + premiums — the most that can be lost. */
  maxLoss: string | null;
  cycles: { total: number | null; started: number | null };
  createdAt: number | null;
  startedAt: number | null;
  currentCycleEndAt: number | null;
  scheduledEndAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  cancelRequested: boolean;
  status: PrintStatus;
}

export interface PrintEvent {
  schema: 1;
  id: number;
  printAddress: string;
  depositor: string | null;
  event: string;
  amount: string | null;
  strikePrice: string | null;
  markPrice: string | null;
  /** Position size of a position_opened event. */
  size: string | null;
  cycleStartedAt: number | null;
  cycleEndedAt: number | null;
  cycleNumber: number | null;
  time: number;
}

export interface Page<T> { items: T[]; hasMore: boolean | null; nextCursor: string | null }

// ── Parsing (strict: a missing required field is EXCHANGE_ERROR, an optional one is null) ──

function bad(what: string, row: unknown): PerpError {
  return new PerpError("EXCHANGE_ERROR", `Pacifica ${what}: ${JSON.stringify(row).slice(0, 200)}`, { exchange: "pacifica" });
}

function reqStr(row: Record<string, unknown>, key: string, ctx: string): string {
  const v = row[key];
  if (typeof v === "string" && v !== "") return v;
  throw bad(`${ctx} without a readable ${key}`, row);
}

function optStr(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function reqDec(row: Record<string, unknown>, key: string, ctx: string): string {
  const v = reqStr(row, key, ctx);
  if (!isPlainDecimal(v)) throw bad(`${ctx} with a non-decimal ${key}`, row);
  return trimDecimal(v);
}

function optDec(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return isPlainDecimal(v) ? trimDecimal(v) : null;
}

/** Positive ms timestamp, else null (the venue sends null / 0 for "not yet"). */
function optMs(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function optInt(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function asRow(x: unknown, ctx: string): Record<string, unknown> {
  if (x === null || typeof x !== "object" || Array.isArray(x)) throw bad(`${ctx} is not an object`, x);
  return x as Record<string, unknown>;
}

/** `data` of a `{success: true, data}` envelope; a refusal / other shape is EXCHANGE_ERROR. */
export function envelopeData(env: Record<string, unknown>, path: string): unknown {
  if (env.success !== true) throw new PerpError("EXCHANGE_ERROR", `Pacifica GET ${path} failed: ${String(env.error ?? JSON.stringify(env).slice(0, 160))}`, { exchange: "pacifica" });
  return env.data;
}

function pageMeta(env: Record<string, unknown>): { hasMore: boolean | null; nextCursor: string | null } {
  return {
    hasMore: typeof env.has_more === "boolean" ? env.has_more : null,
    nextCursor: typeof env.next_cursor === "string" && env.next_cursor !== "" ? env.next_cursor : null,
  };
}

/** GET /game/config `data` → products (`{configs: [...]}`; the app also accepts a bare array). */
export function parsePrintGames(data: unknown): PrintGame[] {
  const rows = Array.isArray(data) ? data : asRow(data, "/game/config data").configs;
  if (!Array.isArray(rows)) throw bad("/game/config without a configs list", data);
  return rows.map((x) => {
    const r = asRow(x, "/game/config row");
    const kind = optStr(r, "segment_kind");
    const days = kind === "fixed_days" ? optInt(r, "segment_value") : null;
    return {
      schema: 1,
      game: reqStr(r, "game", "/game/config row"),
      asset: reqStr(r, "target_asset", "/game/config row"),
      cycleDays: days !== null && days > 0 ? days : null,
      maxLeverage: optDec(r, "max_leverage"),
      productDepositCap: optDec(r, "deposit_cap"),
      poolDepositCap: optDec(r, "lake_deposit_cap"),
      capScope: optStr(r, "cap_scope"),
      poolAddress: optStr(r, "lake_address"),
      minDeposit: PRINT_MIN_DEPOSIT_USDC,
      targetDistancePct: { min: PRINT_MIN_TARGET_DISTANCE_PCT, max: days !== null ? PRINT_MAX_TARGET_DISTANCE_PCT[days] ?? null : null },
    };
  });
}

function directionOf(v: unknown, row: unknown): PrintDirection {
  if (v === 0) return "long";
  if (v === 1) return "short";
  throw bad(`Print order with unknown direction ${JSON.stringify(v)}`, row);
}

/** docs margin-and-liquidation: target ∓ (deposit + yield) × target / (leverage × deposit). */
export function printLiquidationPrice(direction: PrintDirection, strike: string, deposit: string, leverage: string, premium: string, tickSize: string | null = null): string | null {
  const k = divDecimal(sum(deposit, premium), mulDecimal(leverage, deposit));
  if (k === null) return null;
  const off = mulDecimal(strike, k);
  const px = direction === "long" ? subDecimal(strike, off) : sum(strike, off);
  if (cmpDecimal(px, "0") <= 0) return null;
  return formatComputedPrice(Number(px), tickSize);
}

function sum(a: string, b: string): string {
  return subDecimal(a, `-${b}`.replace(/^--/, ""));
}

/** One /game/accounts or /game/history_summary row. */
export function parsePrintPosition(x: unknown): PrintPosition {
  const r = asRow(x, "Print order row");
  const ctx = "Print order row";
  const direction = directionOf(r.direction, r);
  const deposit = reqDec(r, "initial_deposit", ctx);
  const strike = reqDec(r, "strike_price", ctx);
  const leverage = reqDec(r, "leverage", ctx);
  const premium = optDec(r, "premium_paid");
  const endedAt = optMs(r, "game_ended_at_ms");
  const endReason = optStr(r, "end_reason");
  const cancelRequested = r.user_initiated_game_end === true;
  const notional = mulDecimal(deposit, leverage);
  let status: PrintStatus;
  if (endedAt !== null) {
    status = endReason === "filled" ? "filled"
      : endReason === "liquidated" ? "liquidated"
        : endReason === "user_requested" ? "cancelled"
          : endReason === "schedule_completed" ? "completed"
            : "ended"; // ended, reason not reported — never guessed
  } else {
    status = cancelRequested ? "cancelling" : "printing";
  }
  return {
    schema: 1,
    address: reqStr(r, "address", ctx),
    game: reqStr(r, "game", ctx),
    asset: optStr(r, "target_asset"),
    direction,
    deposit,
    strikePrice: strike,
    leverage,
    entryMarkPrice: optDec(r, "entry_mark_price"),
    premiumPaid: premium,
    notional,
    size: divDecimal(notional, strike, 8),
    docsLiquidationPrice: premium === null ? null : printLiquidationPrice(direction, strike, deposit, leverage, premium),
    maxLoss: premium === null ? null : sum(deposit, premium),
    cycles: { total: optInt(r, "total_segments"), started: optInt(r, "segments_started") },
    createdAt: optMs(r, "game_created_at_ms"),
    startedAt: optMs(r, "game_started_at_ms"),
    currentCycleEndAt: optMs(r, "current_segment_end_at_ms"),
    scheduledEndAt: optMs(r, "scheduled_end_at_ms"),
    endedAt,
    endReason,
    cancelRequested,
    status,
  };
}

/** GET /game/accounts `data` (`{game_accounts: [...]}`). */
export function parsePrintAccounts(data: unknown): PrintPosition[] {
  const rows = Array.isArray(data) ? data : asRow(data, "/game/accounts data").game_accounts;
  if (!Array.isArray(rows)) throw bad("/game/accounts without a game_accounts list", data);
  return rows.map(parsePrintPosition);
}

/** One /game/history event (created / premium / end_requested / filled / liquidated / …). */
export function parsePrintEvent(x: unknown): PrintEvent {
  const r = asRow(x, "/game/history row");
  const id = r.history_id;
  const time = r.created_at;
  if (typeof id !== "number" || typeof time !== "number") throw bad("/game/history row without history_id / created_at", r);
  return {
    schema: 1,
    id,
    printAddress: reqStr(r, "address", "/game/history row"),
    depositor: optStr(r, "depositor_address"),
    event: reqStr(r, "event_type", "/game/history row"),
    amount: optDec(r, "amount"),
    strikePrice: optDec(r, "strike_price"),
    markPrice: optDec(r, "mark_price"),
    size: optDec(r, "size"),
    cycleStartedAt: optMs(r, "segment_started_at_ms"),
    cycleEndedAt: optMs(r, "segment_ended_at_ms"),
    cycleNumber: optInt(r, "segment_number"),
    time,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────

type Reader = Pick<PacificaClient, "getEnvelope">;

export async function fetchPrintGames(client: Reader): Promise<PrintGame[]> {
  return parsePrintGames(envelopeData(await client.getEnvelope("/game/config"), "/game/config"));
}

export async function fetchPrintPositions(client: Reader, account: string): Promise<PrintPosition[]> {
  return parsePrintAccounts(envelopeData(await client.getEnvelope("/game/accounts", { account }), "/game/accounts"));
}

function pageParams(p: { limit: number | null; cursor: string | null }): Record<string, string> {
  return { ...(p.limit !== null ? { limit: String(p.limit) } : {}), ...(p.cursor !== null ? { cursor: p.cursor } : {}) };
}

export async function fetchPrintHistory(client: Reader, account: string, page: { limit: number | null; cursor: string | null }): Promise<Page<PrintPosition>> {
  const env = await client.getEnvelope("/game/history_summary", { account, ...pageParams(page) });
  const data = envelopeData(env, "/game/history_summary");
  if (!Array.isArray(data)) throw bad("/game/history_summary without a list", data);
  return { items: data.map(parsePrintPosition), ...pageMeta(env) };
}

export async function fetchPrintEvents(client: Reader, printAddress: string, page: { limit: number | null; cursor: string | null }): Promise<Page<PrintEvent>> {
  const env = await client.getEnvelope("/game/history", { game_account: printAddress, ...pageParams(page) });
  const data = envelopeData(env, "/game/history");
  if (!Array.isArray(data)) throw bad("/game/history without a list", data);
  return { items: data.map(parsePrintEvent), ...pageMeta(env) };
}

/** Mark price + tick size of the product's perp market (GET /prices, GET /info). */
export async function fetchPrintMarket(client: Pick<PacificaClient, "getPrices" | "getInfo">, asset: string): Promise<{ mark: string; tickSize: string }> {
  const [prices, info] = await Promise.all([client.getPrices(), client.getInfo()]);
  const p = prices.find((x) => x.symbol === asset);
  const m = info.find((x) => x.symbol === asset);
  if (p === undefined || !isPlainDecimal(p.mark) || !(Number(p.mark) > 0)) {
    throw new PerpError("PRICE_STALE", `Pacifica has no mark price for ${asset}`, { exchange: "pacifica", remediation: "Retry; check perp -e pacifica market list" });
  }
  if (m === undefined || !isPlainDecimal(m.tick_size)) {
    throw new PerpError("EXCHANGE_ERROR", `Pacifica /info has no tick_size for ${asset}`, { exchange: "pacifica" });
  }
  return { mark: p.mark, tickSize: m.tick_size };
}

/** The product `game` (case-insensitive) from the live list; unknown → SYMBOL_NOT_FOUND naming what exists. */
export function findPrintGame(games: PrintGame[], game: string): PrintGame {
  const g = games.find((x) => x.game.toUpperCase() === game.toUpperCase());
  if (g === undefined) {
    throw new PerpError("SYMBOL_NOT_FOUND", `No Print product "${game}"`, {
      exchange: "pacifica", remediation: `Available: ${games.map((x) => x.game).join(", ")} — see: perp -e pacifica print games`,
    });
  }
  return g;
}

// ── Order validation + preview ──────────────────────────────────────────

export interface PrintOrderInput {
  game: string;
  direction: PrintDirection;
  /** USDC deposit (decimal string). */
  deposit: string;
  strikePrice: string;
  leverage: string;
  /** Number of cycles (total_segments) or null = roll until ended. */
  cycles: number | null;
}

export interface PrintQuote {
  schema: 1;
  game: string;
  asset: string;
  cycleDays: number;
  direction: PrintDirection;
  deposit: string;
  leverage: string;
  strikePrice: string;
  markPrice: string;
  /** |mark − strike| ÷ mark × 100, 4 decimals. */
  targetDistancePct: string;
  allowedTargetDistancePct: { min: string; max: string };
  notional: string;
  /** Position size opened on a fill (asset units, 8 decimals). */
  size: string;
  /** docs formula before any premium (margin fully lost) — the venue liquidates EARLIER (PRINT_LIQUIDATION_NOTE). */
  docsLiquidationPrice: string | null;
  liquidationNote: string;
  /** The deposit now; the deposit plus every premium credited later. Never more. */
  maxLoss: string;
  cycles: number | null;
  /** cycles × cycleDays, null = until ended. */
  maxDurationDays: number | null;
  /** An end request takes effect at the end of the running cycle: up to this many days. */
  cancelSettlesWithinDays: number;
  /** The venue's premium quote is a signed request (preview_game_account) — not called on a read path. */
  estimatedPremium: null;
  notes: string[];
}

function invalid(msg: string, remediation: string): PerpError {
  return new PerpError("INVALID_PARAMS", msg, { exchange: "pacifica", remediation });
}

/** Plain non-negative decimal without leading zeros ("0.5", "10", "10.25"; not "010", "1e3", ".5"). */
export const PLAIN_POSITIVE = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Strict USDC amount: plain positive decimal, no leading zeros, at most 6 fractional digits (USDC precision). */
export function requireUsdcAmount(raw: string, what: string): string {
  const s = String(raw).trim();
  if (!PLAIN_POSITIVE.test(s) || !(Number(s) > 0)) throw invalid(`${what} must be a positive decimal number without leading zeros (got "${raw}")`, "Pass a plain decimal amount, e.g. 100 or 100.5");
  if (fractionDigits(s) > USDC_DECIMALS) throw invalid(`${what} ${s} has more than ${USDC_DECIMALS} decimals (USDC precision)`, `Round to ${USDC_DECIMALS} decimals`);
  return trimDecimal(s);
}

/**
 * Validate a Print order against the product and the live mark (docs limits) and compute the
 * preview. Throws INVALID_PARAMS / INVALID_TICK / CAPABILITY_UNSUPPORTED; signs and sends nothing.
 */
export function quotePrintOrder(game: PrintGame, input: PrintOrderInput, market: { mark: string; tickSize: string }): PrintQuote {
  const where = `Print ${game.game}`;
  if (game.cycleDays === null || game.targetDistancePct.max === null) {
    throw new PerpError("CAPABILITY_UNSUPPORTED", `${where}: cycle length not in the documented set (24 hours / 7 days / 30 days) — no documented target range`, {
      exchange: "pacifica", remediation: "Use a product listed with a 1d / 7d / 30d cycle in: perp -e pacifica print games",
    });
  }
  if (game.maxLeverage === null) {
    throw new PerpError("EXCHANGE_ERROR", `${where}: /game/config reports no max_leverage`, { exchange: "pacifica" });
  }
  const deposit = requireUsdcAmount(input.deposit, "deposit");
  if (cmpDecimal(deposit, PRINT_MIN_DEPOSIT_USDC) < 0) {
    throw invalid(`${where}: deposit ${deposit} USDC is below the ${PRINT_MIN_DEPOSIT_USDC} USDC minimum`, `Deposit at least ${PRINT_MIN_DEPOSIT_USDC} USDC`);
  }
  // No local deposit_cap check: it caps the product's total open deposits (all users), so only the
  // venue knows the remaining room — its refusal decides.
  if (!/^[1-9]\d*$/.test(input.leverage) || cmpDecimal(input.leverage, game.maxLeverage) > 0) {
    throw invalid(`${where}: leverage must be a whole number from 1 to ${game.maxLeverage} (got "${input.leverage}")`, `Pass --leverage 1 … ${game.maxLeverage}`);
  }
  const leverage = input.leverage;
  const strike = String(input.strikePrice).trim();
  if (!PLAIN_POSITIVE.test(strike) || !(Number(strike) > 0)) throw invalid(`${where}: strike must be a positive price (got "${input.strikePrice}")`, "Pass --strike <price>");
  if (exactUnits(strike, market.tickSize) === null) {
    throw new PerpError("INVALID_TICK", `${where}: strike ${strike} is not a multiple of the ${game.asset} tick ${market.tickSize}`, {
      exchange: "pacifica", remediation: `Use a strike that is a multiple of ${market.tickSize}`,
    });
  }
  const mark = market.mark;
  const side = cmpDecimal(strike, mark);
  if (input.direction === "long" && side >= 0) throw invalid(`${where}: a Print long's target must be BELOW the mark ${mark} (got ${strike})`, "Lower the strike, or use short");
  if (input.direction === "short" && side <= 0) throw invalid(`${where}: a Print short's target must be ABOVE the mark ${mark} (got ${strike})`, "Raise the strike, or use long");
  const gap = input.direction === "long" ? subDecimal(mark, strike) : subDecimal(strike, mark);
  const gapX100 = mulDecimal(gap, "100");
  const { min, max } = { min: game.targetDistancePct.min, max: game.targetDistancePct.max };
  if (cmpDecimal(gapX100, mulDecimal(min, mark)) < 0 || cmpDecimal(gapX100, mulDecimal(max, mark)) > 0) {
    throw invalid(`${where}: target ${strike} is ${divDecimal(gapX100, mark, 4)}% from the mark ${mark}; allowed ${min}% … ${max}% for a ${game.cycleDays}-day cycle`,
      `Pick a strike ${min}% … ${max}% ${input.direction === "long" ? "below" : "above"} the mark`);
  }
  if (input.cycles !== null && !(Number.isInteger(input.cycles) && input.cycles >= 1 && input.cycles <= PRINT_MAX_CYCLES)) {
    throw invalid(`${where}: cycles must be a whole number from 1 to ${PRINT_MAX_CYCLES} (got ${input.cycles})`, `Pass --cycles 1 … ${PRINT_MAX_CYCLES}, or omit it to roll until ended`);
  }
  const notional = mulDecimal(deposit, leverage);
  const size = divDecimal(notional, strike, 8) as string;
  return {
    schema: 1,
    game: game.game,
    asset: game.asset,
    cycleDays: game.cycleDays,
    direction: input.direction,
    deposit,
    leverage,
    strikePrice: strike,
    markPrice: mark,
    targetDistancePct: divDecimal(gapX100, mark, 4) as string,
    allowedTargetDistancePct: { min, max },
    notional,
    size,
    docsLiquidationPrice: printLiquidationPrice(input.direction, strike, deposit, leverage, "0", market.tickSize),
    maxLoss: deposit,
    cycles: input.cycles,
    maxDurationDays: input.cycles === null ? null : input.cycles * game.cycleDays,
    cancelSettlesWithinDays: game.cycleDays,
    liquidationNote: PRINT_LIQUIDATION_NOTE,
    estimatedPremium: null,
    notes: [
      `While resting, fill and liquidation are checked only at each ${game.cycleDays}-day checkpoint; a fill opens ${size} ${game.asset} at exactly ${strike}.`,
      `After a fill it is an ordinary position in your main account: continuous mark-price liquidation, it nets with any ${game.asset} position you hold and may be cross-margined — see perp -e pacifica account positions.`,
      `Max loss: the ${deposit} USDC deposit plus every premium credited to it — never more.`,
      `Cancelling resolves at the end of the running cycle (up to ${game.cycleDays} day${game.cycleDays === 1 ? "" : "s"}); funds stay locked until then.`,
      "The premium is set by the venue at the start of each cycle; its quote (preview_game_account) is a signed request and is not called here.",
      "Product and pool deposit caps are totals shared by all users: the venue refuses when they are full (not checkable here).",
    ],
  };
}

// ── Write requests (pure) ───────────────────────────────────────────────

/** POST /game/deposit body + canonical message (deposit_to_game). Field set per the API docs. */
export function buildPrintDepositRequest(q: PrintQuote, identity: PresignedIdentity, opts: { timestamp: number; idempotencyKey: string; expiryWindow?: number }): PresignedRequest {
  return buildPresigned({
    type: "deposit_to_game",
    path: "/game/deposit",
    identity,
    timestamp: opts.timestamp,
    expiryWindow: opts.expiryWindow,
    payload: {
      game: q.game,
      deposit_amount: q.deposit,
      direction: q.direction === "long" ? 0 : 1,
      strike_price: q.strikePrice,
      leverage: q.leverage,
      ...(q.cycles !== null ? { total_segments: q.cycles } : {}),
      idempotency_key: opts.idempotencyKey,
    },
  });
}

/** POST /game/end body + canonical message (end_game, payload `{game_account}` as app.pacifica.fi sends it). */
export function buildPrintEndRequest(printAddress: string, identity: PresignedIdentity, opts: { timestamp: number; expiryWindow?: number }): PresignedRequest {
  return buildPresigned({
    type: "end_game",
    path: "/game/end",
    identity,
    timestamp: opts.timestamp,
    expiryWindow: opts.expiryWindow,
    payload: { game_account: printAddress },
  });
}

/** An end request is accepted only for a running order of the account (not ended, not already ending). */
export function requireEndable(positions: PrintPosition[], printAddress: string): PrintPosition {
  const p = positions.find((x) => x.address === printAddress);
  if (p === undefined) {
    throw new PerpError("POSITION_NOT_FOUND", `No current Print order ${printAddress} on this account`, {
      exchange: "pacifica", remediation: "List them: perp -e pacifica print positions",
    });
  }
  if (p.status !== "printing") {
    throw invalid(`Print order ${printAddress} is ${p.status}; only a running (printing) order can be ended`, "Nothing to do — see: perp -e pacifica print positions");
  }
  return p;
}

/** When a cycle that ends at `cycleEndAt` frees the funds, in days from `now` (null = unknown). */
export function daysUntil(cycleEndAt: number | null, now: number): string | null {
  return cycleEndAt === null ? null : (Math.max(0, cycleEndAt - now) / DAY_MS).toFixed(2);
}
