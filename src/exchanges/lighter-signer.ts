/**
 * Official Lighter WASM signer (lighter-go release v1.0.9), vendored under
 * vendor/lighter-signer/ and loaded directly — no lighter-ts-sdk wrapper.
 *
 * Why: the WASM bundled in lighter-ts-sdk (1.0.10 and 1.1.0) predates lighter-go
 * 8854554 (#89), so it rejects market ids ≥ 4095 ("MarketIndex is not valid") and
 * treats 2048–4094 as spot (reduce-only / trigger / margin refused). Testnet perps
 * are 4095–4097 and Lighter RH testnet perps 2048/2049.
 *
 * Calls follow https://apidocs.lighter.xyz/docs/wasm-signer.md exactly: positional
 * arguments, every one required, `url` = "" in CreateClient (the WASM cannot do
 * HTTP), and an explicit nonce (never -1, which would make the signer fetch it).
 *
 * Integrity: both vendored files are sha256-pinned here and verified at load; a
 * mismatch refuses to load (nothing can be signed).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PerpError } from "../errors.js";
import { LIGHTER_GTT_EXPIRY_MS } from "./venues/lighter-family.js";

export const LIGHTER_SIGNER_VERSION = "lighter-go v1.0.9";
/** sha256 of vendor/lighter-signer/lighter-signer.wasm (= the v1.0.9 release asset digest). */
export const LIGHTER_SIGNER_WASM_SHA256 = "781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b";
/** sha256 of vendor/lighter-signer/wasm_exec.js (= go1.25.6 lib/wasm/wasm_exec.js). */
export const LIGHTER_SIGNER_WASM_EXEC_SHA256 = "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14";

/** Same relative depth from src/exchanges/ and dist/exchanges/ to the package root. */
export function lighterSignerDir(): string {
  return fileURLToPath(new URL("../../vendor/lighter-signer/", import.meta.url));
}

/** Result of every Sign* call (wasm-signer.md "Conventions"). */
export interface LighterSignResult {
  txType: number;
  txInfo: string;
  txHash: string;
  messageToSign?: string;
  error?: string;
}

interface Account { apiKeyIndex: number; accountIndex: number }

type WasmFn = (...args: Array<string | number>) => Record<string, unknown> | undefined;

const EXPORTS = [
  "GenerateAPIKey", "CreateClient", "CreateAuthToken", "SignChangePubKey", "SignCreateOrder",
  "SignModifyOrder", "SignCancelOrder", "SignCancelAllOrders", "SignUpdateLeverage",
  "SignWithdraw", "SignTransfer",
] as const;
type ExportName = typeof EXPORTS[number];

/** cancelAllMarketIndex meaning "all markets" (wasm-signer.md SignCancelAllOrders). */
export const LIGHTER_ALL_MARKETS = 255;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Every numeric argument must be a finite integer: the Go side truncates silently. */
function int(name: string, v: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new PerpError("SIGNATURE_FAILED", `Lighter signer: ${name} must be a safe integer (got ${String(v)})`);
  }
  return v;
}

/** Explicit nonce only: -1 would make the WASM fetch it over HTTP, which it cannot do. */
function nonceArg(v: number): number {
  const n = int("nonce", v);
  if (n < 0) throw new PerpError("SIGNATURE_FAILED", `Lighter signer: nonce must be explicit and ≥ 0 (got ${n})`);
  return n;
}

/**
 * One Go runtime of the official signer. The Go `main` registers its functions on
 * globalThis and then blocks; they are captured synchronously right after `go.run()`
 * and the globals restored, so several runtimes (one per venue+network)
 * never see each other's functions.
 */
export class LighterWasmSigner {
  private constructor(private readonly fn: Record<ExportName, WasmFn>) {}

