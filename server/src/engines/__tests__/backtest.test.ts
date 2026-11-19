import { describe, expect, it } from 'vitest';
import { STORED_RESULTS, runBacktest } from '../backtest.js';
import { loadCsvCandles } from './loadCsv.js';

const data4h = {
  BTCUSDT: loadCsvCandles('BTCUSDT', '4h'),
  SOLUSDT: loadCsvCandles('SOLUSDT', '4h'),
  ETHUSDT: loadCsvCandles('ETHUSDT', '4h'),
  PAXGUSDT: loadCsvCandles('PAXGUSDT', '4h'),
};

describe('stored reference metrics (RESULTS-*.md / metrics-v*.json)', () => {
  it('v3-B is the ONLY validated variant in the stored record', () => {
    expect(STORED_RESULTS.v3b.validated).toBe(true);
    expect(STORED_RESULTS.v1.validated).toBe(false);
    expect(STORED_RESULTS.v2.validated).toBe(false);
    expect(STORED_RESULTS.v3a.validated).toBe(false);
    expect(STORED_RESULTS.v3c.validated).toBe(false);
  });

  it('stored v3-B numbers match RESULTS-v3-b.md', () => {
    const s = STORED_RESULTS.v3b;
    expect(s.trades).toBe(17);
    expect(s.wins).toBe(8);
    expect(s.winRate).toBeCloseTo(47.1, 1);
    expect(s.profitFactor).toBeCloseTo(1.75, 2);
    expect(s.netPnl).toBeCloseTo(72.42, 2);
    expect(s.halves!.H1.net).toBeCloseTo(47.08, 2);
    expect(s.halves!.H2.net).toBeCloseTo(25.35, 2);
    expect(s.worstDay![1]).toBeCloseTo(-26.57, 2);
  });

  it('stored v1/v2/A/C numbers are losses (honest FAILED record)', () => {
    expect(STORED_RESULTS.v1.netPnl).toBeCloseTo(-826.17, 2);
    expect(STORED_RESULTS.v2.netPnl).toBeCloseTo(-141.25, 2);
    expect(STORED_RESULTS.v3a.netPnl).toBeCloseTo(-28.41, 2);
    expect(STORED_RESULTS.v3c.netPnl).toBeCloseTo(9.12, 2);
    expect(STORED_RESULTS.v3c.halves!.H2.net).toBeLessThan(0);
  });
});

describe('replay: v3-B reproduces the validated backtest on stored 240-day data', () => {
  it('17 trades, 8 wins, net +$72.42 ± $0.05, PF 1.75 ± 0.05', () => {
    const result = runBacktest({ variant: 'v3b', data: data4h });
    const m = result.metrics;
    expect(m.trades).toBe(17);
    expect(m.wins).toBe(8);
    expect(m.netPnl).toBeCloseTo(72.42, 1); // ±$0.05
    expect(Math.abs(m.netPnl - 72.42)).toBeLessThanOrEqual(0.05);
    expect(m.profitFactor).toBeCloseTo(1.75, 1);
    expect(Math.abs(m.profitFactor - 1.75)).toBeLessThanOrEqual(0.05);
    expect(m.winRate).toBeCloseTo(47.06, 1);
    expect(m.maxDrawdownPct).toBeCloseTo(-1.25, 1);
    expect(m.worstDay![1]).toBeCloseTo(-26.57, 1);
    expect(m.halves.H1.net).toBeCloseTo(47.08, 1);
    expect(m.halves.H2.net).toBeCloseTo(25.35, 1);
    expect(m.tpExits).toBe(5);
    expect(m.slExits).toBe(7);
    expect(m.timeExits).toBe(4);
    expect(m.haltExits).toBe(1);
    expect(result.criteria.allPass).toBe(true);
    expect(result.criteria.validated).toBe(true);
    expect(result.diagnostics.rawSetups).toBe(19);
    expect(result.diagnostics.costFilterSkips).toBe(2);
  }, 60000);

  it('criteria check passes all 5 pre-registered bars for v3-B', () => {
    const result = runBacktest({ variant: 'v3b', data: data4h });
    expect(result.criteria.checks.map((c) => c.pass)).toEqual([true, true, true, true, true]);
  }, 60000);

  it('chronological train/test split sums back to the full run', () => {
    const result = runBacktest({ variant: 'v3b', data: data4h, trainRatio: 0.5 });
    expect(result.split).not.toBeNull();
    expect(result.split!.train.trades + result.split!.test.trades).toBe(17);
    expect(result.split!.train.netPnl + result.split!.test.netPnl).toBeCloseTo(72.42, 1);
  }, 60000);
});

