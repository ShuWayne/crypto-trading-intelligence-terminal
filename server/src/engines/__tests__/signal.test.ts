import { describe, expect, it } from 'vitest';
import {
  alertTypeForIndicatorState,
  evaluateIndicator,
  evaluateIndicatorAt,
  evaluateSignal,
  evaluateSignalAt,
} from '../signal.js';
import type { Candle } from '../../ta/indicators.js';

/**
 * Deterministic synthetic 4h candles that produce a genuine v3-B LONG:
 * 100 warm-up candles oscillating ±700 around 60,000 (ranging regime,
 * wide range), an 8-candle slide down to the range low (RSI extreme),
 * then a rejection candle closing in its upper half.
 */
function buildLongSetup(): Candle[] {
  const candles: Candle[] = [];
  let time = Date.parse('2026-03-24T16:00:00Z');
  const push = (open: number, high: number, low: number, close: number) => {
    candles.push({ time, open, high, low, close, volume: 100 });
    time += 4 * 60 * 60 * 1000;
  };
  // Warm-up: slow wide oscillation, amplitude 900 (wide range, but
  // small per-candle moves so Wilder RSI/ATR stay moderate).
  let prevClose = 60000;
  for (let i = 0; i < 100; i++) {
    const close = 60000 + 900 * Math.sin(i * 0.25);
    push(prevClose, Math.max(prevClose, close) + 120, Math.min(prevClose, close) - 120, close);
    prevClose = close;
  }
  // Down leg: 7 candles, -220 each, probing the range low (RSI < 32,
  // SMA20-SMA50 spread stays just inside the 1% ranging bound).
  for (let k = 0; k < 7; k++) {
    const close = prevClose - 220;
    push(prevClose, prevClose + 50, close - 80, close);
    prevClose = close;
  }
  // Rejection candle: closes +350 in its upper half.
  const open = prevClose;
  const close = open + 350;
  push(open, close + 60, open - 40, close);
  return candles;
}

/** Mirror of a long setup around 60,000 — must fire a SHORT. */
function mirrorShort(candles: Candle[]): Candle[] {
  return candles.map((c) => ({
    time: c.time,
    open: 120000 - c.open,
    high: 120000 - c.low,
    low: 120000 - c.high,
    close: 120000 - c.close,
    volume: c.volume,
  }));
}

describe('evaluateSignal — v3-B long setup', () => {
  it('fires a LONG on the constructed setup with 1:2 levels', () => {
    const candles = buildLongSetup();
    const sig = evaluateSignal(candles, 'BTCUSDT');
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe('long');
    expect(sig!.symbol).toBe('BTCUSDT');
    expect(sig!.timeframe).toBe('4h');
    expect(sig!.riskReward).toBe('1:2');
    const entry = candles[candles.length - 1].close;
    expect(sig!.entry).toBeCloseTo(entry, 9);
    // Single validated TP: takeProfit = entry + 3.0xATR -> exactly 1:2
    expect((sig!.takeProfit - sig!.entry) / (sig!.entry - sig!.stopLoss)).toBeCloseTo(2, 9);
    expect(sig!.takeProfit).toBeGreaterThan(sig!.entry);
    // No tp1/tp2/tp3 — v3-B has ONE validated TP (addendum-corrected).
    expect('tp1' in sig!).toBe(false);
    expect('tp2' in sig!).toBe(false);
    expect('tp3' in sig!).toBe(false);
    expect(sig!.exitConditions).toEqual(['SL', 'TIME 96h', 'HALT']);
    expect(sig!.signalTimestamp).toBe(
      new Date(candles[candles.length - 1].time + 4 * 60 * 60 * 1000).toISOString(),
    );
    expect(sig!.confidence).toBeGreaterThanOrEqual(5);
    expect(sig!.confidence).toBeLessThanOrEqual(90);
    expect(sig!.reason).toContain('v3-B LONG');
    expect(sig!.structure).toContain('Range');
    expect(sig!.invalidation).toContain('stop-loss');
  });

  it('expiresAt is the entry candle close + 4h', () => {
    const candles = buildLongSetup();
    const sig = evaluateSignal(candles);
    const last = candles[candles.length - 1];
    const expected = new Date(last.time + 8 * 60 * 60 * 1000).toISOString();
    expect(sig!.expiresAt).toBe(expected);
  });

  it('is deterministic: same candles give the same confidence', () => {
    const a = evaluateSignal(buildLongSetup());
    const b = evaluateSignal(buildLongSetup());
    expect(a!.confidence).toBe(b!.confidence);
    expect(a!.entry).toBe(b!.entry);
  });
});

