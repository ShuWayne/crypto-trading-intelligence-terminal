/**
 * Backtest engine — TypeScript port of `backtest_v3.py` (variants
 * v3a/v3b/v3c) and `backtest.py` (variant v2, primary run r15), plus a
 * faithful port of the v1.0 design from STRATEGY-v1.md (its original
 * engine file was overwritten by v2.0, so v1 is ported from the
 * strategy document, not from code — see the v1 note below).
 *
 * Shared conventions, identical to the Python engines:
 * - Closed candles only, no lookahead. Decisions at candle `i` use
 *   indicators computed from candles `0..i`.
 * - Costs: 0.1% taker fee + 0.05% slippage per side (0.3% round-trip
 *   on notional). Entry fill is slippage-adjusted against the trader;
 *   SL/TP are measured from the RAW confirmation close.
 * - Exit order within a candle: SL checked before TP (conservative),
 *   then the breakeven SL move at +1R, then the max-hold TIME exit.
 * - Daily loss halt (v2/v3 only): at each 4h close, realized today +
 *   unrealized of open positions (marked at the close, net of exit
 *   fees) <= -$20 closes ALL open positions (HALT) and blocks the
 *   rest of the UTC day.
 * - No re-entry in a symbol on the same candle it closed a position.
 * - Positions still open at the end of the data close at the last
 *   close with reason END_OF_DATA.
 * - Half split (exit date): H1 = before 2026-07-22, H2 = on/after.
 *
 * Variants (pre-registered; only v3-B validated):
 * - v1  : "Daily-Trend Pullback" — 1h entries, 4h trend/structure,
 *         $10 risk, 48h max hold, warm-up 250 x 1h candles. NO cost
 *         filter, NO notional cap, NO concurrent cap (one position per
 *         symbol only — up to 4 open), NO daily-halt close (the daily
 *         cap only blocks NEW entries; RESULTS-v1.md §4b documents
 *         the resulting -$69.15 worst day). Symbols BTC/ETH/SOL/PAXG.
 * - v2  : "4h Trend Breakout Pullback" (r15 PRIMARY) — 4h, $15 risk,
 *         max 2 concurrent, 25% cost filter, $2,000 notional cap,
 *         daily halt. Symbols BTC/ETH/SOL.
 * - v3a : "BTC-Only Trend Pullback" — 4h, BTC only, 1-candle reclaim.
 * - v3b : "Range Mean-Reversion" — THE VALIDATED DESIGN (STRATEGY-
 *         v3-b.md). 4h, BTC+SOL, $15 risk, max 2 concurrent.
 * - v3c : "Momentum Breakout with Retest" — 4h, BTC+SOL, pending
 *         breakout setups valid 12 candles, structure-based SL
 *         (further of 1.5xATR / level +/- 0.5xATR).
 *
 * `runBacktest` returns computed metrics AND the stored validated
 * metrics for the variant (`stored`), so the API can show honest
 * historical results without re-running — and so a re-run can be
 * checked against the stored numbers. The stored numbers are the
 * authoritative record (metrics-v*.json / RESULTS-*.md); a re-run
 * that differs from them is a bug in this port, not new evidence.
 */

import { computeIndicators, type Candle, type IndicatorSet } from '../ta/indicators.js';
import {
  BE_TRIGGER_R,
  COST_FILTER_MAX,
  DAILY_HALT_USD,
  MAX_HOLD_BARS,
  MAX_LOSSES_PER_DAY,
  MAX_TRADES_PER_DAY,
  NOTIONAL_CAP,
  ROUND_TRIP_COST,
  SLIPPAGE,
  SL_ATR,
  realizedPnl,
  unrealizedPnl,
  type Side,
} from './risk.js';
import { detectSetup, volGuardOk } from './signal.js';

export type BacktestVariant = 'v1' | 'v2' | 'v3a' | 'v3b' | 'v3c';

export const START_EQUITY = 5000;
export const HALF_SPLIT_MS = Date.parse('2026-07-22T00:00:00Z');
export const WARMUP_4H = 100;
export const WARMUP_1H = 250;

export interface BacktestInput {
  variant: BacktestVariant;
  /** 4h candles for v2/v3; 1h candles for v1. */
  data: Record<string, Candle[]>;
  /** Required for v1: 4h candles per symbol (trend + swing structure). */
  data4h?: Record<string, Candle[]>;
  startEquity?: number;
  /**
   * Chronological train/test split: trades are assigned to train or
   * test by ENTRY candle index vs floor(n * trainRatio), where n is
   * the (shortest) series length. 0 < trainRatio < 1. Omitted = no split.
   */
  trainRatio?: number;
}

export type ExitReason = 'TP' | 'SL' | 'TIME' | 'HALT' | 'END_OF_DATA';

export interface BacktestTrade {
  symbol: string;
  side: Side;
  entryTime: string;
  entry: number;
  exitTime: string;
  exit: number;
  exitReason: ExitReason;
  sl: number;
  tp: number;
  size: number;
  riskUsd: number;
  grossPnl: number;
  fees: number;
  pnl: number;
  rMultiple: number;
  barsHeld: number;
  beMoved: boolean;
}

export interface EquityPoint {
  time: string;
  equity: number;
}

