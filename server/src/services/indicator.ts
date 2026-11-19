/**
 * v3-B Range Mean-Reversion indicator state (per symbol, 4h, closed candles).
 *
 * Thin wrapper over the engines agent's canonical evaluator
 * (`server/src/engines/signal.ts` → `evaluateIndicator`) and the TA module
 * (`server/src/ta/indicators.ts`). The strategy parameters live in the
 * engine — this service only adapts its output to the API shape and
 * enforces the validated-universe rule: CONFIRMED_BUY/SELL never fires
 * for symbols outside BTC/SOL (their range state is still reported for
 * the scanner, downgraded to APPROACHING_*).
 *
 * Single validated TP: 3.0xATR (+2R). No TP2/TP3.
 */
import { evaluateIndicator as engineEvaluateIndicator, type IndicatorStateKind } from '../engines/signal.js';
import { computeIndicators } from '../ta/indicators.js';
import type { Candle } from './binance.js';

export type IndicatorRegime = 'RANGING' | 'TRENDING';
export type IndicatorState = IndicatorStateKind;

export interface IndicatorResult {
  symbol: string;
  regime: IndicatorRegime;
  rangeLow: number | null;
  rangeHigh: number | null;
  rangeWidthAtr: number | null;
  rsi: number | null;
  distanceToLowAtr: number | null;
  distanceToHighAtr: number | null;
  state: IndicatorState;
  reason: string;
  /** Extra detail for signal construction (not in the API contract). */
  atr: number | null;
  close: number | null;
  lastCandle: Candle | null;
}

export const V3B = {
  smaFast: 20,
  smaSlow: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  swingWindow: 20,
  regimeSmaGapPct: 0.01,
  minRangeWidthAtr: 4,
  boundaryTouchAtr: 0.5,
  rsiLongMax: 32,
  rsiShortMin: 68,
  volGuardAtr: 2.5,
  slAtr: 1.5,
  tpAtr: 3.0,
  maxHoldHours: 96,
} as const;

function lastOrNull(values: number[]): number | null {
  if (!values.length) return null;
  const v = values[values.length - 1];
  return Number.isFinite(v) ? v : null;
}

/**
 * Evaluate the v3-B indicator state for one symbol from closed 4h candles.
 * `validatedUniverse` is false for symbols outside BTC/SOL.
 */
export function evaluateIndicator(
  symbol: string,
  candles: Candle[],
  validatedUniverse = true,
): IndicatorResult {
  const ev = engineEvaluateIndicator(candles);
  const ind = computeIndicators(candles);
  const last = candles.length ? candles[candles.length - 1] : null;

  let state = ev.state;
  let reason = ev.reason;
  if (!validatedUniverse && (state === 'CONFIRMED_BUY' || state === 'CONFIRMED_SELL')) {
    // Pattern fired, but the symbol is outside the validated universe:
    // report proximity, never a signal.
    state = state === 'CONFIRMED_BUY' ? 'APPROACHING_LOW' : 'APPROACHING_HIGH';
    reason = `${reason} ${symbol} is outside the validated v3-B universe (BTC/SOL only) — no signal.`;
  }

  return {
    symbol,
    regime: ev.regime,
    rangeLow: ev.rangeLow,
    rangeHigh: ev.rangeHigh,
    rangeWidthAtr: ev.rangeWidthAtr,
    rsi: ev.rsi,
    distanceToLowAtr: ev.distanceToLowAtr,
    distanceToHighAtr: ev.distanceToHighAtr,
    state,
    reason,
    atr: lastOrNull(ind.atr14),
    close: last ? last.close : null,
    lastCandle: last,
  };
}
