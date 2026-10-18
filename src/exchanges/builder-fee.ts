/**
 * Builder fees — one uniform, default-OFF mechanism for every venue.
 *
 * A builder fee is an extra per-order fee the venue pays to a third-party "builder"
 * (Hyperliquid builder codes, Pacifica builder program, Aster builder, Ondo builder
 * codes). It is charged to the USER, so perp-cli never attaches one unless:
 *   1. `settings.builder.<venue>` is set explicitly by the user (absent = off — there
 *      is no shipped default and no env var), and
 *   2. the venue approval the fee needs is CONFIRMED (venue status read, cached per
 *      process for BUILDER_APPROVAL_TTL_MS; a builder-related order rejection drops the
 *      cached read). Approval-free venues (Ondo) are confirmed by (1) alone.
 * A builder-related order rejection is returned to the caller with remediation
 * (--no-builder / re-approve) and is NEVER retried — re-sending is a new order.
 * An order whose approval is missing / unknown is sent WITHOUT the fee and says so in
 * `execution.notes` (and once on stderr) — the fee is the builder's, never a reason to
 * fail or silently change the user's order. `--no-builder` disables it per command.
 *
 * Per-venue facts (official docs, checked 2026-10-02):
 * - hyperliquid  https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes
 *     ApproveBuilderFee signed by the MAIN wallet (an agent cannot sign it); order action
 *     `builder: { b: <address>, f: <tenths of a bp> }`; max 0.1% perps / 1% spot; status
 *     info `{ type: "maxBuilderFee", user, builder }`. HIP-3 dexes are not covered by the
 *     docs → never attached there.
 * - pacifica     https://docs.pacifica.fi/programs/builder-program.md
 *     approve_builder_code { builder_code, max_fee_rate } signed by the account; per-order
 *     `builder_code` on create_market / create / stop/create / positions/tpsl. TWAP
 *     (create_twap_order) does not document builder_code → never sent there.
 *     The builder sets its own fee_rate; the user's approved max_fee_rate caps it, so the
 *     code is attached only while the approved max_fee_rate ≤ the configured feeBps (the
 *     user's consent). The venue documents no ceiling → perp-cli caps the consent at 10
 *     bps. Spot rejects it (err 108).
 * - aster        https://asterdex.github.io/aster-api-website/asterCode/integration-flow/
 *     + asterdex/api-docs demo/aster-code.py: approveBuilder { builder, maxFeeRate ≤ 0.001 }
 *     master-signed; orders carry `builder` + `feeRate` (decimal) signed by the API wallet;
 *     list GET /fapi/v3/builder, revoke DELETE /fapi/v3/builder (DelBuilder). The testnet
 *     API documents no approveBuilder → testnet off.
 * - ondo         https://docs.ondoperps.xyz/api-reference/integration_guide (+ rest-spec)
 *     no user approval; per-order `builderCode: { code, feeRateBpsFractional }` on
 *     POST /v1/perps/orders and POST /v1/perps/stop_order (stops do NOT inherit it); cap
 *     10 bps; sandbox uses the same API.
 * - qfex         https://docs.qfex.com/qfex/builder-code
 *     fee SHARE, not an extra fee: the trader pays the normal venue fee and the venue credits
 *     part of it to the builder (feeKind "share", feeBps null). No user approval. The code
 *     (UUID) rides on the Trade WebSocket auth (`params.builder_code`) for the life of the
 *     connection — never per order; an unknown code is not an error, so attribution is not
 *     confirmable from the trader side. Prod codes mean nothing on UAT → testnet off.
 * - lighter / lighter-rh: unsupported — see UNSUPPORTED below.
 * - arcus: unsupported — see UNSUPPORTED below.
 */

import { PerpError, classifyError, isDefiniteOrderFailure, isTransportFailure, isUnknownOutcomeServerError } from "../errors.js";
import type { Network, VenueId } from "./venue-types.js";
import { isVenueId } from "./venue-types.js";

// ── Capability (declared per venue in VenueDefinition.builderFee) ──

