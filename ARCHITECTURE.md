# ARCHITECTURE — Crypto Trading Intelligence Terminal

Repo: `crypto-trading-intelligence-terminal`. Stack: React 18 + TypeScript + Vite
+ Tailwind 3 (client), Node 20+ + Express + TypeScript + SQLite
(`better-sqlite3`) (server). No API keys, no auth, no live trading — market
data is Binance PUBLIC REST + WebSocket only. Paper trading only.

## Ports & dev workflow

- Backend: `http://localhost:3001` — `cd server && npm run dev` (tsx watch)
- Frontend: `http://localhost:5173` — `cd client && npm run dev`
- Vite proxies `/api` and `/ws` to `localhost:3001`.
- Production: `npm run build` in each package; server serves `client/dist`.

## Binance data sources (public only — no keys)

- REST primary: `https://data-api.binance.vision` (api.binance.com is
  geo-blocked from some networks; this is Binance's official public-data
  endpoint). Fallback: `https://api.binance.us`.
- WebSocket: `wss://stream.binance.com:9443/ws/!ticker@arr` for live tickers.
  If WS fails, fall back to REST polling every 5s and report status
  `DEGRADED`. If REST also fails, report `UNAVAILABLE` — never invent data.
- Every API response carries `updatedAt` + `source`. The UI shows connection
  status and last-updated time on every data section.

## Symbols

- Overview / scanner / charts: `BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT,
  DOGEUSDT, TONUSDT, PAXGUSDT`.
- Signal engine (v3-B): `BTCUSDT, SOLUSDT` ONLY (validated). ETH and PAXG are
  excluded by the strategy — the UI must say so, not silently include them.
- Gold section uses `PAXGUSDT`, labelled **"PAXG — gold proxy (Binance)"**.
  It is NOT spot XAUUSD; say so in the UI.

## API contract (backend → frontend)

All JSON. `GET /api/health` → `{status, time, binance:{rest, ws}, uptimeSec}`.

- `GET /api/markets/overview` →
  `{updatedAt, source, symbols:[{symbol, price, change24hPct, high24h,
  low24h, volume24h, quoteVolume24h, fundingRate|null, openInterest|null,
  marketCap:null}]}` (Binance spot has no market cap — return `null`, UI
  shows "—").
- `GET /api/markets/klines?symbol&interval&limit` →
  `{symbol, interval, candles:[{time, open, high, low, close, volume}]}`.
  Intervals: `1m 5m 15m 1h 4h 1d`.
- `GET /api/markets/ticker/:symbol`
- `GET /api/scanner` → `{updatedAt, rows:[{symbol, price, change24hPct,
  rsi14_4h, atr14_4h, sma20, sma50, regime:'RANGING'|'TRENDING_UP'|
  'TRENDING_DOWN', rangeWidthAtr, volumeSpike:boolean,
  signal:'LONG_SETUP'|'SHORT_SETUP'|'NONE', reason}]}`
- `GET /api/signals` → `{updatedAt,
  marketCondition:'BULLISH'|'BEARISH'|'NEUTRAL'|'HIGH_VOLATILITY'|'NO_TRADE',
  signals:[{id, symbol, side:'BUY'|'SELL', entry, stopLoss, takeProfit,
  riskReward:'1:2', confidence, timeframe:'4h', expiresAt, structure,
  reason, invalidation, exitConditions:['SL','TIME 96h','HALT'],
  signalTimestamp, status:'ACTIVE'|'EXPIRED'|'INVALIDATED'}],
  paper:{openPositions, todayPnl, tradesToday, halted, tradingDisabled}}`
  - **TP convention (honest, addendum-corrected):** v3-B has ONE validated
    TP at +2R (3.0×ATR). The API returns a single `takeProfit` — do NOT
    invent TP2/TP3. The validated exits are TP (3.0×ATR) plus SL, TIME
    (96h max hold) and HALT exits (backtest: TP 5 / SL 7 / TIME 4 /
    HALT 1). The breakeven SL move at +1R is a management rule, not a TP.
  - **Confidence:** computed from backtest win rate + setup quality (RSI
    depth, rejection strength, range width in ATRs). Formula documented in
    `docs/strategy.md`. Never random. NO TRADE is a valid output.
