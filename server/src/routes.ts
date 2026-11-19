/**
 * API routes — see ARCHITECTURE.md for the contract.
 * Every response carries updatedAt + source where market data is involved.
 * Binance failures return 502 with status UNAVAILABLE/DEGRADED — never
 * invented data.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { binance, OVERVIEW_SYMBOLS, SIGNAL_SYMBOLS } from './services/binance.js';
import { getDb } from './services/db.js';
import { getGold } from './services/gold.js';
import { getNews } from './services/news.js';
import { evaluateIndicator } from './services/indicator.js';
import { getRiskStatus, readPaperLog, readPaperState } from './services/risk.js';
import { getScanner } from './services/scanner.js';
import { getSignals } from './services/signals.js';
import { listAlerts } from './services/alerts.js';
import { getReport, getVariants, listReports, reportToCsv, runBacktest } from './services/backtest.js';

const router = Router();

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

function wrap(fn: Handler): Handler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function binanceError(res: Response, err: unknown): void {
  res.status(502).json({
    error: 'Binance market data unavailable',
    detail: err instanceof Error ? err.message : String(err),
    status: binance.status(),
    source: binance.source(),
    updatedAt: new Date().toISOString(),
  });
}

const INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;

// ------------------------------------------------------------------ health ---

router.get(
  '/health',
  wrap(async (_req, res) => {
    res.json({
      status: binance.status() === 'UNAVAILABLE' ? 'DEGRADED' : 'OK',
      time: new Date().toISOString(),
      binance: { rest: binance.restStatus, ws: binance.wsStatus },
      db: getDb().backend,
      uptimeSec: Math.round(process.uptime()),
    });
  }),
);

// ----------------------------------------------------------------- markets ---

router.get(
  '/markets/overview',
  wrap(async (_req, res) => {
    try {
      const tickers = await binance.getTickers([...OVERVIEW_SYMBOLS]);
      res.json({
        updatedAt: new Date().toISOString(),
        source: binance.source(),
        status: binance.status(),
        symbols: tickers.map((t) => ({
          symbol: t.symbol,
          price: t.price,
          change24hPct: t.change24hPct,
          high24h: t.high24h,
          low24h: t.low24h,
          volume24h: t.volume24h,
          quoteVolume24h: t.quoteVolume24h,
          fundingRate: null, // spot market — no funding rate
          openInterest: null, // spot market — no open interest
          marketCap: null, // Binance spot has no market cap
        })),
      });
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

router.get(
  '/markets/klines',
  wrap(async (req, res) => {
    const symbol = String(req.query.symbol ?? 'BTCUSDT').toUpperCase();
    const interval = String(req.query.interval ?? '4h');
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 1000);
    if (!SYMBOL_RE.test(symbol)) {
      res.status(400).json({ error: 'Invalid symbol' });
      return;
    }
    if (!INTERVALS.has(interval)) {
      res.status(400).json({ error: `Invalid interval. Allowed: ${[...INTERVALS].join(', ')}` });
      return;
    }
    try {
      const candles = await binance.getKlines(symbol, interval, limit);
      res.json({ updatedAt: new Date().toISOString(), source: binance.source(), symbol, interval, candles });
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

router.get(
  '/markets/ticker/:symbol',
  wrap(async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      res.status(400).json({ error: 'Invalid symbol' });
      return;
    }
    try {
      const t = await binance.getTicker(symbol);
      res.json({
        updatedAt: new Date().toISOString(),
        source: binance.source(),
        ...t,
        fundingRate: null,
        openInterest: null,
        marketCap: null,
      });
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

// ----------------------------------------------------------------- scanner ---

router.get(
  '/scanner',
  wrap(async (_req, res) => {
    try {
      const out = await getScanner();
      res.json({ updatedAt: out.updatedAt, source: out.source, status: binance.status(), rows: out.rows });
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

// ----------------------------------------------------------------- signals ---

router.get(
  '/signals',
  wrap(async (_req, res) => {
    try {
      const out = await getSignals();
      res.json({ ...out, source: binance.source() });
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

router.get(
  '/signals/history',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
    // Paper trades: terminal DB first, then the Phase 2 harness log.
    const dbRows = getDb().listPaperTrades(limit);
    const seen = new Set(dbRows.map((r) => r.tradeId));
    const logRows = readPaperLog()
      .filter((r) => r.type === 'EXIT' && !seen.has(r.tradeId))
      .map((r) => ({
        tradeId: r.tradeId,
        symbol: r.symbol,
        side: r.side,
        entryTime: r.entryTime,
        entry: r.entry,
        exitTime: r.exitTime || null,
        exitPrice: Number.isFinite(r.exit) ? r.exit : null,
        exitReason: r.exitReason || null,
        sl: r.sl,
        tp: r.tp,
        size: r.size,
        riskUsd: r.riskUsd,
        pnl: r.pnl,
        fees: r.fees,
        barsHeld: r.barsHeld,
        status: 'CLOSED',
      }));
    const merged = [
      ...dbRows.map((r) => ({
        tradeId: r.tradeId,
        symbol: r.symbol,
        side: r.side,
        entryTime: r.entryTime,
        entry: r.entry,
        exitTime: r.exitTime,
        exitPrice: r.exitPrice,
        exitReason: r.exitReason,
        sl: r.sl,
        tp: r.tp,
        size: r.size,
        riskUsd: r.riskUsd,
        pnl: r.pnl,
        fees: r.fees,
        barsHeld: r.barsHeld,
        status: r.status,
      })),
      ...logRows,
    ]
      .sort((a, b) => (a.entryTime < b.entryTime ? 1 : -1))
      .slice(0, limit);
    res.json({
      updatedAt: new Date().toISOString(),
      source: 'sqlite:terminal.db + paper-trades.csv (Phase 2 harness)',
      trades: merged,
    });
  }),
);

// --------------------------------------------------------------- indicator ---

router.get(
  '/indicator',
  wrap(async (_req, res) => {
    try {
      const symbols: unknown[] = [];
      for (const symbol of OVERVIEW_SYMBOLS) {
        const candles = await binance.getClosedKlines(symbol, '4h', 120);
        const validated = (SIGNAL_SYMBOLS as readonly string[]).includes(symbol);
        const ind = await evaluateIndicator(symbol, candles, validated);
        symbols.push({
          symbol: ind.symbol,
          regime: ind.regime,
          rangeLow: ind.rangeLow,
          rangeHigh: ind.rangeHigh,
          rangeWidthAtr: ind.rangeWidthAtr,
          rsi: ind.rsi === null ? null : Math.round(ind.rsi * 10) / 10,
          distanceToLowAtr: ind.distanceToLowAtr,
          distanceToHighAtr: ind.distanceToHighAtr,
          state: ind.state,
          reason: ind.reason,
        });
      }
      res.json({
        updatedAt: new Date().toISOString(),
        source: binance.source(),
        status: binance.status(),
        strategy: 'v3-B Range Mean-Reversion (4h, closed candles only)',
        symbols,
      });
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

// ------------------------------------------------------------------ alerts ---

router.get(
  '/alerts',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    if (symbol && !SYMBOL_RE.test(symbol)) {
      res.status(400).json({ error: 'Invalid symbol' });
      return;
    }
    const out = await listAlerts(limit, symbol);
    res.json({ updatedAt: new Date().toISOString(), ...out });
  }),
);

// -------------------------------------------------------------------- gold ---

router.get(
  '/gold',
  wrap(async (_req, res) => {
    try {
      res.json(await getGold());
    } catch (err) {
      binanceError(res, err);
    }
  }),
);

// -------------------------------------------------------------------- news ---

router.get(
  '/news',
  wrap(async (_req, res) => {
    res.json(await getNews());
  }),
);

// -------------------------------------------------------------------- risk ---

router.get(
  '/risk/status',
  wrap(async (_req, res) => {
    const marks: Record<string, number> = {};
    try {
      const tickers = await binance.getTickers([...SIGNAL_SYMBOLS]);
      for (const t of tickers) marks[t.symbol] = t.price;
    } catch {
      /* marks unavailable — unrealized PnL treated as 0, realised still reported */
    }
    const status = await getRiskStatus(marks);
    const state = readPaperState();
    res.json({ ...status, lastProcessed: state.lastProcessed, paperSource: status.source });
  }),
);

