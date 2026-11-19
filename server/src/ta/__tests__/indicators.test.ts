import { describe, expect, it } from 'vitest';
import {
  atr,
  computeIndicators,
  rsi,
  sma,
  smaClose,
  swingHigh,
  swingLow,
  trueRange,
  volumeSma,
  type Candle,
} from '../indicators.js';

function candle(
  close: number,
  opts: Partial<Candle> = {},
): Candle {
  return {
    time: opts.time ?? 0,
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 100,
  };
}

// Reference values computed with the Python originals
// (wilder_rsi / wilder_atr from backtest_v3.py) on the same series.
const closes = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 110, 108, 111, 113, 112, 114, 116, 115, 117, 119];

describe('sma', () => {
  it('averages the last n values and is NaN before n values exist', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it('smaClose uses closes', () => {
    const cs = closes.map((c) => candle(c));
    const out = smaClose(cs, 20);
    expect(out[19]).toBeCloseTo(closes.reduce((a, b) => a + b, 0) / 20, 10);
    expect(out[18]).toBeNaN();
  });
});

describe('rsi (Wilder, 14)', () => {
  it('is NaN until index 14 and matches the Python Wilder RSI', () => {
    const out = rsi(closes, 14);
    for (let i = 0; i < 14; i++) expect(out[i]).toBeNaN();
    // Python wilder_rsi on this series: rsi[14]=75.0, rsi[15]=77.0588, rsi[19]=79.4702
    expect(out[14]).toBeCloseTo(75.0, 3);
    expect(out[15]).toBeCloseTo(77.0588, 3);
    expect(out[19]).toBeCloseTo(79.4702, 3);
  });

  it('is 100 on an all-up series (zero average loss)', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = rsi(up, 14);
    expect(out[14]).toBe(100);
    expect(out[19]).toBe(100);
  });

  it('is 0 on an all-down series', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    const out = rsi(down, 14);
    expect(out[14]).toBe(0);
  });

  it('never changes earlier values when a candle is appended (no repainting)', () => {
    const a = rsi(closes, 14);
    const b = rsi([...closes, 130], 14);
    for (let i = 0; i < closes.length; i++) {
      if (Number.isNaN(a[i])) expect(b[i]).toBeNaN();
      else expect(b[i]).toBeCloseTo(a[i], 12);
    }
  });
});

describe('atr (Wilder, 14)', () => {
  it('true range uses the previous close', () => {
    const cs = [
      candle(100, { high: 102, low: 99 }),
      candle(105, { high: 108, low: 103 }),
    ];
    expect(trueRange(cs, 0)).toBeCloseTo(3, 10);
    // max(108-103, |108-100|, |103-100|) = 8
    expect(trueRange(cs, 1)).toBeCloseTo(8, 10);
  });

  it('matches the Python Wilder ATR on a known series', () => {
    const cs = closes.map((c, i) =>
      candle(c, { high: c + 1, low: c - 1, time: i * 14400000 }),
    );
    const { atr: out, tr } = atr(cs, 14);
    for (let i = 0; i < 14; i++) expect(out[i]).toBeNaN();
    expect(tr[0]).toBeCloseTo(2, 10);
    // TR is 3 for every candle after the first (high-low=2, |high-prevClose|=2..3 -> 3 when close rises by 2... check: close 102 prev 100, high 103 -> |103-100|=3)
    expect(out[14]).toBeCloseTo(tr.slice(1, 15).reduce((a, b) => a + b, 0) / 14, 10);
    expect(out[14]).toBeGreaterThan(0);
  });

  it('never changes earlier values when a candle is appended', () => {
    const cs = closes.map((c) => candle(c, { high: c + 1, low: c - 1 }));
    const a = atr(cs, 14).atr;
    const b = atr([...cs, candle(130, { high: 131, low: 129 })], 14).atr;
    for (let i = 0; i < cs.length; i++) {
      if (Number.isNaN(a[i])) expect(b[i]).toBeNaN();
      else expect(b[i]).toBeCloseTo(a[i], 12);
    }
  });
});

describe('swing high/low (20 candles, excluding current)', () => {
  it('is NaN until 20 prior candles exist and excludes the current candle', () => {
    const cs = Array.from({ length: 25 }, (_, i) =>
      candle(100, { high: 100 + i, low: 100 - i }),
    );
    const hi = swingHigh(cs, 20);
    const lo = swingLow(cs, 20);
    expect(hi[19]).toBeNaN();
    expect(hi[20]).toBe(119); // max high of candles 0..19
    expect(hi[21]).toBe(120); // max high of candles 1..20
    expect(lo[20]).toBe(81); // min low of candles 0..19
    expect(lo[24]).toBe(77); // min low of candles 4..23
  });
});

describe('volumeSma', () => {
  it('averages volume', () => {
    const cs = [10, 20, 30, 40].map((v) => candle(100, { volume: v }));
    const out = volumeSma(cs, 2);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeCloseTo(15, 10);
    expect(out[3]).toBeCloseTo(35, 10);
  });
});

describe('computeIndicators', () => {
  it('returns aligned arrays with NaN warm-up', () => {
    const cs = [...closes, 120, 121, 120, 122, 123].map((c) => candle(c, { high: c + 1, low: c - 1 }));
    const ind = computeIndicators(cs);
    expect(ind.sma20.length).toBe(cs.length);
    expect(ind.sma50[19]).toBeNaN(); // needs 50 closes
    expect(ind.rsi14[13]).toBeNaN();
    expect(Number.isFinite(ind.rsi14[14])).toBe(true);
    expect(ind.swingHigh[19]).toBeNaN();
    expect(Number.isFinite(ind.swingHigh[20])).toBe(true);
    expect(ind.volumeSma20[19]).toBeCloseTo(100, 10);
  });
});
