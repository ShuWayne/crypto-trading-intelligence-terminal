/**
 * Risk-engine tests — TypeScript port of test_risk_engine.py
 * (37 checks in the Python file; this suite ports every one and adds
 * boundary-value checks, for 40+ assertions). Same numbers, same
 * reason codes, same constants as risk_engine.py.
 */
import { describe, expect, it } from 'vitest';
import {
  BE_TRIGGER_R,
  COST_FILTER_MAX,
  DAILY_HALT_USD,
  FEE,
  MAX_CONCURRENT,
  MAX_LOSSES_PER_DAY,
  MAX_TRADES_PER_DAY,
  NOTIONAL_CAP,
  ROUND_TRIP_COST,
  RISK_PER_TRADE,
  breakevenSl,
  checkEntry,
  computeTrade,
  costFilterOk,
  dayTotalPnl,
  emptyDayState,
  realizedPnl,
  roundTripCostUsd,
  shouldHalt,
  unrealizedPnl,
  type DayState,
  type Position,
  type ProposedTrade,
} from '../risk.js';

function freshDay(over: Partial<DayState> = {}): DayState {
  return { ...emptyDayState('2026-11-19'), ...over };
}

function prop(
  symbol = 'BTCUSDT',
  entry = 60000,
  side: 'long' | 'short' = 'long',
  atr = 900,
): ProposedTrade {
  const t = computeTrade(entry, side, atr);
  if (t === null) throw new Error('test fixture computeTrade returned null');
  return { ...t, symbol };
}

function openPos(
  symbol = 'BTCUSDT',
  side: 'long' | 'short' = 'long',
  entry = 60000,
  size = 0.01,
): Position {
  return {
    symbol,
    side,
    entry,
    sl: side === 'long' ? entry - 1350 : entry + 1350,
    slOrig: side === 'long' ? entry - 1350 : entry + 1350,
    tp: side === 'long' ? entry + 2700 : entry - 2700,
    size,
    riskDist: 1350,
    riskUsd: 15,
    beMoved: false,
  };
}

describe('position math: SL/TP distances, size, R:R', () => {
  it('long SL = entry - 1.5xATR', () => {
    expect(prop('BTCUSDT', 60000, 'long', 900).sl).toBeCloseTo(58650, 9);
  });
  it('long TP = entry + 3.0xATR', () => {
    expect(prop('BTCUSDT', 60000, 'long', 900).tp).toBeCloseTo(62700, 9);
  });
  it('size = risk / 1.5xATR', () => {
    expect(prop('BTCUSDT', 60000, 'long', 900).size).toBeCloseTo(15 / 1350, 12);
  });
  it('R:R is 1:2', () => {
    const t = prop('BTCUSDT', 60000, 'long', 900);
    expect((t.tp - t.entry) / (t.entry - t.sl)).toBeCloseTo(2, 9);
  });
  it('notional = size * entry', () => {
    const t = prop('BTCUSDT', 60000, 'long', 900);
    expect(t.notional).toBeCloseTo(t.size * 60000, 6);
  });
  it('short SL = entry + 1.5xATR', () => {
    expect(prop('BTCUSDT', 60000, 'short', 900).sl).toBeCloseTo(61350, 9);
  });
  it('short TP = entry - 3.0xATR', () => {
    expect(prop('BTCUSDT', 60000, 'short', 900).tp).toBeCloseTo(57300, 9);
  });
  it('invalid atr -> null', () => {
    expect(computeTrade(60000, 'long', 0)).toBeNull();
  });
  it('invalid entry -> null', () => {
    expect(computeTrade(-5, 'long', 900)).toBeNull();
  });
  it('invalid side -> null', () => {
    // @ts-expect-error testing a bad side at runtime
    expect(computeTrade(60000, 'up', 900)).toBeNull();
  });
  it('zero risk -> null', () => {
    expect(computeTrade(60000, 'long', 900, 0)).toBeNull();
  });
});

