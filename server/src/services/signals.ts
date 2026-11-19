/**
 * Live v3-B signals — evaluated on closed 4h candles for BTCUSDT + SOLUSDT
 * (the only validated universe). ETH and PAXG are excluded by the strategy.
 * Uses the engines agent's canonical `evaluateSignal` — entry/SL/TP,
 * confidence and expiry come from the engine, not from local math.
 *
 * Honest TP convention (addendum-corrected): ONE validated TP at +2R
 * (3.0xATR). The API returns a single `takeProfit` — no TP2/TP3. Validated
 * exits are TP (+2R) plus SL, TIME (96h max hold) and HALT. The breakeven
 * SL move at +1R is a management rule, not a TP.
 * NO TRADE is a valid output — signals are never manufactured.
 */
import { binance, SIGNAL_SYMBOLS } from './binance.js';
import { getDb } from './db.js';
import { evaluateIndicator, evaluateSignal } from '../engines/signal.js';
import { getPaperSummary } from './risk.js';

export type MarketCondition = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'HIGH_VOLATILITY' | 'NO_TRADE';

export interface ApiSignal {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: '1:2';
  confidence: number;
  timeframe: '4h';
  expiresAt: string;
  structure: string;
  reason: string;
  invalidation: string;
  exitConditions: ['SL', 'TIME 96h', 'HALT'];
  signalTimestamp: string;
  status: 'ACTIVE' | 'EXPIRED' | 'INVALIDATED';
}

const EXIT_CONDITIONS: ['SL', 'TIME 96h', 'HALT'] = ['SL', 'TIME 96h', 'HALT'];

const CACHE_TTL_MS = 60_000;
let cache: { at: number; data: Awaited<ReturnType<typeof computeSignals>> } | null = null;

async function computeSignals(): Promise<{
  updatedAt: string;
  marketCondition: MarketCondition;
  signals: ApiSignal[];
  paper: { openPositions: number; todayPnl: number; tradesToday: number; halted: boolean; tradingDisabled: boolean };
}> {
  const updatedAt = new Date().toISOString();
  const signals: ApiSignal[] = [];
  let marketCondition: MarketCondition = 'NEUTRAL';
  const marks: Record<string, number> = {};

  for (const symbol of SIGNAL_SYMBOLS) {
    const candles = await binance.getClosedKlines(symbol, '4h', 120);
    if (!candles.length) continue;
    const last = candles[candles.length - 1];
    marks[symbol] = last.close;

    if (symbol === 'BTCUSDT') {
      const ind = evaluateIndicator(candles);
      if (ind.state === 'UNSUITABLE_VOLATILITY') marketCondition = 'HIGH_VOLATILITY';
      else if (ind.regime === 'TRENDING') {
        if (ind.rangeHigh !== null && last.close > ind.rangeHigh) marketCondition = 'BULLISH';
        else if (ind.rangeLow !== null && last.close < ind.rangeLow) marketCondition = 'BEARISH';
        else marketCondition = 'NEUTRAL';
      } else {
        marketCondition = 'NEUTRAL';
      }
    }

    const engineSignal = evaluateSignal(candles, symbol);
    if (!engineSignal) continue;

    const side: 'BUY' | 'SELL' = engineSignal.side === 'long' ? 'BUY' : 'SELL';
    const signal: ApiSignal = {
      id: `${symbol}-${side}-${Date.parse(engineSignal.signalTimestamp)}`,
      symbol,
      side,
      entry: engineSignal.entry,
      stopLoss: engineSignal.stopLoss,
      takeProfit: engineSignal.takeProfit,
      riskReward: engineSignal.riskReward,
      confidence: engineSignal.confidence,
      timeframe: engineSignal.timeframe,
      expiresAt: engineSignal.expiresAt,
      structure: engineSignal.structure,
      reason: engineSignal.reason,
      invalidation: engineSignal.invalidation,
      exitConditions: [...engineSignal.exitConditions] as ['SL', 'TIME 96h', 'HALT'],
      signalTimestamp: engineSignal.signalTimestamp,
      status: 'ACTIVE',
    };

    // Persist new signals (dedupe by id).
    const db = getDb();
    db.insertSignal({
      id: signal.id,
      symbol: signal.symbol,
      side: signal.side,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskReward: signal.riskReward,
      confidence: signal.confidence,
      timeframe: signal.timeframe,
      expiresAt: signal.expiresAt,
      structure: signal.structure,
      reason: signal.reason,
      invalidation: signal.invalidation,
      exitConditions: JSON.stringify(EXIT_CONDITIONS),
      signalTimestamp: signal.signalTimestamp,
      status: 'ACTIVE',
    });
    signals.push(signal);
  }

  const paper = await getPaperSummary(marks);
  if (paper.halted || paper.tradingDisabled) marketCondition = 'NO_TRADE';

  return { updatedAt, marketCondition, signals, paper };
}

export async function getSignals(): Promise<Awaited<ReturnType<typeof computeSignals>>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await computeSignals();
  cache = { at: now, data };
  return data;
}

/** Stored signals (for WS broadcast diffing). */
export function listStoredSignals(limit = 20) {
  return getDb().listSignals(limit);
}
