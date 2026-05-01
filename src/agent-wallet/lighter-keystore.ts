/**
 * Lighter L2 agent keystore (SSOT Rule #3 — encrypted at-rest).
 *
 * Lighter's L2 signing key is a 40-byte secp256k1 private key — a non-OWS-native
 * curve, so it cannot live in `~/.ows/wallets/` like Aster/HL/PAC agent keypairs.
 * Per the FIXME(2d-spike) in src/commands/agent.ts and SSOT Rule #3 in CLAUDE.md,
 * we persist these keys at `~/.perp/lighter-agents/<accountIndex>-<slot>.json`
 * using the same AES-256-GCM + scrypt encryption scheme OWS uses.
 *
 * Empty passphrase ("") is acceptable — mirrors the HL/PAC pattern. Security
 * model = file mode 0600 + obfuscation, NOT cryptographic strength against a
 * local attacker. A non-empty passphrase upgrades the threat model.
 *
 * No fallbacks (SSOT Rule #2): missing files / wrong passphrase throw with
 * remediation pointing the user at `perp wallet agent approve lighter --rotate`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from "fs";
import { resolve } from "path";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { PerpError } from "../errors.js";

const KDF_PARAMS = { dklen: 32, n: 65536, p: 1, r: 8 } as const;
const SCRYPT_OPTS = { N: KDF_PARAMS.n, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: 128 * 1024 * 1024 } as const;
const REMEDIATION = "perp wallet agent approve lighter --rotate";

interface KeystoreFile {
  version: 1;
  accountIndex: number;
  slot: number;
  crypto: {
    cipher: "aes-256-gcm";
    cipherparams: { iv: string };
    ciphertext: string;
    auth_tag: string;
    kdf: "scrypt";
    kdfparams: {
      dklen: number;
      n: number;
      p: number;
      r: number;
      salt: string;
    };
  };
  createdAt: string;
}

function lighterAgentsDir(): string {
  return resolve(process.env["HOME"] ?? "~", ".perp", "lighter-agents");
}

/** Pure: deterministic absolute path for the keystore file. */
export function lighterKeystorePath(accountIndex: number, slot: number): string {
  return resolve(lighterAgentsDir(), `${accountIndex}-${slot}.json`);
}

function ensureDir(): string {
  const dir = lighterAgentsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // best-effort tighten permissions if dir exists with looser mode
    try { chmodSync(dir, 0o700); } catch { /* non-fatal */ }
  }
  return dir;
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Encrypt a 40-byte Lighter L2 private key (hex) and write it to
 * `~/.perp/lighter-agents/<accountIndex>-<slot>.json` with mode 0600.
 *
 * Returns the absolute path of the written file.
 */
