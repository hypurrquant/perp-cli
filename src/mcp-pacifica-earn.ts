/**
 * Read-only MCP tools for Pacifica Print and vaults (unauthenticated GETs; nothing is signed).
 * Print deposits / ends and vault deposits / withdrawals are NOT exposed over MCP: the server has
 * no money-moving deposit / withdraw tools (funds moves are CLI-only, `perp funds …`), and these
 * follow the same rule — use `perp print deposit` / `perp vault deposit|withdraw` (with --dry-run).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PacificaClient } from "./pacifica/client.js";
import type { Network } from "./exchanges/venue-types.js";
import { fetchPrintGames, fetchPrintHistory, fetchPrintMarket, fetchPrintPositions, findPrintGame, quotePrintOrder } from "./exchanges/pacifica-print.js";
import { DEPOSIT_WHITELIST_API_STATUS, fetchDepositWhitelist, fetchVaults, findVault, heldShares, withdrawWindowAt } from "./exchanges/pacifica-vaults.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

export function registerPacificaEarnMcpTools(
  server: McpServer,
  network: Network,
  ok: (data: unknown, meta?: Record<string, unknown>) => string,
  errOf: (e: unknown, meta?: Record<string, unknown>) => string,
): void {
  const client = (): PacificaClient => new PacificaClient({ network });
  const run = async (meta: Record<string, unknown>, f: () => Promise<unknown>): Promise<Text> => {
    try {
      return { content: [{ type: "text", text: ok(await f(), meta) }] };
    } catch (e) {
      return { content: [{ type: "text", text: errOf(e, meta) }], isError: true };
    }
  };
  const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 Solana address");

  server.tool(
    "pacifica_print_products",
    "Pacifica Print products (read-only): game id (e.g. BTC_24H, BTC_7D, BTC_1M), cycle length in days, max leverage, deposit caps, allowed target distance from mark. Print = a strike order that earns a premium each cycle; while resting it fills / is liquidated only at a cycle checkpoint, after a fill it is an ordinary perp position (continuous liquidation).",
    {},
    async () => run({ exchange: "pacifica" }, async () => fetchPrintGames(client())),
  );

  server.tool(
    "pacifica_print_quote",
    "Validate a Pacifica Print order and preview it (read-only, nothing signed): notional, size on fill, docs-formula liquidation price (an outer bound — a liquidation was observed earlier in one live case; venue trigger unpublished), max loss (deposit + premiums), lock period. The premium is not quoted (the venue's preview is a signed request). Placing the order is CLI-only: perp -e pacifica print deposit … (supports --dry-run).",
    {
      game: z.string().describe("Print product, e.g. BTC_24H"),
      direction: z.enum(["long", "short"]).describe("long = target below mark, short = target above mark"),
      deposit: z.string().describe("USDC deposit, min 10"),
      strike: z.string().describe("Target price (on the market tick)"),
      leverage: z.string().describe("Whole-number leverage 1 … product max"),
      cycles: z.number().int().optional().describe("Cycles 1 … 1000; omit = roll until cancelled"),
    },
    async ({ game, direction, deposit, strike, leverage, cycles }) => run({ exchange: "pacifica", game }, async () => {
      const c = client();
      const g = findPrintGame(await fetchPrintGames(c), game);
      return quotePrintOrder(g, { game: g.game, direction, deposit, strikePrice: strike, leverage, cycles: cycles ?? null }, await fetchPrintMarket(c, g.asset));
    }),
  );

  server.tool(
    "pacifica_print_positions",
    "Pacifica Print orders of an account (read-only): current orders, or with history=true every order (paginated: limit / cursor). Status printing | cancelling | filled | liquidated | cancelled | completed | ended.",
    {
      account: address.describe("Pacifica account (Solana address)"),
      history: z.boolean().optional().describe("true = every order (history_summary), default false = current orders"),
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional(),
    },
    async ({ account, history, limit, cursor }) => run({ exchange: "pacifica", account }, async () => {
      if (history !== true) return { account, positions: await fetchPrintPositions(client(), account) };
      const page = await fetchPrintHistory(client(), account, { limit: limit ?? null, cursor: cursor ?? null });
      return { account, positions: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }),
  );

  server.tool(
    "pacifica_vaults",
    "Pacifica vaults (API: lakes), read-only. Without vault: every vault (TVL, NAV per share, fee, lock-up, withdrawal window, config); with account: plus that account's shares. With vault (address, or a nickname matching exactly one vault — an ambiguous nickname is INVALID_PARAMS listing the candidates): one vault plus live account equity, positions, deposit whitelist (unofficial endpoint, advisory) and whether withdrawals are open now. APY is not published (null). Deposits / withdrawals are CLI-only: perp -e pacifica vault deposit|withdraw (supports --dry-run).",
    {
      vault: z.string().optional().describe("Vault address or exact nickname"),
      account: address.optional().describe("Include this account's shares"),
    },
    async ({ vault, account }) => run({ exchange: "pacifica" }, async () => {
      const c = client();
      const vaults = await fetchVaults(c, account ?? null);
      if (vault === undefined) return vaults;
      const v = findVault(vaults, vault);
      const [acct, positions, whitelist] = await Promise.all([c.getAccount(v.address), c.getPositions(v.address), fetchDepositWhitelist(c, v.address).catch(() => null)]);
      return {
        ...v,
        ...(account !== undefined ? { holding: heldShares(v, account) } : {}),
        live: { accountEquity: acct.account_equity ?? null, availableToWithdraw: acct.available_to_withdraw ?? null, positions: positions.map((p) => ({ symbol: p.symbol, side: p.side, amount: p.amount, entryPrice: p.entry_price })) },
        depositWhitelist: { apiStatus: DEPOSIT_WHITELIST_API_STATUS, addresses: whitelist },
        withdrawWindow: withdrawWindowAt(v.config, Date.now()),
      };
    }),
  );
}