export type BuilderFeeKind = "exact" | "max" | "share";

export interface BuilderFeeCapability {
  /** "master" = the owner wallet signs a one-time approval; "none" = no approval exists. */
  approval: "master" | "none";
  /** What identifies the builder in settings.builder.<venue>. */
  identity: "address" | "code";
  /** Largest fee (bps) a perp order may carry; null = feeKind "share" (no user-paid fee exists). */
  perpCapBps: number | null;
  /** Largest fee (bps) the venue allows on spot; null = spot does not take a builder fee. Spot orders never carry one in perp-cli. */
  spotCapBps: number | null;
  /** false = HIP-3 dexes never carry the fee (Hyperliquid); null = not applicable. */
  hip3: false | null;
  /** false = the venue's testnet has no builder flow → never attached on testnet. */
  testnet: boolean;
  /** Smallest fee increment (bps) the venue can express; null = feeKind "share". */
  feeStepBps: number | null;
  /**
   * "exact" = the order carries this fee; "max" = the user approves a ceiling, the builder sets
   * the actual rate (Pacifica); "share" = the venue shares its own fee with the builder — the
   * user pays the normal fee and nothing extra (QFEX), so there is no feeBps.
   */
  feeKind: BuilderFeeKind;
  /** Official doc the facts were taken from. */
  docs: string;
}

export const BUILDER_FEE_CAPABILITIES: { readonly [K in VenueId]: BuilderFeeCapability | null } = {
  hyperliquid: {
    approval: "master", identity: "address", perpCapBps: 10, spotCapBps: 100, hip3: false, testnet: true,
    feeStepBps: 0.1, feeKind: "exact", docs: "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes",
  },
  pacifica: {
    approval: "master", identity: "code", perpCapBps: 10, spotCapBps: null, hip3: null, testnet: true,
    feeStepBps: 0.01, feeKind: "max", docs: "https://docs.pacifica.fi/programs/builder-program.md",
  },
  aster: {
    approval: "master", identity: "address", perpCapBps: 10, spotCapBps: null, hip3: null, testnet: false,
    feeStepBps: 0.01, feeKind: "exact", docs: "https://asterdex.github.io/aster-api-website/asterCode/integration-flow/",
  },
  ondo: {
    approval: "none", identity: "code", perpCapBps: 10, spotCapBps: null, hip3: null, testnet: true,
    feeStepBps: 0.01, feeKind: "exact", docs: "https://docs.ondoperps.xyz/api-reference/integration_guide",
  },
  qfex: {
    approval: "none", identity: "code", perpCapBps: null, spotCapBps: null, hip3: null, testnet: false,
    feeStepBps: null, feeKind: "share", docs: "https://docs.qfex.com/qfex/builder-code",
  },
  lighter: null,
  "lighter-rh": null,
  arcus: null,
  risex: null,
  txflow: null,
  variational: null,
};

/** Why a venue has no builder-fee support (shown in CAPABILITY_UNSUPPORTED). */
export const BUILDER_FEE_UNSUPPORTED: { readonly [K in VenueId]?: string } = {
  lighter: "not yet implemented in perp-cli — the official lighter-go signer can sign ApproveIntegrator and the per-order integrator fields, but perp-cli sends them as 0 (https://apidocs.lighter.xyz/docs/partner-integration)",
  "lighter-rh": "not yet implemented in perp-cli — Lighter RH uses the same official lighter-go signer; partner-attribution fields are sent as 0 (https://apidocs.rh.lighter.xyz/docs/partner-attribution.md)",
  risex: "not implemented yet in perp-cli (RISEx builder codes are planned; note the venue's \"bps\" field is parts-per-million)",
  txflow: "TxFlow is integrated through an unofficial read-only API (market data only)",
  variational: "Variational is read-only (market data) in perp-cli; Variational has no public trading API yet",
  arcus: "Arcus has no perps builder fee; its integrator fee applies to the spot router only and needs a partner key from Arcus (https://docs.arcus.xyz/concepts/spot-router)",
};

