export { BotDashboard } from "./BotDashboard.js";
export type { BotTuiState, ExchangeBalance, Position, OpenOrder, LogEntry, StateListener, LogListener, DashboardProps } from "./BotDashboard.js";

import { render } from "ink";
import React from "react";
import { BotDashboard } from "./BotDashboard.js";
import type { DashboardProps } from "./BotDashboard.js";

export function startDashboard(props: DashboardProps): { unmount: () => void } {
  const { unmount } = render(React.createElement(BotDashboard, props));
  return { unmount };
}
