// qwen-tg-v2.js - per-chat prefs, watchlists, digest scheduler, per-chat alert filtering.
// Reads canonical snapshots ONLY. Never polls markets, never computes indicators.
'use strict';
let store = null, deps = null, log = function () {};
const cooldown = {};
const COOLDOWN_MS = 120000;
const digestRetry = {};
let timer = null;

function init(d, st) {
  deps = d; store = st; log = d.log;
  if (!timer) timer = setInterval(function () { tick(); }, 60000);
}
function assetsValid(a) { return ['BTC', 'ETH', 'SOL'].indexOf(a) !== -1; }
async function ensure(msg) {
  const id = String(msg.chat.id);
  let rec = await store.loadChat(id);
  if (!rec) {
    rec = store.defaultRecord(id, msg);
    const r = await store.saveChat(rec);
    log('telegram: chat subscribed (' + (r.persisted ? 'persisted' : 'session-only') + ') id=' + id);
    return { rec: rec, persisted: r.persisted };
  }
  return { rec: rec, persisted: store.isDurable() };
}
function savedText(r, what) { return r.persisted ? what + ' saved.' : what + ' updated for this session only - persistent storage currently unavailable.'; }
function settingsText(rec) {
  return ['QWEN WATCHER SETTINGS', '',
    'Assets: ' + (rec.subscribedAssets.join(', ') || '(none)'), '',
    'Signal alerts: ' + (rec.alerts.signalFlips ? 'ON' : 'OFF'),
    'Invalidation alerts: ' + (rec.alerts.windowInvalidated ? 'ON' : 'OFF'),
    'Level alerts: ' + (rec.alerts.levels ? 'ON' : 'OFF'), '',
    'Minimum confidence: ' + rec.minConfidence, '',
    'Daily digest: ' + (rec.digest.enabled ? 'ON' : 'OFF'),
    'Digest time: ' + String(rec.digest.hour).padStart(2, '0') + ':' + String(rec.digest.minute).padStart(2, '0') + ' ' + rec.digest.timezone,
    'Timezone: ' + rec.digest.timezone].join('\n');
}
function digestText(rec) {
  return ['Daily digest: ' + (rec.digest.enabled ? 'ON' : 'OFF'),
    'Time: ' + String(rec.digest.hour).padStart(2, '0') + ':' + String(rec.digest.minute).padStart(2, '0') + ' ' + rec.digest.timezone,
    'Assets: ' + (rec.subscribedAssets.join(', ') || '(none)')].join('\n');
}

