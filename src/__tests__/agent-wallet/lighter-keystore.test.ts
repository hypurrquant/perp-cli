import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import os from "os";

// Use a temp HOME so tests never touch the real ~/.perp.
const TEST_HOME = resolve(os.tmpdir(), `perp-lighter-keystore-test-${process.pid}`);

vi.stubEnv("HOME", TEST_HOME);

const {
  saveLighterKey,
  loadLighterKey,
  deleteLighterKey,
  lighterKeystorePath,
  migrateFromEnvIfPresent,
} = await import("../../agent-wallet/lighter-keystore.js");

const ACCOUNT_INDEX = 42;
const SLOT = 5;
// 40-byte (80 hex chars) fake L2 key.
const FAKE_KEY_HEX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

beforeEach(() => {
  // Stub HOME again per-test in case other tests changed it.
  vi.stubEnv("HOME", TEST_HOME);
  delete process.env.LIGHTER_API_KEY;
  delete process.env.LIGHTER_ACCOUNT_INDEX;
  delete process.env.LIGHTER_API_KEY_INDEX;
  mkdirSync(resolve(TEST_HOME, ".perp"), { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  delete process.env.LIGHTER_API_KEY;
  delete process.env.LIGHTER_ACCOUNT_INDEX;
  delete process.env.LIGHTER_API_KEY_INDEX;
});

describe("lighterKeystorePath", () => {
  it("returns deterministic absolute path under HOME/.perp/lighter-agents", () => {
    const path = lighterKeystorePath(ACCOUNT_INDEX, SLOT);
    expect(path).toBe(resolve(TEST_HOME, ".perp", "lighter-agents", `${ACCOUNT_INDEX}-${SLOT}.json`));
  });
});

describe("saveLighterKey + loadLighterKey", () => {
  it("round-trips a key through encrypt/decrypt with non-empty passphrase", () => {
    const path = saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "secret");
    expect(existsSync(path)).toBe(true);

    const loaded = loadLighterKey(ACCOUNT_INDEX, SLOT, "secret");
    expect(loaded).toBe(FAKE_KEY_HEX);
  });

  it("round-trips with empty passphrase", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    const loaded = loadLighterKey(ACCOUNT_INDEX, SLOT, "");
    expect(loaded).toBe(FAKE_KEY_HEX);
  });

  it("strips 0x prefix when saving", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, `0x${FAKE_KEY_HEX}`, "");
    const loaded = loadLighterKey(ACCOUNT_INDEX, SLOT, "");
    expect(loaded).toBe(FAKE_KEY_HEX);
    expect(loaded.startsWith("0x")).toBe(false);
  });

  it("rejects non-hex input", () => {
    expect(() => saveLighterKey(ACCOUNT_INDEX, SLOT, "not-hex-zzz", "")).toThrow();
  });

  it("writes file with mode 0600", () => {
    const path = saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    const stat = statSync(path);
    // mask permission bits to ignore file-type bits
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates directory with mode 0700", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    const dir = resolve(TEST_HOME, ".perp", "lighter-agents");
    const stat = statSync(dir);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("wrong passphrase throws LIGHTER_KEYSTORE_DECRYPT_FAILED", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "right");
    expect(() => loadLighterKey(ACCOUNT_INDEX, SLOT, "wrong")).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("LIGHTER_KEYSTORE_DECRYPT_FAILED"),
      }),
    );
  });

  it("missing file throws LIGHTER_KEYSTORE_NOT_FOUND with remediation", () => {
    let caught: unknown = null;
    try {
      loadLighterKey(ACCOUNT_INDEX, SLOT, "");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const err = caught as { message: string; structured?: { remediation?: string } };
    expect(err.message).toContain("LIGHTER_KEYSTORE_NOT_FOUND");
    expect(err.structured?.remediation).toContain("perp wallet agent approve lighter");
  });

  it("corrupt ciphertext throws LIGHTER_KEYSTORE_DECRYPT_FAILED", () => {
    const path = saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    const file = JSON.parse(readFileSync(path, "utf-8"));
    file.crypto.ciphertext = "00".repeat(file.crypto.ciphertext.length / 2);
    writeFileSync(path, JSON.stringify(file));
    expect(() => loadLighterKey(ACCOUNT_INDEX, SLOT, "")).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("LIGHTER_KEYSTORE_DECRYPT_FAILED"),
      }),
    );
  });

  it("corrupt JSON throws LIGHTER_KEYSTORE_DECRYPT_FAILED", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    writeFileSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT), "not-json");
    expect(() => loadLighterKey(ACCOUNT_INDEX, SLOT, "")).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("LIGHTER_KEYSTORE_DECRYPT_FAILED"),
      }),
    );
  });
});

