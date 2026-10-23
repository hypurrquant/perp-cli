/**
 * `perp options` — read-only options market data (`-e derive`).
 *
 * Public, keyless reads through the options venue registry (src/exchanges/options-venues.ts);
 * no orders, no account. JSON shapes: src/exchanges/options-interface.ts (`schema: 1`).
 * The venue is the root `-e`; a perp venue there (or no `-e`) is CAPABILITY_UNSUPPORTED.
 */

import { Command } from "commander";
import chalk from "chalk";
import { networkOf } from "../cli-flags.js";
import { PerpError } from "../errors.js";
import { getOptionsVenue, listOptionsVenueIds } from "../exchanges/options-venues.js";
import type { OptionChain, OptionQuote, OptionsVenue } from "../exchanges/options-interface.js";
import { makeTable, printJson, jsonOk } from "../utils.js";

export function registerOptionsCommands(program: Command, isJson: () => boolean) {
  const options = program
    .command("options")
    .description(`Options market data, read-only (-e ${listOptionsVenueIds().join(" | -e ")}): expiries, chain, greeks, IV`);

  async function venue(): Promise<OptionsVenue> {
    if (program.getOptionValueSource("exchange") !== "cli") {
      throw new PerpError("CAPABILITY_UNSUPPORTED", "perp options needs an options venue in -e", {
        remediation: `Use -e ${listOptionsVenueIds()[0]} (e.g. perp -e ${listOptionsVenueIds()[0]} options expiries ETH)`,
      });
    }
    return getOptionsVenue(String(program.opts().exchange), networkOf(program));
  }

  // ── options underlyings ──────────────────────────────────────────────────
  options
    .command("underlyings")
    .description("List underlyings that have options on the venue")
    .action(async () => {
      const data = await (await venue()).listUnderlyings();
      if (isJson()) return printJson(jsonOk(data));
      const rows = data.underlyings.map(u => [chalk.white.bold(u.underlying), u.spotPrice === null ? chalk.gray("—") : fmtPx(u.spotPrice)]);
      console.log(`\n  ${chalk.white.bold(`${data.venue} options underlyings`)}\n` + makeTable(["underlying", "spot"], rows) + "\n");
    });

  // ── options expiries <underlying> ────────────────────────────────────────
  options
    .command("expiries <underlying>")
    .description("List active option expiries of an underlying (e.g. ETH)")
    .action(async (underlying: string) => {
      const data = await (await venue()).listExpiries(underlying);
      if (isJson()) return printJson(jsonOk(data));
      const rows = data.expiries.map(e => [
        chalk.white.bold(e.expiry),
        new Date(e.expiryMs).toISOString().slice(11, 16) + " UTC",
        String(e.strikes),
        String(e.instruments),
      ]);
      console.log(`\n  ${chalk.white.bold(`${data.underlying} options (${data.venue})`)}\n` + makeTable(["expiry", "time", "strikes", "instruments"], rows) + "\n");
    });

  // ── options chain <underlying> ───────────────────────────────────────────
  options
    .command("chain <underlying>")
    .description("Option chain for one expiry: calls / puts per strike with bid / ask, mark, IV, greeks, OI")
    .option("--expiry <date>", "Expiry (YYYY-MM-DD, UTC); default: the nearest active expiry")
    .option("--strikes <n>", "Only the N strikes closest to the ATM reference (forward, else index)")
    .action(async (underlying: string, opts: { expiry?: string; strikes?: string }) => {
      const strikes = opts.strikes === undefined ? null : parseStrikes(opts.strikes);
      const chain = await (await venue()).getChain({ underlying, expiry: opts.expiry ?? null, strikesAroundAtm: strikes });
      if (isJson()) return printJson(jsonOk(chain));
      printChain(chain);
    });

  // ── options quote <instrument> ───────────────────────────────────────────
  options
    .command("quote <instrument>")
    .description("One option: bid / ask (price + size), mark, IV, greeks, forward, index, OI, 24h volume (e.g. ETH-20261225-3500-P)")
    .action(async (instrument: string) => {
      const q = await (await venue()).getQuote(instrument);
      if (isJson()) return printJson(jsonOk(q));
      printQuote(q);
    });
}