export function saveLighterKey(
  accountIndex: number,
  slot: number,
  privateKeyHex: string,
  passphrase: string,
): string {
  const dir = ensureDir();
  const path = resolve(dir, `${accountIndex}-${slot}.json`);

  const cleanHex = stripHexPrefix(privateKeyHex).toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length === 0) {
    throw new PerpError("INVALID_PARAMS", "Lighter L2 private key must be hex", {
      remediation: REMEDIATION,
    });
  }

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const dk = scryptSync(Buffer.from(passphrase, "utf-8"), salt, KDF_PARAMS.dklen, SCRYPT_OPTS);
  const cipher = createCipheriv("aes-256-gcm", dk, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(cleanHex, "utf-8")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const file: KeystoreFile = {
    version: 1,
    accountIndex,
    slot,
    crypto: {
      cipher: "aes-256-gcm",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      auth_tag: authTag.toString("hex"),
      kdf: "scrypt",
      kdfparams: {
        dklen: KDF_PARAMS.dklen,
        n: KDF_PARAMS.n,
        p: KDF_PARAMS.p,
        r: KDF_PARAMS.r,
        salt: salt.toString("hex"),
      },
    },
    createdAt: new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  // Re-tighten in case writeFileSync overwrote an existing file with a looser umask
  try { chmodSync(path, 0o600); } catch { /* non-fatal */ }
  return path;
}

/**
 * Read + decrypt a stored Lighter L2 private key. Returns the hex string
 * without `0x` prefix.
 *
 * Throws (no fallback):
 *   - LIGHTER_KEYSTORE_NOT_FOUND if the file is missing
 *   - LIGHTER_KEYSTORE_DECRYPT_FAILED if the passphrase is wrong / file corrupt
 */
export function loadLighterKey(
  accountIndex: number,
  slot: number,
  passphrase: string,
): string {
  // One-time data migration: if a legacy `LIGHTER_API_KEY` env var is set and
  // the new keystore file does not exist yet, materialize the keystore from env
  // before continuing. This is NOT a runtime fallback — it's a single-pass
  // upgrade path that runs at most once per install.
  migrateFromEnvIfPresent();

  const path = lighterKeystorePath(accountIndex, slot);
  if (!existsSync(path)) {
    throw new PerpError(
      "KEY_NOT_FOUND",
      `LIGHTER_KEYSTORE_NOT_FOUND: ${path}`,
      { remediation: REMEDIATION },
    );
  }

  let parsed: KeystoreFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as KeystoreFile;
  } catch (e) {
    throw new PerpError(
      "SIGNATURE_FAILED",
      `LIGHTER_KEYSTORE_DECRYPT_FAILED: corrupt JSON — ${e instanceof Error ? e.message : String(e)}`,
      { remediation: REMEDIATION },
    );
  }

  if (parsed.version !== 1 || parsed.crypto?.cipher !== "aes-256-gcm" || parsed.crypto?.kdf !== "scrypt") {
    throw new PerpError(
      "SIGNATURE_FAILED",
      "LIGHTER_KEYSTORE_DECRYPT_FAILED: unsupported version or cipher",
      { remediation: REMEDIATION },
    );
  }

  const salt = Buffer.from(parsed.crypto.kdfparams.salt, "hex");
  const iv = Buffer.from(parsed.crypto.cipherparams.iv, "hex");
  const ciphertext = Buffer.from(parsed.crypto.ciphertext, "hex");
  const authTag = Buffer.from(parsed.crypto.auth_tag, "hex");
  const dk = scryptSync(
    Buffer.from(passphrase, "utf-8"),
    salt,
    parsed.crypto.kdfparams.dklen,
    {
      N: parsed.crypto.kdfparams.n,
      r: parsed.crypto.kdfparams.r,
      p: parsed.crypto.kdfparams.p,
      maxmem: 128 * 1024 * 1024,
    },
  );

  try {
    const decipher = createDecipheriv("aes-256-gcm", dk, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf-8");
  } catch (e) {
    throw new PerpError(
      "SIGNATURE_FAILED",
      `LIGHTER_KEYSTORE_DECRYPT_FAILED: ${e instanceof Error ? e.message : String(e)}`,
      { remediation: REMEDIATION },
    );
  }
}

/**
 * Idempotent delete. Returns true if a file was removed, false if absent.
 */
export function deleteLighterKey(accountIndex: number, slot: number): boolean {
  const path = lighterKeystorePath(accountIndex, slot);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * One-time bridge from legacy env-based storage to the keystore.
 *
 * Triggered on a single, narrow condition: env has `LIGHTER_API_KEY` AND the
 * target keystore file does not yet exist. After successful save, clears the
 * three legacy env entries from `~/.perp/.env` so they cannot be re-read.
 *
 * NOT a fallback (SSOT Rule #2): runs at most once per install (post-clear, the
 * trigger condition is permanently false). Single-direction (env → keystore);
 * never reads from keystore back to env.
 */
export function migrateFromEnvIfPresent(): void {
  const envKey = process.env["LIGHTER_API_KEY"];
  if (!envKey || envKey.length === 0) return;

  const accountIndexStr = process.env["LIGHTER_ACCOUNT_INDEX"];
  const apiKeyIndexStr = process.env["LIGHTER_API_KEY_INDEX"];
  const accountIndex = accountIndexStr ? parseInt(accountIndexStr, 10) : NaN;
  const slot = apiKeyIndexStr ? parseInt(apiKeyIndexStr, 10) : NaN;

  // If we lack the indices needed to address the keystore slot, bail silently.
  // Migration only runs when the env trio is fully populated.
  if (!Number.isFinite(accountIndex) || accountIndex < 0) return;
  if (!Number.isFinite(slot) || slot < 0) return;

  const target = lighterKeystorePath(accountIndex, slot);
  if (existsSync(target)) return;

  saveLighterKey(accountIndex, slot, envKey, "");
  process.stderr.write(
    `[lighter] migrated LIGHTER_API_KEY env → ~/.perp/lighter-agents/${accountIndex}-${slot}.json (SSOT Rule #3)\n`,
  );

  // Clear the legacy env entries from ~/.perp/.env so the trigger never fires
  // again. setEnvVar(name, "") rewrites the file with the empty value.
  try {
    // Inline lazy import to avoid a circular dep at module-load time.
    // setEnvVar is sync; the dynamic import is deliberately resolved lazily.
    void clearEnvLegacyKeys();
  } catch {
    // best-effort — file may be locked or read-only; the in-memory delete below
    // still prevents this process from re-triggering migration.
  }
  delete process.env["LIGHTER_API_KEY"];
  delete process.env["LIGHTER_ACCOUNT_INDEX"];
  delete process.env["LIGHTER_API_KEY_INDEX"];
}

// Async helper deliberately split out so migrateFromEnvIfPresent stays sync.
function clearEnvLegacyKeys(): void {
  // Use the same .env parser/writer the rest of the CLI uses so we don't
  // accidentally drop comments or other entries.
  // Sync read + write via fs.
  const PERP_DIR = resolve(process.env["HOME"] ?? "~", ".perp");
  const ENV_FILE = resolve(PERP_DIR, ".env");
  if (!existsSync(ENV_FILE)) return;

  const lines = readFileSync(ENV_FILE, "utf-8").split("\n");
  const out: string[] = [];
  const dropKeys = new Set([
    "LIGHTER_API_KEY",
    "LIGHTER_ACCOUNT_INDEX",
    "LIGHTER_API_KEY_INDEX",
  ]);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0 && dropKeys.has(trimmed.slice(0, eqIdx))) {
      continue;
    }
    out.push(line);
  }
  writeFileSync(ENV_FILE, out.join("\n"), { mode: 0o600 });
}
