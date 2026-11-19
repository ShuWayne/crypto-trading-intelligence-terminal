/**
 * Risk status — reflects the REAL paper-trading state from the Phase 2
 * harness (~/workspace/trading/binance-system/paper-state.json +
 * paper-trades.csv), combined with the terminal's own settings.
 * No invented positions: when the harness files are absent, open
 * positions / PnL read as zero and the source is labelled honestly.
 *
 * Rules (from risk_engine.py / PHASE2.md — do NOT add the removed
 * absolute-cap projection rule):
 *   $15/trade, max 2 entries/day, max 2 concurrent, 2-loss anti-revenge,
 *   daily halt at realized+unrealized <= -$20, absolute cap -$30 (NO-GO).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// paper-state.json lives in ~/workspace/trading/binance-system/. The module
// runs compiled from server/dist/services/ (3 levels below the repo root
// `trading/`) or from server/src/services/ via tsx (2 levels below), so
// try both layouts and use whichever actually contains the harness files.
function findBinanceSystemDir(): string {
  const candidates = [
    path.resolve(MODULE_DIR, '../../../binance-system'),
    path.resolve(MODULE_DIR, '../../../../binance-system'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'paper-state.json'))) return dir;
  }
  return candidates[0];
}

const BINANCE_SYSTEM_DIR = findBinanceSystemDir();
const PAPER_STATE_PATH = path.join(BINANCE_SYSTEM_DIR, 'paper-state.json');
const PAPER_TRADES_CSV = path.join(BINANCE_SYSTEM_DIR, 'paper-trades.csv');

export interface PaperState {
  openPositions: { symbol: string; side: string; entry: number; sl: number; tp: number; size: number }[];
  entriesByDay: Record<string, number>;
  lossesByDay: Record<string, number>;
  pnlByDay: Record<string, number>;
  haltedDays: string[];
  lastProcessed: Record<string, string>;
  source: 'paper-harness' | 'db-only';
}

export function readPaperState(): PaperState {
  const empty: PaperState = {
    openPositions: [],
    entriesByDay: {},
    lossesByDay: {},
    pnlByDay: {},
    haltedDays: [],
    lastProcessed: {},
    source: 'db-only',
  };
  try {
    const raw = JSON.parse(fs.readFileSync(PAPER_STATE_PATH, 'utf8')) as Record<string, unknown>;
    return {
      openPositions: (raw.open_positions as PaperState['openPositions']) ?? [],
      entriesByDay: (raw.entries_by_day as Record<string, number>) ?? {},
      lossesByDay: (raw.losses_by_day as Record<string, number>) ?? {},
      pnlByDay: (raw.pnl_by_day as Record<string, number>) ?? {},
      haltedDays: (raw.halted_days as string[]) ?? [],
      lastProcessed: (raw.last_processed as Record<string, string>) ?? {},
      source: 'paper-harness',
    };
  } catch {
    return empty;
  }
}

export interface PaperLogRow {
  eventTimeUtc: string;
  candleTimeUtc: string;
  type: string;
  tradeId: string;
  symbol: string;
  side: string;
  entryTime: string;
  entry: number;
  exitTime: string;
  exit: number;
  exitReason: string;
  sl: number;
  tp: number;
  size: number;
  riskUsd: number;
  pnl: number;
  fees: number;
  barsHeld: number;
  reason: string;
}

/** Parse the append-only paper-trades.csv log (header + rows). */
export function readPaperLog(): PaperLogRow[] {
  try {
    const text = fs.readFileSync(PAPER_TRADES_CSV, 'utf8').trim();
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.length < 2) return [];
    const rows: PaperLogRow[] = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const c = line.split(',');
      if (c.length < 19) continue;
      rows.push({
        eventTimeUtc: c[0],
        candleTimeUtc: c[1],
        type: c[2],
        tradeId: c[3],
        symbol: c[4],
        side: c[5],
        entryTime: c[6],
        entry: Number(c[7]),
        exitTime: c[8],
        exit: Number(c[9]),
        exitReason: c[10],
        sl: Number(c[11]),
        tp: Number(c[12]),
        size: Number(c[13]),
        riskUsd: Number(c[14]),
        pnl: Number(c[15]),
        fees: Number(c[16]),
        barsHeld: Number(c[17]),
        reason: c[18] ?? '',
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Unrealized PnL of open positions at the given marks (USD, fees excluded). */
export function unrealizedPnl(
  positions: PaperState['openPositions'],
  marks: Record<string, number>,
): number {
  let total = 0;
  for (const p of positions) {
    const mark = marks[p.symbol];
    if (mark === undefined) continue;
    const gross = p.side.toLowerCase() === 'long' ? (mark - p.entry) * p.size : (p.entry - mark) * p.size;
    total += gross;
  }
  return total;
}

export interface RiskStatus {
  date: string;
  tradesToday: number;
  lossesToday: number;
  realizedToday: number;
  openPositions: number;
  halted: boolean;
  tradingDisabled: boolean;
  dailyLossLimit: number;
  riskPerTrade: number;
  maxDrawdown: number;
  cooldownUntil: string | null;
  source: string;
}

export async function getRiskStatus(marks: Record<string, number> = {}): Promise<RiskStatus> {
  const db = getDb();
  const dailyLossLimit = Number(db.getSetting('dailyLossLimit') ?? '25');
  const riskPerTrade = Number(db.getSetting('riskPerTrade') ?? '15');
  const state = readPaperState();
  const today = utcToday();

  const tradesToday = state.entriesByDay[today] ?? 0;
  const lossesToday = state.lossesByDay[today] ?? 0;
  const realizedToday = Math.round((state.pnlByDay[today] ?? 0) * 100) / 100;
  const unrealized = unrealizedPnl(state.openPositions, marks);
  const halted =
    state.haltedDays.includes(today) || realizedToday + unrealized <= -20 || lossesToday >= 2;
  const tradingDisabled = halted;

  // Max drawdown: worst single-day realized PnL in the harness log (honest,
  // labelled as day-based; full equity-curve DD comes from the backtest).
  const dayPnls = Object.values(state.pnlByDay);
  const maxDrawdown = dayPnls.length ? Math.round(Math.min(...dayPnls, 0) * 100) / 100 : 0;

  const cooldownUntil = halted
    ? new Date(`${today}T00:00:00Z`).getTime() + 24 * 3600_000 <= Date.now()
      ? null
      : new Date(Date.parse(`${today}T00:00:00Z`) + 24 * 3600_000).toISOString()
    : null;

  return {
    date: today,
    tradesToday,
    lossesToday,
    realizedToday,
    openPositions: state.openPositions.length,
    halted,
    tradingDisabled,
    dailyLossLimit,
    riskPerTrade,
    maxDrawdown,
    cooldownUntil,
    source: state.source === 'paper-harness' ? 'paper-harness (paper-state.json)' : 'db-only (no harness state found)',
  };
}

/** Paper summary block used by /api/signals. */
export async function getPaperSummary(marks: Record<string, number> = {}): Promise<{
  openPositions: number;
  todayPnl: number;
  tradesToday: number;
  halted: boolean;
  tradingDisabled: boolean;
}> {
  const s = await getRiskStatus(marks);
  return {
    openPositions: s.openPositions,
    todayPnl: s.realizedToday,
    tradesToday: s.tradesToday,
    halted: s.halted,
    tradingDisabled: s.tradingDisabled,
  };
}
