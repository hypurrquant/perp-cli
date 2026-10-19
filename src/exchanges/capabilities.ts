/**
 * Capability sub-interfaces for exchange-specific features.
 * Use type guard functions (isTwapCapable, hasPacificaSdk, etc.) instead of instanceof checks.
 */

import type { ExchangeAdapter } from "./interface.js";

// ── Capability Interfaces ──

export interface WithdrawCapable {
  withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number }): Promise<unknown>;
}

export interface TwapCapable {
  twapOrder(symbol: string, side: "buy" | "sell", size: string, duration: number, opts?: { reduceOnly?: boolean }): Promise<unknown>;
  twapCancel(symbol: string, twapId: number): Promise<unknown>;
}

export interface TpSlCapable {
  setTpSl(symbol: string, side: "buy" | "sell", opts: { tp?: string; tpLimit?: string; sl?: string; size?: string }): Promise<unknown>;
}

export interface TriggerOrderCapable {
  triggerOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, type: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface DexCapable {
  readonly dex: string;
  setDex(dex: string): void;
  /** An independent adapter for `dex` with this account configuration and its own market state (never mutates this one). */
  forDex(dex: string): ExchangeAdapter & DexCapable;
  listDeployedDexes(): Promise<{ name: string; deployer: string; assets: string[] }[]>;
}

export interface SubAccountCapable {
  createSubAccount(name: string): Promise<unknown>;
  subAccountTransfer(subAccountUser: string, isDeposit: boolean, amount: number): Promise<unknown>;
}

export interface PacificaSdkCapable {
  readonly sdk: unknown;
  readonly publicKey: string;
  readonly signer: (msg: Uint8Array) => Promise<Uint8Array>;
}

export interface LighterAccountCapable {
  readonly accountIndex: number;
  readonly address: string;
  setupApiKey(apiKeyIndex?: number): Promise<{ privateKey: string; publicKey: string }>;
}

export interface EvmAddressCapable {
  readonly address: string;
}

export interface QueryOrderCapable {
  /** Order id (u64) or, on Hyperliquid, a client order id (cloid) string. */
  queryOrder(orderId: number | string): Promise<unknown>;
}

export interface UsdTransferCapable {
  usdTransfer(amount: number, destination: string): Promise<unknown>;
}

// ── Type Guards ──

export function isWithdrawCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & WithdrawCapable {
  return typeof (adapter as unknown as Record<string, unknown>).withdraw === "function";
}

export function isTwapCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & TwapCapable {
  return typeof (adapter as unknown as Record<string, unknown>).twapOrder === "function"
    && typeof (adapter as unknown as Record<string, unknown>).twapCancel === "function";
}

export function isTpSlCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & TpSlCapable {
  return typeof (adapter as unknown as Record<string, unknown>).setTpSl === "function";
}

export function isTriggerOrderCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & TriggerOrderCapable {
  return typeof (adapter as unknown as Record<string, unknown>).triggerOrder === "function";
}

export function isDexCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & DexCapable {
  return typeof (adapter as unknown as Record<string, unknown>).setDex === "function"
    && typeof (adapter as unknown as Record<string, unknown>).listDeployedDexes === "function";
}

export function isSubAccountCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & SubAccountCapable {
  return typeof (adapter as unknown as Record<string, unknown>).createSubAccount === "function";
}

export function hasPacificaSdk(adapter: ExchangeAdapter): adapter is ExchangeAdapter & PacificaSdkCapable {
  return adapter.name === "pacifica"
    && (adapter as unknown as Record<string, unknown>).sdk != null
    && typeof (adapter as unknown as Record<string, unknown>).sdk === "object"
    && typeof (adapter as unknown as Record<string, unknown>).publicKey === "string";
}

export function hasLighterAccount(adapter: ExchangeAdapter): adapter is ExchangeAdapter & LighterAccountCapable {
  return typeof (adapter as unknown as Record<string, unknown>).accountIndex === "number"
    && typeof (adapter as unknown as Record<string, unknown>).setupApiKey === "function";
}

export function hasEvmAddress(adapter: ExchangeAdapter): adapter is ExchangeAdapter & EvmAddressCapable {
  return typeof (adapter as unknown as Record<string, unknown>).address === "string";
}

export function isQueryOrderCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & QueryOrderCapable {
  return typeof (adapter as unknown as Record<string, unknown>).queryOrder === "function";
}

export function isUsdTransferCapable(adapter: ExchangeAdapter): adapter is ExchangeAdapter & UsdTransferCapable {
  return typeof (adapter as unknown as Record<string, unknown>).usdTransfer === "function";
}

/**
 * true when the venue's kline endpoint needs account credentials (Ondo GET /v1/perps/candles):
 * `market kline` then uses the credentialed adapter instead of the keyless public one.
 */
export function klinesNeedAuth(adapter: ExchangeAdapter): boolean {
  return (adapter as unknown as Record<string, unknown>).klinesRequireAuth === true;
}
