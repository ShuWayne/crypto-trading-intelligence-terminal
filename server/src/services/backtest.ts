/**
 * Backtesting — stored validated results + live runs via the backtest engine.
 *
 * Stored variants (verified 19 Nov 2026, 240-day window 24 Mar – 19 Nov 2026,
 * 4h, $5,000 start, 0.1% fee + 0.05% slippage per side):
 *   v1.0  FAILED  158 trades, 27.2% WR, PF 0.43, net -$826.17
 *   v2.0  FAILED   28 trades, 14.3% WR, PF 0.44, net -$141.25
 *   v3-A  FAILED   16 trades, 25.0% WR, PF 0.79, net  -$28.41
 *   v3-B  VALIDATED 17 trades, 47.1% WR, PF 1.75, net  +$72.42
 *   v3-C  FAILED   50 trades, 32.0% WR, PF 1.02, net   +$9.12
 *
 * Live runs use the engines agent's backtest engine (data-passed-in, no
 * network inside engines): this service fetches the klines with the
 * market-data layer and calls runBacktest({variant, data, data4h}).
 * If a live run cannot complete (e.g. Binance unreachable), the stored
 * validated result is returned instead, labelled
 * source:'stored-validated-result' with the failure reason in `note` —
 * never presented as a fresh run.
 */
import { randomUUID } from 'node:crypto';
import { binance, type Candle } from './binance.js';
import { getDb } from './db.js';
import {
  runBacktest as engineRunBacktest,
  type BacktestMetrics,
  type BacktestVariant,
} from '../engines/backtest.js';

export interface VariantMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  grossProfit: number;
  grossLoss: number;
  totalFees: number;
  avgR: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  bestDay: [string, number] | null;
  worstDay: [string, number] | null;
  tpExits: number;
  slExits: number;
  timeExits: number;
  haltExits: number;
  // Extra fields present on live engine runs (and on stored results where known).
  expectancy?: number;
  startEquity?: number;
  endEquity?: number;
  returnPct?: number;
  longestLosingStreak?: number;
  endOfDataExits?: number;
  beMovedCount?: number;
  halves?: { H1: { trades: number; wins: number; winRate: number; net: number }; H2: { trades: number; wins: number; winRate: number; net: number } };
  perSymbol?: Record<string, { trades: number; wins: number; winRate: number; net: number }>;
}

export interface Variant {
  id: string;
  name: string;
  status: 'VALIDATED' | 'FAILED';
  verdict: string;
  window: string;
  symbols: string[];
  riskPerTrade: number;
  metrics: VariantMetrics;
  halves: { h1Net: number; h2Net: number; h1WinRate: number; h2WinRate: number };
  notes: string;
}

