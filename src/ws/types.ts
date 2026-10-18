/**
 * perp-cli/ws public types (plan ws-0.14.4 §4). @experimental through 0.15.x (stable from 0.16.0 after consumer sign-off): breaking changes
 * only in a minor bump; every event carries `schema: 1`.
 *
 * Null rules (§3): unknown = null. A field the venue never sent is null; a field the latest frame
 * did not carry keeps its last value with a per-field `asOf`. `Dec` = the venue's JSON value as a
 * string (a JSON string verbatim, a JSON number via String(value) — precision bounded by JSON
 * parsing). The one documented exception is Lighter's WS funding, sent in PERCENT per hour and
 * converted to a fraction by an exact decimal shift (no float).
 */

import type { Network, VenueId } from "./ids.js";
import type { WsErrorCode } from "./errors.js";

export type { Network, VenueId } from "./ids.js";
export type Dec = string;

// ── Transport / fetch (injectable; resolved lazily inside createVenueStream) ──

export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string; wasClean?: boolean }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ── Connection state ──

export interface CloseReason {
  code: WsErrorCode | "CLIENT_CLOSE";
  message: string; // redacted
  wsCode: number | null;
  remediation: string | null;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  /** Several sockets (Pacifica): `sockets` live ones; `pending` = sockets still opening for the first time
   * (just added, waiting on the new-connection budget, or retrying a failed first handshake) — their subscriptions are not ready yet. */
  | { status: "live"; since: number; sockets: number; pending?: number }
  | { status: "stale"; since: number; silentMs: number; channel: string | null }
  | { status: "reconnecting"; attempt: number; inMs: number; reason: CloseReason }
  | { status: "closed"; reason: CloseReason };

// ── Canonicalization ──

export type Canonicalize = (
  venue: VenueId,
  m: { venueSymbol: string; dex: string | null; base: string; quote: string | null },
) => string | null;

// ── Events ──

export type Source = "ws" | "snapshot" | `rest:${string}` | "venue-definition";
export type RateKind = "lastSettled" | "accruing" | "predicted";

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface MarketDirectoryEntry {
  venue: VenueId;
  dex: string | null;
  symbol: string;
  venueSymbol: string;
  base: string;
  quote: string | null;
  canonical: string | null;
  rateIntervalHours: number | null;
  settlementIntervalHours: number | null;
  source: Source;
}

export type MarketField =
  | "mark" | "index" | "bestBid" | "bestAsk" | "last"
  | "rate" | "predictedRate" | "nextFundingTime" | "fundingInterval"
  | "openInterest" | "volume24hNotional";

export interface FundingState {
  rate: Dec | null;
  rateKind: RateKind | null;
  rateSource: Source | null;
  rateIntervalHours: number | null;
  settlementIntervalHours: number | null;
  intervalSource: Source | null;
  nextFundingTime: number | null;
  /** Always kind "predicted". */
  predictedRate: Dec | null;
  /** QFEX out of hours → rate null + true. null when the venue has no such concept. */
  marketClosed: boolean | null;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface MarketUpdate {
  type: "market";
  schema: 1;
  venue: VenueId;
  dex: string | null;
  symbol: string;
  venueSymbol: string;
  quote: string | null;
  canonical: string | null;
  mark: Dec | null;
  index: Dec | null;
  bestBid: Dec | null;
  bestAsk: Dec | null;
  last: Dec | null;
  funding: FundingState;
  openInterest: { value: Dec | null; unit: "base" | "usd" | null; sides: "one" | "both" | null };
  volume24hNotional: Dec | null;
  venueTs: number | null;
  recvTs: number;
  source: Source;
  changed: ReadonlyArray<MarketField>;
  asOf: Partial<Record<MarketField, number>>;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface BboUpdate {
  type: "bbo"; schema: 1; venue: VenueId; dex: string | null; symbol: string;
  bid: Dec | null; bidSize: Dec | null; ask: Dec | null; askSize: Dec | null; venueTs: number | null; recvTs: number;
}
export interface BookUpdate {
  type: "book"; schema: 1; venue: VenueId; symbol: string; bids: [Dec, Dec][]; asks: [Dec, Dec][];
  seq: string | null; venueTs: number | null; recvTs: number; source: Source; depth: number;
}
export interface TradeUpdate {
  type: "trade"; schema: 1; venue: VenueId; symbol: string; price: Dec; size: Dec;
  side: "buy" | "sell" | null; tradeId: string | null; venueTs: number | null; recvTs: number;
}

// ── Private (user) channels ──

export type UserChannel = "account" | "positions" | "orders" | "fills";

export interface PositionRow {
  symbol: string;
  dex: string | null;
  side: "long" | "short" | null;
  /** Absolute size in base units. */
  size: Dec | null;
  entryPrice: Dec | null;
  /** Mark price is not part of every venue's position stream; join MarketUpdate by symbol. */
  markPrice: Dec | null;
  positionValue: Dec | null;
  unrealizedPnl: Dec | null;
  liquidationPrice: Dec | null;
  marginUsed: Dec | null;
  leverage: Dec | null;
  venueTs: number | null;
}

export interface OrderRow {
  orderId: string;
  clientId: string | null;
  symbol: string;
  dex: string | null;
  side: "buy" | "sell" | null;
  type: string | null;
  /** Venue status string, verbatim. */
  status: string | null;
  price: Dec | null;
  size: Dec | null;
  filled: Dec | null;
  remaining: Dec | null;
  reduceOnly: boolean | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface FillRow {
  /** Venue fill key (HL tid, Pacifica h:i, Lighter trade_id, Arcus tradeId). With `side` and `orderId` it is the dedupe key. */
  fillId: string;
  /** The client order id of the filled order when the fill frame carries it (see the capability notes per venue). */
  clientId: string | null;
  symbol: string;
  dex: string | null;
  side: "buy" | "sell" | null;
  price: Dec | null;
  size: Dec | null;
  /** Fee amount in `feeToken` (negative = rebate). */
  fee: Dec | null;
  feeToken: string | null;
  closedPnl: Dec | null;
  orderId: string | null;
  liquidity: "maker" | "taker" | null;
  time: number | null;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export type UserUpdate =
  | {
    type: "account"; schema: 1; venue: VenueId;
    /** HL: one account per perp dex ("" native → null); other venues null. */
    dex: string | null;
    equity: Dec | null; available: Dec | null; marginUsed: Dec | null; unrealizedPnl: Dec | null;
    venueTs: number | null; source: Source; recvTs: number;
  }
  /** The full current position set (snapshot + merged deltas). snapshot = it came from (or coalesced) a venue snapshot. */
  | { type: "positions"; schema: 1; venue: VenueId; snapshot: boolean; positions: PositionRow[]; source: Source; recvTs: number }
  /**
   * The current OPEN order set (snapshot + merged deltas). `complete`: the set is known to be every open
   * order — true once the venue sent a snapshot for every part of it; false for venues without an
   * order snapshot (Pacifica: refetch over REST; the library cannot be told) and after a refetch gap.
   */
  | { type: "orders"; schema: 1; venue: VenueId; snapshot: boolean; complete: boolean; orders: OrderRow[]; source: Source; recvTs: number }
  /** One live fill (de-duplicated in-library). */
  | { type: "fill"; schema: 1; venue: VenueId; snapshot: false; fillId: string; fill: FillRow; source: Source; recvTs: number }
  /**
   * A venue fill SNAPSHOT (HL / Arcus replay recent fills on every (re)subscribe; up to 2000 on HL) as ONE
   * event: only fills not seen before, oldest venue order preserved. Never split, so it cannot overflow
   * a subscription buffer. Empty snapshots (everything already seen) are not emitted.
   */
  | { type: "fills"; schema: 1; venue: VenueId; snapshot: true; fills: FillRow[]; source: Source; recvTs: number };

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export type UserRef =
  | { venue: "hyperliquid"; address: `0x${string}` }
  | { venue: "pacifica"; account: string }
  | { venue: "lighter" | "lighter-rh"; accountIndex: number }
  /** KNOWN GAP in 0.15.0: Aster user channels are not implemented (CAPABILITY_UNSUPPORTED); 0.15.1. */
  | { venue: "aster"; user: `0x${string}`; signer: `0x${string}` }
  /** subaccount null = the venue default account (0). */
  | { venue: "arcus"; address: `0x${string}`; subaccount: number | null }
  | { venue: "ondo"; keyId: string }
  | { venue: "qfex"; publicKey: string; accountId: string };

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Async credentials; the library never holds keys (only short-lived tokens it is handed).
 * @experimental 0.15.x (stable from 0.16.0 after consumer sign-off)
 */
export interface CredentialProvider {
  user(): Promise<UserRef>;
  /** Ondo login, QFEX auth (secret stays with the provider). Lowercase hex. */
  hmacSha256?(message: string): Promise<string>;
  /** Aster V3 USER_STREAM (API-wallet signer). */
  signTypedData?(td: TypedData): Promise<`0x${string}`>;
  /** Lighter auth token (a read-only `ro:` token is recommended in browsers). Re-called at 80 % of its TTL. */
  authToken?(req: { purpose: string; maxTtlSec: number }): Promise<{ token: string; expiresAt: number }>;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export type StreamControl =
  | { type: "state"; venue: VenueId; state: ConnectionState }
  | {
    type: "gap"; venue: VenueId; channel: string; symbol: string | null;
    expected: string | null; got: string | null; action: "resnapshot" | "refetch-required";
  }
  | {
    type: "error"; venue: VenueId; code: WsErrorCode; message: string; remediation: string | null;
    /** Redacted excerpt (≤ 200 chars) of the offending frame, or null. */
    raw: string | null;
    fatal: boolean;
    /** Structured context, when the code has any (e.g. SYMBOL_NOT_FOUND: the missing canonicals). */
    details?: StreamErrorDetails;
  };

/**
 * `details` of a `{ type: "error" }` control. SYMBOL_NOT_FOUND (non-fatal, kind:"allMarkets" with
 * `canonicals`): `missing` = requested canonicals with no market on this venue (the others are
 * subscribed); `suggestions` = per missing canonical, close directory canonicals (may be empty).
 */
export interface StreamErrorDetails {
  missing?: string[];
  suggestions?: Record<string, string[]>;
}

export interface StreamLog {
  ts: number;
  venue: VenueId;
  level: "info" | "warn" | "error";
  event: string;
  message: string; // redacted
  details?: Record<string, unknown>;
}

// ── Capability matrix (static, §6) ──

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface VenueWsCapabilities {
  /** true = works from a browser page (Origin/CORS checked, Phase 0); "in-page-secrets" = needs allowInPageSecrets. */
  browser: boolean | "in-page-secrets";
  networks: Record<Network, boolean>;
  channels: { allMarkets: boolean; market: boolean; bbo: boolean; book: boolean; trades: boolean; user: boolean };
  /** Market fields this venue publishes over WS (or via a labelled REST source). false → always null. */
  fields: Record<Exclude<MarketField, "rate">, boolean>;
  /** Why a field or channel is null / unsupported. */
  notes: Record<string, string>;
}

// ── Stream ──

/**
 * All-market state, optionally narrowed (pass at most one of the two filters). With `canonicals`,
 * the ones this venue lists are subscribed and the rest are reported once as a non-fatal
 * `{ type: "error", code: "SYMBOL_NOT_FOUND", fatal: false, details: { missing, suggestions } }`;
 * only when none exist does `ready` reject INVALID_PARAMS.
 * - `symbols`: this venue's DIRECTORY symbols, exact and case-sensitive (`BTC` on hyperliquid, `BTCUSDT`
 *   on aster, `BTC-USD` on arcus) — see stream.markets();
 * - `canonicals`: canonical names (`"BTC"`, HIP-3 `"xyz:TSLA"`) → every directory market whose canonical
 *   (opts.canonicalize, default USD-like quotes collapse) matches, e.g. aster BTCUSDT + BTCUSD1. Use it
 *   for the same subscription on several venues.
 */
export interface AllMarketsTarget {
  kind: "allMarkets";
  symbols?: string[];
  canonicals?: string[];
}

export type MarketTarget =
  | AllMarketsTarget
  | { kind: "user"; channels: UserChannel[] }
  | { kind: "market"; symbol: string; channels: Array<"market" | "bbo" | "book" | "trades"> };

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface VenueStreamOptions {
  network?: Network;
  /** hyperliquid: HIP-3 dexes to include. Default [] = native only. */
  hip3Dexes?: string[] | "all";
  /** Default: globalThis.WebSocket, resolved at call time (perp-cli/ws/node supplies `ws`). */
  transport?: WsFactory;
  /** Default: globalThis.fetch, resolved at call time. */
  fetch?: FetchLike;
  canonicalize?: Canonicalize;
  /** Needed for kind:"user". */
  credentials?: CredentialProvider;
  /** Default false. Required for user channels whose auth needs a signing secret in the page (Aster/Ondo/QFEX, 0.15.1). */
  allowInPageSecrets?: boolean;
  /** ≤ venue limits. */
  budget?: { maxSubscriptions?: number; maxSockets?: number; newConnectionsPerMin?: number };
  /** Overrides the per-venue default for every public channel. */
  staleAfterMs?: number;
  /** Default: document.visibilityState when present, else none. */
  visibility?: { hidden(): boolean; onChange(cb: () => void): () => void } | null;
  /** Default { maxAttempts: null, baseMs: 1000, maxMs: 30000 }. */
  reconnect?: { maxAttempts: number | null; baseMs: number; maxMs: number };
  /** Async-iterator buffer per subscription (default 1024). */
  buffer?: { size: number };
  /** Receives redacted entries only. */
  logger?: (e: StreamLog) => void;
  clock?: () => number;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface Subscription<E> extends AsyncIterable<E | StreamControl> {
  /** Unbuffered callback. Returns an unsubscribe-from-callback function. */
  on(cb: (e: E | StreamControl) => void): () => void;
  readonly status: "pending" | "active" | "rejected" | "closed";
  /** Resolves once every wire channel is acknowledged; rejects with a WsError. */
  readonly ready: Promise<void>;
  /** The wire unsubscribe is sent only when the ref-count reaches 0. */
  unsubscribe(): Promise<void>;
}

export interface VenueStream {
  readonly venue: VenueId;
  readonly network: Network;
  readonly state: ConnectionState;
  readonly capabilities: VenueWsCapabilities;
  subscribe(t: AllMarketsTarget): Subscription<MarketUpdate>;
  subscribe(t: { kind: "market"; symbol: string; channels: Array<"market" | "bbo" | "book" | "trades"> }): Subscription<MarketUpdate | BboUpdate | BookUpdate | TradeUpdate>;
  subscribe(t: { kind: "user"; channels: UserChannel[] }): Subscription<UserUpdate>;
  onState(cb: (s: ConnectionState) => void): () => void;
  /** The market directory (REST bootstrap, loaded once). */
  markets(): Promise<MarketDirectoryEntry[]>;
  /** Venue `staleAfterMs` of the all-market channel (used by the funding comparator). */
  readonly staleAfterMs: number;
  close(): Promise<void>;
}

// ── Codec contract (pure; one per venue) ──

/** A wire subscription (one venue channel). `key` is unique per venue. */
export interface WireSub {
  key: string;
  /** Silence beyond this → `stale`; 2× → forced reconnect. null = no stale check. */
  staleAfterMs: number | null;
  params: Record<string, unknown>;
  /** Needs an auth token from CredentialProvider.authToken (sent with the subscribe). */
  auth?: { purpose: string; maxTtlSec: number };
  /** Per-socket channel group for venue caps (limits.perGroup), e.g. Pacifica "bbo" ≤ 20. */
  group?: string;
  /** Non-replayable channels: gap{action:"refetch-required"} after a reconnect / at subscribe. */
  gaps?: { onReconnect?: Array<"fills" | "orders">; onSubscribe?: Array<"orders"> };
}

/** A user-state change decoded from one frame. `scope` partitions snapshots (HL: per dex). */
export type UserDelta =
  | { kind: "account"; snapshot: boolean; dex: string | null; equity?: Dec | null; available?: Dec | null; marginUsed?: Dec | null; unrealizedPnl?: Dec | null; venueTs: number | null }
  /** snapshot: replace every row in `scope`; else upsert rows and remove `remove` keys (symbol). */
  | { kind: "positions"; snapshot: boolean; scope: string; rows: PositionRow[]; remove: string[] }
  /** snapshot: replace every open order in `scope`; else upsert rows and remove `remove` order ids. */
  | { kind: "orders"; snapshot: boolean; scope: string; rows: OrderRow[]; remove: string[] }
  | { kind: "fills"; snapshot: boolean; fills: FillRow[] };

/** A partial market patch: a key present = the frame carried it (its value may be null). */
export interface MarketPatch {
  symbol: string;
  venueTs: number | null;
  mark?: Dec | null;
  index?: Dec | null;
  bestBid?: Dec | null;
  bestAsk?: Dec | null;
  last?: Dec | null;
  rate?: Dec | null;
  predictedRate?: Dec | null;
  nextFundingTime?: number | null;
  openInterest?: Dec | null;
  volume24hNotional?: Dec | null;
}

export type DecodedEvent =
  | { t: "market"; wire: string; patches: MarketPatch[] }
  /** seq: a venue ordering number for the wire's snapshots (frames below the last seen are stale and dropped; equal is applied). */
  | { t: "user"; wire: string; deltas: UserDelta[]; seq?: number | null }
  /** seq: a venue ordering number (only drops out-of-order/duplicate frames; never a gap signal). */
  | { t: "bbo"; wire: string; symbol: string; seq: number | null; bid: Dec | null; bidSize: Dec | null; ask: Dec | null; askSize: Dec | null; venueTs: number | null }
  | { t: "ack"; wire: string | null; reqId: number | null; unsubscribe: boolean }
  | { t: "pong" }
  /** An allowlisted, documented control frame with nothing to do (e.g. "connected"). */
  | { t: "ignore"; what: string }
  | {
    t: "error"; code: WsErrorCode; message: string; wire: string | null; fatal: boolean; remediation: string | null;
    /** The request id the error answers (venues that echo it, e.g. Aster). */
    reqId?: number;
  };

export interface CodecDirectory {
  entries: MarketDirectoryEntry[];
  /** Codec-private lookup data (e.g. HL positional universes, Lighter market ids). */
  data: unknown;
  /** Non-fatal problems in the bootstrap responses (e.g. malformed rows), surfaced as error events. */
  warnings?: string[];
}

export interface CodecContext {
  network: Network;
  fetch: FetchLike;
  restUrl: string;
  hip3Dexes: string[] | "all";
  canonicalize: Canonicalize;
  clock: () => number;
}

/** Per-symbol funding metadata a codec attaches (static or from a labelled REST source). */
export interface FundingMeta {
  rateKind: RateKind | null;
  rateSource: Source | null;
  rateIntervalHours: number | null;
  settlementIntervalHours: number | null;
  intervalSource: Source | null;
  /** When a labelled REST interval was fetched; null for a static (venue-definition) interval. */
  intervalAsOf: number | null;
  marketClosed: boolean | null;
}

export interface LabelledRefresh {
  /** e.g. "rest:/fapi/v3/fundingInfo" */
  source: `rest:${string}`;
  everyMs: number;
  /** Re-fetch and apply into the codec's directory data; throws WsError on failure; resolves to warnings. */
  run(ctx: CodecContext, dir: CodecDirectory): Promise<string[]>;
}

/** @experimental 0.15.x (stable from 0.16.0 after consumer sign-off) */
export interface VenueCodec {
  readonly venue: VenueId;
  readonly capabilities: VenueWsCapabilities;
  /** Wire URL, or null (network unsupported → CAPABILITY_UNSUPPORTED). */
  url(network: Network): string | null;
  restUrl(network: Network): string | null;
  /** Redaction: secret JSON keys and URL path/query patterns. */
  readonly secretKeys: readonly string[];
  readonly secretUrlPatterns: readonly RegExp[];
  /** App-level ping, or null (server protocol pings only). */
  readonly ping: { message: string; everyMs: number } | null;
  /** Venue limits. */
  readonly limits: {
    subscriptionsPerSocket: number;
    newConnectionsPerMin: number;
    outboundPerMin: number;
    /** Per-socket caps per WireSub.group. */
    perGroup?: Record<string, number>;
    /** Sockets one stream may open to spread channels over the per-socket caps. Absent = 1 (the
     * venue's limits are per IP, so extra sockets would not add room). */
    maxSockets?: number;
  };
  /** true → the venue drops the socket (no error frame) on an invalid subscribe (HL). */
  readonly closesOnBadSubscribe: boolean;
  readonly staleAfterMs: number;
  readonly openInterest: { unit: "base" | "usd" | null; sides: "one" | "both" | null };
  loadDirectory(ctx: CodecContext): Promise<CodecDirectory>;
  readonly refresh: LabelledRefresh | null;
  fundingMeta(entry: MarketDirectoryEntry, dir: CodecDirectory): FundingMeta;
  /** Wire channels for a target; throws WsError(INVALID_PARAMS / CAPABILITY_UNSUPPORTED). */
  wiresFor(target: Exclude<MarketTarget, { kind: "user" }>, dir: CodecDirectory, staleOverrideMs: number | null): WireSub[];
  /** User channels, or null when this release does not support them (→ CAPABILITY_UNSUPPORTED). */
  readonly user: {
    /** Auth needs a signing secret in the page (gated by allowInPageSecrets in browsers). */
    inPageSecrets: boolean;
    wires(ref: UserRef, channels: UserChannel[], dir: CodecDirectory): WireSub[];
  } | null;
  /** `auth`: the token for a WireSub with `auth`, else null. */
  encodeSubscribe(w: WireSub, reqId: number, auth: string | null): string;
  encodeUnsubscribe(w: WireSub, reqId: number): string;
  /** Pure decode of one text frame. Throws nothing: problems are `error` events. */
  decode(text: string, dir: CodecDirectory, recvTs: number): DecodedEvent[];
}