export function builderFeeUnsupported(venue: VenueId): PerpError {
  return new PerpError("CAPABILITY_UNSUPPORTED", `${venue} does not support builderFee — ${BUILDER_FEE_UNSUPPORTED[venue] ?? "no builder-fee mechanism"}`, {
    venue, feature: "builderFee", reason: BUILDER_FEE_UNSUPPORTED[venue] ?? "no builder-fee mechanism",
    remediation: `Builder fees are available on: ${builderFeeVenues().join(", ")}`,
  });
}

export function builderFeeVenues(): VenueId[] {
  return (Object.keys(BUILDER_FEE_CAPABILITIES) as VenueId[]).filter(v => BUILDER_FEE_CAPABILITIES[v] !== null);
}

/** Capability of a venue, or CAPABILITY_UNSUPPORTED. */
export function requireBuilderCapability(venue: VenueId): BuilderFeeCapability {
  const cap = BUILDER_FEE_CAPABILITIES[venue];
  if (cap === null) throw builderFeeUnsupported(venue);
  return cap;
}

// ── Settings (settings.builder) ──

export interface BuilderAddressEntry { address: string; feeBps: number }
export interface BuilderCodeEntry { code: string; feeBps: number }
/** feeKind "share" (QFEX): attribution only — there is no user-paid fee, so no feeBps key. */
export interface BuilderShareEntry { code: string }

/** settings.builder — absent venue = builder fee off. Ships empty. */
export interface BuilderSettings {
  hyperliquid?: BuilderAddressEntry;
  pacifica?: BuilderCodeEntry;
  aster?: BuilderAddressEntry;
  ondo?: BuilderCodeEntry;
  qfex?: BuilderShareEntry;
}

/** A configured builder, normalized: identity = address (lowercase) or code. */
export interface BuilderTarget {
  venue: VenueId;
  identity: string;
  /** Extra fee charged to the user (bps); null = feeKind "share" (the user pays the normal venue fee only). */
  feeBps: number | null;
}

/** The configured user-paid fee of an "exact" / "max" venue. A "share" target has none. */
export function requireFeeBps(t: { venue: VenueId; feeBps: number | null }): number {
  if (t.feeBps === null) throw new PerpError("INVALID_PARAMS", `${t.venue} builder attribution carries no fee (fee share)`);
  return t.feeBps;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Pacifica: "alphanumeric, max 16 characters" (builder-program docs). */
const PACIFICA_CODE_RE = /^[A-Za-z0-9]{1,16}$/;
/** Ondo documents no format; refuse whitespace / control characters and absurd lengths. */
const ONDO_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** QFEX builder codes are UUIDs (docs builder-code / authenticate). */
const QFEX_CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate one settings.builder.<venue> entry. Throws `invalid(problem)` — never clamps
 * or rewrites a value. Returns the normalized target.
 */
export function parseBuilderEntry(venue: string, raw: unknown, invalid: (problem: string) => Error): BuilderTarget {
  if (!isVenueId(venue)) throw invalid(`builder: unknown venue "${venue}"`);
  const cap = BUILDER_FEE_CAPABILITIES[venue];
  if (cap === null) throw invalid(`builder.${venue}: ${venue} does not support builder fees — ${BUILDER_FEE_UNSUPPORTED[venue] ?? ""}`);
  if (cap.feeKind === "share") {
    // Fee share: the code only. A feeBps key is refused — there is no user-paid fee to configure.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid(`builder.${venue} must be { code: <uuid> } (fee share — no feeBps)`);
    }
    const s = raw as Record<string, unknown>;
    for (const k of Object.keys(s)) {
      if (k !== "code") throw invalid(`builder.${venue}: unknown key "${k}" (expected code only — ${venue} builder codes share the venue fee, the user pays nothing extra)`);
    }
    if (typeof s.code !== "string" || !QFEX_CODE_RE.test(s.code)) {
      throw invalid(`builder.${venue}.code must be a UUID (got ${JSON.stringify(s.code)})`);
    }
    return { venue, identity: s.code.toLowerCase(), feeBps: null };
  }
  if (cap.perpCapBps === null || cap.feeStepBps === null) {
    throw invalid(`builder.${venue}: capability declares no fee cap / increment`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(`builder.${venue} must be { ${cap.identity}: <${cap.identity}>, feeBps: <number> }`);
  }
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) {
    if (k !== cap.identity && k !== "feeBps") throw invalid(`builder.${venue}: unknown key "${k}" (expected ${cap.identity}, feeBps)`);
  }
  const id = e[cap.identity];
  let identity: string;
  if (cap.identity === "address") {
    if (typeof id !== "string" || !ADDRESS_RE.test(id)) throw invalid(`builder.${venue}.address must be a 0x-prefixed 20-byte EVM address (got ${JSON.stringify(id)})`);
    identity = id.toLowerCase();
  } else {
    const re = venue === "pacifica" ? PACIFICA_CODE_RE : ONDO_CODE_RE;
    if (typeof id !== "string" || !re.test(id)) {
      throw invalid(`builder.${venue}.code must match ${re.source} (got ${JSON.stringify(id)})`);
    }
    identity = id;
  }
  const fee = e.feeBps;
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee <= 0) {
    throw invalid(`builder.${venue}.feeBps must be a number of basis points > 0 (got ${JSON.stringify(fee)})`);
  }
  if (fee > cap.perpCapBps) {
    throw invalid(`builder.${venue}.feeBps ${fee} exceeds the ${venue} cap of ${cap.perpCapBps} bps`);
  }
  const steps = fee / cap.feeStepBps;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    throw invalid(`builder.${venue}.feeBps ${fee} is not a multiple of the venue's ${cap.feeStepBps} bps increment`);
  }
  return { venue, identity, feeBps: fee };
}