export const VARIANTS: Variant[] = [
  {
    id: 'v1',
    name: 'v1.0 — 4h Trend (original)',
    status: 'FAILED',
    verdict: 'DOES NOT VALIDATE — never traded.',
    window: '2026-07-22 → 2026-11-19 (120 days)',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PAXGUSDT'],
    riskPerTrade: 10,
    metrics: {
      trades: 158, wins: 43, losses: 115, winRate: 27.2, profitFactor: 0.43,
      netPnl: -826.17, avgWin: 14.26, avgLoss: -12.52, grossProfit: 613.16,
      grossLoss: 1439.33, totalFees: 555.81, avgR: -0.52,
      maxDrawdownUsd: -915.65, maxDrawdownPct: -18.27,
      bestDay: ['2026-11-12', 52.56], worstDay: ['2026-08-16', -69.15],
      tpExits: 40, slExits: 111, timeExits: 5, haltExits: 0,
    },
    halves: { h1Net: 0, h2Net: 0, h1WinRate: 0, h2WinRate: 0 },
    notes: 'Fees ate small-ATR entries (worst trade -$46.87 on a $10 risk). PAXG worst (-$484). No live trading on v1.0.',
  },
  {
    id: 'v2',
    name: 'v2.0 — 4h Trend Breakout Pullback',
    status: 'FAILED',
    verdict: 'DOES NOT VALIDATE — never traded.',
    window: '2026-03-24 → 2026-11-19 (240 days)',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    riskPerTrade: 15,
    metrics: {
      trades: 28, wins: 4, losses: 24, winRate: 14.3, profitFactor: 0.44,
      netPnl: -141.25, avgWin: 27.46, avgLoss: -10.46, grossProfit: 109.85,
      grossLoss: 251.09, totalFees: 44.0, avgR: -0.34,
      maxDrawdownUsd: -168.76, maxDrawdownPct: -3.36,
      bestDay: ['2026-05-18', 27.47], worstDay: ['2026-10-29', -35.01],
      tpExits: 4, slExits: 22, timeExits: 0, haltExits: 2,
    },
    halves: { h1Net: -16.64, h2Net: -124.61, h1WinRate: 21.4, h2WinRate: 7.1 },
    notes: 'Risk controls fixed drawdown (-3.4% vs -18.3%) but strengthened breakout confirmation bought range tops; H2 win rate 7.1%. Primary run failed the daily-cap criterion (worst day -$35.01).',
  },
  {
    id: 'v3-a',
    name: 'v3-A — BTC-only Pullback',
    status: 'FAILED',
    verdict: 'DOES NOT VALIDATE — never traded.',
    window: '2026-03-24 → 2026-11-19 (240 days)',
    symbols: ['BTCUSDT'],
    riskPerTrade: 15,
    metrics: {
      trades: 16, wins: 4, losses: 12, winRate: 25.0, profitFactor: 0.79,
      netPnl: -28.41, avgWin: 27.39, avgLoss: -11.5, grossProfit: 109.57,
      grossLoss: 137.98, totalFees: 30.49, avgR: -0.12,
      maxDrawdownUsd: -66.61, maxDrawdownPct: -1.32,
      bestDay: ['2026-04-14', 27.51], worstDay: ['2026-10-13', -18.59],
      tpExits: 4, slExits: 12, timeExits: 0, haltExits: 0,
    },
    halves: { h1Net: 38.2, h2Net: -66.61, h1WinRate: 50.0, h2WinRate: 0.0 },
    notes: 'BTC pocket was H1 noise — 0 wins in 8 H2 trades.',
  },
  {
    id: 'v3-b',
    name: 'v3-B — Range Mean-Reversion',
    status: 'VALIDATED',
    verdict: 'VALIDATED — the only strategy advanced to Phase 2 paper trading.',
    window: '2026-03-24 → 2026-11-19 (240 days)',
    symbols: ['BTCUSDT', 'SOLUSDT'],
    riskPerTrade: 15,
    metrics: {
      trades: 17, wins: 8, losses: 9, winRate: 47.1, profitFactor: 1.75,
      netPnl: 72.42, avgWin: 21.06, avgLoss: -10.68, grossProfit: 168.51,
      grossLoss: 96.09, totalFees: 28.16, avgR: 0.28,
      maxDrawdownUsd: -64.0, maxDrawdownPct: -1.25,
      bestDay: ['2026-05-23', 55.19], worstDay: ['2026-10-08', -26.57],
      tpExits: 5, slExits: 7, timeExits: 4, haltExits: 1,
    },
    halves: { h1Net: 47.08, h2Net: 25.35, h1WinRate: 60.0, h2WinRate: 41.7 },
    notes: 'Passes all 5 pre-registered criteria; both halves positive. Caveats: only 17 trades (small sample), best day = 76% of profit, ~1 trade per 14 days, zero November trades.',
  },
  {
    id: 'v3-c',
    name: 'v3-C — Momentum Breakout + Retest',
    status: 'FAILED',
    verdict: 'DOES NOT VALIDATE — never traded.',
    window: '2026-03-24 → 2026-11-19 (240 days)',
    symbols: ['BTCUSDT', 'SOLUSDT'],
    riskPerTrade: 15,
    metrics: {
      trades: 50, wins: 16, losses: 34, winRate: 32.0, profitFactor: 1.02,
      netPnl: 9.12, avgWin: 25.31, avgLoss: -11.64, grossProfit: 404.94,
      grossLoss: 395.82, totalFees: 65.2, avgR: 0.01,
      maxDrawdownUsd: -195.96, maxDrawdownPct: -3.87,
      bestDay: ['2026-06-04', 29.06], worstDay: ['2026-09-11', -34.73],
      tpExits: 13, slExits: 28, timeExits: 4, haltExits: 5,
    },
    halves: { h1Net: 33.38, h2Net: -24.26, h1WinRate: 32.1, h2WinRate: 31.8 },
    notes: 'Net +$9.12 is a November artifact; worst day -$34.73 breaks the -$30 cap.',
  },
];

