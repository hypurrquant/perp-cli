import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const SETTINGS_FILE = resolve(PERP_DIR, "settings.json");

export interface ExchangeFees {
  taker: number;  // fraction, e.g. 0.00035 = 0.035%
  maker: number;
}

export interface AlertRule {
  id: string;
  symbol: string;      // "*" = all symbols
  exchange: string;     // "*" = all exchanges
  threshold: number;    // annualized funding rate %
  direction: "above" | "below";
  enabled: boolean;
}

export interface AlertSettings {
  discord?: {
    botToken: string;
    userId: string;
    channelId?: string; // cached DM channel ID for faster sends
  };
  rules: AlertRule[];
  /** Check interval in seconds (default: 300 = 5 min) */
  intervalSec: number;
  /** Cooldown per symbol in minutes after alert fires (default: 60) */
  cooldownMin: number;
}

export interface Settings {
  /** Default exchange when -e flag is omitted */
  defaultExchange: string;
  /** Enable referral/builder codes (default: false — opt-in only) */
  referrals: boolean;
  /** Per-exchange referral codes (used when referrals=true) */
  referralCodes: {
    pacifica: string;   // builder code (sent per-order, not one-time)
    hyperliquid: string;
    lighter: string;
  };
  /** Track which exchanges have had referral codes applied (one-time) */
  referralApplied: {
    hyperliquid: boolean;
    lighter: boolean;
  };
  /** Per-exchange fee tiers (fetched from exchange APIs) */
  fees: Record<string, ExchangeFees>;
  /** Alert configuration */
  alerts: AlertSettings;
}

const DEFAULTS: Settings = {
  defaultExchange: "",
  referrals: false,
  referralCodes: {
    pacifica: "",
    hyperliquid: "HYPERCASH",
    lighter: "718585MY",
  },
  referralApplied: {
    hyperliquid: false,
    lighter: false,
  },
  fees: {
    hyperliquid: { taker: 0.00035, maker: 0.00002 },
    pacifica: { taker: 0.00035, maker: 0.0001 },
    lighter: { taker: 0, maker: 0 },
  },
  alerts: {
    rules: [],
    intervalSec: 300,
    cooldownMin: 60,
  },
};

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS, referralCodes: { ...DEFAULTS.referralCodes }, fees: { ...DEFAULTS.fees }, alerts: { ...DEFAULTS.alerts } };
  try {
    const stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    // Merge stored fees with defaults (so new exchanges get defaults)
    const fees: Record<string, ExchangeFees> = { ...DEFAULTS.fees };
    if (stored.fees && typeof stored.fees === "object") {
      for (const [ex, f] of Object.entries(stored.fees)) {
        const fee = f as Partial<ExchangeFees>;
        if (fee && typeof fee.taker === "number" && typeof fee.maker === "number") {
          fees[ex] = { taker: fee.taker, maker: fee.maker };
        }
      }
    }
    return {
      defaultExchange: stored.defaultExchange ?? DEFAULTS.defaultExchange,
      referrals: stored.referrals ?? DEFAULTS.referrals,
      referralCodes: {
        pacifica: stored.referralCodes?.pacifica ?? DEFAULTS.referralCodes.pacifica,
        hyperliquid: stored.referralCodes?.hyperliquid ?? DEFAULTS.referralCodes.hyperliquid,
        lighter: stored.referralCodes?.lighter ?? DEFAULTS.referralCodes.lighter,
      },
      referralApplied: {
        hyperliquid: stored.referralApplied?.hyperliquid ?? DEFAULTS.referralApplied.hyperliquid,
        lighter: stored.referralApplied?.lighter ?? DEFAULTS.referralApplied.lighter,
      },
      alerts: {
        discord: stored.alerts?.discord ?? DEFAULTS.alerts.discord,
        rules: Array.isArray(stored.alerts?.rules) ? stored.alerts.rules : DEFAULTS.alerts.rules,
        intervalSec: stored.alerts?.intervalSec ?? DEFAULTS.alerts.intervalSec,
        cooldownMin: stored.alerts?.cooldownMin ?? DEFAULTS.alerts.cooldownMin,
      },
      fees,
    };
  } catch {
    return { ...DEFAULTS, referralCodes: { ...DEFAULTS.referralCodes }, fees: { ...DEFAULTS.fees }, alerts: { ...DEFAULTS.alerts } };
  }
}

export function saveSettings(settings: Settings): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
