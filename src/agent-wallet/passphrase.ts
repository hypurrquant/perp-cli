import { PerpError } from "../errors.js";

const REMEDIATION =
  "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe (echo $PP | perp ...)";

/**
 * Resolve master passphrase from (in precedence order):
 *   1. opts.flag  (--passphrase)
 *   2. process.env.OWS_PASSPHRASE
 *   3. stdin (only if process.stdin.isTTY === false)
 *
 * Returns null if no path provides one AND stdin IS TTY (caller may prompt).
 * Throws PASSPHRASE_REQUIRED with remediation if no path provides one AND
 * stdin is non-TTY (AC-16).
 */
export async function resolvePassphrase(opts: { flag?: string }): Promise<string | null> {
  // 1. CLI flag (allow empty string when explicitly passed via --passphrase '')
  if (opts.flag !== undefined) {
    return opts.flag;
  }

  // 2. Environment variable (allow empty string when explicitly set; treat
  // unset as absent)
  if ("OWS_PASSPHRASE" in process.env) {
    return process.env["OWS_PASSPHRASE"] ?? "";
  }

  // 3. stdin pipe — only when stdin is not a TTY
  if (process.stdin.isTTY === false) {
    const piped = await readStdin();
    if (piped !== null) {
      return piped;
    }
    // stdin was non-TTY but empty — throw rather than falling through to prompt
    throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
      remediation: REMEDIATION,
    });
  }

  // stdin IS TTY — caller decides whether to prompt interactively
  return null;
}

/**
 * Read all bytes from stdin until EOF, trim trailing newlines.
 * Returns null if stdin produced zero bytes.
 */
async function readStdin(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    });
    process.stdin.on("end", () => {
      const raw = chunks.join("").replace(/\r?\n$/, "");
      resolve(raw.length > 0 ? raw : null);
    });
    process.stdin.on("error", reject);
  });
}
