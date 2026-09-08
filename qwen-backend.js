// qwen-backend.js v2 - relay + multi-source market-data proxy
// browser -> THIS backend (/feed WS + /api REST) -> Coinbase/Exchange/Bitstamp -> real data
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8787;
const UPSTREAM = 'wss://advanced-trade-ws.coinbase.com';
const PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const BITSTAMP = { 'BTC-USD': 'btcusd', 'ETH-USD': 'ethusd', 'SOL-USD': 'solusd' };
const GRAN_SECONDS = { ONE_MINUTE: 60, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900, THIRTY_MINUTE: 1800, ONE_HOUR: 3600, TWO_HOUR: 7200, SIX_HOUR: 21600, ONE_DAY: 86400 };
let upstream = null, upstreamState = 'IDLE', attempts = 0;

function log(m) { console.log('[qwen-backend] ' + new Date().toISOString() + ' ' + m); }
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function getJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function tickers(product) {
  try {
    const j = await getJSON('https://api.coinbase.com/api/v3/brokerage/market/tickers?product_id=' + product);
    const t = j && j.tickers && j.tickers[0];
    if (t && isFinite(parseFloat(t.price))) return { tickers: [{ price: parseFloat(t.price), price_percent_change_24h: parseFloat(t.price_percent_change_24h) }], source: 'coinbase-v3' };
  } catch (e) { log('tickers v3 ' + product + ' failed: ' + e.message); }
  try {
    const s = await getJSON('https://api.exchange.coinbase.com/products/' + product + '/stats');
    const last = parseFloat(s.last), open = parseFloat(s.open);
    if (isFinite(last)) return { tickers: [{ price: last, price_percent_change_24h: isFinite(open) && open ? ((last - open) / open) * 100 : null }], source: 'coinbase-exchange' };
  } catch (e) { log('tickers exchange ' + product + ' failed: ' + e.message); }
  const pair = BITSTAMP[product];
  if (pair) {
    try {
      const b = await getJSON('https://www.bitstamp.net/api/v2/ticker/' + pair + '/');
      const last = parseFloat(b.last);
      if (isFinite(last)) return { tickers: [{ price: last, price_percent_change_24h: parseFloat(b.percent_change_24h) }], source: 'bitstamp' };
    } catch (e) { log('tickers bitstamp ' + product + ' failed: ' + e.message); }
  }
  const err = new Error('all ticker sources failed'); err.status = 502; throw err;
}

