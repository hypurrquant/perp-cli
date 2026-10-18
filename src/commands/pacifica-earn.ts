/**
 * `perp print …` (Pacifica Print) and `perp vault …` (Pacifica vaults / "lakes").
 *
 * Pacifica-only products: the commands always talk to Pacifica (an explicit `-e <other venue>` is
 * refused). Reads are unauthenticated GETs and never sign; `--account <address>` reads any
 * account without loading a key or building the adapter.
 *
 * Signer policy (perp-cli rule, stricter than the venue, which accepts `agent_wallet` on all four):
 *  - `vault deposit` (deposit_to_lake) is MASTER-ONLY, like `funds withdraw pacifica`: a leaked agent
 *    key must not be able to move the whole balance into a vault an attacker manages;
 *  - `vault withdraw` (pays only into the own account), `print deposit` and `print cancel` are
 *    signed by the active signer (agent when approved, else master).
 * Every write supports `--dry-run` (exact canonical message + body, never signs, never sends). An
 * unknown send outcome is ORDER_PENDING: never resubmitted except with the same --idempotency-key.
 */
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import chalk from "chalk";
import { isDryRun, networkOf, supportsDryRun } from "../cli-flags.js";
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import { resolveVenueId } from "../exchanges/venue.js";
import { PacificaClient } from "../pacifica/client.js";
import { logExecution } from "../execution-log.js";
import { jsonOk, makeTable, printJson } from "../utils.js";
import { mulDecimal } from "../exchanges/precision.js";
import { cmpDecimal, isPlainDecimal, trimDecimal } from "../exchanges/pacifica-decimal.js";
import { fundsFailStatus } from "./funds.js";
import { requireIdempotencyKey, restampPresigned, sendPresigned, signPresigned, type PresignedIdentity, type PresignedRequest } from "../exchanges/pacifica-presigned.js";
import type { ExecutionRecord } from "../execution-log.js";
import {
  buildPrintDepositRequest, buildPrintEndRequest, daysUntil, fetchPrintEvents, fetchPrintGames, fetchPrintHistory,
  fetchPrintMarket, fetchPrintPositions, findPrintGame, quotePrintOrder, requireEndable,
  type PrintDirection, type PrintPosition, type PrintQuote,
} from "../exchanges/pacifica-print.js";
import {
  buildVaultDepositRequest, buildVaultWithdrawRequest, DEPOSIT_WHITELIST_API_STATUS, fetchDepositWhitelist, fetchVaults, findVault, heldShares,
  planVaultDeposit, planVaultWithdraw, withdrawWindowAt, type PacificaVault,
} from "../exchanges/pacifica-vaults.js";

type Getter = (exchange: string) => Promise<ExchangeAdapter>;

interface Signing { identity: PresignedIdentity; tier: "agent" | "master" | "pk" | null; sign: ((m: Uint8Array) => Promise<Uint8Array>) | null; client: PacificaClient }

const ts = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC");

