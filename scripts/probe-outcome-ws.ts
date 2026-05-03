/**
 * Probe α: HL Outcome WebSocket subscription.
 *
 * Subscribes to l2Book and trades for outcome #10 (BTC binary Yes side) and
 * logs the first few messages from each stream. Run with:
 *   pnpm tsx scripts/probe-outcome-ws.ts
 */

import WebSocket from "ws";

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const COIN = "#10";
const MAX_MSGS_PER_STREAM = 3;

const counts = { l2Book: 0, trades: 0 };

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log(`[ws] connected to ${WS_URL}`);

  const subL2 = { method: "subscribe", subscription: { type: "l2Book", coin: COIN } };
  const subTrades = { method: "subscribe", subscription: { type: "trades", coin: COIN } };

  ws.send(JSON.stringify(subL2));
  ws.send(JSON.stringify(subTrades));
  console.log(`[ws] subscribed: l2Book ${COIN}, trades ${COIN}`);
  console.log(`[ws] waiting for ${MAX_MSGS_PER_STREAM} msgs per stream...`);
});

ws.on("message", (raw) => {
  let msg: { channel?: string; data?: unknown };
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.log(`[ws] non-json: ${String(raw).slice(0, 200)}`);
    return;
  }

  const ch = msg.channel;
  if (ch === "subscriptionResponse") {
    console.log(`[ws] sub-ack:`, JSON.stringify(msg.data));
    return;
  }

  if (ch === "l2Book") {
    counts.l2Book += 1;
    const data = msg.data as { coin: string; time: number; levels: [unknown[], unknown[]] };
    const bids = data.levels[0];
    const asks = data.levels[1];
    const bestBid = bids[0] as { px: string; sz: string; n: number } | undefined;
    const bestAsk = asks[0] as { px: string; sz: string; n: number } | undefined;
    console.log(`[l2Book #${counts.l2Book}] coin=${data.coin} time=${data.time} bid=${bestBid?.px}@${bestBid?.sz} ask=${bestAsk?.px}@${bestAsk?.sz} (${bids.length}/${asks.length} levels)`);
  } else if (ch === "trades") {
    counts.trades += 1;
    const data = msg.data as Array<{ coin: string; side: string; px: string; sz: string; time: number }>;
    for (const t of data) {
      console.log(`[trade #${counts.trades}] ${t.coin} ${t.side === "B" ? "BUY" : "SELL"} sz=${t.sz} @ ${t.px}`);
    }
  } else {
    console.log(`[unknown channel=${ch}]`, JSON.stringify(msg).slice(0, 200));
  }

  if (counts.l2Book >= MAX_MSGS_PER_STREAM && counts.trades >= MAX_MSGS_PER_STREAM) {
    console.log(`[ws] received enough samples, closing`);
    ws.close();
  }
});

ws.on("error", (err) => {
  console.error(`[ws] error:`, err.message);
});

ws.on("close", (code, reason) => {
  console.log(`[ws] closed code=${code} reason=${reason.toString()}`);
  console.log(`[summary] l2Book=${counts.l2Book} trades=${counts.trades}`);
  process.exit(0);
});

setTimeout(() => {
  console.error(`[ws] timeout — only got l2Book=${counts.l2Book} trades=${counts.trades}`);
  ws.close();
}, 30_000);