describe('evaluateSignal — v3-B short setup (mirror)', () => {
  it('fires a SHORT on the mirrored series', () => {
    const sig = evaluateSignal(mirrorShort(buildLongSetup()), 'SOLUSDT');
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe('short');
    expect((sig!.entry - sig!.takeProfit) / (sig!.stopLoss - sig!.entry)).toBeCloseTo(2, 9);
    expect(sig!.reason).toContain('v3-B SHORT');
  });
});

describe('evaluateSignal — NO TRADE cases', () => {
  it('returns null during warm-up (< 100 candles) with a warm-up reason', () => {
    const candles = buildLongSetup().slice(0, 50);
    const ev = evaluateSignalAt(candles, candles.length - 1);
    expect(ev.signal).toBeNull();
    expect(ev.reason).toContain('warm-up');
    expect(ev.checks.warmup).toBe(false);
  });

  it('returns null in a strong trend (SMA spread > 1% of close)', () => {
    const candles: Candle[] = [];
    let time = Date.parse('2026-03-24T16:00:00Z');
    let close = 50000;
    for (let i = 0; i < 120; i++) {
      const open = close;
      close = close * 1.004; // steady +0.4% per 4h candle
      candles.push({ time, open, high: close + 50, low: open - 50, close, volume: 100 });
      time += 4 * 60 * 60 * 1000;
    }
    const ev = evaluateSignalAt(candles, candles.length - 1);
    expect(ev.signal).toBeNull();
    expect(ev.reason).toContain('trending');
  });

  it('returns null when ranging but no boundary is touched', () => {
    // Warm-up oscillation only, plus one more candle so the index
    // clears the 100-candle warm-up (no down leg / rejection).
    const candles = buildLongSetup().slice(0, 100);
    const prevClose = candles[candles.length - 1].close;
    const close = 60000 + 900 * Math.sin(100 * 0.25);
    candles.push({
      time: candles[candles.length - 1].time + 4 * 60 * 60 * 1000,
      open: prevClose,
      high: Math.max(prevClose, close) + 120,
      low: Math.min(prevClose, close) - 120,
      close,
      volume: 100,
    });
    const ev = evaluateSignalAt(candles, candles.length - 1);
    expect(ev.signal).toBeNull();
    expect(ev.reason).toContain('boundary touch');
  });

  it('returns null when the volatility guard fires (TR > 2.5xATR)', () => {
    const candles = buildLongSetup();
    const last = candles[candles.length - 1];
    // Widen the confirmation candle's range moderately: true range
    // ~1,350 vs ~2.5xATR ≈ 1,090, so the guard fires — without
    // inflating ATR so much that the range-width check fails first.
    candles[candles.length - 1] = {
      ...last,
      high: last.close + 500,
      low: last.open - 500,
    };
    const ev = evaluateSignalAt(candles, candles.length - 1);
    expect(ev.signal).toBeNull();
    expect(ev.reason).toContain('volatility guard');
    expect(ev.side).toBe('long');
  });

  it('returns null on empty input', () => {
    expect(evaluateSignal([])).toBeNull();
  });

  it('returns null one candle before the rejection candle (no setup yet)', () => {
    const candles = buildLongSetup().slice(0, -1);
    expect(evaluateSignal(candles)).toBeNull();
  });
});