/** The 17 validated v3-B trades (from trades-v3-b.csv, 240-day backtest). */
export const V3B_TRADES = [
  { symbol: 'BTCUSDT', side: 'short', entryTime: '2026-04-22 16:00:00+00:00', entry: 78807.2, exitTime: '2026-04-26 16:00:00+00:00', exit: 78260.27, exitReason: 'TIME', sl: 80380.24, tp: 75779.39, size: 0.0097808, riskUsd: 15, pnl: 3.81, fees: 1.54, barsHeld: 24 },
  { symbol: 'BTCUSDT', side: 'long', entryTime: '2026-05-23 08:00:00+00:00', entry: 74827.38, exitTime: '2026-05-23 20:00:00+00:00', exit: 77016.49, exitReason: 'TP', sl: 73657.47, tp: 77055.02, size: 0.0132449, riskUsd: 15, pnl: 26.98, fees: 2.01, barsHeld: 3 },
  { symbol: 'SOLUSDT', side: 'long', entryTime: '2026-05-23 08:00:00+00:00', entry: 82.35115, exitTime: '2026-05-23 20:00:00+00:00', exit: 86.4965, exitReason: 'TP', sl: 80.19511, tp: 86.53978, size: 7.0925731, riskUsd: 15, pnl: 28.2, fees: 1.2, barsHeld: 3 },
  { symbol: 'BTCUSDT', side: 'long', entryTime: '2026-05-28 04:00:00+00:00', entry: 73534.75, exitTime: '2026-06-01 04:00:00+00:00', exit: 72781.59, exitReason: 'TIME', sl: 72225.0, tp: 76043.99, size: 0.0117832, riskUsd: 15, pnl: -10.6, fees: 1.72, barsHeld: 24 },
  { symbol: 'SOLUSDT', side: 'long', entryTime: '2026-07-08 16:00:00+00:00', entry: 77.45871, exitTime: '2026-07-10 12:00:00+00:00', exit: 77.41998, exitReason: 'SL', sl: 75.23007, tp: 81.79987, size: 6.8495248, riskUsd: 15, pnl: -1.33, fees: 1.06, barsHeld: 11 },
  { symbol: 'SOLUSDT', side: 'short', entryTime: '2026-07-21 08:00:00+00:00', entry: 78.32082, exitTime: '2026-07-24 00:00:00+00:00', exit: 75.46332, exitReason: 'TP', sl: 79.8272, tp: 75.42561, size: 10.2235786, riskUsd: 15, pnl: 27.64, fees: 1.57, barsHeld: 16 },
  { symbol: 'SOLUSDT', side: 'long', entryTime: '2026-07-25 00:00:00+00:00', entry: 74.17707, exitTime: '2026-07-26 20:00:00+00:00', exit: 76.89234, exitReason: 'TP', sl: 72.7446, tp: 76.9308, size: 10.7496019, riskUsd: 15, pnl: 27.56, fees: 1.62, barsHeld: 11 },
  { symbol: 'SOLUSDT', side: 'short', entryTime: '2026-08-08 16:00:00+00:00', entry: 76.12192, exitTime: '2026-08-09 12:00:00+00:00', exit: 77.50042, exitReason: 'SL', sl: 77.46169, tp: 73.55662, size: 11.5234732, riskUsd: 15, pnl: -17.66, fees: 1.77, barsHeld: 5 },
  { symbol: 'BTCUSDT', side: 'short', entryTime: '2026-09-03 20:00:00+00:00', entry: 81229.73, exitTime: '2026-09-07 20:00:00+00:00', exit: 79151.57, exitReason: 'TIME', sl: 82871.99, tp: 78067.12, size: 0.0093655, riskUsd: 15, pnl: 17.96, fees: 1.5, barsHeld: 24 },
  { symbol: 'SOLUSDT', side: 'short', entryTime: '2026-09-18 08:00:00+00:00', entry: 105.68713, exitTime: '2026-09-18 12:00:00+00:00', exit: 108.5261, exitReason: 'SL', sl: 108.47186, tp: 100.27628, size: 5.4907626, riskUsd: 15, pnl: -16.76, fees: 1.18, barsHeld: 1 },
  { symbol: 'BTCUSDT', side: 'short', entryTime: '2026-09-18 20:00:00+00:00', entry: 80843.43, exitTime: '2026-09-21 08:00:00+00:00', exit: 82368.84, exitReason: 'SL', sl: 82327.67, tp: 77996.26, size: 0.0103892, riskUsd: 15, pnl: -17.54, fees: 1.7, barsHeld: 15 },
  { symbol: 'BTCUSDT', side: 'short', entryTime: '2026-10-05 00:00:00+00:00', entry: 86041.99, exitTime: '2026-10-05 20:00:00+00:00', exit: 86085.01, exitReason: 'SL', sl: 87119.47, tp: 84016.15, size: 0.0145006, riskUsd: 15, pnl: -3.12, fees: 2.5, barsHeld: 5 },
  { symbol: 'SOLUSDT', side: 'long', entryTime: '2026-10-07 20:00:00+00:00', entry: 116.35815, exitTime: '2026-10-08 08:00:00+00:00', exit: 113.79164, exitReason: 'SL', sl: 113.84856, tp: 121.20287, size: 6.1188609, riskUsd: 15, pnl: -17.11, fees: 1.41, barsHeld: 3 },
  { symbol: 'BTCUSDT', side: 'long', entryTime: '2026-10-08 04:00:00+00:00', entry: 83040.25, exitTime: '2026-10-08 08:00:00+00:00', exit: 82464.76, exitReason: 'HALT', sl: 81823.25, tp: 85349.75, size: 0.0127605, riskUsd: 15, pnl: -9.46, fees: 2.11, barsHeld: 1 },
  { symbol: 'BTCUSDT', side: 'short', entryTime: '2026-10-21 16:00:00+00:00', entry: 84447.35, exitTime: '2026-10-22 08:00:00+00:00', exit: 82093.34, exitReason: 'TP', sl: 85708.23, tp: 82052.31, size: 0.0123088, riskUsd: 15, pnl: 26.93, fees: 2.05, barsHeld: 4 },
  { symbol: 'BTCUSDT', side: 'long', entryTime: '2026-10-24 16:00:00+00:00', entry: 80529.35, exitTime: '2026-10-28 12:00:00+00:00', exit: 80489.09, exitReason: 'SL', sl: 79287.99, tp: 82891.36, size: 0.0124883, riskUsd: 15, pnl: -2.51, fees: 2.01, barsHeld: 23 },
  { symbol: 'SOLUSDT', side: 'long', entryTime: '2026-10-24 16:00:00+00:00', entry: 101.22059, exitTime: '2026-10-28 16:00:00+00:00', exit: 103.00847, exitReason: 'TIME', sl: 98.64846, tp: 106.21308, size: 5.9487407, riskUsd: 15, pnl: 9.42, fees: 1.21, barsHeld: 24 },
];

