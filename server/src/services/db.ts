/**
 * SQLite persistence (better-sqlite3) — server/data/terminal.db
 *
 * Tables: paper_trades, signals, settings, backtest_reports.
 * Seeded settings: dailyLossLimit=25, riskPerTrade=15.
 *
 * Fallback: if better-sqlite3 cannot be loaded (native module unavailable
 * on the host), a JSON-file store with the identical interface is used
 * instead (server/data/terminal-fallback.json). The fallback is honest
 * about itself via `backend` — no silent behaviour change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PaperTradeRow {
  id?: number;
  tradeId: string;
  symbol: string;
  side: string;
  entryTime: string;
  entry: number;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  sl: number;
  tp: number;
  size: number;
  riskUsd: number;
  pnl: number | null;
  fees: number | null;
  barsHeld: number | null;
  status: string;
  createdAt: string;
}

export interface SignalRow {
  id: string;
  symbol: string;
  side: string;
  entry: number;
  stopLoss: number;
  /** Single validated TP: +2R (3.0xATR). No TP2/TP3 — see ARCHITECTURE addendum. */
  takeProfit: number;
  riskReward: string; // '1:2'
  confidence: number;
  timeframe: string;
  expiresAt: string;
  structure: string;
  reason: string;
  invalidation: string;
  /** JSON array, e.g. ["SL","TIME 96h","HALT"] */
  exitConditions: string;
  signalTimestamp: string;
  status: string;
  createdAt: string;
}

export interface AlertRow {
  id?: number;
  alertId: string;
  type: 'BUY_SETUP' | 'EXIT_TRIGGER' | 'SL_HIT' | 'TP_HIT' | 'RANGE_INVALID' | 'VOLATILITY_UNSUITABLE';
  symbol: string;
  message: string;
  time: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  createdAt: string;
}

export interface BacktestReportRow {
  id: string;
  variant: string;
  symbols: string;
  days: number;
  metricsJson: string;
  tradesJson: string;
  equityJson: string;
  source: string;
  createdAt: string;
}

export interface Db {
  backend: 'better-sqlite3' | 'json-fallback';
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  getAllSettings(): Record<string, string>;
  insertPaperTrade(t: Omit<PaperTradeRow, 'id' | 'createdAt'>): void;
  listPaperTrades(limit: number): PaperTradeRow[];
  insertSignal(s: Omit<SignalRow, 'createdAt'>): void;
  listSignals(limit: number): SignalRow[];
  getSignal(id: string): SignalRow | null;
  updateSignalStatus(id: string, status: string): void;
  insertBacktestReport(r: Omit<BacktestReportRow, 'createdAt'>): void;
  listBacktestReports(): BacktestReportRow[];
  getBacktestReport(id: string): BacktestReportRow | null;
  insertAlert(a: Omit<AlertRow, 'id' | 'createdAt'>): void;
  listAlerts(limit: number, symbol?: string): AlertRow[];
}

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const DB_PATH = path.join(DATA_DIR, 'terminal.db');
const FALLBACK_PATH = path.join(DATA_DIR, 'terminal-fallback.json');

// ---------------------------------------------------------------------------
// better-sqlite3 backend
// ---------------------------------------------------------------------------

class SqliteDb implements Db {
  backend = 'better-sqlite3' as const;
  private db: unknown; // Database instance (typed loosely to avoid hard dep at import time)

