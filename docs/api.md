# API Reference

All endpoints are served by the backend on `http://localhost:3001`.
In development the Vite dev server (port 5173) proxies `/api` and `/ws`
to the backend, so the frontend uses relative paths.

- All responses are JSON.
- Every market-data response carries `updatedAt` (ISO 8601 UTC) and
  `source` (which Binance endpoint served it, e.g.
  `"data-api.binance.vision"`). The UI shows connection status and
  last-updated time on every data section.
- There is **no authentication and no API key**: all data is Binance
  public data. There are no order/trade-execution endpoints anywhere —
  this terminal is intelligence + paper trading only.
- Timestamps are UTC unless stated otherwise.

## Conventions

### Single validated take-profit — read this before using signal targets

Strategy v3-B has **ONE validated take-profit**: +2R, i.e. 3.0×ATR from
entry. The API returns a single `takeProfit` field — there are no
additional take-profit levels. The validated exits are:

| Exit | Meaning |
|---|---|
| `TP` | **+2R (3.0×ATR)** — **the validated target.** The backtest's TP exits (5 of 17 trades, +$137.32) were all at this level. |
| `SL` | −1R (1.5×ATR) — the stop-loss, set before entry and never widened. |
| `TIME` | 96h max hold — exit at the close of the 24th 4h candle if neither TP nor SL has hit. |
| `HALT` | Daily-loss halt close (realized + unrealized ≤ −$20). |

The breakeven SL move at +1R is a trade-management rule, not an exit
target: once price reaches +1.5×ATR from entry the stop-loss **may** be
moved to breakeven (entry price). It is not a validated exit and the API
does not expose it as a target.

Why: the pre-registered v3-B rules fix R:R at exactly 1:2 (SL 1.5×ATR,
TP 3.0×ATR) so that the only thing varying across the v3 variants was
the entry design. Exiting at any other level would be a different
strategy that has never been backtested. TP is never moved after entry.

### Status values

- Connection / feed status: `LIVE` | `DEGRADED` | `UNAVAILABLE`.
  `DEGRADED` means the WebSocket failed and the server fell back to REST
  polling every 5s. `UNAVAILABLE` means REST also failed — the UI shows
  a badge and never invents data.
- Signal status: `ACTIVE` | `EXPIRED` | `INVALIDATED`.
- Market condition: `BULLISH` | `BEARISH` | `NEUTRAL` |
  `HIGH_VOLATILITY` | `NO_TRADE`. `NO_TRADE` is a valid output.

### Error codes

Errors are JSON: `{ "error": { "code": "...", "message": "..." } }`.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad or missing query/body parameters (e.g. unknown symbol, bad interval, `dailyLossLimit` outside 20–30). |
| 404 | `NOT_FOUND` | Unknown route, unknown symbol in a path param, or unknown backtest report id. |
| 429 | `RATE_LIMITED` | Caller exceeded the rate limit (see below). |
| 502 | `UPSTREAM_ERROR` | Binance REST/WS unreachable; the response also carries `status: "UNAVAILABLE"`. Retry later — the server never fabricates data to fill the gap. |
| 500 | `INTERNAL_ERROR` | Unexpected server error. |

### Rate limits

The terminal is a local, single-user tool; limits are generous and exist
to protect the upstream Binance public endpoints, not to meter users:

| Scope | Limit |
|---|---|
| REST API (all `/api/*` combined) | 120 requests / minute per client IP |
| `POST /api/backtest/run` | 5 runs / minute (backtests are CPU-heavy) |
| WebSocket `/ws` | 1 connection per client; broadcasts are throttled to 1 message / second per symbol |

Exceeding a limit returns `429 RATE_LIMITED` with a `Retry-After`
header (seconds). The frontend backs off automatically; polling
intervals are configurable in Settings (`refreshSec`).

---

## Health

### `GET /api/health`

```json
{
  "status": "ok",
  "time": "2026-11-19T16:30:00.000Z",
  "binance": { "rest": "LIVE", "ws": "LIVE" },
  "uptimeSec": 3600
}
```

`status` is `"ok"` while the server is up even if Binance is down —
check `binance.rest` / `binance.ws` for upstream health.

