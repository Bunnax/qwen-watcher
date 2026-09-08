// qwen-tg-store.js - ONLY module that talks to Upstash Redis REST.
// Memory mirror + write-through cache + reconcile/retry. Never throws into callers.
'use strict';
const REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CACHE_MS = 60000;
const DIGEST_TTL = 172800;

let log = function () {};
const configured = !!(REST_URL && REST_TOKEN);
let healthy = false;
let lastStoreError = null;

const memChats = new Map();
const memDigest = new Set();
const dirty = new Set();
const chatCache = new Map();
let listCache = { ids: null, at: 0 };

function host() { try { return new (require('url').URL)(REST_URL).host; } catch (e) { return 'unconfigured'; } }
function markDown(e) {
  lastStoreError = String(e && e.message ? e.message : e);
  if (healthy) { healthy = false; log('telegram: persistence unavailable (' + lastStoreError + ') - DEGRADED'); }
}
async function rcmd(cmd) {
  const r = await fetch(REST_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
  const j = await r.json();
  if (j && j.error) throw new Error(String(j.error));
  return j ? j.result : null;
}
async function rpipeline(cmds) {
  const r = await fetch(REST_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: cmds }), signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
  const j = await r.json();
  if (j && j.error) throw new Error(String(j.error));
  return (j && j.results) || [];
}

function recToHash(rec) {
  return ['username', String(rec.username || ''), 'firstName', String(rec.firstName || ''),
    'createdAt', String(rec.createdAt || ''), 'updatedAt', String(rec.updatedAt || ''),
    'alertsSignalFlips', rec.alerts.signalFlips ? '1' : '0',
    'alertsWindowInvalidated', rec.alerts.windowInvalidated ? '1' : '0',
    'alertsLevels', rec.alerts.levels ? '1' : '0',
    'minConfidence', String(rec.minConfidence),
    'digestEnabled', rec.digest.enabled ? '1' : '0',
    'digestHour', String(rec.digest.hour), 'digestMinute', String(rec.digest.minute),
    'digestTimezone', String(rec.digest.timezone || 'UTC')];
}
function hashToRec(id, flat, assets) {
  const m = {};
  for (let i = 0; i + 1 < flat.length; i += 2) m[flat[i]] = flat[i + 1];
  return {
    chatId: id, username: m.username || '', firstName: m.firstName || '',
    createdAt: m.createdAt || '', updatedAt: m.updatedAt || '',
    subscribedAssets: assets || [],
    alerts: { signalFlips: m.alertsSignalFlips === '1', windowInvalidated: m.alertsWindowInvalidated !== '0', levels: m.alertsLevels === '1' },
    minConfidence: parseInt(m.minConfidence, 10) || 60,
    digest: { enabled: m.digestEnabled === '1', hour: parseInt(m.digestHour, 10) || 0, minute: parseInt(m.digestMinute, 10) || 0, timezone: m.digestTimezone || 'UTC' }
  };
}
function defaultRecord(chatId, msg) {
  const now = new Date().toISOString();
  const c = (msg && msg.chat) || {};
  return {
    chatId: String(chatId), username: c.username || '', firstName: c.first_name || c.firstName || '',
    createdAt: now, updatedAt: now,
    subscribedAssets: ['BTC'],
    alerts: { signalFlips: true, windowInvalidated: true, levels: false },
    minConfidence: parseInt(process.env.ALERT_MIN_CONF || '60', 10) || 60,
    digest: { enabled: false, hour: 18, minute: 0, timezone: 'UTC' }
  };
}
function applyPatch(rec, patch) {
  if (patch.alerts) Object.keys(patch.alerts).forEach(function (k) { rec.alerts[k] = !!patch.alerts[k]; });
  if (typeof patch.minConfidence === 'number') rec.minConfidence = patch.minConfidence;
  if (patch.digest) Object.keys(patch.digest).forEach(function (k) { rec.digest[k] = patch.digest[k]; });
  if (patch.addAssets) patch.addAssets.forEach(function (a) { if (rec.subscribedAssets.indexOf(a) === -1) rec.subscribedAssets.push(a); });
  if (patch.remAssets) rec.subscribedAssets = rec.subscribedAssets.filter(function (a) { return patch.remAssets.indexOf(a) === -1; });
  rec.updatedAt = new Date().toISOString();
}
function patchToScalars(patch, rec) {
  const out = {};
  if (patch.alerts) {
    if ('signalFlips' in patch.alerts) out.alertsSignalFlips = patch.alerts.signalFlips ? '1' : '0';
    if ('windowInvalidated' in patch.alerts) out.alertsWindowInvalidated = patch.alerts.windowInvalidated ? '1' : '0';
    if ('levels' in patch.alerts) out.alertsLevels = patch.alerts.levels ? '1' : '0';
  }
  if (typeof patch.minConfidence === 'number') out.minConfidence = String(patch.minConfidence);
  if (patch.digest) {
    if ('enabled' in patch.digest) out.digestEnabled = patch.digest.enabled ? '1' : '0';
    if ('hour' in patch.digest) out.digestHour = String(patch.digest.hour);
    if ('minute' in patch.digest) out.digestMinute = String(patch.digest.minute);
    if ('timezone' in patch.digest) out.digestTimezone = String(patch.digest.timezone);
  }
  out.updatedAt = rec.updatedAt;
  return out;
}

