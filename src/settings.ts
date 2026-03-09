import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const SETTINGS_FILE = resolve(PERP_DIR, "settings.json");

export interface Settings {
  /** Enable referral/builder codes (default: false — opt-in only) */
  referrals: boolean;
  /** Per-exchange referral codes (used when referrals=true) */
  referralCodes: {
    pacifica: string;   // builder code
    hyperliquid: string;
    lighter: string;
  };
}

const DEFAULTS: Settings = {
  referrals: false,
  referralCodes: {
    pacifica: "",
    hyperliquid: "PERP_CLI",
    lighter: "",
  },
};

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS, referralCodes: { ...DEFAULTS.referralCodes } };
  try {
    const stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    return {
      referrals: stored.referrals ?? DEFAULTS.referrals,
      referralCodes: {
        pacifica: stored.referralCodes?.pacifica ?? DEFAULTS.referralCodes.pacifica,
        hyperliquid: stored.referralCodes?.hyperliquid ?? DEFAULTS.referralCodes.hyperliquid,
        lighter: stored.referralCodes?.lighter ?? DEFAULTS.referralCodes.lighter,
      },
    };
  } catch {
    return { ...DEFAULTS, referralCodes: { ...DEFAULTS.referralCodes } };
  }
}

export function saveSettings(settings: Settings): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