  constructor(Database: new (path: string) => unknown) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.migrate();
  }

  private run(sql: string, params: unknown[] = []): void {
    const db = this.db as {
      prepare: (s: string) => { run: (...p: unknown[]) => void };
    };
    db.prepare(sql).run(...params);
  }

  private all<T>(sql: string, params: unknown[] = []): T[] {
    const db = this.db as {
      prepare: (s: string) => { all: (...p: unknown[]) => T[] };
    };
    return db.prepare(sql).all(...params);
  }

  private get<T>(sql: string, params: unknown[] = []): T | undefined {
    const db = this.db as {
      prepare: (s: string) => { get: (...p: unknown[]) => T | undefined };
    };
    return db.prepare(sql).get(...params);
  }

  private migrate(): void {
    this.run(`CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT UNIQUE NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
      entry_time TEXT NOT NULL, entry REAL NOT NULL,
      exit_time TEXT, exit_price REAL, exit_reason TEXT,
      sl REAL NOT NULL, tp REAL NOT NULL, size REAL NOT NULL,
      risk_usd REAL NOT NULL, pnl REAL, fees REAL, bars_held INTEGER,
      status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL)`);
    this.run(`CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL,
      entry REAL NOT NULL, stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL,
      risk_reward TEXT NOT NULL DEFAULT '1:2', confidence REAL NOT NULL,
      timeframe TEXT NOT NULL, expires_at TEXT NOT NULL,
      structure TEXT NOT NULL, reason TEXT NOT NULL, invalidation TEXT NOT NULL,
      exit_conditions TEXT NOT NULL DEFAULT '["SL","TIME 96h","HALT"]',
      signal_timestamp TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL)`);
    this.run(`CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL, symbol TEXT NOT NULL, message TEXT NOT NULL,
      time TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'INFO',
      created_at TEXT NOT NULL)`);
    this.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.run(`CREATE TABLE IF NOT EXISTS backtest_reports (
      id TEXT PRIMARY KEY, variant TEXT NOT NULL, symbols TEXT NOT NULL,
      days INTEGER NOT NULL, metrics_json TEXT NOT NULL,
      trades_json TEXT NOT NULL, equity_json TEXT NOT NULL,
      source TEXT NOT NULL, created_at TEXT NOT NULL)`);
    // Seed settings (only when absent).
    for (const [k, v] of [
      ['dailyLossLimit', '25'],
      ['riskPerTrade', '15'],
    ]) {
      this.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
    }
  }

  getSetting(key: string): string | null {
    const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  insertPaperTrade(t: Omit<PaperTradeRow, 'id' | 'createdAt'>): void {
    this.run(
      `INSERT OR IGNORE INTO paper_trades
       (trade_id, symbol, side, entry_time, entry, exit_time, exit_price, exit_reason,
        sl, tp, size, risk_usd, pnl, fees, bars_held, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.tradeId, t.symbol, t.side, t.entryTime, t.entry, t.exitTime, t.exitPrice, t.exitReason,
       t.sl, t.tp, t.size, t.riskUsd, t.pnl, t.fees, t.barsHeld, t.status, new Date().toISOString()],
    );
  }

  listPaperTrades(limit: number): PaperTradeRow[] {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM paper_trades ORDER BY entry_time DESC LIMIT ?', [limit],
    ).map(toPaperTradeRow);
  }

  insertSignal(s: Omit<SignalRow, 'createdAt'>): void {
    this.run(
      `INSERT OR IGNORE INTO signals
       (id, symbol, side, entry, stop_loss, take_profit, risk_reward, confidence,
        timeframe, expires_at, structure, reason, invalidation, exit_conditions,
        signal_timestamp, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.symbol, s.side, s.entry, s.stopLoss, s.takeProfit, s.riskReward,
       s.confidence, s.timeframe, s.expiresAt, s.structure, s.reason, s.invalidation,
       s.exitConditions, s.signalTimestamp, s.status, new Date().toISOString()],
    );
  }

  listSignals(limit: number): SignalRow[] {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM signals ORDER BY created_at DESC LIMIT ?', [limit],
    ).map(toSignalRow);
  }

  getSignal(id: string): SignalRow | null {
    const row = this.get<Record<string, unknown>>('SELECT * FROM signals WHERE id = ?', [id]);
    return row ? toSignalRow(row) : null;
  }

  updateSignalStatus(id: string, status: string): void {
    this.run('UPDATE signals SET status = ? WHERE id = ?', [status, id]);
  }

  insertBacktestReport(r: Omit<BacktestReportRow, 'createdAt'>): void {
    this.run(
      `INSERT OR REPLACE INTO backtest_reports
       (id, variant, symbols, days, metrics_json, trades_json, equity_json, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.variant, r.symbols, r.days, r.metricsJson, r.tradesJson, r.equityJson, r.source, new Date().toISOString()],
    );
  }

  listBacktestReports(): BacktestReportRow[] {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM backtest_reports ORDER BY created_at DESC',
    ).map(toReportRow);
  }

  getBacktestReport(id: string): BacktestReportRow | null {
    const row = this.get<Record<string, unknown>>('SELECT * FROM backtest_reports WHERE id = ?', [id]);
    return row ? toReportRow(row) : null;
  }

  insertAlert(a: Omit<AlertRow, 'id' | 'createdAt'>): void {
    this.run(
      `INSERT OR IGNORE INTO alerts (alert_id, type, symbol, message, time, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [a.alertId, a.type, a.symbol, a.message, a.time, a.severity, new Date().toISOString()],
    );
  }

  listAlerts(limit: number, symbol?: string): AlertRow[] {
    if (symbol) {
      return this.all<Record<string, unknown>>(
        'SELECT * FROM alerts WHERE symbol = ? ORDER BY time DESC, id DESC LIMIT ?', [symbol, limit],
      ).map(toAlertRow);
    }
    return this.all<Record<string, unknown>>(
      'SELECT * FROM alerts ORDER BY time DESC, id DESC LIMIT ?', [limit],
    ).map(toAlertRow);
  }
}