describe('evaluateIndicator — v3-B indicator states', () => {
  it('CONFIRMED_BUY on the long setup, with range/RSI/distances populated', () => {
    const ev = evaluateIndicator(buildLongSetup());
    expect(ev.state).toBe('CONFIRMED_BUY');
    expect(ev.regime).toBe('RANGING');
    expect(ev.rangeLow).not.toBeNull();
    expect(ev.rangeHigh).not.toBeNull();
    expect(ev.rangeLow!).toBeLessThan(ev.rangeHigh!);
    expect(ev.rangeWidthAtr).toBeGreaterThanOrEqual(4);
    expect(ev.rsi).toBeCloseTo(33.3, 0);
    expect(ev.distanceToLowAtr).not.toBeNull();
    expect(ev.distanceToHighAtr).not.toBeNull();
    expect(ev.distanceToLowAtr!).toBeLessThan(ev.distanceToHighAtr!);
    expect(ev.reason).toContain('CONFIRMED BUY');
    expect(alertTypeForIndicatorState(ev.state)).toBe('BUY_SETUP');
  });

  it('CONFIRMED_SELL on the mirrored series', () => {
    const ev = evaluateIndicator(mirrorShort(buildLongSetup()));
    expect(ev.state).toBe('CONFIRMED_SELL');
    expect(ev.regime).toBe('RANGING');
    expect(ev.reason).toContain('CONFIRMED SELL');
    expect(alertTypeForIndicatorState(ev.state)).toBe('EXIT_TRIGGER');
  });

  it('VALID_RANGE on the warm-up oscillation (ranging, no setup)', () => {
    const candles = buildLongSetup().slice(0, 100);
    const prevClose = candles[candles.length - 1].close;
    const close = 60000 + 900 * Math.sin(100 * 0.25);
    candles.push({
      time: candles[candles.length - 1].time + 4 * 60 * 60 * 1000,
      open: prevClose,
      high: Math.max(prevClose, close) + 120,
      low: Math.min(prevClose, close) - 120,
      close,
      volume: 100,
    });
    const ev = evaluateIndicator(candles);
    expect(ev.state).toBe('VALID_RANGE');
    expect(ev.regime).toBe('RANGING');
    expect(ev.rangeWidthAtr).toBeGreaterThanOrEqual(4);
    expect(alertTypeForIndicatorState(ev.state)).toBeNull();
  });

  it('APPROACHING_LOW mid-slide (near the low, RSI extreme, no rejection yet)', () => {
    // Index 105: 6th down-leg candle — close near the range low but
    // close < open, so no v3-B rejection/confirmation yet.
    const ev = evaluateIndicatorAt(buildLongSetup(), 105);
    expect(ev.state).toBe('APPROACHING_LOW');
    expect(ev.distanceToLowAtr).not.toBeNull();
    expect(ev.distanceToLowAtr!).toBeLessThanOrEqual(1.0);
    expect(alertTypeForIndicatorState(ev.state)).toBeNull();
  });

  it('UNSUITABLE_TRENDING on a steady uptrend', () => {
    const candles: Candle[] = [];
    let time = Date.parse('2026-03-24T16:00:00Z');
    let close = 50000;
    for (let i = 0; i < 120; i++) {
      const open = close;
      close = close * 1.004;
      candles.push({ time, open, high: close + 50, low: open - 50, close, volume: 100 });
      time += 4 * 60 * 60 * 1000;
    }
    const ev = evaluateIndicator(candles);
    expect(ev.state).toBe('UNSUITABLE_TRENDING');
    expect(ev.regime).toBe('TRENDING');
    expect(ev.reason).toContain('trending');
    expect(alertTypeForIndicatorState(ev.state)).toBe('RANGE_INVALID');
  });

  it('UNSUITABLE_VOLATILITY when the setup candle blows out its range', () => {
    const candles = buildLongSetup();
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = {
      ...last,
      high: last.close + 500,
      low: last.open - 500,
    };
    const ev = evaluateIndicator(candles);
    expect(ev.state).toBe('UNSUITABLE_VOLATILITY');
    expect(alertTypeForIndicatorState(ev.state)).toBe('VOLATILITY_UNSUITABLE');
  });

  it('BREAKDOWN_AVOID when a candle closes below the range low', () => {
    const candles = buildLongSetup().slice(0, 101);
    const prevClose = candles[candles.length - 1].close;
    // Slam the close ~1,500 below the range low; no rejection, no setup.
    const close = prevClose - 1500;
    candles.push({
      time: candles[candles.length - 1].time + 4 * 60 * 60 * 1000,
      open: prevClose,
      high: prevClose + 10,
      low: close - 10,
      close,
      volume: 100,
    });
    const ev = evaluateIndicator(candles);
    expect(ev.state).toBe('BREAKDOWN_AVOID');
    expect(ev.reason).toContain('below the range low');
    expect(alertTypeForIndicatorState(ev.state)).toBe('RANGE_INVALID');
  });

  it('NO_TRADE during warm-up and on empty input', () => {
    expect(evaluateIndicator(buildLongSetup().slice(0, 50)).state).toBe('NO_TRADE');
    const empty = evaluateIndicator([]);
    expect(empty.state).toBe('NO_TRADE');
    expect(empty.rangeLow).toBeNull();
    expect(empty.rsi).toBeNull();
  });

  it('alert mapping covers every alert type the backend consumes', () => {
    // BUY_SETUP, EXIT_TRIGGER, RANGE_INVALID, VOLATILITY_UNSUITABLE
    // come from indicator states; SL_HIT / TP_HIT come from paper
    // EXIT events (exitReason SL / TP) — the union type itself is the
    // contract, checked here by construction.
    expect(alertTypeForIndicatorState('CONFIRMED_BUY')).toBe('BUY_SETUP');
    expect(alertTypeForIndicatorState('CONFIRMED_SELL')).toBe('EXIT_TRIGGER');
    expect(alertTypeForIndicatorState('BREAKDOWN_AVOID')).toBe('RANGE_INVALID');
    expect(alertTypeForIndicatorState('UNSUITABLE_TRENDING')).toBe('RANGE_INVALID');
    expect(alertTypeForIndicatorState('UNSUITABLE_VOLATILITY')).toBe('VOLATILITY_UNSUITABLE');
    expect(alertTypeForIndicatorState('VALID_RANGE')).toBeNull();
    expect(alertTypeForIndicatorState('NO_TRADE')).toBeNull();
  });
});
