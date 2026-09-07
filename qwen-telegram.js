// qwen-telegram.js - QWEN WATCHER Telegram thin client (V1)
// Reads canonical snapshots OWNED by qwen-backend.js. Never computes indicators,
// never opens market connections. Official Bot API over HTTPS via Node fetch.
'use strict';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const MIN_CONF = parseInt(process.env.ALERT_MIN_CONF || '60', 10);
const COOLDOWN_MS = 120000;
const chats = new Set(process.env.TELEGRAM_CHAT_ID ? [String(process.env.TELEGRAM_CHAT_ID)] : []);
let deps = null, enabled = false, offset = 0;
let alertSignals = true, alertLevels = true;
let lastSend = null, lastError = null;
const cooldown = {};

function log(m) { if (deps) deps.log('telegram: ' + m); }
function age(ts) { const s = Math.floor((Date.now() - ts) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm'; }
function pair(a) { return a + '/USD'; }

function init(d) {
  deps = d;
  if (!TOKEN) { d.log('telegram: disabled (TELEGRAM_BOT_TOKEN not set) - app continues normally'); return; }
  enabled = true;
  d.log('telegram: enabled | chats=' + chats.size + ' | subscriptions are IN-MEMORY and do NOT survive Render restarts');
  poll();
}

async function api(method, body) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return await r.json();
}
async function send(text) {
  if (!enabled || chats.size === 0) return;
  for (const chat of chats) {
    try {
      let j = await api('sendMessage', { chat_id: chat, text: text, disable_web_page_preview: true });
      if (!j.ok && j.parameters && j.parameters.retry_after) {
        await new Promise(function (r) { setTimeout(r, j.parameters.retry_after * 1000 + 500); });
        j = await api('sendMessage', { chat_id: chat, text: text });
      }
      if (!j.ok) throw new Error(j.description || 'send failed');
      lastSend = Date.now();
    } catch (e) { lastError = String(e.message); log('send failed: ' + e.message); }
  }
}

function snapshotFor(arg) {
  const canon = deps.getCanonical();
  const key = Object.keys(canon).find(function (k) { return arg ? k.indexOf(arg) === 0 : false; });
  return key ? canon[key] : null;
}
function fmtSnapFull(slot) {
  const s = slot.state;
  const icon = s.signal === 'BUY' ? '🟢' : s.signal === 'SELL' ? '🔴' : '🟡';
  const lines = [];
  lines.push(icon + ' SIGNAL - ' + pair(s.asset));
  lines.push(s.signal + ' - ' + s.confidence + '% confidence (' + s.tf + ')');
  if (s.entryLow != null) lines.push('Entry ' + Number(s.entryLow).toLocaleString('en-US') + '-' + Number(s.entryHigh).toLocaleString('en-US') + ' | Stop ' + Number(s.stop).toLocaleString('en-US') + ' | Target ' + Number(s.target).toLocaleString('en-US'));
  else lines.push('Levels: n/a (partial snapshot from inactive asset)');
  if (s.regime) lines.push('Regime: ' + s.regime + ' | strength ' + s.strength + '/100 | vol ' + s.volLabel + ' | momentum ' + s.momentum);
  lines.push('Price ' + Number(s.price).toLocaleString('en-US') + ' | snapshot age ' + age(slot.lastPublish));
  lines.push('QWEN WATCHER | probabilistic, not advice');
  return lines.join('\n');
}

function handle(msg) {
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  const parts = msg.text.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = (parts[1] || '').toUpperCase();
  let reply = '';
  if (cmd === '/start') {
    chats.add(chatId);
    log('chat bound ' + chatId + ' (in-memory, session-only)');
    reply = 'QWEN WATCHER bound to this chat (session-only subscription).\nCommands: /status /price /signal /regime /alerts /help';
    send(reply);
    return;
  }
  if (!chats.has(chatId)) { send('Unauthorized chat. Send /start first.'); return; }
  const canon = deps.getCanonical();
  if (cmd === '/help') reply = 'QWEN WATCHER bot\n/status - feed + publisher + signal overview\n/price [BTC|ETH|SOL]\n/signal [pair]\n/regime [pair]\n/alerts on|off|signals|levels\nSubscriptions live in memory only; they reset on Render restart.';
  else if (cmd === '/status') {
    const lines = ['QWEN WATCHER STATUS', 'Coinbase upstream: ' + deps.getUpstream(), 'Dashboard publishers connected: ' + deps.getPublishers(), 'Alerts: signals=' + (alertSignals ? 'on' : 'off') + ' minConf=' + MIN_CONF];
    Object.keys(canon).forEach(function (k) {
      const slot = canon[k];
      lines.push(pair(k) + ': ' + (slot.state ? (Number(slot.state.price).toLocaleString('en-US') + ' | ' + slot.state.signal + ' ' + slot.state.confidence + '% | age ' + age(slot.lastPublish)) : 'no canonical snapshot yet (awaiting dashboard publisher + valid data)'));
    });
    if (deps.getPublishers() === 0) lines.push('note: no dashboard session publishing - snapshots frozen until a tab reconnects');
    if (lastError) lines.push('last telegram error: ' + lastError);
    reply = lines.join('\n');
  } else if (cmd === '/price') {
    const slot = arg ? snapshotFor(arg) : null;
    reply = (!slot || !slot.state) ? 'No canonical price yet for ' + (arg || 'asset') + '.' : pair(slot.state.asset) + ': ' + Number(slot.state.price).toLocaleString('en-US') + (slot.state.pct != null ? ' | 24h ' + Number(slot.state.pct).toFixed(2) + '%' : '') + ' | age ' + age(slot.lastPublish);
  } else if (cmd === '/signal') {
    const slot = arg ? snapshotFor(arg) : null;
    reply = (!slot || !slot.state) ? 'No canonical signal yet for ' + (arg || 'asset') + '.' : fmtSnapFull(slot);
  } else if (cmd === '/regime') {
    const slot = arg ? snapshotFor(arg) : null;
    reply = (!slot || !slot.state || !slot.state.regime) ? 'No regime data yet for ' + (arg || 'asset') + '.' : pair(slot.state.asset) + ': ' + slot.state.regime + ' | strength ' + slot.state.strength + '/100 | vol ' + slot.state.volLabel + ' | momentum ' + slot.state.momentum;
  } else if (cmd === '/alerts') {
    const sub = (parts[1] || '').toLowerCase();
    if (sub === 'on') { alertSignals = true; reply = 'Signal alerts ON.'; }
    else if (sub === 'off') { alertSignals = false; reply = 'Signal alerts OFF (commands still work).'; }
    else if (sub === 'signals') { alertSignals = !alertSignals; reply = 'Signal alerts ' + (alertSignals ? 'ON' : 'OFF') + '.'; }
    else if (sub === 'levels') { alertLevels = !alertLevels; reply = 'Level alerts ' + (alertLevels ? 'ON' : 'OFF') + ' (reserved for Phase 2).'; }
    else reply = 'Usage: /alerts on|off|signals|levels';
  } else reply = 'Unknown command. Try /help';
  send(reply);
}

function onEvent(v) {
  if (!enabled || !alertSignals || chats.size === 0) return;
  const now = Date.now();
  try {
    if (v.event === 'signal-flip') {
      if ((v.confidence || 0) < MIN_CONF) return;
      const key = v.asset + ':flip';
      if (now - (cooldown[key] || 0) < COOLDOWN_MS) return;
      cooldown[key] = now;
      const icon = v.to === 'BUY' ? '🟢' : v.to === 'SELL' ? '🔴' : '🟡';
      send(icon + ' SIGNAL FLIP - ' + pair(v.asset) + '\n' + v.from + ' -> ' + v.to + ' - ' + v.confidence + '% confidence\n' + new Date().toUTCString().slice(17, 25) + ' UTC | QWEN WATCHER | probabilistic, not advice');
      log('alert sent: flip ' + v.asset + ' ' + v.from + '->' + v.to);
    } else if (v.event === 'window-invalidated') {
      const key = v.asset + ':inv';
      if (now - (cooldown[key] || 0) < COOLDOWN_MS) return;
      cooldown[key] = now;
      send('⚠️ WINDOW INVALIDATED - ' + pair(v.asset) + '\nActive ' + v.from + ' window crossed its invalidation level.\n' + new Date().toUTCString().slice(17, 25) + ' UTC | QWEN WATCHER');
      log('alert sent: window invalidated ' + v.asset);
    }
  } catch (e) { lastError = String(e.message); log('onEvent error: ' + e.message); }
}

async function poll() {
  if (!enabled) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, 60000);
    const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/getUpdates?timeout=50&offset=' + offset, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j.ok) for (const u of j.result) { offset = u.update_id + 1; handle(u.message); }
  } catch (e) { lastError = String(e.message); }
  setTimeout(poll, 1500);
}

module.exports = { init: init, onEvent: onEvent };