export interface HalfStats {
  trades: number;
  wins: number;
  winRate: number; // percent
  net: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number; // percent
  avgWin: number;
  avgLoss: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  netPnl: number;
  totalFees: number;
  avgR: number;
  /** Mean net P&L per trade, USD. */
  expectancy: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  longestLosingStreak: number;
  tpExits: number;
  slExits: number;
  timeExits: number;
  haltExits: number;
  endOfDataExits: number;
  beMovedCount: number;
  bestDay: [string, number] | null;
  worstDay: [string, number] | null;
  nExitDays: number;
  halves: { H1: HalfStats; H2: HalfStats };
  perSymbol: Record<string, { trades: number; wins: number; winRate: number; net: number }>;
}

export interface CriterionCheck {
  name: string;
  required: string;
  actual: number;
  pass: boolean;
}

export interface BacktestCriteria {
  checks: CriterionCheck[];
  allPass: boolean;
  /** True only for v3-B: the single validated design. */
  validated: boolean;
}

export interface BacktestDiagnostics {
  rawSetups: number;
  volGuardSkips: number;
  costFilterSkips: number;
  notionalCapSkips: number;
  concurrentCapSkips: number;
  dailyCapSkips: number;
  haltBlockedSkips: number;
  lossStopSkips: number;
  haltTriggers: number;
  haltCloses: number;
  breakoutsDetected: number;
  retestExpired: number;
  retestCancelled: number;
}

export interface StoredVariantMetrics {
  variant: BacktestVariant;
  label: string;
  validated: boolean;
  verdict: string;
  symbols: string[];
  riskPerTrade: number;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  totalFees: number;
  avgR: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  bestDay: [string, number] | null;
  worstDay: [string, number] | null;
  halves: { H1: HalfStats; H2: HalfStats } | null;
  exits: { tp: number; sl: number; time: number; halt: number };
}

/**
 * STORED validated metrics — copied from the authoritative outputs in
 * ~/workspace/trading/binance-system/ (metrics-v1.json,
 * metrics-v2-r15.json [primary], metrics-v3-a/b/c.json and
 * RESULTS-v1.md / RESULTS-v2.md / RESULTS-v3-a/b/c.md). These are
 * reference data: the API shows them as the historical record. They
 * are NOT computed here and must not be edited to match a re-run.
 * v1/v2/v3a/v3c FAILED — their stored numbers are losses, shown as-is.
 */
export const STORED_RESULTS: Record<BacktestVariant, StoredVariantMetrics> = {
  v1: {
    variant: 'v1',
    label: 'v1.0 "Daily-Trend Pullback"',
    validated: false,
    verdict: 'DOES NOT VALIDATE — 158 trades, 27.2% win rate, PF 0.43, net -$826.17. No live trading.',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PAXGUSDT'],
    riskPerTrade: 10,
    trades: 158,
    wins: 43,
    winRate: 27.2,
    profitFactor: 0.43,
    netPnl: -826.17,
    avgWin: 14.26,
    avgLoss: -12.52,
    totalFees: 555.81,
    avgR: -0.52,
    maxDrawdownUsd: -915.65,
    maxDrawdownPct: -18.27,
    bestDay: ['2026-11-12', 52.56],
    worstDay: ['2026-08-16', -69.15],
    halves: null, // 120-day window (22 Jul–19 Nov 2026) — no H1/H2 split published
    exits: { tp: 40, sl: 111, time: 5, halt: 0 },
  },
  v2: {
    variant: 'v2',
    label: 'v2.0 "4h Trend Breakout Pullback" (r15 primary)',
    validated: false,
    verdict: 'DOES NOT VALIDATE — 28 trades, 14.3% win rate, PF 0.44, net -$141.25, worst day -$35.01. No live trading.',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    riskPerTrade: 15,
    trades: 28,
    wins: 4,
    winRate: 14.3,
    profitFactor: 0.44,
    netPnl: -141.25,
    avgWin: 27.46,
    avgLoss: -10.46,
    totalFees: 44.0,
    avgR: -0.34,
    maxDrawdownUsd: -168.76,
    maxDrawdownPct: -3.36,
    bestDay: ['2026-05-18', 27.47],
    worstDay: ['2026-10-29', -35.01],
    halves: {
      H1: { trades: 14, wins: 3, winRate: 21.4, net: -16.64, grossProfit: 82.59, grossLoss: 99.23, profitFactor: 0.83 },
      H2: { trades: 14, wins: 1, winRate: 7.1, net: -124.6, grossProfit: 27.26, grossLoss: 151.86, profitFactor: 0.18 },
    },
    exits: { tp: 4, sl: 22, time: 0, halt: 2 },
  },
  v3a: {
    variant: 'v3a',
    label: 'v3-A "BTC-Only Trend Pullback"',
    validated: false,
    verdict: 'DOES NOT VALIDATE — 16 trades, 25.0% win rate, PF 0.79, net -$28.41, 0 wins in H2. No live trading.',
    symbols: ['BTCUSDT'],
    riskPerTrade: 15,
    trades: 16,
    wins: 4,
    winRate: 25.0,
    profitFactor: 0.79,
    netPnl: -28.41,
    avgWin: 27.39,
    avgLoss: -11.5,
    totalFees: 30.49,
    avgR: -0.12,
    maxDrawdownUsd: -66.61,
    maxDrawdownPct: -1.32,
    bestDay: ['2026-04-14', 27.51],
    worstDay: ['2026-10-13', -18.59],
    halves: {
      H1: { trades: 8, wins: 4, winRate: 50.0, net: 38.2, grossProfit: 109.57, grossLoss: 71.37, profitFactor: 1.54 },
      H2: { trades: 8, wins: 0, winRate: 0.0, net: -66.61, grossProfit: 0, grossLoss: 66.61, profitFactor: 0 },
    },
    exits: { tp: 4, sl: 12, time: 0, halt: 0 },
  },
  v3b: {
    variant: 'v3b',
    label: 'v3-B "Range Mean-Reversion" — VALIDATED',
    validated: true,
    verdict: 'VALIDATES — 17 trades, 47.1% win rate, PF 1.75, net +$72.42, both halves positive, worst day -$26.57. Advances to Phase 2 paper trading; NO live trading yet.',
    symbols: ['BTCUSDT', 'SOLUSDT'],
    riskPerTrade: 15,
    trades: 17,
    wins: 8,
    winRate: 47.1,
    profitFactor: 1.75,
    netPnl: 72.42,
    avgWin: 21.06,
    avgLoss: -10.68,
    totalFees: 28.16,
    avgR: 0.28,
    maxDrawdownUsd: -64.0,
    maxDrawdownPct: -1.25,
    bestDay: ['2026-05-23', 55.19],
    worstDay: ['2026-10-08', -26.57],
    halves: {
      H1: { trades: 5, wins: 3, winRate: 60.0, net: 47.08, grossProfit: 59.0, grossLoss: 11.92, profitFactor: 4.95 },
      H2: { trades: 12, wins: 5, winRate: 41.7, net: 25.35, grossProfit: 109.51, grossLoss: 84.16, profitFactor: 1.3 },
    },
    exits: { tp: 5, sl: 7, time: 4, halt: 1 },
  },
  v3c: {
    variant: 'v3c',
    label: 'v3-C "Momentum Breakout with Retest"',
    validated: false,
    verdict: 'DOES NOT VALIDATE — 50 trades, 32.0% win rate, PF 1.02, net +$9.12 but H2 -$24.26 and worst day -$34.73. No live trading.',
    symbols: ['BTCUSDT', 'SOLUSDT'],
    riskPerTrade: 15,
    trades: 50,
    wins: 16,
    winRate: 32.0,
    profitFactor: 1.02,
    netPnl: 9.12,
    avgWin: 25.31,
    avgLoss: -11.64,
    totalFees: 65.2,
    avgR: 0.01,
    maxDrawdownUsd: -195.96,
    maxDrawdownPct: -3.87,
    bestDay: ['2026-06-04', 29.06],
    worstDay: ['2026-09-11', -34.73],
    halves: {
      H1: { trades: 28, wins: 9, winRate: 32.1, net: 33.38, grossProfit: 231.52, grossLoss: 198.15, profitFactor: 1.17 },
      H2: { trades: 22, wins: 7, winRate: 31.8, net: -24.26, grossProfit: 173.42, grossLoss: 197.68, profitFactor: 0.88 },
    },
    exits: { tp: 13, sl: 28, time: 4, halt: 5 },
  },
};