describe('cost filter: 0.3% round-trip must be <= 25% of $15 = $3.75', () => {
  it('cost filter boundary passes (notional 1250 -> cost exactly $3.75)', () => {
    expect(costFilterOk(1250)).toBe(true);
    expect(roundTripCostUsd(1250)).toBeCloseTo(3.75, 9);
    expect(ROUND_TRIP_COST).toBeCloseTo(0.003, 12);
    expect(COST_FILTER_MAX * RISK_PER_TRADE).toBeCloseTo(3.75, 9);
  });
  it('cost filter just above boundary fails (1250.01)', () => {
    expect(costFilterOk(1250.01)).toBe(false);
  });
  it('cost filter above boundary fails (1251)', () => {
    expect(costFilterOk(1251)).toBe(false);
  });
  it('v1.0 blowup notional rejected (12302 -> cost ~$36.91)', () => {
    expect(costFilterOk(12302)).toBe(false);
    expect(roundTripCostUsd(12302)).toBeCloseTo(36.906, 2);
  });
  it('notional cap 2000 enforced in checklist (tiny ATR -> huge notional)', () => {
    expect(prop('BTCUSDT', 60000, 'long', 100).notional).toBeGreaterThan(2000);
  });
});

describe('checklist happy path', () => {
  it('happy path allowed with no reasons', () => {
    const { allowed, reasons } = checkEntry(freshDay(), prop(), []);
    expect(allowed).toBe(true);
    expect(reasons).toEqual([]);
  });
});

describe('each rule rejects with the right reason', () => {
  it('halted day rejected (HALTED_DAY)', () => {
    const { allowed, reasons } = checkEntry(freshDay({ halted: true }), prop(), []);
    expect(allowed).toBe(false);
    expect(reasons).toContain('HALTED_DAY');
  });
  it('daily entry cap rejected at 2 entries (DAILY_ENTRY_CAP)', () => {
    const { allowed, reasons } = checkEntry(freshDay({ entriesToday: 2 }), prop(), []);
    expect(allowed).toBe(false);
    expect(reasons).toContain('DAILY_ENTRY_CAP');
  });
  it('1 entry today still allowed (boundary)', () => {
    expect(checkEntry(freshDay({ entriesToday: 1 }), prop(), []).allowed).toBe(true);
  });
  it('2-loss anti-revenge rejected (LOSS_STOP_2)', () => {
    const { allowed, reasons } = checkEntry(freshDay({ lossesToday: 2 }), prop(), []);
    expect(allowed).toBe(false);
    expect(reasons).toContain('LOSS_STOP_2');
  });
  it('1 loss today still allowed (boundary)', () => {
    expect(checkEntry(freshDay({ lossesToday: 1 }), prop(), []).allowed).toBe(true);
    expect(MAX_LOSSES_PER_DAY).toBe(2);
  });
  it('realized -20 stops day (DAILY_REALIZED_LOSS)', () => {
    const { allowed, reasons } = checkEntry(freshDay({ realizedToday: -20 }), prop(), []);
    expect(allowed).toBe(false);
    expect(reasons).toContain('DAILY_REALIZED_LOSS');
  });
  it('realized -19.99 still allowed (boundary)', () => {
    expect(checkEntry(freshDay({ realizedToday: -19.99 }), prop(), []).allowed).toBe(true);
  });
  it('concurrent cap rejected at 2 open (CONCURRENT_CAP)', () => {
    const { allowed, reasons } = checkEntry(freshDay(), prop(), [
      openPos('BTCUSDT'),
      openPos('SOLUSDT', 'short', 150, 0.1),
    ]);
    expect(allowed).toBe(false);
    expect(reasons).toContain('CONCURRENT_CAP');
    expect(MAX_CONCURRENT).toBe(2);
  });
  it('same symbol open rejected (SYMBOL_ALREADY_OPEN)', () => {
    const { allowed, reasons } = checkEntry(freshDay(), prop('BTCUSDT'), [openPos('BTCUSDT')]);
    expect(allowed).toBe(false);
    expect(reasons).toContain('SYMBOL_ALREADY_OPEN');
  });
  it('different symbol open is fine', () => {
    expect(checkEntry(freshDay(), prop('SOLUSDT'), [openPos('BTCUSDT')]).allowed).toBe(true);
  });
  it('cost filter rejected in checklist (COST_FILTER + NOTIONAL_CAP together)', () => {
    const big = prop('BTCUSDT', 60000, 'long', 100); // size 0.1, notional 6000, cost $18
    const { allowed, reasons } = checkEntry(freshDay(), big, []);
    expect(allowed).toBe(false);
    expect(reasons).toContain('COST_FILTER');
    expect(reasons).toContain('NOTIONAL_CAP');
  });
  it('notional cap constant is 2000', () => {
    expect(NOTIONAL_CAP).toBe(2000);
  });
  it('multiple violations accumulate all reason codes', () => {
    const { allowed, reasons } = checkEntry(
      freshDay({ halted: true, entriesToday: 2 }),
      prop('BTCUSDT', 60000, 'long', 100),
      [openPos('BTCUSDT'), openPos('SOLUSDT', 'short', 150, 0.1)],
    );
    expect(allowed).toBe(false);
    for (const r of ['HALTED_DAY', 'DAILY_ENTRY_CAP', 'CONCURRENT_CAP', 'SYMBOL_ALREADY_OPEN', 'COST_FILTER', 'NOTIONAL_CAP'] as const) {
      expect(reasons).toContain(r);
    }
  });
});

