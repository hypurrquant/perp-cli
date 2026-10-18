/**
 * Pacifica vaults ("lakes" in the API) — docs.pacifica.fi/vaults.md and pages under it,
 * api-documentation/api/rest-api/vaults/*.
 *
 * Product: a vault is a real Pacifica account traded by its manager; depositors (LPs) get LP
 * shares at NAV (lp_balance ÷ lp_shares, 1:1 when the LP class is empty). PnL is attributed to the
 * LP / manager classes before every deposit or withdrawal; the manager takes `manager_profit_share`
 * of profit above the high-water mark. Minimum deposit 10 USDC; `deposit_cap` caps the LP balance
 * (manager deposits are not counted). A withdrawal redeems shares (amount = shares × NAV) straight
 * into the depositor's own trading balance — the API has no destination field — and is allowed
 * only when: enough shares; `deposit_min_duration_ms` elapsed since the depositor's LAST deposit
 * (each deposit resets the lock for the whole balance); inside the withdrawal window when
 * `withdraw_window_s` / `withdraw_duration_s` are set (open while now_s mod window < duration,
 * epoch-anchored); and the vault has free balance (a fully deployed vault may pay partially).
 * The venue publishes no APY: `apy` is null.
 *
 * Endpoints (GET unauthenticated; writes signed):
 *   GET  /lake/list[?account=]                       vaults (+ the account's `user_share`)
 *   GET  /lake/get_deposit_whitelist?lake=           deposit-address whitelist (app.pacifica.fi; not in the API docs)
 *   GET  /account?account=<vault> · /positions       the vault account's live equity / positions
 *   POST /lake/deposit   type deposit_to_lake        {lake, amount, idempotency_key?}
 *   POST /lake/withdraw  type withdraw_from_lake     {lake, shares, idempotency_key?}
 * Live 2026-10-19: absent config fields are omitted (→ null here), and `user_share` was null for a
 * vault's own manager (it counts LP shares; the manager's are `manager_shares`).
 */
import { PerpError } from "../errors.js";
import type { PacificaClient } from "../pacifica/client.js";
import { mulDecimal, subDecimal } from "./precision.js";
import { cmpDecimal, divDecimal, isPlainDecimal, trimDecimal } from "./pacifica-decimal.js";
import { envelopeData, requireUsdcAmount } from "./pacifica-print.js";
import { buildPresigned, type PresignedIdentity, type PresignedRequest } from "./pacifica-presigned.js";

/** docs vaults/depositing: "Minimum deposit — Constant 10 USDC." */
export const VAULT_MIN_DEPOSIT_USDC = "10";

export interface VaultConfig {
  depositCap: string | null;
  managerProfitShare: string | null;
  managerLossShare: string | null;
  depositMinDurationMs: number | null;
  managerMinBalancePortion: string | null;
  managerLiquidationBalancePortion: string | null;
  withdrawWindowS: number | null;
  withdrawDurationS: number | null;
}

export interface PacificaVault {
  schema: 1;
  address: string;
  nickname: string | null;
  creator: string | null;
  manager: string | null;
  referrer: string | null;
  createdAt: number | null;
  lpShares: string;
  managerShares: string;
  lpBalance: string;
  managerBalance: string;
  /** lp_balance + manager_balance (USDC attributed to the two share classes). */
  tvl: string;
  /** last_checked_equity — the equity snapshot used for vault accounting. */
  equitySnapshot: string | null;
  highWatermark: string | null;
  /** lp_balance ÷ lp_shares (null when the LP class is empty — the next deposit mints 1:1). */
  navPerLpShare: string | null;
  navPerManagerShare: string | null;
  /** Not published by the venue. */
  apy: null;
  config: VaultConfig;
  /** The queried account's LP shares (`user_share`); null when none / not queried. */
  userShares: string | null;
}

function bad(what: string, row: unknown): PerpError {
  return new PerpError("EXCHANGE_ERROR", `Pacifica ${what}: ${JSON.stringify(row).slice(0, 200)}`, { exchange: "pacifica" });
}

function str(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === "string" && v !== "" ? v : null;
}

function dec(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return isPlainDecimal(v) ? trimDecimal(v) : null;
}

function reqDec(r: Record<string, unknown>, k: string): string {
  const v = dec(r, k);
  if (v === null) throw bad(`/lake/list row without a decimal ${k}`, r);
  return v;
}