export interface BacktestResult {
  variant: BacktestVariant;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equity: EquityPoint[];
  criteria: BacktestCriteria;
  diagnostics: BacktestDiagnostics;
  /** Stored authoritative metrics for this variant (reference data). */
  stored: StoredVariantMetrics;
  /** Chronological train/test metrics when `trainRatio` was given, else null. */
  split: { train: BacktestMetrics; test: BacktestMetrics } | null;
}

// ---- variant configuration ----

interface VariantConfig {
  symbols: string[];
  riskPerTrade: number;
  maxConcurrent: number;
  maxHoldBars: number;
  warmup: number;
  costFilter: boolean; // false for v1 (no filter, no notional cap)
  haltEnabled: boolean; // false for v1 (daily cap blocks entries only)
  use1h: boolean;
}

const VARIANT_CONFIG: Record<BacktestVariant, VariantConfig> = {
  v1: { symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PAXGUSDT'], riskPerTrade: 10, maxConcurrent: 4, maxHoldBars: 48, warmup: WARMUP_1H, costFilter: false, haltEnabled: false, use1h: true },
  v2: { symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], riskPerTrade: 15, maxConcurrent: 2, maxHoldBars: MAX_HOLD_BARS, warmup: WARMUP_4H, costFilter: true, haltEnabled: true, use1h: false },
  v3a: { symbols: ['BTCUSDT'], riskPerTrade: 15, maxConcurrent: 2, maxHoldBars: MAX_HOLD_BARS, warmup: WARMUP_4H, costFilter: true, haltEnabled: true, use1h: false },
  v3b: { symbols: ['BTCUSDT', 'SOLUSDT'], riskPerTrade: 15, maxConcurrent: 2, maxHoldBars: MAX_HOLD_BARS, warmup: WARMUP_4H, costFilter: true, haltEnabled: true, use1h: false },
  v3c: { symbols: ['BTCUSDT', 'SOLUSDT'], riskPerTrade: 15, maxConcurrent: 2, maxHoldBars: MAX_HOLD_BARS, warmup: WARMUP_4H, costFilter: true, haltEnabled: true, use1h: false },
};

// v2/v3a shared pullback constants (backtest.py / backtest_v3.py)
const DIP_WINDOW = 6;
const BREAKOUT_WINDOW = 5;
const RSI_DIP_LONG = 45;
const RSI_DIP_SHORT = 55;
const RSI_CAP_LONG = 65;
const RSI_CAP_SHORT = 35;
// v3c constants (STRATEGY-v3-c.md §3)
const BREAKOUT_RSI_LONG = 55;
const BREAKOUT_RSI_SHORT = 45;
const RETEST_WINDOW_BARS = 12;
const RETEST_TOUCH_ATR = 0.5;
const RETEST_LEVEL_BUFFER_ATR = 0.5;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function halfOf(ms: number): 'H1' | 'H2' {
  return ms < HALF_SPLIT_MS ? 'H1' : 'H2';
}

