import { describe, expect, it } from 'vitest';
import {
  auditPaper,
  createPaperState,
  paperTotals,
  processCandles,
  statusLine,
} from '../paper.js';
import { loadCsvCandles } from './loadCsv.js';

const data4h = {
  BTCUSDT: loadCsvCandles('BTCUSDT', '4h'),
  SOLUSDT: loadCsvCandles('SOLUSDT', '4h'),
};

describe('paper replay: reproduces the validated v3-B backtest (test_paper_replay.py)', () => {
  it('17 entries, 17 exits, 8 wins, net +$72.42 ± $0.10, exits TP 5 / SL 7 / TIME 4 / HALT 1', () => {
    const state = createPaperState('2026-11-19T00:00:00Z');
    // Seed lastProcessed before the data start so the whole window replays.
    state.lastProcessed = {
      BTCUSDT: '2026-03-24T12:00:00Z',
      SOLUSDT: '2026-03-24T12:00:00Z',
    };
    const { events, summary } = processCandles(state, data4h);
    const entries = events.filter((e) => e.type === 'ENTRY');
    const exits = events.filter((e) => e.type === 'EXIT');
    const totals = paperTotals(events);
    expect(entries.length).toBe(17);
    expect(exits.length).toBe(17);
    expect(totals.wins).toBe(8);
    expect(Math.abs(totals.net - 72.42)).toBeLessThanOrEqual(0.1);
    expect(exits.filter((e) => e.exitReason === 'TP').length).toBe(5);
    expect(exits.filter((e) => e.exitReason === 'SL').length).toBe(7);
    expect(exits.filter((e) => e.exitReason === 'TIME').length).toBe(4);
    expect(exits.filter((e) => e.exitReason === 'HALT').length).toBe(1);
    expect(summary.entries).toBe(17);
    expect(summary.exits).toBe(17);
    expect(summary.halts).toBe(1);
    // Rejects: 2x COST_FILTER + 1x DAILY_ENTRY_CAP (per PHASE2.md §3)
    const rejects = events.filter((e) => e.type === 'SIGNAL_REJECT');
    expect(rejects.filter((e) => e.reason.includes('COST_FILTER')).length).toBe(2);
    expect(rejects.filter((e) => e.reason.includes('DAILY_ENTRY_CAP')).length).toBe(1);
    expect(state.openPositions.length).toBe(0);
  }, 60000);

  it('is idempotent: a second run over the same candles emits no new events', () => {
    const state = createPaperState('2026-11-19T00:00:00Z');
    state.lastProcessed = {
      BTCUSDT: '2026-03-24T12:00:00Z',
      SOLUSDT: '2026-03-24T12:00:00Z',
    };
    const first = processCandles(state, data4h);
    const before = first.events.length;
    const second = processCandles(state, data4h);
    expect(second.summary.newCandles).toBe(0);
    expect(second.events.length).toBe(0);
    expect(first.events.length).toBe(before);
  }, 60000);

  it('audit is clean on the replay log (zero rule violations)', () => {
    const state = createPaperState('2026-11-19T00:00:00Z');
    state.lastProcessed = {
      BTCUSDT: '2026-03-24T12:00:00Z',
      SOLUSDT: '2026-03-24T12:00:00Z',
    };
    const { events } = processCandles(state, data4h);
    expect(auditPaper(events)).toEqual([]);
  }, 60000);
});

describe('paper state machine: first run starts clean', () => {
  it('a fresh state only evaluates the most recent closed candle (no backfill)', () => {
    const state = createPaperState('2026-11-19T00:00:00Z');
    const { summary } = processCandles(state, data4h);
    expect(summary.newCandles).toBe(1);
    expect(summary.entries).toBe(0); // no setup on the last candle (zero Nov trades)
    expect(state.lastProcessed.BTCUSDT).toBeDefined();
  }, 60000);

  it('dryRun does not mutate state', () => {
    const state = createPaperState('2026-11-19T00:00:00Z');
    state.lastProcessed = {
      BTCUSDT: '2026-03-24T12:00:00Z',
      SOLUSDT: '2026-03-24T12:00:00Z',
    };
    const snapshot = JSON.stringify(state);
    const { events } = processCandles(state, data4h, { dryRun: true });
    expect(events.filter((e) => e.type === 'ENTRY').length).toBe(17);
    expect(JSON.stringify(state)).toBe(snapshot);
  }, 60000);
});

describe('paper audit', () => {
  it('flags >2 entries in a day', () => {
    const events = [
      { type: 'ENTRY', candleTime: '2026-11-19T00:00:00Z', tradeId: 'A', symbol: 'BTCUSDT', side: 'long', entryTime: '', entry: 1, exitTime: '', exit: '', exitReason: '', sl: 1, tp: 1, size: 1, riskUsd: 15, pnl: '', fees: '', barsHeld: 0, reason: '' },
      { type: 'ENTRY', candleTime: '2026-11-19T04:00:00Z', tradeId: 'B', symbol: 'BTCUSDT', side: 'long', entryTime: '', entry: 1, exitTime: '', exit: '', exitReason: '', sl: 1, tp: 1, size: 1, riskUsd: 15, pnl: '', fees: '', barsHeld: 0, reason: '' },
      { type: 'ENTRY', candleTime: '2026-11-19T08:00:00Z', tradeId: 'C', symbol: 'BTCUSDT', side: 'long', entryTime: '', entry: 1, exitTime: '', exit: '', exitReason: '', sl: 1, tp: 1, size: 1, riskUsd: 15, pnl: '', fees: '', barsHeld: 0, reason: '' },
    ] as never;
    const violations = auditPaper(events);
    expect(violations.some((v) => v.includes('3 entries'))).toBe(true);
  });

  it('flags a day worse than -$30', () => {
    const events = [
      { type: 'EXIT', candleTime: '2026-11-19T08:00:00Z', tradeId: 'A', symbol: 'BTCUSDT', side: 'long', entryTime: '', entry: 1, exitTime: '2026-11-19T08:00:00Z', exit: 1, exitReason: 'SL', sl: 1, tp: 1, size: 1, riskUsd: 15, pnl: -35, fees: 1, barsHeld: 3, reason: '' },
    ] as never;
    const violations = auditPaper(events);
    expect(violations.some((v) => v.includes('breached $-30'))).toBe(true);
  });

  it('returns no violations for an empty log', () => {
    expect(auditPaper([])).toEqual([]);
  });
});

describe('paper status line', () => {
  it('matches the paper_trade.py one-line shape', () => {
    const state = createPaperState('2026-11-19T00:00:00Z');
    state.lastProcessed = {
      BTCUSDT: '2026-03-24T12:00:00Z',
      SOLUSDT: '2026-03-24T12:00:00Z',
    };
    const { events } = processCandles(state, data4h);
    const line = statusLine(state, events, '2026-11-19');
    expect(line).toContain('PAPER v3-B');
    expect(line).toContain('open: none');
    expect(line).toContain('halt: NO');
    expect(line).toContain('17 trades');
  }, 60000);
});