router.post(
  '/risk/config',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as { dailyLossLimit?: unknown; riskPerTrade?: unknown };
    const dailyLossLimit = Number(body.dailyLossLimit);
    const riskPerTrade = Number(body.riskPerTrade);
    if (!Number.isFinite(dailyLossLimit) || dailyLossLimit < 20 || dailyLossLimit > 30) {
      res.status(400).json({ error: 'dailyLossLimit must be a number between 20 and 30' });
      return;
    }
    if (!Number.isFinite(riskPerTrade) || riskPerTrade <= 0 || riskPerTrade > 30) {
      res.status(400).json({ error: 'riskPerTrade must be a number between 1 and 30' });
      return;
    }
    const db = getDb();
    db.setSetting('dailyLossLimit', String(dailyLossLimit));
    db.setSetting('riskPerTrade', String(riskPerTrade));
    res.json({ dailyLossLimit, riskPerTrade, updatedAt: new Date().toISOString() });
  }),
);

// --------------------------------------------------------------- backtest ---

router.get(
  '/backtest/variants',
  wrap(async (_req, res) => {
    res.json({
      updatedAt: new Date().toISOString(),
      source: 'stored validated results (metrics-*.json, 19 Nov 2026)',
      variants: getVariants(),
    });
  }),
);

router.post(
  '/backtest/run',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as { variant?: unknown; symbols?: unknown; days?: unknown };
    const variant = String(body.variant ?? 'b').toLowerCase();
    const symbols = Array.isArray(body.symbols) && body.symbols.length
      ? (body.symbols as unknown[]).map((s) => String(s).toUpperCase())
      : ['BTCUSDT', 'SOLUSDT'];
    const days = Math.min(Math.max(Number(body.days ?? 240) || 240, 1), 1500);
    for (const s of symbols) {
      if (!SYMBOL_RE.test(s)) {
        res.status(400).json({ error: `Invalid symbol: ${s}` });
        return;
      }
    }
    try {
      const result = await runBacktest(variant, symbols, days);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }),
);

router.get(
  '/backtest/reports',
  wrap(async (_req, res) => {
    res.json({ updatedAt: new Date().toISOString(), reports: listReports() });
  }),
);

router.get(
  '/backtest/reports/:id/download',
  wrap(async (req, res) => {
    const format = String(req.query.format ?? 'json').toLowerCase();
    const report = getReport(req.params.id);
    if (!report) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="backtest-${report.variant}-${report.id}.csv"`);
      res.send(reportToCsv(report));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backtest-${report.variant}-${report.id}.json"`);
    res.send(JSON.stringify(report, null, 2));
  }),
);

// --------------------------------------------------------------- settings ---

router.get(
  '/settings',
  wrap(async (_req, res) => {
    const db = getDb();
    res.json({
      dailyLossLimit: Number(db.getSetting('dailyLossLimit') ?? '25'),
      riskPerTrade: Number(db.getSetting('riskPerTrade') ?? '15'),
      symbols: [...OVERVIEW_SYMBOLS],
      refreshSec: 5,
      updatedAt: new Date().toISOString(),
    });
  }),
);

export default router;