/** Validate the whole settings.builder object (absent / null = nothing configured). */
export function parseBuilderSettings(raw: unknown, invalid: (problem: string) => Error): BuilderSettings {
  const out: BuilderSettings = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("builder must be an object of { venue: { address|code, feeBps } }");
  for (const [venue, entry] of Object.entries(raw as Record<string, unknown>)) {
    const t = parseBuilderEntry(venue, entry, invalid);
    const cap = BUILDER_FEE_CAPABILITIES[t.venue] as BuilderFeeCapability;
    const stored = entry as Record<string, unknown>;
    (out as Record<string, unknown>)[venue] = cap.feeKind === "share"
      ? { code: stored.code as string }
      : cap.identity === "address"
        ? { address: stored.address as string, feeBps: t.feeBps }
        : { code: stored.code as string, feeBps: t.feeBps };
  }
  return out;
}

/** "2.5 bps", or "fee share (no extra fee)" for a share target. */
export function feeText(t: { feeBps: number | null }): string {
  return t.feeBps === null ? "fee share (no extra fee)" : `${t.feeBps} bps`;
}

/** The configured target for a venue, or null (off). */
export function builderTargetOf(builder: BuilderSettings, venue: VenueId): BuilderTarget | null {
  const entry = (builder as Record<string, unknown>)[venue];
  if (entry === undefined) return null;
  return parseBuilderEntry(venue, entry, p => new PerpError("INVALID_PARAMS", p));
}

// ── Approval + per-order decision ──

export type BuilderApproval =
  /** The venue reports an approval covering the configured fee. maxFeeBps = approved ceiling (null = venue has no approval step). */
  | { status: "approved"; maxFeeBps: number | null }
  /** The venue reports no approval, or one below the configured fee (maxFeeBps = approved ceiling, null = none). */
  | { status: "notApproved"; maxFeeBps: number | null }
  /** feeKind "max": the approved ceiling is ABOVE the configured fee — the builder could charge more than the user configured. */
  | { status: "aboveConsent"; maxFeeBps: number }
  /** The approval could not be determined (request failed / response unreadable). */
  | { status: "unknown"; reason: string };

