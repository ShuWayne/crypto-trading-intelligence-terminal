/**
 * Risk engine — exact TypeScript port of `risk_engine.py`
 * (~/workspace/trading/binance-system/, Phase 2, variant v3-B
 * "Range Mean-Reversion", STRATEGY-v3-b.md §1/§6).
 *
 * PURE FUNCTIONS ONLY: no network calls, no file I/O, no global mutable
 * state. Same constants, same reason codes, same formulas as the Python.
 *
 * DELIBERATELY NOT INCLUDED — the "absolute-cap projection" rule:
 * an extra check (block a trade whose full SL loss *could* push today
 * past -$30) was tried and REMOVED in the Python engine. It is not
 * part of the validated STRATEGY-v3-b.md §6 rules, and the replay test
 * proved it changes trade selection vs the backtest (it rejected the
 * 2026-09-18 BTC short the backtest took). See PHASE2.md §1/§5. The
 * residual hole is documented there: two full-SL losses can in theory
 * land on the same UTC day (~-$35); the audit flags any paper day
 * worse than -$30 as NO-GO. Do not re-add this rule here.
 */

export const RISK_PER_TRADE = 15.0; // USD risked per trade
export const MAX_TRADES_PER_DAY = 2; // entries per UTC calendar day
export const MAX_CONCURRENT = 2; // total open positions
export const DAILY_HALT_USD = -20.0; // realized + unrealized <= -20 -> close all, stop
export const DAILY_LOSS_CAP_USD = -30.0; // absolute floor: a day must never end below -30
export const MAX_LOSSES_PER_DAY = 2; // after 2 losing trades: no more entries
export const FEE = 0.001; // 0.1% taker fee per side
export const SLIPPAGE = 0.0005; // 0.05% slippage per side, always against trader
export const ROUND_TRIP_COST = 2 * (FEE + SLIPPAGE); // 0.3% of notional
export const COST_FILTER_MAX = 0.25; // round-trip costs must be <= 25% of risk
export const NOTIONAL_CAP = 2000.0; // absolute notional cap
export const SL_ATR = 1.5; // stop distance in ATRs
export const TP_ATR = 3.0; // target distance in ATRs (R:R = 1:2 exactly)
export const BE_TRIGGER_R = 1.0; // move SL to breakeven at +1R
export const VOL_GUARD_ATR = 2.5; // skip entry if confirmation candle TR > 2.5xATR
export const MAX_HOLD_BARS = 24; // 96h on 4h candles

export type Side = 'long' | 'short';

export type RiskReason =
  | 'COST_FILTER'
  | 'NOTIONAL_CAP'
  | 'CONCURRENT_CAP'
  | 'SYMBOL_ALREADY_OPEN'
  | 'DAILY_ENTRY_CAP'
  | 'LOSS_STOP_2'
  | 'DAILY_REALIZED_LOSS'
  | 'HALTED_DAY'
  | 'HALT_THRESHOLD'
  | 'VOL_GUARD'
  | 'INVALID_TRADE';

export interface TradeDefinition {
  entry: number;
  side: Side;
  riskDist: number;
  sl: number;
  tp: number;
  size: number;
  riskUsd: number;
  notional: number;
  roundTripCostUsd: number;
}

export interface ProposedTrade extends TradeDefinition {
  symbol: string;
}

/** Open position. Extra fields (entryTime, entryIndex, tradeId) live on extensions, not here. */
export interface Position {
  symbol: string;
  side: Side;
  entry: number;
  sl: number;
  slOrig: number;
  tp: number;
  size: number;
  riskDist: number;
  riskUsd: number;
  beMoved: boolean;
}

/** Per-UTC-day state. `date` is YYYY-MM-DD (UTC). */
export interface DayState {
  date: string;
  entriesToday: number;
  lossesToday: number;
  realizedToday: number;
  halted: boolean;
}

export function emptyDayState(date: string): DayState {
  return { date, entriesToday: 0, lossesToday: 0, realizedToday: 0, halted: false };
}

/** Round-trip cost (fees + slippage, both sides) on a notional. */
export function roundTripCostUsd(notional: number): number {
  return ROUND_TRIP_COST * notional;
}

