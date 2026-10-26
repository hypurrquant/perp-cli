#!/usr/bin/env -S npx tsx
/**
 * perp E2E runner — deposit → trading → withdraw per venue, testnet first, then
 * tiny real-money runs.
 *
 *   pnpm e2e -- --venue <id> --network testnet|mainnet
 *               --phase preflight|trade|spot|deposit|withdraw|all (comma list ok)
 *               [--max-usd N] [--confirm-real-money] [--operator-authorized <id>] [--yes-testnet] [--dry-run] [--symbol SYM]
 *
 * Drives the BUILT CLI (`node dist/index.js --json …`) one step at a time, parses the
 * JSON envelope + exit code, asserts the expected outcome and stops on the first
 * unexpected result. ORDER_PENDING / finality "pending" / a timed-out write stops the
 * run immediately — the runner NEVER retries or resubmits an order.
 *
 * --dry-run: public endpoints only (markets, minimum sizes, network availability);
 * prints the planned commands, sends nothing, needs no keys.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLI_ENTRY, KILL_FILE, REPO_ROOT, ask, ceilToStep, confirmYesNo, decimalsOf, displayCommand, floorToStep, hlPrice,
  isInteractive, killSwitchActive, roundToTick, runCli, writeReport,
  isBookRejection, isDefiniteRejection, openExposureUsd, pickSpotMarketWithBook, pollUntil, spotAcquiredUsd, spotBuyLanded, spotHoldingOf, spotRefPriceProblem, unknownWriteOutcome, planSpotFunding, projectedExposureUsd, type SpotFundingPlan,
  depositWalletProblem, fundingAmountProblem, lighterAssetMinimums, mainnetStartGate, spotQuoteNeed, unitsFromHex, SPOT_FEE_ALLOWANCE, MIN_ORDER_USD,
  type CliResult, type SpotBook, type SpotCandidate, type Envelope, type RunReport, type StepRecord,
} from "./lib.js";
import { DESIGN_ITEMS, E2E_VENUES, PROFILES, isE2eVenue, type DepositWallet, type E2eVenue, type FundingRoute, type Net } from "./venues.js";

// ── Options ────────────────────────────────────────────────────────────────

const PHASES = ["preflight", "trade", "spot", "deposit", "withdraw"] as const;
type Phase = (typeof PHASES)[number];

/** User decision: real-money cap per venue. Higher needs an explicit --max-usd AND an interactive confirmation. */
// Peak open exposure of a run is under 2 orders (+ slippage): with the $15 order floor (MIN_ORDER_USD)
// a $30 cap runs every step at the floor; a lower cap skips the steps that would exceed it.
const MAINNET_DEFAULT_MAX_USD = 30;
const TESTNET_DEFAULT_MAX_USD = 100;

interface Opts {
  venue: E2eVenue;
  network: Net;
  phases: Phase[];
  maxUsd: number;
  maxUsdExplicit: boolean;
  confirmRealMoney: boolean;
  /** `--operator-authorized <venue-id>`: delegated non-interactive mainnet run (must equal --venue). */
  operatorAuthorized: string | null;
  yesTestnet: boolean;
  dryRun: boolean;
  symbol: string | null;
  dex: string | null;
  leverage: number;
  isolated: boolean;
  farPct: number;
  marginPct: number;
  /** Smallest order notional (USD): every perp / spot order is sized to at least this (default MIN_ORDER_USD). */
  minUsd: number;
  slippageBps: number;
  spotSymbol: string | null;
  spotSize: string | null;
  spotRefPrice: number | null;
  spotLimitPrice: string | null;
  depositAmount: string | null;
  withdrawAmount: string | null;
  allowOnchainApprove: boolean;
  pollTimeoutSec: number;
  wallet: string | null;
  paceMs: number;
  /** HIP-3 dex run as the second leg of a hyperliquid run; null = no HIP-3 leg. */
  hip3Dex: string | null;
  hip3Symbol: string | null;
}

const USAGE = `Usage: pnpm e2e -- --venue <${E2E_VENUES.join("|")}> --network <testnet|mainnet>
  --phase <preflight|trade|spot|deposit|withdraw|all>[,...]   (default: preflight)
  [--dry-run]                 public preflight + planned commands only (sends nothing, no keys)
  [--max-usd N]               worst-case open notional cap per step (mainnet default ${MAINNET_DEFAULT_MAX_USD}, testnet ${TESTNET_DEFAULT_MAX_USD})
  [--confirm-real-money]      required for any mainnet run that is not --dry-run (plus a typed confirmation)
  [--operator-authorized ID]  mainnet, with --confirm-real-money: ID must equal --venue; replaces the typed venue-name
                              confirmation (no TTY needed). Cap stays $${MAINNET_DEFAULT_MAX_USD} (raising it still needs a TTY);
                              deposit / withdraw / approve prompts are auto-confirmed and recorded in the report
  [--yes-testnet]             testnet only: no prompts (deposit/withdraw/approve steps auto-confirmed)
  [--symbol SYM] [--leverage N=2] [--isolated] [--far-pct 5] [--min-usd 15] [--margin-pct 10] [--slippage-bps 100]
  [--spot-symbol SYM --spot-size N [--spot-ref-price P] [--spot-limit-price P]] [--allow-onchain-approve]
  [--deposit-amount N] [--withdraw-amount N] [--poll-timeout-sec 900] [--wallet NAME] [--pace-ms N]
hyperliquid only: the HIP-3 dex runs as a second leg (preflight + trade, steps hip3-*) after the core dex passes
  [--dex NAME=xyz] [--hip3-symbol SYM] [--no-hip3]
Kill switch: touch ${KILL_FILE}  (runner refuses to start / stops before the next step)`;

