/**
 * Signal engine — v3-B "Range Mean-Reversion" ONLY (STRATEGY-v3-b.md),
 * the single validated design (240-day backtest: 17 trades, 47.1% win
 * rate, PF 1.75, net +$72.42 — RESULTS-v3-b.md). Variants A/C and
 * v1.0/v2.0 FAILED and are never signalled here; their entry logic
 * lives only in the backtest engine for honest historical comparison.
 *
 * Pure functions, no network calls. Input is an array of CLOSED 4h
 * candles (the caller passes live 4h klines); the signal is evaluated
 * at the last candle (or at index `i` via `evaluateSignalAt`).
 *
 * Entry rules (STRATEGY-v3-b.md §3, all on the same closed 4h
 * "confirmation candle", entry at its close):
 *  3.1 Ranging regime: |SMA20 - SMA50| <= 1.0% of close AND
 *      range width (20-candle swing high - swing low) >= 4 x ATR(14).
 *  3.2 Boundary touch (current or previous candle): long: min(low) <=
 *      swing_low + 0.5 x ATR; short: max(high) >= swing_high - 0.5 x ATR.
 *  3.3 RSI extreme (same 2 candles): long: min(RSI) < 32;
 *      short: max(RSI) > 68.
 *  3.4 Rejection (current candle): long: close > open AND close >
 *      (high+low)/2 AND RSI <= 40; short: mirror with RSI >= 60.
 *  3.5 Volatility guard: skip if the confirmation candle's true range
 *      > 2.5 x ATR(14).
 * Position (STRATEGY-v3-b.md §4): entry = confirmation close, SL =
 * entry ∓ 1.5 x ATR, TP = entry ± 3.0 x ATR (R:R 1:2), size =
 * $15 / (1.5 x ATR). Max hold 96h (24 x 4h candles).
 *
 * Confidence formula (documented, deterministic — never random):
 *   confidence = clamp(round(
 *     47.1                       // base: validated v3-B backtest win
 *                                //   rate, 8/17 = 47.1% (RESULTS-v3-b.md)
 *     + 15 * rsiDepth            // long: (32 - minRsi)/32, short:
 *                                //   (maxRsi - 68)/32, clamped 0..1 —
 *                                //   deeper RSI extreme = stronger fade
 *     + 10 * rejectionStrength  // long: (close - mid) / (0.5 * range),
 *                                //   short mirrored, clamped 0..1 —
 *                                //   close nearer the high (long) = a
 *                                //   harder rejection of the range low
 *     + 10 * rangeBonus         // clamp((rangeWidthAtr - 4) / 8, 0, 1):
 *                                //   4xATR -> 0, >= 12xATR -> 1 — a
 *                                //   wider range leaves more room to
 *                                //   the 2R target
 *     + 5 * flatness            // 1 - |SMA20-SMA50| / (1% of close),
 *                                //   clamped 0..1 — flatter averages =
 *                                //   cleaner ranging regime
 *   ), 5, 90)
 * Maximum possible is 47.1 + 15 + 10 + 10 + 5 = 87.1, so the 90 cap
 * never binds on a real setup; the 5 floor only guards degenerate
 * inputs. A setup that passes every rule therefore scores roughly
 * 50–87 depending on quality — never 95+ on 17 trades of evidence.
 */

import {
  computeIndicators,
  type Candle,
  type IndicatorSet,
} from '../ta/indicators.js';
import {
  VOL_GUARD_ATR,
  computeTrade,
  type Side,
} from './risk.js';

export const WARMUP_CANDLES = 100;
export const RANGE_SPREAD_PCT = 0.01; // |SMA20-SMA50| <= 1.0% of close
export const RANGE_WIDTH_ATR = 4.0; // range width must be >= 4x ATR
export const TOUCH_ATR = 0.5; // boundary touch within 0.5x ATR
export const RSI_EXTREME_LONG = 32;
export const RSI_EXTREME_SHORT = 68;
export const RSI_ENTRY_CAP_LONG = 40;
export const RSI_ENTRY_CAP_SHORT = 60;
export const TIMEFRAME = '4h' as const;
export const CANDLE_MS = 4 * 60 * 60 * 1000;

