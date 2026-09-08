/**
 * Signal Performance Ledger Engine
 */

const TF_EXPIRY_MS = {
  '1m': 10 * 60 * 1000,
  '5m': 30 * 60 * 1000,
  '15m': 90 * 60 * 1000,
  '1H': 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000
};

let logger = console.log;
let broadcaster = function () {};
let getNow = function () { return Date.now(); };
const closeListeners = [];

const openSignals = new Map();
const closedSignals = [];
const latestPrices = new Map();

function init(opts) {
  if (opts) {
    if (typeof opts.log === 'function') logger = opts.log;
    if (typeof opts.broadcast === 'function') broadcaster = opts.broadcast;
    if (typeof opts.now === 'function') getNow = opts.now;
  }
}

function onClose(fn) {
  if (typeof fn === 'function') {
    closeListeners.push(fn);
  }
}

function calculatePnl(direction, entryPrice, exitPrice) {
  if (!entryPrice || entryPrice <= 0) return 0;
  if (direction === 'BUY') {
    return ((exitPrice - entryPrice) / entryPrice) * 100;
  } else if (direction === 'SELL') {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }
  return 0;
}

function closeSignal(rec, reason, exitPrice, exitTs) {
  if (rec.status === 'CLOSED') return;

  rec.status = 'CLOSED';
  rec.closeReason = reason;
  rec.exitPrice = exitPrice;
  rec.exitTs = exitTs || getNow();

  rec.pnlPct = calculatePnl(rec.direction, rec.entryPrice, exitPrice);
  rec.result = rec.pnlPct > 0 ? 'WIN' : (rec.pnlPct < 0 ? 'LOSS' : 'NEUTRAL');

  openSignals.delete(rec.key);
  closedSignals.push(rec);

  broadcaster({ type: 'SIGNAL_CLOSED', signal: rec });

  for (const listener of closeListeners) {
    try {
      listener(rec);
    } catch (e) {
      logger('onClose listener error:', e.message);
    }
  }
}

function checkExpiry(rec, currentTs, price) {
  const windowMs = TF_EXPIRY_MS[rec.timeframe] || (60 * 60 * 1000);
  const isExpired = (currentTs - rec.openedTs) >= windowMs;

  if (isExpired) {
    const lastPriceInfo = latestPrices.get(rec.asset);
    if (!lastPriceInfo || lastPriceInfo.ts < rec.openedTs) {
      return false;
    }
    closeSignal(rec, 'EXPIRED', price || lastPriceInfo.price, currentTs);
    return true;
  }
  return false;
}

function debugTick() {
  const now = getNow();
  for (const [key, rec] of Array.from(openSignals.entries())) {
    const lastPriceInfo = latestPrices.get(rec.asset);
    if (lastPriceInfo) {
      checkExpiry(rec, now, lastPriceInfo.price);
    }
  }
}

function onState(frame) {
  if (!frame || !frame.asset || !frame.tf || !frame.signal) return;
  if (!frame.price || frame.price <= 0) return;
  if (frame.stop === null || frame.stop === undefined || frame.target === null || frame.target === undefined) return;

  const key = `${frame.asset}|${frame.tf}`;
  const now = frame.ts || getNow();
  const dir = frame.signal.toUpperCase();

  if (dir !== 'BUY' && dir !== 'SELL') {
    if (openSignals.has(key)) {
      const existing = openSignals.get(key);
      checkExpiry(existing, now, frame.price);
    }
    return;
  }

  if (openSignals.has(key)) {
    const existing = openSignals.get(key);
    if (existing.direction !== dir) {
      closeSignal(existing, 'REVERSED', frame.price, now);
    } else {
      checkExpiry(existing, now, frame.price);
      return;
    }
  }

  const signalId = `${frame.asset}|${frame.tf}|${now}|${dir}`;
  if (closedSignals.some(r => r.signalId === signalId)) return;

  const record = {
    key: key,
    signalId: signalId,
    asset: frame.asset,
    timeframe: frame.tf,
    direction: dir,
    entryPrice: frame.price,
    stop: frame.stop,
    target: frame.target,
    openedTs: now,
    status: 'OPEN',
    confidence: frame.confidence || 0,
    closeReason: null,
    exitPrice: null,
    exitTs: null,
    pnlPct: 0,
    result: null
  };

  openSignals.set(key, record);
}

function onTrade(asset, price, ts) {
  const tradeTs = ts || getNow();
  latestPrices.set(asset, { price: price, ts: tradeTs });

  for (const [key, rec] of Array.from(openSignals.entries())) {
    if (rec.asset !== asset) continue;

    if (checkExpiry(rec, tradeTs, price)) {
      continue;
    }

    if (rec.direction === 'BUY') {
      if (price >= rec.target) {
        closeSignal(rec, 'TARGET_HIT', price, tradeTs);
      } else if (price <= rec.stop) {
        closeSignal(rec, 'STOP_HIT', price, tradeTs);
      }
    } else if (rec.direction === 'SELL') {
      if (price <= rec.target) {
        closeSignal(rec, 'TARGET_HIT', price, tradeTs);
      } else if (price >= rec.stop) {
        closeSignal(rec, 'STOP_HIT', price, tradeTs);
      }
    }
  }
}

function closedText(rec) {
  const sign = rec.pnlPct > 0 ? '+' : '';
  return `[SIGNAL CLOSED] ${rec.asset} (${rec.timeframe}) ${rec.direction}\nReason: ${rec.closeReason}\nP&L: ${sign}${rec.pnlPct.toFixed(2)}%\nEntry: ${rec.entryPrice} -> Exit: ${rec.exitPrice}`;
}

function summary() {
  const total = closedSignals.length;
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let totalPnl = 0;

  for (const r of closedSignals) {
    if (r.result === 'WIN') wins++;
    else if (r.result === 'LOSS') losses++;
    else breakevens++;
    totalPnl += r.pnlPct;
  }

  const winRate = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0;
  const avgPnl = total > 0 ? Math.round((totalPnl / total) * 100) / 100 : 0;

  return {
    total: total + openSignals.size,
    closed: total,
    open: openSignals.size,
    wins: wins,
    losses: losses,
    breakevens: breakevens,
    winRate: winRate,
    averagePnl: avgPnl,
    totalPnl: Math.round(totalPnl * 100) / 100,
    profitFactor: null
  };
}

function snapshotJSON() {
  return {
    persisted: false,
    summary: summary(),
    open: Array.from(openSignals.values()).map(o => ({
      openedAt: o.openedTs,
      direction: o.direction,
      asset: o.asset,
      timeframe: o.timeframe,
      confidence: o.confidence,
      livePnl: calculatePnl(o.direction, o.entryPrice, latestPrices.get(o.asset)?.price || o.entryPrice)
    })),
    closed: closedSignals.map(c => ({
      openedAt: c.openedTs,
      direction: c.direction,
      asset: c.asset,
      timeframe: c.timeframe,
      entryPrice: c.entryPrice,
      exitPrice: c.exitPrice,
      durationMs: (c.exitTs || getNow()) - c.openedTs,
      confidence: c.confidence,
      pnlPct: c.pnlPct,
      closeReason: c.closeReason
    })),
    breakdowns: {
      direction: {},
      asset: {},
      confidence: {}
    }
  };
}

module.exports = {
  init: init,
  onClose: onClose,
  onState: onState,
  onTrade: onTrade,
  debugTick: debugTick,
  summary: summary,
  snapshotJSON: snapshotJSON,
  closedText: closedText,
  _open: openSignals,
  _closed: closedSignals
};