---

## Markets

### `GET /api/markets/overview`

```json
{
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "source": "data-api.binance.vision",
  "symbols": [
    {
      "symbol": "BTCUSDT",
      "price": 62885.5,
      "change24hPct": -2.41,
      "high24h": 64510.0,
      "low24h": 62063.0,
      "volume24h": 18234.56,
      "quoteVolume24h": 1148234567.89,
      "fundingRate": 0.0001,
      "openInterest": 123456789.0,
      "marketCap": null
    }
  ]
}
```

Symbols covered: `BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT,
TONUSDT, PAXGUSDT`. `fundingRate` / `openInterest` are `null` when the
upstream does not provide them for a symbol. `marketCap` is always
`null` — Binance spot has no market cap; the UI shows "—".

### `GET /api/markets/klines?symbol=BTCUSDT&interval=4h&limit=100`

```json
{
  "symbol": "BTCUSDT",
  "interval": "4h",
  "candles": [
    { "time": 1763568000000, "open": 63000.0, "high": 63200.0,
      "low": 62500.0, "close": 62885.5, "volume": 123.45 }
  ]
}
```

- `interval`: `1m | 5m | 15m | 1h | 4h | 1d` (default `4h`).
- `limit`: 1–1000 (default `100`).
- `time` is the candle open time in epoch milliseconds. Only closed
  candles are used for indicators and signals — never the forming candle.

### `GET /api/markets/ticker/:symbol`

```json
{
  "symbol": "SOLUSDT",
  "price": 142.35,
  "change24hPct": 1.12,
  "high24h": 145.0,
  "low24h": 138.2,
  "volume24h": 987654.32,
  "quoteVolume24h": 140123456.78,
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "source": "data-api.binance.vision"
}
```

Unknown symbol → `404 NOT_FOUND`.

---

## Scanner

### `GET /api/scanner`

```json
{
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "rows": [
    {
      "symbol": "BTCUSDT",
      "price": 62885.5,
      "change24hPct": -2.41,
      "rsi14_4h": 28.4,
      "atr14_4h": 512.3,
      "sma20": 64100.0,
      "sma50": 64800.0,
      "regime": "RANGING",
      "rangeWidthAtr": 5.8,
      "volumeSpike": false,
      "signal": "LONG_SETUP",
      "reason": "Range low touched, RSI 28.4 < 32, rejection candle"
    }
  ]
}
```

- `regime`: `RANGING` | `TRENDING_UP` | `TRENDING_DOWN` (from the
  |SMA20−SMA50| spread; see [docs/strategy.md](strategy.md)).
- `signal`: `LONG_SETUP` | `SHORT_SETUP` | `NONE`. A setup here is a
  scanner observation, not an executed trade — entries still pass the
  full risk-engine checklist.
- `reason` is a human-readable string explaining the row's state; it is
  empty when there is nothing notable.

---

## Signals

### `GET /api/signals`

```json
{
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "marketCondition": "NEUTRAL",
  "signals": [
    {
      "id": "sig-btc-20261119-1200",
      "symbol": "BTCUSDT",
      "side": "BUY",
      "entry": 62885.5,
      "stopLoss": 62117.0,
      "takeProfit": 64422.5,
      "riskReward": "1:2",
      "confidence": 72,
      "timeframe": "4h",
      "expiresAt": "2026-11-23T12:00:00.000Z",
      "structure": "Range low 62063 (20-candle swing low), RSI 28.4, rejection close in upper half",
      "reason": "Ranging regime, boundary touch within 0.5xATR, RSI extreme, rejection confirmed",
      "invalidation": "4h close below swing low minus 0.5xATR, or regime flip to trending",
      "exitConditions": ["SL", "TIME 96h", "HALT"],
      "signalTimestamp": "2026-11-19T12:00:00.000Z",
      "status": "ACTIVE"
    }
  ],
  "paper": {
    "openPositions": 0,
    "todayPnl": 0.0,
    "tradesToday": 0,
    "halted": false,
    "tradingDisabled": false
  }
}
```

Notes:

- Signals are generated **only for BTCUSDT and SOLUSDT** (the validated
  v3-B symbols). ETH and PAXG are excluded by the strategy; the UI must
  say so, not silently include them.
