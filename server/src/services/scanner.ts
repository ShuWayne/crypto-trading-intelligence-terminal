/**
 * Market scanner — all 8 overview symbols on 4h candles.
 * Regime / RSI / ATR / SMA come from the canonical TA module
 * (server/src/ta/indicators.ts); the signal column uses the v3-B engine.
 * Signal column: LONG_SETUP / SHORT_SETUP only for the validated v3-B
 * universe (BTC/SOL); every other symbol reports NONE with the reason
 * that it is outside the validated universe — never a silent inclusion.
 */
import { binance, OVERVIEW_SYMBOLS, SIGNAL_SYMBOLS } from './binance.js';
import { computeIndicators } from '../ta/indicators.js';
import { evaluateIndicator } from './indicator.js';

export interface ScannerRow {
  symbol: string;
  price: number;
  change24hPct: number;
  rsi14_4h: number | null;
  atr14_4h: number | null;
  sma20: number | null;
  sma50: number | null;
  regime: 'RANGING' | 'TRENDING_UP' | 'TRENDING_DOWN';
  rangeWidthAtr: number | null;
  volumeSpike: boolean;
  signal: 'LONG_SETUP' | 'SHORT_SETUP' | 'NONE';
  reason: string;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; data: { updatedAt: string; rows: ScannerRow[] } } | null = null;

function lastOrNull(values: number[]): number | null {
  if (!values.length) return null;
  const v = values[values.length - 1];
  return Number.isFinite(v) ? v : null;
}

function roundOrNull(v: number | null, decimals: number): number | null {
  if (v === null) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export async function getScanner(): Promise<{ updatedAt: string; source: string; rows: ScannerRow[] }> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, source: binance.source() };
  }
  const tickers = await binance.getTickers([...OVERVIEW_SYMBOLS]);
  const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));

  const rows: ScannerRow[] = [];
  for (const symbol of OVERVIEW_SYMBOLS) {
    const ticker = bySymbol.get(symbol);
    const candles = await binance.getClosedKlines(symbol, '4h', 120);
    const closes = candles.map((c) => c.close);
    const ind = computeIndicators(candles);
    const sma20 = lastOrNull(ind.sma20);
    const sma50 = lastOrNull(ind.sma50);
    const rsi14 = lastOrNull(ind.rsi14);
    const atr14 = lastOrNull(ind.atr14);
    const swingHigh = lastOrNull(ind.swingHigh);
    const swingLow = lastOrNull(ind.swingLow);
    const volSma20 = lastOrNull(ind.volumeSma20);
    const last = candles.length ? candles[candles.length - 1] : null;

    let regime: ScannerRow['regime'] = 'RANGING';
    if (sma20 !== null && sma50 !== null && closes.length) {
      const close = closes[closes.length - 1];
      if (Math.abs(sma20 - sma50) / close <= 0.01) regime = 'RANGING';
      else if (sma20 > sma50) regime = 'TRENDING_UP';
      else regime = 'TRENDING_DOWN';
    }

    const rangeWidthAtr =
      swingHigh !== null && swingLow !== null && atr14
        ? Math.round(((swingHigh - swingLow) / atr14) * 100) / 100
        : null;
    const volumeSpike = last !== null && volSma20 !== null ? last.volume > 1.5 * volSma20 : false;

    let signal: ScannerRow['signal'] = 'NONE';
    let reason = 'No v3-B setup on the last closed 4h candle.';
    const validated = (SIGNAL_SYMBOLS as readonly string[]).includes(symbol);
    if (validated && candles.length) {
      const ev = evaluateIndicator(symbol, candles, true);
      if (ev.state === 'CONFIRMED_BUY') {
        signal = 'LONG_SETUP';
        reason = ev.reason;
      } else if (ev.state === 'CONFIRMED_SELL') {
        signal = 'SHORT_SETUP';
        reason = ev.reason;
      } else {
        reason = ev.reason;
      }
    } else if (!validated) {
      reason = `${symbol} is outside the validated v3-B universe (BTC/SOL only) — scanner shows regime only, no signal.`;
    }

    rows.push({
      symbol,
      price: ticker?.price ?? (closes.length ? closes[closes.length - 1] : 0),
      change24hPct: ticker?.change24hPct ?? 0,
      rsi14_4h: roundOrNull(rsi14, 1),
      atr14_4h: roundOrNull(atr14, 2),
      sma20: roundOrNull(sma20, 2),
      sma50: roundOrNull(sma50, 2),
      regime,
      rangeWidthAtr,
      volumeSpike,
      signal,
      reason,
    });
  }

  const data = { updatedAt: new Date().toISOString(), rows };
  cache = { at: now, data };
  return { ...data, source: binance.source() };
}