function toPaperTradeRow(r: Record<string, unknown>): PaperTradeRow {
  return {
    id: r.id as number,
    tradeId: r.trade_id as string,
    symbol: r.symbol as string,
    side: r.side as string,
    entryTime: r.entry_time as string,
    entry: r.entry as number,
    exitTime: (r.exit_time as string | null) ?? null,
    exitPrice: (r.exit_price as number | null) ?? null,
    exitReason: (r.exit_reason as string | null) ?? null,
    sl: r.sl as number,
    tp: r.tp as number,
    size: r.size as number,
    riskUsd: r.risk_usd as number,
    pnl: (r.pnl as number | null) ?? null,
    fees: (r.fees as number | null) ?? null,
    barsHeld: (r.bars_held as number | null) ?? null,
    status: r.status as string,
    createdAt: r.created_at as string,
  };
}

function toSignalRow(r: Record<string, unknown>): SignalRow {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    side: r.side as string,
    entry: r.entry as number,
    stopLoss: r.stop_loss as number,
    takeProfit: r.take_profit as number,
    riskReward: r.risk_reward as string,
    confidence: r.confidence as number,
    timeframe: r.timeframe as string,
    expiresAt: r.expires_at as string,
    structure: r.structure as string,
    reason: r.reason as string,
    invalidation: r.invalidation as string,
    exitConditions: (r.exit_conditions as string) ?? '["SL","TIME 96h","HALT"]',
    signalTimestamp: (r.signal_timestamp as string) ?? (r.created_at as string),
    status: r.status as string,
    createdAt: r.created_at as string,
  };
}

function toAlertRow(r: Record<string, unknown>): AlertRow {
  return {
    id: r.id as number,
    alertId: r.alert_id as string,
    type: r.type as AlertRow['type'],
    symbol: r.symbol as string,
    message: r.message as string,
    time: r.time as string,
    severity: r.severity as AlertRow['severity'],
    createdAt: r.created_at as string,
  };
}

