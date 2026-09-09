/**
 * QWEN WATCHER — Signal Performance / P&L Ledger
 *
 * Deterministic performance tracking from real market prices.
 * No simulated market data.
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
  if (!opts) return;

  if (typeof opts.log === 'function') {
    logger = opts.log;
  }

  if (typeof opts.broadcast === 'function') {
    broadcaster = opts.broadcast;
  }

  if (typeof opts.now === 'function') {
    getNow = opts.now;
  }
}

function onClose(fn) {
  if (typeof fn === 'function') {
    closeListeners.push(fn);
  }
}

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function validPrice(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeDirection(value) {
  const dir = String(value || '').toUpperCase();

  if (dir.includes('BUY')) return 'BUY';
  if (dir.includes('SELL')) return 'SELL';

  return 'WAIT';
}

function calculatePnl(direction, entryPrice, exitPrice) {
  if (!validPrice(entryPrice) || !validPrice(exitPrice)) {
    return 0;
  }

  if (direction === 'BUY') {
    return ((exitPrice - entryPrice) / entryPrice) * 100;
  }

  if (direction === 'SELL') {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  return 0;
}

function closeSignal(rec, reason, exitPrice, exitTs) {
  if (!rec || rec.status === 'CLOSED') {
    return;
  }

  if (!validPrice(exitPrice)) {
    return;
  }

  rec.status = 'CLOSED';
  rec.closeReason = reason;
  rec.exitPrice = Number(exitPrice);
  rec.exitTs = Number(exitTs) || getNow();

  rec.durationMs = Math.max(0, rec.exitTs - rec.openedTs);
  rec.pnlPct = round(
    calculatePnl(rec.direction, rec.entryPrice, rec.exitPrice),
    4
  );

  rec.result =
    rec.pnlPct > 0 ? 'WIN' :
    rec.pnlPct < 0 ? 'LOSS' :
    'NEUTRAL';

  openSignals.delete(rec.key);
  closedSignals.push(rec);

  broadcaster({
    type: 'SIGNAL_CLOSED',
    signal: rec
  });

  for (const listener of closeListeners) {
    try {
      listener(rec);
    } catch (e) {
      logger('onClose listener error:', e.message);
    }
  }
}

function checkExpiry(rec, currentTs, price) {
  const windowMs =
    TF_EXPIRY_MS[rec.timeframe] ||
    (60 * 60 * 1000);

  const isExpired =
    (currentTs - rec.openedTs) >= windowMs;

  if (!isExpired) {
    return false;
  }

  const lastPriceInfo = latestPrices.get(rec.asset);

  if (
    !lastPriceInfo ||
    !validPrice(lastPriceInfo.price) ||
    lastPriceInfo.ts < rec.openedTs
  ) {
    return false;
  }

  const exitPrice =
    validPrice(price)
      ? Number(price)
      : Number(lastPriceInfo.price);

  closeSignal(
    rec,
    'EXPIRED',
    exitPrice,
    currentTs
  );

  return true;
}

function debugTick() {
  const now = getNow();

  for (const rec of Array.from(openSignals.values())) {
    const latest = latestPrices.get(rec.asset);

    if (latest) {
      checkExpiry(
        rec,
        now,
        latest.price
      );
    }
  }
}

function hasClosedSignal(signalId) {
  if (!signalId) return false;

  return closedSignals.some(
    rec => rec.signalId === signalId
  );
}

function onState(frame) {
  if (
    !frame ||
    !frame.asset ||
    !frame.tf ||
    !frame.signal
  ) {
    return;
  }

  if (!validPrice(frame.price)) {
    return;
  }

  if (
    frame.stop === null ||
    frame.stop === undefined ||
    frame.target === null ||
    frame.target === undefined ||
    !validPrice(frame.stop) ||
    !validPrice(frame.target)
  ) {
    return;
  }

  const asset = String(frame.asset).toUpperCase();
  const timeframe = String(frame.tf);
  const direction = normalizeDirection(frame.signal);

  if (
    direction !== 'BUY' &&
    direction !== 'SELL'
  ) {
    return;
  }

  const key = `${asset}|${timeframe}`;
  const now = Number(frame.ts) || getNow();

  latestPrices.set(asset, {
    price: Number(frame.price),
    ts: now
  });

  /*
   * The publisher supplies a stable signalId.
   * Identical signalId = same active signal.
   * Different signalId = new signal/window.
   */
  const signalId =
    frame.signalId ||
    `${asset}|${timeframe}|${now}|${direction}`;

  if (openSignals.has(key)) {
    const existing = openSignals.get(key);

    /*
     * Same signal: refresh metadata only.
     * Never reset the original entry price or opened timestamp.
     */
    if (existing.signalId === signalId) {
      existing.lastStateTs = now;
      existing.lastPrice = Number(frame.price);

      existing.confidence =
        Number.isFinite(Number(frame.confidence))
          ? Number(frame.confidence)
          : existing.confidence;

      if (frame.regime) {
        existing.regime = String(frame.regime);
      }

      checkExpiry(
        existing,
        now,
        Number(frame.price)
      );

      return;
    }

    /*
     * Different signal for the same asset/timeframe.
     *
     * Direction changed:
     *   REVERSED
     *
     * Direction stayed the same:
     *   REPLACED
     */
    const closeReason =
      existing.direction !== direction
        ? 'REVERSED'
        : 'REPLACED';

    closeSignal(
      existing,
      closeReason,
      Number(frame.price),
      now
    );
  }

  /*
   * A previously closed signal with the same stable ID
   * must never be reopened.
   */
  if (hasClosedSignal(signalId)) {
    return;
  }

  const record = {
    key: key,
    signalId: signalId,

    asset: asset,
    timeframe: timeframe,
    direction: direction,

    entryPrice: Number(frame.price),
    entryLow:
      frame.entryLow == null
        ? null
        : Number(frame.entryLow),
    entryHigh:
      frame.entryHigh == null
        ? null
        : Number(frame.entryHigh),

    stop: Number(frame.stop),
    target: Number(frame.target),

    openedTs: now,
    lastStateTs: now,
    lastPrice: Number(frame.price),

    confidence:
      Number.isFinite(Number(frame.confidence))
        ? Number(frame.confidence)
        : 0,

    regime: frame.regime || 'NEUTRAL',

    status: 'OPEN',

    closeReason: null,
    exitPrice: null,
    exitTs: null,
    durationMs: null,

    pnlPct: 0,
    result: null
  };

  openSignals.set(key, record);
}

