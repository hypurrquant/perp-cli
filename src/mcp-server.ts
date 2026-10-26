#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server for perp-cli.
 *
 * Market data, account reads, CLI command suggestions, and two WRITE tools (`trade_execute`,
 * `trade_close`) that place real orders through the same safety path as `perp trade`
 * (local risk gate — no force override over MCP —, quarantine reject, execution log).
 * Network: PERP_NETWORK (mainnet | testnet, validated like `-n`); unset = mainnet, the
 * documented default. Every result's meta carries `network`.
 * Adapters are created lazily from the registered agent / OWS wallet / settings (no CLI flags).
 */

// SSOT Rule #3: load only ~/.perp/.env, like the CLI (src/index.ts) — never a .env in the CWD
// (a project tree's leftover dev keys would silently become this server's credentials).
import { setQuarantineNetwork } from "./bot/quarantine.js";
import { config as loadDotenv } from "dotenv";
import { resolve as resolvePath } from "node:path";
loadDotenv({ path: resolvePath(process.env.HOME || "~", ".perp", ".env") });
import { registerAdapterNetwork } from "./exchanges/adapter-network.js";
import { builderPlanFor } from "./exchanges/builder-fee.js";
import { resolveAdapterSlippage } from "./exchanges/slippage.js";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { hasCredentials, listConfiguredAccountVenues, resolveCredentials, NO_CLI_CREDENTIAL_OPTS } from "./config.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
import { getVenue, listPublicBalanceVenues, listPublicPositionVenues, listVenues, listVenuesWithRole, networkConfig, READ_ONLY_CREDENTIALS, requireCapabilities, roleUnsupported, type VenueDefinition } from "./exchanges/venue.js";
import "./exchanges/venues/index.js";
import type { OrderRequest, VenueId } from "./exchanges/venue-types.js";
import { venueMarketRow } from "./exchanges/venue-types.js";
import { lighterFundingStatsWarning } from "./exchanges/lighter-public.js";
import { newVenueClientOrderId, placeAndConfirm, validateLegacyTif, validateOrderRequest, type PlacedOrder } from "./exchanges/trading-v2.js";
import { closePerpVerified, isOutcomeUnknown } from "./bot/perp-order.js";
import { quarantineSymbol } from "./bot/quarantine.js";
import { fillSizeString, sizeDecimalsOf } from "./exchanges/spot-result.js";
import { tradingV2Of } from "./exchanges/legacy-trading-v2.js";
import { PerpError, classifyError, extractErrorMessage, isDefiniteOrderFailure, orderOutcomeUnknown, parsePositiveDecimal } from "./errors.js";
import { invalidateCache } from "./cache.js";
import { probeVenueHealth } from "./venue-health.js";
import { getOptionsVenue, listOptionsVenueIds } from "./exchanges/options-venues.js";
import { fetchAllFundingRates, isRankedComparison } from "./funding-rates.js";
import { readPositionsByAddress } from "./positions-by-address.js";
import { readBalanceByAddress, readBalanceByAddressAll } from "./balance-by-address.js";
import { loadArbState } from "./arb/state.js";
import { validateTrade } from "./trade-validator.js";
import { orderResultJson, symbolMatch } from "./utils.js";
import { logMcpExecution, mcpPreTradeGate, mcpReduceOnlyGate, resolveMcpNetwork } from "./mcp-trade-guard.js";
import { setSharedApiNetwork } from "./api/public/urls.js";
import { logClientId } from "./client-id-tracker.js";
import { loadSettings } from "./settings.js";
import { registerPacificaEarnMcpTools } from "./mcp-pacifica-earn.js";

/**
 * The one network this server serves: PERP_NETWORK, validated like `-n` (an invalid value
 * makes the server refuse to start). Unset = mainnet, the documented default. Reported in
 * every result's meta.network.
 */
const MCP_NETWORK = resolveMcpNetwork(process.env["PERP_NETWORK"]);
// Quarantine entries are network-scoped; the MCP server trades only MCP_NETWORK.
setQuarantineNetwork(MCP_NETWORK);
setSharedApiNetwork(MCP_NETWORK);

// ── Adapter cache & factory ──
//
// Same creation path and signer tiers as the CLI (agent → OWS master → PK).
// The MCP server has no CLI flags, so credentials come
// from the registered agent, settings.owsActiveWallet, and (legacy venues) env.

const adapters = new Map<VenueId, ExchangeAdapter>();
/** The network each adapter was created on (TradingV2 wrappers must use the same one). */
const adapterNetworks = new WeakMap<ExchangeAdapter, "mainnet" | "testnet">();

function requireCreate(def: VenueDefinition): NonNullable<VenueDefinition["create"]> {
  if (def.create === null) {
    throw new PerpError("NOT_IMPLEMENTED", `${def.displayName} has no account/trading API`, {
      remediation: `${def.id} is market-data only — use get_markets / funding tools`,
    });
  }
  return def.create;
}

async function getOrCreateAdapter(exchange: string): Promise<ExchangeAdapter> {
  const def = getVenue(exchange);
  const cached = adapters.get(def.id);
  if (cached) return cached;
  // Market-data-only venue (TxFlow: unofficial read-only API): every account / trading tool refuses here.
  if (!def.roles.includes("account")) throw roleUnsupported(def, "account");
  const create = requireCreate(def);
  if (!(await hasCredentials(def.id, NO_CLI_CREDENTIAL_OPTS))) {
    throw new PerpError("NO_SIGNER_AVAILABLE", `No credentials configured for ${def.id}`, {
      remediation: def.masterKeyKind === "none"
        ? `Import an API key created on the ${def.displayName} website: perp wallet agent import ${def.id}`
        : `Run: perp setup, or perp wallet agent approve ${def.id}`,
    });
  }
  const network = MCP_NETWORK;
  const adapter = await create({
    network,
    credentials: await resolveCredentials(def.id, NO_CLI_CREDENTIAL_OPTS, network),
    noAgent: false,
    hlDex: null,
    readOnly: false,
    // Builder fees follow settings.builder (user-configured, approval-confirmed); MCP has no per-call opt-out.
    noBuilder: false,
  });
  adapters.set(def.id, adapter);
  adapterNetworks.set(adapter, network);
  registerAdapterNetwork(adapter, network);
  return adapter;
}

/** Signer-availability failures that route a read tool to the venue's public data path. */
const PUBLIC_FALLBACK_CODES: ReadonlySet<string> = new Set(["NO_SIGNER_AVAILABLE", "AGENT_NOT_REGISTERED", "KEY_NOT_FOUND"]);

/**
 * Adapter when credentials are configured and usable; null when there are none
 * or adapter creation fails specifically for lack of a usable signer
 * (NO_SIGNER_AVAILABLE / AGENT_NOT_REGISTERED / KEY_NOT_FOUND) — the caller then
 * reads the venue's public data path. Every other creation error propagates.
 */
async function tryGetAdapter(exchange: string): Promise<ExchangeAdapter | null> {
  const def = getVenue(exchange);
  const cached = adapters.get(def.id);
  if (cached) return cached;
  if (def.create === null || !(await hasCredentials(def.id, NO_CLI_CREDENTIAL_OPTS))) return null;
  try {
    return await getOrCreateAdapter(def.id);
  } catch (e) {
    if (e instanceof PerpError && PUBLIC_FALLBACK_CODES.has(e.structured.code)) return null;
    throw e;
  }
}

/**
 * Fetch markets using the venue's public data path (no key needed). Unofficial-API rows carry
 * venueApi; rows of a venue whose funding is unverified (QFEX, GRVT, TxFlow) carry fundingVerified false.
 */
async function fetchMarketsPublic(exchange: string) {
  return labelMarketRows(exchange, await getVenue(exchange).publicData.fetchMarkets(MCP_NETWORK));
}

/**
 * meta.warnings when a venue's rows carry fundingRate null for a known reason (Lighter: the
 * settled-rate snapshot could not be read) — the reason reaches the agent, not only stderr.
 */
function fundingWarningMeta(exchange: string, rows: ReadonlyArray<{ fundingRate?: unknown }>): { warnings?: string[] } {
  const id = getVenue(exchange).id;
  if (id !== "lighter" && id !== "lighter-rh") return {};
  // Tied to the rows served: only when they actually carry a null rate (cached rows that have
  // rates never get a stale warning; null rows always say why when the reason is known).
  if (!rows.some(r => r.fundingRate === null)) return {};
  const w = lighterFundingStatsWarning(id, MCP_NETWORK);
  return w === null ? {} : { warnings: [w] };
}

/**
 * Keyless get_markets rows: the public directory's VenueMarket rows in the CLI market-row shape
 * (venueMarketRow — the mapper the VenueMarket CLI adapters use), the VenueMarket fields kept
 * (venueSymbol, canonical, assetClass, fundingRateBasis, tickSize, …) and the MCP labels added.
 */
async function fetchMarketRowsPublic(exchange: string) {
  const markets = await getVenue(exchange).publicData.fetchMarkets(MCP_NETWORK);
  return labelMarketRows(exchange, markets.map(m => ({ ...m, ...venueMarketRow(m) })));
}

/**
 * The one row label for market rows of any source (public data path or a credentialed adapter):
 * every row carries fundingVerified (true or false — as `perp market list`), unofficial-API rows venueApi.
 */
function labelMarketRows<T extends object>(exchange: string, rows: T[]) {
  const def = getVenue(exchange);
  const labelled = rows.map(r => ({ ...r, fundingVerified: def.fundingVerified }));
  return def.apiStatus.kind === "unofficial" ? labelled.map(r => ({ ...r, venueApi: "unofficial" as const })) : labelled;
}

/**
 * meta fields every market-data tool adds for its venue: apiStatus, the note for an unofficial API,
 * and fundingVerified false (with a note) when the venue's funding rate is unverified.
 */
function apiMeta(exchange: string): Record<string, unknown> {
  const def = getVenue(exchange);
  if (def.apiStatus.kind === "unofficial") {
    return { apiStatus: "unofficial", apiNote: `${def.displayName}: UNOFFICIAL API — ${def.apiStatus.note}`, fundingVerified: def.fundingVerified };
  }
  return def.fundingVerified
    ? { apiStatus: "official" }
    : { apiStatus: "official", fundingVerified: false, fundingNote: `${def.displayName}: funding rate UNVERIFIED (not confirmed against settled payments) — display only, never a basis for trading` };
}

type BookLevels = { bids: [string, string][]; asks: [string, string][] };

/** One book level from a venue payload; a level without a string price / size is a payload error (never "0"). */
function bookLevel(venue: string, symbol: string, price: unknown, size: unknown): [string, string] {
  if (typeof price !== "string" || typeof size !== "string") {
    throw new PerpError("EXCHANGE_ERROR", `${venue} orderbook ${symbol}: level without price / size`, { exchange: venue });
  }
  return [price, size];
}

/**
 * Fetch an orderbook without credentials. Hyperliquid (native perps) and the Lighter family are
 * read straight from their public REST endpoints and validated (HTTP status, payload shape, unknown
 * symbol); every other venue goes through its read-only adapter (no key material), the same path
 * `perp market book` takes without credentials. A venue without an account/trading API throws
 * NOT_IMPLEMENTED (requireCreate).
 */
async function fetchOrderbookPublic(exchange: string, symbol: string): Promise<BookLevels> {
  const def = getVenue(exchange);
  const sym = symbol.toUpperCase();
  if (def.id === "hyperliquid") {
    const { HYPERLIQUID_API_URL } = await import("./api/public/urls.js");
    const res = await fetch(HYPERLIQUID_API_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: sym }),
    });
    if (!res.ok) throw new PerpError("EXCHANGE_ERROR", `${def.displayName} l2Book ${sym}: HTTP ${res.status}`, { exchange: def.id });
    const data = await res.json() as { levels?: unknown } | null;
    if (data === null) {
      throw new PerpError("SYMBOL_NOT_FOUND", `${def.displayName} has no native perp ${sym}`, {
        exchange: def.id,
        remediation: `List markets with get_markets (exchange: ${def.id}); HIP-3 dex markets are read with the CLI: perp -e hyperliquid --dex <name> market book ${sym}`,
      });
    }
    const levels = data.levels;
    if (!Array.isArray(levels) || levels.length !== 2 || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) {
      throw new PerpError("EXCHANGE_ERROR", `${def.displayName} l2Book ${sym}: unexpected payload (no [bids, asks] levels)`, { exchange: def.id });
    }
    const side = (ls: unknown[]) => ls.map(l => bookLevel(def.id, sym, (l as { px?: unknown }).px, (l as { sz?: unknown }).sz));
    return { bids: side(levels[0]), asks: side(levels[1]) };
  }
  if (def.family === "lighter") {
    const market = (await def.publicData.fetchMarkets(MCP_NETWORK)).find(m => m.symbol.toUpperCase() === sym);
    if (!market) {
      throw new PerpError("SYMBOL_NOT_FOUND", `${def.displayName} has no market ${sym}`, { exchange: def.id, remediation: `List markets with get_markets (exchange: ${def.id})` });
    }
    const res = await fetch(`${networkConfig(def, MCP_NETWORK).restUrl}/api/v1/orderBookOrders?market_id=${market.venueSymbol}&limit=20`);
    if (!res.ok) throw new PerpError("EXCHANGE_ERROR", `${def.displayName} orderBookOrders ${sym}: HTTP ${res.status}`, { exchange: def.id });
    const data = await res.json() as { bids?: unknown; asks?: unknown };
    if (!Array.isArray(data.bids) || !Array.isArray(data.asks)) {
      throw new PerpError("EXCHANGE_ERROR", `${def.displayName} orderBookOrders ${sym}: unexpected payload (no bids / asks arrays)`, { exchange: def.id });
    }
    type LighterLevel = { price?: unknown; remaining_base_amount?: unknown; size?: unknown };
    const side = (ls: unknown[]) => ls.map(l => {
      const lv = l as LighterLevel;
      return bookLevel(def.id, sym, lv.price, lv.remaining_base_amount !== undefined ? lv.remaining_base_amount : lv.size);
    });
    return { bids: side(data.bids), asks: side(data.asks) };
  }
  // Read-only adapter: no key material, public endpoints only.
  const ro = await requireCreate(def)({ network: MCP_NETWORK, credentials: READ_ONLY_CREDENTIALS, noAgent: true, hlDex: null, readOnly: true, noBuilder: true });
  return ro.getOrderbook(sym);
}

// ── JSON envelope helpers ──

function ok(data: unknown, meta?: Record<string, unknown>) {
  return JSON.stringify({ ok: true, data, meta: { ...meta, network: MCP_NETWORK } }, null, 2);
}

/**
 * Error envelope from a thrown value: the STRUCTURED error (classifyError — a PerpError keeps its
 * code / remediation / details verbatim), never just the message. An ORDER_PENDING order must
 * reach the agent as code + "Do NOT resubmit" remediation, or it would retry and double-trade.
 */
function errOf(e: unknown, meta?: Record<string, unknown>, top?: Record<string, unknown>) {
  const s = classifyError(e, typeof meta?.exchange === "string" ? meta.exchange : undefined);
  return JSON.stringify({
    ok: false,
    error: s.message,
    code: s.code,
    retryable: s.retryable,
    ...(s.remediation !== undefined ? { remediation: s.remediation } : {}),
    ...(s.details !== undefined ? { details: s.details } : {}),
    // Tool-specific top-level facts an agent must not miss (e.g. trade_execute executed:false / pending:true).
    ...top,
    meta: { ...meta, network: MCP_NETWORK },
  }, null, 2);
}

/** Hyperliquid scope of every MCP tool: the server builds adapters with no HIP-3 dex (hlDex null). */
const HL_SCOPE_NOTE = "Hyperliquid: native perps only (HIP-3 dexes via the CLI --dex).";

/**
 * Venues with a `perp funds deposit <venue>` command. lighter takes a route (ethereum | cctp <chain>);
 * qfex takes no amount (it shows the deposit address). Tested against the real command tree.
 */
export const MCP_DEPOSIT_VENUES: readonly string[] = ["pacifica", "hyperliquid", "lighter", "lighter-rh", "aster", "ondo", "qfex"];
/** Venues with a `perp funds withdraw <venue>` command. Tested against the real command tree. */
export const MCP_WITHDRAW_VENUES: readonly string[] = ["pacifica", "hyperliquid", "lighter", "aster", "arcus"];