function emptyHalf(): HalfStats {
  return { trades: 0, wins: 0, winRate: 0, net: 0, grossProfit: 0, grossLoss: 0, profitFactor: null };
}

function computeMetrics(
  trades: BacktestTrade[],
  equity: EquityPoint[],
  startEquity: number,
): BacktestMetrics {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);
  const endEquity = equity.length > 0 ? equity[equity.length - 1].equity : startEquity;
  let peak = -Infinity;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    const dd = p.equity - peak;
    if (dd < maxDdUsd) maxDdUsd = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct < maxDdPct) maxDdPct = ddPct;
  }
  let streak = 0;
  let longest = 0;
  for (const t of trades) {
    streak = t.pnl <= 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const daily = new Map<string, number>();
  for (const t of trades) {
    const d = utcDate(Date.parse(t.exitTime));
    daily.set(d, (daily.get(d) ?? 0) + t.pnl);
  }
  let bestDay: [string, number] | null = null;
  let worstDay: [string, number] | null = null;
  for (const [d, pnl] of daily) {
    if (bestDay === null || pnl > bestDay[1]) bestDay = [d, pnl];
    if (worstDay === null || pnl < worstDay[1]) worstDay = [d, pnl];
  }
  const halves = { H1: emptyHalf(), H2: emptyHalf() };
  for (const t of trades) {
    const h = halves[halfOf(Date.parse(t.exitTime))];
    h.trades += 1;
    if (t.pnl > 0) {
      h.wins += 1;
      h.grossProfit += t.pnl;
    } else {
      h.grossLoss += Math.abs(t.pnl);
    }
    h.net += t.pnl;
  }
  for (const h of [halves.H1, halves.H2]) {
    h.winRate = h.trades > 0 ? (h.wins / h.trades) * 100 : 0;
    h.profitFactor = h.grossLoss > 0 ? h.grossProfit / h.grossLoss : h.grossProfit > 0 ? Infinity : null;
  }
  const perSymbol: BacktestMetrics['perSymbol'] = {};
  for (const t of trades) {
    const s = perSymbol[t.symbol] ?? { trades: 0, wins: 0, winRate: 0, net: 0 };
    s.trades += 1;
    if (t.pnl > 0) s.wins += 1;
    s.net += t.pnl;
    perSymbol[t.symbol] = s;
  }
  for (const s of Object.values(perSymbol)) {
    s.winRate = s.trades > 0 ? (s.wins / s.trades) * 100 : 0;
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    netPnl,
    totalFees,
    avgR: trades.length > 0 ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0,
    expectancy: trades.length > 0 ? netPnl / trades.length : 0,
    startEquity,
    endEquity,
    returnPct: ((endEquity / startEquity) - 1) * 100,
    maxDrawdownUsd: maxDdUsd,
    maxDrawdownPct: maxDdPct,
    longestLosingStreak: longest,
    tpExits: trades.filter((t) => t.exitReason === 'TP').length,
    slExits: trades.filter((t) => t.exitReason === 'SL').length,
    timeExits: trades.filter((t) => t.exitReason === 'TIME').length,
    haltExits: trades.filter((t) => t.exitReason === 'HALT').length,
    endOfDataExits: trades.filter((t) => t.exitReason === 'END_OF_DATA').length,
    beMovedCount: trades.filter((t) => t.beMoved).length,
    bestDay,
    worstDay,
    nExitDays: daily.size,
    halves,
    perSymbol,
  };
}

function evaluateCriteria(variant: BacktestVariant, m: BacktestMetrics): BacktestCriteria {
  const checks: CriterionCheck[] = [
    { name: 'Overall net P&L > 0', required: '> $0', actual: m.netPnl, pass: m.netPnl > 0 },
    { name: 'Net P&L > 0 in BOTH halves', required: 'H1 > 0 and H2 > 0', actual: Math.min(m.halves.H1.net, m.halves.H2.net), pass: m.halves.H1.net > 0 && m.halves.H2.net > 0 },
    {
      name: variant === 'v3a' || variant === 'v3b' || variant === 'v3c' ? 'Profit factor >= 1.2' : 'Profit factor > 1.0',
      required: variant === 'v3a' || variant === 'v3b' || variant === 'v3c' ? '>= 1.2' : '> 1.0',
      actual: m.profitFactor,
      pass: variant === 'v3a' || variant === 'v3b' || variant === 'v3c' ? m.profitFactor >= 1.2 : m.profitFactor > 1.0,
    },
    { name: 'Worst single day >= -$30', required: '>= -$30', actual: m.worstDay ? m.worstDay[1] : 0, pass: (m.worstDay ? m.worstDay[1] : 0) >= -30 },
    { name: 'Win rate >= 40%', required: '>= 40%', actual: m.winRate, pass: m.winRate >= 40 },
  ];
  if (variant === 'v1' || variant === 'v2') {
    // v1.0/v2.0 used a 6th criterion: max drawdown < 10% (STRATEGY.md §8).
    checks.push({
      name: 'Max drawdown < 10%',
      required: '< 10%',
      actual: Math.abs(m.maxDrawdownPct),
      pass: Math.abs(m.maxDrawdownPct) < 10,
    });
  }
  const allPass = checks.every((c) => c.pass);
  return { checks, allPass, validated: variant === 'v3b' && allPass };
}