async function pushFull(rec) {
  const id = String(rec.chatId);
  const cmds = [['SADD', 'qwtg:chats', id], ['DEL', 'qwtg:chat:' + id], ['HSET', 'qwtg:chat:' + id].concat(recToHash(rec)), ['DEL', 'qwtg:assets:' + id]];
  if (rec.subscribedAssets.length) cmds.push(['SADD', 'qwtg:assets:' + id].concat(rec.subscribedAssets));
  await rpipeline(cmds);
  return true;
}

function init(d) {
  if (d && d.log) log = d.log;
  if (!configured) { log('telegram: persistence unavailable (UPSTASH env not set) - session-only mode'); return; }
  probe().then(function (ok) {
    if (ok) { healthy = true; log('telegram: persistence loaded (Upstash ' + host() + ')'); reconcile(); }
    else log('telegram: persistence unavailable (probe failed) - DEGRADED, session-only until reconciled');
  });
  setInterval(reconcile, 60000);
}
async function probe() { try { return (await rcmd(['PING'])) === 'PONG'; } catch (e) { markDown(e); return false; } }
async function reconcile() {
  if (!configured) return;
  const ok = await probe();
  if (ok && !healthy) { healthy = true; log('telegram: persistence restored - reconciling'); }
  if (!healthy) return;
  for (const id of Array.from(dirty)) {
    const rec = memChats.get(id);
    if (!rec) { dirty.delete(id); continue; }
    try { await pushFull(rec); dirty.delete(id); lastStoreError = null; } catch (e) { markDown(e); }
  }
}