  /** Load + verify the vendored files and start a fresh runtime. */
  static async load(dir: string = lighterSignerDir()): Promise<LighterWasmSigner> {
    const [wasm, execJs] = await Promise.all([
      readFile(`${dir}/lighter-signer.wasm`),
      readFile(`${dir}/wasm_exec.js`),
    ]);
    const got = { wasm: sha256(wasm), exec: sha256(execJs) };
    if (got.wasm !== LIGHTER_SIGNER_WASM_SHA256 || got.exec !== LIGHTER_SIGNER_WASM_EXEC_SHA256) {
      throw new PerpError("SIGNATURE_FAILED", `Lighter signer files do not match the pinned ${LIGHTER_SIGNER_VERSION} checksums (lighter-signer.wasm ${got.wasm}, wasm_exec.js ${got.exec}); refusing to load`, {
        remediation: "Reinstall perp-cli; the vendored Lighter signer is corrupted or was modified",
      });
    }
    const g = globalThis as Record<string, unknown>;
    // Evaluate the VERIFIED bytes (not a second read of the file); it assigns globalThis.Go.
    const prevGo = g.Go;
    new Function(execJs.toString("utf8"))();
    const Go = g.Go as new () => { importObject: WebAssembly.Imports; exit: (code: number) => void; run(i: WebAssembly.Instance): Promise<void> };
    if (prevGo === undefined) delete g.Go; else g.Go = prevGo;
    if (typeof Go !== "function") throw new PerpError("SIGNATURE_FAILED", "Lighter signer: wasm_exec.js did not define Go");

    const go = new Go();
    let exitCode: number | null = null;
    // Go's default exit only logs; a runtime that exits can no longer sign — record it.
    go.exit = (code: number) => { exitCode = code; };
    const { instance } = await WebAssembly.instantiate(wasm, go.importObject);

    const saved = new Map<string, unknown>(EXPORTS.map(n => [n, g[n]]));
    void go.run(instance).catch(() => { exitCode = exitCode ?? -1; });
    const fn = {} as Record<ExportName, WasmFn>;
    for (const n of EXPORTS) {
      const f = g[n];
      if (typeof f !== "function") throw new PerpError("SIGNATURE_FAILED", `Lighter signer: WASM did not export ${n}`);
      fn[n] = f as WasmFn;
    }
    for (const [n, v] of saved) { if (v === undefined) delete g[n]; else g[n] = v; }
    const signer = new LighterWasmSigner(fn);
    signer.exited = () => exitCode !== null;
    return signer;
  }

  private exited: () => boolean = () => false;

  private call(name: ExportName, args: Array<string | number>): Record<string, unknown> {
    if (this.exited()) throw new PerpError("SIGNATURE_FAILED", "Lighter WASM signer runtime has exited");
    const r = this.fn[name](...args);
    if (r === undefined || r === null || typeof r !== "object") {
      throw new PerpError("SIGNATURE_FAILED", `Lighter signer ${name} returned no result`);
    }
    return r;
  }

  private tx(name: ExportName, args: Array<string | number>): LighterSignResult {
    const r = this.call(name, args);
    if (typeof r.error === "string" && r.error !== "") {
      return { txType: NaN, txInfo: "", txHash: "", error: r.error };
    }
    const out: LighterSignResult = { txType: Number(r.txType), txInfo: String(r.txInfo ?? ""), txHash: String(r.txHash ?? "") };
    if (typeof r.messageToSign === "string") out.messageToSign = r.messageToSign;
    return out;
  }

  generateAPIKey(): { privateKey: string; publicKey: string } {
    const r = this.call("GenerateAPIKey", []);
    if (typeof r.error === "string") throw new PerpError("SIGNATURE_FAILED", `Lighter GenerateAPIKey: ${r.error}`);
    if (typeof r.privateKey !== "string" || typeof r.publicKey !== "string") {
      throw new PerpError("SIGNATURE_FAILED", "Lighter GenerateAPIKey returned no key pair");
    }
    return { privateKey: r.privateKey, publicKey: r.publicKey };
  }

