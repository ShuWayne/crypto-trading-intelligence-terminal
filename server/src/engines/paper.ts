/**
 * Paper-trading state machine — TypeScript port of the `paper_trade.py`
 * harness behavior (~/workspace/trading/binance-system/, Phase 2).
 *
 * *** THIS MODULE CANNOT TRADE. *** There is no order code anywhere in
 * this file: no API client, no sign-in, no keys, no buy/sell calls.
 * It only evaluates CLOSED 4h candles that the caller passes in,
 * maintains paper positions in plain state, and emits ENTRY / EXIT /
 * SIGNAL_REJECT events. A "trade" here is a row in an event log, never
 * an order. (Same statement as paper_trade.py: "There is NO order code
 * anywhere in this file. It cannot trade.")
 *
 * Behavior ported from paper_trade.py:
 * - v3-B signal only (BTCUSDT + SOLUSDT), via the same `detectSetup`
 *   used by the backtest, so signal logic cannot drift.
 * - Per newly closed 4h candle, in order: (1) manage open positions
 *   (SL -> TP -> breakeven move at +1R -> 96h TIME exit; SL checked
 *   before TP within a candle), (2) daily halt check at the close
 *   (realized + unrealized <= -$20 closes ALL positions, HALT),
 *   (3) new entries via the risk-engine checklist (`checkEntry`).
 * - No re-entry in a symbol on the candle it closed a position.
 * - Idempotent: a candle is processed once (`lastProcessed` per
 *   symbol in the state); re-processing the same candles emits no
 *   new events. Trade IDs are unique per symbol + entry candle.
 * - First run starts clean: if a symbol has no `lastProcessed`
 *   entry, it is seeded to the SECOND-newest closed candle, so only
 *   the most recent closed candle is evaluated (older candles are
 *   indicator history only). Positions that would have opened before
 *   the harness started are NOT reconstructed. (For a full-window
 *   replay, seed `lastProcessed` to before the data start — see the
 *   replay test.)
 * - SL/TP are measured from the RAW confirmation close and the entry
 *   is the slippage-adjusted fill — exactly the backtest convention.
 * - `dryRun`: evaluates against a deep clone and returns the events
 *   without mutating the caller's state.
 *
 * Two deliberate deviations from paper_trade.py, both documented:
 * 1. When a day is blocked, paper_trade.py `continue`s the candle
 *    loop BEFORE updating `lastProcessed`, so the candle stays "new"
 *    and is re-evaluated on the next run. This port marks the candle
 *    processed (it was evaluated; the day was simply blocked), which
 *    preserves idempotency across runs. Within a single run the
 *    results are identical.
 * 2. `barsHeld` is the candle-index difference (entry candle to exit
 *    candle), which equals paper_trade.py's elapsed-hours / 4h
 *    computation on gap-free 4h data.
 */

import { computeIndicators, type Candle, type IndicatorSet } from '../ta/indicators.js';
import {
  BE_TRIGGER_R,
  DAILY_HALT_USD,
  DAILY_LOSS_CAP_USD,
  MAX_HOLD_BARS,
  MAX_LOSSES_PER_DAY,
  MAX_TRADES_PER_DAY,
  SLIPPAGE,
  checkEntry,
  computeTrade,
  realizedPnl,
  shouldHalt,
  type DayState,
  type Position,
} from './risk.js';
import { detectSetup, volGuardOk, WARMUP_CANDLES } from './signal.js';

export const PAPER_SYMBOLS = ['BTCUSDT', 'SOLUSDT'] as const;

export interface PaperPosition extends Position {
  entryTime: string; // ISO, entry candle open time
  entryIndex: number; // index into the symbol's candle array
  tradeId: string;
}

export interface PaperState {
  openPositions: PaperPosition[];
  entriesByDay: Record<string, number>;
  lossesByDay: Record<string, number>;
  pnlByDay: Record<string, number>;
  haltedDays: string[];
  /** Last processed candle open time (ISO) per symbol. */
  lastProcessed: Record<string, string>;
  startedUtc: string;
}

export function createPaperState(startedUtc?: string): PaperState {
  return {
    openPositions: [],
    entriesByDay: {},
    lossesByDay: {},
    pnlByDay: {},
    haltedDays: [],
    lastProcessed: {},
    startedUtc: startedUtc ?? new Date().toISOString(),
  };
}