async function loadChat(chatId, force) {
  const id = String(chatId);
  const c = chatCache.get(id);
  if (!force && c && Date.now() - c.at < CACHE_MS) return c.rec;
  if (configured && healthy) {
    try {
      const res = await rpipeline([['HGETALL', 'qwtg:chat:' + id], ['SMEMBERS', 'qwtg:assets:' + id]]);
      const flat = (res[0] && res[0].result) || [];
      const assets = (res[1] && res[1].result) || [];
      if (!flat || flat.length === 0) return null;
      const rec = hashToRec(id, flat, assets);
      chatCache.set(id, { rec: rec, at: Date.now() });
      memChats.set(id, rec);
      return rec;
    } catch (e) { markDown(e); }
  }
  const m = memChats.get(id) || null;
  if (m) chatCache.set(id, { rec: m, at: Date.now() });
  return m;
}
async function saveChat(rec) {
  const id = String(rec.chatId);
  memChats.set(id, rec); dirty.add(id);
  chatCache.set(id, { rec: rec, at: Date.now() });
  listCache = { ids: null, at: 0 };
  if (configured && healthy) {
    try { await pushFull(rec); dirty.delete(id); lastStoreError = null; return { ok: true, persisted: true }; } catch (e) { markDown(e); }
  }
  return { ok: true, persisted: false };
}
async function updateChat(chatId, patch) {
  const id = String(chatId);
  let rec = memChats.get(id) || (chatCache.get(id) || {}).rec || null;
  if (!rec) rec = defaultRecord(id, null);
  applyPatch(rec, patch);
  memChats.set(id, rec); dirty.add(id);
  chatCache.set(id, { rec: rec, at: Date.now() });
  listCache = { ids: null, at: 0 };
  if (configured && healthy) {
    try {
      const cmds = [];
      const scalars = patchToScalars(patch, rec);
      const h = ['HSET', 'qwtg:chat:' + id];
      Object.keys(scalars).forEach(function (k) { h.push(k, String(scalars[k])); });
      cmds.push(h);
      if (patch.addAssets && patch.addAssets.length) cmds.push(['SADD', 'qwtg:assets:' + id].concat(patch.addAssets));
      if (patch.remAssets && patch.remAssets.length) cmds.push(['SREM', 'qwtg:assets:' + id].concat(patch.remAssets));
      await rpipeline(cmds);
      dirty.delete(id); lastStoreError = null;
      return { ok: true, persisted: true, rec: rec };
    } catch (e) { markDown(e); }
  }
  return { ok: true, persisted: false, rec: rec };
}
async function deleteChat(chatId) {
  const id = String(chatId);
  memChats.delete(id); dirty.delete(id); chatCache.delete(id);
  listCache = { ids: null, at: 0 };
  if (configured && healthy) { try { await rpipeline([['SREM', 'qwtg:chats', id], ['DEL', 'qwtg:chat:' + id], ['DEL', 'qwtg:assets:' + id]]); } catch (e) { markDown(e); } }
}
async function listChats() {
  if (listCache.ids && Date.now() - listCache.at < CACHE_MS) return listCache.ids;
  if (configured && healthy) {
    try { const ids = (await rcmd(['SMEMBERS', 'qwtg:chats'])) || []; listCache = { ids: ids, at: Date.now() }; return ids; } catch (e) { markDown(e); }
  }
  const ids = Array.from(memChats.keys());
  listCache = { ids: ids, at: Date.now() };
  return ids;
}
function digestKey(chatId, localDate, hhmm) { return 'qwtg:digest:' + chatId + '|' + localDate + '|' + hhmm; }
async function recordDigestSent(chatId, localDate, hhmm) {
  const key = digestKey(chatId, localDate, hhmm);
  if (configured && healthy) {
    try {
      const res = await rcmd(['SET', key, '1', 'NX', 'EX', String(DIGEST_TTL)]);
      if (res === 'OK') { memDigest.add(key); lastStoreError = null; return { claimed: true, persisted: true }; }
      return { claimed: false, persisted: true };
    } catch (e) { markDown(e); }
  }
  return { claimed: false, persisted: false, reason: 'persistence-unavailable' };
}
async function releaseDigestMarker(chatId, localDate, hhmm) {
  const key = digestKey(chatId, localDate, hhmm);
  memDigest.delete(key);
  if (configured && healthy) { try { await rcmd(['DEL', key]); } catch (e) { markDown(e); } }
}
async function hasDigestBeenSent(chatId, localDate, hhmm) {
  const key = digestKey(chatId, localDate, hhmm);
  if (memDigest.has(key)) return true;
  if (configured && healthy) { try { return (await rcmd(['EXISTS', key])) === 1; } catch (e) { markDown(e); } }
  return false;
}
function status() { if (!configured) return 'UNAVAILABLE'; return healthy ? 'OK' : 'DEGRADED'; }
function lastError() { return lastStoreError; }
function isDurable() { return configured && healthy; }
function cachedChatCount() { return memChats.size; }

module.exports = { init: init, loadChat: loadChat, saveChat: saveChat, updateChat: updateChat, deleteChat: deleteChat, listChats: listChats, recordDigestSent: recordDigestSent, releaseDigestMarker: releaseDigestMarker, hasDigestBeenSent: hasDigestBeenSent, defaultRecord: defaultRecord, status: status, lastError: lastError, isDurable: isDurable, cachedChatCount: cachedChatCount };
