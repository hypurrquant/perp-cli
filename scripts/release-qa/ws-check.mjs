// Live WS checks of an INSTALLED @hypurrquant/perp-ws (run from the release-QA install dir, so the
// import resolves to the published package). Adapted from the 0.15.0 live QA scripts (qa-ws/venue.mjs,
// errors.mjs, zeroes.mjs). Prints one JSON report on stdout: { checks: [{ id, ok, detail }] } with the
// conformance ids ws:<venue>:<check> (src/__tests__/conformance/known-failures.ts).
//   node ws-check.mjs [seconds=12]
import * as lib from "@hypurrquant/perp-ws/node";

const SECS = Number(process.argv[2] ?? 12);
const DEC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
// Documented funding table (skills/perp-cli/references/ws-library.md §4).
const RATE_KIND = { hyperliquid: "accruing", pacifica: "lastSettled", lighter: "lastSettled", "lighter-rh": "lastSettled", aster: "accruing", arcus: "lastSettled" };
const CODECS = ["hyperliquid", "pacifica", "lighter", "lighterRh", "aster", "arcus"];
const checks = [];
const check = (id, failure) => checks.push({ id, ok: failure === null, detail: failure });

async function venue(name) {
  const stream = lib.createVenueStream(lib[name]);
  const v = stream.venue;
  const states = [stream.state.status];
  stream.onState(s => { if (states.at(-1) !== s.status) states.push(s.status); });
  let dir = [];
  try { dir = await stream.markets(); } catch (e) { check(`ws:${v}:directory`, `${e?.structured?.code ?? e?.code} ${e?.message}`); }
  const events = [];
  const bbos = [];
  stream.subscribe({ kind: "allMarkets" }).on(e => { if (e.type === "market" && events.length < 20000) events.push(e); });
  const btc = dir.find(m => m.canonical === "BTC");
  if (btc && JSON.stringify(stream.capabilities?.channels ?? "").includes("bbo")) {
    stream.subscribe({ kind: "market", symbol: btc.symbol, channels: ["bbo"] }).on(e => { if (e.type === "bbo") bbos.push(e); });
  }
  const bad = stream.subscribe({ kind: "allMarkets", canonicals: ["NOPEXYZ"] });
  bad.on(() => {});
  const readyErr = await bad.ready.then(() => null, e => e);
  await new Promise(r => setTimeout(r, SECS * 1000));
  await stream.close();

  check(`ws:${v}:stream-schema`, events.length === 0 ? "no market event" : events.every(e => e.schema === 1) ? null : "event without schema 1");
  const nonDec = [];
  const zero = new Set();
  for (const e of events) {
    for (const [k, x] of Object.entries({ mark: e.mark, index: e.index, bestBid: e.bestBid, bestAsk: e.bestAsk, last: e.last, rate: e.funding.rate, predictedRate: e.funding.predictedRate, oi: e.openInterest.value, vol: e.volume24hNotional })) {
      if (x === undefined || (x !== null && (typeof x !== "string" || !DEC.test(x)))) nonDec.push(`${e.symbol}.${k}=${x}`);
    }
    for (const k of ["mark", "index", "bestBid", "bestAsk", "last"]) if (e[k] !== null && Number(e[k]) === 0) zero.add(`${e.symbol}.${k}`);
  }
  check(`ws:${v}:stream-decimals`, nonDec.length === 0 ? null : nonDec.slice(0, 5).join(", "));
  check(`ws:${v}:stream-no-zero-placeholder`, zero.size === 0 ? null : `"0" for no data: ${[...zero].slice(0, 6).join(", ")} (${zero.size})`);
  const kinds = events.filter(e => e.funding.rate !== null && e.funding.rateKind !== RATE_KIND[v]).map(e => `${e.symbol}:${e.funding.rateKind}`);
  check(`ws:${v}:stream-rate-kind`, kinds.length === 0 ? null : kinds.slice(0, 3).join(","));
  if (bbos.length > 0) {
    const crossed = bbos.filter(b => b.bid !== null && b.ask !== null && !(Number(b.bid) < Number(b.ask))).length;
    check(`ws:${v}:bbo`, crossed === 0 ? null : `${crossed} crossed / locked bbo`);
  }
  check(`ws:${v}:state-sequence`, JSON.stringify(states.filter(s => s !== "stale")) === JSON.stringify(["idle", "connecting", "live", "closed"]) ? null : states.join(" → "));
  check(`ws:${v}:ready-code`, readyErr === null ? "ready resolved for an unknown canonical" : readyErr.code === "INVALID_PARAMS" ? null : `.code=${readyErr.code} structured.code=${readyErr.structured?.code}`);
}

for (const c of CODECS) await venue(c);
// close() leaves nothing behind: the process must be idle (no timers / sockets) right after.
const handles = process.getActiveResourcesInfo().filter(h => h === "Timeout" || h === "TCPWRAP" || h === "TLSWRAP");
check("ws:all:close-timers", handles.length === 0 ? null : `active after close(): ${handles.join(", ")}`);
console.log(JSON.stringify({ checks }, null, 1));