/**
 * Build the full trade definition BEFORE entry. Returns null if the
 * inputs are invalid (non-positive price or ATR, bad side, non-positive
 * risk). SL = 1.5xATR, TP = 3.0xATR from entry -> R:R = 1:2 exactly.
 * Size = risk / (1.5xATR) so a full SL hit loses exactly `risk`.
 *
 * NOTE (paper_trade.py convention, preserved here): SL/TP are measured
 * from the RAW confirmation-candle close passed as `entry`. The caller
 * stores the slippage-adjusted fill as the position's entry; passing
 * the fill into computeTrade would shift every SL/TP by the slippage
 * amount and the replay would not reproduce the backtest.
 */
export function computeTrade(
  entry: number,
  side: Side,
  atr: number,
  risk: number = RISK_PER_TRADE,
): TradeDefinition | null {
  if (entry == null || atr == null || entry <= 0 || atr <= 0 || risk <= 0) return null;
  if (side !== 'long' && side !== 'short') return null;
  const riskDist = SL_ATR * atr;
  const sl = side === 'long' ? entry - riskDist : entry + riskDist;
  const tp = side === 'long' ? entry + TP_ATR * atr : entry - TP_ATR * atr;
  const size = risk / riskDist;
  const notional = size * entry;
  return {
    entry,
    side,
    riskDist,
    sl,
    tp,
    size,
    riskUsd: risk,
    notional,
    roundTripCostUsd: roundTripCostUsd(notional),
  };
}

/** True if round-trip costs are <= 25% of the risked amount. */
export function costFilterOk(notional: number, risk: number = RISK_PER_TRADE): boolean {
  return roundTripCostUsd(notional) <= COST_FILTER_MAX * risk;
}

/**
 * Mark-to-market P&L of an open position, net of the estimated exit
 * fee (the fee that would be paid to close at `mark`). Matches the
 * backtest's halt accounting (backtest_v3.py §2).
 */
export function unrealizedPnl(
  pos: Pick<Position, 'side' | 'entry' | 'size'>,
  mark: number,
): number {
  const gross =
    pos.side === 'long' ? (mark - pos.entry) * pos.size : (pos.entry - mark) * pos.size;
  return gross - FEE * mark * pos.size;
}

/**
 * Net P&L of closing a position at `exitPrice` (already
 * slippage-adjusted by the caller, same convention as the backtest).
 * Entry fee is charged on the filled entry price; exit fee on the
 * exit price.
 */
export function realizedPnl(
  pos: Pick<Position, 'side' | 'entry' | 'size'>,
  exitPrice: number,
): { gross: number; fees: number; net: number } {
  const size = pos.size;
  const feeIn = FEE * pos.entry * size;
  const feeOut = FEE * exitPrice * size;
  const gross =
    pos.side === 'long'
      ? (exitPrice - pos.entry) * size
      : (pos.entry - exitPrice) * size;
  return { gross, fees: feeIn + feeOut, net: gross - feeIn - feeOut };
}

/**
 * Realized today + unrealized of open positions at `marks`
 * ({symbol: price}). This is the number the daily halt watches.
 * Positions without a mark are skipped (the Python raises KeyError;
 * callers here always pass a mark per open symbol).
 */
export function dayTotalPnl(
  realizedToday: number,
  openPositions: readonly Pick<Position, 'symbol' | 'side' | 'entry' | 'size'>[],
  marks: Record<string, number>,
): number {
  let total = realizedToday;
  for (const pos of openPositions) {
    const mark = marks[pos.symbol];
    if (mark === undefined) continue;
    total += unrealizedPnl(pos, mark);
  }
  return total;
}

/** True if realized + unrealized <= -$20 (halt threshold). */
export function shouldHalt(
  realizedToday: number,
  openPositions: readonly Pick<Position, 'symbol' | 'side' | 'entry' | 'size'>[],
  marks: Record<string, number>,
): { halt: boolean; total: number } {
  const total = dayTotalPnl(realizedToday, openPositions, marks);
  return { halt: total <= DAILY_HALT_USD, total };
}