export type PaperEventType = 'ENTRY' | 'EXIT' | 'SIGNAL_REJECT';

export interface PaperEvent {
  type: PaperEventType;
  candleTime: string; // ISO, candle open time
  tradeId: string;
  symbol: string;
  side: 'long' | 'short' | '';
  entryTime: string;
  entry: number | '';
  exitTime: string;
  exit: number | '';
  exitReason: 'SL' | 'TP' | 'TIME' | 'HALT' | '';
  sl: number | '';
  tp: number | '';
  size: number | '';
  riskUsd: number | '';
  pnl: number | '';
  fees: number | '';
  barsHeld: number | '';
  /** Human-readable detail: for rejects, the reason code(s). */
  reason: string;
}

export interface PaperSummary {
  newCandles: number;
  entries: number;
  exits: number;
  rejects: number;
  halts: number;
}

export interface PaperProcessResult {
  state: PaperState;
  events: PaperEvent[];
  summary: PaperSummary;
}

export function tradeId(symbol: string, entryCandleTimeMs: number): string {
  const d = new Date(entryCandleTimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${symbol}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`
  );
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function cloneState(state: PaperState): PaperState {
  return JSON.parse(JSON.stringify(state)) as PaperState;
}

function dayStateFrom(state: PaperState, day: string): DayState {
  return {
    date: day,
    entriesToday: state.entriesByDay[day] ?? 0,
    lossesToday: state.lossesByDay[day] ?? 0,
    realizedToday: state.pnlByDay[day] ?? 0,
    halted: state.haltedDays.includes(day),
  };
}

function dayBlocked(dayState: DayState): boolean {
  if (dayState.halted) return true;
  if (dayState.entriesToday >= MAX_TRADES_PER_DAY) return true;
  if (dayState.lossesToday >= MAX_LOSSES_PER_DAY) return true;
  if (dayState.realizedToday <= DAILY_HALT_USD) return true;
  return false;
}

/**
 * Process every newly closed 4h candle in `data` (per symbol), in
 * chronological order, updating `state` and returning the events.
 * `data` keys must be a subset of the paper symbols; symbols missing
 * from `data` are skipped. Candles must be sorted by time, closed
 * only. Pure except for the state object it is given (cloned first
 * when `dryRun` is set).
 */
export function processCandles(
  state: PaperState,
  data: Record<string, Candle[]>,
  opts?: { dryRun?: boolean },
): PaperProcessResult {
  const working = opts?.dryRun === true ? cloneState(state) : state;
  const events: PaperEvent[] = [];
  const summary: PaperSummary = { newCandles: 0, entries: 0, exits: 0, rejects: 0, halts: 0 };
  const symbols = Object.keys(data).filter((s) => data[s].length > 0);
  if (symbols.length === 0) return { state: working, events, summary };

  const indBySymbol = new Map<string, IndicatorSet>();
  for (const s of symbols) indBySymbol.set(s, computeIndicators(data[s]));

  // First run per symbol: start clean — evaluate only the most recent
  // closed candle (older candles are indicator history only).
  for (const s of symbols) {
    if (working.lastProcessed[s] === undefined) {
      const candles = data[s];
      const seedIdx = Math.max(0, candles.length - 2); // 2nd newest closed
      working.lastProcessed[s] = new Date(candles[seedIdx].time).toISOString();
    }
  }

  // Combined timeline of closed candles, cut to the new ones.
  const allTimes = [...new Set(symbols.flatMap((s) => data[s].map((c) => c.time)))].sort((a, b) => a - b);
  const newTimes = allTimes.filter((t) =>
    symbols.some((s) => new Date(t).toISOString() > (working.lastProcessed[s] ?? '')),
  );
  if (newTimes.length === 0) return { state: working, events, summary };
  summary.newCandles = newTimes.length;

  const closePosition = (
    pos: PaperPosition,
    candleTimeMs: number,
    exitPrice: number,
    exitReason: 'SL' | 'TP' | 'TIME' | 'HALT',
    barsHeld: number,
  ): void => {
    const { gross, fees, net } = realizedPnl(pos, exitPrice);
    const day = utcDate(candleTimeMs);
    working.pnlByDay[day] = (working.pnlByDay[day] ?? 0) + net;
    if (net < 0) working.lossesByDay[day] = (working.lossesByDay[day] ?? 0) + 1;
    working.openPositions = working.openPositions.filter((p) => p.tradeId !== pos.tradeId);
    events.push({
      type: 'EXIT',
      candleTime: new Date(candleTimeMs).toISOString(),
      tradeId: pos.tradeId,
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      entry: pos.entry,
      exitTime: new Date(candleTimeMs).toISOString(),
      exit: exitPrice,
      exitReason,
      sl: pos.slOrig,
      tp: pos.tp,
      size: pos.size,
      riskUsd: pos.riskUsd,
      pnl: Math.round(net * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      barsHeld,
      reason: `gross $${gross.toFixed(2)}`,
    });
    summary.exits += 1;
  };

  for (const t of newTimes) {
    const day = utcDate(t);
    const closedThisCandle = new Set<string>();
    // --- 1. manage open positions on this candle (SL / TP / BE / TIME) ---
    for (const pos of [...working.openPositions]) {
      const candles = data[pos.symbol];
      if (!candles) continue;
      const i = candles.findIndex((c) => c.time === t);
      if (i < 0) continue;
      const row = candles[i];
      let exitPrice: number | null = null;
      let exitReason: 'SL' | 'TP' | 'TIME' | null = null;
      if (pos.side === 'long') {
        if (row.low <= pos.sl) {
          exitPrice = pos.sl * (1 - SLIPPAGE);
          exitReason = 'SL';
        } else if (row.high >= pos.tp) {
          exitPrice = pos.tp * (1 - SLIPPAGE);
          exitReason = 'TP';
        } else if (row.high >= pos.entry + BE_TRIGGER_R * pos.riskDist && !pos.beMoved) {
          pos.sl = pos.entry;
          pos.beMoved = true;
        }
      } else {
        if (row.high >= pos.sl) {
          exitPrice = pos.sl * (1 + SLIPPAGE);
          exitReason = 'SL';
        } else if (row.low <= pos.tp) {
          exitPrice = pos.tp * (1 + SLIPPAGE);
          exitReason = 'TP';
        } else if (row.low <= pos.entry - BE_TRIGGER_R * pos.riskDist && !pos.beMoved) {
          pos.sl = pos.entry;
          pos.beMoved = true;
        }
      }
      const barsHeld = i - pos.entryIndex;
      if (exitPrice === null && barsHeld >= MAX_HOLD_BARS) {
        exitPrice = pos.side === 'long' ? row.close * (1 - SLIPPAGE) : row.close * (1 + SLIPPAGE);
        exitReason = 'TIME';
      }
      if (exitPrice !== null && exitReason !== null) {
        closePosition(pos, t, exitPrice, exitReason, barsHeld);
        closedThisCandle.add(pos.symbol);
      }
    }
    // --- 2. daily loss halt at this candle's close ---
    if (working.openPositions.length > 0 && !working.haltedDays.includes(day)) {
      const marks: Record<string, number> = {};
      for (const pos of working.openPositions) {
        const candles = data[pos.symbol];
        const match = candles?.find((c) => c.time === t);
        if (match) marks[pos.symbol] = match.close;
      }
      const realized = working.pnlByDay[day] ?? 0;
      const { halt } = shouldHalt(realized, working.openPositions, marks);
      if (halt) {
        working.haltedDays.push(day);
        summary.halts += 1;
        for (const pos of [...working.openPositions]) {
          const candles = data[pos.symbol];
          const i = candles?.findIndex((c) => c.time === t) ?? -1;
          if (!candles || i < 0) continue;
          const row = candles[i];
          const px = pos.side === 'long' ? row.close * (1 - SLIPPAGE) : row.close * (1 + SLIPPAGE);
          closePosition(pos, t, px, 'HALT', i - pos.entryIndex);
          closedThisCandle.add(pos.symbol);
        }
      }
    }
    // --- 3. evaluate new entries on this candle ---
    const dayState = dayStateFrom(working, day);
    if (!dayBlocked(dayState)) {
      for (const s of symbols) {
        if (working.openPositions.some((p) => p.symbol === s)) continue;
        if (closedThisCandle.has(s)) continue; // no re-entry on the close candle
        const candles = data[s];
        const i = candles.findIndex((c) => c.time === t);
        if (i < 0 || i < WARMUP_CANDLES) continue;
        const ind = indBySymbol.get(s)!;
        const row = candles[i];
        if (!Number.isFinite(ind.rsi14[i]) || !Number.isFinite(ind.atr14[i]) || !Number.isFinite(ind.sma50[i])) {
          continue;
        }
        const setup = detectSetup(candles, ind, i);
        if (setup === null) continue;
        const reject = (side: 'long' | 'short', reason: string): void => {
          events.push({
            type: 'SIGNAL_REJECT',
            candleTime: new Date(t).toISOString(),
            tradeId: '',
            symbol: s,
            side,
            entryTime: '',
            entry: '',
            exitTime: '',
            exit: '',
            exitReason: '',
            sl: '',
            tp: '',
            size: '',
            riskUsd: '',
            pnl: '',
            fees: '',
            barsHeld: '',
            reason,
          });
          summary.rejects += 1;
        };
        // volatility guard (STRATEGY-v3-b.md §3.5)
        if (!volGuardOk(candles, ind, i)) {
          reject(setup.side, 'VOL_GUARD');
          continue;
        }
        // SL/TP are measured from the RAW confirmation close; the
        // entry stored is the slippage-adjusted fill (backtest conv.).
        const entryFill = setup.side === 'long' ? row.close * (1 + SLIPPAGE) : row.close * (1 - SLIPPAGE);
        const trade = computeTrade(row.close, setup.side, setup.atr);
        if (trade === null) {
          reject(setup.side, 'INVALID_TRADE');
          continue;
        }
        const proposed = { ...trade, entry: entryFill, symbol: s };
        const marks: Record<string, number> = {};
        for (const pos of working.openPositions) {
          const match = data[pos.symbol]?.find((c) => c.time === t);
          if (match) marks[pos.symbol] = match.close;
        }
        const { allowed, reasons } = checkEntry(dayState, proposed, working.openPositions, marks);
        if (!allowed) {
          reject(setup.side, reasons.join('+'));
          continue;
        }
        const tid = tradeId(s, t);
        const pos: PaperPosition = {
          symbol: s,
          side: setup.side,
          entry: proposed.entry,
          entryTime: new Date(t).toISOString(),
          entryIndex: i,
          sl: trade.sl,
          slOrig: trade.sl,
          tp: trade.tp,
          size: trade.size,
          riskDist: trade.riskDist,
          riskUsd: trade.riskUsd,
          beMoved: false,
          tradeId: tid,
        };
        working.openPositions.push(pos);
        working.entriesByDay[day] = (working.entriesByDay[day] ?? 0) + 1;
        dayState.entriesToday += 1;
        events.push({
          type: 'ENTRY',
          candleTime: new Date(t).toISOString(),
          tradeId: tid,
          symbol: s,
          side: setup.side,
          entryTime: new Date(t).toISOString(),
          entry: proposed.entry,
          exitTime: '',
          exit: '',
          exitReason: '',
          sl: trade.sl,
          tp: trade.tp,
          size: trade.size,
          riskUsd: trade.riskUsd,
          pnl: '',
          fees: '',
          barsHeld: 0,
          reason: `v3-B setup; notional $${trade.notional.toFixed(2)}, cost $${trade.roundTripCostUsd.toFixed(2)}`,
        });
        summary.entries += 1;
      }
    }
    // mark this candle processed for every symbol that had it
    for (const s of symbols) {
      if (data[s].some((c) => c.time === t)) {
        working.lastProcessed[s] = new Date(t).toISOString();
      }
    }
  }

  return { state: working, events, summary };
}

/** Totals from closed paper trades (EXIT events only). */
export function paperTotals(events: readonly PaperEvent[]): {
  trades: number;
  net: number;
  wins: number;
  winRate: number | null;
} {
  const exits = events.filter((e) => e.type === 'EXIT');
  const net = exits.reduce((a, e) => a + (typeof e.pnl === 'number' ? e.pnl : 0), 0);
  const wins = exits.filter((e) => typeof e.pnl === 'number' && e.pnl > 0).length;
  return {
    trades: exits.length,
    net,
    wins,
    winRate: exits.length > 0 ? (wins / exits.length) * 100 : null,
  };
}

/**
 * One-line status summary, same shape as paper_trade.py `status_line`.
 * `today` defaults to the current UTC date.
 */
export function statusLine(state: PaperState, events: readonly PaperEvent[], today?: string): string {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const totals = paperTotals(events);
  const todayPnl = state.pnlByDay[day] ?? 0;
  const tradesToday = state.entriesByDay[day] ?? 0;
  const halted = state.haltedDays.includes(day) ? 'YES' : 'NO';
  const opens =
    state.openPositions
      .map((p) => `${p.symbol} ${p.side} @${p.entry.toFixed(2)} (SL ${p.sl.toFixed(2)}, TP ${p.tp.toFixed(2)})`)
      .join(', ') || 'none';
  const last = Object.values(state.lastProcessed).sort().pop() ?? 'n/a';
  const wr = totals.winRate !== null ? `${totals.winRate.toFixed(1)}%` : 'n/a';
  const sign = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
  return (
    `PAPER v3-B | ${day} | open: ${opens} | today P&L: ${sign(todayPnl)} | ` +
    `trades today: ${tradesToday} | halt: ${halted} | paper total: ${sign(totals.net)} ` +
    `(${totals.trades} trades, ${wr} win) | last candle: ${last}`
  );
}

/**
 * Audit an event log for rule violations (port of paper_trade.py
 * `audit()`). Returns violation strings; empty = clean. Checks:
 * >2 entries/day, any day worse than -$30 (realized exits), entries
 * after a HALT the same day, and entries while a prior position in
 * the same symbol was still open.
 */
export function auditPaper(events: readonly PaperEvent[]): string[] {
  const violations: string[] = [];
  if (events.length === 0) return violations;
  const entries = events.filter((e) => e.type === 'ENTRY');
  const exits = events.filter((e) => e.type === 'EXIT');
  // 1. entries per day
  const perDay = new Map<string, number>();
  for (const e of entries) {
    const d = e.candleTime.slice(0, 10);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  for (const [d, n] of perDay) {
    if (n > MAX_TRADES_PER_DAY) violations.push(`${d}: ${n} entries (cap is 2)`);
  }
  // 2. worst day (realized exits, by exit day)
  const daily = new Map<string, number>();
  for (const e of exits) {
    if (typeof e.pnl !== 'number' || !e.exitTime) continue;
    const d = e.exitTime.slice(0, 10);
    daily.set(d, (daily.get(d) ?? 0) + e.pnl);
  }
  for (const [d, pnl] of daily) {
    if (pnl < DAILY_LOSS_CAP_USD) {
      violations.push(`${d}: day P&L $${pnl.toFixed(2)} breached $${DAILY_LOSS_CAP_USD.toFixed(0)} cap`);
    }
  }
  // 3. entries on a halted day (a HALT exit exists that day before entry)
  for (const e of entries) {
    const d = e.candleTime.slice(0, 10);
    const haltBefore = exits.some(
      (x) =>
        x.exitReason === 'HALT' &&
        x.exitTime.slice(0, 10) === d &&
        x.candleTime < e.candleTime,
    );
    if (haltBefore) violations.push(`${d}: entry ${e.tradeId} after a HALT the same day`);
  }
  // 4. overlapping positions in the same symbol
  const symbols = [...new Set(entries.map((e) => e.symbol))];
  for (const sym of symbols) {
    const symEntries = entries.filter((e) => e.symbol === sym).sort((a, b) => (a.candleTime < b.candleTime ? -1 : 1));
    const symExits = exits.filter((e) => e.symbol === sym);
    for (const e of symEntries) {
      const earlier = symEntries.filter((x) => x.candleTime < e.candleTime);
      if (earlier.length === 0) continue;
      const lastEntry = earlier[earlier.length - 1];
      const closed = symExits.find((x) => x.tradeId === lastEntry.tradeId);
      if (!closed || closed.candleTime > e.candleTime) {
        violations.push(`${e.candleTime.slice(0, 10)}: ${sym} entry ${e.tradeId} while a prior ${sym} position was still open`);
      }
    }
  }
  return violations;
}