function onTrade(asset, price, ts) {
  const normalizedAsset =
    String(asset || '').toUpperCase();

  if (!normalizedAsset || !validPrice(price)) {
    return;
  }

  const tradePrice = Number(price);
  const tradeTs = Number(ts) || getNow();

  latestPrices.set(
    normalizedAsset,
    {
      price: tradePrice,
      ts: tradeTs
    }
  );

  for (const rec of Array.from(openSignals.values())) {
    if (rec.asset !== normalizedAsset) {
      continue;
    }

    rec.lastPrice = tradePrice;

    if (
      checkExpiry(
        rec,
        tradeTs,
        tradePrice
      )
    ) {
      continue;
    }

    if (rec.direction === 'BUY') {
      if (tradePrice >= rec.target) {
        closeSignal(
          rec,
          'TARGET_HIT',
          tradePrice,
          tradeTs
        );
      } else if (tradePrice <= rec.stop) {
        closeSignal(
          rec,
          'STOP_HIT',
          tradePrice,
          tradeTs
        );
      }
    }

    else if (rec.direction === 'SELL') {
      if (tradePrice <= rec.target) {
        closeSignal(
          rec,
          'TARGET_HIT',
          tradePrice,
          tradeTs
        );
      } else if (tradePrice >= rec.stop) {
        closeSignal(
          rec,
          'STOP_HIT',
          tradePrice,
          tradeTs
        );
      }
    }
  }
}

function buildBreakdown(records, keyFn) {
  const out = {};

  for (const rec of records) {
    const key = String(keyFn(rec));

    if (!out[key]) {
      out[key] = {
        total: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
        winRate: 0,
        totalPnl: 0,
        averagePnl: 0
      };
    }

    const bucket = out[key];

    bucket.total++;

    if (rec.result === 'WIN') {
      bucket.wins++;
    } else if (rec.result === 'LOSS') {
      bucket.losses++;
    } else {
      bucket.breakevens++;
    }

    bucket.totalPnl += Number(rec.pnlPct) || 0;
  }

  for (const bucket of Object.values(out)) {
    bucket.totalPnl = round(bucket.totalPnl, 4);
    bucket.winRate =
      bucket.total > 0
        ? round((bucket.wins / bucket.total) * 100, 2)
        : 0;
    bucket.averagePnl =
      bucket.total > 0
        ? round(bucket.totalPnl / bucket.total, 4)
        : 0;
  }

  return out;
}

