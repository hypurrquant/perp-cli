/**
 * Probe: Aster V3 `registerAndApproveAgent` signing-shape resolver.
 *
 * WHY: The live Aster V3 spec (section "Register and Approve Agent (PUBLIC)")
 * documents `POST /fapi/v3/registerAndApproveAgent` with a FLAT `msg`-string
 * EIP-712 envelope, but the page is self-contradictory on the domain chainId:
 *   - the typed_data JSON example shows  domain.chainId = 1666
 *   - the "Supported Signing Algorithms" table says chainId = 56
 * Meanwhile our adapter (`src/exchanges/aster-typed-data.ts:buildApproveAgentTypedData`)
 * still signs a STRUCTURED-field `ApproveAgent` payload at domain chainId 56 and
 * POSTs `/fapi/v3/approveAgent` — and `wallet agent verify aster` is broken
 * (see memory `aster_verify_endpoint_pending.md`).
 *
 * This probe signs the documented FLAT-`msg` envelope and submits the 2x2 matrix
 * { endpoint: registerAndApproveAgent | approveAgent } x { chainId: 1666 | 56 }
 * so you can see which combination the venue accepts. It logs the full HTTP
 * status + raw body for each, the way the adapter never does.
 *
 * SAFETY:
 *   - TESTNET ONLY. Never run against mainnet with a funded master key.
 *   - The master private key is read from env (ASTER_TESTNET_MASTER_PK) — never
 *     hard-code or commit a key. canWithdraw is forced false so no withdrawal
 *     permission is ever granted by the probe.
 *   - UNVERIFIED: this script was authored from the spec but could not be run in
 *     the authoring session (no testnet creds). Treat the first run as the test.
 *
 * RUN:
 *   ASTER_TESTNET_MASTER_PK=0x... \
 *   ASTER_TESTNET_URL=https://fapi.asterdex-testnet.com \
 *   npx tsx scripts/probe-aster-agent.ts
 */

import { Wallet } from "ethers";

const BASE_URL = process.env.ASTER_TESTNET_URL ?? "https://fapi.asterdex-testnet.com";
const PK = process.env.ASTER_TESTNET_MASTER_PK;

if (!PK) {
  console.error("Set ASTER_TESTNET_MASTER_PK (testnet master private key). Aborting.");
  process.exit(1);
}
if (!/testnet/i.test(BASE_URL)) {
  console.error(`Refusing to run against a non-testnet URL: ${BASE_URL}`);
  process.exit(1);
}

const master = new Wallet(PK);
const agent = Wallet.createRandom(); // throwaway agent address for the probe

// Per spec: nonce = microseconds; expired = milliseconds (agent validity deadline).
const nonceMicros = Date.now() * 1000;
const expiredMs = Date.now() + 24 * 60 * 60 * 1000; // +24h
const SIGNATURE_CHAIN_ID = 56; // EVM addresses (101 = Solana) — a message field, per spec

// Exact field order from the spec's Signature Instructions block.
const msg =
  `user=${master.address}` +
  `&nonce=${nonceMicros}` +
  `&agentName=probe-agent` +
  `&agentAddress=${agent.address}` +
  `&expired=${expiredMs}` +
  `&signatureChainId=${SIGNATURE_CHAIN_ID}` +
  `&canSpotTrade=true` +
  `&canPerpTrade=true` +
  `&canWithdraw=false` +
  `&ipWhitelist=`;

const MESSAGE_TYPES = { Message: [{ name: "msg", type: "string" }] };

function domain(chainId: number) {
  return {
    name: "AsterSignTransaction",
    version: "1",
    chainId,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
}

async function submit(endpoint: string, chainId: number): Promise<void> {
  const signature = await master.signTypedData(domain(chainId), MESSAGE_TYPES, { msg });
  const body = new URLSearchParams({
    user: master.address,
    nonce: String(nonceMicros),
    agentName: "probe-agent",
    agentAddress: agent.address,
    expired: String(expiredMs),
    signatureChainId: String(SIGNATURE_CHAIN_ID),
    signature,
    canSpotTrade: "true",
    canPerpTrade: "true",
    canWithdraw: "false",
    ipWhitelist: "",
  });
  const url = `${BASE_URL}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const raw = await res.text();
    console.log(`\n[${endpoint}  domain.chainId=${chainId}]  HTTP ${res.status}\n  ${raw}`);
  } catch (e) {
    console.log(`\n[${endpoint}  domain.chainId=${chainId}]  network error: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log(`Aster agent-approval probe → ${BASE_URL}`);
  console.log(`  master=${master.address}  agent=${agent.address} (throwaway)`);
  console.log(`  msg = ${msg}`);
  // 2x2 matrix: documented flat-msg envelope across both endpoints + both chainIds.
  for (const endpoint of ["/fapi/v3/registerAndApproveAgent", "/fapi/v3/approveAgent"]) {
    for (const chainId of [1666, 56]) {
      await submit(endpoint, chainId);
    }
  }
  console.log("\nDone. The variant returning {\"code\":200,\"msg\":\"success\"} is the live shape.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
