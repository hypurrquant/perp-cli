import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { printJson, jsonOk, makeTable, formatUsd, withJsonErrors } from "../utils.js";

export function registerDexCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
) {
  const dex = program.command("dex").description("HIP-3 deployed perp dex commands (Hyperliquid)");

  // ── dex list ──
  dex
    .command("list")
    .description("List all available HIP-3 deployed perp dexes")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (!(adapter instanceof HyperliquidAdapter)) {
          console.error(chalk.red("\n  HIP-3 dexes are only available on Hyperliquid. Use -e hyperliquid.\n"));
          return;
        }

        const dexes = await adapter.listDeployedDexes();

        if (isJson()) return printJson(jsonOk(dexes));

        if (dexes.length === 0) {
          console.log(chalk.gray("\n  No deployed dexes found.\n"));
          return;
        }

        console.log(chalk.cyan.bold("\n  HIP-3 Deployed Perp DEXes\n"));
        const rows = dexes.map(d => [
          chalk.white.bold(d.name),
          chalk.gray(d.deployer.slice(0, 10) + "..."),
          String(d.assets.length),
          d.assets.slice(0, 5).join(", ") + (d.assets.length > 5 ? ` +${d.assets.length - 5}` : ""),
        ]);
        console.log(makeTable(["DEX", "Deployer", "Assets", "Markets"], rows));
        console.log(chalk.gray(`\n  Use --dex <name> to trade on a deployed dex.\n`));
        console.log(chalk.gray(`  Example: perp -e hyperliquid --dex xyz market list\n`));
      });
    });

  // ── dex markets <dex-name> ──
  dex
    .command("markets <dexName>")
    .description("List all markets on a specific HIP-3 dex")
    .action(async (dexName: string) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (!(adapter instanceof HyperliquidAdapter)) {
          console.error(chalk.red("\n  HIP-3 dexes are only available on Hyperliquid. Use -e hyperliquid.\n"));
          return;
        }

        // Temporarily switch dex, fetch markets, then restore
        const prevDex = adapter.dex;
        adapter.setDex(dexName);

        try {
          const markets = await adapter.getMarkets();

          if (isJson()) return printJson(jsonOk({ dex: dexName, markets }));

          if (markets.length === 0) {
            console.log(chalk.gray(`\n  No markets found on dex "${dexName}".\n`));
            return;
          }

          console.log(chalk.cyan.bold(`\n  ${dexName.toUpperCase()} DEX Markets\n`));
          const rows = markets.map(m => [
            chalk.white.bold(m.symbol),
            `$${formatUsd(m.markPrice)}`,
            m.fundingRate !== "0" ? `${(Number(m.fundingRate) * 100).toFixed(4)}%` : chalk.gray("-"),
            `$${formatUsd(m.volume24h)}`,
            `$${formatUsd(m.openInterest)}`,
            `${m.maxLeverage}x`,
          ]);
          console.log(makeTable(["Symbol", "Mark Price", "Funding", "24h Volume", "OI", "Max Lev"], rows));
          console.log(chalk.gray(`\n  Trade: perp -e hyperliquid --dex ${dexName} trade market <symbol> <side> <size>\n`));
        } finally {
          adapter.setDex(prevDex);
        }
      });
    });

  // ── dex balance <dex-name> ──
  dex
    .command("balance <dexName>")
    .description("Show balance on a specific HIP-3 dex")
    .action(async (dexName: string) => {
      await withJsonErrors(isJson(), async () => {
        const adapter = await getAdapter();
        if (!(adapter instanceof HyperliquidAdapter)) {
          console.error(chalk.red("\n  HIP-3 dexes are only available on Hyperliquid. Use -e hyperliquid.\n"));
          return;
        }

        const prevDex = adapter.dex;
        adapter.setDex(dexName);

        try {
          const [balance, positions] = await Promise.all([
            adapter.getBalance(),
            adapter.getPositions(),
          ]);

          if (isJson()) return printJson(jsonOk({ dex: dexName, balance, positions }));

          console.log(chalk.cyan.bold(`\n  ${dexName.toUpperCase()} DEX Balance\n`));
          console.log(`  Equity:      $${formatUsd(balance.equity)}`);
          console.log(`  Available:   $${formatUsd(balance.available)}`);
          console.log(`  Margin Used: $${formatUsd(balance.marginUsed)}`);
          console.log(`  uPnL:        $${formatUsd(balance.unrealizedPnl)}`);

          if (positions.length > 0) {
            console.log(chalk.white.bold("\n  Positions:"));
            for (const p of positions) {
              const color = p.side === "long" ? chalk.green : chalk.red;
              console.log(`    ${color(p.side.toUpperCase().padEnd(5))} ${chalk.white(p.symbol.padEnd(16))} ${p.size.padEnd(10)} entry: $${Number(p.entryPrice).toFixed(2)}  pnl: $${Number(p.unrealizedPnl).toFixed(2)}`);
            }
          }
          console.log();
        } finally {
          adapter.setDex(prevDex);
        }
      });
    });
}