// ---- entry signals per variant (all use closed candles only) ----

type SignalOut = { side: Side; riskDistOverride: number | null } | null;

function signalV2(ind: IndicatorSet, candles: readonly Candle[], i: number): SignalOut {
  const row = candles[i];
  if (!Number.isFinite(ind.rsi14[i]) || !Number.isFinite(ind.atr14[i]) || !Number.isFinite(ind.sma50[i])) return null;
  const rsiWin = ind.rsi14.slice(Math.max(0, i - DIP_WINDOW + 1), i + 1);
  const up = row.close > ind.sma50[i] && ind.sma20[i] > ind.sma50[i];
  const down = row.close < ind.sma50[i] && ind.sma20[i] < ind.sma50[i];
  if (up) {
    const dip = Math.min(...rsiWin) < RSI_DIP_LONG;
    let prevHighMax = -Infinity;
    for (let k = i - BREAKOUT_WINDOW; k < i; k++) prevHighMax = Math.max(prevHighMax, candles[k].high);
    const confirm =
      row.close > prevHighMax && ind.rsi14[i] > RSI_DIP_LONG && ind.rsi14[i] <= RSI_CAP_LONG;
    const struct = row.close > ind.swingLow[i] && row.close > ind.sma20[i];
    if (dip && confirm && struct) return { side: 'long', riskDistOverride: null };
  } else if (down) {
    const dip = Math.max(...rsiWin) > RSI_DIP_SHORT;
    let prevLowMin = Infinity;
    for (let k = i - BREAKOUT_WINDOW; k < i; k++) prevLowMin = Math.min(prevLowMin, candles[k].low);
    const confirm =
      row.close < prevLowMin && ind.rsi14[i] < RSI_DIP_SHORT && ind.rsi14[i] >= RSI_CAP_SHORT;
    const struct = row.close < ind.swingHigh[i] && row.close < ind.sma20[i];
    if (dip && confirm && struct) return { side: 'short', riskDistOverride: null };
  }
  return null;
}

function signalV3a(ind: IndicatorSet, candles: readonly Candle[], i: number): SignalOut {
  const row = candles[i];
  if (!Number.isFinite(ind.rsi14[i]) || !Number.isFinite(ind.atr14[i]) || !Number.isFinite(ind.sma50[i])) return null;
  const rsiWin = ind.rsi14.slice(Math.max(0, i - DIP_WINDOW + 1), i + 1);
  const up = row.close > ind.sma50[i] && ind.sma20[i] > ind.sma50[i];
  const down = row.close < ind.sma50[i] && ind.sma20[i] < ind.sma50[i];
  if (up) {
    const dip = Math.min(...rsiWin) < RSI_DIP_LONG;
    const confirm =
      row.close > candles[i - 1].high && ind.rsi14[i] > RSI_DIP_LONG && ind.rsi14[i] <= RSI_CAP_LONG;
    const struct = row.close > ind.swingLow[i] && row.close > ind.sma20[i];
    if (dip && confirm && struct) return { side: 'long', riskDistOverride: null };
  } else if (down) {
    const dip = Math.max(...rsiWin) > RSI_DIP_SHORT;
    const confirm =
      row.close < candles[i - 1].low && ind.rsi14[i] < RSI_DIP_SHORT && ind.rsi14[i] >= RSI_CAP_SHORT;
    const struct = row.close < ind.swingHigh[i] && row.close < ind.sma20[i];
    if (dip && confirm && struct) return { side: 'short', riskDistOverride: null };
  }
  return null;
}

interface PendingSetup {
  side: Side;
  level: number;
  breakoutIdx: number;
}

function signalV3c(
  ind: IndicatorSet,
  candles: readonly Candle[],
  i: number,
  pend: PendingSetup | null,
): SignalOut {
  // No entry on the breakout candle itself: only pending setups created
  // on an EARLIER candle can fire.
  if (pend === null || pend.breakoutIdx >= i) return null;
  const row = candles[i];
  const atr = ind.atr14[i];
  if (!Number.isFinite(atr)) return null;
  if (pend.side === 'long') {
    if (row.low <= pend.level + RETEST_TOUCH_ATR * atr && row.close >= pend.level) {
      const riskDist = Math.max(
        SL_ATR * atr,
        row.close - pend.level + RETEST_LEVEL_BUFFER_ATR * atr,
      );
      return { side: 'long', riskDistOverride: riskDist };
    }
  } else {
    if (row.high >= pend.level - RETEST_TOUCH_ATR * atr && row.close <= pend.level) {
      const riskDist = Math.max(
        SL_ATR * atr,
        pend.level - row.close + RETEST_LEVEL_BUFFER_ATR * atr,
      );
      return { side: 'short', riskDistOverride: riskDist };
    }
  }
  return null;
}

/**
 * v1.0 entry (STRATEGY-v1.md §2–§3): 1h confirmation candle, 4h trend
 * and swing structure from the last CLOSED 4h candle at the time of
 * the 1h close. `ind1h`/`ind4h` are the indicator sets for the two
 * timeframes; `j` is the index of the last closed 4h candle.
 */