function parseStrikes(raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1) {
    throw new PerpError("INVALID_PARAMS", `--strikes must be a positive integer (got "${raw}")`, {
      remediation: "Pass a positive integer, e.g. --strikes 10",
    });
  }
  return n;
}

// ── human output ──

const dash = chalk.gray("—");

function fmtPx(v: string | null): string {
  return v === null ? dash : String(Number(Number(v).toPrecision(8)));
}

function fmtPct(v: string | null): string {
  return v === null ? dash : `${(Number(v) * 100).toFixed(1)}%`;
}

/**
 * Greeks by significant figures (3), not fixed decimals: toFixed(3) printed theta / vega of cheap
 * options as -0.000. Derive publishes greeks at a 1e-5 resolution, so "0" can mean |x| < 0.00001.
 */
export function fmtGreek(v: string | null | undefined): string {
  if (v === null || v === undefined) return dash;
  const n = Number(v);
  if (!Number.isFinite(n)) return dash;
  if (n === 0) return "0";
  // Fixed notation, 3 significant figures (String() switches to 1.23e-7 below 1e-6).
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(n))));
  return n.toFixed(Math.min(decimals, 20)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function sideCells(q: OptionQuote | null): string[] {
  if (q === null) return [dash, dash, dash, dash, dash];
  return [
    q.bid === null ? dash : fmtPx(q.bid.price),
    q.ask === null ? dash : fmtPx(q.ask.price),
    fmtPx(q.mark),
    fmtPct(q.iv.mark),
    fmtGreek(q.greeks?.delta),
  ];
}

function printChain(c: OptionChain): void {
  const ref = c.atm === null ? "ATM unknown" : `ATM ${c.atm.strike} (${c.atm.reference} ${fmtPx(c.atm.price)})`;
  console.log(chalk.white.bold(`\n  ${c.underlying} options — ${c.expiry} (${c.venue})`));
  console.log(chalk.gray(`  index ${fmtPx(c.index)} · forward ${fmtPx(c.forward)} · ${ref} · ${c.rows.length}/${c.strikesListed} strikes\n`));
  const rows = c.rows.map(r => {
    const strike = c.atm !== null && r.strike === c.atm.strike ? chalk.yellow.bold(r.strike) : chalk.white.bold(r.strike);
    return [...sideCells(r.call), strike, ...sideCells(r.put).reverse()];
  });
  console.log(makeTable(["C bid", "C ask", "C mark", "C IV", "C Δ", "strike", "P Δ", "P IV", "P mark", "P ask", "P bid"], rows));
  if (c.missingTickers.length > 0) console.log(chalk.yellow(`  no ticker: ${c.missingTickers.join(", ")}`));
  console.log("");
}

function printQuote(q: OptionQuote): void {
  const side = (s: OptionQuote["bid"]) => (s === null ? dash : `${fmtPx(s.price)} × ${s.size}`);
  console.log(chalk.white.bold(`\n  ${q.instrument}`) + chalk.gray(`  (${q.venue} · ${q.kind} · strike ${q.strike} · expiry ${new Date(q.expiryMs).toISOString().replace("T", " ").slice(0, 16)} UTC)`));
  const rows: string[][] = [
    ["bid", side(q.bid), "IV", fmtPct(q.iv.bid)],
    ["ask", side(q.ask), "IV", fmtPct(q.iv.ask)],
    ["mark", fmtPx(q.mark), "IV", fmtPct(q.iv.mark)],
    ["index", fmtPx(q.index), "forward", fmtPx(q.forward)],
    ["delta", fmtGreek(q.greeks?.delta), "gamma", q.greeks === null ? dash : q.greeks.gamma],
    ["theta", fmtGreek(q.greeks?.theta), "vega", fmtGreek(q.greeks?.vega)],
    ["rho", fmtGreek(q.greeks?.rho), "OI", q.openInterest],
    ["24h contracts", q.stats24h.contracts, "24h trades", String(q.stats24h.trades)],
  ];
  console.log(makeTable(["field", "value", "field", "value"], rows));
  if (q.venue === "derive") console.log(chalk.gray("  Greeks: 3 significant figures; Derive publishes them at a 1e-5 resolution (0 = |value| < 0.00001).\n"));
  else console.log();
}
