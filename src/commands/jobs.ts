import { Command } from "commander";
import { listJobs, stopJob, removeJob, loadJob, logFile, startJob } from "../jobs.js";
import { printJson, jsonOk } from "../utils.js";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export function registerJobsCommands(
  program: Command,
  isJson: () => boolean
) {
  const jobs = program.command("jobs").description("Background job management (tmux)");

  jobs
    .command("list", { isDefault: true })
    .description("List all jobs")
    .action(() => {
      const all = listJobs();
      if (isJson()) return printJson(jsonOk(all));

      if (all.length === 0) {
        console.log(chalk.gray("\n  No jobs.\n"));
        return;
      }

      console.log(chalk.cyan.bold("\n  Background Jobs\n"));
      for (const j of all) {
        const statusColor = j.status === "running" ? chalk.green : j.status === "error" ? chalk.red : chalk.gray;
        const elapsed = j.status === "running"
          ? ` (${formatElapsed(Date.now() - new Date(j.startedAt).getTime())})`
          : "";

        console.log(
          `  ${chalk.white.bold(j.id)}  ${statusColor(j.status.padEnd(8))} ` +
          `${chalk.cyan(j.strategy.padEnd(14))} ` +
          `${chalk.gray(j.exchange.padEnd(12))} ` +
          `${chalk.gray(new Date(j.startedAt).toLocaleString())}${elapsed}`
        );

        // Show result summary if available
        if (j.result) {
          const r = j.result;
          if (r.pctComplete !== undefined) {
            console.log(chalk.gray(`         Progress: ${r.pctComplete}% | Filled: ${r.filled}/${(Number(r.filled) + Number(r.remaining)).toFixed(4)}`));
          } else if (r.activePositions !== undefined) {
            console.log(chalk.gray(`         Positions: ${r.activePositions} | Cycle: ${r.cycle}`));
          }
        }
      }
      console.log();
    });

  jobs
    .command("stop <id>")
    .description("Stop a running job")
    .action((id: string) => {
      const job = loadJob(id);
      if (!job) {
        console.log(chalk.red(`\n  Job ${id} not found.\n`));
        return;
      }

      stopJob(id);
      if (isJson()) return printJson(jsonOk({ id, status: "stopped" }));
      console.log(chalk.green(`\n  Job ${id} stopped.\n`));
    });

  jobs
    .command("logs <id>")
    .description("Show logs for a job")
    .option("-f, --follow", "Follow log output (tail -f)")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .action((id: string, opts: { follow?: boolean; lines: string }) => {
      const log = logFile(id);
      if (!existsSync(log)) {
        console.log(chalk.gray(`\n  No logs for job ${id}.\n`));
        return;
      }

      if (opts.follow) {
        // Attach to tmux session if running, otherwise tail -f
        const job = loadJob(id);
        if (job?.status === "running") {
          try {
            execSync(`tmux attach-session -t ${job.tmuxSession}`, { stdio: "inherit" });
            return;
          } catch { /* fall through to tail */ }
        }
        try {
          execSync(`tail -f ${log}`, { stdio: "inherit" });
        } catch { /* ctrl-c */ }
      } else {
        const content = readFileSync(log, "utf-8");
        const lines = content.split("\n");
        const n = parseInt(opts.lines);
        const show = lines.slice(-n).join("\n");
        console.log(show);
      }
    });

  jobs
    .command("remove <id>")
    .description("Remove a job entry and its logs")
    .action((id: string) => {
      const job = loadJob(id);
      if (!job) {
        console.log(chalk.red(`\n  Job ${id} not found.\n`));
        return;
      }
      if (job.status === "running") {
        stopJob(id);
      }
      removeJob(id);
      if (isJson()) return printJson(jsonOk({ id, removed: true }));
      console.log(chalk.green(`\n  Job ${id} removed.\n`));
    });

  jobs
    .command("clean")
    .description("Remove all stopped/done jobs")
    .action(() => {
      const all = listJobs();
      let removed = 0;
      for (const j of all) {
        if (j.status !== "running") {
          removeJob(j.id);
          removed++;
        }
      }
      if (isJson()) return printJson(jsonOk({ removed }));
      console.log(chalk.green(`\n  Removed ${removed} finished jobs.\n`));
    });
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