const VARIANT_ALIASES: Record<string, BacktestVariant> = {
  v1: 'v1',
  v2: 'v2',
  'v3-a': 'v3a',
  v3a: 'v3a',
  a: 'v3a',
  'v3-b': 'v3b',
  v3b: 'v3b',
  b: 'v3b',
  'v3-c': 'v3c',
  v3c: 'v3c',
  c: 'v3c',
};

const VARIANT_ID_BY_ENGINE: Record<BacktestVariant, string> = {
  v1: 'v1',
  v2: 'v2',
  v3a: 'v3-a',
  v3b: 'v3-b',
  v3c: 'v3-c',
};

function mapMetrics(m: BacktestMetrics): VariantMetrics {
  return {
    trades: m.trades,
    wins: m.wins,
    losses: m.losses,
    winRate: m.winRate,
    profitFactor: m.profitFactor,
    netPnl: m.netPnl,
    avgWin: m.avgWin,
    avgLoss: m.avgLoss,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    totalFees: m.totalFees,
    avgR: m.avgR,
    maxDrawdownUsd: m.maxDrawdownUsd,
    maxDrawdownPct: m.maxDrawdownPct,
    bestDay: m.bestDay,
    worstDay: m.worstDay,
    tpExits: m.tpExits,
    slExits: m.slExits,
    timeExits: m.timeExits,
    haltExits: m.haltExits,
    expectancy: m.expectancy,
    startEquity: m.startEquity,
    endEquity: m.endEquity,
    returnPct: m.returnPct,
    longestLosingStreak: m.longestLosingStreak,
    endOfDataExits: m.endOfDataExits,
    beMovedCount: m.beMovedCount,
    halves: {
      H1: { trades: m.halves.H1.trades, wins: m.halves.H1.wins, winRate: m.halves.H1.winRate, net: m.halves.H1.net },
      H2: { trades: m.halves.H2.trades, wins: m.halves.H2.wins, winRate: m.halves.H2.winRate, net: m.halves.H2.net },
    },
    perSymbol: m.perSymbol,
  };
}