describe("deleteLighterKey", () => {
  it("removes the file and returns true on first call", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    expect(deleteLighterKey(ACCOUNT_INDEX, SLOT)).toBe(true);
    expect(existsSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT))).toBe(false);
  });

  it("returns false (idempotent) when file is absent", () => {
    expect(deleteLighterKey(ACCOUNT_INDEX, SLOT)).toBe(false);
  });

  it("second delete returns false", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    expect(deleteLighterKey(ACCOUNT_INDEX, SLOT)).toBe(true);
    expect(deleteLighterKey(ACCOUNT_INDEX, SLOT)).toBe(false);
  });
});

describe("schema", () => {
  it("file has version=1, expected crypto block, accountIndex, slot, createdAt", () => {
    const path = saveLighterKey(ACCOUNT_INDEX, SLOT, FAKE_KEY_HEX, "");
    const file = JSON.parse(readFileSync(path, "utf-8"));
    expect(file.version).toBe(1);
    expect(file.accountIndex).toBe(ACCOUNT_INDEX);
    expect(file.slot).toBe(SLOT);
    expect(file.crypto.cipher).toBe("aes-256-gcm");
    expect(file.crypto.kdf).toBe("scrypt");
    expect(file.crypto.kdfparams.n).toBe(65536);
    expect(file.crypto.kdfparams.r).toBe(8);
    expect(file.crypto.kdfparams.p).toBe(1);
    expect(file.crypto.kdfparams.dklen).toBe(32);
    expect(file.crypto.cipherparams.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(file.crypto.kdfparams.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(file.crypto.auth_tag).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof file.createdAt).toBe("string");
    expect(() => new Date(file.createdAt).toISOString()).not.toThrow();
  });
});

describe("migrateFromEnvIfPresent", () => {
  it("env trio set + no keystore → creates keystore + clears env file entries", () => {
    // Seed ~/.perp/.env with the legacy trio.
    const envFile = resolve(TEST_HOME, ".perp", ".env");
    writeFileSync(envFile, [
      "# comment",
      `LIGHTER_API_KEY=${FAKE_KEY_HEX}`,
      `LIGHTER_ACCOUNT_INDEX=${ACCOUNT_INDEX}`,
      `LIGHTER_API_KEY_INDEX=${SLOT}`,
      "OTHER_KEY=keep-me",
    ].join("\n"));

    process.env.LIGHTER_API_KEY = FAKE_KEY_HEX;
    process.env.LIGHTER_ACCOUNT_INDEX = String(ACCOUNT_INDEX);
    process.env.LIGHTER_API_KEY_INDEX = String(SLOT);

    migrateFromEnvIfPresent();

    // Keystore file now exists and decrypts back to the original key.
    expect(existsSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT))).toBe(true);
    expect(loadLighterKey(ACCOUNT_INDEX, SLOT, "")).toBe(FAKE_KEY_HEX);

    // Legacy env entries cleared from process.env...
    expect(process.env.LIGHTER_API_KEY).toBeUndefined();
    expect(process.env.LIGHTER_ACCOUNT_INDEX).toBeUndefined();
    expect(process.env.LIGHTER_API_KEY_INDEX).toBeUndefined();

    // ...and from the .env file (other keys preserved).
    const after = readFileSync(envFile, "utf-8");
    expect(after).not.toMatch(/^LIGHTER_API_KEY=/m);
    expect(after).not.toMatch(/^LIGHTER_ACCOUNT_INDEX=/m);
    expect(after).not.toMatch(/^LIGHTER_API_KEY_INDEX=/m);
    expect(after).toContain("OTHER_KEY=keep-me");
  });

  it("env empty → no-op (no keystore created)", () => {
    migrateFromEnvIfPresent();
    expect(existsSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT))).toBe(false);
  });

  it("keystore already exists → does not overwrite", () => {
    saveLighterKey(ACCOUNT_INDEX, SLOT, "ff".repeat(40), "");
    const before = readFileSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT), "utf-8");

    process.env.LIGHTER_API_KEY = FAKE_KEY_HEX;
    process.env.LIGHTER_ACCOUNT_INDEX = String(ACCOUNT_INDEX);
    process.env.LIGHTER_API_KEY_INDEX = String(SLOT);

    migrateFromEnvIfPresent();

    const after = readFileSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT), "utf-8");
    expect(after).toBe(before);
    // key is the original "ff..." not FAKE_KEY_HEX
    expect(loadLighterKey(ACCOUNT_INDEX, SLOT, "")).toBe("ff".repeat(40));
  });

  it("env without indices → bails silently", () => {
    process.env.LIGHTER_API_KEY = FAKE_KEY_HEX;
    // no LIGHTER_ACCOUNT_INDEX, no LIGHTER_API_KEY_INDEX
    migrateFromEnvIfPresent();
    expect(existsSync(lighterKeystorePath(ACCOUNT_INDEX, SLOT))).toBe(false);
  });
});