function int(r: Record<string, unknown>, k: string): number | null {
  const v = r[k];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function add(a: string, b: string): string {
  return subDecimal(a, `-${b}`.replace(/^--/, ""));
}

function parseConfig(x: unknown): VaultConfig {
  const c = x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  return {
    depositCap: dec(c, "deposit_cap"),
    managerProfitShare: dec(c, "manager_profit_share"),
    managerLossShare: dec(c, "manager_loss_share"),
    depositMinDurationMs: int(c, "deposit_min_duration_ms"),
    managerMinBalancePortion: dec(c, "manager_min_balance_portion"),
    managerLiquidationBalancePortion: dec(c, "manager_liquidation_balance_portion"),
    withdrawWindowS: int(c, "withdraw_window_s"),
    withdrawDurationS: int(c, "withdraw_duration_s"),
  };
}

export function parseVault(x: unknown): PacificaVault {
  if (x === null || typeof x !== "object" || Array.isArray(x)) throw bad("/lake/list row is not an object", x);
  const r = x as Record<string, unknown>;
  const address = str(r, "address");
  if (address === null) throw bad("/lake/list row without an address", r);
  const lpShares = reqDec(r, "lp_shares");
  const managerShares = reqDec(r, "manager_shares");
  const lpBalance = reqDec(r, "lp_balance");
  const managerBalance = reqDec(r, "manager_balance");
  const created = r.created_at;
  return {
    schema: 1,
    address,
    nickname: str(r, "nickname"),
    creator: str(r, "creator"),
    manager: str(r, "manager"),
    referrer: str(r, "referrer"),
    createdAt: typeof created === "number" && created > 0 ? created : null,
    lpShares, managerShares, lpBalance, managerBalance,
    tvl: add(lpBalance, managerBalance),
    equitySnapshot: dec(r, "last_checked_equity"),
    highWatermark: dec(r, "high_watermark"),
    navPerLpShare: divDecimal(lpBalance, lpShares, 12),
    navPerManagerShare: divDecimal(managerBalance, managerShares, 12),
    apy: null,
    config: parseConfig(r.config),
    userShares: dec(r, "user_share"),
  };
}

/** GET /lake/list `data` (`{lakes: [...]}`). */
export function parseVaultList(data: unknown): PacificaVault[] {
  const rows = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).lakes : undefined;
  if (!Array.isArray(rows)) throw bad("/lake/list without a lakes list", data);
  return rows.map(parseVault);
}

type Reader = Pick<PacificaClient, "getEnvelope">;

export async function fetchVaults(client: Reader, account: string | null): Promise<PacificaVault[]> {
  const env = await client.getEnvelope("/lake/list", account !== null ? { account } : {});
  return parseVaultList(envelopeData(env, "/lake/list"));
}

export function findVault(vaults: PacificaVault[], ref: string): PacificaVault {
  const v = vaults.find((x) => x.address === ref) ?? vaults.find((x) => x.nickname !== null && x.nickname.toLowerCase() === ref.toLowerCase());
  if (v === undefined) {
    throw new PerpError("SYMBOL_NOT_FOUND", `No Pacifica vault "${ref}" (address or exact nickname)`, {
      exchange: "pacifica", remediation: "List them: perp -e pacifica vault list",
    });
  }
  return v;
}

export async function fetchDepositWhitelist(client: Reader, vault: string): Promise<string[]> {
  const data = envelopeData(await client.getEnvelope("/lake/get_deposit_whitelist", { lake: vault }), "/lake/get_deposit_whitelist");
  const a = data !== null && typeof data === "object" ? (data as Record<string, unknown>).addresses : undefined;
  if (!Array.isArray(a) || !a.every((s) => typeof s === "string")) throw bad("/lake/get_deposit_whitelist without an addresses list", data);
  return a as string[];
}

// ── Rules ───────────────────────────────────────────────────────────────

export interface WithdrawWindow {
  /** No window configured: always open (subject to the other rules). */
  restricted: boolean;
  open: boolean;
  /** Current window closes (open) or next one opens (closed), ms; null when unrestricted. */
  nextChangeAt: number | null;
}

/** docs: open while current_unix_time_s mod withdraw_window_s < withdraw_duration_s (epoch-anchored). */
export function withdrawWindowAt(c: VaultConfig, nowMs: number): WithdrawWindow {
  if (c.withdrawWindowS === null || c.withdrawDurationS === null || c.withdrawWindowS <= 0) return { restricted: false, open: true, nextChangeAt: null };
  const now = Math.floor(nowMs / 1000);
  const start = now - (now % c.withdrawWindowS);
  const open = now % c.withdrawWindowS < c.withdrawDurationS;
  return { restricted: true, open, nextChangeAt: (open ? start + c.withdrawDurationS : start + c.withdrawWindowS) * 1000 };
}