/** The fee an order actually carried (OrderExecution.builderFee). */
export interface AppliedBuilderFee {
  venue: VenueId;
  /** Builder address (lowercase) or code. */
  identity: string;
  /** Extra fee charged to the user (bps); null = feeKind "share". */
  feeBps: number | null;
  /** "max" = approved ceiling; the builder's own rate applies (Pacifica). "share" = venue fee share, nothing extra. */
  feeKind: BuilderFeeKind;
  /** The ceiling the venue reports as approved (bps); null = the venue has no approval step. */
  approvedMaxBps: number | null;
}

export interface BuilderDecision {
  applied: AppliedBuilderFee | null;
  /** Why a CONFIGURED fee was not attached (null when attached or not configured). */
  note: string | null;
}

export const NO_BUILDER: BuilderDecision = { applied: null, note: null };

/** How long a venue approval read is reused before it is read again. */
export const BUILDER_APPROVAL_TTL_MS = 5 * 60_000;

/** Process-wide approval cache: `${venue}:${network}:${account}:${identity}` → status read + read time. */
const _approvalCache = new Map<string, { read: Promise<BuilderApproval>; at: number }>();
const _warned = new Set<string>();

/** Forget cached approval reads and stderr warnings (after approve / revoke; test hook). */
export function resetBuilderApprovalCache(): void {
  _approvalCache.clear();
  _warned.clear();
}

/** Drop the cached approval reads of one venue + network (the next order re-reads the venue). */
export function invalidateBuilderApproval(venue: VenueId, network: Network): void {
  const prefix = `${venue}:${network}:`;
  for (const k of [..._approvalCache.keys()]) if (k.startsWith(prefix)) _approvalCache.delete(k);
}

/**
 * Per-adapter builder-fee gate. Built only when settings.builder.<venue> is set
 * (resolveBuilderGate) — an unconfigured venue has no gate and no notes at all.
 */
export class BuilderFeeGate {
  constructor(
    readonly target: BuilderTarget,
    readonly network: Network,
    /** Static reason the configured fee is never attached by this adapter (--no-builder, testnet). */
    private readonly skipReason: string | null,
    /** Reads the venue approval for the active account; null when the venue has no approval step. */
    private readonly readApproval: ((target: BuilderTarget) => Promise<BuilderApproval>) | null,
    /** Account the approval belongs to (master address) — part of the cache key. */
    private readonly accountOf: () => string,
  ) {}

  get capability(): BuilderFeeCapability {
    return requireBuilderCapability(this.target.venue);
  }

  /** Venue approval for the configured builder (cached for BUILDER_APPROVAL_TTL_MS). Failures → "unknown". */
  async approval(): Promise<BuilderApproval> {
    if (this.readApproval === null) return { status: "approved", maxFeeBps: null };
    const key = `${this.target.venue}:${this.network}:${this.accountOf().toLowerCase()}:${this.target.identity}`;
    const cached = _approvalCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < BUILDER_APPROVAL_TTL_MS) return cached.read;
    const read = this.readApproval(this.target).then(
      a => a,
      // Recorded, not hidden: the decision carries the reason and the order goes out without the fee.
      (e: unknown): BuilderApproval => ({ status: "unknown", reason: e instanceof Error ? e.message : String(e) }),
    );
    _approvalCache.set(key, { read, at: Date.now() });
    return read;
  }

  /**
   * Whether the next perp order carries the fee. `hip3` = the order is on a Hyperliquid
   * HIP-3 dex. Never throws: a fee that cannot be attached becomes a note.
   */
  async decide(opts: { hip3: boolean }): Promise<BuilderDecision> {
    const t = this.target;
    const cap = this.capability;
    const skip = (why: string): BuilderDecision => this.warnOnce({ applied: null, note: `builder fee not attached: ${why}` });
    if (this.skipReason !== null) return { applied: null, note: `builder fee not attached: ${this.skipReason}` };
    if (opts.hip3 && cap.hip3 === false) return skip("HIP-3 dex orders do not carry builder fees (not covered by the venue docs)");
    const a = await this.approval();
    if (a.status === "unknown") {
      return skip(`${t.venue} approval for ${t.identity} could not be confirmed (${a.reason}) — check: perp${this.network === "testnet" ? " -n testnet" : ""} wallet builder status ${t.venue}`);
    }
    if (a.status === "notApproved") {
      const have = a.maxFeeBps === null ? "none" : `${a.maxFeeBps} bps`;
      return skip(`${t.venue} approval for ${t.identity} missing (approved max: ${have}, configured: ${feeText(t)}) — approve with: perp${this.network === "testnet" ? " -n testnet" : ""} wallet builder approve ${t.venue}`);
    }
    if (a.status === "aboveConsent") {
      return skip(`${t.venue} approved max for ${t.identity} is ${a.maxFeeBps} bps, above the configured ${feeText(t)} — the builder could charge more than you configured; re-approve exactly ${feeText(t)}: perp${this.network === "testnet" ? " -n testnet" : ""} wallet builder approve ${t.venue}`);
    }
    return { applied: { venue: t.venue, identity: t.identity, feeBps: t.feeBps, feeKind: cap.feeKind, approvedMaxBps: a.maxFeeBps }, note: null };
  }

  private warnOnce(d: BuilderDecision): BuilderDecision {
    const key = `${this.target.venue}:${this.network}:${d.note}`;
    if (d.note !== null && !_warned.has(key)) {
      _warned.add(key);
      process.stderr.write(`[warn] ${d.note}\n`);
    }
    return d;
  }
}