// ── MCP Server ──

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const server = new McpServer(
  { name: "perp-cli", version: _pkg.version },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// Pacifica Print + vaults: read-only tools (src/mcp-pacifica-earn.ts).
registerPacificaEarnMcpTools(server, MCP_NETWORK, ok, errOf);

// ============================================================
// Market Data tools (read-only, no private key needed)
// ============================================================

server.tool(
  "get_markets",
  `Get all available perpetual futures markets on an exchange, including price, funding rate, volume, and max leverage. Works without API keys (public market data). ${HL_SCOPE_NOTE}`,
  { exchange: z.string().describe(`Exchange name: ${listVenues().map(v => v.id).join(", ")} (aliases accepted)`) },
  async ({ exchange }) => {
    try {
      // Try adapter first (richer data), fall back to public API (no key needed)
      const adapter = await tryGetAdapter(exchange);
      if (adapter) {
        const markets = labelMarketRows(exchange, await adapter.getMarkets());
        return { content: [{ type: "text", text: ok(markets, { exchange, count: markets.length, ...apiMeta(exchange), ...fundingWarningMeta(exchange, markets) }) }] };
      }
      // No credentials: the venue's public directory — price-only on GRVT (no 184-request
      // margin_rules fan-out per call) — in the CLI market-row shape (venueMarketRow), with the
      // same market set as `perp market list` (the venue's shared eligibility / listing rule).
      const markets = await fetchMarketRowsPublic(exchange);
      return { content: [{ type: "text", text: ok(markets, { exchange, count: markets.length, source: "public", ...apiMeta(exchange), ...fundingWarningMeta(exchange, markets) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_orderbook",
  `Get the order book (bids and asks) for a symbol on an exchange. Works without API keys on every venue with an account API (configured credentials → the account adapter; none → the public endpoint / read-only adapter); market-data-only venues have no orderbook path. ${HL_SCOPE_NOTE}`,
  {
    exchange: z.string().describe(`Exchange name: ${listVenues().map(v => v.id).join(", ")} (aliases accepted)`),
    symbol: z.string().describe("Trading pair symbol, e.g. BTC, ETH, SOL"),
  },
  async ({ exchange, symbol }) => {
    try {
      // Try adapter first (richer data), fall back to public API (no key needed)
      const adapter = await tryGetAdapter(exchange);
      if (adapter) {
        const book = await adapter.getOrderbook(symbol);
        return { content: [{ type: "text", text: ok(book, { exchange, symbol, ...apiMeta(exchange) }) }] };
      }
      const book = await fetchOrderbookPublic(exchange, symbol);
      return { content: [{ type: "text", text: ok(book, { exchange, symbol, source: "public", ...apiMeta(exchange) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange, symbol }) }], isError: true };
    }
  },
);

server.tool(
  "get_funding_rates",
  "Compare funding rates across every market-data venue whose funding rate is verified. Returns rates per symbol with spread analysis. includeUnverified also returns venues whose rate is unverified (QFEX; TxFlow — unofficial API; Variational — a predicted rate not checked against settled payments; GRVT — indicative rate; Extended — not checked against settled payments), each row tagged fundingVerified / apiStatus — display only, never a basis for trading (mirrors the CLI `arb scan --include-unverified`).",
  {
    symbols: z
      .array(z.string())
      .optional()
      .describe("Filter to specific symbols (e.g. ['BTC','ETH']). Omit for all available"),
    minSpread: z.number().optional().describe("Minimum annualized spread % to include (default: 0)"),
    includeUnverified: z.boolean().optional().describe("Also include venues whose funding rate is unverified (default false); rows carry fundingVerified:false / apiStatus"),
  },
  async ({ symbols, minSpread, includeUnverified }) => {
    try {
      const snapshot = await fetchAllFundingRates({ symbols, minSpread, includeUnverified: includeUnverified === true });
      return {
        content: [{
          type: "text",
          text: ok(snapshot, { symbolCount: snapshot.symbols.length, exchangeStatus: snapshot.exchangeStatus }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

server.tool(
  "get_prices",
  "Get cross-exchange prices for symbols. Fetches mark prices from every market-data venue for comparison; a venue appears in a row only when it lists that symbol (e.g. QFEX lists no BTC). Each row's unofficialApiVenues names the venues in it read through an undocumented API (TxFlow) — like get_markets' venueApi tag.",
  {
    symbols: z
      .array(z.string())
      .optional()
      .describe("Symbols to fetch prices for (e.g. ['BTC','ETH']). Omit for top assets"),
  },
  async ({ symbols }) => {
    try {
      const venues = listVenuesWithRole("marketData").map(v => v.id);
      const results = await Promise.allSettled(venues.map(ex => fetchMarketsPublic(ex)));
      const filter = symbols ? new Set(symbols.map(s => s.toUpperCase())) : null;

      // Build symbol → exchange prices map; per-venue failures are reported in meta.errors
      const priceMap = new Map<string, Record<string, number>>();
      const errors: Record<string, string> = {};
      results.forEach((r, i) => {
        const ex = venues[i];
        if (r.status === "rejected") {
          errors[ex] = r.reason instanceof Error ? r.reason.message : String(r.reason);
          return;
        }
        for (const m of r.value) {
          // An ambiguous ticker (SPX6900 vs the S&P 500) names different instruments per venue:
          // never grouped by symbol across venues.
          if (m.assetClass === "unclassified") continue;
          const sym = m.symbol.toUpperCase();
          if (filter && !filter.has(sym)) continue;
          if (!priceMap.has(sym)) priceMap.set(sym, {});
          priceMap.get(sym)![ex] = Number(m.markPrice);
        }
      });

      const unofficial: string[] = listVenuesWithRole("marketData").filter(v => v.apiStatus.kind === "unofficial").map(v => v.id);
      const data = Array.from(priceMap.entries()).map(([symbol, prices]) => ({
        symbol,
        prices,
        unofficialApiVenues: Object.keys(prices).filter(ex => unofficial.includes(ex)),
      }));
      return { content: [{ type: "text", text: ok(data, { count: data.length, errors, unofficialApiVenues: unofficial }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

// ============================================================
// Outcome markets (Hyperliquid HIP-4) — public reads
// ============================================================

server.tool(
  "get_outcome_markets",
  "List active Hyperliquid Outcome markets (HIP-4). Each market has parsed metadata (underlying asset, target price, expiry, period) and per-side info (Yes/No name, encoding, asset id, current mid). Public read — no API key needed.",
  {},
  async () => {
    try {
      const { HyperliquidAdapter } = await import("./exchanges/hyperliquid.js");
      const { HyperliquidOutcomeAdapter } = await import("./exchanges/hyperliquid-outcome.js");
      const hl = new HyperliquidAdapter(undefined, MCP_NETWORK === "testnet");
      await hl.init();
      const out = new HyperliquidOutcomeAdapter(hl);
      const markets = await out.getMarkets();
      return { content: [{ type: "text", text: ok(markets, { count: markets.length, source: "outcomeMeta" }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

server.tool(
  "get_outcome_view",
  "Get a combined view of one outcome market: all sides' books in parallel + underlying mark price gap (vs targetPrice) + time to expiry + per-side implied probability (mid sum). For binary markets, the symmetric structure means Yes bid + No ask ≈ 1.0 — the view exposes both sides in a single round-trip and surfaces directional context (e.g., is BTC currently above the target). Public read.",
  {
    outcome: z.number().int().nonnegative().describe("Outcome id from outcomeMeta (e.g., 1 for the BTC binary daily)"),
    depth: z.number().int().min(1).max(50).optional().default(10).describe("Number of book levels per side"),
  },
  async ({ outcome, depth }) => {
    try {
      const { HyperliquidAdapter } = await import("./exchanges/hyperliquid.js");
      const { HyperliquidOutcomeAdapter } = await import("./exchanges/hyperliquid-outcome.js");
      const hl = new HyperliquidAdapter(undefined, MCP_NETWORK === "testnet");
      await hl.init();
      const out = new HyperliquidOutcomeAdapter(hl);
      const view = await out.getView(outcome, depth);
      return { content: [{ type: "text", text: ok(view, { outcome, depth }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { outcome }) }], isError: true };
    }
  },
);

server.tool(
  "get_outcome_book",
  "Get the orderbook for one outcome side. Public read — no API key needed.",
  {
    outcome: z.number().int().nonnegative().describe("Outcome id from outcomeMeta (e.g., 1 for the BTC binary daily)"),
    side: z.number().int().min(0).max(9).describe("Side index within the outcome (0 = first sideSpecs entry like 'Yes', 1 = second like 'No')"),
  },
  async ({ outcome, side }) => {
    try {
      const { HyperliquidAdapter } = await import("./exchanges/hyperliquid.js");
      const { HyperliquidOutcomeAdapter } = await import("./exchanges/hyperliquid-outcome.js");
      const hl = new HyperliquidAdapter(undefined, MCP_NETWORK === "testnet");
      await hl.init();
      const out = new HyperliquidOutcomeAdapter(hl);
      const book = await out.getOrderbook(outcome, side);
      return { content: [{ type: "text", text: ok(book, { outcome, side, assetId: HyperliquidOutcomeAdapter.assetId(outcome, side) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { outcome, side }) }], isError: true };
    }
  },
);

// ============================================================
// Options market data (read-only, keyless; venues: src/exchanges/options-venues.ts)
// ============================================================

const OPTIONS_VENUE_ARG = z.string().describe(`Options venue: ${listOptionsVenueIds().join(", ")}`);

server.tool(
  "get_option_expiries",
  "List the active option expiries of an underlying on an options venue (Derive): per expiry the UTC date (YYYY-MM-DD), expiry ms, strike and instrument counts, soonest first. Public read — no API key needed.",
  { venue: OPTIONS_VENUE_ARG, underlying: z.string().describe("Underlying, e.g. ETH, BTC") },
  async ({ venue, underlying }) => {
    try {
      const data = await (await getOptionsVenue(venue, MCP_NETWORK)).listExpiries(underlying);
      return { content: [{ type: "text", text: ok(data, { venue, count: data.expiries.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { venue, underlying }) }], isError: true };
    }
  },
);

server.tool(
  "get_option_chain",
  "Option chain for one expiry (Derive): rows per strike with call and put quotes — bid / ask (price + size; null = empty side), mark, index, forward, IV (mark / bid / ask; null = not computable), greeks (delta, gamma, theta, vega, rho), open interest, 24h volume — plus the ATM strike. Decimals are strings. One venue request per expiry. Public read.",
  {
    venue: OPTIONS_VENUE_ARG,
    underlying: z.string().describe("Underlying, e.g. ETH, BTC"),
    expiry: z.string().optional().describe("Expiry date YYYY-MM-DD (UTC); omit for the nearest active expiry (result expirySelection: \"nearest\")"),
    strikes: z.number().int().min(1).optional().describe("Only the N strikes closest to the ATM reference (forward, else index); omit for all strikes"),
  },
  async ({ venue, underlying, expiry, strikes }) => {
    try {
      const chain = await (await getOptionsVenue(venue, MCP_NETWORK)).getChain({
        underlying, expiry: expiry === undefined ? null : expiry, strikesAroundAtm: strikes === undefined ? null : strikes,
      });
      return { content: [{ type: "text", text: ok(chain, { venue, expiry: chain.expiry, rows: chain.rows.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { venue, underlying }) }], isError: true };
    }
  },
);

server.tool(
  "get_option_quote",
  "Quote one option instrument (Derive name, e.g. ETH-20261225-3500-P): bid / ask (price + size), mark, index, forward, IV, greeks, open interest, 24h stats. Unknown instrument → SYMBOL_NOT_FOUND. Public read.",
  { venue: OPTIONS_VENUE_ARG, instrument: z.string().describe("Venue instrument name, e.g. ETH-20261225-3500-P") },
  async ({ venue, instrument }) => {
    try {
      const q = await (await getOptionsVenue(venue, MCP_NETWORK)).getQuote(instrument);
      return { content: [{ type: "text", text: ok(q, { venue, instrument: q.instrument }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { venue, instrument }) }], isError: true };
    }
  },
);

// ============================================================
// Account tools (need private key)
// ============================================================

server.tool(
  "get_outcome_positions",
  "Get the active account's open outcome positions (size, entry notional, mark price, unrealized PnL). Requires a configured Hyperliquid wallet or agent.",
  {},
  async () => {
    try {
      const { HyperliquidAdapter } = await import("./exchanges/hyperliquid.js");
      const { HyperliquidOutcomeAdapter } = await import("./exchanges/hyperliquid-outcome.js");
      const adapter = await getOrCreateAdapter("hyperliquid");
      if (!(adapter instanceof HyperliquidAdapter)) {
        throw new PerpError("CAPABILITY_UNSUPPORTED", "Outcome positions are Hyperliquid-only", { exchange: "hyperliquid" });
      }
      const out = new HyperliquidOutcomeAdapter(adapter);
      const positions = await out.getPositions();
      return { content: [{ type: "text", text: ok(positions, { count: positions.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange: "hyperliquid" }) }], isError: true };
    }
  },
);

server.tool(
  "get_balance",
  `Get account balance (equity, available margin, margin used, unrealized PnL) on an exchange. ${HL_SCOPE_NOTE}`,
  { exchange: z.string().describe(`Exchange name: ${listVenues().map(v => v.id).join(", ")} (aliases accepted)`) },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const balance = await adapter.getBalance();
      return { content: [{ type: "text", text: ok(balance, { exchange }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_positions",
  `Get all open positions on an exchange, including size, entry price, PnL, leverage. ${HL_SCOPE_NOTE}`,
  { exchange: z.string().describe(`Exchange name: ${listVenues().map(v => v.id).join(", ")} (aliases accepted)`) },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const positions = await adapter.getPositions();
      return { content: [{ type: "text", text: ok(positions, { exchange, count: positions.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_positions_by_address",
  `Open positions of ANY account by its public address — keyless, read-only (public venue data; nothing is signed, no key is needed). Venues: ${listPublicPositionVenues().map(v => `${v.id} (${v.publicData.addressKind === "solana" ? "base58 Solana address" : "0x address"})`).join(", ")}. Hyperliquid reads the native dex and every HIP-3 dex (rows carry dex: null | "<dex>"; a dex that fails is listed in meta.errors / meta.warnings — its rows are missing, not absent); Lighter reads every account of the address (rows carry accountIndex; accountIndex narrows). Other venues: CAPABILITY_UNSUPPORTED; a wrong address format: INVALID_PARAMS. Same rows as \`perp -e <venue> account positions --address <addr>\`.`,
  {
    exchange: z.string().describe(`Exchange: ${listPublicPositionVenues().map(v => v.id).join(", ")} (aliases accepted)`),
    address: z.string().describe("Public account address (0x… for hyperliquid / lighter / lighter-rh; base58 Solana for pacifica)"),
    symbol: z.string().optional().describe("Only this market (plain asset, e.g. BTC)"),
    accountIndex: z.number().int().nonnegative().optional().describe("Lighter only: one account (sub-account) of the address"),
  },
  async ({ exchange, address, symbol, accountIndex }) => {
    try {
      const r = await readPositionsByAddress(exchange, MCP_NETWORK, address, { symbol, accountIndex });
      return { content: [{ type: "text", text: ok(r.positions, {
        exchange: r.venue, address, source: "public", count: r.positions.length,
        ...(r.warnings.length > 0 ? { warnings: r.warnings, errors: r.errors } : {}),
        ...(r.notes.length > 0 ? { notes: r.notes } : {}),
      }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_balance_by_address",
  `Balances of ANY account by its public address — keyless, read-only (public venue data; nothing is signed, no key is needed). Venues: ${listPublicBalanceVenues().map(v => `${v.id} (${v.publicData.addressKind === "solana" ? "base58 Solana address" : "0x address"})`).join(", ")}; omit exchange to read every one of them (a venue that fails, address format included, is listed in data.errors). data: { balance (equity / available / marginUsed / unrealizedPnl + venue extras; null on Lighter), spot (token balances; null where the venue does not publish them), accounts (Lighter: one row per account of the address; accountIndex narrows), dexes + accountMode (Hyperliquid: HIP-3 dexes with a non-zero account value; a dex that fails is in meta.errors / meta.warnings — unknown, not zero) }. Other venues: CAPABILITY_UNSUPPORTED; a wrong address format: INVALID_PARAMS. Same data as \`perp [-e <venue>] account balance --address <addr>\`.`,
  {
    exchange: z.string().optional().describe(`Exchange: ${listPublicBalanceVenues().map(v => v.id).join(", ")} (aliases accepted); omit for every one`),
    address: z.string().describe("Public account address (0x… for hyperliquid / lighter / lighter-rh / risex; base58 Solana for pacifica)"),
    accountIndex: z.number().int().nonnegative().optional().describe("Lighter only: one account (sub-account) of the address"),
  },
  async ({ exchange, address, accountIndex }) => {
    try {
      if (exchange === undefined) {
        const all = await readBalanceByAddressAll(MCP_NETWORK, address, { accountIndex });
        return { content: [{ type: "text", text: ok({
          venues: all.venues,
          ...(Object.keys(all.errors).length > 0 ? { errors: all.errors } : {}),
          ...(Object.keys(all.notes).length > 0 ? { notes: all.notes } : {}),
        }, { address, source: "public", ...(all.warnings.length > 0 ? { warnings: all.warnings } : {}) }) }] };
      }
      const r = await readBalanceByAddress(exchange, MCP_NETWORK, address, { accountIndex });
      return { content: [{ type: "text", text: ok({ exchange: r.venue, address, ...r.data }, {
        exchange: r.venue, address, source: "public",
        ...(r.warnings.length > 0 ? { warnings: r.warnings, errors: r.errors } : {}),
        ...(r.notes.length > 0 ? { notes: r.notes } : {}),
      }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "get_open_orders",
  `Get all open/pending orders on an exchange. ${HL_SCOPE_NOTE}`,
  { exchange: z.string().describe(`Exchange name: ${listVenues().map(v => v.id).join(", ")} (aliases accepted)`) },
  async ({ exchange }) => {
    try {
      const adapter = await getOrCreateAdapter(exchange);
      const orders = await adapter.getOpenOrders();
      return { content: [{ type: "text", text: ok(orders, { exchange, count: orders.length }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange }) }], isError: true };
    }
  },
);

server.tool(
  "portfolio",
  "Cross-exchange portfolio summary: balances, positions, and risk metrics across all exchanges with configured credentials",
  {},
  async () => {
    const EXCHANGES = await listConfiguredAccountVenues();

    interface ExchangeSnapshot {
      exchange: string;
      connected: boolean;
      balance: { equity: string; available: string; marginUsed: string; unrealizedPnl: string } | null;
      positions: Awaited<ReturnType<ExchangeAdapter["getPositions"]>>;
      openOrders: number;
      error?: string;
    }

    const snapshots: ExchangeSnapshot[] = await Promise.all(
      EXCHANGES.map(async (name) => {
        try {
          const adapter = await getOrCreateAdapter(name);
          const [balance, positions, orders] = await Promise.all([
            adapter.getBalance(),
            adapter.getPositions(),
            adapter.getOpenOrders(),
          ]);
          return { exchange: name, connected: true, balance, positions, openOrders: orders.length };
        } catch (e) {
          return {
            exchange: name,
            connected: false,
            balance: null,
            positions: [],
            openOrders: 0,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    // Totals are null (unknown) when no account balance was read — no configured credentials, or
    // every venue failed — never 0 (QA 0.15.0: totalEquity 0 without credentials).
    const read = snapshots.filter(s => s.balance !== null);
    let totalEquity = 0;
    let totalAvailable = 0;
    let totalMarginUsed = 0;
    let totalUnrealizedPnl = 0;
    let totalPositions = 0;
    let totalOpenOrders = 0;
    const allPositions: (Awaited<ReturnType<ExchangeAdapter["getPositions"]>>[number] & { exchange: string })[] = [];

    for (const snap of snapshots) {
      if (snap.balance) {
        totalEquity += Number(snap.balance.equity);
        totalAvailable += Number(snap.balance.available);
        totalMarginUsed += Number(snap.balance.marginUsed);
        totalUnrealizedPnl += Number(snap.balance.unrealizedPnl);
      }
      totalPositions += snap.positions.length;
      totalOpenOrders += snap.openOrders;
      for (const pos of snap.positions) {
        allPositions.push({ ...pos, exchange: snap.exchange });
      }
    }

    const marginUtilization = totalEquity > 0 ? (totalMarginUsed / totalEquity) * 100 : 0;

    let largestPosition: { symbol: string; exchange: string; notional: number } | null = null;
    for (const pos of allPositions) {
      const notional = Math.abs(Number(pos.size) * Number(pos.markPrice));
      if (!largestPosition || notional > largestPosition.notional) {
        largestPosition = { symbol: pos.symbol, exchange: pos.exchange, notional };
      }
    }

    const exchangeConcentration = snapshots
      .filter(s => s.balance && Number(s.balance.equity) > 0)
      .map(s => ({
        exchange: s.exchange,
        pct: totalEquity > 0 ? (Number(s.balance!.equity) / totalEquity) * 100 : 0,
      }))
      .sort((a, b) => b.pct - a.pct);

    const known = read.length > 0;
    const summary = {
      /** "noAccount" = no venue has credentials; "unread" = credentials exist but no balance was read. */
      accountState: EXCHANGES.length === 0 ? "noAccount" : known ? "ok" : "unread",
      /** Venues whose balances the totals cover. */
      totalsCover: read.map(s => s.exchange),
      totalEquity: known ? totalEquity : null,
      totalAvailable: known ? totalAvailable : null,
      totalMarginUsed: known ? totalMarginUsed : null,
      totalUnrealizedPnl: known ? totalUnrealizedPnl : null,
      totalPositions,
      totalOpenOrders,
      exchanges: snapshots,
      positions: allPositions,
      riskMetrics: { marginUtilization: known ? marginUtilization : null, largestPosition, exchangeConcentration },
    };

    return { content: [{ type: "text", text: ok(summary) }] };
  },
);

// ============================================================
// Advisory tools (suggest CLI commands, do NOT execute trades)
// ============================================================

server.tool(
  "suggest_command",
  "Given a natural language trading goal, suggest the exact perp CLI commands to run. Does NOT execute anything — only returns commands for the user to review and run manually",
  {
    goal: z.string().describe("Natural language goal, e.g. 'buy 0.1 BTC on pacifica', 'close all positions', 'check funding arb opportunities'"),
    exchange: z.string().optional().describe(`Preferred exchange (default: settings.defaultExchange, else pacifica — the CLI's -e default). Options: ${listVenuesWithRole("trading").map(v => v.id).join(", ")}`),
  },
  async ({ goal, exchange }) => {
    try {
      // Same default as the CLI's -e (src/index.ts): settings.defaultExchange, else pacifica. Aliases resolve; unknown names throw.
      const ex = getVenue(exchange ?? (loadSettings().defaultExchange || "pacifica")).id;
      const g = goal.toLowerCase();
      const steps: { step: number; command: string; description: string; dangerous?: boolean }[] = [];

      if (g.includes("buy") || g.includes("long")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "<size>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook and liquidity` },
          { step: 2, command: `perp -e ${ex} --json portfolio`, description: "Check available balance and margin" },
          { step: 3, command: `perp -e ${ex} --json trade check ${symbol} buy ${size}`, description: "Pre-flight validation (read-only, sends nothing)" },
          { step: 4, command: `perp -e ${ex} --json trade market ${symbol} buy ${size}`, description: `Buy ${size} ${symbol} at market`, dangerous: true },
          { step: 5, command: `perp -e ${ex} --json account positions`, description: "Verify position opened" },
        );
      } else if (g.includes("sell") || g.includes("short")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "<size>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook and liquidity` },
          { step: 2, command: `perp -e ${ex} --json portfolio`, description: "Check available balance and margin" },
          { step: 3, command: `perp -e ${ex} --json trade check ${symbol} sell ${size}`, description: "Pre-flight validation (read-only, sends nothing)" },
          { step: 4, command: `perp -e ${ex} --json trade market ${symbol} sell ${size}`, description: `Sell ${size} ${symbol} at market`, dangerous: true },
          { step: 5, command: `perp -e ${ex} --json account positions`, description: "Verify position opened" },
        );
      } else if (g.includes("limit")) {
        const symbol = extractSymbol(g) || "BTC";
        const size = extractNumber(g) || "<size>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook for price levels` },
          { step: 2, command: `perp -e ${ex} --json portfolio`, description: "Check available balance" },
          { step: 3, command: `perp -e ${ex} --json trade limit ${symbol} ${side} <price> ${size}`, description: `Place limit ${side} order`, dangerous: true },
          { step: 4, command: `perp -e ${ex} --json account orders`, description: "Verify order placed" },
        );
      } else if (g.includes("close") || g.includes("exit") || g.includes("flatten")) {
        const symbol = extractSymbol(g);
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Get current positions" },
        );
        if (g.includes("flatten")) {
          steps.push(
            { step: 2, command: `perp -e ${ex} --json trade flatten`, description: "Cancel all orders + close all positions", dangerous: true },
          );
        } else if (symbol) {
          steps.push(
            { step: 2, command: `perp -e ${ex} --json trade close ${symbol}`, description: `Close ${symbol} position at market`, dangerous: true },
          );
        } else {
          steps.push(
            { step: 2, command: `perp -e ${ex} --json trade cancel-all`, description: "Cancel any open orders first", dangerous: true },
            { step: 3, command: `perp -e ${ex} --json trade close-all`, description: "Close all positions at market", dangerous: true },
          );
        }
      } else if (g.includes("tp") || g.includes("take profit") || g.includes("scale-tp")) {
        const symbol = extractSymbol(g) || "<symbol>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position size and entry" },
          { step: 2, command: `perp -e ${ex} --json market book ${symbol}`, description: "Check current prices" },
          { step: 3, command: `perp -e ${ex} --json trade scale-tp ${symbol} --levels '<price1>:25%,<price2>:50%,<price3>:25%'`, description: "Place scaled take-profit orders", dangerous: true },
        );
      } else if (g.includes("scale-in") || g.includes("scale in") || g.includes("dca in")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: "Check current prices" },
          { step: 2, command: `perp -e ${ex} --json portfolio`, description: "Check available balance" },
          { step: 3, command: `perp -e ${ex} --json trade scale-in ${symbol} ${side} --levels '<price1>:<size>,<price2>:<size>'`, description: "Place scaled entry orders at multiple levels", dangerous: true },
        );
      } else if (g.includes("tpsl") || g.includes("tp/sl") || g.includes("tp sl") || (g.includes("take profit") && g.includes("stop loss"))) {
        const symbol = extractSymbol(g) || "<symbol>";
        const side = g.includes("sell") || g.includes("short") ? "short" : "long";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position (side and size)" },
          { step: 2, command: `perp -e ${ex} --json trade tpsl ${symbol} ${side} --tp <price> --sl <price>`, description: "Set reduce-only TP/SL on the position (positionSide = long|short)", dangerous: true },
          { step: 3, command: `perp -e ${ex} --json account orders`, description: "Verify TP/SL orders placed" },
        );
      } else if (g.includes("trailing") || g.includes("trail")) {
        const symbol = extractSymbol(g) || "<symbol>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position" },
          { step: 2, command: `perp -e ${ex} --json strategy trailing-stop ${symbol} --trail <pct>`, description: "Run a client-side trailing stop (closes the position when the trail % is hit)", dangerous: true },
        );
      } else if (g.includes("stop") || g.includes("sl") || g.includes("stop loss")) {
        const symbol = extractSymbol(g) || "<symbol>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position" },
          { step: 2, command: `perp -e ${ex} --json trade stop ${symbol} <side> <size> <stopPrice>`, description: "Place stop order", dangerous: true },
        );
      } else if (g.includes("split") || g.includes("depth") || (g.includes("large") && (g.includes("order") || g.includes("buy") || g.includes("sell")))) {
        const symbol = extractSymbol(g) || "<symbol>";
        const amount = extractNumber(g) || "<usd>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `Check ${symbol} orderbook depth` },
          { step: 2, command: `perp -e ${ex} --json portfolio`, description: "Check available balance" },
          { step: 3, command: `perp -e ${ex} --json trade split ${symbol} ${side} ${amount}`, description: `Split ${side} $${amount} ${symbol} into depth-based slices`, dangerous: true },
          { step: 4, command: `perp -e ${ex} --json account positions`, description: "Verify position opened" },
        );
      } else if (g.includes("twap")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const size = extractNumber(g) || "<size>";
        const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json portfolio`, description: "Check available balance" },
          { step: 2, command: `perp -e ${ex} --json trade twap ${symbol} ${side} ${size} <duration>`, description: `TWAP ${side} ${size} ${symbol} over duration`, dangerous: true },
        );
      } else if (g.includes("reduce")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const pct = extractNumber(g) || "<percent>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account positions`, description: "Check current position size" },
          { step: 2, command: `perp -e ${ex} --json trade reduce ${symbol} ${pct}`, description: `Reduce ${symbol} position by ${pct}%`, dangerous: true },
        );
      } else if (g.includes("edit") || g.includes("modify order")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json account orders`, description: "List open orders to find order ID" },
          { step: 2, command: `perp -e ${ex} --json trade edit <symbol> <orderId> <price> <size>`, description: "Modify the order", dangerous: true },
        );
      } else if (g.includes("arb") || g.includes("arbitrage")) {
        steps.push(
          { step: 1, command: "perp --json arb scan --min 5", description: "Scan funding rate arbitrage opportunities" },
          { step: 2, command: "perp --json arb scan --gaps", description: "Check cross-exchange price gaps" },
          { step: 3, command: "perp --json arb scan --hip3", description: "HIP-3 cross-dex arb opportunities (Hyperliquid)" },
        );
      } else if (g.includes("funding")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp --json arb scan --rates`, description: `Funding rates across all exchanges` },
            { step: 2, command: `perp -e ${ex} --json market funding ${symbol}`, description: `${symbol} funding history` },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json arb scan --rates", description: "Funding rates across all exchanges" },
            { step: 2, command: "perp --json arb scan --min 5", description: "Funding rate arb opportunities" },
          );
        }
      } else if (g.includes("bridge") || g.includes("transfer") || g.includes("cross-chain")) {
        const amount = extractNumber(g) || "<amount>";
        steps.push(
          { step: 1, command: "perp --json funds bridge chains", description: "List supported chains" },
          { step: 2, command: `perp --json funds bridge quote --from <chain> --to <chain> --amount ${amount}`, description: "Get bridge quote with fees" },
          { step: 3, command: `perp --json funds bridge send --from <chain> --to <chain> --amount ${amount}`, description: "Execute bridge transfer", dangerous: true },
          { step: 4, command: "perp --json funds bridge status <orderId>", description: "Track bridge completion" },
        );
      } else if (g.includes("grid") || g.includes("dca") || g.includes("bot")) {
        const symbol = extractSymbol(g) || "<symbol>";
        if (g.includes("grid")) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: "Check current price" },
            { step: 2, command: `perp -e ${ex} --json strategy quick-grid ${symbol}`, description: "Start grid bot", dangerous: true },
            { step: 3, command: "perp --json background list", description: "Verify bot is running" },
          );
        } else if (g.includes("dca")) {
          const amount = extractNumber(g) || "<amount>";
          const side = g.includes("sell") || g.includes("short") ? "sell" : "buy";
          steps.push(
            { step: 1, command: `perp -e ${ex} --json portfolio`, description: "Check available balance" },
            { step: 2, command: `perp -e ${ex} --json strategy quick-dca ${symbol} ${side} ${amount} <interval>`, description: "Start DCA bot", dangerous: true },
            { step: 3, command: "perp --json background list", description: "Verify bot is running" },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json strategy preset-list", description: "List available bot presets" },
            { step: 2, command: `perp -e ${ex} --json strategy quick-arb`, description: "Start arb bot", dangerous: true },
            { step: 3, command: "perp --json background list", description: "Verify bot is running" },
          );
        }
      } else if (g.includes("backtest")) {
        if (g.includes("grid")) {
          steps.push(
            { step: 1, command: "perp --json backtest grid", description: "Backtest grid strategy on historical data" },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json backtest funding-arb", description: "Backtest funding arb strategy" },
          );
        }
      } else if (g.includes("setup") || g.includes("init") || g.includes("configure") || g.includes("connect") || g.includes("set key") || g.includes("set wallet") || g.includes("private key")) {
        steps.push(
          { step: 1, command: "perp --json wallet show", description: "Check if any wallets are already configured" },
          { step: 2, command: "printf '%s' \"$KEY\" | OWS_PASSPHRASE=<pp> perp --json wallet set <exchange>", description: "Import the master key (stdin — never argv) into the OWS vault and make it the active wallet. wallet set takes pacifica, hyperliquid, lighter, aster (aliases: hl, pac, lt, ast); Lighter RH / Ondo / Arcus register with perp wallet agent approve <lighter-rh|ondo|arcus>, QFEX with perp wallet agent import qfex" },
          { step: 3, command: "printf '%s' \"$KEY\" | OWS_PASSPHRASE=<pp> perp --json wallet set <exchange> --default", description: "Import key + make it the default exchange" },
          { step: 4, command: "perp --json wallet show", description: "Verify wallet is configured (shows public address)" },
        );
      } else if (g.includes("wallet") || g.includes("balance") || g.includes("on-chain")) {
        steps.push(
          { step: 1, command: "perp --json wallet show", description: "Show configured wallets with public addresses" },
          { step: 2, command: "perp --json wallet balance", description: "Check on-chain balances" },
        );
      } else if (g.includes("risk")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json risk status`, description: "Portfolio risk overview" },
          { step: 2, command: `perp -e ${ex} --json risk limits`, description: "Current position limits" },
        );
      } else if (g.includes("analytic") || g.includes("performance") || g.includes("pnl") || g.includes("p&l")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json history summary`, description: "Trading performance summary" },
          { step: 2, command: `perp -e ${ex} --json history pnl`, description: "P&L breakdown" },
          { step: 3, command: `perp -e ${ex} --json history funding`, description: "Funding payment history" },
        );
      } else if (g.includes("history") || g.includes("log") || g.includes("audit")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json history list`, description: "Execution audit trail" },
          { step: 2, command: `perp -e ${ex} --json history stats`, description: "Execution statistics" },
        );
      } else if (g.includes("live") || g.includes("watch") || g.includes("realtime")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `${symbol} orderbook` },
            { step: 2, command: `perp -e ${ex} --json market trades ${symbol}`, description: `${symbol} recent trades` },
            { step: 3, command: `perp --json arb scan --gaps --live`, description: "Live cross-exchange price gap monitor" },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json arb scan --gaps --live", description: "Live cross-exchange price gap monitor" },
            { step: 2, command: `perp -e ${ex} --json market prices`, description: "Current prices across exchanges" },
          );
        }
      } else if (g.includes("gap")) {
        steps.push(
          { step: 1, command: "perp --json arb scan --gaps", description: "Cross-exchange price gaps" },
          { step: 2, command: "perp --json arb scan --gaps --live", description: "Live gap monitor" },
        );
      } else if (g.includes("rebalance")) {
        steps.push(
          { step: 1, command: "perp --json funds rebalance check", description: "Check balance distribution" },
          { step: 2, command: "perp --json funds rebalance plan", description: "Generate rebalance plan" },
          { step: 3, command: "perp --json funds rebalance execute", description: "Execute rebalance", dangerous: true },
        );
      } else if (g.includes("job") || g.includes("running") || g.includes("background")) {
        steps.push(
          { step: 1, command: "perp --json background list", description: "List running background jobs" },
        );
      } else if (g.includes("dex") || g.includes("hip-3") || g.includes("hip3")) {
        steps.push(
          { step: 1, command: "perp --json -e hl market hip3", description: "List HIP-3 deployed dexes" },
          { step: 2, command: "perp --json -e hl --dex <name> market list", description: "Show markets on a specific dex" },
        );
      } else if (g.includes("plan") || g.includes("composite") || g.includes("multi-step")) {
        steps.push(
          { step: 1, command: "perp strategy plan example", description: "Show example execution plan format" },
          { step: 2, command: "perp --json strategy plan validate <file>", description: "Validate plan file" },
          { step: 3, command: "perp --json strategy plan execute <file> --dry-run", description: "Dry-run the plan", dangerous: true },
        );
      } else if (g.includes("status") || g.includes("check") || g.includes("overview") || g.includes("portfolio")) {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json portfolio`, description: "Single-exchange portfolio overview" },
          { step: 2, command: `perp -e ${ex} --json account positions`, description: "Detailed positions" },
          { step: 3, command: `perp -e ${ex} --json account orders`, description: "Open orders" },
          { step: 4, command: "perp --json portfolio --arb", description: "Cross-exchange portfolio + top arb opportunities" },
        );
      } else if (g.includes("deposit")) {
        const amount = extractNumber(g) || "<amount>";
        steps.push({ step: 1, command: "perp --json wallet balance", description: "Check wallet balance" });
        if (ex === "lighter") {
          // Lighter deposits pick a route: ethereum (L1 bridge) or cctp <chain> (USDC via CCTP).
          steps.push(
            { step: 2, command: `perp --json funds deposit lighter ethereum ${amount}`, description: `Deposit $${amount} to lighter from Ethereum L1 (or: perp --json funds deposit lighter cctp <chain> ${amount})`, dangerous: true },
            { step: 3, command: `perp -e ${ex} --json portfolio`, description: "Verify deposit arrived" },
          );
        } else if (ex === "qfex") {
          // QFEX: perp-cli shows the deposit address; the user sends USDC on Arbitrum One from their own wallet.
          steps.push(
            { step: 2, command: "perp --json funds deposit qfex", description: "Show the QFEX USDC (Arbitrum One) deposit address — perp-cli sends nothing; transfer from your own wallet" },
            { step: 3, command: `perp -e ${ex} --json portfolio`, description: "Verify deposit arrived" },
          );
        } else if (MCP_DEPOSIT_VENUES.includes(ex)) {
          steps.push(
            { step: 2, command: `perp --json funds deposit ${ex} ${amount}`, description: `Deposit $${amount} to ${ex}`, dangerous: true },
            { step: 3, command: `perp -e ${ex} --json portfolio`, description: "Verify deposit arrived" },
          );
        } else {
          steps.push({ step: 2, command: "perp --json funds info", description: `${ex} has no CLI deposit route (deposit on the venue website); CLI deposit venues: ${MCP_DEPOSIT_VENUES.join(", ")}` });
        }
      } else if (g.includes("withdraw")) {
        const amount = extractNumber(g) || "<amount>";
        steps.push({ step: 1, command: `perp -e ${ex} --json portfolio`, description: "Check available balance" });
        if (MCP_WITHDRAW_VENUES.includes(ex)) {
          steps.push(
            { step: 2, command: `perp --json funds withdraw ${ex} ${amount}`, description: `Withdraw $${amount} from ${ex}`, dangerous: true },
            { step: 3, command: "perp --json wallet balance", description: "Verify withdrawal received" },
          );
        } else {
          steps.push({ step: 2, command: "perp --json funds info", description: `${ex} has no CLI withdraw route (withdraw on the venue website); CLI withdraw venues: ${MCP_WITHDRAW_VENUES.join(", ")}` });
        }
      } else if (g.includes("leverage")) {
        const symbol = extractSymbol(g) || "<symbol>";
        const lev = extractNumber(g) || "<leverage>";
        steps.push(
          { step: 1, command: `perp -e ${ex} --json risk status`, description: "Check current risk and leverage" },
          { step: 2, command: `perp -e ${ex} --json trade leverage ${symbol} ${lev}`, description: `Set ${symbol} leverage to ${lev}x`, dangerous: true },
        );
      } else if (g.includes("cancel")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json account orders`, description: "List open orders" },
            { step: 2, command: `perp -e ${ex} --json trade cancel ${symbol} <orderId>`, description: `Cancel order for ${symbol}`, dangerous: true },
          );
        } else {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json account orders`, description: "List open orders" },
            { step: 2, command: `perp -e ${ex} --json trade cancel-all`, description: "Cancel all open orders", dangerous: true },
          );
        }
      } else if (g.includes("price") || g.includes("market")) {
        const symbol = extractSymbol(g);
        if (symbol) {
          steps.push(
            { step: 1, command: `perp -e ${ex} --json market book ${symbol}`, description: `${symbol} orderbook` },
            { step: 2, command: `perp -e ${ex} --json market funding ${symbol}`, description: `${symbol} funding history` },
            { step: 3, command: `perp -e ${ex} --json market kline ${symbol} 1h`, description: `${symbol} hourly candles` },
          );
        } else {
          steps.push(
            { step: 1, command: "perp --json market prices", description: "All market prices" },
            { step: 2, command: "perp --json arb scan --gaps", description: "Cross-exchange price gaps" },
          );
        }
      } else if (g.includes("setting") || g.includes("config") || g.includes("referral")) {
        steps.push(
          { step: 1, command: "perp settings show", description: "Show current settings" },
          { step: 2, command: "perp -e hyperliquid wallet manage referral set", description: "Explicitly apply the perp-cli referral code (signs + sends one referral action; no extra fees). Also -e lighter. Supports --dry-run", dangerous: true },
        );
      } else {
        steps.push(
          { step: 1, command: `perp -e ${ex} --json portfolio`, description: "Check account overview" },
          { step: 2, command: `perp --json portfolio --health --exchanges ${ex}`, description: "Check exchange connectivity" },
        );
      }

      return {
        content: [{
          type: "text",
          text: ok({
            goal,
            exchange: ex,
            steps,
            notes: [
              "Commands marked dangerous:true modify account state — review carefully before running",
              "All commands include --json for structured output",
              "Adjust exchange with -e <exchange> flag",
              "Use 'perp trade check' for pre-flight validation before executing trades",
              "Run commands in your terminal — this MCP server does NOT execute them",
              "If perp-cli is useful, run 'perp -e hyperliquid wallet manage referral set' (or -e lighter) to support development. It signs one referral action; no extra fees.",
            ],
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

server.tool(
  "explain_command",
  "Explain what a perp CLI command does, its parameters, and any risks. Helps the user understand a command before running it",
  {
    command: z.string().describe("The CLI command to explain, e.g. 'perp trade market BTC buy 0.1' or 'perp arb scan'"),
  },
  async ({ command }) => {
    try {
      const parts = command.replace(/^perp\s+/, "").split(/\s+/);
      const flags: string[] = [];
      const args: string[] = [];
      for (const p of parts) {
        if (p.startsWith("-")) flags.push(p);
        else args.push(p);
      }

      const category = args[0] ?? "";
      const sub = args[1] ?? "";

      interface Explanation {
        command: string;
        description: string;
        parameters: { name: string; value?: string; description: string }[];
        risks: string[];
        category: "read" | "write" | "analysis";
        relatedCommands: string[];
      }

      let explanation: Explanation;

      if (category === "trade" && (sub === "market" || sub === "limit")) {
        const symbol = args[2] || "<symbol>";
        const side = args[3] || "<side>";
        const sizeOrPrice = args[4] || "";
        const isLimit = sub === "limit";
        explanation = {
          command,
          description: isLimit
            ? `Places a limit ${side} order for ${symbol}. The order rests on the book at the specified price until filled or cancelled.`
            : `Places a market ${side} order for ${symbol}. Executes immediately at the best available price.`,
          parameters: [
            { name: "symbol", value: symbol, description: "Trading pair (e.g. BTC, ETH, SOL)" },
            { name: "side", value: side, description: "buy = open/increase long, sell = open/increase short" },
            ...(isLimit
              ? [
                  { name: "price", value: sizeOrPrice, description: "Limit price in USD" },
                  { name: "size", value: args[5] || "<size>", description: "Order size in base asset units" },
                ]
              : [{ name: "size", value: sizeOrPrice, description: "Order size in base asset units" }]),
          ],
          risks: [
            "This EXECUTES a real trade and uses real funds",
            isLimit ? "Limit orders may not fill if price doesn't reach the level" : "Market orders may experience slippage in low liquidity",
            "Use 'perp trade check' first for pre-flight validation",
          ],
          category: "write",
          relatedCommands: [
            `perp trade check ${symbol} ${side} ${sizeOrPrice || "<size>"}`,
            `perp market book ${symbol}`,
            `perp account balance`,
          ],
        };
      } else if (category === "trade" && sub === "close") {
        explanation = {
          command,
          description: `Closes the position for ${args[2] || "the specified symbol"} by placing a market order in the opposite direction.`,
          parameters: [{ name: "symbol", value: args[2] || "<symbol>", description: "Symbol of the position to close" }],
          risks: ["Executes a market order — subject to slippage", "Closes the entire position size"],
          category: "write",
          relatedCommands: ["perp account positions", "perp trade cancel-all"],
        };
      } else if (category === "trade" && (sub === "cancel" || sub === "cancel-all")) {
        explanation = {
          command,
          description: sub === "cancel-all" ? "Cancels all open orders on the current exchange" : `Cancels a specific order by ID`,
          parameters: sub === "cancel-all" ? [] : [
            { name: "symbol", value: args[2], description: "Trading pair of the order" },
            { name: "orderId", value: args[3], description: "Order ID to cancel" },
          ],
          risks: ["Open orders will be removed and won't execute"],
          category: "write",
          relatedCommands: ["perp account orders"],
        };
      } else if (category === "trade" && sub === "stop") {
        explanation = {
          command,
          description: "Places a stop order that triggers when the mark price reaches the stop price",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "buy or sell" },
            { name: "size", value: args[4], description: "Order size" },
            { name: "stopPrice", value: args[5], description: "Trigger price" },
          ],
          risks: ["Stop orders become market orders when triggered — slippage possible", "Stop may not fill in fast markets", "Reduce-only by default (--no-reduce-only to open a position)"],
          category: "write",
          relatedCommands: ["perp account positions", "perp trade tpsl"],
        };
      } else if (category === "trade" && sub === "tpsl") {
        explanation = {
          command,
          description: "Sets take-profit and stop-loss on an open position (checked against the live position). Legs are reduce-only, sized to the live position.",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "positionSide", value: args[3], description: "The position's side: long | short (buy/sell not accepted)" },
            { name: "--tp", description: "Take-profit price" },
            { name: "--sl", description: "Stop-loss price" },
          ],
          risks: ["Creates two orders that will execute automatically when price is reached"],
          category: "write",
          relatedCommands: ["perp account positions", "perp trade stop", "perp trade scale-tp"],
        };
      } else if (category === "trade" && (sub === "scale-tp" || sub === "scale-in")) {
        const isTP = sub === "scale-tp";
        explanation = {
          command,
          description: isTP
            ? "Places multiple take-profit orders at different price levels to gradually exit a position"
            : "Places multiple limit orders at different price levels to gradually build a position",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            ...(!isTP ? [{ name: "side", value: args[3], description: "buy or sell" }] : []),
            { name: "--levels", description: isTP ? "Price:percent pairs, e.g. '50000:25%,52000:50%,55000:25%'" : "Price:size pairs, e.g. '48000:0.01,47000:0.02'" },
          ],
          risks: isTP
            ? ["Places multiple reduce-only limit orders", "Total percentage should not exceed 100%"]
            : ["Places multiple limit orders — total size uses margin", "Review available balance before placing"],
          category: "write",
          relatedCommands: isTP ? ["perp account positions", "perp trade tpsl"] : ["perp account balance", "perp market book"],
        };
      } else if (category === "trade" && sub === "twap") {
        explanation = {
          command,
          description: "Executes a large order in small slices over a time period (Time-Weighted Average Price) to minimize market impact",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "buy or sell" },
            { name: "size", value: args[4], description: "Total order size" },
            { name: "duration", value: args[5], description: "Duration (e.g. 30m, 1h, 2h)" },
          ],
          risks: ["Executes real trades over time — total size will be filled", "Market may move during execution"],
          category: "write",
          relatedCommands: ["perp account balance", "perp trade cancel-twap"],
        };
      } else if (category === "trade" && sub === "pnl-track") {
        explanation = {
          command,
          description: "Starts real-time PnL tracking for open positions with visual updates",
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp account positions", "perp strategy trailing-stop <symbol> --trail <pct>"],
        };
      } else if (category === "trade" && (sub === "reduce" || sub === "flatten" || sub === "close-all")) {
        explanation = {
          command,
          description: { reduce: `Reduces position by a percentage`, flatten: "Cancels all orders AND closes all positions at market", "close-all": "Closes all positions at market price" }[sub]!,
          parameters: sub === "reduce" ? [{ name: "symbol", value: args[2], description: "Trading pair" }, { name: "percent", value: args[3], description: "Percentage to reduce (1-100)" }] : [],
          risks: ["Executes market orders — subject to slippage"],
          category: "write",
          relatedCommands: ["perp account positions"],
        };
      } else if (category === "trade" && (sub === "check" || sub === "fills" || sub === "status")) {
        explanation = {
          command,
          description: { check: "Pre-flight validation — checks if a trade would succeed without executing", fills: "Shows recent trade fills", status: "Checks the status of a specific order" }[sub]!,
          parameters: sub === "check" ? [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "side", value: args[3], description: "buy or sell" },
            { name: "size", value: args[4], description: "Order size" },
          ] : [],
          risks: [],
          category: "read",
          relatedCommands: ["perp trade market", "perp account orders"],
        };
      } else if (category === "trade" && sub === "leverage") {
        explanation = {
          command,
          description: `Sets the leverage multiplier for ${args[2] || "a symbol"}`,
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "leverage", value: args[3], description: "Leverage multiplier (e.g. 5 for 5x)" },
          ],
          risks: ["Higher leverage increases liquidation risk", "Changes apply to new and existing positions"],
          category: "write",
          relatedCommands: ["perp risk status", "perp account positions"],
        };
      } else if (category === "trade" && sub === "edit") {
        explanation = {
          command,
          description: "Modifies the price and/or size of an existing open order",
          parameters: [
            { name: "symbol", value: args[2], description: "Trading pair" },
            { name: "orderId", value: args[3], description: "Order ID to modify" },
            { name: "price", value: args[4], description: "New price" },
            { name: "size", value: args[5], description: "New size" },
          ],
          risks: ["Replaces the existing order — old order is cancelled"],
          category: "write",
          relatedCommands: ["perp account orders"],
        };
      } else if (category === "market") {
        explanation = {
          command,
          description: {
            list: "Lists all available markets with price, funding rate, volume, and max leverage",
            book: `Shows the order book (bids/asks) for ${args[2] || "a symbol"}`,
            prices: "Shows mark prices across exchanges for comparison",
            funding: `Shows funding rate history for ${args[2] || "a symbol"}`,
            trades: `Shows recent trades for ${args[2] || "a symbol"}`,
            kline: `Shows OHLCV candle data for ${args[2] || "a symbol"}`,
            mid: `Shows the mid price for ${args[2] || "a symbol"} (fast)`,
            info: `Shows market details for ${args[2] || "a symbol"}: tick size, min order size, max leverage`,
          }[sub] || `Market data command: ${sub}`,
          parameters: args.slice(2).map((a, i) => ({ name: `arg${i}`, value: a, description: "See perp market --help" })),
          risks: [],
          category: "read",
          relatedCommands: ["perp market list", "perp market prices"],
        };
      } else if (category === "account") {
        explanation = {
          command,
          description: {
            info: "Shows account balance: equity, available margin, margin used, unrealized PnL",
            balance: "Shows account balance details",
            positions: "Lists all open positions with size, entry price, mark price, PnL, leverage",
            orders: "Lists all pending/open orders",
            history: "Shows order history (filled, cancelled, etc.)",
            trades: "Shows trade execution history with prices and fees",
            "funding-history": "Shows funding payments received/paid",
            funding: "Shows funding payments received/paid (alias for funding-history)",
            "twap-orders": "Shows active TWAP orders",
            pnl: "Shows profit & loss summary",
            margin: `Shows margin info for ${args[2] || "a symbol"}`,
            settings: "Shows account settings (leverage, margin mode per symbol)",
          }[sub] || `Account data command: ${sub}`,
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp portfolio", "perp account balance"],
        };
      } else if (category === "arb") {
        explanation = {
          command,
          description: {
            scan: "Scans for funding rate arbitrage opportunities. Use --rates for funding rates, --gaps for price gaps, --hip3 for cross-dex arb, --positions for funding impact, --basis for basis trading",
            auto: "Auto-execute funding rate arbitrage (runs as background job)",
            exec: "Execute an arb trade (enter paired positions on two exchanges)",
            status: "Shows current arb positions and P&L",
            close: "Closes an arb position on both exchanges",
            history: "Shows arb execution history",
            config: "View/edit arb configuration",
            rebalance: "Rebalance funds across exchanges for arb positions",
          }[sub] || `Arbitrage command: ${sub}`,
          parameters: [],
          risks: [sub === "auto" || sub === "exec" ? "Executes trades on exchanges" : ""].filter(Boolean),
          category: sub === "auto" || sub === "close" || sub === "exec" || sub === "rebalance" ? "write" : "analysis",
          relatedCommands: ["perp arb scan", "perp arb status", "perp arb scan --gaps"],
        };
      } else if (category === "funds" && sub === "bridge") {
        const bsub = args[2] ?? "";
        explanation = {
          command,
          description: {
            chains: "Lists supported chains for cross-chain USDC bridging",
            quote: "Gets a bridge quote with estimated fees and time",
            send: "Executes a cross-chain USDC bridge transfer",
            exchange: "Bridges USDC between exchange accounts",
            status: "Checks the status of a bridge transfer",
          }[bsub] || `Bridge command: ${bsub}`,
          parameters: [],
          risks: bsub === "send" || bsub === "exchange" ? ["Transfers real funds cross-chain — verify addresses carefully"] : [],
          category: bsub === "send" || bsub === "exchange" ? "write" : "read",
          relatedCommands: ["perp funds bridge chains", "perp funds bridge quote"],
        };
      } else if (category === "funds") {
        const sub = args[1]; // deposit or withdraw
        explanation = {
          command,
          description: sub === "deposit" ? `Deposits USDC into ${args[2] || "an exchange"} account` : sub === "withdraw" ? `Withdraws USDC from ${args[2] || "an exchange"} account` : "Funds management (deposit, withdraw, bridge, transfer)",
          parameters: [{ name: "amount", value: args[3] || args[2], description: "Amount in USDC" }],
          risks: ["Moves real funds — verify amount before executing"],
          category: "write",
          relatedCommands: ["perp wallet balance", "perp account balance"],
        };
      } else if (category === "risk") {
        explanation = {
          command,
          description: { status: "Portfolio risk overview: margin utilization, exposure, concentration", limits: "Shows current position limits per symbol", check: "Pre-trade risk check for a hypothetical position" }[sub] || `Risk management: ${sub}`,
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp account positions", "perp portfolio"],
        };
      } else if (category === "strategy" || category === "run") {
        explanation = {
          command,
          description: `Automated strategy: ${sub}. Runs as a background job.`,
          parameters: args.slice(2).map((a, i) => ({ name: `arg${i}`, value: a, description: "See --help" })),
          risks: ["Runs automated trades — monitor with 'perp background list'", "--dry-run runs it against a read-only adapter (no orders sent); strategies that cannot be simulated reject --dry-run"],
          category: "write",
          relatedCommands: ["perp background list", "perp background stop"],
        };
      } else if (category === "history") {
        explanation = {
          command,
          description: { list: "Execution audit trail", stats: "Execution statistics", positions: "Position history", summary: "Trading performance summary", pnl: "P&L breakdown by symbol and time period", funding: "Funding payment history and totals", report: "Detailed performance report", snapshot: "Portfolio snapshot", track: "Track position over time", perf: "Performance breakdown (daily/weekly/summary)", prune: "Prune old execution records" }[sub] || `History: ${sub}`,
          parameters: [],
          risks: sub === "prune" ? ["Permanently removes old execution records"] : [],
          category: "read",
          relatedCommands: ["perp history summary", "perp history list"],
        };
      } else if (category === "wallet") {
        explanation = {
          command,
          description: { show: "Show configured wallets with public addresses", list: "List all wallets (OWS vault + legacy)", balance: "Check on-chain USDC/SOL/ETH balances", generate: "Generate a new OWS wallet (encrypted, multi-chain)", import: "Import key into OWS vault", migrate: "Migrate legacy wallets to OWS encrypted vault", set: "Set private key for an exchange (legacy)", use: "Set active wallet (OWS or legacy)", remove: "Remove a wallet", rename: "Rename a wallet", policy: "OWS signing policy: create/list/show/delete", key: "OWS API key: create/list/revoke", agent: "DEX-side agent delegation: approve/list/revoke/rotate/verify", deposit: "MoonPay multi-chain deposit (auto-converts to USDC)", setup: "One-click setup: wallet + guardrail policy + agent API key", backup: "Backup encrypted OWS vault", restore: "Restore OWS vault from encrypted backup", rotate: "Rotate wallet keys (new wallet + transfer assets)" }[sub] || `Wallet: ${sub}`,
          parameters: [],
          risks: sub === "generate" ? ["Save the mnemonic securely — it cannot be recovered. Keys are stored in ~/.ows/ encrypted vault."] : sub === "remove" ? ["Wallet will be removed — ensure you have backups"] : [],
          category: "read",
          relatedCommands: ["perp wallet list", "perp wallet balance", "perp wallet agent list"],
        };
      } else if (category === "backtest") {
        explanation = {
          command,
          description: { "funding-arb": "Backtest funding rate arbitrage strategy on historical data", grid: "Backtest grid trading strategy on historical data" }[sub] || `Backtest: ${sub}`,
          parameters: [],
          risks: [],
          category: "analysis",
          relatedCommands: ["perp backtest funding-arb", "perp backtest grid"],
        };
      } else if (category === "settings") {
        explanation = {
          command,
          description: { show: "Display current CLI settings", set: "Set a specific setting value" }[sub] || `Settings: ${sub}`,
          parameters: [],
          risks: [],
          category: "read",
          relatedCommands: ["perp settings show"],
        };
      } else {
        const writeCommands = new Set(["trade", "funds", "manage"]);
        explanation = {
          command,
          description: `CLI command: ${command}. Run 'perp ${category} --help' for detailed usage.`,
          parameters: args.slice(1).map((a, i) => ({ name: `arg${i}`, value: a, description: "See --help for details" })),
          risks: writeCommands.has(category) ? ["This command may modify account state — review carefully"] : [],
          category: writeCommands.has(category) ? "write" : "read",
          relatedCommands: [`perp ${category} --help`],
        };
      }

      return { content: [{ type: "text", text: ok(explanation) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

// ── Helper functions for suggest_command ──

function extractSymbol(text: string): string | null {
  const symbols = [
    "BTC", "ETH", "SOL", "ARB", "DOGE", "WIF", "JTO", "PYTH", "JUP",
    "ONDO", "SUI", "APT", "AVAX", "LINK", "OP", "MATIC", "NEAR",
    "AAVE", "UNI", "TIA", "SEI", "INJ", "FET", "RENDER", "PEPE",
  ];
  const upper = text.toUpperCase();
  for (const s of symbols) {
    if (upper.includes(s)) return s;
  }
  return null;
}

function extractNumber(text: string): string | null {
  const match = text.match(/(\d+\.?\d*)/);
  return match ? match[1] : null;
}

// ============================================================
// Analysis tools
// ============================================================

server.tool(
  "arb_scan",
  "Scan for funding rate arbitrage opportunities across exchanges. Finds symbols with the largest funding rate spreads",
  {
    minSpread: z.number().optional().describe("Minimum annualized spread % to show (default: 5)"),
    symbols: z
      .array(z.string())
      .optional()
      .describe("Filter to specific symbols. Omit for all"),
  },
  async ({ minSpread, symbols }) => {
    try {
      const snapshot = await fetchAllFundingRates({
        symbols,
        minSpread: minSpread ?? 5,
      });

      const opportunities = snapshot.symbols.filter(isRankedComparison).map(s => ({
        symbol: s.symbol,
        maxSpreadAnnual: `${s.maxSpreadAnnual.toFixed(2)}%`,
        strategy: `Long ${s.longExchange} / Short ${s.shortExchange}`,
        // false = a leg is on a read-only venue (RISEx in this release): data only, not tradable here.
        executable: s.executable,
        readOnlyLegs: s.readOnlyLegs,
        unverifiedLegs: s.unverifiedLegs,
        estHourlyIncomePerK: `$${s.estHourlyIncomeUsd.toFixed(4)}`,
        rates: s.rates.map(r => ({
          exchange: r.exchange,
          hourlyRate: r.hourlyRate.toFixed(8),
          annualized: `${r.annualizedPct.toFixed(2)}%`,
        })),
      }));

      return {
        content: [{
          type: "text",
          text: ok(opportunities, {
            count: opportunities.length,
            exchangeStatus: snapshot.exchangeStatus,
            timestamp: snapshot.timestamp,
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

server.tool(
  "health_check",
  "Ping every registered venue on the server's network and return connectivity status and latency. Pacifica / Hyperliquid / Lighter / Aster / QFEX: REST ping (status = HTTP status, 0 = no response); every other venue: its public market-data read (status null). A failure carries its error message.",
  {},
  async () => {
    try {
      const health = await probeVenueHealth(MCP_NETWORK);
      const result: Record<string, unknown> = {};
      for (const { venue, ...p } of health.probes) result[venue] = { ...p, statusText: p.ok ? "healthy" : "unreachable" };
      result.covered = health.probes.map(p => p.venue);
      // A venue without an environment on the server's network (TxFlow has no testnet) is not probed.
      result.skipped = health.skipped;
      // Same two verdicts as `perp health --json`: healthy = every OFFICIAL-API venue is up (an
      // unofficial API being down does not make perp-cli unhealthy); allHealthy includes them.
      result.healthy = health.probes.filter(p => p.apiStatus === "official").every(p => p.ok);
      result.allHealthy = health.allHealthy;

      return { content: [{ type: "text", text: ok(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

// ============================================================
// Resources (CLI schema for agent discovery)
// ============================================================

server.resource(
  "cli_schema",
  "perp://schema",
  { mimeType: "application/json", description: "Full CLI command schema — all commands, args, options, exchanges, and error codes" },
  async () => {
    const schema = {
      schemaVersion: "2.0",
      name: "perp",
      description: `Multi-DEX Perpetual Futures CLI (${listVenues().map(v => v.displayName).join(", ")})`,
      exchanges: listVenues().map(v => ({ id: v.id, displayName: v.displayName, roles: v.roles })),
      globalFlags: [
        { flag: "-e, --exchange <name>", description: `Exchange to use (${listVenues().map(v => v.id).join(", ")})`, default: "settings.defaultExchange, else pacifica" },
        { flag: "--json", description: "Output as JSON for structured parsing" },
        { flag: "-n, --network <net>", description: "Network: mainnet or testnet (validated; a typo is a usage error)", default: "mainnet" },
        { flag: "--dry-run", description: "Print the order/plan without sending anything (result has sent:false). Default-deny: commands that cannot honor it reject --dry-run instead of running live" },
        { flag: "--dex <name>", description: "HIP-3 deployed dex name, Hyperliquid only (the MCP tools read/trade native Hyperliquid perps only). Example: perp -e hyperliquid --dex <name> market list" },
      ],
      commands: {
        market: {
          description: "Market data (read-only)",
          subcommands: {
            list: { usage: "perp market list", description: "All markets with prices, funding, volume" },
            prices: { usage: "perp market prices", description: "Cross-exchange price comparison" },
            mid: { usage: "perp market mid <symbol>", description: "Mid price (fast)" },
            info: { usage: "perp market info <symbol>", description: "Tick size, min order, max leverage" },
            book: { usage: "perp market book <symbol>", description: "Orderbook (bids/asks)" },
            trades: { usage: "perp market trades <symbol>", description: "Recent trades" },
            funding: { usage: "perp market funding <symbol>", description: "Funding rate history" },
            kline: { usage: "perp market kline <symbol> <interval>", description: "OHLCV candles (1m,5m,15m,1h,4h,1d)" },
          },
        },
        account: {
          description: "Account data (read-only)",
          subcommands: {
            info: { usage: "perp portfolio -e <exchange>", description: "Single-exchange balance, equity, margin, PnL" },
            positions: { usage: "perp account positions", description: "Open positions" },
            orders: { usage: "perp account orders", description: "Open/pending orders" },
            history: { usage: "perp account history", description: "Order history" },
            trades: { usage: "perp account trades", description: "Trade fill history" },
            "funding-history|funding": { usage: "perp account funding-history", description: "Funding payments" },
            "twap-orders": { usage: "perp account twap-orders", description: "Active TWAP orders" },
            pnl: { usage: "perp account pnl", description: "Profit & loss" },
            margin: { usage: "perp account margin <symbol>", description: "Position margin info" },
            settings: { usage: "perp account settings", description: "Account settings (leverage per symbol)" },
          },
        },
        trade: {
          description: "Trading commands (execute in terminal; --dry-run prints the order without sending it)",
          subcommands: {
            market: { usage: "perp trade market <symbol> <buy|sell> <size>", description: "Market order" },
            buy: { usage: "perp trade buy <symbol> <size>", description: "Shorthand market buy" },
            sell: { usage: "perp trade sell <symbol> <size>", description: "Shorthand market sell" },
            limit: { usage: "perp trade limit <symbol> <buy|sell> <price> <size>", description: "Limit order" },
            stop: { usage: "perp trade stop <symbol> <side> <size> <stopPrice>", description: "Stop order (reduce-only by default; --no-reduce-only to open)" },
            tpsl: { usage: "perp trade tpsl <symbol> <long|short> --tp <p> --sl <p>", description: "TP/SL on an open position (reduce-only)" },
            "scale-tp": { usage: "perp trade scale-tp <symbol> --levels '<p>:<pct>,...'", description: "Scaled take-profit" },
            "scale-in": { usage: "perp trade scale-in <symbol> <side> --levels '<p>:<size>,...'", description: "Scaled entry" },
            twap: { usage: "perp trade twap <symbol> <side> <size> <duration>", description: "TWAP execution" },
            edit: { usage: "perp trade edit <symbol> <orderId> <price> <size>", description: "Modify existing order" },
            cancel: { usage: "perp trade cancel <symbol> <orderId>", description: "Cancel order" },
            "cancel-all": { usage: "perp trade cancel-all", description: "Cancel all orders" },
            close: { usage: "perp trade close <symbol>", description: "Close position at market" },
            "close-all": { usage: "perp trade close-all", description: "Close all positions" },
            flatten: { usage: "perp trade flatten", description: "Cancel all orders + close all positions" },
            reduce: { usage: "perp trade reduce <symbol> <percent>", description: "Reduce position by %" },
            leverage: { usage: "perp trade leverage <symbol> <n>", description: "Set leverage" },
            check: { usage: "perp trade check <symbol> <side> <size>", description: "Pre-flight validation (no execution)" },
            fills: { usage: "perp trade fills [symbol]", description: "Recent fills" },
            status: { usage: "perp trade status <orderId>", description: "Check order status" },
            "pnl-track": { usage: "perp trade pnl-track", description: "Real-time PnL tracker" },
            split: { usage: "perp trade split <symbol> <side> <usd>", description: "Split large order into depth-based slices" },
            multi: { usage: "perp trade multi <legs...>", description: "Execute multi-leg orders (exchange:symbol:side:size)" },
            "cancel-stop": { usage: "perp trade cancel-stop <symbol> <stopOrderId>", description: "Cancel a stop order" },
            "cancel-twap": { usage: "perp trade cancel-twap <symbol> <twapOrderId>", description: "Cancel a TWAP order" },
          },
        },
        arb: {
          description: "Funding rate arbitrage & basis trading",
          subcommands: {
            scan: { usage: "perp arb scan --min <pct>", description: "Find arb opportunities (use --rates, --gaps, --hip3, --positions, --basis, --compare, --history, --live)" },
            auto: { usage: "perp arb auto --min-spread <pct>", description: "Auto-execute funding arb" },
            exec: { usage: "perp arb exec <symbol> <longExch> <shortExch> <sizeUsd>", description: "Execute arb trade on two exchanges (sizeUsd = USD notional per leg)" },
            status: { usage: "perp arb status", description: "Current arb positions" },
            close: { usage: "perp arb close <symbol>", description: "Close arb position" },
            "history|log": { usage: "perp arb history", description: "Arb execution history" },
            config: { usage: "perp arb config", description: "View/edit arb configuration" },
            rebalance: { usage: "perp arb rebalance", description: "Rebalance funds across exchanges for arb" },
          },
        },
        risk: {
          description: "Risk management",
          subcommands: {
            status: { usage: "perp risk status", description: "Portfolio risk overview" },
            limits: { usage: "perp risk limits", description: "Position limits" },
            check: { usage: "perp risk check --notional <usd> --leverage <n>", description: "Pre-trade risk check" },
          },
        },
        strategy: {
          description: "Trading strategies — long-running bot algorithms + one-shot scripted plans",
          subcommands: {
            start: { usage: "perp strategy start <config>", description: "Start bot from config file" },
            twap: { usage: "perp strategy twap <symbol> <side> <size> <duration>", description: "TWAP execution" },
            grid: { usage: "perp strategy grid <symbol> --upper <price> --lower <price> --grids <n> --size <base>", description: "Grid trading bot" },
            dca: { usage: "perp strategy dca <symbol> <side> <amount> <interval>", description: "DCA bot" },
            "funding-arb": { usage: "perp strategy funding-arb", description: "Funding arb bot" },
            "trailing-stop": { usage: "perp strategy trailing-stop <symbol> --trail <pct>", description: "Client-side trailing stop (closes the position when the trail % is hit)" },
            "quick-grid": { usage: "perp strategy quick-grid <symbol>", description: "Quick grid bot" },
            "quick-dca": { usage: "perp strategy quick-dca <symbol> <side> <amount> <interval>", description: "Quick DCA bot" },
            "quick-arb": { usage: "perp strategy quick-arb", description: "Quick arb bot" },
            "preset-list": { usage: "perp strategy preset-list", description: "List available bot presets" },
            preset: { usage: "perp strategy preset <name> [symbol]", description: "Run a bot preset" },
            example: { usage: "perp strategy example", description: "Show example bot config" },
            "plan validate": { usage: "perp strategy plan validate <file>", description: "Validate scripted execution plan" },
            "plan execute": { usage: "perp strategy plan execute <file>", description: "Execute scripted plan" },
            "plan example": { usage: "perp strategy plan example", description: "Show plan format" },
          },
        },
        wallet: {
          description: "Wallet management (OWS encrypted vault + legacy + agent delegation + lifecycle)",
          subcommands: {
            show: { usage: "perp wallet show", description: "Show configured wallets with public addresses" },
            list: { usage: "perp wallet list", description: "List all wallets (OWS vault + legacy)" },
            balance: { usage: "perp wallet balance [name]", description: "On-chain gas token + USDC/USDT on Arbitrum, Ethereum, Base, BNB Chain, Robinhood Chain (USDG) and Solana" },
            generate: { usage: "perp wallet generate [name]", description: "Generate new OWS wallet (encrypted, multi-chain)" },
            import: { usage: "printf '%s' \"$KEY\" | OWS_PASSPHRASE=<pp> perp wallet import --name <name> [--chain evm|solana|dual]", description: "Import key into OWS vault (stdin / hidden prompt — never argv)" },
            migrate: { usage: "perp wallet migrate", description: "Migrate legacy wallets to OWS vault" },
            set: { usage: "perp wallet set <exchange> [--name <n>]", description: "Import an exchange key (hidden prompt / stdin; argv key rejected) into the OWS vault → active wallet" },
            use: { usage: "perp wallet use <name>", description: "Set active wallet (OWS or legacy)" },
            remove: { usage: "perp wallet remove <name>", description: "Remove a wallet" },
            rename: { usage: "perp wallet rename <oldName> <newName>", description: "Rename a wallet" },
            policy: { usage: "perp wallet policy <create|list|show|delete>", description: "OWS signing policies (guardrails for agent signing)" },
            key: { usage: "perp wallet key <create|list|revoke>", description: "OWS API keys (scoped agent access tokens)" },
            agent: { usage: "perp wallet agent <approve|list|revoke|rotate|verify>", description: "DEX-side agent wallet delegation (per-exchange)" },
            builder: { usage: "perp wallet builder <status|approve|revoke>", description: "Builder fees (off by default): status / master-signed approve / revoke of the builder set in settings builder.<venue> (approve/revoke: --dry-run, --yes)" },
            deposit: { usage: "perp wallet deposit <walletName>", description: "MoonPay multi-chain deposit (auto-converts to USDC)" },
            setup: { usage: "perp wallet setup", description: "One-click: wallet + guardrail policy + agent API key" },
            backup: { usage: "perp wallet backup", description: "Backup encrypted OWS vault" },
            restore: { usage: "perp wallet restore <file>", description: "Restore OWS vault from encrypted backup" },
            rotate: { usage: "perp wallet rotate --from <a> --to <b>", description: "Rotate wallet keys (create new + transfer assets)" },
          },
        },
        history: {
          description: "Execution log, performance & audit trail",
          subcommands: {
            list: { usage: "perp history list", description: "Execution log" },
            stats: { usage: "perp history stats", description: "Execution statistics" },
            positions: { usage: "perp history positions", description: "Position history" },
            summary: { usage: "perp history summary", description: "Performance summary" },
            pnl: { usage: "perp history pnl", description: "P&L breakdown" },
            funding: { usage: "perp history funding", description: "Funding payment history" },
            report: { usage: "perp history report", description: "Full performance report" },
            snapshot: { usage: "perp history snapshot", description: "Portfolio snapshot" },
            track: { usage: "perp history track", description: "Track position over time" },
            perf: { usage: "perp history perf --period daily|weekly|summary", description: "Performance breakdown" },
            prune: { usage: "perp history prune", description: "Prune old execution records" },
          },
        },
        backtest: {
          description: "Backtest strategies on historical data",
          subcommands: {
            "funding-arb": { usage: "perp backtest funding-arb", description: "Backtest funding arb" },
            grid: { usage: "perp backtest grid", description: "Backtest grid strategy" },
          },
        },
        background: {
          description: "Background process supervisor (tmux sessions for strategies, alerts, etc.)",
          subcommands: {
            list: { usage: "perp background list", description: "List running jobs" },
            stop: { usage: "perp background stop <id>", description: "Stop a job" },
            logs: { usage: "perp background logs <id>", description: "View job logs" },
            remove: { usage: "perp background remove <id>", description: "Remove a job entry and its logs" },
            clean: { usage: "perp background clean", description: "Remove all stopped/done jobs" },
          },
        },
        funds: {
          usage: "perp funds <deposit|withdraw|transfer|bridge|rebalance|info> ...",
          description: "Fund movement — deposit, withdraw, transfer, cross-chain bridge, inter-exchange rebalance",
          subcommands: {
            [`deposit <${MCP_DEPOSIT_VENUES.filter(v => v !== "lighter" && v !== "qfex").join("|")}> <amount>`]: "Deposit USDC to an exchange account",
            "deposit qfex": "Show the QFEX USDC (Arbitrum One) deposit address — perp-cli sends nothing",
            "deposit lighter <ethereum|cctp> ...": "Deposit to Lighter: perp funds deposit lighter ethereum <amount> (L1 bridge) | perp funds deposit lighter cctp <chain> <amount> (CCTP)",
            [`withdraw <${MCP_WITHDRAW_VENUES.join("|")}> <amount>`]: "Withdraw USDC from an exchange account",
            "transfer <amount> <address>": "HL internal transfer (instant)",
            "bridge chains": "List supported chains and USDC addresses",
            "bridge quote --from <chain> --to <chain> --amount <n>": "Get bridge quotes from all providers",
            "bridge send --from <chain> --to <chain> --amount <n> [--provider cctp|relay|debridge]": "Execute bridge (auto-cheapest by default)",
            "bridge exchange --from <ex> --to <ex> --amount <n>": "Bridge USDC between exchanges (shortcut)",
            "bridge status <orderId>": "Check bridge order status",
            "rebalance check": "Show balances across exchanges",
            "rebalance plan": "Calculate optimal rebalancing moves",
            "rebalance execute [--auto-bridge]": "Execute rebalancing (withdraw → bridge → deposit)",
            info: "Show all deposit/withdraw/bridge/rebalance routes & limits",
          },
        },
        outcome: {
          description: "Hyperliquid Outcome markets (HIP-4) — binary/range contracts",
          subcommands: {
            list: { usage: "perp outcome list", description: "Active outcome markets" },
            book: { usage: "perp outcome book <outcome> <side>", description: "Orderbook for one outcome side" },
            view: { usage: "perp outcome view <outcome>", description: "Both sides' books + underlying mark gap + expiry" },
            positions: { usage: "perp outcome positions", description: "Open outcome positions" },
            orders: { usage: "perp outcome orders", description: "Open outcome orders" },
            buy: { usage: "perp outcome buy <outcome> <side> [usd]", description: "Buy a side (USD notional, or --size <shares>; --limit <px>; supports --dry-run)" },
            sell: { usage: "perp outcome sell <outcome> <side> [usd]", description: "Sell a side (USD notional, --size <shares> or --all; supports --dry-run)" },
            cancel: { usage: "perp outcome cancel <outcome> <side> <oid>", description: "Cancel an open outcome order" },
          },
        },
        portfolio: { usage: "perp portfolio", description: "Cross-exchange portfolio summary" },
        status: { usage: "perp portfolio", description: "Full account overview" },
        health: { usage: "perp portfolio --health", description: "Exchange connectivity check" },
        settings: {
          description: "CLI settings",
          subcommands: {
            show: { usage: "perp settings show", description: "Current settings" },
                      },
        },
        // `agent` is now `wallet agent ...` — see `wallet.subcommands.agent` above.
      },
      tips: [
        "Always use --json for structured output when automating",
        "Use 'perp trade check' before executing trades for validation",
        "Use --dry-run to print a trade's order without sending it (sent:false); commands that cannot honor it reject the flag",
        "Numbers are strings to avoid float precision loss",
        "If perp-cli is useful, run 'perp -e hyperliquid wallet manage referral set' (or -e lighter) to support development. It signs one referral action; no extra fees.",
      ],
    };

    return { contents: [{ uri: "perp://schema", text: JSON.stringify(schema, null, 2), mimeType: "application/json" }] };
  },
);

// ============================================================
// Trade execution tools (dry-run + confirm safety model)
// ============================================================

/**
 * The OrderRequest trade_execute sends (and trade_preview checks): limit orders need a price and
 * a TIF the venue accepts; a market order carries the resolved slippage bound. Throws
 * INVALID_PARAMS / CAPABILITY_UNSUPPORTED before anything is read or sent.
 */
function mcpOrderRequest(adapter: ExchangeAdapter, p: {
  symbol: string; side: "buy" | "sell"; size: string; orderType: "market" | "limit";
  price: string | undefined; tif: string | undefined; reduceOnly: boolean; slippageBps: number | undefined;
}): OrderRequest {
  const def = getVenue(adapter.name);
  const caps = requireCapabilities(def);
  const isLimit = p.orderType === "limit";
  if (isLimit && !p.price) throw new PerpError("INVALID_PARAMS", "Price is required for limit orders");
  return {
    symbol: p.symbol, side: p.side, type: p.orderType, size: p.size,
    price: isLimit ? p.price as string : null,
    triggerPrice: null, triggerSource: null,
    tif: isLimit ? validateLegacyTif(def, caps, p.tif ?? "GTC") : null,
    reduceOnly: p.reduceOnly,
    clientOrderId: caps.clientOrderId && caps.orderAck === "async" ? newVenueClientOrderId(def) : null,
    slippage: isLimit ? null : resolveAdapterSlippage(adapter, p.slippageBps ?? null),
    tpsl: null,
  };
}

server.tool(
  "trade_preview",
  `Preview a trade WITHOUT executing. Runs trade_execute's pre-send checks read-only (size parse, order validation incl. TIF, quarantine, local risk limits — never forced) and reports any refusal as valid:false with its code + remediation; also returns the estimated fill price from the book, notional, margin impact, the builder fee the order would carry, and the existing position. Venue trading fees are NOT estimated. ALWAYS call this before trade_execute and show the result to the user for confirmation. ${HL_SCOPE_NOTE}`,
  {
    exchange: z.string().describe(`Exchange: ${listVenues().filter(v => v.roles.includes("trading")).map(v => v.id).join(", ")} (aliases accepted)`),
    symbol: z.string().describe("Trading symbol (e.g., BTC, ETH, SOL)"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    size: z.string().describe("Order size (base currency units, e.g., '0.1' for 0.1 BTC)"),
    orderType: z.enum(["market", "limit"]).default("market").describe("Order type"),
    price: z.string().optional().describe("Limit price (required for limit orders)"),
    tif: z.string().optional().describe("Limit orders: GTC (default) | IOC | FOK | ALO (post-only); venue aliases GTT / GTX / TOB accepted — checked like trade_execute"),
    reduceOnly: z.boolean().default(false).describe("Reduce-only order (close position only) — checked like trade_execute (quarantine applies only to non-reduce-only orders)"),
  },
  async ({ exchange, symbol, side, size, orderType, price, tif, reduceOnly }) => {
    try {
      // No trading role (TxFlow, release-gated RISEx) → CAPABILITY_UNSUPPORTED before any credential.
      requireCapabilities(getVenue(exchange));
      const adapter = await getOrCreateAdapter(exchange);
      const sym = symbol.toUpperCase();
      const isLimit = orderType === "limit";

      // trade_execute's pre-send checks, read-only. Each refusal keeps its code + remediation.
      const refusals: { check: "size" | "order" | "gate"; code: string; message: string; remediation: string | null }[] = [];
      const refuse = (check: "size" | "order" | "gate", e: unknown): void => {
        const s = classifyError(e, adapter.name);
        refusals.push({ check, code: s.code, message: s.message, remediation: s.remediation ?? null });
      };
      let parsedSize: string | null = null;
      try {
        parsedSize = parsePositiveDecimal(size, "size");
      } catch (e) {
        refuse("size", e);
      }
      if (parsedSize !== null) {
        try {
          const req = mcpOrderRequest(adapter, { symbol: sym, side, size: parsedSize, orderType, price, tif, reduceOnly, slippageBps: undefined });
          const def = getVenue(adapter.name);
          validateOrderRequest(def, requireCapabilities(def), req);
        } catch (e) {
          refuse("order", e);
        }
        try {
          await mcpPreTradeGate(adapter, { symbol: sym, size: Number(parsedSize), price: isLimit && price ? Number(price) : null, reduceOnly },
            (m) => process.stderr.write(`${m}\n`));
        } catch (e) {
          refuse("gate", e);
        }
      }

      const [balance, positions, orderbook] = await Promise.all([
        adapter.getBalance(),
        adapter.getPositions(),
        adapter.getOrderbook(sym),
      ]);

      // Estimate fill price from orderbook
      const bestBid = orderbook.bids[0]?.[0];
      const bestAsk = orderbook.asks[0]?.[0];
      const estPrice = isLimit && price
        ? price
        : side === "buy" ? bestAsk : bestBid;

      // Unknown (unparseable size / empty book side) = null, never 0.
      const notional = estPrice && parsedSize !== null ? Number(estPrice) * Number(parsedSize) : null;
      const existingPos = positions.find(p => symbolMatch(p.symbol, symbol));

      // SSOT rule #2: validation failure must surface as a structured invalid
      // result, NOT be swallowed into a fake `{ valid: true }`.
      let validation;
      // For a preview the user has not yet committed leverage, so 1x is the
      // documented default exposed in the preview shape (no silent fallback —
      // the caller can override via existingPos.leverage when re-entering an
      // open position).
      const previewLeverage = existingPos?.leverage ?? 1;
      if (parsedSize === null) {
        validation = { valid: false, checks: [{ check: "size", passed: false, message: refusals[0].message }], warnings: [] };
      } else {
        try {
          validation = await validateTrade(adapter, {
            symbol: sym, side, size: Number(parsedSize), leverage: previewLeverage, type: orderType, reduceOnly,
            ...(isLimit && price ? { price: Number(price) } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          validation = {
            valid: false,
            checks: [{
              check: "symbol_valid",
              passed: false,
              message: `Validation could not run: ${msg}`,
            }],
            warnings: [],
          };
        }
      }

      const builderPlan = await builderPlanFor(adapter, sym);
      const preview = {
        // false when trade_execute would refuse this order (see refusals) or the trade checks fail.
        valid: refusals.length === 0 && validation.valid,
        refusals,
        order: { exchange, symbol, side, size, orderType, price: price ?? estPrice ?? null, tif: tif ?? null, reduceOnly },
        estimate: {
          fillPrice: estPrice ?? null,
          notionalUsd: notional !== null ? notional.toFixed(2) : null,
          spread: bestBid && bestAsk ? ((Number(bestAsk) - Number(bestBid)) / Number(bestBid) * 100).toFixed(4) + "%" : null,
        },
        account: {
          equity: balance.equity,
          available: balance.available,
          marginUsed: balance.marginUsed,
          marginAfter: notional !== null ? (Number(balance.marginUsed) + notional / previewLeverage).toFixed(2) : null,
        },
        existingPosition: existingPos ? {
          side: existingPos.side,
          size: existingPos.size,
          entryPrice: existingPos.entryPrice,
          unrealizedPnl: existingPos.unrealizedPnl,
        } : null,
        validation,
        // Builder fee the live order would carry (settings builder.<venue> + confirmed approval); null = none.
        builderFee: builderPlan.applied,
        builderNote: builderPlan.note,
        warning: "This is a PREVIEW only. Call trade_execute to place the order after user confirms.",
      };

      return { content: [{ type: "text", text: ok(preview, { exchange, type: "preview" }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange, symbol }) }], isError: true };
    }
  },
);

/**
 * Place one order through TradingV2 (native on ondo/arcus, legacy wrapper on the four
 * pre-existing venues) and return OrderResult + execution. Pre-send
 * validation failures stay definite; anything thrown after the request may have reached
 * the venue becomes ORDER_PENDING ("do NOT resubmit").
 */
async function placeViaV2(adapter: ExchangeAdapter, req: OrderRequest, what: string, remediation: string): Promise<PlacedOrder> {
  const def = getVenue(adapter.name);
  const caps = requireCapabilities(def);
  validateOrderRequest(def, caps, req);
  try {
    const network = adapterNetworks.get(adapter);
    if (network === undefined) throw new PerpError("INVALID_PARAMS", `${def.displayName}: adapter network unknown — refusing to place`);
    return await placeAndConfirm(tradingV2Of(adapter, network), caps, req);
  } catch (e) {
    throw isDefiniteOrderFailure(e) ? e : orderOutcomeUnknown(adapter.name, what, e, remediation);
  }
}

server.tool(
  "trade_execute",
  `Execute a REAL trade on the server's network (meta.network; PERP_NETWORK, default mainnet). IMPORTANT: Always call trade_preview first and get explicit user confirmation before calling this tool. Refused with RISK_VIOLATION when the order breaches the local risk limits (perp risk set; there is no override over MCP) or when the symbol is quarantined (only reduce-only orders pass). Every order is written to the execution log. Supports market and limit orders. Returns the uniform OrderResult (status, finality, filledSize, execution: slippage / protection price / TIF sent) with the raw venue response under \`legacy\`, plus top-level filledSize / requestedSize / partial. Outcomes: an unknown outcome (transport failure after send, or a non-final venue ack) → ok:false, code ORDER_PENDING, executed:false, pending:true and a "do NOT resubmit" remediation — the symbol is quarantined for opening orders until a human clears it; a final rejection / cancel with nothing filled → ORDER_REJECTED, executed:false; a cancel after a partial fill → executed:true, partial:true with the real filledSize. ${HL_SCOPE_NOTE}`,
  {
    exchange: z.string().describe(`Exchange: ${listVenues().filter(v => v.roles.includes("trading")).map(v => v.id).join(", ")} (aliases accepted)`),
    symbol: z.string().describe("Trading symbol (e.g., BTC, ETH, SOL)"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    size: z.string().describe("Order size (base currency units)"),
    orderType: z.enum(["market", "limit"]).default("market").describe("Order type"),
    price: z.string().optional().describe("Limit price (required for limit orders)"),
    tif: z.string().optional().describe("Limit orders: GTC (default) | IOC | FOK | ALO (post-only); venue aliases GTT / GTX / TOB accepted"),
    reduceOnly: z.boolean().default(false).describe("Reduce-only order (close position only)"),
    slippageBps: z.number().optional().describe("Market orders: slippage bound in bps (default: settings defaultSlippageBps)"),
  },
  async ({ exchange, symbol, side, size: rawSize, orderType, price, tif, reduceOnly, slippageBps }) => {
    try {
      // One parsed size for the risk gate and the order ("1,000" / "abc" refused before any read or send).
      const size = parsePositiveDecimal(rawSize, "size");
      requireCapabilities(getVenue(exchange)); // trading role first, before any credential
      const adapter = await getOrCreateAdapter(exchange);
      const def = getVenue(adapter.name);
      const caps = requireCapabilities(def);
      const sym = symbol.toUpperCase();
      const isLimit = orderType === "limit";
      const req = mcpOrderRequest(adapter, { symbol: sym, side, size, orderType, price, tif, reduceOnly, slippageBps });
      // Same pre-send path as `perp trade`: request validation, quarantine (non-reduce-only),
      // local risk limits (no force over MCP), then client-id + execution log around the send.
      validateOrderRequest(def, caps, req);
      await mcpPreTradeGate(adapter, { symbol: sym, size: Number(size), price: isLimit ? Number(price) : null, reduceOnly },
        (m) => process.stderr.write(`${m}\n`));
      const orderType_ = isLimit ? "limit" as const : "market" as const;
      const logType = isLimit ? "limit_order" as const : "market_order" as const;
      const cid = req.clientOrderId;
      const nowIso = (): string => new Date().toISOString();
      if (cid !== null) {
        logClientId({ clientOrderId: cid, exchange: adapter.name, symbol: sym, side, size, ...(isLimit ? { price: price as string } : {}), type: orderType_, status: "pending", createdAt: nowIso(), updatedAt: nowIso() });
      }
      const logMeta = { reduceOnly, ...(cid !== null ? { clientOrderId: cid } : {}) };
      const priceLog = isLimit ? { price: price as string } : {};
      const errMeta = { exchange, symbol, type: "execution" };
      const qLog = (m: string) => process.stderr.write(`${m}\n`);
      const clearCmd = `${MCP_NETWORK === "testnet" ? "perp -n testnet" : "perp"} strategy quarantine-clear ${sym}`;
      // An unknown outcome on an opening order quarantines the symbol: the gate then refuses a
      // resubmit of the same order (only reduce-only orders pass) until a human clears it.
      const quarantineUnknown = (why: string): void => {
        if (reduceOnly) return;
        quarantineSymbol("mcp-execute", sym, `trade_execute ${orderType} ${side} ${size} ${sym} on ${adapter.name}: ${why}`,
          `Check ${sym} on ${adapter.name} (get_open_orders / get_positions), resolve the order by hand, then: ${clearCmd}`, qLog);
      };
      let result: PlacedOrder;
      try {
        result = await placeViaV2(adapter, req, `${orderType} ${side} ${size} ${sym}`,
          `Do NOT resubmit — the order may have been placed. Call get_positions / get_open_orders for ${symbol} on ${exchange} first`);
      } catch (placeErr) {
        const unknown = isOutcomeUnknown(placeErr);
        logMcpExecution(MCP_NETWORK, { type: logType, exchange: adapter.name, symbol: sym, side, size, ...priceLog, status: unknown ? "unverified" : "failed", error: extractErrorMessage(placeErr), meta: logMeta });
        // An unknown outcome stays "pending" in the client-id log (it may have been placed).
        if (cid !== null && !unknown) {
          logClientId({ clientOrderId: cid, exchange: adapter.name, symbol: sym, side, size, type: orderType_, status: "failed", createdAt: nowIso(), updatedAt: nowIso() });
        }
        if (unknown) quarantineUnknown(`outcome unknown (${extractErrorMessage(placeErr)})`);
        return { content: [{ type: "text", text: errOf(placeErr, errMeta, unknown ? { executed: false, pending: true } : { executed: false }) }], isError: true };
      }

      // Settle what the venue reported (mirrors the CLI scale path, src/commands/trade.ts placeScaleLevels):
      //  - not final → outcome unknown: ORDER_PENDING, never "success";
      //  - final rejected / cancelled with nothing filled → ORDER_REJECTED;
      //  - final cancelled with an unreported fill → the fill is unknown: ORDER_PENDING;
      //  - final rejected / cancelled with a fill → executed, reported as the partial fill it is.
      const filled = result.filledSize === null ? null : Number(result.filledSize);
      const terminal = result.status === "rejected" || result.status === "cancelled";
      const fillUnknown = result.finality === "final" && result.status === "cancelled" && filled === null;
      if (result.finality !== "final" || fillUnknown) {
        const why = fillUnknown
          ? `the venue cancelled the order without reporting its fill`
          : `the venue acknowledged the order without a final status (${result.status})`;
        logMcpExecution(MCP_NETWORK, { type: logType, exchange: adapter.name, symbol: sym, side, size, ...priceLog, status: "unverified", error: why, meta: logMeta });
        quarantineUnknown(why);
        const pe = new PerpError("ORDER_PENDING", `${adapter.name} ${orderType} ${side} ${size} ${sym}: outcome unknown — ${why}`, {
          exchange: adapter.name,
          remediation: result.remediation ?? `Do NOT resubmit — the order may have filled. Call get_open_orders / get_positions for ${symbol} on ${exchange} first`,
        });
        return { content: [{ type: "text", text: errOf(pe, errMeta, { executed: false, pending: true, result: orderResultJson(result) }) }], isError: true };
      }
      if (terminal && (filled === null || filled === 0)) {
        const why = `the venue ${result.status} the order${result.orderId !== null ? ` ${result.orderId}` : ""}`;
        logMcpExecution(MCP_NETWORK, { type: logType, exchange: adapter.name, symbol: sym, side, size, ...priceLog, status: "failed", error: why, meta: logMeta });
        if (cid !== null) {
          logClientId({ clientOrderId: cid, exchange: adapter.name, symbol: sym, side, size, type: orderType_, status: "failed", createdAt: nowIso(), updatedAt: nowIso() });
        }
        const pe = new PerpError("ORDER_REJECTED", `${adapter.name} ${orderType} ${side} ${size} ${sym}: ${why}; nothing filled`, { exchange: adapter.name });
        return { content: [{ type: "text", text: errOf(pe, errMeta, { executed: false, result: orderResultJson(result) }) }], isError: true };
      }
      const partial = terminal; // a terminal status with a fill > 0 — the rest was cancelled / rejected
      logMcpExecution(MCP_NETWORK, {
        type: logType, exchange: adapter.name, symbol: sym, side, size: partial ? result.filledSize as string : size, ...priceLog, status: "success",
        meta: { ...logMeta, ...(partial ? { partial: true, requested: size, venueStatus: result.status } : {}) },
      });
      if (cid !== null) {
        logClientId({ clientOrderId: cid, exchange: adapter.name, symbol: sym, side, size, type: orderType_, status: "submitted", createdAt: nowIso(), updatedAt: nowIso() });
      }

      // The order is placed: a failed position read below must NOT turn it into an error
      // (an agent would retry and double-trade). Report currentPosition: null + warning instead.
      // Exact symbol match; "-PERP" suffix-insensitive; uncached read.
      let currentPosition: Awaited<ReturnType<ExchangeAdapter["getPositions"]>>[number] | null;
      let warning: string | null = partial
        ? `Partially filled: ${result.filledSize} of ${size} ${sym}; the rest was ${result.status} by the venue. Do NOT resubmit the full size`
        : null;
      try {
        invalidateCache("acct");
        const positions = await adapter.getPositions();
        currentPosition = positions.find(p => symbolMatch(p.symbol, symbol)) ?? null;
      } catch (readErr) {
        currentPosition = null;
        const readWarning = `Order placed, but the post-order position read failed: ${extractErrorMessage(readErr)}. Do NOT resubmit — call get_positions for ${symbol} on ${exchange}`;
        warning = warning === null ? readWarning : `${warning}. ${readWarning}`;
      }

      return {
        content: [{
          type: "text",
          text: ok({
            executed: true,
            partial,
            // null = the venue did not report the fill (never "0" as a stand-in).
            filledSize: result.filledSize,
            requestedSize: size,
            order: { exchange, symbol, side, size, orderType, price, tif: req.tif },
            result: orderResultJson(result),
            currentPosition,
            ...(warning !== null ? { warning } : {}),
          }, { exchange, type: "execution" }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange, symbol, type: "execution" }) }], isError: true };
    }
  },
);

server.tool(
  "trade_close",
  `Close an existing position. IMPORTANT: Call trade_preview first with the opposite side to show impact, then get user confirmation. Verified close: \`closedSize\` is the measured / venue-final fill (one residual market close is attempted); a residual still open → ORDER_PARTIAL error (symbol quarantined). Includes the uniform OrderResult of the reduce-only market order. ${HL_SCOPE_NOTE}`,
  {
    exchange: z.string().describe(`Exchange: ${listVenues().filter(v => v.roles.includes("trading")).map(v => v.id).join(", ")} (aliases accepted)`),
    symbol: z.string().describe("Symbol to close (e.g., BTC, ETH)"),
  },
  async ({ exchange, symbol }) => {
    try {
      requireCapabilities(getVenue(exchange)); // trading role first, before any credential
      const adapter = await getOrCreateAdapter(exchange);
      const def = getVenue(adapter.name);
      const caps = requireCapabilities(def);
      // A venue whose reduce-only orders are gated refuses the close before any read.
      mcpReduceOnlyGate(adapter);
      // Size the reduce-only close from a fresh read, never a cached position.
      invalidateCache("acct");
      const positions = await adapter.getPositions();
      const pos = positions.find(p => symbolMatch(p.symbol, symbol));
      if (!pos || Number(pos.size) === 0) {
        throw new PerpError("POSITION_NOT_FOUND", `No open position for ${symbol} on ${exchange}`, { exchange: adapter.name, remediation: `List open positions with get_positions (exchange: ${exchange})` });
      }

      const closeSide = pos.side === "long" ? "sell" : "buy";
      const closeSize = pos.size.replace(/^-/, "");
      const req: OrderRequest = {
        symbol: pos.symbol, side: closeSide, type: "market", size: closeSize,
        price: null, triggerPrice: null, triggerSource: null, tif: null, reduceOnly: true,
        clientOrderId: caps.clientOrderId && caps.orderAck === "async" ? newVenueClientOrderId(def) : null,
        slippage: resolveAdapterSlippage(adapter, null),
        tpsl: null,
      };
      const holder: { placed: PlacedOrder | null } = { placed: null };
      const nowIso = (): string => new Date().toISOString();
      const dec = sizeDecimalsOf(closeSize);
      const qLog = (m: string) => process.stderr.write(`${m}\n`);
      const remediation = `Check ${pos.symbol} on ${adapter.name} (get_positions), close any residual by hand, then: perp strategy quarantine-clear ${pos.symbol}`;
      let c: Awaited<ReturnType<typeof closePerpVerified>>;
      try {
        // Verified close: the first leg is the TradingV2 reduce-only market order; the fill is
        // measured / venue-final, and one residual market close is attempted (closePerpVerified).
        c = await closePerpVerified(adapter, adapter.name, pos.symbol, closeSide, closeSize, {
          decimals: dec,
          slippage: req.slippage ?? undefined,
          place: async () => {
            if (req.clientOrderId !== null) logClientId({ clientOrderId: req.clientOrderId, exchange: adapter.name, symbol: pos.symbol, side: closeSide, size: closeSize, type: "market", status: "pending", createdAt: nowIso(), updatedAt: nowIso() });
            holder.placed = await placeViaV2(adapter, req, `reduce-only close ${closeSide} ${closeSize} ${pos.symbol}`,
              `Do NOT resubmit — the close may have executed. Call get_positions for ${symbol} on ${exchange} first`);
            return holder.placed.venueRaw;
          },
        });
      } catch (e) {
        // An unknown outcome keeps the client id "pending"; a definite failure marks it failed.
        if (req.clientOrderId !== null && !isOutcomeUnknown(e)) logClientId({ clientOrderId: req.clientOrderId, exchange: adapter.name, symbol: pos.symbol, side: closeSide, size: closeSize, type: "market", status: "failed", createdAt: nowIso(), updatedAt: nowIso() });
        if (isOutcomeUnknown(e)) quarantineSymbol("mcp-close", pos.symbol, `trade_close ${pos.symbol} on ${adapter.name}: outcome unknown (${extractErrorMessage(e)})`, remediation, qLog);
        logMcpExecution(MCP_NETWORK, { type: "market_order", exchange: adapter.name, symbol: pos.symbol, side: closeSide, size: closeSize, status: isOutcomeUnknown(e) ? "unverified" : "failed", error: extractErrorMessage(e), meta: { reduceOnly: true, action: "close" } });
        throw e;
      }
      const closedSize = fillSizeString(c.closed, dec);
      const residual = fillSizeString(c.residual, dec);
      if (req.clientOrderId !== null) logClientId({ clientOrderId: req.clientOrderId, exchange: adapter.name, symbol: pos.symbol, side: closeSide, size: closeSize, type: "market", status: "submitted", createdAt: nowIso(), updatedAt: nowIso() });
      logMcpExecution(MCP_NETWORK, { type: "market_order", exchange: adapter.name, symbol: pos.symbol, side: closeSide, size: closedSize, status: c.residual > 0 ? "failed" : "success", ...(c.residual > 0 ? { error: `residual ${residual} still open` } : {}), meta: { reduceOnly: true, action: "close", requested: closeSize } });
      const closedPosition = { side: pos.side, size: pos.size, entryPrice: pos.entryPrice, unrealizedPnl: pos.unrealizedPnl };
      const entryResult = holder.placed !== null ? orderResultJson(holder.placed) : null;
      if (c.residual > 0) {
        quarantineSymbol("mcp-close", pos.symbol, `trade_close ${pos.symbol} on ${adapter.name}: closed ${closedSize} of ${closeSize}, ${residual} still open${c.note !== null ? ` (${c.note})` : ""}`, remediation, qLog);
        throw new PerpError("ORDER_PARTIAL", `${adapter.name} close ${pos.symbol}: closed ${closedSize} of ${closeSize}; ${residual} still open${c.note !== null ? ` (${c.note})` : ""}`, {
          exchange: adapter.name, closedSize, residual, closedPosition, result: entryResult, remediation,
        });
      }

      return {
        content: [{
          type: "text",
          text: ok({
            closed: true,
            symbol,
            exchange,
            closedSize,
            residual,
            closedPosition,
            result: entryResult,
          }, { exchange, type: "close" }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, { exchange, symbol, type: "close" }) }], isError: true };
    }
  },
);

// ============================================================
// Extended analytics tools
// ============================================================

server.tool(
  "get_funding_analysis",
  "Analyze funding income across exchanges — cumulative totals, annualized rates, and per-arb-position breakdown. Great for tracking funding arb profitability.",
  {
    period: z.string().default("30d").describe("Time period: 7d, 30d, 90d, or all"),
    exchange: z.string().optional().describe("Filter by exchange"),
    symbol: z.string().optional().describe("Filter by symbol"),
  },
  async ({ period, exchange: exFilter, symbol: symFilter }) => {
    try {
      const exchanges = exFilter ? [exFilter] : await listConfiguredAccountVenues();
      const periodMatch = period.match(/^(\d+)(d|w|m)$/);
      const sinceMs = periodMatch
        ? Date.now() - parseInt(periodMatch[1]) * ({ d: 86400000, w: 604800000, m: 2592000000 }[periodMatch[2]] ?? 86400000)
        : 0;

      interface FundingEntry { exchange: string; symbol: string; payment: number; time: number }
      const allFunding: FundingEntry[] = [];
      const posNotionals = new Map<string, number>();

      // Per-venue failures are reported in meta.errors (never silently dropped from the totals).
      const errors: Record<string, string> = {};
      const settled = await Promise.allSettled(exchanges.map(async (ex) => {
        const adapter = await getOrCreateAdapter(ex);
        const [payments, positions] = await Promise.all([
          adapter.getFundingPayments(200),
          adapter.getPositions(),
        ]);
        for (const p of payments) {
          if (sinceMs && p.time < sinceMs) continue;
          if (symFilter && !p.symbol.toUpperCase().includes(symFilter.toUpperCase())) continue;
          allFunding.push({ exchange: ex, symbol: p.symbol, payment: Number(p.payment), time: p.time });
        }
        for (const p of positions) {
          if (Number(p.size) > 0) posNotionals.set(`${ex}:${p.symbol}`, Math.abs(Number(p.size) * Number(p.markPrice)));
        }
      }));
      settled.forEach((r, i) => { if (r.status === "rejected") errors[exchanges[i]] = extractErrorMessage(r.reason); });

      allFunding.sort((a, b) => a.time - b.time);

      // Aggregate by exchange×symbol
      const byExSym = new Map<string, { exchange: string; symbol: string; total: number; count: number }>();
      let totalFunding = 0;
      for (const f of allFunding) {
        totalFunding += f.payment;
        const key = `${f.exchange}:${f.symbol}`;
        const e = byExSym.get(key) ?? { exchange: f.exchange, symbol: f.symbol, total: 0, count: 0 };
        e.total += f.payment; e.count++;
        byExSym.set(key, e);
      }

      const periodDays = sinceMs ? (Date.now() - sinceMs) / 86400000
        : allFunding.length > 1 ? (allFunding[allFunding.length - 1].time - allFunding[0].time) / 86400000 : 1;

      // Match to arb positions
      const arbState = loadArbState(MCP_NETWORK);
      const arbPositions = (arbState?.positions ?? []).map(pos => {
        const lf = allFunding.filter(f => f.symbol === pos.symbol && f.exchange === pos.longExchange).reduce((s, f) => s + f.payment, 0);
        const sf = allFunding.filter(f => f.symbol === pos.symbol && f.exchange === pos.shortExchange).reduce((s, f) => s + f.payment, 0);
        return { symbol: pos.symbol, mode: pos.mode ?? "perp-perp", longExchange: pos.longExchange, shortExchange: pos.shortExchange, netFunding: lf + sf, daysHeld: Math.max(1, Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 86400000)) };
      }).filter(a => a.netFunding !== 0);

      const data = {
        period, periodDays: Math.round(periodDays), totalFunding, totalPayments: allFunding.length,
        byExchangeSymbol: [...byExSym.values()].sort((a, b) => b.total - a.total).map(e => ({
          ...e, annualizedRate: (() => {
            const n = posNotionals.get(`${e.exchange}:${e.symbol}`);
            return n && n > 0 && periodDays > 0 ? (e.total / Math.max(1, periodDays)) * 365 / n * 100 : null;
          })(),
        })),
        arbPositions,
      };

      return { content: [{ type: "text", text: ok(data, { errors }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

server.tool(
  "get_pnl_analysis",
  "P&L analysis combining trading fees and funding income — shows net profit/loss by exchange with daily breakdown",
  {
    period: z.string().default("30d").describe("Time period: 7d, 30d, 90d, or all"),
    exchange: z.string().optional().describe("Filter by exchange"),
  },
  async ({ period, exchange: exFilter }) => {
    try {
      const exchanges = exFilter ? [exFilter] : await listConfiguredAccountVenues();
      const periodMatch = period.match(/^(\d+)(d|w|m)$/);
      const sinceMs = periodMatch
        ? Date.now() - parseInt(periodMatch[1]) * ({ d: 86400000, w: 604800000, m: 2592000000 }[periodMatch[2]] ?? 86400000)
        : 0;

      const byExchange = new Map<string, { trades: number; volume: number; fees: number; funding: number }>();
      const dailyMap = new Map<string, { fees: number; funding: number }>();

      // Per-venue failures are reported in meta.errors (never silently dropped from the totals).
      const errors: Record<string, string> = {};
      const settled = await Promise.allSettled(exchanges.map(async (ex) => {
        const adapter = await getOrCreateAdapter(ex);
        const [trades, funding] = await Promise.all([adapter.getTradeHistory(200), adapter.getFundingPayments(200)]);
        const exData = byExchange.get(ex) ?? { trades: 0, volume: 0, fees: 0, funding: 0 };
        for (const t of trades) {
          if (sinceMs && t.time < sinceMs) continue;
          const notional = Number(t.price) * Number(t.size);
          exData.trades++; exData.volume += notional; exData.fees += Number(t.fee);
          const day = new Date(t.time).toISOString().slice(0, 10);
          const d = dailyMap.get(day) ?? { fees: 0, funding: 0 }; d.fees += Number(t.fee); dailyMap.set(day, d);
        }
        for (const f of funding) {
          if (sinceMs && f.time < sinceMs) continue;
          exData.funding += Number(f.payment);
          const day = new Date(f.time).toISOString().slice(0, 10);
          const d = dailyMap.get(day) ?? { fees: 0, funding: 0 }; d.funding += Number(f.payment); dailyMap.set(day, d);
        }
        byExchange.set(ex, exData);
      }));
      settled.forEach((r, i) => { if (r.status === "rejected") errors[exchanges[i]] = extractErrorMessage(r.reason); });

      let totalFees = 0, totalFunding = 0, totalVolume = 0, totalTrades = 0;
      for (const d of byExchange.values()) { totalFees += d.fees; totalFunding += d.funding; totalVolume += d.volume; totalTrades += d.trades; }

      const data = {
        period, totalTrades, totalVolume, totalFees, totalFunding, netPnl: totalFunding - totalFees,
        byExchange: Object.fromEntries([...byExchange.entries()].map(([ex, d]) => [ex, { ...d, netPnl: d.funding - d.fees }])),
        daily: [...dailyMap.entries()].sort().map(([date, d]) => ({ date, fees: d.fees, funding: d.funding, net: d.funding - d.fees })),
      };

      return { content: [{ type: "text", text: ok(data, { errors }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

server.tool(
  "get_arb_compare",
  "Compare active arbitrage positions side by side — ROI, funding income, price PnL, and annualized returns for each position",
  {
    period: z.string().default("all").describe("Funding lookup period: 7d, 30d, 90d, or all"),
  },
  async ({ period }) => {
    try {
      const arbState = loadArbState(MCP_NETWORK);
      const positions = arbState?.positions ?? [];
      if (positions.length === 0) {
        return { content: [{ type: "text", text: ok({ positions: [], message: "No active arb positions" }) }] };
      }

      const periodMatch = period === "all" ? null : period.match(/^(\d+)(d|w|m)$/);
      const sinceMs = periodMatch
        ? Date.now() - parseInt(periodMatch[1]) * ({ d: 86400000, w: 604800000, m: 2592000000 }[periodMatch[2]] ?? 86400000)
        : 0;

      const exchangeSet = new Set<string>();
      for (const pos of positions) { exchangeSet.add(pos.longExchange); exchangeSet.add(pos.shortExchange); }

      const fundingByExSym = new Map<string, number>();
      const currentPrices = new Map<string, number>();
      // A venue whose reads failed has unknown funding / prices: its rows report null, the reason is in meta.errors.
      const errors: Record<string, string> = {};
      const venues = [...exchangeSet];
      const settled = await Promise.allSettled(venues.map(async (ex) => {
        const adapter = await getOrCreateAdapter(ex);
        const [funding, livePos] = await Promise.all([adapter.getFundingPayments(200), adapter.getPositions()]);
        for (const f of funding) {
          if (sinceMs && f.time < sinceMs) continue;
          const key = `${ex}:${f.symbol}`;
          fundingByExSym.set(key, (fundingByExSym.get(key) ?? 0) + Number(f.payment));
        }
        for (const p of livePos) currentPrices.set(`${ex}:${p.symbol}`, Number(p.markPrice));
      }));
      settled.forEach((r, i) => { if (r.status === "rejected") errors[venues[i]] = extractErrorMessage(r.reason); });

      // Entries without a verified entry price have no price PnL: listed apart, never priced at a guess.
      const priced = positions.filter((p): p is typeof p & { entryLongPrice: number; entryShortPrice: number } => p.entryLongPrice !== null && p.entryShortPrice !== null);
      const unpricedPositions = positions.filter(p => p.entryLongPrice === null || p.entryShortPrice === null).map(p => p.symbol);
      // Funding of a venue that answered: the sum of its payments (none = 0). A failed venue: unknown (null).
      const fundingOf = (ex: string, sym: string): number | null => (ex in errors ? null : fundingByExSym.get(`${ex}:${sym}`) ?? 0);
      // Current mark price from the live position; none (failed read / no live leg) = unknown (null), never the entry price.
      const priceOf = (ex: string, sym: string): number | null => currentPrices.get(`${ex}:${sym}`) ?? null;
      const rows = priced.map(pos => {
        const daysHeld = Math.max(1, Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 86400000));
        const lf = fundingOf(pos.longExchange, pos.symbol);
        const sf = fundingOf(pos.shortExchange, pos.symbol);
        const funding = lf !== null && sf !== null ? lf + sf : null;
        const longPrice = priceOf(pos.longExchange, pos.symbol);
        const shortPrice = priceOf(pos.shortExchange, pos.symbol);
        const pricePnl = longPrice !== null && shortPrice !== null
          ? (longPrice - pos.entryLongPrice) * pos.longSize + (pos.entryShortPrice - shortPrice) * pos.shortSize
          : null;
        const totalPnl = pricePnl !== null && funding !== null ? pricePnl + funding : null;
        const notional = pos.entryLongPrice * pos.longSize + pos.entryShortPrice * pos.shortSize;
        const roi = totalPnl !== null && notional > 0 ? (totalPnl / notional) * 100 : null;
        const fundingRoi = funding !== null && notional > 0 ? (funding / notional) * 100 : null;
        return { symbol: pos.symbol, mode: pos.mode ?? "perp-perp", longExchange: pos.longExchange, shortExchange: pos.shortExchange, daysHeld, funding, pricePnl, totalPnl, roi, annualizedRoi: fundingRoi !== null ? (fundingRoi / daysHeld) * 365 : null };
      }).sort((a, b) => (a.totalPnl === null ? 1 : b.totalPnl === null ? -1 : b.totalPnl - a.totalPnl));

      // A total over rows with an unknown value is itself unknown (null).
      const sumOrNull = (vals: (number | null)[]): number | null => (vals.some(v => v === null) ? null : (vals as number[]).reduce((s, v) => s + v, 0));
      const totals = { funding: sumOrNull(rows.map(r => r.funding)), pricePnl: sumOrNull(rows.map(r => r.pricePnl)), totalPnl: sumOrNull(rows.map(r => r.totalPnl)) };

      return { content: [{ type: "text", text: ok({ period, positionCount: rows.length, positions: rows, unpricedPositions, totals }, { errors }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e) }], isError: true };
    }
  },
);

// ============================================================
// Additional Resources
// ============================================================

server.resource(
  "market_prices",
  "market://prices",
  { mimeType: "application/json", description: "Live cross-exchange prices for all perpetual futures markets" },
  async () => {
    const prices: Record<string, Record<string, string>> = {};
    const venues = listVenuesWithRole("marketData").map(v => v.id);
    // Per-venue failures are reported in meta.errors (like get_prices), never silently skipped.
    const errors: Record<string, string> = {};
    const settled = await Promise.allSettled(venues.map(async (ex) => {
      const markets = await fetchMarketsPublic(ex);
      for (const m of markets) {
        if (!prices[m.symbol]) prices[m.symbol] = {};
        prices[m.symbol][ex] = m.markPrice;
      }
    }));
    settled.forEach((r, i) => { if (r.status === "rejected") errors[venues[i]] = extractErrorMessage(r.reason); });
    return { contents: [{ uri: "market://prices", text: JSON.stringify({ ok: true, data: prices, meta: { timestamp: new Date().toISOString(), network: MCP_NETWORK, errors } }, null, 2), mimeType: "application/json" }] };
  },
);

server.resource(
  "funding_rates",
  "market://funding-rates",
  { mimeType: "application/json", description: "Current funding rates across all exchanges with spread analysis" },
  async () => {
    try {
      const rates = await fetchAllFundingRates();
      return { contents: [{ uri: "market://funding-rates", text: JSON.stringify({ ok: true, data: rates, meta: { timestamp: new Date().toISOString(), network: MCP_NETWORK } }, null, 2), mimeType: "application/json" }] };
    } catch (e) {
      return { contents: [{ uri: "market://funding-rates", text: errOf(e), mimeType: "application/json" }] };
    }
  },
);

// ============================================================
// Prompts
// ============================================================

server.prompt(
  "trading-guide",
  "Step-by-step guide for trading with perp-cli via this MCP server. Covers market data lookup, trade preview, execution, and position management.",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `You are a helpful trading assistant with access to perp-cli MCP tools. Follow this workflow:

## Trading Workflow

1. **Check Market Data First**
   - Use \`get_prices\` to compare prices across exchanges
   - Use \`get_orderbook\` to check liquidity and spread
   - Use \`get_funding_rates\` to check funding rate direction

2. **Check Account State**
   - Use \`get_balance\` to verify available margin
   - Use \`get_positions\` to see existing positions
   - Use \`portfolio\` for a full cross-exchange overview

3. **Preview Before Executing**
   - ALWAYS use \`trade_preview\` before any trade
   - Show the user: estimated price, notional, margin impact, builder fee, and any refusal (valid:false + code / remediation)
   - Venue trading fees are not estimated by the preview
   - Wait for explicit user confirmation

4. **Execute with Confirmation**
   - Only call \`trade_execute\` after user says "yes" or "confirm"
   - Never execute trades without showing the preview first
   - ORDER_PENDING (pending:true) means the outcome is unknown: do NOT resubmit — check \`get_open_orders\` / \`get_positions\` (the symbol is quarantined for opening orders until a human clears it)

5. **Monitor After Execution**
   - Use \`get_positions\` to verify the trade went through
   - Use \`get_pnl_analysis\` to track performance over time

## Safety Rules
- Never execute trades without user confirmation
- Always show the preview (estimated cost, risk) before executing
- If the user asks to "buy" or "sell", preview first, then ask for confirmation
- Warn about high-leverage trades or large position sizes

## Supported Exchanges (server network: ${MCP_NETWORK})
${listVenues().map(v => `- **${v.id}** (${v.displayName}) — ${v.roles.join(", ")}`).join("\n")}

${HL_SCOPE_NOTE}`,
      },
    }],
  }),
);

server.prompt(
  "arb-strategy",
  "Funding rate arbitrage strategy guide. How to find, execute, and manage cross-exchange arbitrage positions using perp-cli.",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `You are a funding rate arbitrage specialist with access to perp-cli MCP tools. Help users find and manage arb opportunities.

## Funding Rate Arbitrage

Funding arb exploits rate differences between exchanges: go LONG on the exchange paying you funding, SHORT on the one charging you.

### Step 1: Scan for Opportunities
Use \`arb_scan\` to find symbols with large funding rate spreads:
- Look for annualized spreads > 10% (good), > 20% (excellent)
- Check that the spread has been persistent (not just a spike)

### Step 2: Validate with Market Data
- Use \`get_funding_rates\` to see current rates
- Use \`get_orderbook\` on both exchanges to check liquidity
- Use \`get_prices\` to compare mark prices (large deviation = risk)

### Step 3: Execute the Arb
For each leg:
1. \`trade_preview\` the LONG leg on the exchange with positive funding
2. \`trade_preview\` the SHORT leg on the exchange with negative funding
3. Show both previews to user, get confirmation
4. Execute both legs

### Step 4: Monitor Performance
- Use \`get_arb_compare\` to track all arb positions side by side
- Use \`get_funding_analysis\` to see cumulative funding income
- Use \`get_pnl_analysis\` to see net P&L (funding income - trading fees)

### Step 5: Close When Spread Compresses
When the funding spread narrows below 2-3%, consider closing:
- Use \`trade_close\` on both legs
- Check final P&L with \`get_pnl_analysis\`

### Risk Factors
- **Basis risk**: Prices may diverge between exchanges
- **Liquidation risk**: Each leg can be liquidated independently
- **Funding reversal**: Rates can flip direction
- **Bridge costs**: Moving funds between exchanges has costs`,
      },
    }],
  }),
);

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running and listening on stdio
}

main().catch((e) => {
  console.error("Fatal: MCP server failed to start:", e);
  process.exit(1);
});