function handleCommand(msg, reply) {
  const parts = String(msg.text || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  if (['/watch', '/unwatch', '/watchlist', '/confidence', '/settings', '/digest', '/alerts'].indexOf(cmd) === -1) return false;
  run(msg, parts, reply).catch(function (e) { log('v2 command error: ' + e.message); reply('Command failed: ' + e.message); });
  return true;
}
async function run(msg, parts, reply) {
  const cmd = parts[0].toLowerCase();
  const e = await ensure(msg);
  const rec = e.rec;
  const id = rec.chatId;
  if (cmd === '/watch' || cmd === '/unwatch') {
    const a = (parts[1] || '').toUpperCase();
    if (!assetsValid(a)) { reply('Usage: /watch BTC|ETH|SOL'); return; }
    const has = rec.subscribedAssets.indexOf(a) !== -1;
    if (cmd === '/watch' && has) { reply(a + ' is already in your watchlist.'); return; }
    if (cmd === '/unwatch' && !has) { reply(a + ' is not in your watchlist.'); return; }
    const r = await store.updateChat(id, cmd === '/watch' ? { addAssets: [a] } : { remAssets: [a] });
    log('telegram: preference updated (' + cmd + ' ' + a + ') id=' + id);
    reply(savedText(r, cmd === '/watch' ? a + ' added to watchlist' : a + ' removed from watchlist'));
    return;
  }
  if (cmd === '/alerts') {
    const sub = (parts[1] || '').toLowerCase();
    let patchA = null, label = '';
    if (sub === 'on') { patchA = { signalFlips: true, windowInvalidated: true }; label = 'Alerts ON'; }
    else if (sub === 'off') { patchA = { signalFlips: false, windowInvalidated: false }; label = 'Alerts OFF'; }
    else if (sub === 'signals') { patchA = { signalFlips: !rec.alerts.signalFlips }; label = 'Signal alerts ' + (!rec.alerts.signalFlips ? 'ON' : 'OFF'); }
    else if (sub === 'levels') { patchA = { levels: !rec.alerts.levels }; label = 'Level alerts ' + (!rec.alerts.levels ? 'ON' : 'OFF'); }
    else { reply('Usage: /alerts on|off|signals|levels'); return; }
    const r = await store.updateChat(id, { alerts: patchA });
    log('telegram: preference updated (alerts ' + sub + ') id=' + id);
    reply(savedText(r, label));
    return;
  }
  if (cmd === '/watchlist') { reply('Watchlist: ' + (rec.subscribedAssets.join(', ') || '(none)')); return; }
  if (cmd === '/confidence') {
    const n = parseInt(parts[1], 10);
    if (!isFinite(n) || n < 1 || n > 100) { reply('Usage: /confidence 1-100'); return; }
    const r = await store.updateChat(id, { minConfidence: n });
    log('telegram: preference updated (confidence ' + n + ') id=' + id);
    reply(savedText(r, 'Minimum confidence ' + n + '%'));
    return;
  }
  if (cmd === '/settings') { reply(settingsText(rec) + '\n\nPersistence: ' + store.status()); return; }
  if (cmd === '/digest') {
    const sub = (parts[1] || '').toLowerCase();
    if (!sub) { reply(digestText(rec)); return; }
    if (sub === 'on' || sub === 'off') {
      const r = await store.updateChat(id, { digest: Object.assign({}, rec.digest, { enabled: sub === 'on' }) });
      log('telegram: digest ' + sub + ' id=' + id);
      reply(savedText(r, 'Daily digest ' + sub));
      return;
    }
    if (sub === 'time') {
      const t = parts[2] || '';
      const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
      if (!m) { reply('Usage: /digest time HH:MM (24h)'); return; }
      const r = await store.updateChat(id, { digest: Object.assign({}, rec.digest, { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) }) });
      log('telegram: digest time ' + t + ' id=' + id);
      reply(savedText(r, 'Digest time ' + t + ' ' + rec.digest.timezone));
      return;
    }
    if (sub === 'timezone') {
      const tz = parts[2] || '';
      try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch (err) { reply('Invalid timezone. Use an IANA timezone such as Africa/Lagos or UTC.'); return; }
      const r = await store.updateChat(id, { digest: Object.assign({}, rec.digest, { timezone: tz }) });
      log('telegram: digest timezone ' + tz + ' id=' + id);
      reply(savedText(r, 'Digest timezone ' + tz));
      return;
    }
    reply('Usage: /digest [on|off|time HH:MM|timezone TZ]');
    return;
  }
}
async function bind(msg) { await ensure(msg); }

function onEvent(v, io) {
  if (!v || !v.asset) return;
  const kind = v.event === 'signal-flip' ? 'flip' : v.event === 'window-invalidated' ? 'inv' : null;
  if (!kind) return;
  const now = Date.now();
  const ck = v.asset + ':' + kind;
  if (now - (cooldown[ck] || 0) < COOLDOWN_MS) return;
  cooldown[ck] = now;
  dispatch(v, kind, io).catch(function (e) { log('v2 dispatch error: ' + e.message); });
}
async function dispatch(v, kind, io) {
  const ids = await store.listChats();
  let sent = 0;
  for (const id of ids) {
    const rec = await store.loadChat(id);
    if (!rec) continue;
    if (rec.subscribedAssets.indexOf(v.asset) === -1) continue;
    if (kind === 'flip') {
      if (!rec.alerts.signalFlips) continue;
      if ((v.confidence || 0) < rec.minConfidence) continue;
    } else {
      if (!rec.alerts.windowInvalidated) continue;
    }
    const head = kind === 'inv' ? '⚠️ WINDOW INVALIDATED - ' + v.asset + '/USD'
      : (v.to === 'BUY' ? '🟢' : v.to === 'SELL' ? '🔴' : '🟡') + ' SIGNAL FLIP - ' + v.asset + '/USD';
    const body = kind === 'inv' ? 'Active ' + v.from + ' window crossed its invalidation level.'
      : v.from + ' -> ' + v.to + ' - ' + v.confidence + '% confidence';
    io.sendTo(id, head + '\n' + body + '\n' + new Date().toUTCString().slice(17, 25) + ' UTC | QWEN WATCHER | probabilistic, not advice');
    sent++;
  }
  if (sent) log('telegram: alert sent (' + kind + ' ' + v.asset + ') to ' + sent + ' chat(s)');
}