/**
 * Fetch `count` candles for a symbol/interval, paged backwards from the
 * latest closed candle (Binance caps at 1000 per request).
 */
async function fetchSeries(symbol: string, interval: string, count: number): Promise<Candle[]> {
  const capped = Math.min(count, 6000);
  const pages: Candle[][] = [];
  let endTime: number | undefined;
  let remaining = capped;
  while (remaining > 0) {
    const limit = Math.min(remaining, 1000);
    const page = await binance.getKlines(symbol, interval, limit, endTime);
    if (page.length === 0) break;
    pages.unshift(page);
    remaining -= page.length;
    if (page.length < limit) break; // reached the start of available data
    endTime = page[0].time - 1;
  }
  const all = pages.flat();
  return all.slice(-capped);
}

export function getVariants(): Variant[] {
  return VARIANTS;
}

export async function runBacktest(variantId: string, symbols: string[], days: number): Promise<{
  id: string;
  variant: string;
  symbols: string[];
  days: number;
  metrics: VariantMetrics;
  trades: unknown[];
  equity: unknown[];
  criteria: unknown;
  diagnostics: unknown;
  stored: unknown;
  window: { from: string | null; to: string | null };
  source: string;
  note?: string;
  createdAt: string;
}> {
  const engineVariant = VARIANT_ALIASES[variantId.toLowerCase()];
  const variant = VARIANTS.find((v) => v.id === VARIANT_ID_BY_ENGINE[engineVariant as BacktestVariant]);
  if (!engineVariant || !variant) throw new Error(`Unknown variant: ${variantId}`);

  const runSymbols = symbols.length > 0 ? symbols : variant.symbols;
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    // v1 runs on 1h data (+ 4h for trend/swing structure); v2/v3 run on 4h.
    const data: Record<string, Candle[]> = {};
    let data4h: Record<string, Candle[]> | undefined;
    if (engineVariant === 'v1') {
      for (const s of runSymbols) {
        data[s] = await fetchSeries(s, '1h', days * 24 + 250);
        data4h ??= {};
        data4h[s] = await fetchSeries(s, '4h', days * 6 + 100);
      }
    } else {
      for (const s of runSymbols) {
        data[s] = await fetchSeries(s, '4h', days * 6 + 120);
      }
    }

    const result = engineRunBacktest({ variant: engineVariant, data, data4h });
    const first = Object.values(data)[0];
    const window = {
      from: first?.length ? new Date(first[0].time).toISOString() : null,
      to: first?.length ? new Date(first[first.length - 1].time).toISOString() : null,
    };
    const metrics = mapMetrics(result.metrics);
    getDb().insertBacktestReport({
      id,
      variant: variant.id,
      symbols: runSymbols.join(','),
      days,
      metricsJson: JSON.stringify(metrics),
      tradesJson: JSON.stringify(result.trades),
      equityJson: JSON.stringify(result.equity),
      source: 'engine-live-run',
    });
    return {
      id,
      variant: variant.id,
      symbols: runSymbols,
      days,
      metrics,
      trades: result.trades,
      equity: result.equity,
      criteria: result.criteria,
      diagnostics: result.diagnostics,
      stored: result.stored,
      window,
      source: 'engine-live-run',
      createdAt,
    };
  } catch (err) {
    // Live run failed (Binance unreachable, insufficient data, ...):
    // return the stored validated result, clearly labelled — never fake a run.
    const reason = err instanceof Error ? err.message : String(err);
    const metrics = variant.metrics;
    getDb().insertBacktestReport({
      id,
      variant: variant.id,
      symbols: runSymbols.join(','),
      days,
      metricsJson: JSON.stringify(metrics),
      tradesJson: JSON.stringify(variant.id === 'v3-b' ? V3B_TRADES : []),
      equityJson: JSON.stringify([]),
      source: 'stored-validated-result',
    });
    return {
      id,
      variant: variant.id,
      symbols: runSymbols,
      days,
      metrics,
      trades: variant.id === 'v3-b' ? V3B_TRADES : [],
      equity: [],
      criteria: null,
      diagnostics: null,
      stored: null,
      window: { from: null, to: null },
      source: 'stored-validated-result',
      note: `Live engine run failed (${reason}); returning the stored validated result for ${variant.id} instead.`,
      createdAt,
    };
  }
}

