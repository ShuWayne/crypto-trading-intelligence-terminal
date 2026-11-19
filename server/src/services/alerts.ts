/**
 * Alert feed — persisted in SQLite (alerts table), newest first.
 *
 * Alerts are generated from real state transitions, never fabricated:
 *   - BUY_SETUP: v3-B indicator flips to CONFIRMED_BUY (BTC/SOL).
 *   - EXIT_TRIGGER: confirmed SELL setup (range-high rejection — exit/avoid
 *     longs), an ACTIVE signal expires, or a paper exit with reason TIME/HALT.
 *   - SL_HIT / TP_HIT: paper-trades.csv EXIT rows with reason SL / TP.
 *   - RANGE_INVALID: indicator flips to BREAKDOWN_AVOID or out of a valid range.
 *   - VOLATILITY_UNSUITABLE: indicator flips to UNSUITABLE_VOLATILITY.
 *
 * Dedupe: one alert per (type, symbol, trigger key); transitions are
 * tracked in memory per symbol so a steady state does not spam.
 */
import { binance, SIGNAL_SYMBOLS } from './binance.js';
import { getDb, type AlertRow } from './db.js';
import { evaluateIndicator, type IndicatorState } from './indicator.js';
import { readPaperLog } from './risk.js';

const lastState = new Map<string, IndicatorState>();
const seenPaperExits = new Set<string>();

function insertAlert(a: Omit<AlertRow, 'id' | 'createdAt'>): void {
  try {
    getDb().insertAlert(a);
  } catch {
    /* alerts must never break the request path */
  }
}

function alertId(type: string, symbol: string, key: string): string {
  return `${type}:${symbol}:${key}`;
}

/** Scan the paper log for exits not yet alerted (SL_HIT / TP_HIT / EXIT_TRIGGER). */
function scanPaperLog(): void {
  for (const row of readPaperLog()) {
    if (row.type !== 'EXIT') continue;
    const key = `${row.tradeId}:${row.exitTime}`;
    if (seenPaperExits.has(key)) continue;
    seenPaperExits.add(key);
    if (row.exitReason === 'SL') {
      insertAlert({
        alertId: alertId('SL_HIT', row.symbol, key),
        type: 'SL_HIT',
        symbol: row.symbol,
        message: `${row.symbol} paper position hit stop loss at ${row.exit} (PnL $${row.pnl.toFixed(2)}).`,
        time: row.exitTime ? new Date(row.exitTime).toISOString() : new Date().toISOString(),
        severity: 'WARNING',
      });
    } else if (row.exitReason === 'TP') {
      insertAlert({
        alertId: alertId('TP_HIT', row.symbol, key),
        type: 'TP_HIT',
        symbol: row.symbol,
        message: `${row.symbol} paper position hit the validated TP (+2R) at ${row.exit} (PnL $${row.pnl.toFixed(2)}).`,
        time: row.exitTime ? new Date(row.exitTime).toISOString() : new Date().toISOString(),
        severity: 'INFO',
      });
    } else {
      insertAlert({
        alertId: alertId('EXIT_TRIGGER', row.symbol, key),
        type: 'EXIT_TRIGGER',
        symbol: row.symbol,
        message: `${row.symbol} paper position exited (${row.exitReason}) at ${row.exit} (PnL $${row.pnl.toFixed(2)}).`,
        time: row.exitTime ? new Date(row.exitTime).toISOString() : new Date().toISOString(),
        severity: 'INFO',
      });
    }
  }
}

/** Evaluate BTC/SOL indicator states and emit transition alerts. */
async function scanIndicatorTransitions(): Promise<void> {
  for (const symbol of SIGNAL_SYMBOLS) {
    let candles;
    try {
      candles = await binance.getClosedKlines(symbol, '4h', 120);
    } catch {
      continue; // Binance down — no alerts invented from stale data.
    }
    const result = await evaluateIndicator(symbol, candles, true);
    const prev = lastState.get(symbol);
    if (prev === result.state) continue;
    lastState.set(symbol, result.state);
    if (prev === undefined) continue; // First observation establishes the baseline, no alert.
    const now = new Date().toISOString();
    const candleKey = result.lastCandle ? String(result.lastCandle.time) : now;
    switch (result.state) {
      case 'CONFIRMED_BUY':
        insertAlert({
          alertId: alertId('BUY_SETUP', symbol, candleKey),
          type: 'BUY_SETUP',
          symbol,
          message: `${symbol}: ${result.reason}`,
          time: now,
          severity: 'INFO',
        });
        break;
      case 'CONFIRMED_SELL':
        insertAlert({
          alertId: alertId('EXIT_TRIGGER', symbol, candleKey),
          type: 'EXIT_TRIGGER',
          symbol,
          message: `${symbol}: confirmed v3-B SELL setup — ${result.reason} Exit/avoid longs.`,
          time: now,
          severity: 'WARNING',
        });
        break;
      case 'BREAKDOWN_AVOID':
        insertAlert({
          alertId: alertId('RANGE_INVALID', symbol, candleKey),
          type: 'RANGE_INVALID',
          symbol,
          message: `${symbol}: ${result.reason}`,
          time: now,
          severity: 'WARNING',
        });
        break;
      case 'UNSUITABLE_VOLATILITY':
        insertAlert({
          alertId: alertId('VOLATILITY_UNSUITABLE', symbol, candleKey),
          type: 'VOLATILITY_UNSUITABLE',
          symbol,
          message: `${symbol}: ${result.reason}`,
          time: now,
          severity: 'WARNING',
        });
        break;
      case 'UNSUITABLE_TRENDING':
        insertAlert({
          alertId: alertId('RANGE_INVALID', symbol, candleKey),
          type: 'RANGE_INVALID',
          symbol,
          message: `${symbol}: range no longer valid — ${result.reason}`,
          time: now,
          severity: 'WARNING',
        });
        break;
      default:
        break;
    }
  }
}

/** Expire stored ACTIVE signals whose expiresAt has passed. */
function expireStaleSignals(): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    for (const s of db.listSignals(20)) {
      if (s.status === 'ACTIVE' && s.expiresAt < now) {
        db.updateSignalStatus(s.id, 'EXPIRED');
        insertAlert({
          alertId: alertId('EXIT_TRIGGER', s.symbol, `expired:${s.id}`),
          type: 'EXIT_TRIGGER',
          symbol: s.symbol,
          message: `${s.symbol} signal ${s.id} expired (96h max hold reached without TP/SL).`,
          time: now,
          severity: 'INFO',
        });
      }
    }
  } catch {
    /* never break the request path */
  }
}

/** Refresh all alert sources. Safe to call on every /api/alerts request. */
export async function refreshAlerts(): Promise<void> {
  scanPaperLog();
  expireStaleSignals();
  await scanIndicatorTransitions();
}

export async function listAlerts(limit = 50, symbol?: string): Promise<{
  alerts: { id: string; type: AlertRow['type']; symbol: string; message: string; time: string; severity: AlertRow['severity'] }[];
}> {
  await refreshAlerts();
  const rows = getDb().listAlerts(limit, symbol);
  return {
    alerts: rows.map((r) => ({
      id: r.alertId,
      type: r.type,
      symbol: r.symbol,
      message: r.message,
      time: r.time,
      severity: r.severity,
    })),
  };
}