async function candles(product, gran, limit) {
  const sec = GRAN_SECONDS[gran] || parseInt(gran, 10) || 900;
  try {
    const j = await getJSON('https://api.coinbase.com/api/v3/brokerage/market/candles?product_id=' + product + '&granularity=' + gran + '&limit=' + (limit || 300));
    if (j && Array.isArray(j.candles) && j.candles.length) {
      return { candles: j.candles.map(function (c) { return { start: +c.start, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume }; }).reverse(), source: 'coinbase-v3' };
    }
  } catch (e) { log('candles v3 ' + product + ' failed: ' + e.message); }
  try {
    const rows = await getJSON('https://api.exchange.coinbase.com/products/' + product + '/candles?granularity=' + sec);
    if (Array.isArray(rows) && rows.length) {
      return { candles: rows.map(function (r) { return { start: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }; }).reverse(), source: 'coinbase-exchange' };
    }
  } catch (e) { log('candles exchange ' + product + ' failed: ' + e.message); }
  const pair = BITSTAMP[product];
  if (pair) {
    try {
      const b = await getJSON('https://www.bitstamp.net/api/v2/ohlc/' + pair + '/?step=' + sec + '&limit=' + Math.min(limit || 300, 1000));
      const ohlc = b && b.data && b.data.ohlc;
      if (Array.isArray(ohlc) && ohlc.length) {
        return { candles: ohlc.map(function (c) { return { start: +c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume }; }), source: 'bitstamp' };
      }
    } catch (e) { log('candles bitstamp ' + product + ' failed: ' + e.message); }
  }
  const err = new Error('all candle sources failed'); err.status = 502; throw err;
}

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/performance') { json(res, 200, PERF.snapshotJSON()); return; }
  if (u.pathname === '/api/health') { json(res, 200, { ok: true, upstream: upstreamState }); return; }
  if (u.pathname === '/api/canonical') { json(res, 200, { publishers: publisherSockets.size, rejects: canonRejects, assets: Object.keys(CANON).map(function (k) { return { asset: k, lastPublish: CANON[k].lastPublish, state: CANON[k].state }; }) }); return; }
  if (u.pathname === '/api/tickers') {
    try { const j = await tickers(u.searchParams.get('product_id') || 'BTC-USD'); log('tickers ' + (u.searchParams.get('product_id') || 'BTC-USD') + ' via ' + j.source); json(res, 200, j); }
    catch (e) { json(res, e.status || 502, { error: String(e.message) }); }
    return;
  }
  if (u.pathname === '/api/candles') {
    try {
      const j = await candles(u.searchParams.get('product_id') || 'BTC-USD', u.searchParams.get('granularity') || 'FIFTEEN_MINUTE', parseInt(u.searchParams.get('limit'), 10) || 300);
      log('candles ' + (u.searchParams.get('product_id') || 'BTC-USD') + ' via ' + j.source);
      json(res, 200, j);
    } catch (e) { json(res, e.status || 502, { error: String(e.message) }); }
    return;
  }
  let file = u.pathname === '/' ? 'qwen-watcher.html' : decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  if (file.indexOf('..') !== -1) { res.writeHead(400); res.end('bad path'); return; }
  const fp = path.join(__dirname, file);
  fs.readFile(fp, function (err, buf) {
    if (err) {
      const any = fs.readdirSync(__dirname).find(function (f) { return f.endsWith('.html'); });
      if (any) {
        fs.readFile(path.join(__dirname, any), function (e2, b2) {
          if (e2) { res.writeHead(404); res.end('not found'); }
          else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(b2); }
        });
      } else { res.writeHead(404); res.end('Save qwen-watcher.html next to qwen-backend.js'); }
      return;
    }
    const ct = fp.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, ct === 'text/html' ? { 'Content-Type': ct, 'Cache-Control': 'no-store, must-revalidate' } : { 'Content-Type': ct });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/feed' });
const PERF = require('./qwen-signal-performance.js');
PERF.init({ log: log, broadcast: function (obj) { for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify(obj)); } });
PERF.onClose(function (rec) { try { const tm = require('./qwen-telegram.js'); const v2 = tm.v2 && tm.v2(); if (v2 && v2.notifyClosed) v2.notifyClosed(rec.asset, PERF.closedText(rec)); } catch (e) {} });

/* ---- CANONICAL SNAPSHOT STORE (owned by backend) + Telegram wiring ---- */
const CANON = {};
PRODUCTS.forEach(function (p) { CANON[p.split('-')[0]] = { state: null, lastPublish: 0 }; });
const publisherSockets = new Set();
let canonRejects = 0;
function numOk(x) { return typeof x === 'number' && isFinite(x); }
function validateSnapshot(f) {
  if (!f || f.type !== 'qwen-state' || f.v !== 1) return null;
  if (typeof f.asset !== 'string' || !CANON[f.asset]) return null;
  if (f.dataQuality !== 'ok' && f.dataQuality !== 'ok-partial') return null;
  if (!numOk(f.ts) || Date.now() - f.ts > 120000) return null;
  if (!numOk(f.price)) return null;
  if (typeof f.signal !== 'string' || ['BUY', 'SELL', 'WAIT'].indexOf(f.signal) === -1) return null;
  if (!numOk(f.confidence) || f.confidence < 0 || f.confidence > 100) return null;
  if (typeof f.tf !== 'string') return null;
  const optNum = function (x) { return x === null || numOk(x); };
  if (!optNum(f.entryLow) || !optNum(f.entryHigh) || !optNum(f.stop) || !optNum(f.target)) return null;
  if (f.pct !== null && !numOk(f.pct)) return null;
  if (f.regime !== null && typeof f.regime !== 'string') return null;
  return f;
}
function validateEvent(f) {
  if (!f || f.type !== 'qwen-event' || f.v !== 1) return null;
  if (typeof f.asset !== 'string' || !CANON[f.asset]) return null;
  if (['signal-flip', 'window-invalidated'].indexOf(f.event) === -1) return null;
  if (!numOk(f.ts) || Date.now() - f.ts > 120000) return null;
  return f;
}
let TG = null;
try {
  TG = require('./qwen-telegram.js');
  TG.init({
    getCanonical: function () { return CANON; },
    getUpstream: function () { return upstreamState; },
    getPublishers: function () { return publisherSockets.size; },
    log: log
  });
} catch (e) { TG = null; log('telegram module load failed (app continues): ' + e.message); }