- `GET /api/signals/history?limit` → paper trades (from SQLite).
- `GET /api/indicator` → per-symbol v3-B indicator state:
  `{updatedAt, symbols:[{symbol, regime:'RANGING'|'TRENDING', rangeLow,
  rangeHigh, rangeWidthAtr, rsi, distanceToLowAtr, distanceToHighAtr,
  state:'VALID_RANGE'|'APPROACHING_LOW'|'APPROACHING_HIGH'|
  'CONFIRMED_BUY'|'CONFIRMED_SELL'|'BREAKDOWN_AVOID'|
  'UNSUITABLE_TRENDING'|'UNSUITABLE_VOLATILITY'|'NO_TRADE', reason}]}`
- `GET /api/alerts` → `{alerts:[{id,
  type:'BUY_SETUP'|'EXIT_TRIGGER'|'SL_HIT'|'TP_HIT'|'RANGE_INVALID'|
  'VOLATILITY_UNSUITABLE', symbol, message, time, severity:'INFO'|
  'WARNING'|'CRITICAL'}]}` (persisted in SQLite, newest first).
- `GET /api/gold` → `{symbol:'PAXGUSDT', label:'PAXG (gold proxy)', price,
  change24hPct, sessions:{asian:{open,close,active}, london:{...},
  newYork:{...}}, support, resistance, notes}`. Session hours are
  computed from the UTC clock; crypto is never shown as closed.
- `GET /api/news` → `{updatedAt,
  fedEvents:[{id, title, date, time, actual, forecast, previous,
  impact:'HIGH'|'MEDIUM'|'LOW', assets, source, url}],
  cryptoNews:[{title, source, url, publishedAt, summary}],
  status:'LIVE'|'DEGRADED'|'UNAVAILABLE'}`. Fed/economic events come from
  the curated `server/data/fed-events.json` (official sources only:
  federalreserve.gov, BLS, BEA schedules, with source URLs). Crypto news
  from public RSS (CoinDesk/CoinTelegraph). Values are `null` unless the
  source provides them — never invented.
- `GET /api/risk/status` → `{date, tradesToday, lossesToday, realizedToday,
  openPositions, halted, tradingDisabled, dailyLossLimit, riskPerTrade,
  maxDrawdown, cooldownUntil}`
- `POST /api/risk/config` `{dailyLossLimit (20–30), riskPerTrade}` → persisted.
- `GET /api/backtest/variants` → stored results for v1.0, v2.0, v3-A/B/C
  (honest: v1/v2/A/C FAILED, B validated — with numbers).
- `POST /api/backtest/run` `{variant:'b', symbols, days}` → runs the engine,
  returns `{metrics, trades, equity}` and saves a report.
- `GET /api/backtest/reports` + `GET /api/backtest/reports/:id/download`
  (CSV/JSON download).
- `GET /api/settings` → `{dailyLossLimit, riskPerTrade, symbols, refreshSec}`
- `WS /ws` → `{type:'ticker', symbol, price, change24hPct, ts}` broadcasts;
  `{type:'signal', ...}` on a new signal.

## Engines (server/src/engines + server/src/ta)

- **TA indicators** (`ta/`): SMA, RSI(14) Wilder, ATR(14) Wilder, swing
  high/low (20 candles), volume SMA. Closed candles only, no lookahead,
  no repainting.
- **Signal engine** — implements ONLY the validated strategy v3-B
  "Range Mean-Reversion" (`STRATEGY-v3-b.md` in
  `~/workspace/trading/binance-system/`): 4h, ranging regime
  (|SMA20−SMA50| ≤ 1% of close AND range width ≥ 4×ATR), boundary touch
  within 0.5×ATR, RSI extreme <32/>68, rejection candle, volatility guard
  (true range ≤ 2.5×ATR), SL 1.5×ATR, TP 3.0×ATR, $15 risk, max hold 96h.
  Entry at confirmation-candle close.
- **Risk engine** — port of `risk_engine.py` (same constants, same reason
  codes): $15/trade, max 2 entries/day, max 2 concurrent, 2-loss
  anti-revenge stop, daily halt at realized+unrealized ≤ −$20 counting
  open positions, absolute cap −$30 (a day worse than this = NO-GO),
  25% cost filter, $2,000 notional cap, breakeven SL at +1R (never
  widened), TP never moved. `check_entry()` returns `(allowed, reasons)`.
  **Do NOT add the removed "absolute-cap projection" rule** — it is not
  part of the validated design (see PHASE2.md §1/§5).
- **Backtest engine** — port of `backtest_v3.py` logic: chronological
  train/test split, no lookahead, 0.1% fee + 0.05% slippage per side,
  metrics (win rate, profit factor, max drawdown, net P&L, avg R,
  expectancy, trades, fees). Must reproduce v3-B's validated numbers
  (17 trades, 47.1% WR, PF 1.75, +$72.42) on the stored 240-day data.
