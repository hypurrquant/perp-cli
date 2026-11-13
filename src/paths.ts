/**
 * The one place perp-cli resolves the user's home directory (~/.perp state, ~/.ows binary).
 *
 * Every path is computed at call time from the environment: HOME on every platform, and
 * USERPROFILE on Windows when HOME is not set (what os.homedir() reads there). No home → a typed
 * error (SSOT Rule #2). The old `resolve(process.env.HOME || "~", ".perp")` silently wrote
 * settings, nonces, execution logs and the bot quarantine under `./~/.perp` in the CWD when HOME
 * was unset (cron, systemd units, some containers) — path.resolve does not expand "~".
 *
 * os.homedir() is deliberately not used: on POSIX with HOME unset it falls back to the passwd
 * entry, so a process (or a test) that cleared HOME would silently reach the real home's
 * nonce/quarantine/keystore files.
 */
import { isAbsolute, join } from "node:path";
import { PerpError } from "./errors.js";

export function homeDir(): string {
  const home = process.env.HOME || (process.platform === "win32" ? process.env.USERPROFILE : undefined);
  if (!home || !isAbsolute(home)) {
    const what = home ? `HOME is not an absolute path ("${home}")` : "HOME is not set";
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
