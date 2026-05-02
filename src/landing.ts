import chalk from "chalk";
import { listAgents } from "./agent-wallet/store.js";

export const LANDING_EXCHANGES = ["pacifica", "hyperliquid", "lighter", "aster"] as const;

export type LandingExchangeStatus = {
  exchange: typeof LANDING_EXCHANGES[number];
  ok: boolean;
  equity: number;
  positions: number;
  errorCode?: string;
};

const ASTER_AGENT_REQUIRED_CODES = new Set([
  "NOT_IMPLEMENTED",
  "NO_SIGNER_AVAILABLE",
  "AGENT_EXPIRED",
]);

function exchangeLabel(exchange: LandingExchangeStatus["exchange"]): string {
  return exchange === "pacifica" ? "Pacifica" : exchange === "hyperliquid" ? "Hyperliquid" : exchange === "lighter" ? "Lighter" : "Aster";
}

export function asterAgentMissing(): boolean {
  return listAgents("aster").length === 0;
}

export function renderLandingExchangeLine(
  status: LandingExchangeStatus,
  asterAgentMissing: boolean,
): string {
  if (
    !status.ok &&
    status.exchange === "aster" &&
    asterAgentMissing &&
    status.errorCode !== undefined &&
    ASTER_AGENT_REQUIRED_CODES.has(status.errorCode)
  ) {
    return `    ${chalk.yellow("⚙")} ${chalk.cyan(exchangeLabel(status.exchange).padEnd(14))} ${chalk.yellow("agent required")} ${chalk.gray("→ perp wallet agent approve aster")}`;
  }

  const icon = status.ok ? chalk.green("●") : chalk.red("○");
  const equity = status.ok
    ? chalk.white(`$${Number(status.equity).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    : chalk.gray("—");
  const positions = status.ok && status.positions > 0 ? chalk.yellow(` ${status.positions} pos`) : "";

  return `    ${icon} ${chalk.cyan(exchangeLabel(status.exchange).padEnd(14))} ${equity}${positions}`;
}