function toReportRow(r: Record<string, unknown>): BacktestReportRow {
  return {
    id: r.id as string,
    variant: r.variant as string,
    symbols: r.symbols as string,
    days: r.days as number,
    metricsJson: r.metrics_json as string,
    tradesJson: r.trades_json as string,
    equityJson: r.equity_json as string,
    source: r.source as string,
    createdAt: r.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// JSON-file fallback (only used when better-sqlite3 cannot load)
// ---------------------------------------------------------------------------

interface FallbackState {
  settings: Record<string, string>;
  paperTrades: PaperTradeRow[];
  signals: SignalRow[];
  reports: BacktestReportRow[];
  alerts: AlertRow[];
}

class JsonDb implements Db {
  backend = 'json-fallback' as const;
  private state: FallbackState;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.state = JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8')) as FallbackState;
    } catch {
      this.state = {
        settings: { dailyLossLimit: '25', riskPerTrade: '15' },
        paperTrades: [],
        signals: [],
        reports: [],
        alerts: [],
      };
      this.persist();
    }
  }

  private persist(): void {
    fs.writeFileSync(FALLBACK_PATH, JSON.stringify(this.state, null, 2));
  }

  getSetting(key: string): string | null {
    return this.state.settings[key] ?? null;
  }

  setSetting(key: string, value: string): void {
    this.state.settings[key] = value;
    this.persist();
  }

  getAllSettings(): Record<string, string> {
    return { ...this.state.settings };
  }

  insertPaperTrade(t: Omit<PaperTradeRow, 'id' | 'createdAt'>): void {
    if (this.state.paperTrades.some((x) => x.tradeId === t.tradeId)) return;
    this.state.paperTrades.push({ ...t, id: this.state.paperTrades.length + 1, createdAt: new Date().toISOString() });
    this.persist();
  }

  listPaperTrades(limit: number): PaperTradeRow[] {
    return [...this.state.paperTrades]
      .sort((a, b) => (a.entryTime < b.entryTime ? 1 : -1))
      .slice(0, limit);
  }

  insertSignal(s: Omit<SignalRow, 'createdAt'>): void {
    if (this.state.signals.some((x) => x.id === s.id)) return;
    this.state.signals.push({ ...s, createdAt: new Date().toISOString() });
    this.persist();
  }

  listSignals(limit: number): SignalRow[] {
    return [...this.state.signals]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  getSignal(id: string): SignalRow | null {
    return this.state.signals.find((x) => x.id === id) ?? null;
  }

  updateSignalStatus(id: string, status: string): void {
    const s = this.state.signals.find((x) => x.id === id);
    if (s) {
      s.status = status;
      this.persist();
    }
  }

  insertBacktestReport(r: Omit<BacktestReportRow, 'createdAt'>): void {
    this.state.reports = this.state.reports.filter((x) => x.id !== r.id);
    this.state.reports.push({ ...r, createdAt: new Date().toISOString() });
    this.persist();
  }

  listBacktestReports(): BacktestReportRow[] {
    return [...this.state.reports].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getBacktestReport(id: string): BacktestReportRow | null {
    return this.state.reports.find((x) => x.id === id) ?? null;
  }

  insertAlert(a: Omit<AlertRow, 'id' | 'createdAt'>): void {
    if (this.state.alerts.some((x) => x.alertId === a.alertId)) return;
    this.state.alerts.push({ ...a, id: this.state.alerts.length + 1, createdAt: new Date().toISOString() });
    this.persist();
  }

  listAlerts(limit: number, symbol?: string): AlertRow[] {
    const rows = symbol
      ? this.state.alerts.filter((x) => x.symbol === symbol)
      : this.state.alerts;
    return [...rows].sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, limit);
  }
}

// ---------------------------------------------------------------------------

let instance: Db | null = null;

/** Initialise persistence. Prefers better-sqlite3; falls back to JSON file. */
export async function initDb(): Promise<Db> {
  if (instance) return instance;
  try {
    const mod = (await import('better-sqlite3')) as unknown as {
      default: new (path: string) => unknown;
    };
    instance = new SqliteDb(mod.default);
  } catch (err) {
    console.warn(
      '[db] better-sqlite3 unavailable, using JSON-file fallback:',
      err instanceof Error ? err.message : String(err),
    );
    instance = new JsonDb();
  }
  return instance;
}

export function getDb(): Db {
  if (!instance) throw new Error('Database not initialised — call initDb() first');
  return instance;
}

export function dbPath(): string {
  return instance?.backend === 'better-sqlite3' ? DB_PATH : FALLBACK_PATH;
}
