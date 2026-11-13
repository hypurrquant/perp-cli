/**
 * The one place perp-cli resolves the user's home directory (~/.perp state, ~/.ows binary).
 *
 * Every path is computed at call time from the environment: HOME on every platform, and
 * USERPROFILE on Windows when HOME is not set. No home → a typed error (SSOT Rule #2). The old
 * `resolve(process.env.HOME || "~", ".perp")` silently wrote settings, nonces, execution logs
 * and the bot quarantine under `./~/.perp` in the CWD when HOME was unset (cron, systemd units,
 * some containers) — path.resolve does not expand "~". See assertNoLegacyCwdPerpDir().
 *
 * os.homedir() is deliberately not used: on POSIX with HOME unset it falls back to the passwd
 * entry, so a process (or a test) that cleared HOME would silently reach the real home's
 * nonce/quarantine/keystore files.
 *
 * Windows order (HOME first, then USERPROFILE): the funds-guarding state (settings, quarantine,
 * nonces, keystores, .env) was always read from HOME, so a shell that sets HOME (MSYS / Git
 * Bash) keeps finding it. os.homedir() reads USERPROFILE first; only the non-critical files of
 * its former callers (equity / funding history, jobs, bot logs, trade journal) move when such a
 * shell's HOME differs from USERPROFILE. Native shells do not set HOME → USERPROFILE, as before.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PerpError } from "./errors.js";

/** The usable home directory, or null when HOME (USERPROFILE on Windows) is unset or relative. */
export function homeDirOrNull(): string | null {
  const home = process.env.HOME || (process.platform === "win32" ? process.env.USERPROFILE : undefined);
  return home && isAbsolute(home) ? home : null;
}

export function homeDir(): string {
  const home = homeDirOrNull();
  if (home === null) {
    const raw = process.env.HOME;
    const what = raw ? `HOME is not an absolute path ("${raw}")` : "HOME is not set";
    throw new PerpError("INVALID_PARAMS", `${what}; cannot locate ~/.perp (settings, nonces, quarantine, keystores)`, {
      remediation: "Set HOME to your home directory (absolute path) in the environment that runs perp — e.g. Environment=HOME=/home/<user> in a systemd unit, or HOME=/home/<user> at the top of a crontab",
    });
  }
  return home;
}

/** ~/.perp */
export function perpDir(): string {
  return join(homeDir(), ".perp");
}

/** ~/.perp/<segments...> */
export function perpPath(...segments: string[]): string {
  return join(perpDir(), ...segments);
}

/** ~/.ows/<segments...> (OWS CLI install location) */
export function owsPath(...segments: string[]): string {
  return join(homeDir(), ".ows", ...segments);
}

/**
 * Refuse while `<cwd>/~/.perp` exists: where earlier perp-cli versions kept their state when they ran
 * without HOME. That state (quarantined symbols, nonces, Lighter keystores, settings) is never
 * read from ~/.perp, so continuing would silently un-quarantine symbols and restart nonces.
 * Nothing is moved automatically (Rule #2). Called once at process startup (CLI, MCP server),
 * before any command runs — never on an order path. Only the CWD can be checked.
 */
export function assertNoLegacyCwdPerpDir(): void {
  const legacy = resolve("~", ".perp");
  const current = perpDir();
  if (legacy === current || !existsSync(legacy)) return;
  throw new PerpError("INVALID_PARAMS", `Found perp-cli state at ${legacy} (written by an earlier version that ran without HOME); it is not read from ${current}`, {
    remediation: `Move or merge ${legacy} into ${current} (merge bot-quarantine.json entries, keep the higher nonces in aster-nonces.json / risex-nonce/, move lighter-agents/ keystores), then remove or rename ${legacy} (e.g. to ${legacy}.migrated) and retry`,
  });
}