- `entry` is the confirmation-candle close; `stopLoss` = entry ∓
  1.5×ATR; `takeProfit` = entry ± 3.0×ATR (the single validated target,
  +2R). `riskReward` is always `"1:2"` for v3-B.
- `exitConditions` lists the validated exits: `SL`, `TIME 96h` (max
  hold), `HALT` (daily-loss halt close). `signalTimestamp` is when the
  confirmation candle closed and the signal was generated.
- `confidence` is an integer 0–100 computed deterministically from the
  backtest win rate and setup quality (RSI depth, rejection strength,
  range width in ATRs). Formula: [docs/strategy.md](strategy.md) §6.
  It is **not** a probability of winning and it is never random. A
  signal with no setup is not emitted at all — `signals: []` with
  `marketCondition: "NO_TRADE"` is the honest response.
- `expiresAt` is entry + 96h (the max hold); after expiry the signal
  becomes `EXPIRED`.
- `paper.tradingDisabled` is `true` when the daily risk state blocks
  new entries (halted day, 2 losses, or daily realized loss ≤ −$20).
  See [docs/risk.md](risk.md).

### `GET /api/signals/history?limit=50`

Paper trades from SQLite (append-only log), newest first.

```json
{
  "trades": [
    {
      "id": "btc-20260523-1200-long",
      "symbol": "BTCUSDT",
      "side": "long",
      "entry": 102340.0,
      "exit": 105410.0,
      "entryTime": "2026-05-23T12:00:00.000Z",
      "exitTime": "2026-05-24T08:00:00.000Z",
      "exitReason": "TP",
      "pnl": 26.98,
      "fees": 2.1,
      "status": "CLOSED"
    }
  ]
}
```

- `exitReason`: `TP` | `SL` | `TIME` (96h max hold) | `HALT`
  (daily-loss halt close).
- `limit`: 1–500 (default `50`).

---

## Indicator

### `GET /api/indicator`

Per-symbol v3-B indicator state (4h, closed candles only), for all 8
tracked symbols. `CONFIRMED_BUY` / `CONFIRMED_SELL` never fire for
symbols outside the validated universe (BTCUSDT + SOLUSDT) — their
range state is still reported, downgraded to `APPROACHING_*`.

```json
{
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "source": "data-api.binance.vision",
  "status": "LIVE",
  "strategy": "v3-B Range Mean-Reversion (4h, closed candles only)",
  "symbols": [
    {
      "symbol": "BTCUSDT",
      "regime": "RANGING",
      "rangeLow": 62063.0,
      "rangeHigh": 64800.0,
      "rangeWidthAtr": 5.8,
      "rsi": 28.4,
      "distanceToLowAtr": 0.3,
      "distanceToHighAtr": 5.5,
      "state": "APPROACHING_LOW",
      "reason": "Range low touched, RSI 28.4 < 32, rejection candle"
    }
  ]
}
```

- `regime`: `RANGING` | `TRENDING` (|SMA20−SMA50| spread; see
  [docs/strategy.md](strategy.md)).
- `rangeLow` / `rangeHigh`: 20-candle swing low/high (`null` until 20
  prior candles exist). `rangeWidthAtr`: range width in ATRs.
- `distanceToLowAtr` / `distanceToHighAtr`: current price distance to
  each boundary, in ATRs.
- `state`: `VALID_RANGE` | `APPROACHING_LOW` | `APPROACHING_HIGH` |
  `CONFIRMED_BUY` | `CONFIRMED_SELL` | `BREAKDOWN_AVOID` |
  `UNSUITABLE_TRENDING` | `UNSUITABLE_VOLATILITY` | `NO_TRADE`.
- `reason` is a human-readable string explaining the state.

### `GET /api/alerts`

Alert feed, persisted in SQLite, newest first. Alerts fire on real
state transitions only — never fabricated. `?limit=` 1–200 (default
`50`); `?symbol=` filters to one symbol.