function localParts(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const o = {};
  fmt.formatToParts(new Date()).forEach(function (p) { o[p.type] = p.value; });
  return { date: o.year + '-' + o.month + '-' + o.day, hh: parseInt(o.hour, 10) % 24, mm: parseInt(o.minute, 10), hhmm: String(o.hour).padStart(2, '0') + ':' + String(o.minute).padStart(2, '0') };
}
function digestBody(rec) {
  const canon = deps.getCanonical();
  const lines = ['QWEN WATCHER - DAILY DIGEST', new Date().toUTCString().slice(17, 25) + ' UTC', ''];
  rec.subscribedAssets.forEach(function (a) {
    const slot = canon[a];
    lines.push(a);
    if (!slot || !slot.state || (Date.now() - slot.lastPublish > 120000)) { lines.push('Signal: UNAVAILABLE'); lines.push('Reason: canonical market state is stale.'); }
    else {
      const s = slot.state;
      lines.push('Signal: ' + s.signal);
      lines.push('Confidence: ' + s.confidence + '%');
      lines.push('Regime: ' + (s.regime || 'n/a'));
      lines.push('Price: ' + (s.price != null ? Number(s.price).toLocaleString('en-US') : 'n/a'));
      lines.push('24h: ' + (s.pct != null ? Number(s.pct).toFixed(2) + '%' : 'n/a'));
      lines.push('Trend strength: ' + (s.strength != null ? s.strength + '/100' : 'n/a'));
      lines.push('Momentum: ' + (s.momentum || 'n/a'));
      lines.push('Plan: ' + (s.planStatus || 'n/a'));
    }
    lines.push('');
  });
  lines.push('Probabilistic, not advice.');
  return lines.join('\n');
}
async function tick() {
  try {
    const ids = await store.listChats();
    for (const id of ids) {
      const rec = await store.loadChat(id);
      if (!rec || !rec.digest.enabled) continue;
      let lp;
      try { lp = localParts(rec.digest.timezone || 'UTC'); } catch (e) { lp = localParts('UTC'); }
      if (lp.hh !== rec.digest.hour || lp.mm !== rec.digest.minute) continue;
      if ((digestRetry[id] || 0) > Date.now()) continue;
      const claim = await store.recordDigestSent(id, lp.date, lp.hhmm);
      if (!claim.claimed) {
        log('telegram: digest skipped (' + (claim.persisted ? 'already sent' : 'dedupe state not durable - fail closed') + ') id=' + id);
        continue;
      }
      const okSend = await deps.send(id, digestBody(rec));
      if (okSend) log('telegram: digest sent id=' + id);
      else { await store.releaseDigestMarker(id, lp.date, lp.hhmm); digestRetry[id] = Date.now() + 600000; log('telegram: digest failed id=' + id); }
    }
  } catch (e) { log('telegram: digest scheduler error: ' + e.message); }
}

function statusLines() {
  const st = store.status();
  const canon = deps.getCanonical();
  let newest = 0;
  Object.keys(canon).forEach(function (k) { if (canon[k].lastPublish > newest) newest = canon[k].lastPublish; });
  return ['Telegram: ' + (st === 'OK' ? 'CONNECTED' : st === 'DEGRADED' ? 'DEGRADED' : 'DISABLED (session-only)'),
    'Persisted chats: ' + store.cachedChatCount(),
    'Publisher: ' + (deps.getPublishers() > 0 ? 'CONNECTED' : 'DISCONNECTED'),
    'Snapshot age: ' + (newest ? Math.round((Date.now() - newest) / 1000) + 's' : 'n/a'),
    'Digest scheduler: ' + (timer ? 'RUNNING' : 'DISABLED'),
    'Persistence: ' + st + (st === 'DEGRADED' && store.lastError() ? ' (' + store.lastError() + ')' : '')].join('\n');
}

module.exports = { init: init, handleCommand: handleCommand, onEvent: onEvent, bind: bind, statusLines: statusLines };