function summary() {
  const records = closedSignals;

  let wins = 0;
  let losses = 0;
  let breakevens = 0;

  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  let bestPnl = null;
  let worstPnl = null;

  let totalDuration = 0;

  for (const rec of records) {
    const pnl = Number(rec.pnlPct) || 0;

    if (rec.result === 'WIN') {
      wins++;
      grossProfit += pnl;
    } else if (rec.result === 'LOSS') {
      losses++;
      grossLoss += Math.abs(pnl);
    } else {
      breakevens++;
    }

    totalPnl += pnl;

    if (bestPnl === null || pnl > bestPnl) {
      bestPnl = pnl;
    }

    if (worstPnl === null || pnl < worstPnl) {
      worstPnl = pnl;
    }

    if (Number.isFinite(rec.durationMs)) {
      totalDuration += rec.durationMs;
    }
  }

  const closed = records.length;
  const open = openSignals.size;
  const total = closed + open;

  const winRate =
    closed > 0
      ? round((wins / closed) * 100, 2)
      : 0;

  const averagePnl =
    closed > 0
      ? round(totalPnl / closed, 4)
      : 0;

  const averageWin =
    wins > 0
      ? round(grossProfit / wins, 4)
      : 0;

  const averageLoss =
    losses > 0
      ? round(-(grossLoss / losses), 4)
      : 0;

  const profitFactor =
    grossLoss > 0
      ? round(grossProfit / grossLoss, 4)
      : null;

  const averageDurationMs =
    closed > 0
      ? Math.round(totalDuration / closed)
      : 0;

  return {
    total: total,
    closed: closed,
    open: open,

    wins: wins,
    losses: losses,
    breakevens: breakevens,

    winRate: winRate,

    averagePnl: averagePnl,
    totalPnl: round(totalPnl, 4),

    grossProfit: round(grossProfit, 4),
    grossLoss: round(grossLoss, 4),

    averageWin: averageWin,
    averageLoss: averageLoss,

    profitFactor: profitFactor,

    bestPnl:
      bestPnl === null
        ? 0
        : round(bestPnl, 4),

    worstPnl:
      worstPnl === null
        ? 0
        : round(worstPnl, 4),

    averageDurationMs: averageDurationMs
  };
}

function snapshotJSON() {
  const allClosed = closedSignals;

  return {
    persisted: false,

    summary: summary(),

    open: Array.from(openSignals.values()).map(rec => {
      const latest = latestPrices.get(rec.asset);
      const livePrice =
        latest && validPrice(latest.price)
          ? latest.price
          : rec.entryPrice;

      return {
        signalId: rec.signalId,
        openedAt: rec.openedTs,

        asset: rec.asset,
        timeframe: rec.timeframe,
        direction: rec.direction,

        entryPrice: rec.entryPrice,
        entryLow: rec.entryLow,
        entryHigh: rec.entryHigh,

        stop: rec.stop,
        target: rec.target,

        confidence: rec.confidence,
        regime: rec.regime,

        status: rec.status,

        livePrice: livePrice,

        livePnl: round(
          calculatePnl(
            rec.direction,
            rec.entryPrice,
            livePrice
          ),
          4
        )
      };
    }),

    closed: allClosed.map(rec => ({
      signalId: rec.signalId,

      openedAt: rec.openedTs,
      exitTs: rec.exitTs,

      asset: rec.asset,
      timeframe: rec.timeframe,
      direction: rec.direction,

      entryPrice: rec.entryPrice,
      entryLow: rec.entryLow,
      entryHigh: rec.entryHigh,

      stop: rec.stop,
      target: rec.target,

      confidence: rec.confidence,
      regime: rec.regime,

      exitPrice: rec.exitPrice,
      durationMs: rec.durationMs,

      pnlPct: rec.pnlPct,
      closeReason: rec.closeReason,
      result: rec.result
    })),

    breakdowns: {
      direction: buildBreakdown(
        allClosed,
        rec => rec.direction
      ),

      asset: buildBreakdown(
        allClosed,
        rec => rec.asset
      ),

      timeframe: buildBreakdown(
        allClosed,
        rec => rec.timeframe
      ),

      confidence: buildBreakdown(
        allClosed,
        rec => {
          const confidence =
            Number(rec.confidence) || 0;

          if (confidence < 60) return '<60';
          if (confidence < 70) return '60-69';
          if (confidence < 80) return '70-79';
          if (confidence < 90) return '80-89';

          return '90+';
        }
      )
    }
  };
}

function broadcastSnapshot() {
  broadcaster({
    type: 'qwen-perf',
    ...snapshotJSON()
  });
}

function closedText(rec) {
  const sign = rec.pnlPct > 0 ? '+' : '';

  return (
    `[SIGNAL CLOSED] ${rec.asset} (${rec.timeframe}) ${rec.direction}\n` +
    `Reason: ${rec.closeReason}\n` +
    `P&L: ${sign}${rec.pnlPct.toFixed(2)}%\n` +
    `Entry: ${rec.entryPrice} -> Exit: ${rec.exitPrice}`
  );
}

module.exports = {
  init: init,
  onClose: onClose,
  onState: onState,
  onTrade: onTrade,
  debugTick: debugTick,

  summary: summary,
  snapshotJSON: snapshotJSON,
  broadcastSnapshot: broadcastSnapshot,
  closedText: closedText,

  _open: openSignals,
  _closed: closedSignals
};