```json
{
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "alerts": [
    {
      "id": "BUY_SETUP:BTCUSDT:1763568000000",
      "type": "BUY_SETUP",
      "symbol": "BTCUSDT",
      "message": "BTCUSDT: Range low touched, RSI 28.4 < 32, rejection candle",
      "time": "2026-11-19T16:30:00.000Z",
      "severity": "INFO"
    }
  ]
}
```

- `type`: `BUY_SETUP` | `EXIT_TRIGGER` | `SL_HIT` | `TP_HIT` |
  `RANGE_INVALID` | `VOLATILITY_UNSUITABLE`.
- `severity`: `INFO` | `WARNING` | `CRITICAL`.

---

## Gold

### `GET /api/gold`

```json
{
  "symbol": "PAXGUSDT",
  "label": "PAXG (gold proxy)",
  "price": 3710.25,
  "change24hPct": -0.84,
  "sessions": {
    "asian":   { "open": 3695.0, "close": 3710.25, "active": false },
    "london":  { "open": 3702.0, "close": 3710.25, "active": true },
    "newYork": { "open": null,   "close": null,    "active": false }
  },
  "support": 3693.0,
  "resistance": 3890.0,
  "notes": "PAXG is a gold proxy traded on Binance, not spot XAUUSD. Crypto markets never close; session hours are computed from the UTC clock."
}
```

Session hours are computed from the UTC clock; crypto is never shown
as closed. `support` / `resistance` are recent swing levels from 4h
candles. `open`/`close` are `null` for a session that has not started.

---

## News & Fed

### `GET /api/news`

```json
{
  "updatedAt": "2026-11-19T16:30:00.000Z",
  "fedEvents": [
    {
      "id": "fomc-2026-12-09",
      "title": "FOMC meeting — rate decision",
      "date": "2026-12-09",
      "time": "19:00 UTC",
      "actual": null,
      "forecast": null,
      "previous": "3.75–4.00%",
      "impact": "HIGH",
      "assets": ["BTC", "PAXG", "USD"],
      "source": "federalreserve.gov",
      "url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
    }
  ],
  "cryptoNews": [
    {
      "title": "Bitcoin steadies near $62,000 after sell-off",
      "source": "CoinDesk",
      "url": "https://www.coindesk.com/...",
      "publishedAt": "2026-11-19T15:00:00.000Z",
      "summary": "BTC holds the $62,000 zone after a sharp decline..."
    }
  ],
  "status": "LIVE"
}
```

- Fed/economic events come from the curated `server/data/fed-events.json`
  (official sources only: federalreserve.gov, BLS, BEA schedules, with
  source URLs). `actual` / `forecast` are `null` unless the source
  provides them — never invented.
- Crypto news comes from public RSS (CoinDesk / CoinTelegraph).
- `status`: `LIVE` | `DEGRADED` | `UNAVAILABLE`. `DEGRADED` means one
  source failed (e.g. RSS down) while the other still serves;
  `UNAVAILABLE` means neither source responded.

---

## Risk

### `GET /api/risk/status`

```json
{
  "date": "2026-11-19",
  "tradesToday": 0,
  "lossesToday": 0,
  "realizedToday": 0.0,
  "openPositions": 0,
  "halted": false,
  "tradingDisabled": false,
  "dailyLossLimit": 25,
  "riskPerTrade": 15,
  "maxDrawdown": 0.0,
  "cooldownUntil": null
}
```

- `date` is the UTC calendar day the counters belong to.
- `tradingDisabled` is `true` when no new paper entries may open today
  (halted, 2 losses, or realized loss ≤ −$20).
- `cooldownUntil` is an ISO timestamp when a cooldown is active, else
  `null`.

### `POST /api/risk/config`

Request body:

```json
{ "dailyLossLimit": 25, "riskPerTrade": 15 }
```

- `dailyLossLimit`: 20–30 (inclusive). Outside that range →
  `400 VALIDATION_ERROR`.
- `riskPerTrade`: positive number (USD). The validated value is `15`;
  changing it means paper trading no longer tests the validated design,
  and the UI warns accordingly.
- Response: the persisted settings object (same shape as
  `GET /api/settings`).

---

## Backtesting

### `GET /api/backtest/variants`

Stored results for all five tested variants — honest, including the
failures:

```json
{
  "variants": [
    {
      "variant": "v1.0",
      "name": "Daily-Trend Pullback",
      "trades": 158,
      "winRate": 27.2,
      "profitFactor": 0.43,
      "netPnl": -826.17,
      "worstDay": -69.15,
      "verdict": "FAILED"
    },
    {
      "variant": "v3-b",
      "name": "Range Mean-Reversion",
      "trades": 17,
      "winRate": 47.1,
      "profitFactor": 1.75,
      "netPnl": 72.42,
      "worstDay": -26.57,
      "verdict": "VALIDATED"
    }
  ]
}
```

Full tables: [docs/backtesting.md](backtesting.md). v1.0, v2.0, v3-A
and v3-C are `FAILED`; only v3-B is `VALIDATED`.

### `POST /api/backtest/run`

Request body:

```json
{ "variant": "b", "symbols": ["BTCUSDT", "SOLUSDT"], "days": 240 }
```

- `variant`: `v1` | `v2` | `a` | `b` | `c` (default `"b"`).
  Only `"b"` is the validated design; other variants are available for
  comparison and research, never for trading.
- `symbols`: subset of the supported symbols (default: the variant's
  validated symbols).
- `days`: 30–240 (default `240`).

Response:

```json
{
  "reportId": "bt-20261119-163000-b",
  "variant": "b",
  "metrics": {
    "trades": 17, "wins": 8, "losses": 9, "winRate": 47.1,
    "profitFactor": 1.75, "netPnl": 72.42, "avgWin": 21.06,
    "avgLoss": -10.68, "maxDrawdown": -64.0, "avgR": 0.28,
    "expectancy": 4.26, "fees": 28.16, "bestDay": 55.19,
    "worstDay": -26.57
  },
  "trades": [ "... full trade list ..." ],
  "equity": [ { "time": 1763510400000, "equity": 5000.0 } ]
}
```

The report is saved to SQLite and listed by
`GET /api/backtest/reports`. A run of variant `b` on the stored 240-day
data must reproduce the validated numbers (17 trades, 47.1% WR, PF
1.75, +$72.42) — the replay test enforces this.

### `GET /api/backtest/reports`

```json
{
  "reports": [
    {
      "id": "bt-20261119-163000-b",
      "variant": "b",
      "createdAt": "2026-11-19T16:30:00.000Z",
      "trades": 17,
      "netPnl": 72.42,
      "formats": ["csv", "json"]
    }
  ]
}
```

### `GET /api/backtest/reports/:id/download?format=csv`

Downloads the report as CSV (`format=csv`) or JSON (`format=json`).
Unknown id → `404 NOT_FOUND`. Unknown format → `400 VALIDATION_ERROR`.

---

## Settings

### `GET /api/settings`

```json
{
  "dailyLossLimit": 25,
  "riskPerTrade": 15,
  "symbols": ["BTCUSDT", "SOLUSDT"],
  "refreshSec": 5
}
```

Seeded on first run with `dailyLossLimit=25, riskPerTrade=15`.
`symbols` here are the signal-engine symbols (BTCUSDT + SOLUSDT);
the overview/scanner always cover the full 8-symbol list.

---

## WebSocket — `WS /ws`

Connect to `ws://localhost:3001/ws` (in development,
`ws://localhost:5173/ws` via the Vite proxy).

Server → client messages:

```json
{ "type": "ticker", "symbol": "BTCUSDT", "price": 62885.5,
  "change24hPct": -2.41, "ts": 1763567400000 }
```

```json
{ "type": "signal", "id": "sig-btc-20261119-1200", "symbol": "BTCUSDT",
  "side": "BUY", "entry": 62885.5, "stopLoss": 62117.0,
  "takeProfit": 64422.5,
  "confidence": 72, "status": "ACTIVE", "ts": 1763567400000 }
```

- `ticker` broadcasts fire on price updates (throttled to 1/second per
  symbol).
- `signal` broadcasts fire only when a new signal is generated. No
  signal is ever manufactured to fill silence — an empty market emits
  nothing.
- If the WebSocket fails, the server falls back to REST polling every
  5s and reports status `DEGRADED`; the client shows this. If REST
  also fails, status is `UNAVAILABLE`.
