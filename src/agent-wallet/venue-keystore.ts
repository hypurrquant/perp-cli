/**
 * Generic per-venue encrypted secret store (SSOT Rule #3).
 *
 * `~/.perp/<dir>/<name>.json`, AES-256-GCM with a scrypt-derived key — the same
 * scheme as lighter-keystore.ts / OWS. Used for secrets that are not an
 * OWS-native curve key: Lighter-family L2 slot keys (`lighter-rh-agents`) and
 * Ondo HMAC API secrets (`ondo-agents`).
 *
 * No fallbacks (Rule #2): missing file / wrong passphrase / corrupt file throw.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "fs";
import { resolve } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { PerpError } from "../errors.js";
import { perpPath } from "../paths.js";

const KDF = { dklen: 32, n: 65536, p: 1, r: 8 } as const;

interface VenueKeystoreFile {
  version: 1;
  kind: "venue-secret";
  dir: string;
  name: string;
  crypto: {
    cipher: "aes-256-gcm";
    cipherparams: { iv: string };
    ciphertext: string;
    auth_tag: string;
    kdf: "scrypt";
    kdfparams: { dklen: number; n: number; p: number; r: number; salt: string };
  };
  createdAt: string;
}

function assertSafeSegment(s: string, what: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") {
    throw new PerpError("INVALID_PARAMS", `invalid keystore ${what}: "${s}"`);
  }
}

export function venueKeystoreDir(dir: string): string {
  assertSafeSegment(dir, "directory");
  return perpPath(dir);
}

export function venueKeystorePath(dir: string, name: string): string {
  assertSafeSegment(name, "name");
  return resolve(venueKeystoreDir(dir), `${name}.json`);
}

/** Encrypt `plaintext` and write it with mode 0600. Returns the absolute path. */
export function saveVenueSecret(dir: string, name: string, plaintext: string, passphrase: string): string {
  const d = venueKeystoreDir(dir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  const path = venueKeystorePath(dir, name);

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const dk = scryptSync(Buffer.from(passphrase, "utf-8"), salt, KDF.dklen, { N: KDF.n, r: KDF.r, p: KDF.p, maxmem: 128 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", dk, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf-8")), cipher.final()]);

  const file: VenueKeystoreFile = {
    version: 1,
    kind: "venue-secret",
    dir,
    name,
    crypto: {
      cipher: "aes-256-gcm",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      auth_tag: cipher.getAuthTag().toString("hex"),
      kdf: "scrypt",
      kdfparams: { dklen: KDF.dklen, n: KDF.n, p: KDF.p, r: KDF.r, salt: salt.toString("hex") },
    },
    createdAt: new Date().toISOString(),
  };
  writeKeystoreAtomic(path, JSON.stringify(file, null, 2));
  return path;
}

/**
 * Atomic keystore write: tmp file (0600, exclusive create) in the same directory, fsync,
 * then rename over the target. A crash or full disk never leaves a truncated keystore
 * where a valid one (or none) was. Throws on any failure after removing the tmp file.
 */
export function writeKeystoreAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

/** Read + decrypt a stored secret. `remediation` is surfaced on every failure. */
export function loadVenueSecret(dir: string, name: string, passphrase: string, remediation: string): string {
  const path = venueKeystorePath(dir, name);
  if (!existsSync(path)) {
    throw new PerpError("KEY_NOT_FOUND", `Keystore not found: ${path}`, { remediation });
  }
  let parsed: VenueKeystoreFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as VenueKeystoreFile;
  } catch (e) {
    throw new PerpError("SIGNATURE_FAILED", `Keystore corrupt (${path}): ${e instanceof Error ? e.message : String(e)}`, { remediation });
  }
  if (parsed.version !== 1 || parsed.crypto?.cipher !== "aes-256-gcm" || parsed.crypto?.kdf !== "scrypt") {
    throw new PerpError("SIGNATURE_FAILED", `Keystore has unsupported version/cipher: ${path}`, { remediation });
  }
  const kp = parsed.crypto.kdfparams;
  const dk = scryptSync(Buffer.from(passphrase, "utf-8"), Buffer.from(kp.salt, "hex"), kp.dklen, { N: kp.n, r: kp.r, p: kp.p, maxmem: 128 * 1024 * 1024 });
  try {
    const decipher = createDecipheriv("aes-256-gcm", dk, Buffer.from(parsed.crypto.cipherparams.iv, "hex"));
    decipher.setAuthTag(Buffer.from(parsed.crypto.auth_tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.crypto.ciphertext, "hex")), decipher.final()]).toString("utf-8");
  } catch (e) {
    throw new PerpError("SIGNATURE_FAILED", `Keystore decrypt failed (${path}): ${e instanceof Error ? e.message : String(e)}`, { remediation });
  }
}

/** Idempotent delete. Returns true if a file was removed. */
export function deleteVenueSecret(dir: string, name: string): boolean {
  const path = venueKeystorePath(dir, name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