describe('halt math (counts open positions)', () => {
  it('unrealized long: 0.01 BTC @60000 marked 59000 -> -10.59', () => {
    expect(unrealizedPnl(openPos('BTCUSDT', 'long', 60000, 0.01), 59000)).toBeCloseTo(-10.59, 9);
  });
  it('unrealized short: 0.1 SOL @150 marked 160 -> -1.016', () => {
    expect(unrealizedPnl(openPos('SOLUSDT', 'short', 150, 0.1), 160)).toBeCloseTo(-1.016, 9);
  });
  it('halt fires at realized+unreal <= -20', () => {
    const { halt, total } = shouldHalt(-12, [openPos('BTCUSDT', 'long', 60000, 0.01)], { BTCUSDT: 59000 });
    expect(halt).toBe(true);
    expect(total).toBeCloseTo(-22.59, 9);
  });
  it('no halt at -19.x', () => {
    const { halt, total } = shouldHalt(-12, [openPos('BTCUSDT', 'long', 60000, 0.01)], { BTCUSDT: 59500 });
    expect(halt).toBe(false);
    expect(total).toBeCloseTo(-17.595, 9);
  });
  it('halt fires exactly at -20.00 (boundary)', () => {
    const { halt, total } = shouldHalt(-9.41, [openPos('BTCUSDT', 'long', 60000, 0.01)], { BTCUSDT: 59000 });
    expect(total).toBeCloseTo(-20, 9);
    expect(halt).toBe(true);
    expect(DAILY_HALT_USD).toBe(-20);
  });
  it('dayTotalPnl sums realized + unrealized across symbols', () => {
    const total = dayTotalPnl(-5, [openPos('BTCUSDT', 'long', 60000, 0.01), openPos('SOLUSDT', 'short', 150, 0.1)], {
      BTCUSDT: 59000,
      SOLUSDT: 160,
    });
    expect(total).toBeCloseTo(-5 - 10.59 - 1.016, 9);
  });
});

describe('realized P&L', () => {
  it('TP gross/fees/net for a long', () => {
    const { gross, fees, net } = realizedPnl(openPos('BTCUSDT', 'long', 60000, 0.01), 62700);
    expect(gross).toBeCloseTo(27, 9);
    expect(fees).toBeCloseTo(0.6 + 0.627, 9);
    expect(net).toBeCloseTo(27 - 1.227, 9);
    expect(FEE).toBe(0.001);
  });
  it('SL net for a short', () => {
    const { gross, net } = realizedPnl(openPos('SOLUSDT', 'short', 150, 0.1), 152.25);
    expect(gross).toBeCloseTo(-0.225, 9);
    expect(net).toBeCloseTo(-0.225 - (0.015 + 0.015225), 9);
  });
});