function signalV1(
  ind1h: IndicatorSet,
  candles1h: readonly Candle[],
  ind4h: IndicatorSet,
  candles4h: readonly Candle[],
  i: number,
  j: number,
): SignalOut {
  const row = candles1h[i];
  const row4h = candles4h[j];
  if (
    !Number.isFinite(ind1h.rsi14[i]) ||
    !Number.isFinite(ind1h.atr14[i]) ||
    !Number.isFinite(ind4h.sma50[j]) ||
    !Number.isFinite(ind4h.swingLow[j]) ||
    !Number.isFinite(ind4h.swingHigh[j])
  ) {
    return null;
  }
  const rsiWin = ind1h.rsi14.slice(Math.max(0, i - 12 + 1), i + 1);
  const up = row4h.close > ind4h.sma50[j] && ind4h.sma20[j] > ind4h.sma50[j];
  const down = row4h.close < ind4h.sma50[j] && ind4h.sma20[j] < ind4h.sma50[j];
  if (up) {
    const dip = Math.min(...rsiWin) < RSI_DIP_LONG;
    const confirm =
      row.close > candles1h[i - 1].high && ind1h.rsi14[i] > RSI_DIP_LONG && ind1h.rsi14[i] <= RSI_CAP_LONG;
    const struct = row.close > ind4h.swingLow[j];
    if (dip && confirm && struct) return { side: 'long', riskDistOverride: null };
  } else if (down) {
    const dip = Math.max(...rsiWin) > RSI_DIP_SHORT;
    const confirm =
      row.close < candles1h[i - 1].low && ind1h.rsi14[i] < RSI_DIP_SHORT && ind1h.rsi14[i] >= RSI_CAP_SHORT;
    const struct = row.close < ind4h.swingHigh[j];
    if (dip && confirm && struct) return { side: 'short', riskDistOverride: null };
  }
  return null;
}

// ---- main engine ----

interface OpenPos {
  symbol: string;
  side: Side;
  entry: number; // slippage-adjusted fill
  entryTime: string;
  entryIdx: number;
  sl: number;
  slOrig: number;
  tp: number;
  size: number;
  riskDist: number;
  riskUsd: number;
  beMoved: boolean;
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const cfg = VARIANT_CONFIG[input.variant];
  const startEquity = input.startEquity ?? START_EQUITY;
  const symbols = cfg.symbols.filter((s) => input.data[s] !== undefined);
  if (symbols.length === 0) {
    throw new Error(`runBacktest(${input.variant}): no candle data supplied for ${cfg.symbols.join(', ')}`);
  }
  if (cfg.use1h && !input.data4h) {
    throw new Error('runBacktest(v1): data4h (4h candles) is required alongside 1h data.');
  }
  const n = Math.min(...symbols.map((s) => input.data[s].length));
  const indBySymbol = new Map<string, IndicatorSet>();
  for (const s of symbols) indBySymbol.set(s, computeIndicators(input.data[s]));
  const ind4hBySymbol = new Map<string, IndicatorSet>();
  if (input.data4h) {
    for (const s of symbols) {
      if (input.data4h[s]) ind4hBySymbol.set(s, computeIndicators(input.data4h[s]));
    }
  }
  // For v1: pointer from each 1h candle to the last closed 4h candle
  // (4h candle whose open time <= the 1h candle's open time).
  const fourHourIdxBySymbol = new Map<string, number[]>();
  if (cfg.use1h && input.data4h) {
    for (const s of symbols) {
      const candles4h = input.data4h[s];
      if (!candles4h) {
        throw new Error(`runBacktest(v1): data4h is required for ${s} (4h trend/structure timeframe).`);
      }
      const map: number[] = [];
      let j = -1;
      for (let i = 0; i < n; i++) {
        const t = input.data[s][i].time;
        while (j + 1 < candles4h.length && candles4h[j + 1].time <= t) j++;
        map.push(j);
      }
      fourHourIdxBySymbol.set(s, map);
    }
  }

  const times = input.data[symbols[0]].slice(0, n).map((c) => c.time);
  const dates = times.map(utcDate);

  const trades: BacktestTrade[] = [];
  let equity = startEquity;
  const equityCurve: EquityPoint[] = [
    { time: new Date(times[0]).toISOString(), equity },
  ];
  const openPos = new Map<string, OpenPos | null>(symbols.map((s) => [s, null]));
  const entriesByDay = new Map<string, number>();
  const lossesByDay = new Map<string, number>();
  const pnlByDay = new Map<string, number>();
  const haltedDays = new Set<string>();
  const pending = new Map<string, PendingSetup | null>(symbols.map((s) => [s, null]));
  const diag: BacktestDiagnostics = {
    rawSetups: 0, volGuardSkips: 0, costFilterSkips: 0, notionalCapSkips: 0,
    concurrentCapSkips: 0, dailyCapSkips: 0, haltBlockedSkips: 0, lossStopSkips: 0,
    haltTriggers: 0, haltCloses: 0, breakoutsDetected: 0, retestExpired: 0, retestCancelled: 0,
  };

  const closePosition = (s: string, i: number, exitPrice: number, exitReason: ExitReason): void => {
    const pos = openPos.get(s);
    if (!pos) return;
    const row = input.data[s][i];
    const { gross, fees, net } = realizedPnl(pos, exitPrice);
    equity += net;
    const exDay = dates[i];
    pnlByDay.set(exDay, (pnlByDay.get(exDay) ?? 0) + net);
    if (net < 0) lossesByDay.set(exDay, (lossesByDay.get(exDay) ?? 0) + 1);
    trades.push({
      symbol: s,
      side: pos.side,
      entryTime: pos.entryTime,
      entry: pos.entry,
      exitTime: new Date(row.time).toISOString(),
      exit: exitPrice,
      exitReason,
      sl: pos.slOrig,
      tp: pos.tp,
      size: pos.size,
      riskUsd: pos.riskUsd,
      grossPnl: gross,
      fees,
      pnl: net,
      rMultiple: net / cfg.riskPerTrade,
      barsHeld: i - pos.entryIdx,
      beMoved: pos.beMoved,
    });
    equityCurve.push({ time: new Date(row.time).toISOString(), equity });
    openPos.set(s, null);
  };

