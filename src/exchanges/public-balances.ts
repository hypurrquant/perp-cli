/**
 * Balances of ANY account by its public address, keyless (`perp account balance --address`, MCP
 * get_balance_by_address). Wired into the registry through VenuePublicData.fetchBalanceByAddress;
 * the balance comes from the same functions as the keyed adapters' getBalance (hlBalanceOf /
 * lighterBalanceOf / pacificaBalanceOf) and the spot rows from the keyed spot mappers
 * (hlSpotBalanceRows / lighterSpotBalanceRows / pacificaSpotBalanceRows). Read-only GETs / info
 * POSTs; nothing is signed, no key is loaded.
 */
import { classifyError, PerpError } from "../errors.js";
import { getVenue, networkConfig, type Network, type PublicBalanceResult, type PublicPositionsOptions } from "./venue.js";
import type { ExchangeBalance } from "./interface.js";
import type { LighterVenueId } from "./venues/lighter-family.js";
import { chooseLighterAccounts, hlDexFanOut, hlDexNamesOf, lighterAccountIndexOf } from "./public-positions.js";

function errorOf(e: unknown, venue: string): { code: string; message: string } {
  const s = classifyError(e, venue);
  return { code: s.code, message: s.message };
}

/** A venue read failure as a typed error (the public HTTP helpers throw plain Errors on HTTP status). */
async function typed<T>(venue: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (e) {
    if (e instanceof PerpError) throw e;
    const s = classifyError(e, venue);
    throw new PerpError(s.code === "UNKNOWN" ? "EXCHANGE_ERROR" : s.code, s.message, { exchange: venue });
  }
}

const EMPTY = { balance: null, spot: null, accounts: null, dexes: null, accountMode: null } as const;

/** spotClearinghouseState `balances`, every row with a coin and numeric total / hold (unreadable → EXCHANGE_ERROR, never "0"). */
function hlSpotBalancesOf(state: unknown): Record<string, unknown>[] {
  const balances = (state as { balances?: unknown } | null)?.balances;
  if (!Array.isArray(balances)) throw new PerpError("EXCHANGE_ERROR", "hyperliquid spotClearinghouseState: no balances array", { exchange: "hyperliquid" });
  for (const b of balances as Array<Record<string, unknown>>) {
    const num = (v: unknown) => typeof v === "string" && v !== "" && Number.isFinite(Number(v));
    if (typeof b?.coin !== "string" || !num(b.total) || !num(b.hold)) {
      throw new PerpError("EXCHANGE_ERROR", `hyperliquid spotClearinghouseState: unreadable balance row ${JSON.stringify(b).slice(0, 160)}`, { exchange: "hyperliquid" });
    }
  }
  return balances as Record<string, unknown>[];
}

/**
 * Hyperliquid: info `clearinghouseState` (native perp dex), `userAbstraction` (the mode decides
 * the equity source, exactly as the keyed getBalance) and `spotClearinghouseState` (spot rows;
 * in unified / portfolio mode also the collateral), plus `meta.collateralToken` when the mode needs
 * it. HIP-3: `clearinghouseState {dex}` for every dex of `perpDexs` (paced: hlDexFanOut); a dex
 * balance is that dex's own perp clearinghouse, listed when its account value is non-zero. A dex
 * (or the dex list) that fails is an `errors` entry ("hip3:<dex>") — unknown, never zero; the
 * native, mode or spot read failing fails the venue.
 */