export function registerPacificaEarnCommands(program: Command, getAdapterForExchange: Getter, isJson: () => boolean): void {
  /** Pacifica-only: an explicit -e naming another venue is refused (never silently ignored). */
  function assertPacifica(): void {
    if (program.getOptionValueSource("exchange") !== "cli") return;
    const raw = program.opts().exchange as string | undefined;
    if (raw !== undefined && resolveVenueId(raw) !== "pacifica") {
      throw new PerpError("INVALID_PARAMS", `Print and vaults are Pacifica products; -e ${raw} has neither`, { remediation: "Run with -e pacifica (or omit -e)" });
    }
  }

  const publicClient = (): PacificaClient => new PacificaClient({ network: networkOf(program) });

  async function pacificaAdapter(): Promise<PacificaAdapter> {
    const a = await getAdapterForExchange("pacifica");
    if (!(a instanceof PacificaAdapter)) throw new Error("pacifica venue did not produce a PacificaAdapter");
    return a;
  }

  /** Account to read: --account, else the configured wallet's (master) address. Signs nothing. */
  async function readAccount(opt: string | undefined): Promise<string> {
    if (opt !== undefined) return requireAddress(opt);
    const a = await pacificaAdapter();
    if (a.isReadOnly) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "No Pacifica wallet configured to read", { remediation: "Pass --account <solana address>, or configure a Pacifica wallet (perp setup)" });
    }
    return a.publicKey;
  }

  /** Identity for a write. --account only plans (dry-run, no key loaded); a live write signs as the configured wallet. */
  async function signing(accountOpt: string | undefined, dryRun: boolean): Promise<Signing> {
    if (accountOpt !== undefined) {
      if (!dryRun) {
        throw new PerpError("INVALID_PARAMS", "--account only plans with --dry-run; a live write signs as the configured Pacifica wallet", { remediation: "Drop --account (or add --dry-run)" });
      }
      return { identity: { account: requireAddress(accountOpt), agentWallet: null }, tier: null, sign: null, client: publicClient() };
    }
    const a = await pacificaAdapter();
    const id = a.signingIdentity();
    return { identity: { account: id.account, agentWallet: id.agentWallet }, tier: id.tier, sign: id.signMessage, client: a.sdk };
  }

  /**
   * Master-only identity (vault deposit): the master Solana signer, never the agent — even when an
   * agent is approved. No master on this machine → NO_SIGNER_AVAILABLE. Mirrors PacificaAdapter.withdraw.
   */
  async function masterSigning(accountOpt: string | undefined, dryRun: boolean): Promise<Signing> {
    if (accountOpt !== undefined) {
      const plan = await signing(accountOpt, dryRun);
      return { ...plan, tier: null };
    }
    const a = await pacificaAdapter();
    const refuse = (): PerpError => new PerpError("NO_SIGNER_AVAILABLE", "A Pacifica vault deposit must be signed by the account's master wallet (an agent key cannot fund a vault), and it is not loaded", {
      exchange: "pacifica",
      remediation: "Run with the master wallet: perp -e pacifica --ows <wallet> vault deposit … (or deposit on the Pacifica website)",
    });
    let master;
    try { master = a.masterSolanaSigner(); } catch { throw refuse(); }
    if (master.getPublicKeyBase58() !== a.publicKey) throw refuse();
    return { identity: { account: a.publicKey, agentWallet: null }, tier: "master", sign: (m) => master.signMessage(m), client: a.sdk };
  }

  /** Dry-run: the exact request a live run would sign and send (no signature). */
  function printDryRun(plan: unknown, req: PresignedRequest, tier: Signing["tier"], extra: Record<string, unknown> = {}): void {
    const request = { path: `POST /api/v1${req.path}`, type: req.type, signer: tier ?? "not loaded (--account plan)", signedMessage: req.message, body: { ...req.body, signature: null } };
    if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, ...extra, plan, request }));
    if (extra.apiStatus === "unofficial") console.log(chalk.yellow(`  ! ${req.path} is UNOFFICIAL (not in the Pacifica API docs; shape captured from app.pacifica.fi)`));
    console.log(chalk.yellow(`\n  [dry-run] ${req.type} — nothing signed, nothing sent`));
    console.log(`  POST /api/v1${req.path}   signer: ${request.signer}`);
    console.log(chalk.gray("  message to sign:"));
    console.log(`  ${req.message}`);
    console.log(chalk.gray("  body (signature added at send):"));
    console.log(`  ${JSON.stringify(request.body)}\n`);
  }

  /** Sign + send; log every outcome incl. a signing failure (unknown outcome → "unverified", ORDER_PENDING). */
  async function send(s: Signing, req: PresignedRequest, o: { what: string; check: string; logType: ExecutionRecord["type"]; symbol: string; size: string; meta: Record<string, unknown>; before: Record<string, unknown> }): Promise<Record<string, unknown>> {
    if (s.sign === null) throw new Error("send without a signer");
    const base = { type: o.logType, exchange: "pacifica", symbol: o.symbol, side: req.type, size: o.size, dryRun: false, meta: { ...o.meta, signer: s.tier, idempotencyKey: req.idempotencyKey, before: o.before } } as const;
    try {
      // Credit wait BEFORE signing (a post-sign wait would eat the 5 s expiry_window). The body's
      // timestamp is re-stamped after the wait so the signature window starts now.
      await s.client.awaitPresignedCapacity(req.type);
      req = restampPresigned(req, Date.now());
      const body = await signPresigned(req, s.sign);
      const data = await sendPresigned(s.client, req, body, { what: o.what, check: o.check, before: o.before });
      logExecution({ ...base, status: "success", meta: { ...base.meta, response: data } });
      return data;
    } catch (err) {
      logExecution({ ...base, status: fundsFailStatus(err), error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  const keyOf = (raw: string | undefined): string => (raw === undefined ? randomUUID() : requireIdempotencyKey(raw));

  // ═══════════════════════════ PRINT ═══════════════════════════

  const print = program.command("print").description("Pacifica Print — strike orders that earn a premium every cycle while they wait (reads, quote, deposit/cancel with --dry-run)");

  print.command("games").alias("products")
    .description("Print products: market, cycle, max leverage, deposit caps, allowed target range")
    .action(async () => {
      assertPacifica();
      const games = await fetchPrintGames(publicClient());
      if (isJson()) return printJson(jsonOk(games));
      console.log(chalk.white.bold("\n  Pacifica Print products"));
      console.log(makeTable(["game", "asset", "cycle", "max lev", "target from mark", "product cap (total)", "pool cap (total)"],
        games.map((g) => [g.game, g.asset, g.cycleDays === null ? "?" : `${g.cycleDays}d`, g.maxLeverage === null ? "?" : `${g.maxLeverage}x`,
          g.targetDistancePct.max === null ? "?" : `${g.targetDistancePct.min}%–${g.targetDistancePct.max}%`, g.productDepositCap ?? "—", g.poolDepositCap ?? "—"])));
      console.log(chalk.gray(`  Min deposit ${games[0]?.minDeposit ?? "10"} USDC · while resting, fill/liquidation only at each cycle's checkpoint · after a fill: ordinary perp position · cancel settles at the cycle's end\n`));
    });

  const orderArgs = (c: Command): Command => c
    .argument("<game>", "Print product, e.g. BTC_24H, BTC_7D, BTC_1M (perp print games)")
    .argument("<direction>", "long (target below mark) | short (target above mark)")
    .argument("<deposit>", "USDC deposit (locked margin), min 10")
    .requiredOption("--strike <price>", "Target price (on the market tick)")
    .requiredOption("--leverage <n>", "Whole-number leverage, 1 … the product max")
    .option("--cycles <n>", "Cycles to run, 1 … 1000 (default: roll until cancelled)");

  async function quoteFrom(gameArg: string, dirArg: string, deposit: string, o: { strike: string; leverage: string; cycles?: string }): Promise<PrintQuote> {
    const direction = parseDirection(dirArg);
    const cycles = o.cycles === undefined ? null : parseWhole(o.cycles, "--cycles");
    const c = publicClient();
    const game = findPrintGame(await fetchPrintGames(c), gameArg);
    const market = await fetchPrintMarket(c, game.asset);
    return quotePrintOrder(game, { game: game.game, direction, deposit, strikePrice: o.strike, leverage: o.leverage, cycles }, market);
  }

  orderArgs(print.command("quote"))
    .description("Validate a Print order and preview size, liquidation price, max loss and lock period (read-only; the premium itself is quoted only by the venue)")
    .action(async (gameArg: string, dirArg: string, deposit: string, o: { strike: string; leverage: string; cycles?: string }) => {
      assertPacifica();
      const q = await quoteFrom(gameArg, dirArg, deposit, o);
      if (isJson()) return printJson(jsonOk(q));
      printQuote(q);
    });

  print.command("positions")
    .description("Current Print orders of the account (printing / cancelling / just settled)")
    .option("--account <address>", "Read this account instead of the configured wallet")
    .action(async (o: { account?: string }) => {
      assertPacifica();
      const account = await readAccount(o.account);
      const rows = await fetchPrintPositions(publicClient(), account);
      if (isJson()) return printJson(jsonOk({ account, positions: rows }));
      printPositions(account, rows);
    });

  print.command("history")
    .description("Every Print order of the account, newest first (paginated)")
    .option("--account <address>", "Read this account instead of the configured wallet")
    .option("--limit <n>", "Rows per page")
    .option("--cursor <cursor>", "next_cursor of the previous page")
    .action(async (o: { account?: string; limit?: string; cursor?: string }) => {
      assertPacifica();
      const account = await readAccount(o.account);
      const page = await fetchPrintHistory(publicClient(), account, { limit: o.limit === undefined ? null : parseWhole(o.limit, "--limit"), cursor: o.cursor ?? null });
      if (isJson()) return printJson(jsonOk({ account, positions: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor }));
      printPositions(account, page.items);
      if (page.hasMore === true) console.log(chalk.gray(`  More: --cursor ${page.nextCursor ?? "?"}\n`));
    });

  print.command("events <printAddress>")
    .description("Event log of one Print order: created, premium, end_requested, filled, liquidated, …")
    .option("--limit <n>", "Rows per page")
    .option("--cursor <cursor>", "next_cursor of the previous page")
    .action(async (addr: string, o: { limit?: string; cursor?: string }) => {
      assertPacifica();
      const page = await fetchPrintEvents(publicClient(), requireAddress(addr), { limit: o.limit === undefined ? null : parseWhole(o.limit, "--limit"), cursor: o.cursor ?? null });
      if (isJson()) return printJson(jsonOk({ printAddress: addr, events: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor }));
      console.log("\n" + makeTable(["time", "event", "amount", "strike", "mark", "cycle"],
        page.items.map((e) => [ts(e.time), e.event, e.amount ?? "—", e.strikePrice ?? "—", e.markPrice ?? "—", e.cycleStartedAt === null ? "—" : `${ts(e.cycleStartedAt)} → ${ts(e.cycleEndedAt)}`])) + "\n");
    });

  supportsDryRun(orderArgs(print.command("deposit").alias("open")))
    .description("Place a Print order (POST /game/deposit, deposit_to_game) — locks the deposit until it fills or a cancel settles at a cycle's end; supports --dry-run")
    .option("--account <address>", "With --dry-run: plan for this account without loading a key")
    .option("--idempotency-key <uuid>", "Re-send an earlier attempt with ITS key (only safe retry after ORDER_PENDING; default: a fresh key)")
    .action(async (gameArg: string, dirArg: string, deposit: string, o: { strike: string; leverage: string; cycles?: string; account?: string; idempotencyKey?: string }, cmd: Command) => {
      assertPacifica();
      const dryRun = isDryRun(cmd);
      const idempotencyKey = keyOf(o.idempotencyKey);
      const q = await quoteFrom(gameArg, dirArg, deposit, o);
      const s = await signing(o.account, dryRun);
      const ordersBefore = (await fetchPrintPositions(publicClient(), s.identity.account)).length;
      const available = availableOf(await publicClient().getAccount(s.identity.account), s.identity.account);
      if (cmpDecimal(available, q.deposit) < 0) {
        throw new PerpError("INSUFFICIENT_BALANCE", `Print deposit ${q.deposit} USDC exceeds available_to_withdraw ${available}`, { exchange: "pacifica", remediation: "Deposit less, or free margin first (perp -e pacifica portfolio)" });
      }
      const req = buildPrintDepositRequest(q, s.identity, { timestamp: Date.now(), idempotencyKey });
      if (!isJson()) printQuote(q);
      if (dryRun) return printDryRun(q, req, s.tier);
      const data = await send(s, req, {
        what: `Print deposit ${q.deposit} USDC ${q.game} ${q.direction} @ ${q.strikePrice}`,
        check: `perp -e pacifica print positions — look for a new ${q.game} ${q.direction} order with strikePrice ${q.strikePrice} and deposit ${q.deposit} (${ordersBefore} current order(s) before this request)`,
        logType: "print_deposit", symbol: q.game, size: q.deposit, before: { printOrders: ordersBefore },
        meta: { game: q.game, direction: q.direction, strike: q.strikePrice, leverage: q.leverage, cycles: q.cycles },
      });
      const printAddress = typeof data.game_account_address === "string" ? data.game_account_address : null;
      if (isJson()) return printJson(jsonOk({ placed: true, printAddress, quote: q, idempotencyKey: req.idempotencyKey, response: data }));
      console.log(chalk.green(`\n  Print order placed: ${printAddress ?? "(no address in response)"}`));
      console.log(chalk.gray("  Track it: perp -e pacifica print positions\n"));
    });

  supportsDryRun(print.command("cancel <printAddress>").alias("end"))
    .description("[UNOFFICIAL endpoint] End a running Print order (POST /game/end, end_game — not in the API docs; shape captured from app.pacifica.fi). It still runs to the end of the current cycle, then fills or returns the deposit + premiums. Live run needs --unverified-endpoint; supports --dry-run")
    .option("--account <address>", "With --dry-run: plan for this account without loading a key")
    .option("--unverified-endpoint", "Acknowledge that /game/end is undocumented (required for a live run)")
    .action(async (addr: string, o: { account?: string; unverifiedEndpoint?: boolean }, cmd: Command) => {
      assertPacifica();
      const dryRun = isDryRun(cmd);
      if (!dryRun && o.unverifiedEndpoint !== true) {
        throw new PerpError("INVALID_PARAMS", "print cancel uses POST /game/end (end_game), which is not in the Pacifica API docs (apiStatus: unofficial)", {
          exchange: "pacifica", apiStatus: "unofficial",
          remediation: "Check it first with --dry-run, then re-run with --unverified-endpoint — or end the order on app.pacifica.fi",
        });
      }
      const s = await signing(o.account, dryRun);
      const p = requireEndable(await fetchPrintPositions(publicClient(), s.identity.account), requireAddress(addr));
      const req = buildPrintEndRequest(p.address, s.identity, { timestamp: Date.now() });
      const plan = { printAddress: p.address, game: p.game, settlesAt: p.currentCycleEndAt, settlesInDays: daysUntil(p.currentCycleEndAt, Date.now()), lockedNow: p.maxLoss };
      if (!isJson()) console.log(chalk.cyan(`\n  End ${p.address} (${p.game}): it keeps running until ${ts(p.currentCycleEndAt)}, then fills or returns ${p.maxLoss ?? p.deposit} USDC`));
      if (dryRun) return printDryRun(plan, req, s.tier, { apiStatus: "unofficial" });
      const data = await send(s, req, {
        what: `Print end ${p.address}`,
        check: `perp -e pacifica print positions — order ${p.address} shows status "cancelling" if the end was accepted (it was "${p.status}" before)`,
        logType: "print_end", symbol: p.game, size: p.deposit, before: { status: p.status }, meta: { printAddress: p.address, game: p.game, apiStatus: "unofficial" },
      });
      const at = typeof data.scheduled_end_at_ms === "number" ? data.scheduled_end_at_ms : null;
      if (isJson()) return printJson(jsonOk({ endRequested: true, apiStatus: "unofficial", printAddress: p.address, scheduledEndAt: at, response: data }));
      console.log(chalk.green(`\n  End requested for ${p.address} — settles at ${ts(at)} (the order runs until then).\n`));
    });

  // ═══════════════════════════ VAULT ═══════════════════════════

  const vault = program.command("vault").alias("lake").description("Pacifica vaults (API: lakes) — list, info, positions, deposit/withdraw with --dry-run");

  vault.command("list")
    .description("Vaults by TVL with NAV per share, fees, lock-up and withdrawal window")
    .option("--account <address>", "Include this account's LP shares")
    .option("--limit <n>", "Rows shown (human output; --json returns all)", "25")
    .action(async (o: { account?: string; limit: string }) => {
      assertPacifica();
      const vaults = sortByTvl(await fetchVaults(publicClient(), o.account === undefined ? null : requireAddress(o.account)));
      if (isJson()) return printJson(jsonOk(vaults));
      const n = parseWhole(o.limit, "--limit");
      console.log("\n" + makeTable(["vault", "address", "TVL", "NAV/LP share", "fee", "lock-up", "withdraw window"],
        vaults.slice(0, n).map((v) => [v.nickname ?? "—", v.address, v.tvl, v.navPerLpShare ?? "1 (empty)", v.config.managerProfitShare ?? "—",
          v.config.depositMinDurationMs === null ? "—" : `${(v.config.depositMinDurationMs / 3_600_000).toFixed(1)}h`, windowLabel(v)])));
      console.log(chalk.gray(`  ${Math.min(n, vaults.length)} of ${vaults.length} vaults · APY is not published by Pacifica\n`));
    });

  vault.command("info <vault>")
    .description("One vault (address or nickname): balances, NAV, config, live account equity, positions, withdrawal window now")
    .action(async (ref: string) => {
      assertPacifica();
      const c = publicClient();
      const v = findVault(await fetchVaults(c, null), ref);
      const [acct, positions, whitelist] = await Promise.all([c.getAccount(v.address), c.getPositions(v.address), whitelistOrNull(c, v.address)]);
      const out = {
        ...v,
        live: { accountEquity: acct.account_equity ?? null, availableToWithdraw: acct.available_to_withdraw ?? null, positions: positions.map((p) => ({ symbol: p.symbol, side: p.side, amount: p.amount, entryPrice: p.entry_price })) },
        depositWhitelist: { apiStatus: DEPOSIT_WHITELIST_API_STATUS, addresses: whitelist },
        withdrawWindow: withdrawWindowAt(v.config, Date.now()),
      };
      if (isJson()) return printJson(jsonOk(out));
      console.log(chalk.white.bold(`\n  ${v.nickname ?? v.address}`));
      for (const [k, val] of Object.entries({
        address: v.address, manager: v.manager ?? "none (fresh vault)", creator: v.creator ?? "—", TVL: v.tvl, "NAV / LP share": v.navPerLpShare ?? "1 (LP class empty)",
        "NAV / manager share": v.navPerManagerShare ?? "—", "high-water mark": v.highWatermark ?? "—", "live equity": out.live.accountEquity ?? "—",
        "vault free balance": out.live.availableToWithdraw ?? "—", "performance fee": v.config.managerProfitShare ?? "none", "deposit cap": v.config.depositCap ?? "none",
        "lock-up after deposit": v.config.depositMinDurationMs === null ? "none" : `${(v.config.depositMinDurationMs / 3_600_000).toFixed(2)} h (reset by every deposit)`,
        "withdrawal window": `${windowLabel(v)}${out.withdrawWindow.restricted ? ` — now ${out.withdrawWindow.open ? "OPEN until" : "closed, opens"} ${ts(out.withdrawWindow.nextChangeAt)}` : ""}`,
        "deposit whitelist": `${whitelist === null ? "unknown" : whitelist.length === 0 ? "none (anyone)" : `${whitelist.length} address(es)`} (unofficial endpoint; the venue decides)`, APY: "not published",
      })) console.log(`  ${k.padEnd(22)} ${val}`);
      if (out.live.positions.length > 0) console.log("\n" + makeTable(["symbol", "side", "amount", "entry"], out.live.positions.map((p) => [p.symbol, p.side, p.amount, p.entryPrice])));
      console.log("");
    });

  vault.command("positions")
    .description("Vaults where the account holds shares (LP shares, or the manager's own)")
    .option("--account <address>", "Read this account instead of the configured wallet")
    .action(async (o: { account?: string }) => {
      assertPacifica();
      const account = await readAccount(o.account);
      const rows = (await fetchVaults(publicClient(), account)).map((v) => ({ v, h: heldShares(v, account) }))
        .filter(({ h }) => h.shares !== null && Number(h.shares) > 0)
        .map(({ v, h }) => ({ schema: 1 as const, vault: v.address, nickname: v.nickname, role: h.role, shares: h.shares as string, navPerShare: h.nav, value: h.nav === null ? null : mul(h.shares as string, h.nav), withdrawWindow: withdrawWindowAt(v.config, Date.now()), lockMs: v.config.depositMinDurationMs }));
      if (isJson()) return printJson(jsonOk({ account, positions: rows }));
      if (rows.length === 0) { console.log(chalk.gray(`\n  ${account} holds no vault shares.\n`)); return; }
      console.log("\n" + makeTable(["vault", "role", "shares", "NAV/share", "value ≈ USDC", "withdraw now"], rows.map((r) => [r.nickname ?? r.vault, r.role, r.shares, r.navPerShare ?? "—", r.value ?? "—", r.withdrawWindow.open ? "window open" : `closed → ${ts(r.withdrawWindow.nextChangeAt)}`])) + "\n");
    });

  supportsDryRun(vault.command("deposit <vault> <amount>"))
    .description("Deposit USDC from the trading balance into a vault (POST /lake/deposit, deposit_to_lake) for shares at NAV; supports --dry-run")
    .option("--account <address>", "With --dry-run: plan for this account without loading a key")
    .option("--idempotency-key <uuid>", "Re-send an earlier attempt with ITS key (only safe retry after ORDER_PENDING; default: a fresh key)")
    .action(async (ref: string, amount: string, o: { account?: string; idempotencyKey?: string }, cmd: Command) => {
      assertPacifica();
      const dryRun = isDryRun(cmd);
      const idempotencyKey = keyOf(o.idempotencyKey);
      const c = publicClient();
      const s = await masterSigning(o.account, dryRun);
      const v = findVault(await fetchVaults(c, s.identity.account), ref);
      const [info, whitelist] = await Promise.all([c.getAccount(s.identity.account), whitelistOrNull(c, v.address)]);
      const plan = planVaultDeposit(v, s.identity.account, amount, { availableToWithdraw: availableOf(info, s.identity.account), whitelist });
      const sharesBefore = heldShares(v, s.identity.account).shares ?? "0";
      const req = buildVaultDepositRequest(v.address, plan.amount, s.identity, { timestamp: Date.now(), idempotencyKey });
      if (!isJson()) printWarnings(`Depositing ${plan.amount} USDC into vault ${v.address} "${v.nickname ?? ""}" (manager ${v.manager ?? "none"}) — ≈ ${plan.estimatedShares ?? "?"} shares; signer: master`, plan.warnings);
      if (dryRun) return printDryRun(plan, req, s.tier === null ? null : "master");
      const data = await send(s, req, {
        what: `vault deposit ${plan.amount} USDC into ${v.address}`,
        check: `perp -e pacifica vault positions — shares in vault ${v.address} (${sharesBefore} before this request)`,
        logType: "vault_deposit", symbol: "USDC", size: plan.amount, before: { shares: sharesBefore }, meta: { vault: v.address, manager: v.manager },
      });
      const minted = typeof data.shares_minted === "string" ? data.shares_minted : null;
      if (isJson()) return printJson(jsonOk({ deposited: true, vault: v.address, amount: plan.amount, sharesMinted: minted, idempotencyKey: req.idempotencyKey, response: data }));
      console.log(chalk.green(`\n  Deposited ${plan.amount} USDC — shares minted: ${minted ?? "(not in response)"}\n`));
    });

  supportsDryRun(vault.command("withdraw <vault> [shares]"))
    .description("Redeem vault shares back into YOUR OWN trading balance (POST /lake/withdraw, withdraw_from_lake; no destination exists); supports --dry-run")
    .option("--all", "Redeem every share the account holds")
    .option("--account <address>", "With --dry-run: plan for this account without loading a key")
    .option("--idempotency-key <uuid>", "Re-send an earlier attempt with ITS key (only safe retry after ORDER_PENDING; default: a fresh key)")
    .action(async (ref: string, shares: string | undefined, o: { all?: boolean; account?: string; idempotencyKey?: string }, cmd: Command) => {
      assertPacifica();
      if ((shares === undefined) === (o.all !== true)) {
        throw new PerpError("INVALID_PARAMS", "vault withdraw: give exactly one of <shares> or --all", { remediation: "e.g. perp -e pacifica vault withdraw <vault> 50 | --all" });
      }
      const dryRun = isDryRun(cmd);
      const idempotencyKey = keyOf(o.idempotencyKey);
      const c = publicClient();
      const s = await signing(o.account, dryRun);
      const v = findVault(await fetchVaults(c, s.identity.account), ref);
      const lake = await c.getAccount(v.address);
      const plan = planVaultWithdraw(v, s.identity.account, o.all === true ? "all" : (shares as string), { nowMs: Date.now(), vaultAvailableToWithdraw: isPlainDecimal(lake.available_to_withdraw) ? lake.available_to_withdraw : null });
      const req = buildVaultWithdrawRequest(v.address, plan.shares, s.identity, { timestamp: Date.now(), idempotencyKey });
      if (req.body.account !== s.identity.account) throw new Error("vault withdraw body account mismatch");
      if (!isJson()) printWarnings(`Redeeming ${plan.shares} shares (≈ ${plan.estimatedAmount ?? "?"} USDC) from vault ${v.address} "${v.nickname ?? ""}" (manager ${v.manager ?? "none"}) to ${plan.destination}`, plan.warnings);
      if (dryRun) return printDryRun(plan, req, s.tier);
      const data = await send(s, req, {
        what: `vault withdraw ${plan.shares} shares from ${v.address}`,
        check: `perp -e pacifica vault positions — shares in vault ${v.address} (${plan.heldShares} before this request)`,
        logType: "vault_withdraw", symbol: "USDC", size: plan.shares, before: { shares: plan.heldShares }, meta: { vault: v.address, estimatedAmount: plan.estimatedAmount },
      });
      const amt = typeof data.amount_withdrawn === "string" ? data.amount_withdrawn : null;
      if (isJson()) return printJson(jsonOk({ withdrawn: true, vault: v.address, shares: plan.shares, amountWithdrawn: amt, destination: plan.destination, idempotencyKey: req.idempotencyKey, response: data }));
      console.log(chalk.green(`\n  Redeemed ${plan.shares} shares → ${amt ?? "(amount not in response)"} USDC credited to ${plan.destination}\n`));
    });
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Unofficial whitelist read: null when unreadable (advisory only — the venue's refusal is final). */
async function whitelistOrNull(c: PacificaClient, vault: string): Promise<string[] | null> {
  try { return await fetchDepositWhitelist(c, vault); } catch { return null; }
}

function requireAddress(s: string): string {
  const a = s.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
    throw new PerpError("INVALID_PARAMS", `Not a Solana (base58) address: "${s}"`, { remediation: "Pass a base58 Solana address" });
  }
  return a;
}

function parseDirection(s: string): PrintDirection {
  const d = s.trim().toLowerCase();
  if (d === "long" || d === "short") return d;
  throw new PerpError("INVALID_PARAMS", `direction must be long or short (got "${s}")`, { remediation: "long = target below mark, short = target above mark" });
}

function parseWhole(s: string, what: string): number {
  if (!/^[1-9]\d*$/.test(s.trim())) throw new PerpError("INVALID_PARAMS", `${what} must be a positive whole number (got "${s}")`);
  return Number(s.trim());
}

function mul(a: string, b: string): string {
  return trimDecimal(mulDecimal(a, b));
}

/** available_to_withdraw of GET /account; unreadable → EXCHANGE_ERROR (never treated as 0). */
function availableOf(info: { available_to_withdraw?: unknown }, account: string): string {
  const v = info.available_to_withdraw;
  if (!isPlainDecimal(v)) throw new PerpError("EXCHANGE_ERROR", `Pacifica /account for ${account} has no readable available_to_withdraw`, { exchange: "pacifica" });
  return v;
}

function sortByTvl(v: PacificaVault[]): PacificaVault[] {
  return [...v].sort((a, b) => Number(b.tvl) - Number(a.tvl));
}

function windowLabel(v: PacificaVault): string {
  const { withdrawWindowS: w, withdrawDurationS: d } = v.config;
  return w === null || d === null ? "always" : `${(d / 3600).toFixed(1)}h every ${(w / 3600).toFixed(1)}h`;
}

function printWarnings(title: string, warnings: string[]): void {
  console.log(chalk.cyan(`\n  ${title}`));
  for (const w of warnings) console.log(chalk.yellow(`  ! ${w}`));
}

function printQuote(q: PrintQuote): void {
  console.log(chalk.white.bold(`\n  Print ${q.direction.toUpperCase()} ${q.game} — preview`));
  for (const [k, v] of Object.entries({
    "deposit (locked)": `${q.deposit} USDC`,
    leverage: `${q.leverage}x  → notional ${q.notional} USDC`,
    "target / mark": `${q.strikePrice} / ${q.markPrice}  (${q.targetDistancePct}% away; allowed ${q.allowedTargetDistancePct.min}%–${q.allowedTargetDistancePct.max}%)`,
    "size on fill": `${q.size} ${q.asset} at exactly ${q.strikePrice}`,
    "liquidation": `${q.docsLiquidationPrice ?? "unknown (docs formula gives ≤ 0)"} — docs-formula outer bound only; observed earlier in one live case, venue trigger unpublished`,
    "after a fill": "ordinary position in your main account: continuous mark-price liquidation, nets with an existing position, may be cross-margined (perp -e pacifica account positions)",
    "MAX LOSS": `${q.maxLoss} USDC deposit + every premium credited — never more`,
    cycles: q.cycles === null ? `rolls every ${q.cycleDays}d until cancelled` : `${q.cycles} × ${q.cycleDays}d (up to ${q.maxDurationDays} days)`,
    "cancel settles": `at the end of the running cycle (up to ${q.cancelSettlesWithinDays}d)`,
    premium: "set by the venue each cycle (not quoted here)",
  })) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log("");
}

function printPositions(account: string, rows: PrintPosition[]): void {
  if (rows.length === 0) { console.log(chalk.gray(`\n  No Print orders for ${account}.\n`)); return; }
  console.log("\n" + makeTable(["address", "game", "dir", "deposit", "lev", "strike", "premium", "liq (docs, outer)", "status", "cycle ends"],
    rows.map((p) => [p.address, p.game, p.direction, p.deposit, `${p.leverage}x`, p.strikePrice, p.premiumPaid ?? "—", p.docsLiquidationPrice ?? "—", p.status, ts(p.currentCycleEndAt ?? p.scheduledEndAt)])) + "\n");
}