export function parseArgs(argv: string[]): Opts {
  const args = argv[0] === "--" ? argv.slice(1) : argv.filter((a, i) => !(a === "--" && i === 0));
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (!a.startsWith("--")) throw new Error(`Unexpected argument "${a}"\n${USAGE}`);
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) { flags.set(k, inline); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(k, next); i++; } else flags.set(k, true);
  }
  const str = (k: string): string | null => { const v = flags.get(k); return typeof v === "string" ? v : null; };
  const num = (k: string, d: number): number => {
    const v = str(k);
    if (v === null) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number (got "${v}")`);
    return n;
  };
  if (flags.has("help")) { console.log(USAGE); process.exit(0); }
  const known = new Set(["venue", "network", "phase", "max-usd", "confirm-real-money", "operator-authorized", "yes-testnet", "dry-run", "symbol", "dex", "leverage", "isolated",
    "far-pct", "min-usd", "margin-pct", "slippage-bps", "spot-symbol", "spot-size", "spot-ref-price", "spot-limit-price", "deposit-amount", "withdraw-amount",
    "allow-onchain-approve", "poll-timeout-sec", "wallet", "pace-ms", "hip3-symbol", "no-hip3", "help"]);
  for (const k of flags.keys()) if (!known.has(k)) throw new Error(`Unknown option --${k}\n${USAGE}`);

  const venue = str("venue");
  if (venue === null || !isE2eVenue(venue)) throw new Error(`--venue must be one of ${E2E_VENUES.join(", ")}\n${USAGE}`);
  const network = str("network");
  if (network !== "testnet" && network !== "mainnet") throw new Error(`--network must be testnet or mainnet\n${USAGE}`);
  const phaseArg = (str("phase") ?? "preflight").split(",").map(s => s.trim());
  const phases: Phase[] = phaseArg.includes("all") ? [...PHASES] : phaseArg.map(p => {
    if (!(PHASES as readonly string[]).includes(p)) throw new Error(`Unknown phase "${p}"\n${USAGE}`);
    return p as Phase;
  });
  if (!phases.includes("preflight")) phases.unshift("preflight");
  const maxUsdExplicit = str("max-usd") !== null;
  const yesTestnet = flags.has("yes-testnet");
  if (yesTestnet && network !== "testnet") throw new Error("--yes-testnet is only valid with --network testnet");
  if (flags.has("operator-authorized")) {
    if (str("operator-authorized") === null) throw new Error("--operator-authorized needs the venue id (it must equal --venue)");
    if (network !== "mainnet") throw new Error("--operator-authorized is only valid with --network mainnet");
  }
  const profile = PROFILES[venue];
  if (profile.hip3 === null) {
    for (const k of ["dex", "hip3-symbol", "no-hip3"]) if (flags.has(k)) throw new Error(`--${k} is only valid with --venue hyperliquid (HIP-3 leg)`);
  }
  return {
    venue, network, phases,
    maxUsd: num("max-usd", network === "mainnet" ? MAINNET_DEFAULT_MAX_USD : TESTNET_DEFAULT_MAX_USD),
    maxUsdExplicit,
    confirmRealMoney: flags.has("confirm-real-money"),
    operatorAuthorized: str("operator-authorized"),
    yesTestnet,
    dryRun: flags.has("dry-run"),
    symbol: str("symbol")?.toUpperCase() ?? null,
    dex: null,
    leverage: num("leverage", 2),
    isolated: flags.has("isolated"),
    farPct: num("far-pct", 5),
    marginPct: num("margin-pct", 10),
    minUsd: num("min-usd", MIN_ORDER_USD),
    slippageBps: num("slippage-bps", 100),
    spotSymbol: str("spot-symbol")?.toUpperCase() ?? null,
    spotSize: str("spot-size"),
    spotRefPrice: str("spot-ref-price") !== null ? num("spot-ref-price", 0) : null,
    spotLimitPrice: str("spot-limit-price"),
    depositAmount: str("deposit-amount"),
    withdrawAmount: str("withdraw-amount"),
    allowOnchainApprove: flags.has("allow-onchain-approve"),
    pollTimeoutSec: num("poll-timeout-sec", 900),
    wallet: str("wallet"),
    paceMs: num("pace-ms", venue === "lighter-rh" || venue === "lighter" ? 3000 : 800),
    hip3Dex: profile.hip3 === null || flags.has("no-hip3") ? null : str("dex") ?? profile.hip3.dex,
    hip3Symbol: str("hip3-symbol")?.toUpperCase() ?? null,
  };
}

// ── Built venue definitions (dist) ─────────────────────────────────────────

interface DistMarket {
  symbol: string; markPrice: string; tickSize: string | null; stepSize: string | null;
  minSize: string | null; minNotional: string | null; maxLeverage: number | null; tradable: boolean;
}
interface DistFunding { symbol: string; fundingRate?: string | null; rate?: string | null; [k: string]: unknown }
interface DistVenueDef {
  id: string;
  displayName: string;
  networks: Record<Net, { restUrl: string; collateral: string[]; settlementChain: string; signingChainId: number | null; collateralAssetIndex: number | null; rpcUrl: string | null; depositPins: { token: string } | null }>;
  fundingRateBasis: unknown;
  capabilities: { timeInForce: string[]; tpsl: string; amend: string; orderAck: string; marketOrder: string; marginModes: string[]; withdrawAssets: string[] | null };
  spot: { accountModel: string; quoteAssets: Record<Net, string[]>; capabilities: { limitOrder: boolean; orderbook: boolean; cancel: boolean; transfer: boolean } } | null;
  publicData: { fetchMarkets(net: Net): Promise<DistMarket[]>; fetchFundingRates(net: Net): Promise<DistFunding[]> };
}

async function loadVenueDef(cliVenue: string): Promise<DistVenueDef> {
  const mod = await import(pathToFileURL(join(REPO_ROOT, "dist", "exchanges", "venues", "index.js")).href) as { ALL_VENUES: DistVenueDef[] };
  const def = mod.ALL_VENUES.find(v => v.id === cliVenue);
  if (def === undefined) throw new Error(`venue ${cliVenue} is not in dist ALL_VENUES — rebuild (pnpm build)`);
  return def;
}

// ── Market model used for sizing ───────────────────────────────────────────

interface Mkt {
  symbol: string;
  mark: number;
  tick: string | null;
  step: string;
  szDecimals: number | null;
  minSize: number | null;
  minNotional: number;
  minNotionalSource: string;
  maxLeverage: number | null;
  percentPrice: { up: number; down: number } | null;
  onlyIsolated: boolean | null;
  tradable: boolean;
  source: string;
}

async function fetchJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, body === undefined ? { signal: AbortSignal.timeout(20_000) } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json() as Promise<unknown>;
}

const HL_INFO: Record<Net, string> = { mainnet: "https://api.hyperliquid.xyz/info", testnet: "https://api.hyperliquid-testnet.xyz/info" };

async function hip3Markets(net: Net, dex: string, fallbackMinNotional: number): Promise<Mkt[]> {
  const raw = await fetchJson(HL_INFO[net], { type: "metaAndAssetCtxs", dex }) as [{ universe: Array<Record<string, unknown>> }, Array<Record<string, unknown>>];
  return raw[0].universe.map((u, i) => {
    const szd = Number(u.szDecimals);
    const ctx = raw[1][i] ?? {};
    return {
      symbol: String(u.name).split(":").pop() ?? String(u.name),
      mark: Number(ctx.markPx ?? NaN),
      tick: null, step: szd === 0 ? "1" : (1 / 10 ** szd).toFixed(szd), szDecimals: szd,
      minSize: null, minNotional: fallbackMinNotional, minNotionalSource: "HL docs $10",
      maxLeverage: typeof u.maxLeverage === "number" ? u.maxLeverage : null, percentPrice: null,
      onlyIsolated: u.onlyIsolated === true || u.marginMode === "strictIsolated" || u.marginMode === "noCross" ? true : (u.onlyIsolated === false ? false : null),
      tradable: u.isDelisted !== true && Number.isFinite(Number(ctx.markPx)),
      source: `HL /info metaAndAssetCtxs dex=${dex}`,
    };
  });
}

async function asterMarkets(def: DistVenueDef, net: Net): Promise<Mkt[]> {
  // Same REST host the CLI uses (venue definition networks — fapi.asterdex-testnet.com on testnet).
  const base = def.networks[net].restUrl;
  const info = await fetchJson(`${base}/fapi/v1/exchangeInfo`) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string; filters: Array<Record<string, string>> }> };
  const marks = await fetchJson(`${base}/fapi/v1/premiumIndex`) as Array<{ symbol: string; markPrice: string }>;
  const markOf = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]));
  return info.symbols.filter(s => s.quoteAsset === "USDT").map(s => {
    const f = (t: string) => s.filters.find(x => x.filterType === t);
    const pf = f("PRICE_FILTER"); const lot = f("LOT_SIZE"); const mn = f("MIN_NOTIONAL"); const pp = f("PERCENT_PRICE");
    return {
      symbol: s.baseAsset, mark: markOf.get(s.symbol) ?? NaN,
      tick: pf?.tickSize ?? null, step: lot?.stepSize ?? "1", szDecimals: null,
      minSize: lot?.minQty !== undefined ? Number(lot.minQty) : null,
      minNotional: mn?.notional !== undefined ? Number(mn.notional) : 5, minNotionalSource: mn?.notional !== undefined ? "exchangeInfo MIN_NOTIONAL" : "assumed 5",
      maxLeverage: null,
      percentPrice: pp !== undefined ? { up: Number(pp.multiplierUp), down: Number(pp.multiplierDown) } : null,
      onlyIsolated: null, tradable: s.status === "TRADING", source: `${base}/fapi/v1/exchangeInfo`,
    };
  });
}

async function venueMarkets(def: DistVenueDef, opts: Opts): Promise<Mkt[]> {
  const profile = PROFILES[opts.venue];
  if (opts.dex !== null) return hip3Markets(opts.network, opts.dex, profile.minNotionalFallback?.usd ?? 10);
  if (opts.venue === "aster") return asterMarkets(def, opts.network);
  const ms = await def.publicData.fetchMarkets(opts.network);
  return ms.map(m => {
    const mn = m.minNotional !== null ? Number(m.minNotional) : null;
    const fb = profile.minNotionalFallback;
    const step = m.stepSize ?? "1";
    return {
      symbol: m.symbol, mark: Number(m.markPrice), tick: m.tickSize, step,
      szDecimals: opts.venue === "hyperliquid" ? decimalsOf(step) : null,
      minSize: m.minSize !== null ? Number(m.minSize) : null,
      minNotional: mn ?? fb?.usd ?? 0,
      minNotionalSource: mn !== null ? "venue public data" : fb !== null ? fb.source : "none published (0)",
      maxLeverage: m.maxLeverage, percentPrice: null, onlyIsolated: null, tradable: m.tradable,
      source: `${def.id} publicData.fetchMarkets(${opts.network})`,
    };
  });
}

// ── Spot markets (public) for the spot-phase auto-selection ────────────────

/** HL spot tokens the CLI refuses to resolve (hyperliquid-spot.ts SPOT_EXCLUDE). */
const HL_SPOT_EXCLUDE = new Set(["TRUMP", "PEPE", "HFUN"]);

/**
 * Public spot markets of the venue, or null when the runner has no public spot reader for it
 * (the operator then passes --spot-symbol and --spot-size). Same hosts as the CLI (venue definition).
 */
async function spotCandidates(def: DistVenueDef, opts: Opts): Promise<SpotCandidate[] | null> {
  const net = opts.network;
  const num = (v: unknown): number | null => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
  if (opts.venue === "hyperliquid") {
    const [meta, ctxs] = await fetchJson(HL_INFO[net], { type: "spotMetaAndAssetCtxs" }) as [
      { tokens: Array<{ name: string; index: number; szDecimals?: number }>; universe: Array<{ name: string; tokens: [number, number]; index: number }> },
      Array<Record<string, unknown>>,
    ];
    const tok = new Map(meta.tokens.map(t => [t.index, t]));
    return meta.universe.flatMap((u, i) => {
      const b = tok.get(u.tokens[0]); const q = tok.get(u.tokens[1]); const ctx = ctxs[i] ?? {};
      if (b === undefined || q === undefined || b.szDecimals === undefined || HL_SPOT_EXCLUDE.has(b.name.toUpperCase())) return [];
      const step = b.szDecimals === 0 ? "1" : (1 / 10 ** b.szDecimals).toFixed(b.szDecimals);
      const mid = num(ctx.midPx);
      return [{ symbol: b.name, quote: q.name, mark: num(ctx.markPx), twoSided: mid !== null, mid, volume24hUsd: num(ctx.dayNtlVlm),
        step, minSize: null, minNotional: profileMinNotional(opts), bookRef: u.name }];
    });
  }
  if (opts.venue === "lighter" || opts.venue === "lighter-rh") {
    const base = def.networks[net].restUrl;
    const ob = await fetchJson(`${base}/api/v1/orderBooks?filter=spot`) as { order_books: Array<Record<string, unknown>> };
    const det = await fetchJson(`${base}/api/v1/orderBookDetails?filter=spot`) as { spot_order_book_details?: Array<Record<string, unknown>> };
    const detOf = new Map((det.spot_order_book_details ?? []).map(d => [String(d.symbol), d]));
    return ob.order_books.filter(o => o.status === "active").map(o => {
      const [b, q] = String(o.symbol).split("/");
      const d = detOf.get(String(o.symbol));
      const sd = Number(o.supported_size_decimals);
      const last = num(d?.last_trade_price);
      return { symbol: b, quote: q ?? "", mark: last !== null && last > 0 ? last : null, twoSided: null, mid: null, volume24hUsd: num(d?.daily_quote_token_volume),
        step: sd === 0 ? "1" : (1 / 10 ** sd).toFixed(sd), minSize: num(o.min_base_amount), minNotional: num(o.min_quote_amount), bookRef: String(o.market_id) };
    });
  }
  if (opts.venue === "pacifica") {
    const base = def.networks[net].restUrl;
    const info = (await fetchJson(`${base}/info`) as { data: Array<Record<string, unknown>> }).data.filter(m => m.instrument_type === "spot");
    const prices = (await fetchJson(`${base}/info/prices`) as { data: Array<Record<string, unknown>> }).data;
    const px = new Map(prices.map(p => [String(p.symbol), p]));
    // The live book is read per ranked market by spotBook (pickSpotMarketWithBook): Pacifica testnet
    // lists SOL-USDC spot with an EMPTY book, and a market buy there is refused 422 no_reasonable_price.
    return info.map(m => {
      const p = px.get(String(m.symbol));
      return { symbol: String(m.base_asset), quote: String(m.symbol).split(/[-/]/)[1] ?? "", mark: num(p?.mark), twoSided: null, mid: null,
        volume24hUsd: num(p?.volume_24h), step: String(m.lot_size), minSize: null, minNotional: num(m.min_order_size), bookRef: String(m.symbol) };
    });
  }
  return null;
}

/** Public read with up to 3 attempts (HL testnet answers 502 intermittently); the last failure throws. */
async function fetchJsonRetry(url: string, body?: unknown): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1_000 * i));
    try { return await fetchJson(url, body); } catch (e) { last = e; }
  }
  throw last;
}

/**
 * Live spot book (best bid / ask) of a candidate, from the same venue endpoint the CLI's spot
 * adapter reads (HL l2Book, Lighter orderBookOrders, Pacifica /book). A failed read throws.
 */
async function spotBook(def: DistVenueDef, opts: Opts, bookRef: string): Promise<SpotBook> {
  const num = (v: unknown): number | null => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
  const net = opts.network;
  if (opts.venue === "hyperliquid") {
    const b = await fetchJsonRetry(HL_INFO[net], { type: "l2Book", coin: bookRef }) as { levels?: [Array<{ px: string }>, Array<{ px: string }>] } | null;
    if (b === null || !Array.isArray(b.levels)) throw new Error(`HL l2Book ${bookRef}: no levels in the response`);
    return { bestBid: num(b.levels[0]?.[0]?.px), bestAsk: num(b.levels[1]?.[0]?.px) };
  }
  if (opts.venue === "lighter" || opts.venue === "lighter-rh") {
    const b = await fetchJsonRetry(`${def.networks[net].restUrl}/api/v1/orderBookOrders?market_id=${encodeURIComponent(bookRef)}&limit=1`) as { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };
    if (!Array.isArray(b.bids) || !Array.isArray(b.asks)) throw new Error(`${opts.venue} orderBookOrders market ${bookRef}: no bids / asks arrays`);
    return { bestBid: num(b.bids[0]?.price), bestAsk: num(b.asks[0]?.price) };
  }
  if (opts.venue === "pacifica") {
    const b = (await fetchJsonRetry(`${def.networks[net].restUrl}/book?symbol=${encodeURIComponent(bookRef)}`) as { data?: { l?: [Array<{ p: string }>, Array<{ p: string }>] } }).data;
    if (b === undefined || !Array.isArray(b.l)) throw new Error(`pacifica /book ${bookRef}: no levels in the response`);
    return { bestBid: num(b.l[0]?.[0]?.p), bestAsk: num(b.l[1]?.[0]?.p) };
  }
  throw new Error(`no spot book reader for ${opts.venue}`);
}

/** Venue minimum notional from the profile (HL: docs $10), null when none is documented. */
function profileMinNotional(opts: Opts): number | null {
  return PROFILES[opts.venue].minNotionalFallback?.usd ?? null;
}

// ── Sizing ─────────────────────────────────────────────────────────────────

interface Sizing {
  unit: string;
  unitNotional: number;
  requiredNotional: number;
  farPct: number;
  farBuyPrice: string;
  farBuyPrice2: string;
  farBuySize: string;
  farBuySize2: string;
  farSellPrice: string;
  tp: string;
  sl: string;
  stopPrice: string;
  stopPrice2: string;
  tpCrossed: string;
}

function priceAt(m: Mkt, opts: Opts, factor: number, dir: "down" | "up"): string {
  const p = m.mark * factor;
  if (opts.venue === "hyperliquid" || opts.dex !== null) return hlPrice(p, m.szDecimals ?? 0, dir);
  if (m.tick !== null) return roundToTick(p, m.tick, dir);
  return hlPrice(p, 0, dir); // 5 significant figures when no tick is published
}

function sizeFor(m: Mkt, opts: Opts, price: number): string {
  const required = Math.max(opts.minUsd, m.minNotional * (1 + opts.marginPct / 100));
  return ceilToStep(Math.max(required / price, m.minSize ?? 0, Number(m.step)), m.step);
}

function computeSizing(m: Mkt, opts: Opts): Sizing {
  let far = opts.farPct / 100;
  // Aster PERCENT_PRICE: a protection / limit price outside the band is refused before sending.
  if (m.percentPrice !== null) far = Math.min(far, (1 - m.percentPrice.down) * 0.8, (m.percentPrice.up - 1) * 0.8);
  const unit = sizeFor(m, opts, m.mark);
  const farBuyPrice = priceAt(m, opts, 1 - far, "down");
  const farBuyPrice2 = priceAt(m, opts, 1 - far * 1.2, "down");
  const farBuySize = sizeFor(m, opts, Number(farBuyPrice));
  const farBuySize2 = ceilToStep(Number(sizeFor(m, opts, Number(farBuyPrice2))) + Number(m.step), m.step);
  return {
    unit, unitNotional: Number(unit) * m.mark, requiredNotional: Math.max(opts.minUsd, m.minNotional * (1 + opts.marginPct / 100)), farPct: far * 100,
    farBuyPrice, farBuyPrice2, farBuySize, farBuySize2,
    farSellPrice: priceAt(m, opts, 1 + far, "up"),
    tp: priceAt(m, opts, 1 + far, "up"), sl: priceAt(m, opts, 1 - far, "down"),
    stopPrice: priceAt(m, opts, 1 - far, "down"), stopPrice2: priceAt(m, opts, 1 - far * 1.2, "down"),
    tpCrossed: priceAt(m, opts, 1 - far, "down"),
  };
}

// ── Run state + step executor ──────────────────────────────────────────────

class StopRun extends Error {
  constructor(message: string, readonly kind: "fail" | "stopped" | "preflight-fail") { super(message); }
}

interface Assertion { name: string; ok: boolean; detail: string }

interface StepSpec {
  id: string;
  title: string;
  phase: string;
  /** Args after the global flags (`--json -n <net> -e <venue> [--dex] [-w]`). */
  args: string[];
  write: boolean;
  /** Worst-case open notional if this step executes; > --max-usd → skipped with the reason. */
  worstCase: number | null;
  settles: string[];
  /** "ok" = envelope ok; string[] = accepted error codes; "observe" = any definite outcome is recorded. */
  expect: "ok" | string[] | "observe";
  /** Extra assertions on a parsed envelope (only when not dry-run). */
  check?: (env: Envelope) => Assertion[] | Promise<Assertion[]>;
  observe?: (env: Envelope) => Record<string, unknown>;
  /** Placeholder values the dry-run plan shows for this step's outputs. */
  note?: string;
  timeoutMs?: number;
  /** Step ids this step depends on: when one of them was skipped, this step is skipped too (never failed). */
  needs?: string[];
  /** Open exposure (USD) this step replaces or closes if it executes (the order an edit replaces; the long a resting sell closes). */
  offsetUsd?: number;
}

const ITEM_VENUES: Record<string, E2eVenue[] | "all"> = {
  "#1": ["lighter-rh"], "#2": ["lighter-rh"], "#3": ["lighter", "lighter-rh"],
  "#4": ["ondo"], "#5": ["ondo"], "#6": ["ondo"], "#7": ["ondo"],
  "#8": ["arcus"], "#9": ["arcus"], "#10": ["arcus"], "#11": ["hyperliquid"], "#12": "all",
  "#13": ["lighter", "lighter-rh"], "#14": ["pacifica"], "#15": ["hyperliquid"], "#16": ["pacifica"],
  "#17": ["lighter", "lighter-rh"], "#18": ["lighter", "lighter-rh", "aster"], "#19": ["lighter", "lighter-rh"],
  "#20": ["hyperliquid"], "#21": ["lighter", "lighter-rh"],
  S1: ["ondo"], S2: ["ondo"], S3: ["ondo"], S4: ["ondo"], S5: ["ondo"], S6: ["ondo"], S7: ["ondo"], S8: ["ondo"],
  S9: ["aster"], S10: ["aster"], S11: ["aster"], S12: ["aster"], S13: ["aster"], S14: ["arcus"], S15: "all",
  S16: ["hyperliquid"], S17: ["lighter", "lighter-rh"], S18: ["aster"], S19: ["pacifica"], S20: ["arcus"],
  S21: ["lighter", "lighter-rh"], S22: ["lighter", "lighter-rh"],
  Q1: ["qfex"], Q2: ["qfex"], Q3: ["qfex"], Q4: ["qfex"], Q5: ["qfex"], Q6: ["qfex"], Q7: ["qfex"], Q8: ["qfex"], Q9: ["qfex"],
  Q10: ["qfex"], Q11: ["qfex"], Q12: ["qfex"], Q13: ["qfex"], Q14: ["qfex"], Q15: ["qfex"], Q16: ["qfex"], Q17: ["qfex"], Q18: ["qfex"],
  Q19: ["qfex"], Q20: ["qfex"], Q21: ["qfex"], Q22: ["qfex"], Q23: ["qfex"],
};

/** Items no runner step can settle, with the reason. */
const NOT_COVERED: Record<string, string> = {
  "#3": "P3: run `perp -n <net> --json account positions` (no -e) with lighter + lighter-rh agents — runner records it in live preflight only",
  "#7": "ondo withdraw is a manual CLI step (`funds withdraw ondo --to <address-book address>`); CLI uses no WS login",
  "#10": "arcus withdraw runs via `funds withdraw arcus` (withdraw phase); scheduleCancel not implemented",
  "#12": "P0 — `pnpm test` (unit), not an exchange step",
  "#13": "ALO is disabled on lighter(+rh) (CAPABILITY_UNSUPPORTED) — needs a dedicated SDK probe on testnet",
  "#18": "CLI refuses a crossed trigger before sending (INVALID_PARAMS); the venue-rejection → ORDER_PARTIAL path is unreachable from the CLI",
  S6: "no spot orderbook command; exercised only indirectly by spot-buy",
  S10: "the denied path needs an agent WITHOUT --can-spot — manual step (spot-balance before `wallet agent rotate aster --can-spot`)",
  S12: "needs an agent WITHOUT --can-spot — manual step (expect POLICY_DENIED from spot-buy)",
  S15: "P3 — `perp -n <net> --json arb scan --mode spot-perp` (public, keyless)",
  // QFEX: no generic runner step settles these — each is a manual UAT drill (QFEX section).
  Q1: "manual UAT drill: place GTC, close / kill the socket, re-list",
  Q2: "manual UAT drill with a raw add_order — perp-cli refuses every reduce-only order until this passes",
  Q3: "manual UAT drill (auth frames)", Q4: "manual: compare /executions funding amounts with position notional",
  Q5: "manual UAT drill with a raw modify_order — perp-cli refuses amend until this passes",
  Q6: "observe with `trade status` after fills / cancels", Q7: "manual UAT drill with a raw add_order carrying take_profit / stop_loss",
  Q8: "manual UAT drill (cancel-all with a web-placed stop)", Q9: "manual observation across sessions", Q10: "manual: open long + short on UAT and read `account positions --json`",
  Q11: "manual: import a view-only / account-scoped key", Q12: "manual: venue docs / support", Q13: "manual observation",
  Q14: "manual UAT drill (timestamps of ACK vs get_user_orders)", Q15: "manual observation", Q16: "manual: `funds transfer -e qfex`, `trade leverage` with a restricted key",
  Q17: "manual: `funds withdraw qfex` on UAT", Q18: "observed on the first order (UUID accepted or INVALID_CLIENT_ORDER_ID)", Q19: "manual: `arb scan --rates --include-unverified -n testnet`",
  Q20: "manual UAT drill: IOC full / partial / no fill, record frames (venueRaw.responses)", Q21: "manual UAT drill with a raw stop add_order",
  Q22: "observed on the first order: execution.notes reports a user_id ≠ account id", Q23: "manual: time from fill frame to /user/positions change",
};

function isPendingEnvelope(env: Envelope | null): string | null {
  if (env === null) return null;
  if (!env.ok && env.error?.code === "ORDER_PENDING") return `ORDER_PENDING: ${env.error.message}`;
  const d = env.data as Record<string, unknown> | undefined;
  if (d !== undefined && d !== null && typeof d === "object") {
    if (d.finality === "pending") return `result finality "pending" (status ${String(d.status)})`;
    const order = d.order as Record<string, unknown> | undefined;
    if (order !== undefined && order !== null && order.finality === "pending") return `spot result finality "pending" (status ${String(order.status)})`;
    if (Array.isArray(d.pending) && d.pending.length > 0) return `cancel not proven for ${d.pending.length} order(s) (pending)`;
  }
  return null;
}

// ── One leg (the venue itself, or its HIP-3 dex) ───────────────────────────

let interrupted = false;

/**
 * Run the phases of one leg into `report`. `leg` null = the venue itself; "hip3" = the HIP-3
 * dex of a hyperliquid run (`opts.dex` set, steps and phases prefixed `hip3-`). Returns an exit
 * code when a gate refused to start, else null (outcome is in `report.result`).
 */
export async function runLeg(opts: Opts, report: RunReport, leg: "hip3" | null): Promise<number | null> {
  const profile = PROFILES[opts.venue];
  const net = opts.network;
  const live = !opts.dryRun;

  // Child env: testnet host override only when the operator exported it (never injected silently).
  const childEnv: Record<string, string> = {};
  const globals = ["--json", "-n", net, "-e", profile.cliVenue, ...(opts.dex !== null ? ["--dex", opts.dex] : []), ...(opts.wallet !== null ? ["-w", opts.wallet] : [])];
  const cmd = (args: string[]): string => displayCommand([...globals.filter(g => g !== "--json"), ...args]);

  let lastCall = 0;
  const pace = async (): Promise<void> => {
    const wait = lastCall + opts.paceMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  };

  const record = (s: Omit<StepRecord, "assertions" | "observations" | "exitCode" | "durationMs" | "envelope" | "stderrTail"> & Partial<StepRecord>): StepRecord => {
    const r: StepRecord = { assertions: [], observations: {}, exitCode: null, durationMs: null, envelope: null, stderrTail: null, ...s };
    if (leg !== null) { r.id = `${leg}-${r.id}`; r.phase = `${leg}-${r.phase}`; }
    report.steps.push(r);
    return r;
  };

  /** true when the step `id` of this leg was recorded as skipped (cap, or a skipped prerequisite). */
  const wasSkipped = (id: string): boolean => report.steps.some(r => r.id === (leg !== null ? `${leg}-${id}` : id) && r.outcome === "skipped");

  const cleanupFor = (symbol: string | null): string[] => [
    cmd(["account", "orders"]), cmd(["account", "positions"]),
    ...(symbol !== null ? [cmd(["trade", "cancel-all"]), cmd(["trade", "close", symbol])] : []),
    "perp --json strategy quarantine",
  ];

  /** Spot base asset traded by this run + its holding before the first spot write (set in the spot phase). */
  let spotTrack: { base: string; bookRef: string | null; baseline: number } | null = null;

  /**
   * USD value of spot `base` acquired since the baseline, at the mid of its own SPOT book (a spot
   * token may have no perp market — HL testnet PURR); StopRun when unreadable.
   */
  async function spotExposureUsd(track: { base: string; bookRef: string | null; baseline: number }): Promise<number> {
    await pace();
    const b = await runCli([...globals, "trade", "spot-balance"], { timeoutMs: 60_000, env: childEnv });
    if (b.envelope?.ok !== true) throw new StopRun("cannot read spot holdings (trade spot-balance) — refusing to place more orders", "stopped");
    let current: number;
    try { current = spotHoldingOf(b.envelope.data, track.base); } catch (e) {
      throw new StopRun(`cannot read spot holdings: ${(e as Error).message}`, "stopped");
    }
    if (!(current > track.baseline)) return 0;
    if (track.bookRef === null) throw new StopRun(`cannot value spot ${track.base}: no spot book reference for this market — refusing to place more orders`, "stopped");
    let mid: number | null;
    try {
      const book = await spotBook(await loadVenueDef(profile.cliVenue), opts, track.bookRef);
      mid = book.bestBid !== null && book.bestAsk !== null ? (book.bestBid + book.bestAsk) / 2 : null;
    } catch (e) {
      throw new StopRun(`cannot read the ${track.base} spot book: ${(e as Error).message}`, "stopped");
    }
    try { return spotAcquiredUsd(track.baseline, current, mid); } catch (e) {
      throw new StopRun(`cannot value spot holdings: ${(e as Error).message}`, "stopped");
    }
  }

  /**
   * Live USD exposure of the venue account — open perp positions + resting orders, plus spot
   * holdings acquired during this run (public mid); StopRun when any part is unreadable.
   */
  /**
   * A READ refused by the venue's rate limit / WAF (HTTP 429; Lighter mainnet answers 405 "Human
   * Verification" from AWS WAF for a minute or two after a burst) is repeated after a pause.
   * Reads only — a write is never repeated.
   */
  const READ_THROTTLE_RETRIES = 4;
  const READ_THROTTLE_WAIT_MS = 60_000;
  const throttled = (r: CliResult): boolean => {
    const e = r.envelope?.error;
    return r.envelope?.ok === false && e !== undefined
      && (e.code === "RATE_LIMITED" || /\(429\)|Too Many Requests|Human Verification/i.test(e.message ?? ""));
  };
  async function runRead(argv: string[], timeoutMs: number): Promise<CliResult> {
    let res = await runCli(argv, { timeoutMs, env: childEnv });
    for (let attempt = 0; attempt < READ_THROTTLE_RETRIES && throttled(res); attempt++) {
      console.log(`  …  read throttled by the venue — waiting ${READ_THROTTLE_WAIT_MS / 1000}s before reading again (${attempt + 1}/${READ_THROTTLE_RETRIES})`);
      await new Promise(r => setTimeout(r, READ_THROTTLE_WAIT_MS));
      res = await runCli(argv, { timeoutMs, env: childEnv });
    }
    return res;
  }

  async function currentExposureUsd(): Promise<number> {
    const rows = (d: unknown): unknown[] => Array.isArray(d) ? d : ((d as { main?: unknown[] } | null)?.main ?? []);
    await pace();
    const p = await runRead([...globals, "account", "positions"], 60_000);
    await pace();
    const o = await runRead([...globals, "account", "orders"], 60_000);
    if (p.envelope?.ok !== true || o.envelope?.ok !== true) {
      throw new StopRun("cannot read open exposure (account positions / orders) — refusing to place more orders", "stopped");
    }
    let perp: number;
    try {
      perp = openExposureUsd(
        rows(p.envelope.data) as Array<{ symbol: string; size: string; markPrice?: string }>,
        rows(o.envelope.data) as Array<{ symbol: string; size: string; price: string; filled?: string }>,
      );
    } catch (e) {
      throw new StopRun(`cannot value open exposure: ${(e as Error).message}`, "stopped");
    }
    return perp + (spotTrack !== null ? await spotExposureUsd(spotTrack) : 0);
  }

  /** Execute (or plan) one CLI step. Throws StopRun on anything unexpected. */
  async function step(spec: StepSpec): Promise<Envelope | null> {
    if (interrupted) throw new StopRun("interrupted by SIGINT", "stopped");
    if (killSwitchActive()) throw new StopRun(`kill switch ${KILL_FILE} present`, "stopped");
    const argv = [...globals, ...spec.args];
    const base = { id: spec.id, title: spec.title, phase: spec.phase, command: cmd(spec.args), worstCaseNotionalUsd: spec.worstCase, settles: spec.settles, note: spec.note ?? null };
    const blockedBy = (spec.needs ?? []).find(wasSkipped);
    if (blockedBy !== undefined) {
      record({ ...base, outcome: "skipped", note: `prerequisite ${blockedBy} was skipped — not run` });
      console.log(`  ⏭  ${spec.id}: skipped (prerequisite ${blockedBy} was skipped)`);
      return null;
    }
    if (spec.worstCase !== null && spec.worstCase > opts.maxUsd) {
      record({ ...base, outcome: "skipped", note: `worst-case notional $${spec.worstCase.toFixed(2)} > --max-usd ${opts.maxUsd}${spec.note !== undefined ? ` — ${spec.note}` : ""}` });
      console.log(`  ⏭  ${spec.id}: skipped (worst-case $${spec.worstCase.toFixed(2)} > cap $${opts.maxUsd})`);
      return null;
    }
    if (opts.dryRun) {
      record({ ...base, outcome: "planned" });
      console.log(`  ·  ${spec.id}: ${base.command}`);
      return null;
    }
    // Run-wide cap: what is already open (positions + resting orders) plus this step's worst
    // case must stay within --max-usd — not just this one order.
    if (spec.write && spec.worstCase !== null) {
      const open = await currentExposureUsd();
      const offset = spec.offsetUsd ?? 0;
      if (projectedExposureUsd(open, spec.worstCase, offset) > opts.maxUsd) {
        record({ ...base, outcome: "skipped", note: `open exposure $${open.toFixed(2)}${offset > 0 ? ` − replaced/closed $${offset.toFixed(2)}` : ""} + worst case $${spec.worstCase.toFixed(2)} > --max-usd ${opts.maxUsd}` });
        console.log(`  ⏭  ${spec.id}: skipped (open $${open.toFixed(2)}${offset > 0 ? ` − $${offset.toFixed(2)}` : ""} + $${spec.worstCase.toFixed(2)} > cap $${opts.maxUsd})`);
        return null;
      }
    }
    await pace();
    const res: CliResult = spec.write
      ? await runCli(argv, { timeoutMs: spec.timeoutMs ?? 180_000, env: childEnv })
      : await runRead(argv, spec.timeoutMs ?? 180_000);
    const rec = record({ ...base, outcome: "pass", exitCode: res.exitCode, durationMs: res.durationMs, envelope: res.envelope, stderrTail: res.stderr.split("\n").slice(-15).join("\n") });
    const env = res.envelope;
    if (res.timedOut) {
      rec.outcome = "stopped";
      throw new StopRun(spec.write
        ? `${spec.id} timed out after ${res.durationMs} ms — the outcome of this write is UNKNOWN. Do NOT resubmit; inspect positions/orders${spec.id.includes("market") ? " and trade status" : ""}`
        : `${spec.id} (read) timed out`, "stopped");
    }
    const pending = isPendingEnvelope(env);
    if (pending !== null) {
      rec.outcome = "stopped";
      const d = (env?.data ?? env?.error?.details ?? {}) as Record<string, unknown>;
      const oid = typeof d.orderId === "string" ? d.orderId : null;
      throw new StopRun(`${spec.id}: ${pending}. Do NOT resubmit. Check: ${oid !== null ? `${cmd(["trade", "status", oid, "--symbol", "<SYM>"])}; ` : ""}${cmd(["account", "positions"])}; ${cmd(["account", "orders"])}${env?.error?.remediation !== undefined ? ` — ${env.error.remediation}` : ""}`, "stopped");
    }
    if (env === null) {
      // A write that died without an envelope may have been sent: UNKNOWN outcome, so no cleanup write follows.
      rec.outcome = spec.write ? "stopped" : "fail";
      throw new StopRun(`${spec.id}: no JSON envelope on stdout (exit ${res.exitCode})${spec.write ? " — the outcome of this write is UNKNOWN. Do NOT resubmit" : ""}`, spec.write ? "stopped" : "fail");
    }
    // A failed write is only a known outcome when the error PROVES nothing executed (or the step
    // expects exactly that error): anything else stops the run as an UNKNOWN outcome — never a
    // plain failure, so no cleanup write follows it.
    if (spec.write && !env.ok && !(Array.isArray(spec.expect) && spec.expect.includes(env.error?.code ?? "?"))) {
      const unknown = unknownWriteOutcome(env);
      if (unknown !== null) {
        rec.outcome = "stopped";
        throw new StopRun(`${spec.id}: ${unknown}. Do NOT resubmit. Check: ${cmd(["account", "positions"])}; ${cmd(["account", "orders"])}`, "stopped");
      }
    }
    // Exit code must agree with the envelope.
    rec.assertions.push({ name: "exit code matches envelope", ok: env.ok ? res.exitCode === 0 : res.exitCode !== 0, detail: `ok=${env.ok} exit=${res.exitCode}` });
    if (spec.expect === "ok") {
      rec.assertions.push({ name: "envelope ok", ok: env.ok, detail: env.ok ? "ok" : `${env.error?.code}: ${env.error?.message}` });
    } else if (Array.isArray(spec.expect)) {
      const code = env.ok ? "ok" : env.error?.code ?? "?";
      rec.assertions.push({ name: `expected one of ${spec.expect.join("/")}`, ok: spec.expect.includes(code), detail: env.ok ? "envelope ok" : `${code}: ${env.error?.message}` });
    } else {
      rec.outcome = "observed";
    }
    if (spec.observe !== undefined) {
      try { rec.observations = { ...rec.observations, ...spec.observe(env) }; } catch (e) { rec.observations.observeError = String(e); }
    }
    if (spec.check !== undefined && (spec.expect === "observe" || env.ok || Array.isArray(spec.expect))) {
      rec.assertions.push(...await spec.check(env));
    }
    const failed = rec.assertions.filter(a => !a.ok);
    if (failed.length > 0) {
      rec.outcome = "fail";
      throw new StopRun(`${spec.id}: ${failed.map(a => `${a.name} (${a.detail})`).join("; ")}`, "fail");
    }
    console.log(`  ✓  ${spec.id}: ${spec.title}${rec.outcome === "observed" ? " (observed)" : ""}`);
    return env;
  }

  function internal(id: string, title: string, phase: string, outcome: StepRecord["outcome"], observations: Record<string, unknown>, settles: string[] = [], note: string | null = null, assertions: Assertion[] = []): StepRecord {
    const r = record({ id, title, phase, outcome, command: null, worstCaseNotionalUsd: null, settles, note, assertions, observations });
    console.log(`  ${outcome === "fail" ? "✗" : outcome === "skipped" ? "⏭ " : "•"}  ${id}: ${title}${note !== null ? ` — ${note}` : ""}`);
    return r;
  }

  /** Master wallet address (public) the CLI signs deposits with: `-w <name>` or the active OWS wallet. */
  async function masterAddress(kind: "evm" | "solana"): Promise<string> {
    let address: string | undefined;
    if (opts.wallet === null) {
      const r = await runCli(["--json", "wallet", "show"], { timeoutMs: 30_000, env: childEnv });
      const a = (r.envelope?.data as { owsActive?: { evmAddress?: string; solanaAddress?: string } | null } | undefined)?.owsActive;
      address = kind === "evm" ? a?.evmAddress : a?.solanaAddress;
    } else {
      const r = await runCli(["--json", "wallet", "list"], { timeoutMs: 30_000, env: childEnv });
      const ws = (r.envelope?.data as { ows?: { wallets?: Array<{ name: string; accounts: Array<{ chainId: string; address: string }> }> } } | undefined)?.ows?.wallets ?? [];
      address = ws.find(x => x.name === opts.wallet)?.accounts.find(a => a.chainId.startsWith(kind === "evm" ? "eip155:" : "solana:"))?.address;
    }
    if (typeof address !== "string" || address === "") throw new Error(`no ${kind} address for ${opts.wallet !== null ? `wallet ${opts.wallet}` : "the active OWS wallet"} (perp wallet show)`);
    return address;
  }

  /** Read-only JSON-RPC: deposit-asset and gas balances of `address` on the deposit chain. Throws on any failed read. */
  async function walletBalances(def: DistVenueDef, w: DepositWallet, address: string): Promise<{ token: number; gas: number; rpcUrl: string; tokenAddress: string }> {
    const rpcUrl = w.rpcUrl ?? def.networks[net].rpcUrl;
    const tokenAddress = w.token ?? def.networks[net].depositPins?.token ?? null;
    if (rpcUrl === null || tokenAddress === null) throw new Error(`${opts.venue} ${net} venue definition has no rpcUrl / depositPins.token`);
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      const r = await fetchJsonRetry(rpcUrl, { jsonrpc: "2.0", id: 1, method, params }) as { result?: unknown; error?: { message?: string } };
      if (r.result === undefined || r.result === null) throw new Error(`${method}: ${r.error?.message ?? "no result"}`);
      return r.result;
    };
    if (w.kind === "evm") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`);
      const gas = unitsFromHex(String(await rpc("eth_getBalance", [address, "latest"])), 18);
      const token = unitsFromHex(String(await rpc("eth_call", [{ to: tokenAddress, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"])), w.decimals);
      return { token, gas, rpcUrl, tokenAddress };
    }
    const lamports = (await rpc("getBalance", [address]) as { value?: unknown }).value;
    if (typeof lamports !== "number") throw new Error("getBalance: no value");
    const accounts = (await rpc("getTokenAccountsByOwner", [address, { mint: tokenAddress }, { encoding: "jsonParsed" }]) as { value?: unknown }).value;
    if (!Array.isArray(accounts)) throw new Error("getTokenAccountsByOwner: no value");
    // No token account for the mint = a zero holding.
    const token = (accounts as Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } } }>)
      .reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmountString), 0);
    if (!Number.isFinite(token)) throw new Error("getTokenAccountsByOwner: unreadable tokenAmount");
    return { token, gas: lamports / 1e9, rpcUrl, tokenAddress };
  }

  // ── Gates ──────────────────────────────────────────────────────────────
  console.log(`\nperp E2E — ${opts.venue}${opts.dex !== null ? ` (dex ${opts.dex})` : ""} / ${net} / phases ${opts.phases.join(",")}${opts.dryRun ? " / DRY-RUN" : ""} / cap $${opts.maxUsd}\n`);
  const needsConfirmation = opts.phases.some(p => p === "deposit" || p === "withdraw") || (opts.allowOnchainApprove && opts.phases.includes("spot"));
  if (leg === null && live && net === "mainnet") {
    const gate = mainnetStartGate({ venue: opts.venue, confirmRealMoney: opts.confirmRealMoney, operatorAuthorized: opts.operatorAuthorized, maxUsd: opts.maxUsd, defaultCapUsd: MAINNET_DEFAULT_MAX_USD, interactive: isInteractive() });
    if (gate.kind === "refuse") { console.error(gate.message); return 2; }
    if (gate.raiseCap) {
      const a = await ask(`--max-usd ${opts.maxUsd} is above the $${MAINNET_DEFAULT_MAX_USD} real-money cap. Type RAISE-CAP-${opts.maxUsd} to accept: `);
      if (a !== `RAISE-CAP-${opts.maxUsd}`) { console.error("Cap not confirmed — aborting."); return 2; }
    }
    if (gate.typeVenue) {
      const typed = await ask(`REAL MONEY on ${opts.venue} mainnet (cap $${opts.maxUsd}${opts.hip3Dex !== null ? `; then the HIP-3 dex ${opts.hip3Dex} leg, same cap` : ""}). Type the venue name to confirm: `);
      if (typed !== opts.venue) { console.error("Venue name mismatch — aborting."); return 2; }
    }
    if (gate.operatorAuthorized) {
      report.operatorAuthorized = true;
      const bar = "═".repeat(78);
      console.log([bar,
        `  OPERATOR-AUTHORIZED MAINNET RUN — REAL MONEY on ${opts.venue}${opts.hip3Dex !== null ? ` (+ HIP-3 dex ${opts.hip3Dex})` : ""}`,
        `  --operator-authorized ${opts.operatorAuthorized} replaces the typed venue-name confirmation (TTY: ${isInteractive()})`,
        `  cap $${opts.maxUsd} (worst case per step + open exposure) · unknown outcome → stop, never resubmit`,
        "  deposit / withdraw / approve prompts are auto-confirmed and recorded as operator-authorized",
        `  kill switch: touch ${KILL_FILE}`,
        bar, ""].join("\n"));
    }
  }
  // Set by the core leg's gate; the HIP-3 leg of the same run inherits it.
  const operatorMode = report.operatorAuthorized;
  if (leg === null && live && net === "testnet" && needsConfirmation && !opts.yesTestnet && !isInteractive()) {
    console.error("Testnet deposit/withdraw/approve steps need confirmation: pass --yes-testnet for a non-interactive run.");
    return 2;
  }
  const confirmStep = async (what: string, phase: string): Promise<boolean> => {
    if (net === "testnet" && opts.yesTestnet) { console.log(`  [--yes-testnet] auto-confirmed: ${what}`); return true; }
    if (operatorMode) {
      internal(`${phase[0]}-operator-confirm`, "confirmation: operator-authorized", phase, "observed", { confirmation: "operator-authorized", what }, [], `operator-authorized (auto-confirmed): ${what}`);
      return true;
    }
    if (!isInteractive()) return false;
    return confirmYesNo(`  Execute: ${what}`);
  };

  const norm = (s: string): string => s.toUpperCase().split(":").pop()!.replace(/-PERP$|-USD\.P$|-USD$|USDT$/, "");
  let symbol: string | null = null;
  // What this run may have left open (set while the phase runs, cleared when it ends clean): the
  // cleanup after a FAILED run cancels / closes / sells / transfers back exactly these.
  let cleanupTrade: { symbol: string; cancelAll: boolean } | null = null;
  let cleanupSpot: { sym: string; base: string; grid: string; quote: string; orderIds: string[]; movedIn: string | null; sellArgs: string[] } | null = null;

  /**
   * After a failed run (a definite failure — never after an unknown outcome, the kill switch or
   * SIGINT): cancel the orders this run placed, close the position it opened on the test symbol
   * (flat before the run — pf-flat), sell the spot it bought (holding − baseline) and move back the
   * quote it moved in. Every step is recorded (phase `cleanup`); the first unknown outcome stops it.
   */
  async function cleanup(): Promise<void> {
    console.log("\n[cleanup]");
    const PH = "cleanup";
    const rowsOf = (d: unknown): unknown[] => Array.isArray(d) ? d : ((d as { main?: unknown[]; balances?: unknown[] } | null)?.main ?? (d as { balances?: unknown[] } | null)?.balances ?? []);
    try {
      if (cleanupSpot !== null && spotTrack !== null) {
        const c = cleanupSpot;
        for (const id of c.orderIds) {
          await step({ id: `c-spot-cancel-${id}`, title: "cancel a spot order this run placed", phase: PH, args: ["trade", "spot-cancel", c.sym, id], write: true, worstCase: null, settles: [], expect: "observe",
            observe: env => ({ result: env.data ?? env.error }) });
        }
        const b = await step({ id: "c-spot-balance", title: "spot balance", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null, settles: [], expect: "ok" });
        const sellSize = floorToStep(Math.max(spotHoldingOf(b?.data, c.base) - spotTrack.baseline, 0), c.grid);
        if (Number(sellSize) > 0) {
          await step({ id: "c-spot-sell", title: `sell the ${c.base} this run bought`, phase: PH, args: ["trade", "spot-sell", c.sym, sellSize, ...c.sellArgs], write: true, worstCase: null, settles: [], expect: "observe",
            observe: env => ({ result: env.data ?? env.error }) });
        }
        if (c.movedIn !== null) {
          const b2 = await step({ id: "c-spot-balance-2", title: "spot balance before the transfer back", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null, settles: [], expect: "ok" });
          const q = Number((rowsOf(b2?.data) as Array<{ token: string; available: string }>).find(r => r.token.toUpperCase() === c.quote.toUpperCase())?.available ?? NaN);
          if (!Number.isFinite(q)) throw new StopRun(`cannot read the spot ${c.quote} balance — transfer back by hand`, "stopped");
          const back = floorToStep(Math.min(q, Number(c.movedIn)), "0.01");
          if (Number(back) > 0) {
            await step({ id: "c-spot-transfer-out", title: `spot-transfer to-perp ${back}`, phase: PH, args: ["trade", "spot-transfer", "to-perp", back], write: true, worstCase: null, settles: [], expect: "observe",
              observe: env => ({ result: env.data ?? env.error }) });
          }
        }
      }
      if (cleanupTrade !== null) {
        const c = cleanupTrade;
        const sameSym = (r: { symbol: string }): boolean => norm(r.symbol) === norm(c.symbol);
        const o = await step({ id: "c-orders", title: "read open orders", phase: PH, args: ["account", "orders"], write: false, worstCase: null, settles: [], expect: "ok" });
        const ords = (rowsOf(o?.data) as Array<{ orderId: string; symbol: string }>).filter(sameSym);
        if (ords.length > 0 && c.cancelAll) {
          await step({ id: "c-cancel-all", title: "cancel-all (the venue account had no orders before the run)", phase: PH, args: ["trade", "cancel-all"], write: true, worstCase: null, settles: [], expect: "observe",
            observe: env => ({ result: env.data ?? env.error }) });
        } else {
          for (const r of ords) {
            await step({ id: `c-cancel-${r.orderId}`, title: `cancel a ${c.symbol} order this run placed`, phase: PH, args: ["trade", "cancel", c.symbol, r.orderId], write: true, worstCase: null, settles: [], expect: "observe",
              observe: env => ({ result: env.data ?? env.error }) });
          }
        }
        const p = await step({ id: "c-positions", title: "read positions", phase: PH, args: ["account", "positions"], write: false, worstCase: null, settles: [], expect: "ok" });
        if ((rowsOf(p?.data) as Array<{ symbol: string; size: string }>).some(r => sameSym(r) && Number(r.size) !== 0)) {
          await step({ id: "c-close", title: `close the ${c.symbol} position this run opened`, phase: PH, args: ["trade", "close", c.symbol, "--slippage-bps", String(opts.slippageBps)], write: true, worstCase: null, settles: [], expect: "observe",
            observe: env => ({ result: env.data ?? env.error }) });
        }
      }
      internal("c-done", "cleanup finished — verify with the commands below", PH, "observed", {});
    } catch (e) {
      internal("c-stopped", "cleanup stopped", PH, "fail", {}, [], `${(e as Error).message} — finish by hand with the commands below`);
    }
  }

  try {
    // ── P: preflight ────────────────────────────────────────────────────
    console.log("[preflight]");
    const ver = await runCli(["--version"], { timeoutMs: 30_000, env: childEnv });
    report.cliVersion = ver.stdout.trim() || null;
    const def = await loadVenueDef(profile.cliVenue);
    const caps = def.capabilities;
    report.capabilities = {
      timeInForce: caps.timeInForce, tpsl: caps.tpsl, amend: caps.amend, orderAck: caps.orderAck, marketOrder: caps.marketOrder,
      marginModes: caps.marginModes, withdrawAssets: caps.withdrawAssets, fundingRateBasis: def.fundingRateBasis,
      spot: def.spot !== null ? { accountModel: def.spot.accountModel, quoteAssets: [...def.spot.quoteAssets[net]], ...def.spot.capabilities } : null,
      network: def.networks[net],
    };
    internal("pf-network", `network config ${net}`, "preflight", "observed", { restUrl: def.networks[net].restUrl, settlementChain: def.networks[net].settlementChain, collateral: def.networks[net].collateral });

    // Testnet host override (aster).
    if (net === "testnet" && profile.testnetEnv !== null) {
      const envName = profile.testnetEnv.name;
      const set = process.env[envName];
      if (set === undefined) {
        const msg = `${envName} is not set — ${profile.testnetEnv.why}. Fix: export ${envName}=${profile.testnetEnv.suggested}`;
        if (live) throw new StopRun(msg, "preflight-fail");
        internal("pf-testnet-host", `${envName} override`, "preflight", "fail", { suggested: profile.testnetEnv.suggested }, [], msg);
        report.result = "preflight-fail";
        report.stopReason = msg;
      } else {
        childEnv[envName] = set;
        internal("pf-testnet-host", `${envName} override`, "preflight", "pass", { value: set });
      }
    }

    // Public market data → symbol + sizing.
    let markets: Mkt[];
    try {
      markets = await venueMarkets(def, opts);
    } catch (e) {
      const msg = `public market data unavailable on ${net}: ${(e as Error).message}`;
      internal("pf-markets", "public market data", "preflight", "fail", {}, [], msg);
      throw new StopRun(msg, "preflight-fail");
    }
    const tradable = markets.filter(m => m.tradable && Number.isFinite(m.mark) && m.mark > 0);
    internal("pf-markets", "public market data", "preflight", tradable.length > 0 ? "pass" : "fail", { total: markets.length, tradable: tradable.length, source: markets[0]?.source ?? null });
    if (tradable.length === 0) throw new StopRun(`no tradable markets on ${net}`, "preflight-fail");

    const candidates = opts.symbol !== null ? [opts.symbol] : leg === "hip3" && profile.hip3 !== null ? profile.hip3.symbols[net] : profile.symbols[net];
    const found = candidates.map(s => tradable.find(m => m.symbol.toUpperCase() === s)).filter((m): m is Mkt => m !== undefined);
    if (found.length === 0) throw new StopRun(`none of ${candidates.join(", ")} is tradable on ${opts.venue} ${net}`, "preflight-fail");
    const ranked = found.map(m => ({ m, s: computeSizing(m, opts) })).sort((a, b) => a.s.unitNotional - b.s.unitNotional);
    // Only a market with a two-sided book can run the trade phase (mid / ALO cross / market IOC):
    // Lighter RH testnet lists TSLA with an index price but an EMPTY book (no bids, no asks).
    let market = ranked[0];
    if (live && opts.symbol === null) {
      const books: Array<{ symbol: string; bid: string | null; ask: string | null; error: string | null }> = [];
      let pick: typeof market | null = null;
      for (const c of ranked) {
        const r = await runCli([...globals, "market", "mid", c.m.symbol], { timeoutMs: 60_000, env: childEnv });
        const d = r.envelope?.ok === true ? r.envelope.data as { bid?: string | null; ask?: string | null } : null;
        books.push({ symbol: c.m.symbol, bid: d?.bid ?? null, ask: d?.ask ?? null, error: r.envelope?.ok === true ? null : `${r.envelope?.error?.code ?? `exit ${r.exitCode}`}: ${r.envelope?.error?.message ?? ""}` });
        if (d !== null && Number(d.bid) > 0 && Number(d.ask) > 0) { pick = c; break; }
      }
      internal("pf-book", "two-sided book for the trade symbol", "preflight", pick !== null ? "pass" : "fail", { books }, [],
        pick !== null ? null : `none of ${ranked.map(c => c.m.symbol).join(", ")} has a two-sided book on ${net} — pass --symbol`);
      if (pick === null) throw new StopRun(`no candidate symbol has a two-sided book on ${opts.venue} ${net}`, "preflight-fail");
      market = pick;
    }
    const m = market.m;
    const sz = market.s;
    symbol = m.symbol;
    const sizingOut = { ...sz, maxUsd: opts.maxUsd, leverage: opts.leverage, marginNeededAtPeakUsd: (sz.unitNotional * 2) / opts.leverage };
    const marginNeeded = sizingOut.marginNeededAtPeakUsd;
    if (leg === null) { report.market = { ...m }; report.sizing = sizingOut; }
    else if (report.hip3 !== null) { report.hip3.market = { ...m }; report.hip3.sizing = sizingOut; }
    const unitOk = sz.unitNotional <= opts.maxUsd;
    internal("pf-sizing", `sizing ${symbol}`, "preflight", unitOk ? "pass" : "fail",
      { unit: sz.unit, unitNotional: Number(sz.unitNotional.toFixed(4)), minNotional: m.minNotional, minNotionalSource: m.minNotionalSource, step: m.step, minSize: m.minSize, tick: m.tick, mark: m.mark },
      [], unitOk ? `unit ${sz.unit} ≈ $${sz.unitNotional.toFixed(2)}; leverage ${opts.leverage}x → peak margin ≈ $${marginNeeded.toFixed(2)} (position + one resting order)` : `minimum order notional $${sz.unitNotional.toFixed(2)} > --max-usd ${opts.maxUsd} — refusing`);
    if (!unitOk) throw new StopRun(`unit notional $${sz.unitNotional.toFixed(2)} exceeds --max-usd ${opts.maxUsd}`, "preflight-fail");
    // --leverage is sent as-is by t-leverage and sizes the margin estimate: above the market's maximum the venue would refuse it.
    if (opts.phases.includes("trade") && m.maxLeverage !== null && opts.leverage > m.maxLeverage) {
      const msg = `--leverage ${opts.leverage} > ${symbol} maximum leverage ${m.maxLeverage} on ${opts.venue}${opts.dex !== null ? ` (dex ${opts.dex})` : ""} — pass a lower --leverage or another --symbol`;
      internal("pf-leverage", `leverage ${opts.leverage}x on ${symbol}`, "preflight", "fail", { leverage: opts.leverage, maxLeverage: m.maxLeverage }, [], msg);
      throw new StopRun(msg, "preflight-fail");
    }

    // Lighter family: live collateral minimums (public). Enforced on the withdraw amount and the spot quote move.
    let lighterMins: { symbol: string; minTransfer: number; minWithdrawal: number } | null = null;
    if (leg === null && [profile.deposit[net], profile.withdraw[net]].some(r => r.kind === "cli" && r.liveMin === "lighterAssetDetails")) {
      const assetId = def.networks[net].collateralAssetIndex;
      const url = `${def.networks[net].restUrl}/api/v1/assetDetails?asset_id=${assetId}`;
      try {
        if (assetId === null) throw new Error(`${opts.venue} ${net} venue definition has no collateralAssetIndex`);
        lighterMins = lighterAssetMinimums(await fetchJsonRetry(url), assetId);
        internal("pf-funding-mins", "collateral minimums (assetDetails, live)", "preflight", "observed", { ...lighterMins, source: url }, [],
          `min transfer ${lighterMins.minTransfer} ${lighterMins.symbol}, min withdrawal ${lighterMins.minWithdrawal} ${lighterMins.symbol}`);
      } catch (e) {
        const msg = `cannot read ${opts.venue} collateral minimums (${url}): ${(e as Error).message}`;
        const needed = opts.phases.includes("withdraw") || opts.phases.includes("spot");
        internal("pf-funding-mins", "collateral minimums (assetDetails, live)", "preflight", needed ? "fail" : "observed", { error: String(e), source: url }, [], msg);
        if (needed) throw new StopRun(msg, "preflight-fail");
      }
    }

    // CLI public read path (keyless). Non-fatal: records what the CLI returns.
    {
      const r = await runCli([...globals, "market", "list"], { timeoutMs: 120_000, env: childEnv });
      const env = r.envelope;
      const data = env?.ok === true ? env.data : null;
      const count = Array.isArray(data) ? data.length : data !== null && typeof data === "object" ? Object.keys(data as object).length : null;
      const outcome = env?.ok === true && count !== null && count > 0 ? "pass" : "observed";
      const note = env === null ? `no envelope (exit ${r.exitCode})` : !env.ok ? `${env.error?.code}: ${env.error?.message}` : count === 0 ? "ok but EMPTY market list (keyless adapter?) — Rule #2 suspect" : null;
      record({ id: "pf-cli-markets", title: "CLI market list (keyless)", phase: "preflight", outcome, command: cmd(["market", "list"]), worstCaseNotionalUsd: null, settles: [], note, exitCode: r.exitCode, durationMs: r.durationMs, envelope: env !== null && env.ok ? { ok: true, data: `(${count} markets)` } : env, stderrTail: r.stderr.split("\n").slice(-5).join("\n"), observations: { count } });
      console.log(`  ${outcome === "pass" ? "✓" : "•"}  pf-cli-markets: ${note ?? `${count} markets`}`);
    }

    // Venue-specific public observations.
    if (opts.dex !== null) {
      try {
        const coin = `${opts.dex}:${symbol}`;
        const hist = await fetchJson(HL_INFO[net], { type: "fundingHistory", coin, startTime: Date.now() - 12 * 3600_000 }) as Array<{ time: number; fundingRate: string }>;
        const gaps = hist.slice(1).map((h, i) => (h.time - hist[i].time) / 3600_000).sort((a, b) => a - b);
        const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null;
        internal("pf-funding", `HIP-3 ${coin} funding interval`, "preflight", "observed", { samples: hist.length, medianIntervalHours: median, declaredBasis: def.fundingRateBasis, onlyIsolated: m.onlyIsolated }, ["#11"],
          median === null ? "no funding samples" : `median interval ${median.toFixed(2)} h (declared basis: 1h)`);
      } catch (e) {
        internal("pf-funding", "HIP-3 funding interval", "preflight", "observed", { error: String(e) }, ["#11"]);
      }
    }
    if (opts.venue === "lighter-rh") {
      try {
        const lighterDef = await loadVenueDef("lighter");
        const [rh, main] = await Promise.all([def.publicData.fetchFundingRates(net), lighterDef.publicData.fetchFundingRates(net)]);
        const pick = (rows: DistFunding[]) => rows.filter(r => ["ETH", "BTC", "SOL", "TSLA"].includes(String(r.symbol))).map(r => ({ symbol: r.symbol, rate: r.fundingRate ?? r.rate ?? null }));
        internal("pf-rh-funding", "Lighter RH vs Lighter funding rates (basis 8h check)", "preflight", "observed", { declaredBasis: def.fundingRateBasis, rh: pick(rh), lighter: pick(main) }, ["#1"],
          "compare RH rate vs premium/main venue; confirm 8h basis by hand");
      } catch (e) {
        internal("pf-rh-funding", "Lighter RH funding comparison", "preflight", "observed", { error: String(e) }, ["#1"]);
      }
    }

    // Authenticated preflight (live only).
    let venueFlatAtStart = false;
    let foreignOrdersAtStart = 0;
    let equityStart: number | null = null;
    /** "imported" = every agent on this network was imported from the venue website (no master here). */
    let agentSource: "approved" | "imported" | null = null;
    const positionsEnv = async (id: string, phase: string): Promise<Array<{ symbol: string; side: string; size: string }>> => {
      const env = await step({ id, title: "read positions", phase, args: ["account", "positions"], write: false, worstCase: null, settles: [], expect: "ok" });
      if (env === null) return [];
      const d = env.data as unknown;
      const arr = Array.isArray(d) ? d : (d as { main?: unknown[] }).main ?? [];
      return arr as Array<{ symbol: string; side: string; size: string }>;
    };
    const ordersEnv = async (id: string, phase: string): Promise<Array<{ orderId: string; symbol: string; side: string; price: string; size: string; type: string }>> => {
      const env = await step({ id, title: "read open orders", phase, args: ["account", "orders"], write: false, worstCase: null, settles: [], expect: "ok" });
      if (env === null) return [];
      const d = env.data as unknown;
      const arr = Array.isArray(d) ? d : (d as { main?: unknown[] }).main ?? [];
      return arr as Array<{ orderId: string; symbol: string; side: string; price: string; size: string; type: string }>;
    };
    const onSym = <T extends { symbol: string }>(rows: T[]): T[] => rows.filter(r => norm(r.symbol) === norm(symbol!));
    const signedPos = (rows: Array<{ symbol: string; side: string; size: string }>): number =>
      onSym(rows).reduce((a, p) => a + (p.side === "short" ? -1 : 1) * Math.abs(Number(p.size)), 0);
    const tol = Number(m.step) / 2 + 1e-12;
    /**
     * Symbol position re-read (≤ SETTLE_TIMEOUT_MS) until it is within `tol` of `want`: venue
     * account reads can lag a verified fill (Lighter testnet: 0 right after a final 0.09 fill,
     * 0.09 seconds later). Only reads are repeated — never a write.
     */
    const settledPos = async (id: string, phase: string, want: number): Promise<number> =>
      (await pollUntil(async i => signedPos(await positionsEnv(i === 0 ? id : `${id}-poll${i}`, phase)), p => !live || Math.abs(p - want) <= tol)).value;
    const equityOf = async (id: string, phase: string): Promise<number | null> => {
      const env = await step({ id, title: "portfolio snapshot", phase, args: ["portfolio"], write: false, worstCase: null, settles: [], expect: "ok" });
      if (env === null) return null;
      const ex = ((env.data as { exchanges?: Array<{ perp: { equity: string } | null }> }).exchanges ?? [])[0];
      return ex?.perp !== null && ex?.perp !== undefined ? Number(ex.perp.equity) : null;
    };

    if (live) {
      const agentVenue = profile.cliVenue;
      // Agents may be approved here (master on this machine) or imported from the venue website
      // (`wallet agent import`, master known only by address). Both are accepted.
      const listEnv = await step({ id: "pf-agent-list", title: `wallet agent list ${agentVenue}`, phase: "preflight", args: ["wallet", "agent", "list", agentVenue], write: false, worstCase: null,
        settles: [], expect: "ok", observe: env => ({ agents: env.data ?? null }) });
      const rows = (listEnv?.data ?? []) as Array<{ name: string; network: string | null; source?: string }>;
      const onNet = rows.filter(r => r.network === net);
      agentSource = onNet.length > 0 && onNet.every(r => r.source === "imported") ? "imported" : onNet.length > 0 ? "approved" : null;
      internal("pf-agent-source", `agent source on ${net}`, "preflight", agentSource === null ? "fail" : "observed", { agentSource, agents: onNet.map(r => r.name) }, [],
        agentSource === null ? `no ${agentVenue} agent on ${net}: perp${net === "testnet" ? " -n testnet" : ""} wallet agent approve|import ${agentVenue}` : null);
      if (agentSource === null) throw new StopRun(`no ${agentVenue} agent registered on ${net}`, "preflight-fail");
      // An imported Pacifica agent cannot be verified without the master (NO_SIGNER_AVAILABLE) — accepted, recorded.
      await step({ id: "pf-agent-verify", title: `wallet agent verify ${agentVenue}`, phase: "preflight", args: ["wallet", "agent", "verify", agentVenue], write: false, worstCase: null,
        settles: ["#2", "#4", "#8"],
        // Aster has no endpoint that lists approved agents: verify is NOT_IMPLEMENTED by design; the
        // signed pf-portfolio read below is what proves the agent there.
        expect: opts.venue === "aster" ? ["ok", "NOT_IMPLEMENTED"] : agentSource === "imported" ? ["ok", "NO_SIGNER_AVAILABLE"] : "ok",
        note: "fails with AGENT_NOT_REGISTERED / 403 (arcus whitelist) → fix prerequisites first; an imported key whose venue verifies only with the master → NO_SIGNER_AVAILABLE (accepted)" });
      equityStart = await equityOf("pf-portfolio", "preflight");
      internal("pf-equity", "starting equity", "preflight", "observed", { equity: equityStart }, ["#4", "#8"], `venue account equity $${equityStart}`);
      // Mainnet: on-chain balances of the wallet the CLI deposit is sent from (read-only RPC).
      const depRoute = profile.deposit[net];
      if (leg === null && net === "mainnet" && depRoute.kind === "cli" && depRoute.wallet !== null) {
        const w = depRoute.wallet;
        const depositing = opts.phases.includes("deposit");
        let problem: string | null;
        try {
          const address = await masterAddress(w.kind);
          const bal = await walletBalances(def, w, address);
          const fault = depositWalletProblem({ amount: depositing && opts.depositAmount !== null ? Number(opts.depositAmount) : null, asset: w.asset, tokenBalance: bal.token, gasAsset: w.gasAsset, gasBalance: bal.gas, minGas: w.minGas });
          problem = depositing ? fault : null;
          internal("pf-wallet", `deposit wallet on ${w.chain}`, "preflight", problem !== null ? "fail" : "observed",
            { address, chain: w.chain, asset: w.asset, tokenBalance: bal.token, gasAsset: w.gasAsset, gasBalance: bal.gas, rpcUrl: bal.rpcUrl, token: bal.tokenAddress, venueEquity: equityStart }, [],
            `${address} on ${w.chain}: ${bal.token} ${w.asset}, ${bal.gas} ${w.gasAsset} (gas); venue account equity $${equityStart}${fault !== null ? ` — ${fault}` : ""}`);
        } catch (e) {
          problem = `cannot read the deposit wallet on ${w.chain}: ${(e as Error).message}`;
          internal("pf-wallet", `deposit wallet on ${w.chain}`, "preflight", depositing ? "fail" : "observed", { error: String(e) }, [], problem);
          if (!depositing) problem = null;
        }
        if (problem !== null) throw new StopRun(problem, "preflight-fail");
      }
      // A HIP-3 dex has its own collateral on a standard (non-unified) HL account: with none on the
      // dex every order is refused ("Insufficient margin") — say so here, not at the first order.
      if (leg === "hip3" && opts.phases.includes("trade") && equityStart !== null && equityStart < marginNeeded) {
        const msg = `dex ${opts.dex} equity $${equityStart} < $${marginNeeded.toFixed(2)} needed — no collateral on the HIP-3 dex (standard account: move USDC to the dex on the HL app, or switch the account to unified mode)`;
        internal("pf-dex-collateral", `collateral on dex ${opts.dex}`, "preflight", "fail", { equity: equityStart, needed: marginNeeded }, [], msg);
        throw new StopRun(msg, "preflight-fail");
      }
      const pos = await positionsEnv("pf-positions", "preflight");
      const ords = await ordersEnv("pf-orders", "preflight");
      venueFlatAtStart = pos.filter(p => Number(p.size) !== 0).length === 0 && ords.length === 0;
      foreignOrdersAtStart = ords.length - onSym(ords).length;
      const symFlat = signedPos(pos) === 0 && onSym(ords).length === 0;
      internal("pf-flat", `${symbol} flat before start`, "preflight", symFlat ? "pass" : "fail", { venueFlatAtStart, positions: pos.length, orders: ords.length }, [],
        symFlat ? null : `existing ${symbol} position/orders — close them or pick another --symbol`,
        [{ name: "symbol flat", ok: symFlat, detail: `position ${signedPos(pos)}, orders ${onSym(ords).length}` }]);
      if (!symFlat) throw new StopRun(`${symbol} is not flat on ${opts.venue}`, "preflight-fail");
      const q = await runCli(["--json", "strategy", "quarantine"], { timeoutMs: 30_000, env: childEnv });
      const entries = ((q.envelope?.data as { entries?: Array<{ symbol: string }> } | undefined)?.entries ?? []);
      const blocked = entries.filter(e => norm(e.symbol) === norm(symbol!));
      internal("pf-quarantine", "quarantine list", "preflight", blocked.length === 0 ? "pass" : "fail", { entries }, [], blocked.length === 0 ? null : `${symbol} is quarantined — resolve, then perp strategy quarantine-clear ${symbol}`);
      if (blocked.length > 0) throw new StopRun(`${symbol} is quarantined`, "preflight-fail");
      if (opts.venue === "lighter" || opts.venue === "lighter-rh") {
        // No -e → every configured venue in ONE process (lighter + lighter-rh WASM runtimes side by side).
        const r = await runCli(["--json", "-n", net, "account", "positions"], { timeoutMs: 180_000, env: childEnv });
        internal("pf-wasm-isolation", "positions without -e (all venues, one process)", "preflight", "observed",
          { exit: r.exitCode, errors: (r.envelope?.data as { errors?: unknown } | undefined)?.errors ?? null, ok: r.envelope?.ok ?? null }, ["#3"]);
      }
    } else {
      const depRoute = profile.deposit[net];
      if (leg === null && net === "mainnet" && depRoute.kind === "cli" && depRoute.wallet !== null) {
        internal("pf-wallet", `deposit wallet on ${depRoute.wallet.chain}`, "preflight", "planned", { wallet: depRoute.wallet }, [],
          `live run reads the master wallet's ${depRoute.wallet.asset} + ${depRoute.wallet.gasAsset} (gas) on ${depRoute.wallet.chain} (read-only RPC) and the venue equity; --deposit-amount above the balance or gas 0 / under ${depRoute.wallet.minGas} → refused`);
      }
      internal("pf-auth", "authenticated checks", "preflight", "planned", {}, ["#2", "#4", "#8"],
        `live run will: ${cmd(["wallet", "agent", "list", profile.cliVenue])} (approved or imported agent); ${cmd(["wallet", "agent", "verify", profile.cliVenue])}; ${cmd(["portfolio"])}; ${cmd(["account", "positions"])}; ${cmd(["account", "orders"])}; perp --json strategy quarantine`);
    }

    // ── T: trade ────────────────────────────────────────────────────────
    if (opts.phases.includes("trade")) {
      // The trade phase runs `trade cancel-all`, which is account-wide: refuse to start it on an
      // account that already has resting orders on other symbols (positions are not touched by it).
      if (live && foreignOrdersAtStart > 0) {
        throw new StopRun(`the ${opts.venue} account has ${foreignOrdersAtStart} open order(s) on other symbols — the trade phase's cancel-all would cancel them. Cancel them by hand first`, "preflight-fail");
      }
      console.log("\n[trade]");
      const S = symbol;
      const unitN = sz.unitNotional;
      const alo = caps.timeInForce.includes("ALO");
      const isLighter = opts.venue === "lighter" || opts.venue === "lighter-rh";
      const isolated = opts.isolated || m.onlyIsolated === true;
      const PH = "trade";
      let marketOrderId: string | null = null;
      let orderIdOf = (env: Envelope | null, fallback: string): string => {
        const d = env?.data as { orderId?: string | null; clientOrderId?: string | null } | undefined;
        if (d?.orderId !== undefined && d.orderId !== null) return d.orderId;
        if (d?.clientOrderId !== undefined && d.clientOrderId !== null) return `c:${d.clientOrderId}`;
        return fallback;
      };
      if (!live) orderIdOf = (_e, fallback) => fallback;
      const statusOf = (env: Envelope): string => String((env.data as { status?: string }).status);
      const filledOf = (env: Envelope): number => Number((env.data as { filledSize?: string | null }).filledSize ?? NaN);

      if (live) cleanupTrade = { symbol: S, cancelAll: venueFlatAtStart };
      await step({ id: "t-leverage", title: `set leverage ${opts.leverage}x ${isolated ? "isolated" : "cross"}`, phase: PH, args: ["trade", "leverage", S, String(opts.leverage), ...(isolated ? ["--isolated"] : [])], write: true, worstCase: null, settles: [], expect: "ok" });

      // A. Resting / non-crossing orders while flat (worst case = that order filling).
      const gtc = await step({ id: "t-limit-gtc", title: "limit GTC far from market", phase: PH, args: ["trade", "limit", S, "buy", sz.farBuyPrice, sz.farBuySize, "--tif", "GTC"], write: true,
        worstCase: Number(sz.farBuySize) * Number(sz.farBuyPrice), settles: [], expect: "ok",
        check: env => [{ name: "rests (open/accepted)", ok: ["open", "accepted"].includes(statusOf(env)), detail: statusOf(env) }],
        observe: env => ({ execution: (env.data as { execution?: unknown }).execution }) });
      const gtcTif = live && gtc !== null ? ((gtc.data as { execution?: { tifSent?: string | null } }).execution?.tifSent ?? null) : null;
      let gtcId = orderIdOf(gtc, "<gtcOrderId>");

      // Status lookup right after placement (async venues: /v1/order 404 window).
      if (live && gtc !== null) {
        const t0 = Date.now();
        let firstOk: number | null = null;
        let lastEnv: Envelope | null = null;
        for (let i = 0; i < (caps.orderAck === "async" ? 10 : 1); i++) {
          await pace();
          const r = await runCli([...globals, "trade", "status", gtcId, "--symbol", S], { timeoutMs: 60_000, env: childEnv });
          lastEnv = r.envelope;
          if (r.envelope?.ok === true) { firstOk = Date.now() - t0; break; }
          await new Promise(res => setTimeout(res, 1000));
        }
        internal("t-status-after-place", "trade status right after placement", PH, "observed", { msUntilFound: firstOk, last: lastEnv }, ["#9"],
          firstOk === null ? "order not found via trade status within the poll window" : null);
      } else if (!live) {
        record({ id: "t-status-after-place", title: "trade status right after placement (poll on async venues)", phase: PH, outcome: "planned", command: cmd(["trade", "status", gtcId, "--symbol", S]), worstCaseNotionalUsd: null, settles: ["#9"], note: null });
      }
      const ordsAfterGtc = await ordersEnv("t-orders-gtc", PH);
      if (live && !wasSkipped("t-limit-gtc")) {
        const hit = ordsAfterGtc.find(o => o.orderId === gtcId.replace(/^c:/, ""));
        internal("t-orders-gtc-check", "GTC order listed in account orders", PH, hit !== undefined ? "pass" : "fail", { order: hit ?? null }, [], null,
          [{ name: "listed", ok: hit !== undefined || gtcId.startsWith("c:"), detail: hit !== undefined ? `${hit.price} x ${hit.size}` : "not found" }]);
        if (hit === undefined && !gtcId.startsWith("c:")) throw new StopRun("GTC order not listed in account orders", "fail");
      }

      const edit = await step({ id: "t-edit", title: "edit price + size (keeps TIF)", phase: PH, args: ["trade", "edit", S, gtcId, sz.farBuyPrice2, sz.farBuySize2], write: true,
        // An edit REPLACES the resting order: only the difference adds exposure.
        worstCase: Number(sz.farBuySize2) * Number(sz.farBuyPrice2), offsetUsd: Number(sz.farBuySize) * Number(sz.farBuyPrice), needs: ["t-limit-gtc"],
        settles: ["#5", "#9", "#14", "#15", "#16"], expect: "ok",
        check: env => {
          const e = (env.data as { execution?: { method?: string; tifSent?: string | null } }).execution;
          const out: Assertion[] = [{ name: "execution method recorded", ok: typeof e?.method === "string", detail: String(e?.method) }];
          if (opts.venue !== "pacifica" && gtcTif !== null && e?.tifSent !== undefined && e.tifSent !== null) {
            out.push({ name: "TIF preserved", ok: e.tifSent === gtcTif, detail: `${gtcTif} → ${e.tifSent}` });
          }
          return out;
        },
        observe: env => ({ newOrderId: (env.data as { orderId?: unknown }).orderId, oldOrderId: gtcId, execution: (env.data as { execution?: unknown }).execution, venueRaw: (env.data as { venueRaw?: unknown }).venueRaw }),
        note: opts.venue === "pacifica" ? "pacifica edit re-creates as ALO — TIF change is observed, not asserted" : undefined });
      gtcId = orderIdOf(edit, gtcId);
      if (live && !wasSkipped("t-edit")) {
        const ords = await ordersEnv("t-orders-edit", PH);
        const hit = ords.find(o => o.orderId === gtcId.replace(/^c:/, ""));
        const priceOk = hit !== undefined && Math.abs(Number(hit.price) - Number(sz.farBuyPrice2)) <= Number(m.tick ?? "0") + Number(sz.farBuyPrice2) * 1e-9 + 1e-12;
        const sizeOk = hit !== undefined && Math.abs(Number(hit.size) - Number(sz.farBuySize2)) <= tol;
        internal("t-edit-check", "edited order shows new price/size", PH, priceOk && sizeOk ? "pass" : "fail", { order: hit ?? null }, [], null,
          [{ name: "new price", ok: priceOk, detail: `${hit?.price} vs ${sz.farBuyPrice2}` }, { name: "new size", ok: sizeOk, detail: `${hit?.size} vs ${sz.farBuySize2}` }]);
        if (!(priceOk && sizeOk)) throw new StopRun("edited order does not show the new price/size", "fail");
      }
      await step({ id: "t-cancel", title: "cancel the edited order", phase: PH, args: ["trade", "cancel", S, gtcId], write: true, worstCase: null, needs: ["t-limit-gtc"], settles: ["#14", "#20"], expect: "ok",
        check: env => [{ name: "cancel proven", ok: Array.isArray((env.data as { cancelled?: unknown[] }).cancelled) && ((env.data as { cancelled: unknown[] }).cancelled.length > 0), detail: JSON.stringify((env.data as { cancelled?: unknown }).cancelled) }] });
      if (live && !wasSkipped("t-cancel")) {
        const ords = await ordersEnv("t-orders-cancel", PH);
        const still = ords.find(o => o.orderId === gtcId.replace(/^c:/, ""));
        internal("t-cancel-check", "order gone after cancel", PH, still === undefined ? "pass" : "fail", {}, [], null, [{ name: "gone", ok: still === undefined, detail: still !== undefined ? "still open" : "gone" }]);
        if (still !== undefined) throw new StopRun("cancelled order still listed", "fail");
      }

      if (alo) {
        const a = await step({ id: "t-limit-alo", title: "limit ALO (post-only) far from market", phase: PH, args: ["trade", "limit", S, "buy", sz.farBuyPrice, sz.farBuySize, "--tif", "ALO"], write: true,
          worstCase: Number(sz.farBuySize) * Number(sz.farBuyPrice), settles: ["#15"], expect: "ok",
          check: env => [{ name: "rests", ok: ["open", "accepted"].includes(statusOf(env)), detail: statusOf(env) }] });
        await step({ id: "t-cancel-alo", title: "cancel ALO order", phase: PH, args: ["trade", "cancel", S, orderIdOf(a, "<aloOrderId>")], write: true, worstCase: null, needs: ["t-limit-alo"], settles: [], expect: "ok" });
        // Crossing post-only must be refused, never filled.
        let crossPrice = priceAt(m, opts, 1.005, "up");
        if (live) {
          const mid = await step({ id: "t-mid", title: "best bid/ask", phase: PH, args: ["market", "mid", S], write: false, worstCase: null, settles: [], expect: "ok" });
          const ask = Number((mid?.data as { ask?: string | null } | undefined)?.ask ?? NaN);
          if (Number.isFinite(ask) && ask > 0) crossPrice = priceAt({ ...m, mark: ask }, opts, 1.002, "up");
        }
        const sizeCross = sizeFor(m, opts, Number(crossPrice));
        await step({ id: "t-alo-cross", title: "ALO crossing the ask → must be rejected", phase: PH, args: ["trade", "limit", S, "buy", crossPrice, sizeCross, "--tif", "ALO"], write: true,
          worstCase: Number(sizeCross) * Number(crossPrice), settles: ["#14", "#15"], expect: "observe",
          check: env => {
            const filled = env.ok ? filledOf(env) : 0;
            const rested = env.ok && ["open", "accepted"].includes(statusOf(env));
            return [{ name: "not filled", ok: !(filled > 0), detail: env.ok ? `status ${statusOf(env)} filled ${filled}` : `${env.error?.code}` },
              { name: "not resting (crossing post-only)", ok: !rested, detail: rested ? "post-only order RESTED at a crossing price — cancel it by hand" : "refused" }];
          } });
      } else {
        await step({ id: "t-limit-alo", title: "ALO declared unsupported → uniform refusal", phase: PH, args: ["trade", "limit", S, "buy", sz.farBuyPrice, sz.farBuySize, "--tif", "ALO"], write: true,
          worstCase: Number(sz.farBuySize) * Number(sz.farBuyPrice), settles: ["#13"], expect: ["CAPABILITY_UNSUPPORTED"] });
      }

      const iocPrice = sz.farSellPrice;
      await step({ id: "t-ioc-nomatch", title: "IOC sell far above market → no fill, definite", phase: PH, args: ["trade", "limit", S, "sell", iocPrice, sz.unit, "--tif", "IOC"], write: true,
        worstCase: Number(sz.unit) * Number(iocPrice), settles: ["#17", "#20"], expect: "observe",
        check: env => {
          const filled = env.ok ? filledOf(env) : 0;
          return [{ name: "no fill", ok: !(filled > 0), detail: env.ok ? `status ${statusOf(env)} filled ${filled}` : `${env.error?.code}: ${env.error?.message}` },
            { name: "definite outcome", ok: env.ok ? ["cancelled", "rejected"].includes(statusOf(env)) || filled === 0 : isDefiniteRejection(env), detail: env.ok ? statusOf(env) : String(env.error?.code) }];
        },
        observe: env => ({ code: env.ok ? null : env.error?.code, message: env.ok ? null : env.error?.message }) });
      if (live) {
        const p = await settledPos("t-pos-after-ioc", PH, 0);
        internal("t-flat-check-1", "still flat after resting/IOC tests", PH, Math.abs(p) <= tol ? "pass" : "fail", { position: p }, [], null, [{ name: "flat", ok: Math.abs(p) <= tol, detail: String(p) }]);
        if (Math.abs(p) > tol) throw new StopRun(`unexpected position ${p} after non-crossing tests`, "fail");
      }

      // B. Entry with --tp/--sl from flat (1 unit), verify legs, cancel-all, close.
      const entry = await step({ id: "t-entry-tpsl", title: "market entry with --tp/--sl", phase: PH, args: ["trade", "market", S, "buy", sz.unit, "--tp", sz.tp, "--sl", sz.sl, "--slippage-bps", String(opts.slippageBps)], write: true,
        worstCase: unitN * (1 + opts.slippageBps / 10_000), settles: ["#9", "#15", "#18"], expect: "ok",
        check: env => {
          const d = env.data as { tpsl?: { method?: string; legs?: Array<{ kind: string; status?: string }> }; verifiedFilledSize?: string; filledSize?: string | null };
          const out: Assertion[] = [];
          if (caps.tpsl === "separateOrders" || caps.tpsl === "positionLevel") {
            out.push({ name: "tpsl method", ok: d.tpsl?.method === caps.tpsl, detail: String(d.tpsl?.method) });
            out.push({ name: "verified fill > 0", ok: Number(d.verifiedFilledSize) > 0, detail: String(d.verifiedFilledSize) });
          }
          if (caps.tpsl === "separateOrders") {
            const kinds = (d.tpsl?.legs ?? []).map(l => l.kind).sort().join(",");
            out.push({ name: "legs tp + sl", ok: kinds === "sl,tp", detail: kinds });
            out.push({ name: "no rejected leg", ok: (d.tpsl?.legs ?? []).every(l => l.status !== "rejected"), detail: JSON.stringify((d.tpsl?.legs ?? []).map(l => l.status)) });
          }
          return out;
        },
        observe: env => ({ tpsl: (env.data as { tpsl?: unknown }).tpsl, execution: (env.data as { execution?: unknown }).execution }) });
      if (live && !wasSkipped("t-entry-tpsl")) {
        const d = entry?.data as { verifiedFilledSize?: string; filledSize?: string | null } | undefined;
        const want = Number(d?.verifiedFilledSize ?? d?.filledSize ?? NaN);
        const p = await settledPos("t-pos-entry", PH, want);
        internal("t-entry-pos-check", "position == verified entry fill", PH, Math.abs(p - want) <= tol ? "pass" : "fail", { position: p, fill: want }, [], null, [{ name: "delta", ok: Math.abs(p - want) <= tol, detail: `${p} vs ${want}` }]);
        if (Math.abs(p - want) > tol) throw new StopRun(`position ${p} != verified fill ${want}`, "fail");
        const ords = onSym(await ordersEnv("t-orders-entry", PH));
        const legsVisible = caps.tpsl === "positionLevel" ? true : ords.length >= 2;
        internal("t-entry-legs-visible", "TP/SL legs visible as orders", PH, legsVisible ? "pass" : "observed", { orders: ords }, ["#6", "#9", "#15"],
          caps.tpsl === "positionLevel" ? "position-level TP/SL (not listed as orders)" : legsVisible ? null : `only ${ords.length} order(s) on ${S} — check venue UI`);
      }
      await step({ id: "t-tpsl-crossed", title: "TP below mark on a long → refused before sending", phase: PH, args: ["trade", "tpsl", S, "long", "--tp", sz.tpCrossed], write: true, worstCase: null, needs: ["t-entry-tpsl"],
        settles: ["#18"], expect: ["INVALID_PARAMS", "ORDER_PARTIAL", "ORDER_REJECTED"] });
      await step({ id: "t-cancel-all-1", title: "cancel-all (removes TP/SL legs)", phase: PH, args: ["trade", "cancel-all"], write: true, worstCase: null, settles: ["#21"], expect: "ok" });
      if (live) {
        const left = onSym(await ordersEnv("t-orders-after-cancel-all-1", PH));
        internal("t-cancel-all-1-check", "no open orders on symbol", PH, left.length === 0 ? "pass" : caps.tpsl === "positionLevel" ? "observed" : "fail", { left }, [], null,
          caps.tpsl === "positionLevel" ? [] : [{ name: "no orders", ok: left.length === 0, detail: `${left.length} left` }]);
        if (left.length > 0 && caps.tpsl !== "positionLevel") throw new StopRun("orders remain after cancel-all", "fail");
      }
      await step({ id: "t-close-1", title: "close (verified reduce-only)", phase: PH, args: ["trade", "close", S, "--slippage-bps", String(opts.slippageBps)], write: true, worstCase: null, needs: ["t-entry-tpsl"], settles: ["#5"], expect: "ok" });
      if (live) {
        const p = await settledPos("t-pos-close-1", PH, 0);
        internal("t-close-1-check", "flat after close", PH, Math.abs(p) <= tol ? "pass" : "fail", { position: p }, [], null, [{ name: "flat", ok: Math.abs(p) <= tol, detail: String(p) }]);
        if (Math.abs(p) > tol) throw new StopRun(`not flat after close (${p})`, "fail");
      }

      // C. Plain market buy (1 unit) → cancel semantics, stop, tpsl, reduce, close.
      const mkt = await step({ id: "t-market-buy", title: "market buy (protected IOC)", phase: PH, args: ["trade", "market", S, "buy", sz.unit, "--slippage-bps", String(opts.slippageBps)], write: true,
        worstCase: unitN * (1 + opts.slippageBps / 10_000), settles: ["#16", "#17"], expect: "ok",
        check: env => [
          { name: "filled/partiallyFilled", ok: ["filled", "partiallyFilled"].includes(statusOf(env)), detail: statusOf(env) },
          { name: "finality final", ok: (env.data as { finality?: string }).finality === "final", detail: String((env.data as { finality?: string }).finality) },
          { name: "filledSize reported", ok: Number.isFinite(filledOf(env)) && filledOf(env) > 0, detail: String((env.data as { filledSize?: unknown }).filledSize) },
        ],
        observe: env => ({ execution: (env.data as { execution?: unknown }).execution, durationNote: "see durationMs (lighter /tx COMMITTED→EXECUTED)" }) });
      if (live && mkt !== null) {
        marketOrderId = (mkt.data as { orderId?: string | null }).orderId ?? null;
        const f = filledOf(mkt);
        const p = await settledPos("t-pos-market", PH, f);
        internal("t-market-pos-check", "position delta == filledSize", PH, Math.abs(p - f) <= tol ? "pass" : "fail", { position: p, filledSize: f }, ["#16", "#17"], null, [{ name: "delta", ok: Math.abs(p - f) <= tol, detail: `${p} vs ${f}` }]);
        if (Math.abs(p - f) > tol) throw new StopRun(`position ${p} != filledSize ${f}`, "fail");
      }
      if (marketOrderId !== null || !live) {
        await step({ id: "t-cancel-filled", title: "cancel the already-filled market order → must NOT be reported cancelled", phase: PH, args: ["trade", "cancel", S, marketOrderId ?? "<marketOrderId>"], write: true, worstCase: null,
          settles: ["#17", "#21"], expect: "observe",
          check: env => {
            const c = env.ok ? ((env.data as { cancelled?: Array<{ value: string }> }).cancelled ?? []) : [];
            return [{ name: "no false cancel proof", ok: c.length === 0, detail: env.ok ? `cancelled=${JSON.stringify(c)}` : `${env.error?.code}` }];
          } });
      }
      await step({ id: "t-cancel-unknown", title: "cancel a non-existent order id → not reported cancelled", phase: PH, args: ["trade", "cancel", S, "999999999"], write: true, worstCase: null,
        settles: ["#21"], expect: "observe",
        check: env => {
          const c = env.ok ? ((env.data as { cancelled?: unknown[] }).cancelled ?? []) : [];
          return [{ name: "no false cancel proof", ok: c.length === 0, detail: env.ok ? `cancelled=${JSON.stringify(c)}` : `${env.error?.code}` }];
        } });

      const stop = await step({ id: "t-stop", title: "stop (reduce-only) below market", phase: PH, args: ["trade", "stop", S, "sell", sz.unit, sz.stopPrice], write: true, worstCase: null, needs: ["t-market-buy"],
        settles: ["#6", "#19"], expect: "ok", observe: env => ({ execution: (env.data as { execution?: unknown }).execution, reduceOnly: (env.data as { reduceOnly?: unknown }).reduceOnly }) });
      const stopId = orderIdOf(stop, "<stopOrderId>");
      if (live && !wasSkipped("t-stop")) {
        const ords = onSym(await ordersEnv("t-orders-stop", PH));
        const hit = ords.find(o => o.orderId === stopId.replace(/^c:/, ""));
        internal("t-stop-visible", "stop visible in open orders", PH, hit !== undefined ? "pass" : opts.venue === "ondo" ? "fail" : "observed", { orders: ords }, ["#6"], hit !== undefined ? null : "stop not in account orders");
        if (hit === undefined && opts.venue === "ondo") throw new StopRun("ondo position stop not visible in GET /v1/perps/orders", "fail");
      }
      if (isLighter) {
        await step({ id: "t-edit-stop", title: "edit a trigger order → uniform refusal", phase: PH, args: ["trade", "edit", S, stopId, sz.stopPrice2, sz.unit], write: true, worstCase: null, needs: ["t-stop"],
          settles: ["#19"], expect: ["CAPABILITY_UNSUPPORTED"] });
      }
      await step({ id: "t-cancel-stop", title: "cancel the stop", phase: PH,
        args: opts.venue === "pacifica" ? ["trade", "cancel-stop", S, stopId] : ["trade", "cancel", S, stopId], write: true, worstCase: null, needs: ["t-stop"], settles: ["#19", "#21"], expect: "ok" });

      await step({ id: "t-tpsl", title: "tpsl on the open position", phase: PH, args: ["trade", "tpsl", S, "long", "--tp", sz.tp, "--sl", sz.sl], write: true, worstCase: null, needs: ["t-market-buy"],
        settles: ["#9", "#14", "#15", "#18"], expect: "ok",
        check: env => {
          const d = env.data as { method?: string; legs?: Array<{ kind: string }> };
          const out: Assertion[] = [{ name: "method", ok: d.method === caps.tpsl, detail: String(d.method) }];
          if (caps.tpsl === "separateOrders") out.push({ name: "legs tp + sl", ok: (d.legs ?? []).map(l => l.kind).sort().join(",") === "sl,tp", detail: JSON.stringify((d.legs ?? []).map(l => l.kind)) });
          return out;
        },
        observe: env => ({ legs: (env.data as { legs?: unknown }).legs }) });
      if (opts.venue === "pacifica") {
        await step({ id: "t-tpsl-overwrite", title: "tpsl again with new prices (overwrite?)", phase: PH, args: ["trade", "tpsl", S, "long", "--tp", priceAt(m, opts, 1 + sz.farPct / 100 * 1.2, "up"), "--sl", sz.stopPrice2], write: true, worstCase: null, needs: ["t-tpsl"],
          settles: ["#14"], expect: "observe", observe: env => ({ ok: env.ok, data: env.data ?? env.error }) });
      }
      await step({ id: "t-cancel-all-2", title: "cancel-all", phase: PH, args: ["trade", "cancel-all"], write: true, worstCase: null, settles: ["#21"], expect: "ok" });

      const posBeforeReduce = live ? signedPos(await positionsEnv("t-pos-before-reduce", PH)) : 0;
      await step({ id: "t-reduce", title: "reduce 50% (may hit venue min notional on a 1-unit position)", phase: PH, args: ["trade", "reduce", S, "50", "--slippage-bps", String(opts.slippageBps)], write: true, worstCase: null, needs: ["t-market-buy"],
        settles: ["#5"], expect: "observe",
        check: async env => {
          const reduced = env.ok ? Number((env.data as { sizeReduced?: string }).sizeReduced ?? NaN) : 0;
          const after = await settledPos("t-pos-after-reduce", PH, Number.isFinite(reduced) ? posBeforeReduce - reduced : posBeforeReduce);
          if (env.ok) {
            return [{ name: "position reduced by sizeReduced", ok: Math.abs(posBeforeReduce - after - reduced) <= tol, detail: `${posBeforeReduce} → ${after}, sizeReduced ${reduced}` }];
          }
          return [{ name: "definite refusal leaves position unchanged", ok: Math.abs(after - posBeforeReduce) <= tol && isDefiniteRejection(env), detail: `${env.error?.code}; ${posBeforeReduce} → ${after}` }];
        } });
      await step({ id: "t-close-2", title: "close (verified reduce-only)", phase: PH, args: ["trade", "close", S, "--slippage-bps", String(opts.slippageBps)], write: true, worstCase: null, needs: ["t-market-buy"], settles: ["#5"], expect: "ok" });
      if (live) {
        const p = await settledPos("t-pos-close-2", PH, 0);
        internal("t-close-2-check", "flat after close", PH, Math.abs(p) <= tol ? "pass" : "fail", { position: p }, [], null, [{ name: "flat", ok: Math.abs(p) <= tol, detail: String(p) }]);
        if (Math.abs(p) > tol) throw new StopRun(`not flat after close (${p})`, "fail");
      }

      // D. flatten — only when the whole venue account was flat at start (it closes EVERYTHING).
      if (venueFlatAtStart || !live) {
        await step({ id: "t-market-buy-2", title: "market buy (for flatten)", phase: PH, args: ["trade", "market", S, "buy", sz.unit, "--slippage-bps", String(opts.slippageBps)], write: true,
          worstCase: unitN * (1 + opts.slippageBps / 10_000), settles: [], expect: "ok", note: live ? undefined : "only when the venue account is completely flat at start" });
        await step({ id: "t-limit-sell-far", title: "resting sell far above (reduces only if filled)", phase: PH, args: ["trade", "limit", S, "sell", sz.farSellPrice, sz.unit, "--tif", "GTC"], write: true,
          // Against the 1-unit long just bought: a fill closes it, so the long is offset (not added to).
          worstCase: unitN, offsetUsd: unitN, needs: ["t-market-buy-2"], settles: [], expect: "ok" });
        await step({ id: "t-flatten", title: "flatten (cancel all + close all, verified)", phase: PH, args: ["trade", "flatten", "--slippage-bps", String(opts.slippageBps)], write: true, worstCase: null, settles: [], expect: "ok" });
      } else {
        internal("t-flatten", "flatten", PH, "skipped", {}, [], "venue account had other positions/orders at start — flatten would close them");
      }
      if (live) {
        const p = await settledPos("t-final-positions", PH, 0);
        const ords = await ordersEnv("t-final-orders", PH);
        const ok = Math.abs(p) <= tol && onSym(ords).length === 0;
        internal("t-final", "symbol flat, no orders", PH, ok ? "pass" : "fail", { position: p, orders: onSym(ords) }, [], null, [{ name: "clean", ok, detail: `position ${p}, orders ${onSym(ords).length}` }]);
        if (!ok) throw new StopRun("final state not clean", "fail");
      }
      cleanupTrade = null;
    }

    // ── S: spot ─────────────────────────────────────────────────────────
    if (opts.phases.includes("spot")) {
      console.log("\n[spot]");
      const PH = "spot";
      if (def.spot === null || opts.dex !== null) {
        internal("s-none", "spot", PH, "skipped", {}, [], opts.dex !== null ? "HIP-3 dexes have no spot" : `${opts.venue} has no spot definition`);
      } else spotPhase: {
        const sp = def.spot;
        // Without --spot-symbol / --spot-size: the most liquid quote-asset market whose minimum
        // order fits the cap (public data), sized at the venue minimum (pickSpotMarket), whose live book is two-sided (pickSpotMarketWithBook).
        let autoSize: string | null = null;
        let autoSymbol: string | null = null;
        let spotMark: number | null = null; // the picked market's own public spot price
        let spotBookRef: string | null = null; // the picked market's spot book id (values acquired spot for the cap)
        // The venue's spot quote on this network (network-keyed: Lighter RH USDC on testnet, USDG on mainnet) —
        // the same source the CLI's spot-transfer asset comes from (defaultSpotQuote).
        const spotQuote = sp.quoteAssets[net][0];
        if (spotQuote === undefined) throw new StopRun(`${opts.venue} spot definition has no ${net} quote asset`, "preflight-fail");
        if (opts.spotSymbol === null || opts.spotSize === null) {
          const cands = await spotCandidates(def, opts);
          if (cands === null) {
            const hint = profile.spotSymbol[net] !== null ? ` (suggested: --spot-symbol ${profile.spotSymbol[net]})` : "";
            internal("s-pick", "spot market auto-selection", PH, live ? "fail" : "planned", {}, [], `no public spot reader for ${opts.venue} — pass --spot-symbol and --spot-size${hint}`);
            if (live) throw new StopRun(`spot phase on ${opts.venue} needs --spot-symbol and --spot-size (no automatic selection for this venue${hint})`, "preflight-fail");
          } else {
            const pool = opts.spotSymbol !== null ? cands.filter(c => c.symbol.toUpperCase() === opts.spotSymbol!.split("/")[0]) : cands;
            if (pool.length === 1) spotBookRef = pool[0].bookRef;
            // Ranked (profile major first, then volume), then the LIVE book of each in order: two-sided,
            // mid within 2% of the mark — every venue.
            const { pick, rejected } = await pickSpotMarketWithBook(pool, spotQuote, opts.maxUsd, opts.slippageBps, profile.spotSymbol[net], ref => spotBook(def, opts, ref), opts.minUsd);
            // Every quote market refused only for its price / book (none, empty / one-sided, mid off) → venue limitation: SKIP spot.
            const quoted = rejected.filter(r => !r.reason.startsWith("quote "));
            const noBook = pick === null && quoted.length > 0 && quoted.every(r => isBookRejection(r.reason));
            internal("s-pick", "spot market auto-selection", PH, pick !== null ? "observed" : noBook ? "skipped" : live ? "fail" : "planned",
              { pick, quote: spotQuote, candidates: pool.length, rejected: rejected.slice(0, 20) }, [],
              pick !== null ? `${pick.symbol} size ${pick.size} (≈ $${pick.notional.toFixed(2)}, 24h vol ${pick.volume24hUsd ?? "n/a"})`
                : noBook ? `no ${spotQuote} spot market on ${opts.venue} ${net} has a usable two-sided book (${quoted.map(r => `${r.symbol}: ${r.reason}`).join("; ")}) — venue limitation`
                : `no ${spotQuote} spot market qualifies (${rejected.slice(0, 5).map(r => `${r.symbol}: ${r.reason}`).join("; ")})`);
            if (noBook) {
              console.log(`  [spot] SKIPPED — no ${spotQuote} spot market with a usable two-sided book (${quoted.map(r => `${r.symbol}: ${r.reason}`).join("; ")})`);
              break spotPhase;
            }
            if (pick === null) {
              const why = rejected.slice(0, 5).map(r => `${r.symbol}: ${r.reason}`).join("; ");
              if (live) throw new StopRun(`no ${spotQuote} spot market on ${opts.venue} ${net} fits the $${opts.maxUsd} cap${why !== "" ? ` (${why})` : ""} — pass --spot-symbol/--spot-size or raise --max-usd`, "preflight-fail");
            } else {
              autoSymbol = pick.symbol;
              autoSize = pick.size;
              spotMark = pick.mark;
              spotBookRef = pick.bookRef;
            }
          }
        }
        const sym = opts.spotSymbol ?? autoSymbol ?? profile.spotSymbol[net] ?? "<SPOT_SYMBOL>";
        const spotSize = opts.spotSize ?? autoSize;
        const size = spotSize ?? "<SPOT_SIZE>";
        const base = sym.split("/")[0];
        const publicRef = tradable.find(x => x.symbol.toUpperCase() === base)?.mark ?? null;
        // An operator-supplied reference on mainnet must agree with the public price (±5%):
        // a typo would otherwise size a real-money spot order off a wrong notional.
        if (live && net === "mainnet" && opts.spotRefPrice !== null) {
          const problem = spotRefPriceProblem(opts.spotRefPrice, publicRef);
          if (problem !== null) throw new StopRun(problem, "preflight-fail");
        }
        const ref = opts.spotRefPrice ?? spotMark ?? publicRef;
        const notional = ref !== null && spotSize !== null ? Number(spotSize) * ref : null;
        // Quote the phase needs: the market buy + 5% (slippage / fees). Order is buy → sell → resting far
        // limit, so the limit reuses the quote the sell freed (it used to be placed while the bought base
        // was still held: 2.05 × notional, and buy + limit together exceeded the cap).
        const quoteAmt = notional !== null ? spotQuoteNeed(notional).toFixed(2) : "<QUOTE_AMOUNT>";
        internal("s-plan", `spot ${sym} size ${size}`, PH, "observed", { accountModel: sp.accountModel, quote: sp.quoteAssets[net], caps: sp.capabilities, refPrice: ref, notional, quoteNeed: notional !== null ? Number(quoteAmt) : null }, [],
          notional !== null ? `notional ≈ $${notional.toFixed(2)}; quote needed ≈ ${quoteAmt} ${spotQuote} (1.05 × notional; the far limit reuses the sell proceeds)` : null);
        if (live && (sym.startsWith("<") || spotSize === null)) throw new StopRun("spot phase needs --spot-symbol and --spot-size (venue minimum)", "preflight-fail");
        if (live && notional === null) throw new StopRun(`no reference price for ${sym} — pass --spot-ref-price`, "preflight-fail");
        const worst = notional ?? null;
        const yes = opts.venue === "arcus" && opts.allowOnchainApprove ? ["--yes"] : [];
        const bal0 = await step({ id: "s-balance-0", title: "spot balance (before)", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null, settles: ["S1", "S10"], expect: "observe",
          observe: env => ({ balances: env.data ?? env.error }) });
        // Baseline for the run-wide cap: spot bought from here on counts as open exposure.
        if (live) {
          if (bal0 === null || !bal0.ok) throw new StopRun("cannot read the spot balance baseline — refusing to trade spot", "stopped");
          try { spotTrack = { base, bookRef: spotBookRef, baseline: spotHoldingOf(bal0.data, base) }; } catch (e) {
            throw new StopRun(`cannot read the spot balance baseline: ${(e as Error).message}`, "stopped");
          }
        }
        let movedIn: string | null = null; // quote this run moved perp → spot (returned at the end)
        if (live && spotSize !== null) {
          const d = decimalsOf(spotSize);
          cleanupSpot = { sym, base, grid: d === 0 ? "1" : (1 / 10 ** d).toFixed(d), quote: spotQuote, orderIds: [], movedIn: null, sellArgs: ["--slippage-bps", String(opts.slippageBps), ...yes] };
        }
        if (sp.accountModel === "wallet") {
          await step({ id: "s-transfer-in", title: "spot-transfer on a wallet venue → uniform refusal", phase: PH, args: ["trade", "spot-transfer", "to-spot", quoteAmt], write: true, worstCase: null, settles: [], expect: ["CAPABILITY_UNSUPPORTED"] });
        } else {
          // Size the quote move to what the account holds (live): spot quote available + perp
          // withdrawable. Short → the spot phase is SKIPPED with the shortfall, never a failed transfer.
          let transferAmt: string | null = quoteAmt;
          if (live && bal0 !== null && bal0.ok && sp.accountModel !== "unified") {
            const rows = (Array.isArray(bal0.data) ? bal0.data : ((bal0.data as { balances?: unknown[] }).balances ?? [])) as Array<{ token: string; available: string; shared?: boolean }>;
            const qRow = rows.find(r => r.token.toUpperCase() === spotQuote.toUpperCase());
            const pf = await step({ id: "s-perp-free", title: "perp withdrawable (portfolio)", phase: PH, args: ["portfolio"], write: false, worstCase: null, settles: [], expect: "ok" });
            const perpFree = Number(((pf?.data as { exchanges?: Array<{ perp: { available: string } | null }> } | undefined)?.exchanges ?? [])[0]?.perp?.available ?? NaN);
            let plan: SpotFundingPlan;
            try {
              plan = planSpotFunding({ asset: spotQuote, need: Number(quoteAmt), spotAvail: qRow === undefined ? 0 : Number(qRow.available), perpWithdrawable: perpFree, shared: qRow?.shared === true,
                exercise: lighterMins !== null ? Math.max(1, lighterMins.minTransfer) : 1 });
            } catch (e) {
              throw new StopRun(`cannot size the spot quote move: ${(e as Error).message}`, "stopped");
            }
            internal("s-funding", "spot funding plan (need vs spot + perp withdrawable)", PH, plan.kind === "skip" ? "skipped" : "observed",
              { need: quoteAmt, spotQuoteAvailable: qRow?.available ?? "0", perpWithdrawable: perpFree, plan }, [], plan.kind === "skip" ? plan.reason : plan.note);
            if (plan.kind === "skip") {
              console.log(`  [spot] SKIPPED — ${plan.reason}`);
              break spotPhase;
            }
            transferAmt = plan.transfer;
          }
          if (transferAmt !== null) {
            // unified → must be the sharedAccount no-op; runtime (HL abstraction, Lighter
            // account_trading_mode) → either a real transfer or the sharedAccount no-op.
            const tin = await step({ id: "s-transfer-in", title: `spot-transfer to-spot ${transferAmt}`, phase: PH, args: ["trade", "spot-transfer", "to-spot", transferAmt], write: true, worstCase: null, settles: ["S3", "S16"], expect: "ok",
              check: env => {
                const method = (env.data as { execution?: { method?: string } } | undefined)?.execution?.method;
                const detail = JSON.stringify((env.data as { execution?: unknown } | undefined)?.execution);
                if (sp.accountModel === "unified") return [{ name: "sharedAccount no-op", ok: method === "sharedAccount", detail }];
                if (sp.accountModel === "runtime") return [{ name: "transfer or sharedAccount no-op", ok: method === "transfer" || method === "sharedAccount", detail }];
                return [];
              },
              observe: env => ({ execution: (env.data as { execution?: unknown } | undefined)?.execution ?? null, error: env.error ?? null }) });
            // A shared-balance account moved nothing → nothing to transfer back at the end.
            movedIn = (tin?.data as { execution?: { method?: string } } | undefined)?.execution?.method === "sharedAccount" ? null : transferAmt;
            if (cleanupSpot !== null) cleanupSpot.movedIn = movedIn;
          }
        }
        if (opts.venue === "arcus" && opts.allowOnchainApprove && live) {
          if (!await confirmStep(`Arcus spot-buy with --yes (may send an on-chain Permit2 approve, costs RH ETH gas)`, PH)) throw new StopRun("on-chain approve not confirmed", "stopped");
        }
        const buy = await step({ id: "s-buy", title: `spot-buy ${sym} ${size}`, phase: PH, args: ["trade", "spot-buy", sym, size, "--slippage-bps", String(opts.slippageBps), ...yes], write: true,
          worstCase: worst !== null ? worst * (1 + opts.slippageBps / 10_000) : null, settles: ["S4", "S9", "S11", "S13", "S14", "S20", "S21", "S22"], expect: "ok",
          check: env => {
            const o = (env.data as { order?: { status?: string; finality?: string } }).order;
            return [{ name: "filled/partial", ok: ["filled", "partial"].includes(String(o?.status)), detail: String(o?.status) },
              { name: "final", ok: o?.finality === "final", detail: String(o?.finality) }];
          },
          observe: env => ({ order: (env.data as { order?: unknown }).order, execution: (env.data as { execution?: unknown }).execution }) });
        // Re-read (≤ SETTLE_TIMEOUT_MS) until the verified buy shows in the balance: account reads
        // can lag the fill, and venues that take the fee in the bought asset credit slightly less
        // than filledSize (HL: 3 PURR → 2.9979) — spotBuyLanded allows for that fee.
        const boughtFilled = Number((buy?.data as { order?: { filledSize?: string | null } } | undefined)?.order?.filledSize ?? NaN);
        const bal1 = (await pollUntil(
          i => step({ id: i === 0 ? "s-balance-1" : `s-balance-1-poll${i}`, title: "spot balance after buy (fee asset / units)", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null,
            settles: i === 0 ? ["S2", "S18", "S19", "S21"] : [], expect: "observe",
            observe: env => ({ balances: env.data ?? env.error, filled: Number.isFinite(boughtFilled) ? boughtFilled : null }) }),
          env => {
            if (!live || spotTrack === null || env === null || !env.ok || !Number.isFinite(boughtFilled)) return true;
            try { return spotBuyLanded(spotTrack.baseline, spotHoldingOf(env.data, base), boughtFilled); } catch { return true; }
          })).value;
        if (opts.venue === "pacifica") await equityOf("s-portfolio-pacifica", PH).then(e => internal("s-pacifica-equity", "equity incl. spot? (double count check)", PH, "observed", { equity: e }, ["S19"]));

        // Sell what this run bought (base available, floored to the size grid) — never more.
        let sellSize = "<SELLABLE_SIZE>";
        if (live && bal1 !== null && buy !== null) {
          const rows = (Array.isArray(bal1.data) ? bal1.data : ((bal1.data as { balances?: unknown[] }).balances ?? [])) as Array<{ token: string; available: string }>;
          const avail = Number(rows.find(r => r.token.toUpperCase() === base.toUpperCase())?.available ?? NaN);
          const filled = Number((buy.data as { order?: { filledSize?: string | null } }).order?.filledSize ?? NaN);
          const d = decimalsOf(spotSize ?? "1");
          sellSize = floorToStep(Math.min(avail, filled), d === 0 ? "1" : (1 / 10 ** d).toFixed(d));
          internal("s-sellable", "sellable = min(available, filled)", PH, "observed", { available: avail, filled, sellSize }, ["S18"]);
        }
        const sell = await step({ id: "s-sell", title: `spot-sell ${sym}`, phase: PH, args: ["trade", "spot-sell", sym, sellSize, "--slippage-bps", String(opts.slippageBps), ...yes], write: true, worstCase: null, needs: ["s-buy"],
          settles: ["S4", "S13", "S18", "S20"], expect: "ok",
          check: env => [{ name: "final", ok: (env.data as { order?: { finality?: string } }).order?.finality === "final", detail: String((env.data as { order?: { finality?: string } }).order?.finality) }],
          observe: env => ({ order: (env.data as { order?: unknown }).order }) });
        // Re-read (≤ SETTLE_TIMEOUT_MS) until the sell shows in the balance (base back to the baseline, within the fee allowance / grid remainder).
        const soldFilled = Number((sell?.data as { order?: { filledSize?: string | null } } | undefined)?.order?.filledSize ?? NaN);
        const bal2 = (await pollUntil(
          i => step({ id: i === 0 ? "s-balance-2" : `s-balance-2-poll${i}`, title: "spot balance after sell", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null, settles: [], expect: "observe",
            observe: env => ({ balances: env.data ?? env.error, sold: Number.isFinite(soldFilled) ? soldFilled : null }) }),
          env => {
            if (!live || spotTrack === null || env === null || !env.ok || !Number.isFinite(boughtFilled) || !Number.isFinite(soldFilled)) return true;
            try { return spotHoldingOf(env.data, base) - spotTrack.baseline <= Math.max(boughtFilled - soldFilled, 0) + boughtFilled * SPOT_FEE_ALLOWANCE; } catch { return true; }
          })).value;

        // Resting orders AFTER the sell: the far limit (below the market, never filling) is funded by the sell proceeds.
        const lp = opts.spotLimitPrice ?? (ref !== null ? hlPrice(ref * (1 - sz.farPct / 100), 0, "down") : "<FAR_PRICE>");
        let limitFunded = true;
        if (live && sp.capabilities.limitOrder && bal2 !== null) {
          const rows = (bal2.ok ? (Array.isArray(bal2.data) ? bal2.data : ((bal2.data as { balances?: unknown[] }).balances ?? [])) : []) as Array<{ token: string; available: string }>;
          const q = Number(rows.find(r => r.token.toUpperCase() === spotQuote.toUpperCase())?.available ?? NaN);
          const limitNeed = Number(size) * Number(lp);
          limitFunded = q >= limitNeed;
          internal("s-limit-funding", "quote available for the far limit (after the sell)", PH, limitFunded ? "observed" : "skipped", { quoteAvailable: Number.isFinite(q) ? q : null, limitNeed }, [],
            limitFunded ? `${q} ${spotQuote} ≥ ${limitNeed.toFixed(2)}` : `spot ${spotQuote} available ${Number.isFinite(q) ? q : "unreadable"} < ${limitNeed.toFixed(2)} needed by the far limit — resting-limit steps skipped (no order sent)`);
        }
        if (sp.capabilities.limitOrder && !limitFunded) {
          console.log("  [spot] resting-limit steps SKIPPED — not enough quote after the sell");
        } else if (sp.capabilities.limitOrder) {
          const lim = await step({ id: "s-limit", title: "spot-limit GTC far from market", phase: PH, args: ["trade", "spot-limit", sym, "buy", lp, size, "--tif", "GTC"], write: true,
            worstCase: spotSize !== null && lp !== "<FAR_PRICE>" ? Number(spotSize) * Number(lp) : worst, settles: ["S7", "S8", "S13"], expect: "ok",
            observe: env => ({ order: (env.data as { order?: unknown }).order }) });
          const lid = live && lim !== null ? String((lim.data as { order?: { orderId?: string | null } }).order?.orderId ?? "<spotOrderId>") : "<spotOrderId>";
          if (live && lim !== null && cleanupSpot !== null && lid !== "<spotOrderId>") cleanupSpot.orderIds.push(lid);
          await step({ id: "s-orders", title: "spot-orders lists it", phase: PH, args: ["trade", "spot-orders", sym], write: false, worstCase: null, needs: ["s-limit"], settles: ["S17", "#15"], expect: "ok",
            check: env => {
              const os = ((env.data as { orders?: Array<{ orderId: string }> }).orders ?? []);
              return [{ name: "listed", ok: os.some(o => String(o.orderId) === lid), detail: `${os.length} orders` }];
            }, observe: env => ({ orders: (env.data as { orders?: unknown }).orders }) });
          await step({ id: "s-cancel", title: "spot-cancel", phase: PH, args: ["trade", "spot-cancel", sym, lid], write: true, worstCase: null, needs: ["s-limit"], settles: ["S5"], expect: "ok" });
          if (cleanupSpot !== null) cleanupSpot.orderIds = [];
          const alo = await step({ id: "s-limit-alo", title: "spot-limit ALO far (TIF set)", phase: PH, args: ["trade", "spot-limit", sym, "buy", lp, size, "--tif", "ALO"], write: true,
            worstCase: worst, settles: ["S7"], expect: "observe", observe: env => ({ result: env.data ?? env.error }) });
          if (live && alo !== null && alo.ok) {
            const aid = String((alo.data as { order?: { orderId?: string | null } }).order?.orderId ?? "");
            if (aid !== "" && cleanupSpot !== null) cleanupSpot.orderIds.push(aid);
            if (aid !== "") await step({ id: "s-cancel-alo", title: "spot-cancel ALO", phase: PH, args: ["trade", "spot-cancel", sym, aid], write: true, worstCase: null, settles: ["S5"], expect: "ok" });
            if (cleanupSpot !== null) cleanupSpot.orderIds = [];
          }
        } else {
          await step({ id: "s-limit", title: "spot-limit on a market-only spot venue → uniform refusal", phase: PH, args: ["trade", "spot-limit", sym, "buy", "1", size], write: true, worstCase: null, settles: [], expect: ["CAPABILITY_UNSUPPORTED"] });
          await step({ id: "s-orders", title: "spot-orders → uniform refusal", phase: PH, args: ["trade", "spot-orders"], write: false, worstCase: null, settles: [], expect: ["CAPABILITY_UNSUPPORTED"] });
        }

        if (sp.accountModel === "separate" || sp.accountModel === "runtime") {
          let backAmt: string | null = movedIn;
          if (live && movedIn !== null) {
            const bal3 = await step({ id: "s-balance-3", title: "spot balance before the transfer back", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null, settles: [], expect: "ok" });
            const rows = (Array.isArray(bal3?.data) ? bal3?.data : ((bal3?.data as { balances?: unknown[] } | undefined)?.balances ?? [])) as Array<{ token: string; available: string }>;
            const q = Number(rows.find(r => r.token.toUpperCase() === spotQuote.toUpperCase())?.available ?? NaN);
            backAmt = Number.isFinite(q) ? floorToStep(Math.min(q, Number(movedIn)), "0.01") : movedIn;
          }
          // Only what this run moved in goes back (pre-existing spot quote is never touched).
          if (backAmt !== null && !(Number(backAmt) <= 0)) {
            await step({ id: "s-transfer-out", title: `spot-transfer to-perp ${backAmt}`, phase: PH, args: ["trade", "spot-transfer", "to-perp", backAmt], write: true, worstCase: null, settles: ["S3", "S16"], expect: "ok" });
          }
        }
        await step({ id: "s-balance-final", title: "spot balance (final)", phase: PH, args: ["trade", "spot-balance"], write: false, worstCase: null, settles: [], expect: "observe", observe: env => ({ balances: env.data ?? env.error }) });
        cleanupSpot = null;
      }
    }

    // ── D / W: funding moves ────────────────────────────────────────────
    const fundingPhase = async (phase: "deposit" | "withdraw", route: FundingRoute, amountArg: string | null): Promise<void> => {
      console.log(`\n[${phase}]`);
      const PH = phase;
      if (route.kind === "none") { internal(`${phase[0]}-route`, `${phase} route`, PH, "skipped", {}, phase === "withdraw" ? ["#7", "#10"] : [], route.reason); return; }
      // Testnet CLI route without --<phase>-amount: the route's documented minimum (test funds);
      // mainnet always needs an explicit amount.
      if (amountArg === null && net === "testnet" && route.kind === "cli" && route.min !== null) {
        amountArg = String(route.min);
        internal(`${phase[0]}-amount`, `${phase} amount`, PH, "observed", { amount: amountArg, source: "route minimum (testnet default)" }, [], `--${phase}-amount not given — using the testnet route minimum ${amountArg}`);
      }
      const amount = amountArg ?? "<AMOUNT>";
      if (live && amountArg === null && route.kind !== "manual") throw new StopRun(`--${phase}-amount is required for the ${phase} phase`, "preflight-fail");
      // Limits before anything is read or sent: cap, route minimum (HL: a Bridge2 deposit under 5 USDC is lost) and, on the
      // Lighter family, the live assetDetails minimum.
      if (route.kind === "cli") {
        let min = route.min;
        if (route.liveMin === "lighterAssetDetails" && phase === "withdraw") {
          if (lighterMins === null) throw new StopRun(`${opts.venue} live withdraw minimum (assetDetails) was not read — refusing to withdraw`, "preflight-fail");
          min = Math.max(min ?? 0, lighterMins.minWithdrawal);
        }
        internal(`${phase[0]}-limits`, `${phase} limits`, PH, "observed", { min, routeMin: route.min, minSource: route.minSource, liveMin: route.liveMin !== null ? lighterMins : null, fee: route.fee, belowMinLost: route.belowMinLost }, [],
          `minimum ${min ?? "none"} (${route.minSource})${route.fee !== null ? `; fee ${route.fee.amount} ${route.fee.asset} (${route.fee.source})` : ""}`);
        if (amountArg !== null) {
          const problem = fundingAmountProblem({ phase, amount: Number(amountArg), min, minSource: route.minSource, belowMinLost: route.belowMinLost, maxUsd: opts.maxUsd });
          if (problem !== null) throw new StopRun(problem, "preflight-fail");
        }
      } else if (amountArg !== null && Number(amountArg) > opts.maxUsd) {
        throw new StopRun(`--${phase}-amount ${amountArg} > --max-usd ${opts.maxUsd}`, "preflight-fail");
      }
      const before = live ? await equityOf(`${phase[0]}-equity-before`, PH) : null;
      if (route.kind === "cli") {
        const args = route.args(amount);
        if (live && !await confirmStep(cmd(args), PH)) { internal(`${phase[0]}-confirm`, `${phase} not confirmed`, PH, "skipped", {}, [], "operator declined"); return; }
        // NO_SIGNER_AVAILABLE = the master wallet is not on this machine (imported agent only): the
        // command refuses before loading any key or signing, so the phase is manual (website), not failed.
        // HL testnet withdraw3: the venue refused it with {"status":"err","response":"Error withdrawing from
        // bridge"} (ACTION_REJECTED; ledger + balance unchanged, round 6) — a testnet bridge limitation, not a
        // CLI failure. Only that explicit refusal is SKIPPED, on testnet only; mainnet is unchanged.
        const hlTestnetBridge = phase === "withdraw" && opts.venue === "hyperliquid" && net === "testnet";
        const fundEnv = await step({ id: `${phase[0]}-${phase}`, title: `${phase} ${amount} (${route.note})`, phase: PH, args, write: true, worstCase: null,
          settles: phase === "withdraw" && opts.venue === "lighter-rh" ? ["#2"] : [], expect: hlTestnetBridge ? ["ok", "NO_SIGNER_AVAILABLE", "ACTION_REJECTED"] : ["ok", "NO_SIGNER_AVAILABLE"], timeoutMs: 600_000,
          observe: env => ({ result: env.data ?? env.error }) });
        if (hlTestnetBridge && fundEnv !== null && !fundEnv.ok && fundEnv.error?.code === "ACTION_REJECTED") {
          internal("w-venue-refused", "withdraw refused by the HL testnet bridge", PH, "skipped", { error: fundEnv.error }, [],
            `venue limitation: Hyperliquid testnet refused withdraw3 (${fundEnv.error?.message ?? ""}) — nothing moved; mainnet withdraw is unaffected`);
          return;
        }
        if (fundEnv !== null && !fundEnv.ok && fundEnv.error?.code === "NO_SIGNER_AVAILABLE") {
          internal(`${phase[0]}-manual`, `${phase}: manual (master not on this machine)`, PH, "skipped", { agentSource, remediation: fundEnv.error?.remediation ?? null }, [],
            `do the ${phase} on the ${opts.venue} website (or add the master wallet with perp wallet import)`);
          return;
        }
      } else if (route.kind === "manual") {
        internal(`${phase[0]}-manual`, `${phase} is external/manual`, PH, live ? "observed" : "planned", { instructions: route.instructions }, [], route.instructions.join("; "));
        if (live) console.log(`  → Do it now by hand: ${route.instructions.join("; ")} — polling equity for ${opts.pollTimeoutSec}s`);
      } else if (route.kind === "ondoSandbox") {
        if (net !== "testnet") throw new StopRun("sandbox_deposit is sandbox-only", "preflight-fail");
        if (!live) {
          internal("d-ondo-sandbox", "POST /v1/sandbox_deposit (HMAC, via dist OndoClient)", PH, "planned", { body: { amount, symbol: "USDC", deposit_destination: { id: "<accountID>", wallet: "margin" }, chain_id: "eth-sepolia" } });
        } else {
          if (!await confirmStep(`Ondo sandbox_deposit ${amount} USDC`, PH)) { internal("d-confirm", "not confirmed", PH, "skipped", {}); return; }
          const out = await ondoSandboxDeposit(amount);
          internal("d-ondo-sandbox", "POST /v1/sandbox_deposit", PH, "pass", { response: out }, ["#4"]);
        }
      }
      if (!live) return;
      const deadline = Date.now() + opts.pollTimeoutSec * 1000;
      let now = before;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 15_000));
        const r = await runCli([...globals, "portfolio"], { timeoutMs: 120_000, env: childEnv });
        const ex = ((r.envelope?.data as { exchanges?: Array<{ perp: { equity: string } | null }> } | undefined)?.exchanges ?? [])[0];
        now = ex?.perp != null ? Number(ex.perp.equity) : now;
        if (before !== null && now !== null && (phase === "deposit" ? now > before + 0.5 : now < before - 0.5)) break;
      }
      const moved = before !== null && now !== null && (phase === "deposit" ? now > before + 0.5 : now < before - 0.5);
      internal(`${phase[0]}-balance-change`, `equity ${phase === "deposit" ? "increased" : "decreased"}`, PH, moved ? "pass" : "fail", { before, after: now }, [], moved ? (phase === "withdraw" ? "confirm arrival on-chain (destination wallet / explorer) and note the tx in the report" : null) : `no change within ${opts.pollTimeoutSec}s`);
      if (!moved) throw new StopRun(`${phase}: equity did not change within ${opts.pollTimeoutSec}s (before ${before}, now ${now})`, "fail");
    };
    if (opts.phases.includes("deposit")) await fundingPhase("deposit", profile.deposit[net], opts.depositAmount);
    if (opts.phases.includes("withdraw")) await fundingPhase("withdraw", profile.withdraw[net], opts.withdrawAmount);

    if (live && equityStart !== null) {
      const end = await equityOf("z-equity-end", "final");
      internal("z-reconcile", "equity reconciliation", "final", "observed", { start: equityStart, end, delta: end !== null ? end - equityStart : null }, [],
        "delta = fees + slippage + funding (+ deposit/withdraw); compare with perp account trades / funding-history");
    }
  } catch (e) {
    if (e instanceof StopRun) {
      report.stopReason = e.message;
      report.result = e.kind === "preflight-fail" ? "preflight-fail" : e.kind === "fail" ? "fail" : "stopped";
      console.error(`\n[e2e] ${e.kind.toUpperCase()}: ${e.message}`);
      // A definite failure leaves known state: undo what this run created. "stopped" = unknown
      // outcome / kill switch / SIGINT → nothing more is sent.
      if (e.kind === "fail" && live && (cleanupTrade !== null || cleanupSpot !== null)) await cleanup();
    } else {
      report.stopReason = `runner error: ${(e as Error).stack ?? String(e)}`;
      report.result = "fail";
      console.error(`\n[e2e] runner error: ${(e as Error).message}`);
    }
  }

  for (const c of cleanupFor(symbol)) if (!report.cleanup.includes(c)) report.cleanup.push(c);
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let opts: Opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (killSwitchActive()) {
    console.error(`Kill switch is active (${KILL_FILE}) — remove it to run.`);
    return 3;
  }
  if (!existsSync(CLI_ENTRY)) {
    console.error(`dist/index.js not found — run \`pnpm build\` first.`);
    return 2;
  }

  const profile = PROFILES[opts.venue];
  const net = opts.network;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error("\n[e2e] SIGINT — stopping after the current step (press again to abort immediately).");
  });

  const report: RunReport = {
    tool: "perp-e2e", version: 1, startedAt: new Date().toISOString(), finishedAt: null,
    venue: opts.venue, cliVenue: profile.cliVenue, dex: opts.dex, network: net, phases: opts.phases, dryRun: opts.dryRun, operatorAuthorized: false,
    cliVersion: null, gitCommit: null,
    options: { ...opts, venue: undefined, network: undefined, phases: undefined },
    market: null, sizing: null, hip3: opts.hip3Dex !== null ? { dex: opts.hip3Dex, market: null, sizing: null } : null,
    capabilities: null,
    prerequisites: [...profile.prerequisites[net], ...(opts.hip3Dex !== null && profile.hip3 !== null ? profile.hip3.prerequisites[net] : [])],
    steps: [], designItems: {}, stopReason: null, cleanup: [], result: opts.dryRun ? "dry-run" : "pass",
  };
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  report.gitCommit = git.status === 0 ? `${git.stdout.trim()}${spawnSync("git", ["diff", "--quiet"], { cwd: REPO_ROOT }).status === 0 ? "" : "+dirty"}` : null;

  const refused = await runLeg(opts, report, null);
  if (refused !== null) return refused;
  // HIP-3 leg: same account/agent, `--dex <name>`; only once the core dex finished clean. No spot /
  // deposit / withdraw on a HIP-3 dex — those ran on the core leg.
  if (opts.hip3Dex !== null) {
    if (report.result === "pass" || report.result === "dry-run") {
      const hip3Phases = opts.phases.filter(p => p === "preflight" || p === "trade");
      await runLeg({ ...opts, dex: opts.hip3Dex, symbol: opts.hip3Symbol, phases: hip3Phases }, report, "hip3");
    } else {
      report.steps.push({ id: "hip3-leg", title: `HIP-3 dex ${opts.hip3Dex} leg`, phase: "hip3-preflight", outcome: "skipped", command: null, worstCaseNotionalUsd: null,
        exitCode: null, durationMs: null, envelope: null, stderrTail: null, assertions: [], observations: {}, settles: [], note: `not run: the core leg ended ${report.result}` });
      console.log(`\n  ⏭  hip3-leg: skipped (core leg ended ${report.result})`);
    }
  }

  // ── Design items summary + report ─────────────────────────────────────
  for (const [item, info] of Object.entries(DESIGN_ITEMS)) {
    const rel = ITEM_VENUES[item];
    const relevant = rel === "all" || rel.includes(opts.venue);
    const steps = report.steps.filter(s => s.settles.includes(item));
    let status: string;
    if (!relevant) status = "n/a for this venue";
    else if (steps.length === 0) status = NOT_COVERED[item] !== undefined ? `not covered: ${NOT_COVERED[item]}` : "not reached in this run";
    else if (steps.some(s => s.outcome === "fail")) status = "FAIL — see steps";
    else if (steps.every(s => s.outcome === "planned" || s.outcome === "skipped")) status = `planned${NOT_COVERED[item] !== undefined ? ` (partial: ${NOT_COVERED[item]})` : ""}`;
    else status = `exercised — review observations${NOT_COVERED[item] !== undefined ? ` (partial: ${NOT_COVERED[item]})` : ""}`;
    report.designItems[item] = { what: `${info.venues}: ${info.what}`, steps: steps.map(s => s.id), status };
  }
  report.finishedAt = new Date().toISOString();
  const files = writeReport(report);
  const counts = report.steps.reduce<Record<string, number>>((a, s) => { a[s.outcome] = (a[s.outcome] ?? 0) + 1; return a; }, {});
  console.log(`\nResult: ${report.result}${report.stopReason !== null ? ` — ${report.stopReason}` : ""}`);
  console.log(`Steps: ${JSON.stringify(counts)}`);
  if (report.result === "fail" || report.result === "stopped") {
    console.log("Cleanup / verify by hand (no automatic retries were made):");
    for (const c of report.cleanup) console.log(`  ${c}`);
  }
  console.log(`Report: ${files.json}\n        ${files.md}`);
  return report.result === "pass" || report.result === "dry-run" ? 0 : report.result === "preflight-fail" ? 4 : 1;
}