/** Shares this account holds in the vault: manager shares for the manager, else LP `user_share`. */
export function heldShares(v: PacificaVault, account: string): { role: "manager" | "lp"; shares: string | null; nav: string | null } {
  if (v.manager === account) return { role: "manager", shares: v.managerShares, nav: v.navPerManagerShare };
  return { role: "lp", shares: v.userShares, nav: v.navPerLpShare };
}

export interface VaultDepositPlan {
  schema: 1;
  vault: string;
  nickname: string | null;
  role: "manager" | "lp";
  amount: string;
  /** amount × shares ÷ balance of the class now (the venue mints at the post-sync NAV). */
  estimatedShares: string | null;
  lockMs: number | null;
  warnings: string[];
}

/**
 * Validate a deposit (docs vaults/depositing: min 10 USDC, deposit cap on the LP balance,
 * available_to_withdraw, deposit whitelist). Throws INVALID_PARAMS / INSUFFICIENT_BALANCE / POLICY_DENIED.
 */
export function planVaultDeposit(v: PacificaVault, account: string, amountRaw: string, ctx: { availableToWithdraw: string; whitelist: string[] }): VaultDepositPlan {
  const amount = requireUsdcAmount(amountRaw, "vault deposit");
  const where = `vault ${v.nickname ?? v.address}`;
  if (cmpDecimal(amount, VAULT_MIN_DEPOSIT_USDC) < 0) {
    throw new PerpError("INVALID_PARAMS", `${where}: deposit ${amount} USDC is below the ${VAULT_MIN_DEPOSIT_USDC} USDC minimum`, { exchange: "pacifica", remediation: `Deposit at least ${VAULT_MIN_DEPOSIT_USDC} USDC` });
  }
  const { role } = heldShares(v, account);
  if (role === "lp" && v.config.depositCap !== null && cmpDecimal(add(v.lpBalance, amount), v.config.depositCap) > 0) {
    throw new PerpError("INVALID_PARAMS", `${where}: LP balance ${v.lpBalance} + ${amount} exceeds the deposit cap ${v.config.depositCap} USDC`, {
      exchange: "pacifica", remediation: `Deposit at most ${subDecimal(v.config.depositCap, v.lpBalance)} USDC`,
    });
  }
  if (ctx.whitelist.length > 0 && !ctx.whitelist.includes(account)) {
    throw new PerpError("POLICY_DENIED", `${where} accepts deposits only from its whitelist, which does not include ${account}`, { exchange: "pacifica", remediation: "Ask the vault creator to whitelist the account, or pick another vault" });
  }
  if (cmpDecimal(ctx.availableToWithdraw, amount) < 0) {
    throw new PerpError("INSUFFICIENT_BALANCE", `${where}: deposit ${amount} USDC exceeds available_to_withdraw ${ctx.availableToWithdraw}`, { exchange: "pacifica", remediation: "Deposit less, or free margin first (perp -e pacifica portfolio)" });
  }
  const warnings: string[] = [
    "A vault is a third-party trading pool: you can lose up to the whole deposit (Pacifica does not vet or insure managers).",
  ];
  const lock = v.config.depositMinDurationMs;
  if (lock !== null && lock > 0) warnings.push(`Lock-up: no withdrawal for ${(lock / 3_600_000).toFixed(2)} h after this deposit — and the timer restarts for your WHOLE balance in this vault.`);
  if (v.config.withdrawWindowS !== null && v.config.withdrawDurationS !== null) {
    warnings.push(`Withdrawals open only ${v.config.withdrawDurationS} s out of every ${v.config.withdrawWindowS} s (epoch-anchored window).`);
  }
  if (v.manager === null) warnings.push("The vault has no manager yet (fresh vault): nobody trades it until a manager claims the seat.");
  if (v.config.managerProfitShare !== null) warnings.push(`Manager performance fee: ${v.config.managerProfitShare} of profit above the high-water mark.`);
  return {
    schema: 1, vault: v.address, nickname: v.nickname, role, amount,
    // docs: shares_minted = amount × shares ÷ balance of the class (1:1 when the class is empty)
    estimatedShares: role === "lp"
      ? (cmpDecimal(v.lpShares, "0") === 0 ? amount : divDecimal(mulDecimal(amount, v.lpShares), v.lpBalance, 6))
      : (cmpDecimal(v.managerShares, "0") === 0 ? amount : divDecimal(mulDecimal(amount, v.managerShares), v.managerBalance, 6)),
    lockMs: lock, warnings,
  };
}