describe('replay: failed variants reproduce their stored (losing) results', () => {
  it('v3-A: 16 trades, net -$28.41 ± $0.05', () => {
    const result = runBacktest({ variant: 'v3a', data: data4h });
    expect(result.metrics.trades).toBe(16);
    expect(Math.abs(result.metrics.netPnl - -28.41)).toBeLessThanOrEqual(0.05);
    expect(result.metrics.wins).toBe(4);
    expect(result.criteria.validated).toBe(false);
    expect(result.criteria.allPass).toBe(false);
  }, 60000);

  it('v3-C: 50 trades, net +$9.12 ± $0.5, fails criteria (H2 negative, worst day < -$30)', () => {
    const result = runBacktest({ variant: 'v3c', data: data4h });
    expect(result.metrics.trades).toBe(50);
    expect(Math.abs(result.metrics.netPnl - 9.12)).toBeLessThanOrEqual(0.5);
    expect(result.metrics.wins).toBe(16);
    expect(result.metrics.halves.H2.net).toBeLessThan(0);
    expect(result.metrics.worstDay![1]).toBeLessThan(-30);
    expect(result.criteria.allPass).toBe(false);
  }, 60000);

  it('v2 (r15 primary): 28 trades, net -$141.25 ± $0.05, 14.3% win rate', () => {
    const result = runBacktest({ variant: 'v2', data: data4h });
    expect(result.metrics.trades).toBe(28);
    expect(Math.abs(result.metrics.netPnl - -141.25)).toBeLessThanOrEqual(0.05);
    expect(result.metrics.wins).toBe(4);
    expect(result.metrics.worstDay![1]).toBeCloseTo(-35.01, 1);
    expect(result.criteria.allPass).toBe(false);
  }, 60000);
});

describe('v1.0 dual-timeframe replay (1h entries, 4h trend)', () => {
  it('runs over the stored 120-day 1h data and loses money, as documented', () => {
    const data1h = {
      BTCUSDT: loadCsvCandles('BTCUSDT', '1h'),
      ETHUSDT: loadCsvCandles('ETHUSDT', '1h'),
      SOLUSDT: loadCsvCandles('SOLUSDT', '1h'),
      PAXGUSDT: loadCsvCandles('PAXGUSDT', '1h'),
    };
    const result = runBacktest({ variant: 'v1', data: data1h, data4h });
    // Stored v1.0: 158 trades, net -$826.17 (RESULTS-v1.md). The
    // original v1 engine file was overwritten by v2.0, so this port
    // is from STRATEGY-v1.md; expect a close reproduction, not a
    // bit-exact one — the verdict (large loss) must match. Measured
    // reproduction: 162 trades, net -$710.17, win rate 29.0%; the
    // worst day reproduces exactly (-$69.15 on 2026-08-16).
    expect(result.metrics.trades).toBeGreaterThan(100);
    expect(result.metrics.netPnl).toBeLessThan(-500);
    expect(result.metrics.winRate).toBeLessThan(40);
    expect(result.metrics.worstDay![0]).toBe('2026-08-16');
    expect(Math.abs(result.metrics.worstDay![1] - -69.15)).toBeLessThanOrEqual(0.05);
    expect(result.criteria.validated).toBe(false);
    expect(result.stored.trades).toBe(158);
    expect(result.stored.netPnl).toBeCloseTo(-826.17, 2);
  }, 120000);
});