export function listReports() {
  return getDb().listBacktestReports().map((r) => ({
    id: r.id,
    variant: r.variant,
    symbols: r.symbols,
    days: r.days,
    source: r.source,
    createdAt: r.createdAt,
    metrics: JSON.parse(r.metricsJson) as VariantMetrics,
  }));
}

export function getReport(id: string) {
  const r = getDb().getBacktestReport(id);
  if (!r) return null;
  return {
    id: r.id,
    variant: r.variant,
    symbols: r.symbols,
    days: r.days,
    source: r.source,
    createdAt: r.createdAt,
    metrics: JSON.parse(r.metricsJson) as VariantMetrics,
    trades: JSON.parse(r.tradesJson) as unknown[],
    equity: JSON.parse(r.equityJson) as unknown[],
  };
}

export function reportToCsv(report: NonNullable<ReturnType<typeof getReport>>): string {
  const header = 'symbol,side,entry_time,entry,exit_time,exit,exit_reason,sl,tp,size,risk_usd,pnl,fees,bars_held';
  const lines = (report.trades as Record<string, unknown>[]).map((t) =>
    [t.symbol, t.side, t.entryTime, t.entry, t.exitTime, t.exit, t.exitReason, t.sl, t.tp, t.size, t.riskUsd, t.pnl, t.fees, t.barsHeld].join(','),
  );
  return [header, ...lines].join('\n');
}