export interface VaultWithdrawPlan {
  schema: 1;
  vault: string;
  nickname: string | null;
  role: "manager" | "lp";
  shares: string;
  heldShares: string;
  /** shares × NAV now (the venue pays at the post-sync NAV; may pay partially when the vault is deployed). */
  estimatedAmount: string | null;
  /** Always the account itself — the API has no destination. */
  destination: string;
  window: WithdrawWindow;
  warnings: string[];
}

/** Validate a withdrawal: shares held, withdrawal window. Throws POSITION_NOT_FOUND / INVALID_PARAMS / POLICY_DENIED. */
export function planVaultWithdraw(v: PacificaVault, account: string, sharesRaw: string | "all", ctx: { nowMs: number; vaultAvailableToWithdraw: string | null }): VaultWithdrawPlan {
  const where = `vault ${v.nickname ?? v.address}`;
  const held = heldShares(v, account);
  if (held.shares === null || cmpDecimal(held.shares, "0") <= 0) {
    throw new PerpError("POSITION_NOT_FOUND", `${account} holds no ${held.role} shares in ${where}`, { exchange: "pacifica", remediation: "See your vault positions: perp -e pacifica vault positions" });
  }
  let shares: string;
  if (sharesRaw === "all") shares = held.shares;
  else {
    const s = String(sharesRaw).trim();
    if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) throw new PerpError("INVALID_PARAMS", `shares must be a positive decimal number (got "${sharesRaw}")`, { exchange: "pacifica", remediation: "Pass the shares to redeem, or --all" });
    shares = trimDecimal(s);
  }
  if (cmpDecimal(shares, held.shares) > 0) {
    throw new PerpError("SIZE_TOO_LARGE", `${where}: redeeming ${shares} shares exceeds the ${held.shares} held`, { exchange: "pacifica", remediation: `Redeem at most ${held.shares} (or --all)` });
  }
  const window = withdrawWindowAt(v.config, ctx.nowMs);
  if (!window.open) {
    throw new PerpError("POLICY_DENIED", `${where}: the withdrawal window is closed; it next opens at ${new Date(window.nextChangeAt as number).toISOString()}`, {
      exchange: "pacifica", remediation: "Withdraw while the window is open (perp -e pacifica vault info <vault> shows it)",
    });
  }
  const estimatedAmount = held.nav === null ? null : trimDecimal(mulDecimal(shares, held.nav));
  const warnings: string[] = [];
  const lock = v.config.depositMinDurationMs;
  if (lock !== null && lock > 0) warnings.push(`The venue refuses a withdrawal within ${(lock / 3_600_000).toFixed(2)} h of your most recent deposit into this vault (not checkable here).`);
  if (estimatedAmount !== null && ctx.vaultAvailableToWithdraw !== null && cmpDecimal(estimatedAmount, ctx.vaultAvailableToWithdraw) > 0) {
    warnings.push(`The vault's free balance ${ctx.vaultAvailableToWithdraw} USDC is below the ≈${estimatedAmount} USDC redeemed: the venue may pay only part.`);
  }
  return { schema: 1, vault: v.address, nickname: v.nickname, role: held.role, shares, heldShares: held.shares, estimatedAmount, destination: account, window, warnings };
}

// ── Write requests (pure) ───────────────────────────────────────────────

export function buildVaultDepositRequest(vault: string, amount: string, identity: PresignedIdentity, opts: { timestamp: number; idempotencyKey: string; expiryWindow?: number }): PresignedRequest {
  return buildPresigned({
    type: "deposit_to_lake", path: "/lake/deposit", identity, timestamp: opts.timestamp, expiryWindow: opts.expiryWindow,
    payload: { lake: vault, amount, idempotency_key: opts.idempotencyKey },
  });
}

export function buildVaultWithdrawRequest(vault: string, shares: string, identity: PresignedIdentity, opts: { timestamp: number; idempotencyKey: string; expiryWindow?: number }): PresignedRequest {
  return buildPresigned({
    type: "withdraw_from_lake", path: "/lake/withdraw", identity, timestamp: opts.timestamp, expiryWindow: opts.expiryWindow,
    payload: { lake: vault, shares, idempotency_key: opts.idempotencyKey },
  });
}
