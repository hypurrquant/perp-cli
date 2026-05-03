/**
 * Probe β v2: HL Outcome order — direct sign+send (no adapter wrapper).
 *
 * Uses the agent's local EVM keypair from OWS vault, signs the L1 action,
 * and posts directly to /exchange. Logs full HTTP status + raw body so we
 * can see venue rejections that the adapter swallows.
 */

import { encode } from "@msgpack/msgpack";
import { ethers, keccak256, Wallet } from "ethers";
import { getAgent } from "../src/agent-wallet/store.js";
import { OwsEvmSigner } from "../src/signer/ows-evm.js";

const ASSET_ID = 100_000_010; // outcome=1, side=0 (Yes)
const PRICE = "0.30";          // < current best bid (~$0.583) so it rests
const SIZE = "40";             // 0.30 * 40 = 12 USDH notional, > $10 minimum

async function signAndSendCapture(action: Record<string, unknown>, signer: ethers.Signer | OwsEvmSigner): Promise<unknown> {
  const baseUrl = "https://api.hyperliquid.xyz";

  // Normalize p/s trailing zeros (replicate adapter logic)
  const normalize = (a: Record<string, unknown>): Record<string, unknown> => {
    if (a.type !== "order" || !Array.isArray(a.orders)) return a;
    return {
      ...a,
      orders: (a.orders as Record<string, unknown>[]).map(o => {
        const trim = (s: string) => s.includes(".") ? (s.replace(/\.?0+$/, "") || "0") : s;
        return { ...o, p: trim(o.p as string), s: trim(o.s as string) };
      }),
    };
  };
  const normAction = normalize(action);

  const nonce = Date.now();
  const msgPackBytes = encode(normAction);
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  // last byte = 0 (no vault) — already 0 from Uint8Array

  const hash = keccak256(data);
  const phantomDomain = {
    name: "Exchange",
    version: "1",
    chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
  const agentTypes = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };
  const phantomAgent = {
    source: "a", // mainnet
    connectionId: hash,
  };

  const sig = await signer.signTypedData(phantomDomain, agentTypes, phantomAgent);
  const parsed = ethers.Signature.from(sig);

  const payload = {
    action,
    nonce,
    signature: { r: parsed.r, s: parsed.s, v: parsed.v },
    vaultAddress: null,
  };

  console.log(`\n[POST /exchange] nonce=${nonce}`);
  console.log(`[payload]:`, JSON.stringify(payload).slice(0, 400));

  const res = await fetch(`${baseUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`[response] http=${res.status} body=${text}`);
  return JSON.parse(text);
}

async function main() {
  console.log(`[probe-β v2] direct sign+send`);
  console.log(`  asset_id: ${ASSET_ID}  price: ${PRICE}  size: ${SIZE}  side: BUY`);

  const agentMeta = getAgent("hyperliquid");
  if (!agentMeta) throw new Error("No HL agent — run: perp wallet agent approve hyperliquid");
  const agentSigner = OwsEvmSigner.create(agentMeta.agentWalletName, "");
  console.log(`  agent: ${agentMeta.agentWalletName} (${agentMeta.agentEvmAddress})`);

  // Place
  const orderAction = {
    type: "order",
    orders: [{
      a: ASSET_ID,
      b: true,
      p: PRICE,
      s: SIZE,
      r: false,
      t: { limit: { tif: "Gtc" } },
    }],
    grouping: "na",
  };
  const placeRes = await signAndSendCapture(orderAction, agentSigner as unknown as ethers.Signer);

  // Extract OID and cancel
  const r = placeRes as { status?: string; response?: { data?: { statuses?: Array<{ resting?: { oid: number }; filled?: { oid: number }; error?: string }> } } };
  const status = r.response?.data?.statuses?.[0];
  if (!status) {
    console.error(`[place] no statuses[0] — bailing`);
    return;
  }
  if (status.error) {
    console.error(`[place] FAILED: ${status.error}`);
    return;
  }
  const oid = status.resting?.oid ?? status.filled?.oid;
  if (!oid) {
    console.error(`[place] no oid in response`);
    return;
  }
  console.log(`\n[place] OK — oid=${oid} (resting=${!!status.resting})`);

  const cancelAction = {
    type: "cancel",
    cancels: [{ a: ASSET_ID, o: oid }],
  };
  await signAndSendCapture(cancelAction, agentSigner as unknown as ethers.Signer);
  console.log(`\n[probe-β v2] DONE — outcome order placement + cancel verified end-to-end`);
}

main().catch((err) => {
  console.error(`[probe-β v2] FAILED:`, err instanceof Error ? err.stack : err);
  process.exit(1);
});
