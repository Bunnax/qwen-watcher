// patch-telegram.js - deterministic insertions into existing files.
// Fails loudly if anchors are missing or files already patched. No rewrites.
const fs = require('fs');
const A = "const wss = new WebSocketServer({ server, path: '/feed' });";
const B = "  ws.send(JSON.stringify({ type: 'hello', service: 'qwen-backend', upstream: UPSTREAM, upstreamState: upstreamState }));\n});";
const C = "  if (u.pathname === '/api/health') { json(res, 200, { ok: true, upstream: upstreamState }); return; }";

let s = fs.readFileSync('qwen-backend.js', 'utf8');
if (s.indexOf('CANON') !== -1) { console.error('ABORT: qwen-backend.js already patched'); process.exit(1); }
if (s.indexOf(A) === -1) { console.error('ABORT: anchor A not found'); process.exit(1); }
if (s.indexOf(B) === -1) { console.error('ABORT: anchor B not found'); process.exit(1); }

const INSERT_A = `
/* ---- CANONICAL SNAPSHOT STORE (owned by backend) + Telegram wiring ---- */
const CANON = {};
PRODUCTS.forEach(function (p) { CANON[p.split('-')[0]] = { state: null, lastPublish: 0 }; });
const publisherSockets = new Set();
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
`;

const INSERT_B = `  ws.on('message', function (data) {
    let f = null;
    try { f = JSON.parse(data.toString()); } catch (e) { return; }
    if (f && f.type === 'qwen-state') {
      const v = validateSnapshot(f);
      if (!v) return;
      CANON[v.asset].state = v;
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
`;

s = s.replace(A, A + '\n' + INSERT_A);
s = s.replace(B, "  ws.send(JSON.stringify({ type: 'hello', service: 'qwen-backend', upstream: UPSTREAM, upstreamState: upstreamState }));\n" + INSERT_B + "});");
if (s.indexOf(C) !== -1) {
  s = s.replace(C, C + "\n  if (u.pathname === '/api/canonical') { json(res, 200, { publishers: publisherSockets.size, assets: Object.keys(CANON).map(function (k) { return { asset: k, lastPublish: CANON[k].lastPublish, state: CANON[k].state }; }) }); return; }");
} else { console.warn('warn: anchor C not found - skipping optional /api/canonical route'); }
fs.writeFileSync('qwen-backend.js', s);
console.log('backend patched: 2 mandatory insertions + optional /api/canonical');

let h = fs.readFileSync('qwen-watcher.html', 'utf8');
if (h.indexOf('qwen-state') !== -1) { console.error('ABORT: frontend already patched'); process.exit(1); }
const idx = h.lastIndexOf('</body>');
if (idx === -1) { console.error('ABORT: </body> not found in frontend'); process.exit(1); }
const PUB = fs.readFileSync('publisher-block.txt', 'utf8').trim() + '\n';
h = h.slice(0, idx) + PUB + h.slice(idx);
fs.writeFileSync('qwen-watcher.html', h);
console.log('frontend patched: publisher tail module appended, 0 existing lines changed');