  const dayBlocked = (day: string): 'halt' | 'cap' | 'loss_stop' | null => {
    if (haltedDays.has(day)) return 'halt';
    if ((entriesByDay.get(day) ?? 0) >= MAX_TRADES_PER_DAY) return 'cap';
    if ((lossesByDay.get(day) ?? 0) >= MAX_LOSSES_PER_DAY) return 'loss_stop';
    if ((pnlByDay.get(day) ?? 0) <= DAILY_HALT_USD) return 'loss_stop';
    return null;
  };

  for (let i = cfg.warmup; i < n; i++) {
    const day = dates[i];
    // --- 1. manage open positions on this candle (SL / TP / BE / TIME) ---
    const closedToday = new Set<string>();
    for (const s of symbols) {
      const pos = openPos.get(s);
      if (!pos) continue;
      const row = input.data[s][i];
      const { sl, tp } = pos;
      let exitPrice: number | null = null;
      let exitReason: ExitReason | null = null;
      if (pos.side === 'long') {
        if (row.low <= sl) {
          exitPrice = sl * (1 - SLIPPAGE);
          exitReason = 'SL';
        } else if (row.high >= tp) {
          exitPrice = tp * (1 - SLIPPAGE);
          exitReason = 'TP';
        } else if (row.high >= pos.entry + BE_TRIGGER_R * pos.riskDist && !pos.beMoved) {
          pos.sl = pos.entry;
          pos.beMoved = true;
        }
      } else {
        if (row.high >= sl) {
          exitPrice = sl * (1 + SLIPPAGE);
          exitReason = 'SL';
        } else if (row.low <= tp) {
          exitPrice = tp * (1 + SLIPPAGE);
          exitReason = 'TP';
        } else if (row.low <= pos.entry - BE_TRIGGER_R * pos.riskDist && !pos.beMoved) {
          pos.sl = pos.entry;
          pos.beMoved = true;
        }
      }
      if (exitPrice === null && i - pos.entryIdx >= cfg.maxHoldBars) {
        exitPrice =
          pos.side === 'long' ? row.close * (1 - SLIPPAGE) : row.close * (1 + SLIPPAGE);
        exitReason = 'TIME';
      }
      if (exitPrice !== null && exitReason !== null) {
        closePosition(s, i, exitPrice, exitReason);
        closedToday.add(s);
      }
    }
    // --- 2. daily loss halt (v2/v3 only): realized today + unrealized open, at close ---
    if (cfg.haltEnabled) {
      const nOpen = symbols.filter((s) => openPos.get(s) !== null).length;
      if (nOpen > 0 && !haltedDays.has(day)) {
        let unreal = 0;
        for (const s of symbols) {
          const pos = openPos.get(s);
          if (!pos) continue;
          const mark = input.data[s][i].close;
          unreal += unrealizedPnl(pos, mark);
        }
        if ((pnlByDay.get(day) ?? 0) + unreal <= DAILY_HALT_USD) {
          diag.haltTriggers += 1;
          haltedDays.add(day);
          for (const s of symbols) {
            const pos = openPos.get(s);
            if (!pos) continue;
            const row = input.data[s][i];
            const px =
              pos.side === 'long' ? row.close * (1 - SLIPPAGE) : row.close * (1 + SLIPPAGE);
            closePosition(s, i, px, 'HALT');
            diag.haltCloses += 1;
            closedToday.add(s);
          }
        }
      }
    }
    // --- 2b. variant C: update pending breakout setups (observation, not a trade) ---
    if (input.variant === 'v3c') {
      for (const s of symbols) {
        const ind = indBySymbol.get(s)!;
        const row = input.data[s][i];
        if (!Number.isFinite(ind.rsi14[i]) || !Number.isFinite(ind.atr14[i]) || !Number.isFinite(ind.sma50[i])) {
          continue;
        }
        const pend = pending.get(s) ?? null;
        if (pend === null) {
          if (row.close > ind.swingHigh[i] && ind.sma20[i] > ind.sma50[i] && ind.rsi14[i] >= BREAKOUT_RSI_LONG) {
            pending.set(s, { side: 'long', level: ind.swingHigh[i], breakoutIdx: i });
            diag.breakoutsDetected += 1;
          } else if (row.close < ind.swingLow[i] && ind.sma20[i] < ind.sma50[i] && ind.rsi14[i] <= BREAKOUT_RSI_SHORT) {
            pending.set(s, { side: 'short', level: ind.swingLow[i], breakoutIdx: i });
            diag.breakoutsDetected += 1;
          }
        } else {
          if (i - pend.breakoutIdx > RETEST_WINDOW_BARS) {
            pending.set(s, null);
            diag.retestExpired += 1;
          } else if (pend.side === 'long' && row.close < pend.level) {
            pending.set(s, null);
            diag.retestCancelled += 1;
          } else if (pend.side === 'short' && row.close > pend.level) {
            pending.set(s, null);
            diag.retestCancelled += 1;
          }
        }
      }
    }
    // --- 3. evaluate new entries on this candle ---
    const block = dayBlocked(day);
    if (block !== null) {
      if (block === 'halt') diag.haltBlockedSkips += 1;
      else if (block === 'cap') diag.dailyCapSkips += 1;
      else diag.lossStopSkips += 1;
      continue;
    }
    let nOpen = symbols.filter((s) => openPos.get(s) !== null).length;
    for (const s of symbols) {
      if (openPos.get(s) !== null || closedToday.has(s)) continue;
      const ind = indBySymbol.get(s)!;
      const row = input.data[s][i];
      if (!Number.isFinite(ind.rsi14[i]) || !Number.isFinite(ind.atr14[i]) || !Number.isFinite(ind.sma50[i])) {
        continue;
      }
      const atr = ind.atr14[i];
      let sig: SignalOut = null;
      if (input.variant === 'v1') {
        const j = fourHourIdxBySymbol.get(s)![i];
        if (j < 0) continue;
        sig = signalV1(ind, input.data[s], ind4hBySymbol.get(s)!, input.data4h![s], i, j);
      } else if (input.variant === 'v2') {
        sig = signalV2(ind, input.data[s], i);
      } else if (input.variant === 'v3a') {
        sig = signalV3a(ind, input.data[s], i);
      } else if (input.variant === 'v3b') {
        const setup = detectSetup(input.data[s], ind, i);
        sig = setup === null ? null : { side: setup.side, riskDistOverride: null };
      } else {
        sig = signalV3c(ind, input.data[s], i, pending.get(s) ?? null);
      }
      if (sig === null) continue;
      const { side, riskDistOverride } = sig;
      diag.rawSetups += 1;
      // volatility guard
      if (!volGuardOk(input.data[s], ind, i)) {
        diag.volGuardSkips += 1;
        continue;
      }
      const entry = row.close;
      const riskDist = riskDistOverride ?? SL_ATR * atr;
      const sl = side === 'long' ? entry - riskDist : entry + riskDist;
      const tp = side === 'long' ? entry + 2 * riskDist : entry - 2 * riskDist;
      const size = cfg.riskPerTrade / riskDist;
      const notional = size * entry;
      if (cfg.costFilter) {
        // cost filter: round-trip costs must be <= 25% of risk
        if (ROUND_TRIP_COST * notional > COST_FILTER_MAX * cfg.riskPerTrade) {
          diag.costFilterSkips += 1;
          continue;
        }
        if (notional > NOTIONAL_CAP) {
          diag.notionalCapSkips += 1;
          continue;
        }
      }
      // concurrent-position cap
      if (nOpen >= cfg.maxConcurrent) {
        diag.concurrentCapSkips += 1;
        continue;
      }
      // daily cap re-check (another symbol may have filled it this candle)
      if (dayBlocked(day) !== null) {
        diag.dailyCapSkips += 1;
        continue;
      }
      const entryFill = side === 'long' ? entry * (1 + SLIPPAGE) : entry * (1 - SLIPPAGE);
      openPos.set(s, {
        symbol: s,
        side,
        entry: entryFill,
        entryTime: new Date(row.time).toISOString(),
        entryIdx: i,
        sl,
        slOrig: sl,
        tp,
        size,
        riskDist,
        riskUsd: cfg.riskPerTrade,
        beMoved: false,
      });
      if (input.variant === 'v3c') pending.set(s, null); // retest consumed
      entriesByDay.set(day, (entriesByDay.get(day) ?? 0) + 1);
      nOpen += 1;
      if ((entriesByDay.get(day) ?? 0) >= MAX_TRADES_PER_DAY) break;
    }
  }