/**
 * The gate for an adapter being created, or null when settings.builder.<venue> is not
 * set (default) or the context is read-only. The single place builder settings are
 * resolved (adapters never read settings).
 */
export function resolveBuilderGate(
  venue: VenueId,
  ctx: { network: Network; noBuilder: boolean; readOnly: boolean },
  builder: BuilderSettings,
  readApproval: ((target: BuilderTarget) => Promise<BuilderApproval>) | null,
  accountOf: () => string,
): BuilderFeeGate | null {
  if (ctx.readOnly) return null;
  const target = builderTargetOf(builder, venue);
  if (target === null) return null;
  const cap = requireBuilderCapability(venue);
  let skipReason: string | null = null;
  if (ctx.noBuilder) skipReason = "disabled by --no-builder";
  else if (ctx.network === "testnet" && !cap.testnet) skipReason = `${venue} testnet has no builder-fee flow`;
  return new BuilderFeeGate(target, ctx.network, skipReason, cap.approval === "none" ? null : readApproval, accountOf);
}

/** Gate held by an adapter (public `builderFee` field), or null. */
export function builderGateOf(adapter: unknown): BuilderFeeGate | null {
  const g = (adapter as { builderFee?: unknown } | null)?.builderFee;
  return g instanceof BuilderFeeGate ? g : null;
}

/** Decision for an adapter's next perp order (no gate = not configured = NO_BUILDER). */
export async function builderDecisionOf(adapter: unknown, opts: { hip3: boolean }): Promise<BuilderDecision> {
  const g = builderGateOf(adapter);
  return g === null ? NO_BUILDER : g.decide(opts);
}

// ── Unit conversions (one place) ──

/** Fee rate as a decimal fraction string: 2.5 bps → "0.00025". */
export function bpsToRate(bps: number): string {
  const s = (bps / 10_000).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}

/** Decimal fraction (string | number) → bps, or null when unreadable. */
export function rateToBps(rate: unknown): number | null {
  const n = typeof rate === "number" ? rate : typeof rate === "string" && rate.trim() !== "" ? Number(rate) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10_000 * 1e6) / 1e6 : null;
}

/** Hyperliquid `f` (tenths of a basis point). */
export function hlFeeTenthsBps(bps: number): number {
  return Math.round(bps * 10);
}

/** Hyperliquid ApproveBuilderFee maxFeeRate: a percent string ("0.01%" = 1 bp). */
export function hlMaxFeeRatePercent(bps: number): string {
  return `${bpsToRate(bps * 100)}%`;
}

