// qwen-backend.js - QWEN WATCHER application backend
// browser -> THIS backend (WSS /feed + HTTPS /api) -> Coinbase -> real data
// Setup: npm i ws | node qwen-backend.js | open http://localhost:8787
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8787;
const UPSTREAM = 'wss://advanced-trade-ws.coinbase.com';
const PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
let upstream = null, upstreamState = 'IDLE', attempts = 0;

function log(m) { console.log('[qwen-backend] ' + new Date().toISOString() + ' ' + m); }

function proxyCoinbase(cbPath, search, res) {
  fetch('https://api.coinbase.com' + cbPath + search, { headers: { Accept: 'application/json' } })
    .then(async function (r) {
      const body = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    })
    .catch(function (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    });
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: upstreamState }));
    return;
  }
  if (u.pathname === '/api/tickers') { proxyCoinbase('/api/v3/brokerage/market/tickers', u.search, res); return; }
  if (u.pathname === '/api/candles') { proxyCoinbase('/api/v3/brokerage/market/candles', u.search, res); return; }
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
    res.writeHead(200, { 'Content-Type': ct });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/feed' });

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
});

setInterval(function () {
  if (upstream && upstream.readyState === 1) upstream.ping();
}, 20000);

server.listen(PORT, function () {
  log('QWEN backend ready - open http://localhost:' + PORT);
  connectUpstream();
});