function connectUpstream() {
  attempts++;
  upstreamState = 'CONNECTING';
  log('connecting ' + UPSTREAM + ' attempt ' + attempts);
  upstream = new WebSocket(UPSTREAM);
  upstream.onopen = function () {
    attempts = 0;
    upstreamState = 'OPEN';
    log('upstream OPEN - subscribing ticker + heartbeats + market_trades');
    upstream.send(JSON.stringify({ type: 'subscribe', product_ids: PRODUCTS, channel: 'ticker', timestamp: new Date().toISOString() }));
    upstream.send(JSON.stringify({ type: 'subscribe', product_ids: PRODUCTS, channel: 'heartbeats', timestamp: new Date().toISOString() }));
    upstream.send(JSON.stringify({ type: 'subscribe', product_ids: PRODUCTS, channel: 'market_trades', timestamp: new Date().toISOString() }));
  };
  upstream.onmessage = function (ev) {
  try { const um = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); if (um && um.channel === 'market_trades') { for (const e of um.events || []) for (const t of e.trades || []) { const p = parseFloat(t.price); if (isFinite(p)) PERF.onTrade(String(t.product_id || '').split('-')[0], p, Date.now()); } } } catch (e) {}
    const data = typeof ev.data === 'string' ? ev.data : ev.data.toString();
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };
  upstream.onclose = function () {
    upstreamState = 'CLOSED';
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempts, 5)));
    log('upstream CLOSED - retry in ' + delay + 'ms');
    setTimeout(connectUpstream, delay);
  };
  upstream.onerror = function (e) { log('upstream ERROR ' + (e.message || 'unknown')); };
}

wss.on('connection', function (ws) {
  log('frontend connected');
  ws.send(JSON.stringify({ type: 'hello', service: 'qwen-backend', upstream: UPSTREAM, upstreamState: upstreamState }));
  ws.on('message', function (data) {
    let f = null;
    try { f = JSON.parse(data.toString()); } catch (e) { return; }
    if (f && f.type === 'qwen-state') {
      const v = validateSnapshot(f);
      if (!v) { canonRejects++; return; }
      CANON[v.asset].state = v;
      try { PERF.onState(v); } catch (e) {}
      CANON[v.asset].lastPublish = Date.now();
      publisherSockets.add(ws);
    } else if (f && f.type === 'qwen-event') {
      const v = validateEvent(f);
      if (!v) return;
      publisherSockets.add(ws);
      if (TG) { try { TG.onEvent(v); } catch (e) { log('telegram dispatch error: ' + e.message); } }
    }
  });
  ws.on('close', function () { publisherSockets.delete(ws); });
});

setInterval(function () {
  if (upstream && upstream.readyState === 1) upstream.ping();
}, 20000);

server.listen(PORT, function () {
  log('QWEN backend ready - open http://localhost:' + PORT);
  connectUpstream();
});