  // close any still-open positions at the last close (marked, not a signal)
  for (const s of symbols) {
    const pos = openPos.get(s);
    if (!pos) continue;
    const row = input.data[s][n - 1];
    const exitPrice =
      pos.side === 'long' ? row.close * (1 - SLIPPAGE) : row.close * (1 + SLIPPAGE);
    closePosition(s, n - 1, exitPrice, 'END_OF_DATA');
  }

  const metrics = computeMetrics(trades, equityCurve, startEquity);
  const criteria = evaluateCriteria(input.variant, metrics);
  let split: BacktestResult['split'] = null;
  if (input.trainRatio !== undefined && input.trainRatio > 0 && input.trainRatio < 1) {
    const splitIdx = Math.floor(n * input.trainRatio);
    // Trades are assigned by ENTRY candle index; equity curves are
    // rebuilt per split from that split's trades in exit order.
    const trainTrades = trades.filter((t) => Date.parse(t.entryTime) < times[splitIdx]);
    const testTrades = trades.filter((t) => Date.parse(t.entryTime) >= times[splitIdx]);
    const equityFor = (subset: BacktestTrade[]): EquityPoint[] => {
      const pts: EquityPoint[] = [{ time: new Date(times[0]).toISOString(), equity: startEquity }];
      let eq = startEquity;
      for (const t of subset) {
        eq += t.pnl;
        pts.push({ time: t.exitTime, equity: eq });
      }
      return pts;
    };
    split = {
      train: computeMetrics(trainTrades, equityFor(trainTrades), startEquity),
      test: computeMetrics(testTrades, equityFor(testTrades), startEquity),
    };
  }
  return {
    variant: input.variant,
    metrics,
    trades,
    equity: equityCurve,
    criteria,
    diagnostics: diag,
    stored: STORED_RESULTS[input.variant],
    split,
  };
}
