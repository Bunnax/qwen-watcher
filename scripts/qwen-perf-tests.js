// Deterministic ledger tests. FIXTURES ONLY - never production data.
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
const P = require('../qwen-signal-performance.js');
let T = 1000000000000;
P.init({ log: function () {}, broadcast: function () {}, now: function () { return T; } });
function frame(a, tf, dir, conf, entry, stop, target, ts) { return { asset: a, tf: tf, signal: dir, confidence: conf, price: entry, entryLow: entry * 0.999, entryHigh: entry * 1.001, stop: stop, target: target, regime: 'BULLISH', strength: 60, volLabel: 'Moderate', momentum: 'Bullish', planStatus: 'ACTIVE', ts: ts, dataQuality: 'ok' }; }
function id(a, tf, ts, d) { return a + '|' + tf + '|' + ts + '|' + d; }
function C(a, tf, ts, d) { return P._closed.find(function (r) { return r.signalId === id(a, tf, ts, d); }); }
function O(a, tf) { return P._open.get(a + '|' + tf); }
let pass = 0, fail = 0;
function eq(n, a, b) { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + n + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); } }
function near(n, a, b) { if (Math.abs(a - b) <= 1e-6) pass++; else { fail++; console.log('FAIL ' + n + ' got ' + a + ' want ' + b); } }
// 1 BUY target
T += 1000; let ts = T; P.onState(frame('BTC', '15m', 'BUY', 70, 100, 95, 105, ts)); P.onTrade('BTC', 105, T);
eq('1 result', C('BTC', '15m', ts, 'BUY').result, 'WIN'); eq('1 reason', C('BTC', '15m', ts, 'BUY').closeReason, 'TARGET_HIT'); near('1 pnl', C('BTC', '15m', ts, 'BUY').pnlPct, 5);
// 2 BUY stop
T += 1000; ts = T; P.onState(frame('ETH', '15m', 'BUY', 70, 100, 95, 105, ts)); P.onTrade('ETH', 94.9, T);
eq('2 result', C('ETH', '15m', ts, 'BUY').result, 'LOSS'); eq('2 reason', C('ETH', '15m', ts, 'BUY').closeReason, 'STOP_HIT'); near('2 pnl', C('ETH', '15m', ts, 'BUY').pnlPct, -5.1);
// 3 SELL target
T += 1000; ts = T; P.onState(frame('SOL', '15m', 'SELL', 70, 193, 196, 189, ts)); P.onTrade('SOL', 189, T);
eq('3 result', C('SOL', '15m', ts, 'SELL').result, 'WIN'); near('3 pnl', C('SOL', '15m', ts, 'SELL').pnlPct, (193 - 189) / 193 * 100);
// 4 SELL stop
T += 1000; ts = T; P.onState(frame('SOL', '1H', 'SELL', 70, 193, 196, 189, ts)); P.onTrade('SOL', 196, T);
eq('4 result', C('SOL', '1H', ts, 'SELL').result, 'LOSS'); near('4 pnl', C('SOL', '1H', ts, 'SELL').pnlPct, (193 - 196) / 193 * 100);
// 5 BUY expiry profit
T += 1000; ts = T; P.onState(frame('BTC', '1H', 'BUY', 70, 100, 95, 105, ts)); T += 61 * 60000; P.onTrade('BTC', 102, T); P.debugTick();
eq('5 reason', C('BTC', '1H', ts, 'BUY').closeReason, 'EXPIRED'); eq('5 result', C('BTC', '1H', ts, 'BUY').result, 'WIN'); near('5 pnl', C('BTC', '1H', ts, 'BUY').pnlPct, 2);
// 6 BUY expiry loss
T += 1000; ts = T; P.onState(frame('BTC', '4H', 'BUY', 70, 100, 95, 105, ts)); T += 241 * 60000; P.onTrade('BTC', 99, T); P.debugTick();
eq('6 result', C('BTC', '4H', ts, 'BUY').result, 'LOSS'); eq('6 reason', C('BTC', '4H', ts, 'BUY').closeReason, 'EXPIRED');
// 7 SELL expiry profit
T += 1000; ts = T; P.onState(frame('ETH', '1H', 'SELL', 70, 100, 105, 95, ts)); T += 61 * 60000; P.onTrade('ETH', 98, T); P.debugTick();
eq('7 result', C('ETH', '1H', ts, 'SELL').result, 'WIN'); eq('7 reason', C('ETH', '1H', ts, 'SELL').closeReason, 'EXPIRED');
// 8 SELL expiry loss
T += 1000; ts = T; P.onState(frame('ETH', '4H', 'SELL', 70, 100, 105, 95, ts)); T += 241 * 60000; P.onTrade('ETH', 101, T); P.debugTick();
eq('8 result', C('ETH', '4H', ts, 'SELL').result, 'LOSS');
// 9 SELL reverses to BUY
T += 1000; ts = T; P.onState(frame('BTC', '1D', 'SELL', 70, 100, 105, 95, ts)); P.onTrade('BTC', 99, T); P.onState(frame('BTC', '1D', 'BUY', 72, 99, 96, 104, T + 1));
eq('9 reason', C('BTC', '1D', ts, 'SELL').closeReason, 'REVERSED'); eq('9 new open', O('BTC', '1D').direction, 'BUY');
// 10 BUY reverses to SELL
T += 1000; ts = T; P.onState(frame('ETH', '1D', 'BUY', 70, 100, 95, 105, ts)); P.onTrade('ETH', 101, T); P.onState(frame('ETH', '1D', 'SELL', 72, 101, 106, 96, T + 1));
eq('10 reason', C('ETH', '1D', ts, 'BUY').closeReason, 'REVERSED'); eq('10 new open', O('ETH', '1D').direction, 'SELL');
// 11 same direction does NOT close
const n11 = P._closed.length; P.onState(frame('ETH', '1D', 'SELL', 74, 101, 106, 96, T + 2));
eq('11 no close', P._closed.length, n11); eq('11 open', O('ETH', '1D').status, 'OPEN');
// 12 duplicate frame no duplicate record
T += 1000; const ts12 = T; const n12 = P._open.size; P.onState(frame('SOL', '15m', 'BUY', 70, 200, 190, 210, ts12)); P.onState(frame('SOL', '15m', 'BUY', 70, 200, 190, 210, ts12));
eq('12 no dup', P._open.size, n12 + 1);
// 13 duplicate close ignored, pnl frozen
P.onTrade('SOL', 210, T); const r13 = C('SOL', '15m', ts12, 'BUY'); const p13 = r13.pnlPct; P.onTrade('SOL', 190, T + 1);
eq('13 frozen', r13.pnlPct, p13); eq('13 closed', r13.status, 'CLOSED');
// 14 asset isolation
const r14 = O('BTC', '1D'); P.onTrade('SOL', 50, T); P.onTrade('ETH', 50, T);
eq('14 isolated', r14.status, 'OPEN');
// 15 timeframe isolation
T += 1000; ts = T; P.onState(frame('BTC', '5m', 'BUY', 70, 100, 95, 105, ts)); P.onState(frame('BTC', '15m', 'BUY', 70, 100, 90, 110, ts)); P.onTrade('BTC', 105, T);
eq('15 5m closed', C('BTC', '5m', ts, 'BUY').closeReason, 'TARGET_HIT'); eq('15 15m open', O('BTC', '15m').status, 'OPEN');
// 16 missing levels safe
const n16 = P._open.size; P.onState(Object.assign(frame('BTC', '5m', 'BUY', 70, 100, 95, 105, T + 5), { stop: null }));
eq('16 skipped', P._open.size, n16);
// 17 stale price defers expiry, fresh price closes
T += 1000; ts = T; P.onState(frame('SOL', '4H', 'BUY', 70, 100, 95, 105, ts)); T += 241 * 60000; P.debugTick();
eq('17 deferred', O('SOL', '4H').status, 'OPEN'); P.onTrade('SOL', 101, T); P.debugTick();
eq('17 closed', C('SOL', '4H', ts, 'BUY').closeReason, 'EXPIRED');
// 18 invalid entry rejected
const n18 = P._open.size; P.onState(Object.assign(frame('ETH', '5m', 'BUY', 70, 0, 95, 105, T + 7), { price: 0 }));
eq('18 rejected', P._open.size, n18);
// 19 honest persistence flag
eq('19 flag', P.snapshotJSON().persisted, false);
// 20 arithmetic + summary formulas
const s20 = P.summary();
eq('20 winRate', s20.winRate, Math.round(s20.wins / s20.closed * 1000) / 10);
eq('20 avg', s20.averagePnl, Math.round(P._closed.reduce(function (s, r) { return s + r.pnlPct; }, 0) / P._closed.length * 100) / 100);
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