/** feeKind "exact": approval verdict from the venue's approved ceiling (bps; null = no approval on record). */
export function approvalFromMax(maxFeeBps: number | null, feeBps: number): BuilderApproval {
  // 1e-9 absorbs decimal-string → float conversion; never rounds a smaller approval up.
  if (maxFeeBps !== null && maxFeeBps + 1e-9 >= feeBps) return { status: "approved", maxFeeBps };
  return { status: "notApproved", maxFeeBps };
}

/**
 * feeKind "max" (Pacifica): the builder picks its own rate up to the approved ceiling, so the
 * configured feeBps is the user's consent and the approved ceiling must not exceed it.
 * null = no approval on record.
 */
export function approvalFromCeiling(maxFeeBps: number | null, feeBps: number): BuilderApproval {
  if (maxFeeBps === null) return { status: "notApproved", maxFeeBps: null };
  if (maxFeeBps - 1e-9 <= feeBps) return { status: "approved", maxFeeBps };
  return { status: "aboveConsent", maxFeeBps };
}

/**
 * An order the venue rejected for a builder-related reason (the error text names the builder):
 * the cached approval of that venue is dropped (the next order re-reads it) and the rejection is
 * returned with remediation. The order is NOT retried — re-sending is a new order, so that stays
 * the user's explicit choice. Any other error (or no gate) is returned unchanged.
 */
export function builderRejectionOf(adapter: unknown, err: unknown): unknown {
  const g = builderGateOf(adapter);
  if (g === null) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (!/builder/i.test(msg)) return err;
  // Only a DEFINITE venue rejection is re-described: an unknown outcome (ORDER_PENDING /
  // ORDER_PARTIAL, a transport failure, a 5xx, any non-definite PerpError) keeps its own
  // "do NOT resubmit" remediation — "re-send it without the fee" could double the order.
  if (!isDefiniteBuilderRejection(err)) return err;
  const venue = g.target.venue;
  invalidateBuilderApproval(venue, g.network);
  const n = g.network === "testnet" ? " -n testnet" : "";
  const remediation = `The venue rejected the order over the builder fee; it was NOT retried. Re-send it without the fee (--no-builder), or re-approve: perp${n} wallet builder approve ${venue} (check: perp${n} wallet builder status ${venue})`;
  const e = classifyError(err, venue);
  return new PerpError(e.code, e.message, { ...(e.details ?? {}), exchange: venue, remediation });
}

/**
 * true when `err` proves the order was refused (nothing placed): a PerpError with a definite code
 * (isDefiniteOrderFailure), or a venue 4xx answer (details.httpStatus 4xx, not 429) whose code is
 * not an unknown-outcome code; a plain Error that is neither a transport failure nor a 5xx
 * unknown-outcome message (adapter-level venue refusal text).
 */
function isDefiniteBuilderRejection(err: unknown): boolean {
  if (err instanceof PerpError) {
    const code = err.structured.code;
    if (code === "ORDER_PENDING" || code === "ORDER_PARTIAL") return false;
    if (isDefiniteOrderFailure(err)) return true;
    const http = err.structured.details?.httpStatus;
    return typeof http === "number" && http >= 400 && http < 500 && http !== 429;
  }
  return !isTransportFailure(err) && !isUnknownOutcomeServerError(err);
}

/**
 * Builder decision for a planned perp order on `symbol` (dry-run / preview): the same
 * cached gate decision a live order would use. Hyperliquid resolves the asset id so a
 * HIP-3 market reports "not attached".
 */
export async function builderPlanFor(adapter: unknown, symbol: string | null): Promise<BuilderDecision> {
  if (builderGateOf(adapter) === null) return NO_BUILDER;
  const hl = adapter as { name?: unknown; builderDecision?: unknown; getAssetIndex?: unknown };
  if (hl.name === "hyperliquid" && typeof hl.builderDecision === "function" && typeof hl.getAssetIndex === "function") {
    const idx = symbol === null ? null : await (hl.getAssetIndex as (s: string) => Promise<number>).call(adapter, symbol.toUpperCase());
    return (hl.builderDecision as (i: number | null) => Promise<BuilderDecision>).call(adapter, idx);
  }
  return builderDecisionOf(adapter, { hip3: false });
}
