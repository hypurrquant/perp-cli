/**
 * Dashboard frontend UI — single-file HTML/CSS/JS served inline.
 */

export function getUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>perp-cli Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --green: #3fb950;
    --red: #f85149; --blue: #58a6ff; --yellow: #d29922;
    --cyan: #39d2c0; --purple: #bc8cff;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: var(--bg); color: var(--text); min-height: 100vh; }
  .header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--border); }
  .header h1 { font-size:18px; color:var(--cyan); }
  .status { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); }
  .status .dot { width:8px; height:8px; border-radius:50%; background:var(--green); }
  .status .dot.off { background:var(--red); }
  .container { padding:20px 24px; }

  /* Nav tabs */
  .nav { display:flex; gap:4px; margin-bottom:20px; border-bottom:1px solid var(--border); padding-bottom:0; }
  .nav-tab { padding:8px 16px; cursor:pointer; font-size:13px; color:var(--muted); border-bottom:2px solid transparent; transition:all 0.15s; }
  .nav-tab:hover { color:var(--text); }
  .nav-tab.active { color:var(--cyan); border-bottom-color:var(--cyan); font-weight:600; }
  .page { display:none; }
  .page.active { display:block; }

  /* Totals row */
  .totals { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:20px; }
  .total-card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:14px 16px; }
  .total-card .label { font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:4px; letter-spacing:0.5px; }
  .total-card .value { font-size:22px; font-weight:600; }
  .total-card .value.green { color:var(--green); }
  .total-card .value.red { color:var(--red); }

  /* Exchange tabs */
  .tabs { display:flex; gap:8px; margin-bottom:16px; }
  .tab { padding:6px 14px; border-radius:6px; background:var(--card); border:1px solid var(--border); cursor:pointer; font-size:13px; color:var(--muted); transition:all 0.15s; }
  .tab:hover { border-color:var(--cyan); color:var(--text); }
  .tab.active { background:var(--cyan); color:var(--bg); border-color:var(--cyan); font-weight:600; }

  /* Exchange panels */
  .exchange-panel { display:none; }
  .exchange-panel.active { display:block; }

  /* Balance bar */
  .balance-bar { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:16px; }
  .balance-item { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; }
  .balance-item .label { font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:2px; }
  .balance-item .val { font-size:17px; font-weight:500; }

  /* Tables */
  .section-title { font-size:14px; font-weight:600; margin:16px 0 8px; color:var(--cyan); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  thead th { text-align:left; padding:8px 10px; color:var(--muted); font-size:11px; text-transform:uppercase; border-bottom:1px solid var(--border); letter-spacing:0.5px; }
  tbody td { padding:8px 10px; border-bottom:1px solid var(--border); }
  tbody tr:hover { background:rgba(88,166,255,0.04); }
  .side-long { color:var(--green); font-weight:600; }
  .side-short, .side-sell { color:var(--red); font-weight:600; }
  .side-buy { color:var(--green); font-weight:600; }
  .pnl-pos { color:var(--green); }
  .pnl-neg { color:var(--red); }
  .empty-msg { color:var(--muted); font-size:13px; padding:12px 0; }

  /* Arb-specific */
  .spread-high { color:var(--green); font-weight:700; }
  .spread-mid { color:var(--yellow); font-weight:600; }
  .spread-low { color:var(--muted); }
  .viability-A { color:var(--green); font-weight:700; }
  .viability-B { color:var(--cyan); font-weight:600; }
  .viability-C { color:var(--yellow); }
  .viability-D { color:var(--muted); }
  .exchange-status { display:inline-flex; align-items:center; gap:4px; font-size:12px; margin-right:12px; }
  .exchange-status .dot-sm { width:6px; height:6px; border-radius:50%; display:inline-block; }
  .dot-ok { background:var(--green); }
  .dot-err { background:var(--red); }

  /* Arb summary cards */
  .arb-summary { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:16px; }
  .arb-card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:14px 16px; }
  .arb-card .label { font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
  .arb-card .value { font-size:20px; font-weight:600; }

  /* Funding rate heatmap-style */
  .rate-cell { font-weight:500; }
  .rate-positive { color:var(--green); }
  .rate-negative { color:var(--red); }
  .rate-neutral { color:var(--muted); }

  /* Sortable headers */
  thead th.sortable { cursor:pointer; user-select:none; transition:color 0.15s; }
  thead th.sortable:hover { color:var(--cyan); }

  /* Spread bar */
  .spread-bar { margin-top:3px; height:3px; width:100%; background:var(--border); border-radius:2px; overflow:hidden; }
  .spread-bar-fill { height:100%; border-radius:2px; transition:width 0.3s; }

  /* Event log */
  .event-log { max-height:200px; overflow-y:auto; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 14px; font-size:12px; line-height:1.6; }
  .event-log .event { border-bottom:1px solid var(--border); padding:3px 0; }
  .event-log .event:last-child { border:none; }
  .event-time { color:var(--muted); }
  .event-type { font-weight:600; }
  .event-type.warn { color:var(--yellow); }
  .event-type.crit { color:var(--red); }

  /* Dex filters */
  .dex-filters { display:flex; gap:6px; margin:8px 0; flex-wrap:wrap; }
  .dex-filter { padding:3px 10px; border-radius:4px; background:var(--card); border:1px solid var(--border); cursor:pointer; font-size:11px; color:var(--muted); transition:all 0.15s; }
  .dex-filter:hover { border-color:var(--cyan); color:var(--text); }
  .dex-filter.active { background:var(--cyan); color:var(--bg); border-color:var(--cyan); font-weight:600; }

  .footer { padding:16px 24px; text-align:center; font-size:11px; color:var(--muted); border-top:1px solid var(--border); margin-top:20px; }

  @media (max-width: 768px) {
    .balance-bar { grid-template-columns:repeat(2, 1fr); }
    .totals { grid-template-columns:repeat(2, 1fr); }
    .arb-summary { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
<div class="header">
  <h1>perp-cli dashboard</h1>
  <div class="status">
    <span class="dot" id="ws-dot"></span>
    <span id="ws-status">connecting...</span>
    <span id="last-update" style="margin-left:12px"></span>
  </div>
</div>

<div class="container">
  <!-- Top-level navigation -->
  <div class="nav">
    <div class="nav-tab active" data-page="portfolio">Portfolio</div>
    <div class="nav-tab" data-page="arb">Arb Scanner</div>
    <div class="nav-tab" data-page="dex-arb">DEX Arb</div>
    <div class="nav-tab" data-page="events">Events</div>
  </div>

  <!-- ═══ Portfolio Page ═══ -->
  <div class="page active" id="page-portfolio">
    <div class="totals" id="totals"></div>
    <div class="tabs" id="tabs"></div>
    <div id="panels"></div>
  </div>

  <!-- ═══ Arb Scanner Page ═══ -->
  <div class="page" id="page-arb">
    <div class="arb-summary" id="arb-summary"></div>
    <div id="arb-status" style="margin-bottom:12px"></div>
    <div class="section-title">Cross-Exchange Funding Arb Opportunities</div>
    <div id="arb-table"></div>
  </div>

  <!-- ═══ DEX Arb Page ═══ -->
  <div class="page" id="page-dex-arb">
    <div class="section-title">HIP-3 DEX Funding Rates</div>
    <p style="color:var(--muted);font-size:12px;margin-bottom:12px">Funding rates across Hyperliquid deployed DEXs — sorted by max spread</p>
    <div id="dex-rates-table"></div>

    <div class="section-title" style="margin-top:24px">Cross-DEX Arb Opportunities</div>
    <p style="color:var(--muted);font-size:12px;margin-bottom:12px">Best funding arb pairs across HIP-3 dexes (>10% annual spread)</p>
    <div id="dex-arb-table"></div>
  </div>

  <!-- ═══ Events Page ═══ -->
  <div class="page" id="page-events">
    <div class="section-title">Event Log</div>
    <div class="event-log" id="event-log" style="max-height:500px">
      <div class="empty-msg">Waiting for events...</div>
    </div>
  </div>
</div>

<div class="footer">perp-cli v0.3.1 &mdash; live dashboard</div>

<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let ws;
let snapshot = null;
let arbData = null;
let activeExchange = null;
let activePage = 'portfolio';
const MAX_EVENTS = 100;
const events = [];
// Dex filter: which dex prefixes to show (null = show all)
let activeDexFilters = new Set(); // empty = show all
// Arb sort state
let arbSort = { col: 'spread', dir: 'desc' };

// ── Navigation ──
$$('.nav-tab').forEach(tab => {
  tab.onclick = () => {
    activePage = tab.dataset.page;
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.page').forEach(p => p.classList.remove('active'));
    $('#page-' + activePage).classList.add('active');
  };
});

// ── WebSocket ──
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => { $('#ws-dot').className = 'dot'; $('#ws-status').textContent = 'connected'; };
  ws.onclose = () => { $('#ws-dot').className = 'dot off'; $('#ws-status').textContent = 'reconnecting...'; setTimeout(connect, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      snapshot = msg.data;
      if (msg.data.arb) arbData = msg.data.arb;
      render();
    }
    if (msg.type === 'arb') {
      arbData = msg.data;
      renderArb();
      renderDexRates();
      renderDexArb();
    }
  };
}

// ── Helpers ──
function fmt(v, d=2) { const n=Number(v)||0; return n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); }
function usdOrDash(v, d=2) { return v==null ? '-' : '$'+fmt(v,d); }
// Market row cells: prices in the row's quote currency (QFEX SAMSUNG-KRW: "220,150.00 KRW", never $); OI is BASE units (never $); funding null = "-" (not 0%).
function marketCells(m) { const q=(typeof m.quoteAsset==='string'&&m.quoteAsset!=='USD')?m.quoteAsset:null; const px=(v,d=2)=>v==null?'-':(q===null?'$'+fmt(v,d):fmt(v,d)+' '+q); const vol=m.volume24h==null&&typeof m.volume24hQuote==='string'?px(m.volume24hQuote,0):usdOrDash(m.volume24h,0); const base=String(m.symbol).split(':').pop().replace(/-PERP$/i,''); return { mark: px(m.markPrice), index: px(m.indexPrice), funding: m.fundingRate==null?'-':(Number(m.fundingRate)*100).toFixed(4)+'%', volume: vol, oi: m.openInterest==null?'-':Number(m.openInterest).toLocaleString('en-US',{maximumFractionDigits:4})+' '+base }; }
function pnlClass(v) { return Number(v)>=0?'pnl-pos':'pnl-neg'; }
function pnlSign(v) { const n=Number(v)||0; return n>=0?'+$'+fmt(Math.abs(n)):'-$'+fmt(Math.abs(n)); }
function rateClass(v) { const n=Number(v)||0; return n>0?'rate-positive':n<0?'rate-negative':'rate-neutral'; }
function spreadClass(v) { return v>=50?'spread-high':v>=20?'spread-mid':'spread-low'; }
// null = the venue value could not be read / is unknown → shown as such, never as $0.
const NA = '<span style="color:var(--yellow,#e5c07b)">unavailable</span>';
function usdOrNA(v, d=2) { return v==null ? NA : '$'+fmt(v,d); }
function pnlOrNA(v) { return v==null ? NA : pnlSign(v); }
function escHtml(v) { return String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }

// ── Portfolio Rendering ──
function renderTotals(t) {
  const pnlCls = Number(t.unrealizedPnl)>=0?'green':'red';
  $('#totals').innerHTML = [
    {label:'Total Equity',value:'$'+fmt(t.equity),cls:''},
    {label:'Available',value:'$'+fmt(t.available),cls:''},
    {label:'Margin Used',value:'$'+fmt(t.marginUsed),cls:''},
    {label:'Unrealized PnL',value:pnlSign(t.unrealizedPnl),cls:pnlCls},
    {label:'Positions',value:t.positionCount,cls:''},
    {label:'Open Orders',value:t.orderCount,cls:''},
  ].map(c=>\`<div class="total-card"><div class="label">\${c.label}\${t.partial?' (partial)':''}</div><div class="value \${c.cls}">\${c.value}</div></div>\`).join('')
  + (t.partial ? \`<div class="total-card" style="grid-column:1/-1"><div class="label">\${NA} — left out of the totals</div><div style="font-size:12px">\${escHtml((t.unavailable||[]).join(', '))}</div></div>\` : '');
}

function renderTabs(exchanges) {
  if (!activeExchange && exchanges.length) activeExchange = exchanges[0].name;
  $('#tabs').innerHTML = exchanges.map(ex=>\`<div class="tab \${ex.name===activeExchange?'active':''}" data-ex="\${ex.name}">\${ex.name}\${(ex.feed&&ex.feed.stale)||ex.error?' ⚠':''}</div>\`).join('');
  $$('.tab').forEach(tab => { tab.onclick=()=>{ activeExchange=tab.dataset.ex; render(); }; });
}

function getDex(symbol) {
  // "xyz:CL" → "xyz", "BTC" → "hl"
  return symbol.includes(':') ? symbol.split(':')[0] : 'hl';
}

function renderPanels(exchanges) {
  $('#panels').innerHTML = exchanges.map(ex => {
    const isActive = ex.name===activeExchange;
    const isHL = ex.name === 'hyperliquid';

    // For HL: detect unique dexes from positions/orders
    let dexes = [];
    // null = list could not be read (shown as unavailable, never as "no positions")
    const posKnown = ex.positions != null, ordKnown = ex.orders != null;
    let filteredPositions = ex.positions || [];
    let filteredOrders = ex.orders || [];
    if (isHL) {
      const dexSet = new Set();
      filteredPositions.forEach(p => dexSet.add(getDex(p.symbol)));
      filteredOrders.forEach(o => dexSet.add(getDex(o.symbol)));
      dexes = ['all', ...Array.from(dexSet).sort()];
      if (activeDexFilters.size > 0) {
        filteredPositions = filteredPositions.filter(p => activeDexFilters.has(getDex(p.symbol)));
        filteredOrders = filteredOrders.filter(o => activeDexFilters.has(getDex(o.symbol)));
      }
    }

    const dexFilterHtml = isHL && dexes.length > 2 ? \`<div class="dex-filters">\${dexes.map(d =>
      \`<div class="dex-filter \${d==='all' ? (activeDexFilters.size===0?'active':'') : (activeDexFilters.has(d)?'active':'')}" data-dex="\${d}">\${d}</div>\`
    ).join('')}</div>\` : '';

    // Dex balance breakdown (dex pools are subsets of main balance, not additive)
    const dexBal = ex.dexBalances || null;
    const dexBreakdown = (field) => {
      if (!dexBal || dexBal.length < 1) return '';
      return '<div style="font-size:10px;color:var(--muted);margin-top:2px">' +
        dexBal.map(d => d.name + ': ' + (d.balance ? usdOrNA(d.balance[field]) : NA)).join(' · ') + '</div>';
    };

    const bal = ex.balance || {};
    const stale = ex.feed && ex.feed.stale;
    const banner = (stale || ex.error)
      ? \`<div class="empty-msg" style="color:var(--yellow,#e5c07b)">⚠ \${stale ? 'STALE data' : 'Partial data'}\${ex.feed && ex.feed.lastOkAt ? ' (last update ' + new Date(ex.feed.lastOkAt).toLocaleTimeString() + ')' : ''}\${ex.error ? ': ' + escHtml(ex.error) : ''}</div>\`
      : '';
    return \`<div class="exchange-panel \${isActive?'active':''}" id="panel-\${ex.name}">
      \${banner}
      <div class="balance-bar">
        <div class="balance-item"><div class="label">Equity</div><div class="val">\${usdOrNA(bal.equity)}</div>\${dexBreakdown('equity')}</div>
        <div class="balance-item"><div class="label">Available</div><div class="val">\${usdOrNA(bal.available)}</div>\${dexBreakdown('available')}</div>
        <div class="balance-item"><div class="label">Margin Used</div><div class="val">\${usdOrNA(bal.marginUsed)}</div>\${dexBreakdown('marginUsed')}</div>
        <div class="balance-item"><div class="label">Unrealized PnL</div><div class="val \${pnlClass(bal.unrealizedPnl)}">\${pnlOrNA(bal.unrealizedPnl)}</div>\${dexBreakdown('unrealizedPnl')}</div>
      </div>
      <div class="section-title">Positions (\${posKnown ? filteredPositions.length : '?'}\${isHL && posKnown && activeDexFilters.size>0 ? '/'+ex.positions.length : ''})</div>
      \${dexFilterHtml}
      \${filteredPositions.length?\`<table><thead><tr>\${isHL?'<th>DEX</th>':''}<th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq</th><th>Value</th><th>PnL</th><th>ROE%</th><th>Lev</th></tr></thead><tbody>\${filteredPositions.map(p=>{
        const dex = getDex(p.symbol);
        const sym = p.symbol.includes(':') ? p.symbol.split(':').slice(1).join(':') : p.symbol;
        const notional = p.markPrice == null ? null : Math.abs(Number(p.size)) * Number(p.markPrice);
        const margin = notional == null ? null : p.leverage > 0 ? notional / p.leverage : notional;
        const roe = margin != null && margin > 0 && p.unrealizedPnl != null ? (Number(p.unrealizedPnl) / margin * 100) : null;
        return \`<tr>\${isHL?\`<td style="color:var(--purple);font-size:11px">\${dex}</td>\`:''}<td>\${sym}</td><td class="side-\${p.side}">\${p.side.toUpperCase()}</td><td>\${p.size}</td><td>\${usdOrNA(p.entryPrice)}</td><td>\${usdOrNA(p.markPrice)}</td><td>\${(p.liquidationPrice==null||p.liquidationPrice==='N/A')?'-':'$'+fmt(p.liquidationPrice)}</td><td style="color:var(--muted)">\${usdOrNA(notional)}</td><td class="\${pnlClass(p.unrealizedPnl)}">\${pnlOrNA(p.unrealizedPnl)}</td><td class="\${pnlClass(p.unrealizedPnl)}">\${roe==null?NA:(roe>=0?'+':'')+fmt(roe,1)+'%'}</td><td>\${p.leverage}x</td></tr>\`;
      }).join('')}</tbody></table>\`:(posKnown?'<div class="empty-msg">No open positions</div>':'<div class="empty-msg">Positions '+NA+'</div>')}
      <div class="section-title">Open Orders (\${ordKnown ? filteredOrders.length : '?'})</div>
      \${filteredOrders.length?\`<table><thead><tr>\${isHL?'<th>DEX</th>':''}<th>Symbol</th><th>Side</th><th>Type</th><th>Price</th><th>Size</th><th>Filled</th><th>Status</th></tr></thead><tbody>\${filteredOrders.map(o=>{
        const dex = getDex(o.symbol);
        const sym = o.symbol.includes(':') ? o.symbol.split(':').slice(1).join(':') : o.symbol;
        return \`<tr>\${isHL?\`<td style="color:var(--purple);font-size:11px">\${dex}</td>\`:''}<td>\${sym}</td><td class="side-\${o.side}">\${o.side.toUpperCase()}</td><td>\${o.type}</td><td>$\${fmt(o.price)}</td><td>\${o.size}</td><td>\${o.filled}</td><td>\${o.status}</td></tr>\`;
      }).join('')}</tbody></table>\`:(ordKnown?'<div class="empty-msg">No open orders</div>':'<div class="empty-msg">Open orders '+NA+'</div>')}
      <div class="section-title">Markets (Top 10)</div>
      \${ex.topMarkets.length?\`<table><thead><tr><th>Symbol</th><th>Mark</th><th>Index</th><th>Funding</th><th>24h Vol</th><th>OI</th><th>Max Lev</th></tr></thead><tbody>\${ex.topMarkets.map(m=>{const fr=Number(m.fundingRate);const c=marketCells(m);return\`<tr><td>\${m.symbol}</td><td>\${c.mark}</td><td>\${c.index}</td><td class="\${rateClass(fr)}">\${c.funding}</td><td>\${c.volume}</td><td>\${c.oi}</td><td>\${m.maxLeverage==null?'-':m.maxLeverage+'x'}</td></tr>\`;}).join('')}</tbody></table>\`:'<div class="empty-msg">No market data</div>'}
    </div>\`;
  }).join('');

  // Bind dex filter clicks
  $$('.dex-filter').forEach(btn => {
    btn.onclick = () => {
      const dex = btn.dataset.dex;
      if (dex === 'all') {
        activeDexFilters.clear();
      } else {
        if (activeDexFilters.has(dex)) {
          activeDexFilters.delete(dex);
        } else {
          activeDexFilters.add(dex);
        }
      }
      render();
    };
  });
}

// ── Arb Rendering ──
function renderArb() {
  if (!arbData) { $('#arb-table').innerHTML='<div class="empty-msg">Loading arb data...</div>'; return; }

  // Status (hover shows the venue's error message)
  const escapeHtml = (v) => String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  const statusHtml = Object.entries(arbData.exchangeStatus||{}).map(([ex,st])=>
    \`<span class="exchange-status" title="\${escapeHtml((arbData.exchangeErrors||{})[ex]||'')}"><span class="dot-sm \${st==='ok'?'dot-ok':'dot-err'}"></span>\${ex}</span>\`
  ).join('');
  $('#arb-status').innerHTML = statusHtml;

  // Summary cards
  const opps = arbData.opportunities || [];
  const bestSpread = opps.length ? opps[0].spreadAnnual : 0;
  const bestDaily = opps.length ? Math.max(...opps.map(o=>o.estHourlyUsd*24)) : 0;
  const totalOpps = opps.length;
  const highSpread = opps.filter(o=>o.spreadAnnual>=50).length;
  $('#arb-summary').innerHTML = [
    {label:'Best Spread',value:fmt(bestSpread,1)+'%',cls:bestSpread>=50?'green':''},
    {label:'Best Daily ($1k)',value:'$'+fmt(bestDaily,2),cls:bestDaily>1?'green':''},
    {label:'Opportunities (>5%)',value:totalOpps,cls:''},
    {label:'High Spread (>50%)',value:highSpread,cls:highSpread>0?'green':''},
  ].map(c=>\`<div class="arb-card"><div class="label">\${c.label}</div><div class="value \${c.cls}">\${c.value}</div></div>\`).join('');

  if (!opps.length) { $('#arb-table').innerHTML='<div class="empty-msg">No arb opportunities found (>5% annual spread)</div>'; return; }

  // Sort
  const sorted = [...opps].sort((a,b) => {
    let va, vb;
    switch(arbSort.col) {
      case 'symbol': return arbSort.dir==='asc'?a.symbol.localeCompare(b.symbol):b.symbol.localeCompare(a.symbol);
      case 'spread': va=a.spreadAnnual; vb=b.spreadAnnual; break;
      case 'income': va=a.estHourlyUsd; vb=b.estHourlyUsd; break;
      default: va=a.spreadAnnual; vb=b.spreadAnnual;
    }
    return arbSort.dir==='asc' ? va-vb : vb-va;
  });

  const maxSpread = Math.max(...opps.map(o=>o.spreadAnnual), 1);
  const sortH = (col, label) => {
    const active = arbSort.col===col;
    const arrow = active ? (arbSort.dir==='desc'?' \\u2193':' \\u2191') : '';
    return \`<th class="sortable" data-sort="\${col}" style="\${active?'color:var(--cyan)':''}">\${label}\${arrow}</th>\`;
  };

  $('#arb-table').innerHTML = \`<table id="arb-tbl">
    <thead><tr>
      \${sortH('symbol','Symbol')}
      \${sortH('spread','Spread')}
      <th>Strategy</th>
      <th>Mark</th>
      \${sortH('income','Est Income ($1k)')}
      \${['pacifica','hyperliquid','lighter'].map(e=>\`<th>\${e.slice(0,3).toUpperCase()}</th>\`).join('')}
    </tr></thead>
    <tbody>\${sorted.map(o => {
      const rateMap = {};
      o.rates.forEach(r => rateMap[r.exchange] = r);
      const daily = o.estHourlyUsd * 24;
      const monthly = daily * 30;
      const barW = Math.min(100, (o.spreadAnnual / maxSpread) * 100);
      const barColor = o.spreadAnnual>=50?'var(--green)':o.spreadAnnual>=20?'var(--yellow)':'var(--muted)';
      const bestMark = o.rates.reduce((best,r) => r.markPrice>0?r.markPrice:best, 0);
      return \`<tr>
        <td style="font-weight:600">\${o.symbol}</td>
        <td>
          <div class="\${spreadClass(o.spreadAnnual)}">\${fmt(o.spreadAnnual,1)}%</div>
          <div class="spread-bar"><div class="spread-bar-fill" style="width:\${barW}%;background:\${barColor}"></div></div>
        </td>
        <td>
          <div style="font-size:12px"><span class="side-long">Long</span> <span style="color:var(--cyan);font-weight:600">\${o.longExchange.slice(0,3).toUpperCase()}</span></div>
          <div style="font-size:12px"><span class="side-short">Short</span> <span style="color:var(--cyan);font-weight:600">\${o.shortExchange.slice(0,3).toUpperCase()}</span></div>
        </td>
        <td style="color:var(--muted);font-size:12px">\${bestMark>0?'$'+fmt(bestMark):'-'}</td>
        <td>
          <div style="font-weight:600;color:\${daily>0?'var(--green)':'var(--muted)'}">\${daily>0?'$'+fmt(daily,2)+'/d':'-'}</div>
          <div style="font-size:11px;color:var(--muted)">\${monthly>0?'$'+fmt(monthly,0)+'/mo':''}</div>
        </td>
        \${['pacifica','hyperliquid','lighter'].map(ex => {
          const r = rateMap[ex];
          if (!r) return '<td style="text-align:center;color:var(--muted)">-</td>';
          return \`<td style="text-align:center">
            <div class="rate-cell \${rateClass(r.annualizedPct)}" style="font-size:12px">\${(r.hourlyRate*100).toFixed(4)}%/h</div>
            <div style="font-size:10px;color:var(--muted)">\${fmt(r.annualizedPct,1)}% ann.</div>
          </td>\`;
        }).join('')}
      </tr>\`;
    }).join('')}</tbody>
  </table>\`;

  // Bind sort clicks
  $$('#arb-tbl th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (arbSort.col===col) { arbSort.dir = arbSort.dir==='desc'?'asc':'desc'; }
      else { arbSort.col=col; arbSort.dir='desc'; }
      renderArb();
    };
  });
}

function renderDexRates() {
  if (!arbData) { $('#dex-rates-table').innerHTML='<div class="empty-msg">Loading HIP-3 rates...</div>'; return; }
  const assets = arbData.dexAssets || [];
  const dexNames = arbData.dexNames || [];
  if (!assets.length) { $('#dex-rates-table').innerHTML='<div class="empty-msg">No HIP-3 DEX data available</div>'; return; }
  $('#dex-rates-table').innerHTML = \`<table>
    <thead><tr><th>Asset</th><th>Spread</th>\${dexNames.map(d=>\`<th>\${d}</th>\`).join('')}</tr></thead>
    <tbody>\${assets.map(a => {
      const rateMap = {};
      a.dexes.forEach(d => rateMap[d.dex] = d);
      const rates = a.dexes.map(d=>d.annualizedPct);
      const spread = rates.length>=2 ? Math.max(...rates)-Math.min(...rates) : 0;
      return \`<tr>
        <td>\${a.base}</td>
        <td class="\${spreadClass(spread)}">\${fmt(spread,1)}%</td>
        \${dexNames.map(dn => {
          const d = rateMap[dn];
          if (!d) return '<td class="rate-neutral" style="font-size:11px">-</td>';
          const title = '$'+fmt(d.markPrice)+' | OI: $'+fmt(d.oi,0);
          return \`<td class="rate-cell \${rateClass(d.annualizedPct)}" title="\${title}" style="font-size:11px;cursor:help">\${fmt(d.annualizedPct,1)}%</td>\`;
        }).join('')}
      </tr>\`;
    }).join('')}</tbody>
  </table>\`;
}

function renderDexArb() {
  if (!arbData) { $('#dex-arb-table').innerHTML='<div class="empty-msg">Loading DEX arb data...</div>'; return; }
  const dex = arbData.dexArb || [];
  if (!dex.length) { $('#dex-arb-table').innerHTML='<div class="empty-msg">No DEX arb opportunities found (>10% annual spread)</div>'; return; }
  $('#dex-arb-table').innerHTML = \`<table>
    <thead><tr><th>Underlying</th><th>Spread (Ann.)</th><th>Long (low rate)</th><th>Short (high rate)</th><th>Price Gap</th><th>Viability</th></tr></thead>
    <tbody>\${dex.map(d=>\`<tr>
      <td>\${d.underlying}</td>
      <td class="\${spreadClass(d.annualSpread)}">\${fmt(d.annualSpread,1)}%</td>
      <td class="side-long">\${d.longDex}</td>
      <td class="side-short">\${d.shortDex}</td>
      <td>\${fmt(d.priceGapPct,2)}%</td>
      <td class="viability-\${d.viability}">\${d.viability}</td>
    </tr>\`).join('')}</tbody>
  </table>\`;
}

// ── Events ──
function addEvent(type, exchange, data) {
  const time = new Date().toLocaleTimeString();
  const isWarn = type.includes('warning');
  const isCrit = type.includes('margin_call') || type.includes('critical');
  events.unshift({time,type,exchange,data,isWarn,isCrit});
  if (events.length > MAX_EVENTS) events.pop();
  renderEvents();
}

function renderEvents() {
  const el = $('#event-log');
  if (!events.length) { el.innerHTML='<div class="empty-msg">Waiting for events...</div>'; return; }
  el.innerHTML = events.map(e => {
    const cls = e.isCrit?'crit':e.isWarn?'warn':'';
    return \`<div class="event"><span class="event-time">\${e.time}</span> <span class="event-type \${cls}">[\${e.type}]</span> <span>\${e.exchange}</span> <span style="color:var(--muted)">\${JSON.stringify(e.data).slice(0,120)}</span></div>\`;
  }).join('');
}

let prevSnapshot = null;
function detectEvents(snap) {
  if (!prevSnapshot) { prevSnapshot = snap; return; }
  for (const ex of snap.exchanges) {
    const prev = prevSnapshot.exchanges.find(e => e.name === ex.name);
    if (!prev) continue;
    // An unread (null) side is not a change — no opened/closed events from a failed read.
    if (prev.positions && ex.positions) {
      const prevSyms = new Set(prev.positions.map(p => p.symbol));
      const currSyms = new Set(ex.positions.map(p => p.symbol));
      for (const p of ex.positions) { if (!prevSyms.has(p.symbol)) addEvent('position_opened', ex.name, {symbol:p.symbol,side:p.side,size:p.size}); }
      for (const p of prev.positions) { if (!currSyms.has(p.symbol)) addEvent('position_closed', ex.name, {symbol:p.symbol,side:p.side}); }
    }
    if (prev.balance && ex.balance) {
      const eqDelta = Math.abs(Number(ex.balance.equity) - Number(prev.balance.equity));
      if (eqDelta > 0.01) addEvent('balance_update', ex.name, {equity:ex.balance.equity,delta:eqDelta.toFixed(2)});
    }
  }
  prevSnapshot = snap;
}

// ── Main render ──
function render() {
  if (!snapshot) return;
  renderTotals(snapshot.totals);
  renderTabs(snapshot.exchanges);
  renderPanels(snapshot.exchanges);
  renderArb();
  renderDexRates();
  renderDexArb();
  $('#last-update').textContent = new Date(snapshot.timestamp).toLocaleTimeString();
  detectEvents(snapshot);
}

connect();
</script>
</body>
</html>`;
}
