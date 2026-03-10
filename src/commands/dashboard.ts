import { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { startDashboard, type DashboardExchange } from "../dashboard/server.js";

export function registerDashboardCommands(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getHLAdapterForDex?: (dex: string) => Promise<ExchangeAdapter>,
) {
  program
    .command("dashboard")
    .description("Launch live web dashboard for real-time portfolio monitoring")
    .option("-p, --port <port>", "Port to serve dashboard on (auto-finds free port)", "3456")
    .option("--interval <ms>", "Poll interval in milliseconds", "5000")
    .option("--exchanges <list>", "Comma-separated exchanges to monitor", "pacifica,hyperliquid,lighter")
    .option("--dex <list>", "Comma-separated HIP-3 dexes to monitor (e.g. xyz,flx,hyna)")
    .action(async (opts) => {
      const exchangeNames = (opts.exchanges as string).split(",").map((s: string) => s.trim()).filter(Boolean);
      const dexNames = opts.dex ? (opts.dex as string).split(",").map((s: string) => s.trim()).filter(Boolean) : [];
      const port = parseInt(opts.port as string, 10);
      const interval = parseInt(opts.interval as string, 10);

      if (isJson()) {
        const { printJson, jsonOk } = await import("../utils.js");
        const exchanges: DashboardExchange[] = [];
        for (const name of exchangeNames) {
          try {
            const adapter = await getAdapterForExchange(name);
            exchanges.push({ name, adapter });
          } catch { /* skip */ }
        }
        if (getHLAdapterForDex) {
          for (const dex of dexNames) {
            try {
              const adapter = await getHLAdapterForDex(dex);
              exchanges.push({ name: `hl:${dex}`, adapter });
            } catch { /* skip */ }
          }
        }
        if (!exchanges.length) {
          const { jsonError } = await import("../utils.js");
          console.log(JSON.stringify(jsonError("NO_EXCHANGES", "No exchange adapters could be initialized. Check your keys.")));
          process.exit(1);
        }
        const dashboard = await startDashboard(exchanges, { port, pollInterval: interval });
        printJson(jsonOk({ url: `http://localhost:${dashboard.port}`, port: dashboard.port, exchanges: exchanges.map((e) => e.name) }));
        await new Promise(() => {});
        return;
      }

      console.log(chalk.cyan.bold("\n  perp-cli Live Dashboard\n"));
      console.log(chalk.gray(`  Initializing exchanges: ${exchangeNames.join(", ")}${dexNames.length ? ` + HIP-3: ${dexNames.join(", ")}` : ""}...\n`));

      const exchanges: DashboardExchange[] = [];
      for (const name of exchangeNames) {
        try {
          const adapter = await getAdapterForExchange(name);
          exchanges.push({ name, adapter });
          console.log(chalk.green(`  ✓ ${name}`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(chalk.yellow(`  ✗ ${name}: ${msg.slice(0, 80)}`));
        }
      }

      // Initialize HIP-3 dex adapters
      if (getHLAdapterForDex) {
        for (const dex of dexNames) {
          try {
            const adapter = await getHLAdapterForDex(dex);
            exchanges.push({ name: `hl:${dex}`, adapter });
            console.log(chalk.green(`  ✓ hl:${dex} (HIP-3)`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow(`  ✗ hl:${dex}: ${msg.slice(0, 80)}`));
          }
        }
      }

      if (!exchanges.length) {
        console.error(chalk.red("\n  No exchanges available. Check your private keys in .env\n"));
        process.exit(1);
      }

      console.log(chalk.gray(`\n  Starting server on port ${port}...`));

      const dashboard = await startDashboard(exchanges, { port, pollInterval: interval });

      console.log(chalk.cyan.bold(`\n  Dashboard running at: `) + chalk.white.bold(`http://localhost:${dashboard.port}`));
      console.log(chalk.gray(`  Monitoring: ${exchanges.map((e) => e.name).join(", ")}`));
      console.log(chalk.gray(`  Poll interval: ${interval}ms`));
      console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

      // Open browser automatically (best-effort)
      try {
        const { exec } = await import("child_process");
        const url = `http://localhost:${dashboard.port}`;
        if (process.platform === "darwin") exec(`open ${url}`);
        else if (process.platform === "linux") exec(`xdg-open ${url}`);
      } catch {
        // ignore — user can open manually
      }

      // Keep process running
      const ac = new AbortController();
      process.on("SIGINT", () => {
        console.log(chalk.gray("\n  Shutting down dashboard..."));
        dashboard.close();
        ac.abort();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        dashboard.close();
        ac.abort();
        process.exit(0);
      });

      await new Promise(() => {});
    });
}