- **Paper trading** — port of `paper_trade.py` behavior: live 4h candles,
  same signal logic, positions to SL/TP/TIME/HALT, append-only log,
  idempotent. No order code anywhere.

## Persistence (SQLite)

`server/data/terminal.db` (better-sqlite3): `paper_trades`, `signals`,
`settings`, `backtest_reports`. Created on first run; seed `settings`
with `dailyLossLimit=25, riskPerTrade=15`.

## Frontend (client/)

- 11 sections (sidebar nav): Overview, Live Markets, Trading Signals,
  Gold Intelligence, Market Scanner, News & Fed, Advanced Charts,
  Risk Management, Backtesting, Trade History, Settings.
- Overview shows at a glance: market condition, best opportunity, top
  gainers/losers, upcoming events, active signals, daily risk status.
- Charts: TradingView Lightweight Charts (candles + volume + EMA 20/50/200
  + RSI + MACD + Bollinger + ATR + S/R + entry/SL/TP overlays).
- Design: premium dark futuristic institutional terminal (MotionSites.ai
  inspiration): deep black `#05070d`, charcoal panels, glassmorphism
  (`rgba(255,255,255,0.04)`, 1px `rgba(255,255,255,0.08)` borders),
  electric blue `#2f7bff`, cyan `#22d3ee`, violet `#8b5cf6`, green
  `#22c55e`, red `#ef4444`, amber `#f59e0b`. Inter/system font, tabular
  numerals, 16px card radius, subtle glow on active signals, animated
  price ticks, responsive desktop + mobile.
- Every data section shows source + updatedAt; unavailable feeds show an
  UNAVAILABLE badge, never fake data. No empty pages, no fake buttons,
  no placeholder charts.

## File ownership (parallel builders — do not edit outside your area)

- Backend agent: `server/src/**` EXCEPT `server/src/engines/**` and
  `server/src/ta/**`; `server/tsconfig.json`, `server/data/*`.
- Engines agent: `server/src/engines/**`, `server/src/ta/**` (+ their tests).
- Frontend agent: `client/**` (do not edit `client/package.json`).
- Docs agent: `README.md`, `docs/**`, `.env.example`, `.gitignore`,
  `.github/workflows/ci.yml`, root `package.json` scripts only.
- Nobody edits another area's files. Shared contract is this file.
  `server/package.json` and `client/package.json` are FIXED (written by
  the coordinator) — do not change dependencies.

## v3-B Trading Indicator module (addendum — required)

- A dedicated **Trading Indicator** view (own nav item) plus indicator
  overlays on the Advanced Charts page. The strategy is labelled **"v3-B"**
  everywhere it appears; parameters are exactly STRATEGY-v3-b.md — never
  retuned to improve displayed results, no untested filters.
- **Chart indicator:** BUY = range-low / oversold mean-reversion setup;
  SELL/EXIT = the defined mean-reversion exit condition; STOP LOSS =
  clearly marked invalidation level; TP = the single validated TP
  (3.0×ATR) — NO TP2/TP3. NO TRADE when range conditions are invalid.
  Every signal shows entry, SL, TP, R:R, timeframe, signal timestamp.
- **Scanner:** applies the indicator to all supported pairs and classifies
  each as valid range / approaching boundary / confirmed BUY / breaking
  down (avoid) / unsuitable for mean-reversion.
- **Strategy Performance panel:** shows the VERIFIED baseline, labelled
  "historical backtest" and visually separated from live performance:
  **240 days | 17 trades | 47.1% win rate | PF 1.75 | +$72.42 net |
  −1.25% max drawdown**.
- **Alerts:** BUY_SETUP, EXIT_TRIGGER, SL_HIT, TP_HIT, RANGE_INVALID,
  VOLATILITY_UNSUITABLE (see `/api/alerts`).
- **Validation:** the indicator run against the original 240-day backtest
  must reproduce the original signals and results (17 entries, net
  +$72.42 ± $0.05, same fees/slippage/execution rules) — no repainting,
  no look-ahead. A verification report is required at integration.

## Honesty rules (non-negotiable)

- Never display fabricated prices or simulated data as live market data.
- Never claim a strategy is profitable without its backtest evidence —
  v1.0/v2.0/v3-A/v3-C FAILED and their docs say so.
- NO TRADE is a valid signal. Never manufacture signals.
- Never expose API keys (there are none — public data only).
- No live trading, no orders, no withdrawals — intelligence + paper only.
- No Muse.ai anywhere.