describe('breakeven SL move', () => {
  const posBe = { ...openPos('BTCUSDT', 'long', 60000, 0.01), riskDist: 1350, beMoved: false };
  it('BE not triggered below +1R', () => {
    expect(breakevenSl(posBe, 61300)).toBeNull();
  });
  it('BE triggers exactly at +1R (61350)', () => {
    expect(breakevenSl(posBe, 61350)).toBe(60000);
    expect(BE_TRIGGER_R).toBe(1);
  });
  it('BE never moves twice', () => {
    expect(breakevenSl({ ...posBe, beMoved: true }, 63000)).toBeNull();
  });
  it('BE triggers for short at +1R (147.75)', () => {
    const posS = { ...openPos('SOLUSDT', 'short', 150, 0.1), riskDist: 2.25, beMoved: false };
    expect(breakevenSl(posS, 147.75)).toBe(150);
  });
  it('BE not triggered for short above +1R trigger', () => {
    const posS = { ...openPos('SOLUSDT', 'short', 150, 0.1), riskDist: 2.25, beMoved: false };
    expect(breakevenSl(posS, 148)).toBeNull();
  });
});

describe('NO absolute-cap projection (deliberate — PHASE2.md §1/§5)', () => {
  it('day at -13 still allows entry (no projection rule)', () => {
    const small = prop('BTCUSDT', 60000, 'long', 900); // notional 666.7, cost $2.00
    const { allowed, reasons } = checkEntry(freshDay({ realizedToday: -13 }), small, [], {});
    expect(allowed).toBe(true);
    expect(reasons).toEqual([]);
  });
  it('day at -10 allows entry', () => {
    const small = prop('BTCUSDT', 60000, 'long', 900);
    expect(checkEntry(freshDay({ realizedToday: -10 }), small, [], {}).allowed).toBe(true);
  });
  it('halt threshold blocks new entry when marks put the day at/below -20', () => {
    // Proposed trade is a different symbol (SOL) so the only blocker is HALT_THRESHOLD.
    const small = prop('SOLUSDT', 150, 'long', 2.25); // notional ~$667, cost $2.00
    const { allowed, reasons } = checkEntry(
      freshDay({ realizedToday: -12 }),
      small,
      [openPos('BTCUSDT', 'long', 60000, 0.01)],
      { BTCUSDT: 59000 },
    );
    expect(allowed).toBe(false);
    expect(reasons).toContain('HALT_THRESHOLD');
  });
  it('halt threshold does not fire when marks keep the day above -20', () => {
    const small = prop('SOLUSDT', 150, 'long', 2.25);
    const { allowed } = checkEntry(
      freshDay({ realizedToday: -12 }),
      small,
      [openPos('BTCUSDT', 'long', 60000, 0.01)],
      { BTCUSDT: 59500 },
    );
    expect(allowed).toBe(true);
  });
});

describe('invalid proposed trade', () => {
  it('null proposed rejected with exactly [INVALID_TRADE]', () => {
    const { allowed, reasons } = checkEntry(freshDay(), null, []);
    expect(allowed).toBe(false);
    expect(reasons).toEqual(['INVALID_TRADE']);
  });
});

describe('constants', () => {
  it('match risk_engine.py exactly', () => {
    expect(RISK_PER_TRADE).toBe(15);
    expect(MAX_TRADES_PER_DAY).toBe(2);
    expect(MAX_CONCURRENT).toBe(2);
    expect(DAILY_HALT_USD).toBe(-20);
    expect(MAX_LOSSES_PER_DAY).toBe(2);
  });
});