/**
 * New SL if price has reached +1R in profit and the SL has not been
 * moved yet, else null. `triggerPrice` is the candle high (long) or
 * low (short) — same trigger the backtest uses. The SL is moved to the
 * entry price (breakeven); it is NEVER widened and never moved again.
 */
export function breakevenSl(
  pos: Pick<Position, 'side' | 'entry' | 'riskDist' | 'beMoved'>,
  triggerPrice: number,
): number | null {
  if (pos.beMoved) return null;
  if (pos.side === 'long') {
    if (triggerPrice >= pos.entry + BE_TRIGGER_R * pos.riskDist) return pos.entry;
  } else {
    if (triggerPrice <= pos.entry - BE_TRIGGER_R * pos.riskDist) return pos.entry;
  }
  return null;
}

/**
 * The pre-trade checklist. A trade is opened ONLY if `allowed` is true.
 * Every violated rule appends its reason code — the list is empty only
 * when the trade passes. `marks` ({symbol: price}) is optional; if
 * given, the halt-threshold check also runs.
 *
 * Order of checks mirrors risk_engine.py exactly:
 * 1 HALTED_DAY, 2 DAILY_ENTRY_CAP, 3 LOSS_STOP_2, 4 DAILY_REALIZED_LOSS,
 * 5 CONCURRENT_CAP, 6 SYMBOL_ALREADY_OPEN, 7 COST_FILTER,
 * 8 NOTIONAL_CAP, 9 HALT_THRESHOLD (marks only).
 * There is deliberately NO absolute-cap projection rule (see header).
 */
export function checkEntry(
  day: DayState,
  proposed: ProposedTrade | null,
  openPositions: readonly Position[],
  marks?: Record<string, number>,
): { allowed: boolean; reasons: RiskReason[] } {
  const reasons: RiskReason[] = [];
  if (proposed === null) return { allowed: false, reasons: ['INVALID_TRADE'] };

  // 1. day already halted (daily loss halt fired earlier today)
  if (day.halted) reasons.push('HALTED_DAY');
  // 2. max 2 entries per UTC day
  if (day.entriesToday >= MAX_TRADES_PER_DAY) reasons.push('DAILY_ENTRY_CAP');
  // 3. anti-revenge: after 2 losing trades, no more entries today
  if (day.lossesToday >= MAX_LOSSES_PER_DAY) reasons.push('LOSS_STOP_2');
  // 4. after a daily realized loss of $20, stop for the day
  if (day.realizedToday <= DAILY_HALT_USD) reasons.push('DAILY_REALIZED_LOSS');
  // 5. max 2 concurrent open positions
  if (openPositions.length >= MAX_CONCURRENT) reasons.push('CONCURRENT_CAP');
  // 6. one open position per symbol at a time
  if (openPositions.some((p) => p.symbol === proposed.symbol)) {
    reasons.push('SYMBOL_ALREADY_OPEN');
  }
  // 7. cost filter: round-trip costs must be <= 25% of risk
  if (!costFilterOk(proposed.notional, proposed.riskUsd)) reasons.push('COST_FILTER');
  // 8. absolute notional cap $2,000
  if (proposed.notional > NOTIONAL_CAP) reasons.push('NOTIONAL_CAP');

  // 9. day already at/below the halt line -> do not add exposure
  // (marks = current closes of open positions)
  if (marks !== undefined) {
    const total = dayTotalPnl(day.realizedToday, openPositions, marks);
    if (total <= DAILY_HALT_USD) reasons.push('HALT_THRESHOLD');
  }

  return { allowed: reasons.length === 0, reasons };
}

/** One-line summary of the current day state (mirrors risk_engine.audit_day). */
export function auditDay(
  entries: number,
  realizedToday: number,
  openPositions: readonly Position[],
  halted: boolean | null,
): { entriesToday: number; realizedTodayUsd: number; openPositions: number; halted: boolean | null } {
  return {
    entriesToday: entries,
    realizedTodayUsd: Math.round(realizedToday * 100) / 100,
    openPositions: openPositions.length,
    halted,
  };
}