export interface Signal {
  symbol?: string;
  side: Side;
  /** Entry price = confirmation candle close (raw close; the fill applies 0.05% slippage against the trader). */
  entry: number;
  stopLoss: number;
  /**
   * THE single validated take-profit: entry ± 3.0 x ATR (+2R).
   * v3-B has ONE validated TP — there are no TP1/TP2/TP3 levels.
   * The breakeven SL move at +1R is a trade-management rule
   * (STRATEGY-v3-b.md §5), not a take-profit.
   */
  takeProfit: number;
  riskReward: '1:2';
  /** 0-100, computed from the documented formula above; never random. */
  confidence: number;
  timeframe: '4h';
  /** ISO timestamp: entry candle close + 4h (the signal is only valid for the next 4h candle). */
  expiresAt: string;
  /** Human-readable range structure the setup faded. */
  structure: string;
  /** Human-readable summary of the passing checks. */
  reason: string;
  /** What would invalidate the setup. */
  invalidation: string;
  /**
   * The validated exit conditions for a v3-B position, in the order
   * the backtest counts them: TP (3.0xATR) 5 / SL 7 / TIME 4 / HALT 1
   * over the 240-day validation window (RESULTS-v3-b.md §1).
   */
  exitConditions: readonly ['SL', 'TIME 96h', 'HALT'];
  /** ISO timestamp of the confirmation candle close that generated this signal. */
  signalTimestamp: string;
}

export interface SignalChecks {
  warmup: boolean;
  ranging: boolean;
  rangeWideEnough: boolean;
  touchedBoundary: boolean;
  rsiExtreme: boolean;
  rejection: boolean;
  volGuard: boolean;
}