/** Ondo sandbox only: credit test USDC with the registered HMAC key (dist OndoClient). */
async function ondoSandboxDeposit(amount: string): Promise<unknown> {
  const dist = (p: string) => pathToFileURL(join(REPO_ROOT, "dist", p)).href;
  await import(dist("exchanges/venues/index.js"));
  const { getVenueAgent } = await import(dist("agent-wallet/store.js")) as { getVenueAgent(v: "ondo"): { keyId: string } | null };
  const { loadOndoCredentials } = await import(dist("exchanges/ondo/agent.js")) as { loadOndoCredentials(keyId: string): unknown };
  const { OndoClient } = await import(dist("exchanges/ondo/client.js")) as {
    OndoClient: new (o: { restUrl: string; network: Net; rateLimit: unknown; credentials: unknown }) => {
      get<T>(path: string, q: null): Promise<T>; post<T>(path: string, body: unknown): Promise<T>;
    };
  };
  const { getVenue, networkConfig } = await import(dist("exchanges/venue.js")) as {
    getVenue(id: string): { rateLimit: unknown }; networkConfig(def: unknown, net: Net): { restUrl: string };
  };
  const meta = getVenueAgent("ondo");
  if (meta === null) throw new StopRun("no Ondo API key registered (perp wallet agent approve ondo -n testnet)", "preflight-fail");
  const def = getVenue("ondo");
  const client = new OndoClient({ restUrl: networkConfig(def, "testnet").restUrl, network: "testnet", rateLimit: def.rateLimit, credentials: loadOndoCredentials(meta.keyId) });
  const account = await client.get<{ accountID: string }>("/v1/account", null);
  return client.post("/v1/sandbox_deposit", { amount, symbol: "USDC", deposit_destination: { id: account.accountID, wallet: "margin" }, chain_id: "eth-sepolia" });
}

// Run only as the entry script (unit tests import runLeg / parseArgs).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
}
