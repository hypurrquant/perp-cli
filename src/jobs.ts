import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const JOBS_DIR = join(homedir(), ".perp", "jobs");
const LOGS_DIR = join(homedir(), ".perp", "logs");

export interface JobEntry {
  id: string;
  strategy: string;
  exchange: string;
  params: Record<string, unknown>;
  tmuxSession: string;
  pid?: number;
  startedAt: string;
  status: "running" | "stopped" | "done" | "error";
  result?: Record<string, unknown>;
}

function ensureDirs() {
  mkdirSync(JOBS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

function jobFile(id: string) {
  return join(JOBS_DIR, `${id}.json`);
}

export function logFile(id: string) {
  return join(LOGS_DIR, `${id}.log`);
}

function genId(): string {
  return randomBytes(4).toString("hex");
}

function hasTmux(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name} 2>/dev/null`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function saveJob(job: JobEntry): void {
  ensureDirs();
  writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(id: string): JobEntry | null {
  const path = jobFile(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function listJobs(): JobEntry[] {
  ensureDirs();
  const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const job = JSON.parse(readFileSync(join(JOBS_DIR, f), "utf-8")) as JobEntry;
    // Check if tmux session is still alive
    if (job.status === "running" && !tmuxSessionExists(job.tmuxSession)) {
      job.status = "done";
      saveJob(job);
    }
    return job;
  });
}

import { readdirSync } from "node:fs";

/**
 * Start a job in a tmux background session.
 * Returns the job entry.
 */
export function startJob(opts: {
  strategy: string;
  exchange: string;
  params: Record<string, unknown>;
  cliArgs: string[];
}): JobEntry {
  if (!hasTmux()) {
    throw new Error("tmux is required for background jobs. Install with: brew install tmux");
  }

  ensureDirs();
  const id = genId();
  const session = `perp-${id}`;
  const log = logFile(id);

  // Build the command — re-invoke ourselves with `run` subcommand
  const nodeCmd = process.argv[0];
  const cliPath = process.argv[1];
  const envVars = buildEnvString();
  const args = opts.cliArgs.join(" ");
  const cmd = `${envVars} ${nodeCmd} ${cliPath} run ${opts.strategy} ${args} --job-id ${id} 2>&1 | tee -a ${log}`;

  // Create tmux session
  execSync(`tmux new-session -d -s ${session} '${cmd.replace(/'/g, "'\\''")}'`);

  const job: JobEntry = {
    id,
    strategy: opts.strategy,
    exchange: opts.exchange,
    params: opts.params,
    tmuxSession: session,
    startedAt: new Date().toISOString(),
    status: "running",
  };

  saveJob(job);
  return job;
}

/**
 * Stop a running job.
 */
export function stopJob(id: string): boolean {
  const job = loadJob(id);
  if (!job) return false;

  if (tmuxSessionExists(job.tmuxSession)) {
    try {
      execSync(`tmux kill-session -t ${job.tmuxSession}`);
    } catch { /* already dead */ }
  }

  job.status = "stopped";
  saveJob(job);
  return true;
}

/**
 * Update job state file (called from within the running job).
 */
export function updateJobState(id: string, data: Partial<JobEntry>): void {
  const job = loadJob(id);
  if (!job) return;
  Object.assign(job, data);
  saveJob(job);
}

/**
 * Remove a job entry.
 */
export function removeJob(id: string): boolean {
  const path = jobFile(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  // Also remove log
  const log = logFile(id);
  if (existsSync(log)) unlinkSync(log);
  return true;
}

/**
 * Build env string to pass through to tmux session.
 */
function buildEnvString(): string {
  const keys = [
    "LIGHTER_PRIVATE_KEY", "LIGHTER_API_KEY", "LIGHTER_ACCOUNT_INDEX", "LIGHTER_API_KEY_INDEX",
    "PRIVATE_KEY", "pk",
    "PACIFICA_BUILDER_CODE", "NEXT_PUBLIC_BUILDER_CODE",
    "HL_REFERRAL_CODE", "LIGHTER_REFERRAL_CODE",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    if (process.env[k]) parts.push(`${k}='${process.env[k]}'`);
  }
  return parts.join(" ");
}