export interface SignalEvaluation {
  signal: Signal | null;
  /** First failing check (or the confirmation summary when a signal fires). */
  reason: string;
  checks: SignalChecks;
  side: Side | null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function computeConfidence(
  side: Side,
  ind: IndicatorSet,
  candles: readonly Candle[],
  i: number,
  rangeWidthAtr: number,
): number {
  const row = candles[i];
  const rsiNow = ind.rsi14[i];
  const rsiPrev = ind.rsi14[i - 1];
  const mid = (row.high + row.low) / 2;
  const range = row.high - row.low;
  let rsiDepth: number;
  let rejection: number;
  if (side === 'long') {
    rsiDepth = clamp01((RSI_EXTREME_LONG - Math.min(rsiNow, rsiPrev)) / RSI_EXTREME_LONG);
    rejection = range > 0 ? clamp01((row.close - mid) / (0.5 * range)) : 0;
  } else {
    rsiDepth = clamp01((Math.max(rsiNow, rsiPrev) - RSI_EXTREME_SHORT) / (100 - RSI_EXTREME_SHORT));
    rejection = range > 0 ? clamp01((mid - row.close) / (0.5 * range)) : 0;
  }
  const rangeBonus = clamp01((rangeWidthAtr - RANGE_WIDTH_ATR) / 8);
  const spreadPct = Math.abs(ind.sma20[i] - ind.sma50[i]) / row.close;
  const flatness = clamp01(1 - spreadPct / RANGE_SPREAD_PCT);
  const score =
    47.1 + 15 * rsiDepth + 10 * rejection + 10 * rangeBonus + 5 * flatness;
  return Math.min(90, Math.max(5, Math.round(score)));
}

/**
 * Raw v3-B setup detection at candle `i`, IGNORING the volatility
 * guard. The backtest and paper engines call this and then apply the
 * guard themselves so they can count/log VOL_GUARD skips separately
 * (backtest_v3.py counts a raw setup before the guard). Returns the
 * side plus the levels needed to build a position, or null.
 */
export function detectSetup(
  candles: readonly Candle[],
  ind: IndicatorSet,
  i: number,
): {
  side: Side;
  swingHigh: number;
  swingLow: number;
  atr: number;
  rsiMin2: number;
  rsiMax2: number;
  rangeWidthAtr: number;
} | null {
  if (i < WARMUP_CANDLES || i < 1 || i >= candles.length) return null;
  const row = candles[i];
  const prev = candles[i - 1];
  const sma20 = ind.sma20[i];
  const sma50 = ind.sma50[i];
  const rsi = ind.rsi14[i];
  const rsiPrev = ind.rsi14[i - 1];
  const atr = ind.atr14[i];
  const swingHigh = ind.swingHigh[i];
  const swingLow = ind.swingLow[i];
  if (
    [sma20, sma50, rsi, rsiPrev, atr, swingHigh, swingLow].some((v) => !Number.isFinite(v))
  ) {
    return null;
  }
  // 3.1 Ranging regime.
  if (Math.abs(sma20 - sma50) > RANGE_SPREAD_PCT * row.close) return null;
  const rangeWidthAtr = (swingHigh - swingLow) / atr;
  if (rangeWidthAtr < RANGE_WIDTH_ATR) return null;
  const mid = (row.high + row.low) / 2;

  // 3.2 + 3.3 + 3.4 LONG: fade the range low.
  const touchedLow = Math.min(row.low, prev.low) <= swingLow + TOUCH_ATR * atr;
  if (
    touchedLow &&
    Math.min(rsi, rsiPrev) < RSI_EXTREME_LONG &&
    row.close > row.open &&
    row.close > mid &&
    rsi <= RSI_ENTRY_CAP_LONG
  ) {
    return { side: 'long', swingHigh, swingLow, atr, rsiMin2: Math.min(rsi, rsiPrev), rsiMax2: Math.max(rsi, rsiPrev), rangeWidthAtr };
  }
  // SHORT: fade the range high (mirror).
  const touchedHigh = Math.max(row.high, prev.high) >= swingHigh - TOUCH_ATR * atr;
  if (
    touchedHigh &&
    Math.max(rsi, rsiPrev) > RSI_EXTREME_SHORT &&
    row.close < row.open &&
    row.close < mid &&
    rsi >= RSI_ENTRY_CAP_SHORT
  ) {
    return { side: 'short', swingHigh, swingLow, atr, rsiMin2: Math.min(rsi, rsiPrev), rsiMax2: Math.max(rsi, rsiPrev), rangeWidthAtr };
  }
  return null;
}

/** Volatility guard (STRATEGY-v3-b.md §3.5): true range must be <= 2.5 x ATR. */
export function volGuardOk(candles: readonly Candle[], ind: IndicatorSet, i: number): boolean {
  const atr = ind.atr14[i];
  if (!Number.isFinite(atr) || atr <= 0) return false;
  return ind.tr[i] <= VOL_GUARD_ATR * atr;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Full v3-B signal evaluation at candle `i`, including the volatility
 * guard. Returns `{ signal, reason, checks, side }`; `signal` is null
 * (NO TRADE) when any condition fails, with `reason` naming the first
 * failing check.
 */
export function evaluateSignalAt(
  candles: readonly Candle[],
  i: number,
  symbol?: string,
): SignalEvaluation {
  const ind = computeIndicators(candles);
  const checks: SignalChecks = {
    warmup: false,
    ranging: false,
    rangeWideEnough: false,
    touchedBoundary: false,
    rsiExtreme: false,
    rejection: false,
    volGuard: false,
  };
  const noTrade = (reason: string, side: Side | null = null): SignalEvaluation => ({
    signal: null,
    reason,
    checks,
    side,
  });
  if (i < WARMUP_CANDLES || i < 1 || i >= candles.length) {
    return noTrade(
      `NO TRADE: warm-up — need ${WARMUP_CANDLES} closed 4h candles before any signal (have ${candles.length}).`,
    );
  }
  checks.warmup = true;
  const row = candles[i];
  const prev = candles[i - 1];
  const sma20 = ind.sma20[i];
  const sma50 = ind.sma50[i];
  const rsi = ind.rsi14[i];
  const rsiPrev = ind.rsi14[i - 1];
  const atr = ind.atr14[i];
  const swingHigh = ind.swingHigh[i];
  const swingLow = ind.swingLow[i];
  if (
    [sma20, sma50, rsi, rsiPrev, atr, swingHigh, swingLow].some((v) => !Number.isFinite(v))
  ) {
    return noTrade('NO TRADE: indicators not yet defined at this candle (NaN).');
  }
  // 3.1 Ranging regime.
  if (Math.abs(sma20 - sma50) > RANGE_SPREAD_PCT * row.close) {
    return noTrade(
      `NO TRADE: trending, not ranging — |SMA20-SMA50| = ${fmt(Math.abs(sma20 - sma50))} > 1.0% of close ${fmt(row.close)}.`,
    );
  }
  checks.ranging = true;
  const rangeWidthAtr = (swingHigh - swingLow) / atr;
  if (rangeWidthAtr < RANGE_WIDTH_ATR) {
    return noTrade(
      `NO TRADE: range too narrow — width ${rangeWidthAtr.toFixed(2)}xATR < 4xATR.`,
    );
  }
  checks.rangeWideEnough = true;

  const setup = detectSetup(candles, ind, i);
  if (setup === null) {
    // Distinguish which of 3.2-3.4 failed, for an actionable reason.
    const touchedLow = Math.min(row.low, prev.low) <= swingLow + TOUCH_ATR * atr;
    const touchedHigh = Math.max(row.high, prev.high) >= swingHigh - TOUCH_ATR * atr;
    if (!touchedLow && !touchedHigh) {
      return noTrade(
        'NO TRADE: no boundary touch — neither the range low nor the range high was probed within 0.5xATR on this or the previous candle.',
      );
    }
    checks.touchedBoundary = true;
    const rsiExtremeLong = Math.min(rsi, rsiPrev) < RSI_EXTREME_LONG;
    const rsiExtremeShort = Math.max(rsi, rsiPrev) > RSI_EXTREME_SHORT;
    if (!rsiExtremeLong && !rsiExtremeShort) {
      return noTrade(
        `NO TRADE: boundary touched but no RSI extreme — 2-candle RSI range ${fmt(Math.min(rsi, rsiPrev))}–${fmt(Math.max(rsi, rsiPrev))} (need <32 for long / >68 for short).`,
      );
    }
    checks.rsiExtreme = true;
    return noTrade(
      'NO TRADE: RSI extreme present but no rejection candle — close must be beyond open AND beyond the candle midpoint, with RSI back inside 40 (long) / 60 (short).',
    );
  }
  checks.touchedBoundary = true;
  checks.rsiExtreme = true;
  checks.rejection = true;

  // 3.5 Volatility guard.
  if (!volGuardOk(candles, ind, i)) {
    return noTrade(
      `NO TRADE: volatility guard — confirmation candle true range ${fmt(ind.tr[i])} > 2.5xATR (${fmt(VOL_GUARD_ATR * atr)}).`,
      setup.side,
    );
  }
  checks.volGuard = true;

  const trade = computeTrade(row.close, setup.side, atr);
  if (trade === null) {
    return noTrade('NO TRADE: invalid trade definition (non-positive price/ATR).', setup.side);
  }
  const confidence = computeConfidence(setup.side, ind, candles, i, rangeWidthAtr);
  const entryCloseMs = row.time + CANDLE_MS; // entry candle close
  const expiresAt = new Date(entryCloseMs + CANDLE_MS).toISOString();
  const boundary = setup.side === 'long' ? swingLow : swingHigh;
  const structure =
    setup.side === 'long'
      ? `Range ${fmt(swingLow)}–${fmt(swingHigh)} (${rangeWidthAtr.toFixed(1)}xATR); faded the low at ${fmt(boundary)}, RSI 2-candle min ${fmt(setup.rsiMin2)}, ATR ${fmt(atr)}`
      : `Range ${fmt(swingLow)}–${fmt(swingHigh)} (${rangeWidthAtr.toFixed(1)}xATR); faded the high at ${fmt(boundary)}, RSI 2-candle max ${fmt(setup.rsiMax2)}, ATR ${fmt(atr)}`;
  const reason =
    setup.side === 'long'
      ? `v3-B LONG: ranging (|SMA20-SMA50| <= 1% of close), range ${rangeWidthAtr.toFixed(1)}xATR wide, low touched within 0.5xATR, RSI extreme ${fmt(setup.rsiMin2)} < 32, rejection close ${fmt(row.close)} in upper half, RSI ${fmt(rsi)} <= 40.`
      : `v3-B SHORT: ranging (|SMA20-SMA50| <= 1% of close), range ${rangeWidthAtr.toFixed(1)}xATR wide, high touched within 0.5xATR, RSI extreme ${fmt(setup.rsiMax2)} > 68, rejection close ${fmt(row.close)} in lower half, RSI ${fmt(rsi)} >= 60.`;
  const invalidation =
    setup.side === 'long'
      ? `Invalidated if a 4h candle closes below the range low ${fmt(swingLow)} or the stop-loss ${fmt(trade.sl)} is hit; signal expires ${expiresAt}.`
      : `Invalidated if a 4h candle closes above the range high ${fmt(swingHigh)} or the stop-loss ${fmt(trade.sl)} is hit; signal expires ${expiresAt}.`;
  const signal: Signal = {
    ...(symbol !== undefined ? { symbol } : {}),
    side: setup.side,
    entry: trade.entry,
    stopLoss: trade.sl,
    takeProfit: trade.tp,
    riskReward: '1:2',
    confidence,
    timeframe: TIMEFRAME,
    expiresAt,
    structure,
    reason,
    invalidation,
    exitConditions: ['SL', 'TIME 96h', 'HALT'],
    signalTimestamp: new Date(entryCloseMs).toISOString(),
  };
  return { signal, reason, checks, side: setup.side };
}

/**
 * Evaluate the v3-B signal on the LAST closed candle of `candles`
 * (the backend calls this with live 4h klines). Returns the signal,
 * or null when there is NO TRADE. Use `evaluateSignalAt` / the
 * detailed evaluation when the reason string is needed.
 */
export function evaluateSignal(candles: readonly Candle[], symbol?: string): Signal | null {
  if (candles.length === 0) return null;
  return evaluateSignalAt(candles, candles.length - 1, symbol).signal;
}

// ---------------------------------------------------------------------------
// Indicator-state evaluator (v3-B Trading Indicator module, addendum)
// ---------------------------------------------------------------------------

export type IndicatorRegime = 'RANGING' | 'TRENDING';

export type IndicatorStateKind =
  | 'VALID_RANGE'
  | 'APPROACHING_LOW'
  | 'APPROACHING_HIGH'
  | 'CONFIRMED_BUY'
  | 'CONFIRMED_SELL'
  | 'BREAKDOWN_AVOID'
  | 'UNSUITABLE_TRENDING'
  | 'UNSUITABLE_VOLATILITY'
  | 'NO_TRADE';

export interface IndicatorEvaluation {
  regime: IndicatorRegime;
  /** 20-candle swing low (null until 20 prior candles exist). */
  rangeLow: number | null;
  /** 20-candle swing high (null until 20 prior candles exist). */
  rangeHigh: number | null;
  /** (rangeHigh - rangeLow) / ATR(14) (null when ATR/swing undefined). */
  rangeWidthAtr: number | null;
  /** RSI(14) at the evaluated candle (null when undefined). */
  rsi: number | null;
  /** (close - rangeLow) / ATR — ATRs above the range low (null when undefined). */
  distanceToLowAtr: number | null;
  /** (rangeHigh - close) / ATR — ATRs below the range high (null when undefined). */
  distanceToHighAtr: number | null;
  state: IndicatorStateKind;
  reason: string;
}

/**
 * Alert event types the backend consumes (ARCHITECTURE.md `/api/alerts`).
 * BUY_SETUP / RANGE_INVALID / VOLATILITY_UNSUITABLE come from the
 * indicator state (see `alertTypeForIndicatorState`). EXIT_TRIGGER /
 * SL_HIT / TP_HIT are position-lifecycle alerts: the backend derives
 * them from paper EXIT events — SL exit -> SL_HIT, TP exit -> TP_HIT,
 * TIME/HALT exit -> EXIT_TRIGGER. No alert type is emitted by this
 * module itself; this is only the shared vocabulary.
 */
export type AlertEventType =
  | 'BUY_SETUP'
  | 'EXIT_TRIGGER'
  | 'SL_HIT'
  | 'TP_HIT'
  | 'RANGE_INVALID'
  | 'VOLATILITY_UNSUITABLE';

/** Map an indicator state to the alert it raises, if any (null = no alert). */
export function alertTypeForIndicatorState(state: IndicatorStateKind): AlertEventType | null {
  switch (state) {
    case 'CONFIRMED_BUY':
      return 'BUY_SETUP';
    case 'CONFIRMED_SELL':
      return 'EXIT_TRIGGER'; // the indicator's SELL is an exit trigger for the fade
    case 'BREAKDOWN_AVOID':
    case 'UNSUITABLE_TRENDING':
      return 'RANGE_INVALID'; // range invalid for mean-reversion
    case 'UNSUITABLE_VOLATILITY':
      return 'VOLATILITY_UNSUITABLE';
    default:
      return null;
  }
}

/**
 * Proximity band for the APPROACHING_LOW / APPROACHING_HIGH scanner
 * states: within 1.0 x ATR of the boundary. This is a DISPLAY
 * classification for the scanner only — it is NOT a strategy
 * parameter and never changes signal logic (the strategy's own
 * boundary touch is 0.5 x ATR, STRATEGY-v3-b.md §3.2).
 */
export const APPROACH_ATR = 1.0;

/**
 * Classify the v3-B indicator state at candle `i`. Same closed-candle
 * indicators and the same strategy parameters as `evaluateSignalAt` —
 * no retuning, no extra filters. Decision order (first match wins):
 *  1. warm-up / undefined indicators -> NO_TRADE
 *  2. full v3-B setup + volatility guard OK -> CONFIRMED_BUY / CONFIRMED_SELL
 *  3. full v3-B setup but volatility guard fails -> UNSUITABLE_VOLATILITY
 *  4. |SMA20-SMA50| > 1% of close -> UNSUITABLE_TRENDING (a trending
 *     market has no meaningful range to break, so this precedes the
 *     breakdown check)
 *  5. close beyond the range boundary by MORE than the 0.5xATR touch
 *     tolerance (below the low or above the high: the range is broken)
 *     -> BREAKDOWN_AVOID. A close within tolerance of the boundary is
 *     a probe/touch, not a break — it falls through to APPROACHING_*.
 *  6. range width < 4 x ATR -> NO_TRADE (range too narrow to trade)
 *  7. within 1.0 x ATR of the low / high -> APPROACHING_LOW / APPROACHING_HIGH
 *  8. otherwise -> VALID_RANGE
 */
export function evaluateIndicatorAt(
  candles: readonly Candle[],
  i: number,
): IndicatorEvaluation {
  const ind = computeIndicators(candles);
  const noTrade = (
    state: IndicatorStateKind,
    reason: string,
    partial: Partial<IndicatorEvaluation> = {},
  ): IndicatorEvaluation => ({
    regime: 'TRENDING',
    rangeLow: null,
    rangeHigh: null,
    rangeWidthAtr: null,
    rsi: null,
    distanceToLowAtr: null,
    distanceToHighAtr: null,
    state,
    reason,
    ...partial,
  });
  if (i < WARMUP_CANDLES || i < 1 || i >= candles.length) {
    return noTrade(
      'NO_TRADE',
      `NO TRADE: warm-up — need ${WARMUP_CANDLES} closed 4h candles before the indicator is valid (have ${candles.length}).`,
    );
  }
  const row = candles[i];
  const sma20 = ind.sma20[i];
  const sma50 = ind.sma50[i];
  const rsi = ind.rsi14[i];
  const atr = ind.atr14[i];
  const swingHigh = ind.swingHigh[i];
  const swingLow = ind.swingLow[i];
  if (
    [sma20, sma50, rsi, atr, swingHigh, swingLow].some((v) => !Number.isFinite(v))
  ) {
    return noTrade('NO_TRADE', 'NO TRADE: indicators not yet defined at this candle (NaN).');
  }
  const regime: IndicatorRegime =
    Math.abs(sma20 - sma50) <= RANGE_SPREAD_PCT * row.close ? 'RANGING' : 'TRENDING';
  const rangeWidthAtr = (swingHigh - swingLow) / atr;
  const distanceToLowAtr = (row.close - swingLow) / atr;
  const distanceToHighAtr = (swingHigh - row.close) / atr;
  const base: Pick<IndicatorEvaluation, 'regime' | 'rangeLow' | 'rangeHigh' | 'rangeWidthAtr' | 'rsi' | 'distanceToLowAtr' | 'distanceToHighAtr'> = {
    regime,
    rangeLow: swingLow,
    rangeHigh: swingHigh,
    rangeWidthAtr,
    rsi,
    distanceToLowAtr,
    distanceToHighAtr,
  };

  // 2-3. Full v3-B setup (volatility guard decides BUY/SELL vs VOLATILITY).
  const setup = detectSetup(candles, ind, i);
  if (setup !== null) {
    if (volGuardOk(candles, ind, i)) {
      return {
        ...base,
        state: setup.side === 'long' ? 'CONFIRMED_BUY' : 'CONFIRMED_SELL',
        reason:
          setup.side === 'long'
            ? `CONFIRMED BUY: v3-B long setup — range low faded, RSI 2-candle min ${fmt(setup.rsiMin2)} < 32, rejection close, range ${rangeWidthAtr.toFixed(1)}xATR wide.`
            : `CONFIRMED SELL: v3-B short setup — range high faded, RSI 2-candle max ${fmt(setup.rsiMax2)} > 68, rejection close, range ${rangeWidthAtr.toFixed(1)}xATR wide.`,
      };
    }
    return {
      ...base,
      state: 'UNSUITABLE_VOLATILITY',
      reason: `UNSUITABLE (volatility): v3-B setup present but confirmation candle true range ${fmt(ind.tr[i])} > 2.5xATR (${fmt(VOL_GUARD_ATR * atr)}) — no trade.`,
    };
  }
  // 4. Trending, not ranging (precedes the breakdown check: a trending
  // market has no meaningful range to break).
  if (regime === 'TRENDING') {
    return {
      ...base,
      state: 'UNSUITABLE_TRENDING',
      reason: `UNSUITABLE (trending): |SMA20-SMA50| = ${fmt(Math.abs(sma20 - sma50))} > 1.0% of close ${fmt(row.close)} — mean-reversion does not apply.`,
    };
  }
  // 5. Range broken: close beyond a boundary by MORE than the 0.5xATR
  // touch tolerance — a close within tolerance is a probe, not a break.
  if (row.close < swingLow - TOUCH_ATR * atr) {
    return {
      ...base,
      state: 'BREAKDOWN_AVOID',
      reason: `BREAKDOWN — AVOID: 4h close ${fmt(row.close)} broke below the range low ${fmt(swingLow)} by more than 0.5xATR; the range is broken, do not fade the low.`,
    };
  }
  if (row.close > swingHigh + TOUCH_ATR * atr) {
    return {
      ...base,
      state: 'BREAKDOWN_AVOID',
      reason: `BREAKDOWN — AVOID: 4h close ${fmt(row.close)} broke above the range high ${fmt(swingHigh)} by more than 0.5xATR; the range is broken, do not fade the high.`,
    };
  }
  // 6. Range too narrow to trade.
  if (rangeWidthAtr < RANGE_WIDTH_ATR) {
    return {
      ...base,
      state: 'NO_TRADE',
      reason: `NO TRADE: range too narrow — width ${rangeWidthAtr.toFixed(2)}xATR < 4xATR.`,
    };
  }
  // 7. Approaching a boundary (within 1.0xATR; display band only).
  if (distanceToLowAtr <= APPROACH_ATR) {
    return {
      ...base,
      state: 'APPROACHING_LOW',
      reason: `APPROACHING LOW: close ${fmt(row.close)} is ${distanceToLowAtr.toFixed(2)}xATR above the range low ${fmt(swingLow)} (RSI ${fmt(rsi)}); watching for a v3-B fade, no setup yet.`,
    };
  }
  if (distanceToHighAtr <= APPROACH_ATR) {
    return {
      ...base,
      state: 'APPROACHING_HIGH',
      reason: `APPROACHING HIGH: close ${fmt(row.close)} is ${distanceToHighAtr.toFixed(2)}xATR below the range high ${fmt(swingHigh)} (RSI ${fmt(rsi)}); watching for a v3-B fade, no setup yet.`,
    };
  }
  // 8. Valid ranging market, no setup at this candle.
  return {
    ...base,
    state: 'VALID_RANGE',
    reason: `VALID RANGE: ranging (|SMA20-SMA50| <= 1% of close), range ${rangeWidthAtr.toFixed(1)}xATR wide (${fmt(swingLow)}–${fmt(swingHigh)}), RSI ${fmt(rsi)}; no boundary setup at this candle.`,
  };
}

/**
 * Classify the v3-B indicator state on the LAST closed candle of
 * `candles` (the backend calls this with live 4h klines per symbol).
 * Pure function, closed candles only, no lookahead, no repainting.
 */
export function evaluateIndicator(candles: readonly Candle[]): IndicatorEvaluation {
  if (candles.length === 0) {
    return {
      regime: 'TRENDING',
      rangeLow: null,
      rangeHigh: null,
      rangeWidthAtr: null,
      rsi: null,
      distanceToLowAtr: null,
      distanceToHighAtr: null,
      state: 'NO_TRADE',
      reason: 'NO TRADE: no candles supplied.',
    };
  }
  return evaluateIndicatorAt(candles, candles.length - 1);
}
