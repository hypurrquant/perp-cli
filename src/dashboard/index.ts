// dashboard/ barrel — public API
export { startDashboard } from "./server.js";
export type { DashboardExchange, DashboardOpts, DashboardSnapshot } from "./server.js";
export { WsFeedManager } from "./ws-feeds.js";
export type { WsFeedState, WsFeedManagerOpts } from "./ws-feeds.js";