  /** CreateClient(url = "", privateKey, chainId, apiKeyIndex, accountIndex). `url` is ignored (kept for call-site compatibility). */
  createClient(p: { url?: string; privateKey: string; chainId: number } & Account): void {
    const r = this.call("CreateClient", ["", p.privateKey, int("chainId", p.chainId), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex)]);
    if (typeof r.error === "string" && r.error !== "") throw new PerpError("SIGNATURE_FAILED", `Lighter CreateClient: ${r.error}`);
  }

  /** CreateAuthToken(deadline unix s, apiKeyIndex, accountIndex) → token string. */
  createAuthToken(deadline: number, apiKeyIndex: number, accountIndex: number): string {
    const r = this.call("CreateAuthToken", [int("deadline", deadline), int("apiKeyIndex", apiKeyIndex), int("accountIndex", accountIndex)]);
    if (typeof r.error === "string" && r.error !== "") throw new PerpError("SIGNATURE_FAILED", `Lighter CreateAuthToken: ${r.error}`);
    if (typeof r.authToken !== "string" || r.authToken === "") throw new PerpError("SIGNATURE_FAILED", "Lighter CreateAuthToken returned no token");
    return r.authToken;
  }

  /** SignChangePubKey(pubKeyHex, skipNonce, nonce, apiKeyIndex, accountIndex). */
  signChangePubKey(p: { pubkey: string; nonce: number } & Account): LighterSignResult {
    return this.tx("SignChangePubKey", [p.pubkey, 0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex)]);
  }

  /**
   * SignCreateOrder — 19 args. Integrator fields and self-trade modes are 0 (defaults);
   * skipNonce 0. `orderExpiry` −1 = GTT default: now + LIGHTER_GTT_EXPIRY_MS (28 days), resolved here.
   */
  signCreateOrder(p: {
    marketIndex: number; clientOrderIndex: number; baseAmount: number; price: number; isAsk: number;
    orderType: number; timeInForce: number; reduceOnly: number; triggerPrice: number; orderExpiry: number; nonce: number;
  } & Account): LighterSignResult {
    const expiry = p.orderExpiry === -1 ? Date.now() + LIGHTER_GTT_EXPIRY_MS : int("orderExpiry", p.orderExpiry);
    return this.tx("SignCreateOrder", [
      int("marketIndex", p.marketIndex), int("clientOrderIndex", p.clientOrderIndex), int("baseAmount", p.baseAmount),
      int("price", p.price), int("isAsk", p.isAsk), int("orderType", p.orderType), int("timeInForce", p.timeInForce),
      int("reduceOnly", p.reduceOnly), int("triggerPrice", p.triggerPrice), expiry,
      0, 0, 0, // integratorAccountIndex, integratorTakerFee, integratorMakerFee
      0, 0,    // selfTradeBehaviorMode, selfTradeEqualityMode
      0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex),
    ]);
  }

  /**
   * SignModifyOrder — 15 args (lighter-go #83): marketIndex, index, baseAmount, price, triggerPrice,
   * 0,0,0 (integrator), 0,0 (self-trade), skipNonce, nonce, orderVersion, apiKeyIndex, accountIndex.
   * `index` = the order's client order index (or order index). orderVersion 0 = unversioned.
   */
  signModifyOrder(p: { marketIndex: number; index: number; baseAmount: number; price: number; triggerPrice: number; nonce: number; orderVersion?: number } & Account): LighterSignResult {
    return this.tx("SignModifyOrder", [
      int("marketIndex", p.marketIndex), int("index", p.index), int("baseAmount", p.baseAmount), int("price", p.price),
      int("triggerPrice", p.triggerPrice), 0, 0, 0, 0, 0, 0, nonceArg(p.nonce), int("orderVersion", p.orderVersion ?? 0),
      int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex),
    ]);
  }

  /** SignCancelOrder(marketIndex, orderIndex, skipNonce, nonce, apiKeyIndex, accountIndex). */
  signCancelOrder(p: { marketIndex: number; orderIndex: number; nonce: number } & Account): LighterSignResult {
    return this.tx("SignCancelOrder", [int("marketIndex", p.marketIndex), int("orderIndex", p.orderIndex), 0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex)]);
  }

  /** SignCancelAllOrders(timeInForce, time, cancelAllMarketIndex (255 = all), skipNonce, nonce, apiKeyIndex, accountIndex). */
  signCancelAllOrders(p: { timeInForce: number; time: number; marketIndex?: number; nonce: number } & Account): LighterSignResult {
    return this.tx("SignCancelAllOrders", [
      int("timeInForce", p.timeInForce), int("time", p.time), int("cancelAllMarketIndex", p.marketIndex ?? LIGHTER_ALL_MARKETS),
      0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex),
    ]);
  }

  /** SignUpdateLeverage(marketIndex, fraction, marginMode, skipNonce, nonce, apiKeyIndex, accountIndex). */
  signUpdateLeverage(p: { marketIndex: number; fraction: number; marginMode: number; nonce: number } & Account): LighterSignResult {
    return this.tx("SignUpdateLeverage", [int("marketIndex", p.marketIndex), int("fraction", p.fraction), int("marginMode", p.marginMode), 0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex)]);
  }

  /** SignWithdraw(assetIndex, routeType, amount, skipNonce, nonce, apiKeyIndex, accountIndex). `usdcAmount` is already in base units. */
  signWithdraw(p: { usdcAmount: number; assetIndex: number; routeType: number; nonce: number } & Account): LighterSignResult {
    return this.tx("SignWithdraw", [int("assetIndex", p.assetIndex), int("routeType", p.routeType), int("amount", p.usdcAmount), 0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex)]);
  }

  /** SignTransfer(toAccountIndex, assetIndex, fromRouteType, toRouteType, amount, usdcFee, memo (32-byte hex), skipNonce, nonce, apiKeyIndex, accountIndex). */
  signTransfer(p: { toAccountIndex: number; assetIndex: number; fromRouteType: number; toRouteType: number; amount: number; usdcFee: number; memo: string; nonce: number } & Account): LighterSignResult {
    return this.tx("SignTransfer", [
      int("toAccountIndex", p.toAccountIndex), int("assetIndex", p.assetIndex), int("fromRouteType", p.fromRouteType),
      int("toRouteType", p.toRouteType), int("amount", p.amount), int("usdcFee", p.usdcFee), p.memo,
      0, nonceArg(p.nonce), int("apiKeyIndex", p.apiKeyIndex), int("accountIndex", p.accountIndex),
    ]);
  }
}