export async function hyperliquidBalanceByAddress(net: Network, address: string): Promise<PublicBalanceResult> {
  const { legacyPublicJson } = await import("../funding/legacy-public.js");
  const { legacyPublicBaseUrl } = await import("../api/public/urls.js");
  const { hlAbstractionModeOf, hlBalanceOf, hlSpotUsdPricesOf } = await import("./hyperliquid.js");
  const { hlSpotBalanceRows } = await import("./hyperliquid-spot.js");
  const url = `${legacyPublicBaseUrl("hyperliquid", net)}/info`;
  const post = (body: Record<string, unknown>, label: string) => legacyPublicJson("hyperliquid", url, label, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const errors: PublicBalanceResult["errors"] = {};
  const [native, modeRaw, spotState, dexList] = await Promise.all([
    typed("hyperliquid", () => post({ type: "clearinghouseState", user: address }, "info clearinghouseState")),
    typed("hyperliquid", () => post({ type: "userAbstraction", user: address }, "info userAbstraction")),
    typed("hyperliquid", () => post({ type: "spotClearinghouseState", user: address }, "info spotClearinghouseState")),
    post({ type: "perpDexs" }, "info perpDexs").then(
      hlDexNamesOf,
      (e: unknown) => { errors.hip3 = errorOf(e, "hyperliquid"); return [] as string[]; },
    ),
  ]);
  const mode = hlAbstractionModeOf(modeRaw);
  const balances = hlSpotBalancesOf(spotState);
  let token: Promise<number> | null = null;
  const collateralToken = (): Promise<number> => (token ??= typed("hyperliquid", () => post({ type: "meta" }, "info meta")).then((meta) => {
    const idx = (meta as { collateralToken?: unknown } | null)?.collateralToken;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
      throw new PerpError("EXCHANGE_ERROR", `Hyperliquid meta has no collateralToken (got ${JSON.stringify(idx)})`, { exchange: "hyperliquid" });
    }
    return idx;
  }));
  const nativeState = native as Record<string, unknown>;
  const { balance, notes } = await hlBalanceOf(nativeState, mode, "", {
    collateralToken,
    spotCollateralRow: async () => {
      const t = await collateralToken();
      return { row: balances.find(b => Number(b.token) === t) ?? null, balances, token: t, portfolioMarginRatio: (spotState as { portfolioMarginRatio?: unknown }).portfolioMarginRatio };
    },
    spotUsdPrices: async () => hlSpotUsdPricesOf(await typed("hyperliquid", () => post({ type: "spotMetaAndAssetCtxs" }, "info spotMetaAndAssetCtxs"))),
  });
  const unified = mode === "unified" || mode === "portfolio";
  const out: string[] = notes.map(n => n.trim());
  if (unified) {
    const av = (nativeState.marginSummary as { accountValue?: unknown } | undefined)?.accountValue;
    const wd = nativeState.withdrawable;
    const perp = [typeof av === "string" ? `accountValue ${av}` : null, typeof wd === "string" ? `withdrawable ${wd}` : null].filter(x => x !== null).join(", ");
    out.push(`account mode ${mode}: equity / available come from the spot clearinghouse (the collateral balance already moves with perp PnL), as in the keyed balance; the native perp clearinghouse${perp !== "" ? ` (${perp})` : ""} is a per-dex view and is not added`);
  }

  // HIP-3 dex balances: the dex's own perp clearinghouse (standard semantics — the mode-dependent
  // spot collateral is the top-level balance, never repeated per dex).
  const dexes: Record<string, ExchangeBalance> = {};
  const noSpotRead = (): never => { throw new PerpError("EXCHANGE_ERROR", "internal: a HIP-3 dex balance read asked for spot state", { exchange: "hyperliquid" }); };
  const perDex = await hlDexFanOut(net, dexList, dex => post({ type: "clearinghouseState", user: address, dex }, `info clearinghouseState dex ${dex}`));
  for (const [i, res] of perDex.entries()) {
    const dex = dexList[i];
    if (res.status === "rejected") { errors[`hip3:${dex}`] = errorOf(res.reason, "hyperliquid"); continue; }
    try {
      const b = (await hlBalanceOf(res.value as Record<string, unknown>, "standard", dex, { collateralToken: noSpotRead, spotCollateralRow: noSpotRead, spotUsdPrices: noSpotRead })).balance;
      if (Number(b.equity) !== 0) dexes[dex] = b;
    } catch (e) { errors[`hip3:${dex}`] = errorOf(e, "hyperliquid"); }
  }
  return { balance, spot: hlSpotBalanceRows({ balances }, unified), accounts: null, dexes, accountMode: mode, errors, notes: out };
}

/**
 * Lighter / Lighter RH: `GET /account?by=l1_address` lists every account of the address; each
 * account's balance (lighterBalanceOf) and spot assets (lighterSpotBalanceRows) are one
 * `accounts` row. `accountIndex` narrows to one account (not one of the address's →
 * INVALID_PARAMS); no account → empty `accounts` + note.
 */
export async function lighterBalanceByAddress(venue: LighterVenueId, net: Network, address: string, opts: PublicPositionsOptions): Promise<PublicBalanceResult> {
  const { fetchLighterAccountsByL1 } = await import("./lighter-public.js");
  const { lighterBalanceOf } = await import("./lighter.js");
  const { lighterSpotBalanceRows } = await import("./lighter-spot.js");
  const collateral = networkConfig(getVenue(venue), net).collateral[0];
  if (collateral === undefined) throw new PerpError("INVALID_PARAMS", `${venue} network config has no collateral`);
  const accounts = await fetchLighterAccountsByL1(venue, net, address);
  if (accounts === null || accounts.length === 0) {
    return { ...EMPTY, accounts: [], errors: {}, notes: [`no ${venue === "lighter" ? "Lighter" : "Lighter RH"} account for this address`] };
  }
  const rows = chooseLighterAccounts(venue, accounts, opts.accountIndex).map(a => ({
    accountIndex: lighterAccountIndexOf(a),
    balance: lighterBalanceOf(a, venue, collateral),
    spot: lighterSpotBalanceRows(a, venue, collateral),
  }));
  return { ...EMPTY, accounts: rows, errors: {}, notes: [] };
}

/**
 * Pacifica: `GET /account?account=` (balance + spot_balances), `/positions?account=` and
 * `/info/prices` — pacificaBalanceOf with the keyed extras (usdcBalance, borrowedUsdc,
 * pendingInterest, availableToWithdraw). The address is validated as base58 32 bytes by the caller.
 */
export async function pacificaBalanceByAddress(net: Network, address: string): Promise<PublicBalanceResult> {
  const { PacificaClient } = await import("../pacifica/client.js");
  const { pacificaBalanceOf } = await import("./pacifica.js");
  const { pacificaSpotBalanceRows } = await import("./pacifica-spot.js");
  const client = new PacificaClient({ network: net });
  const [info, positions, prices] = await typed("pacifica", () => Promise.all([client.getAccount(address), client.getPositions(address), client.getPrices()]));
  return {
    ...EMPTY,
    balance: pacificaBalanceOf(info, positions, prices),
    spot: pacificaSpotBalanceRows(info as unknown as Record<string, unknown>),
    errors: {},
    notes: [],
  };
}
