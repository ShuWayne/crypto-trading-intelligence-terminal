/**
 * Technical indicators — pure functions over closed candles only.
 *
 * Port of the indicator math in `backtest_v3.py` / `backtest.py`
 * (~/workspace/trading/binance-system/), which in turn implements
 * STRATEGY-v3-b.md §2. Every function is closed-candle only: the value
 * at index `i` is computed from candles `0..i` and never from a later
 * candle. No lookahead, no repainting — appending a new candle never
 * changes an earlier value.
 *
 * Conventions (matching the Python exactly, including its quirks):
 * - RSI(14): Wilder's smoothing. The first RSI value lands at index 14
 *   (average of the first 14 one-period gains/losses); later values use
 *   Wilder's recursive update. RSI is 100 when average loss is 0.
 * - ATR(14): Wilder's ATR over true range. The first ATR value lands at
 *   index 14 (mean of true ranges 1..14); later values use Wilder's
 *   recursive update. True range of candle 0 is high - low.
 * - SMA(n): simple mean of the last n closes; NaN until n closes exist.
 * - Swing high/low: max high / min low of the last 20 candles EXCLUDING
 *   the current one (pandas `shift(1).rolling(20)`); NaN until 20 prior
 *   candles exist (index < 20).
 */

export interface Candle {
  /** Open time of the candle, milliseconds since epoch (Binance kline open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const RSI_PERIOD = 14;
export const ATR_PERIOD = 14;
export const SWING_WINDOW = 20;

/** True range of candle `i` (needs the previous candle's close for i > 0). */
export function trueRange(candles: readonly Candle[], i: number): number {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const prevClose = candles[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/** Simple moving average of `values`; NaN until `period` values exist. */
export function sma(values: readonly number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** SMA of candle closes. */
export function smaClose(candles: readonly Candle[], period: number): number[] {
  return sma(candles.map((c) => c.close), period);
}

/**
 * Wilder's RSI, period `n` (default 14). First value at index `n`.
 * Matches `wilder_rsi` in backtest_v3.py exactly.
 */
export function rsi(closes: readonly number[], n = RSI_PERIOD): number[] {
  const out: number[] = new Array(closes.length).fill(Number.NaN);
  if (closes.length <= n) return out;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(ch > 0 ? ch : 0);
    losses.push(ch < 0 ? -ch : 0);
  }
  // gains[k] is the change closes[k+1] - closes[k]; the first n changes
  // are gains[0..n-1]. RSI lands at index n.
  let avgGain = gains.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let avgLoss = losses.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  for (let i = n + 1; i < closes.length; i++) {
    avgGain = (avgGain * (n - 1) + gains[i - 1]) / n;
    avgLoss = (avgLoss * (n - 1) + losses[i - 1]) / n;
    out[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  }
  return out;
}

/** RSI(14) of candle closes. */
export function rsiClose(candles: readonly Candle[], n = RSI_PERIOD): number[] {
  return rsi(candles.map((c) => c.close), n);
}

/**
 * Wilder's ATR, period `n` (default 14). Returns `{ atr, tr }` where
 * `tr` is the true-range series. First ATR value at index `n`
 * (mean of true ranges 1..n). Matches `wilder_atr` in backtest_v3.py.
 */
export function atr(
  candles: readonly Candle[],
  n = ATR_PERIOD,
): { atr: number[]; tr: number[] } {
  const tr: number[] = candles.map((_, i) => trueRange(candles, i));
  const out: number[] = new Array(candles.length).fill(Number.NaN);
  if (candles.length <= n) return { atr: out, tr };
  let sum = 0;
  for (let k = 1; k <= n; k++) sum += tr[k];
  out[n] = sum / n;
  for (let i = n + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (n - 1) + tr[i]) / n;
  }
  return { atr: out, tr };
}

/**
 * Swing high: max high of the last `window` candles EXCLUDING the
 * current one. NaN until `window` prior candles exist.
 */
export function swingHigh(candles: readonly Candle[], window = SWING_WINDOW): number[] {
  const out: number[] = new Array(candles.length).fill(Number.NaN);
  for (let i = window; i < candles.length; i++) {
    let m = -Infinity;
    for (let k = i - window; k < i; k++) m = Math.max(m, candles[k].high);
    out[i] = m;
  }
  return out;
}

/**
 * Swing low: min low of the last `window` candles EXCLUDING the
 * current one. NaN until `window` prior candles exist.
 */
export function swingLow(candles: readonly Candle[], window = SWING_WINDOW): number[] {
  const out: number[] = new Array(candles.length).fill(Number.NaN);
  for (let i = window; i < candles.length; i++) {
    let m = Infinity;
    for (let k = i - window; k < i; k++) m = Math.min(m, candles[k].low);
    out[i] = m;
  }
  return out;
}

/** SMA of candle volume. */
export function volumeSma(candles: readonly Candle[], period: number): number[] {
  return sma(candles.map((c) => c.volume), period);
}

export interface IndicatorSet {
  sma20: number[];
  sma50: number[];
  rsi14: number[];
  atr14: number[];
  tr: number[];
  swingHigh: number[];
  swingLow: number[];
  volumeSma20: number[];
}

/**
 * Compute the full indicator set for a candle array, aligned by index
 * (NaN where the indicator is not yet defined). One pass, closed
 * candles only.
 */
export function computeIndicators(candles: readonly Candle[]): IndicatorSet {
  const closes = candles.map((c) => c.close);
  const { atr: atr14, tr } = atr(candles, ATR_PERIOD);
  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, RSI_PERIOD),
    atr14,
    tr,
    swingHigh: swingHigh(candles, SWING_WINDOW),
    swingLow: swingLow(candles, SWING_WINDOW),
    volumeSma20: sma(candles.map((c) => c.volume), 20),
  };
}
