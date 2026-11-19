# Verification Report — Crypto Trading Intelligence Terminal

Verified by the coordinator on **19 Nov 2026, ~16:50–17:05 UTC** (22:20–22:35 IST).
Environment: Node v24.22.1, npm 10.9.4, Linux VM. Backend left running on
`http://localhost:3001` (serves the built frontend + API); the Vite dev server
used for screenshots was stopped afterwards.

## 1. Builds & tests

| Check | Result |
|---|---|
| `server: npm run build` (tsc) | ✅ clean |
| `server: npm test` (vitest) | ✅ **99/99 pass** — risk 49, signal 19, backtest 10, indicators 12, paper 9 |
| `client: npm run build` (tsc + Vite) | ✅ clean, 410 modules, ~5 s. Only output: pre-existing Rollup chunk-size warning (>500 kB bundle) |
| `grep tp1\|tp2\|tp3` over `client/src`, `docs/api.md`, `docs/strategy.md`, built JS bundle | ✅ zero matches |
| `grep Muse.ai` over the repo | ✅ zero matches |

## 2. Strategy validation (the addendum requirement)

The v3-B indicator was run against the original 240-day backtest with the
same fees (0.1%/side), slippage (0.05%/side) and execution rules. No
repainting, no look-ahead (closed candles only).

- **Backtest replay (stored data): 17 trades, 8 wins, net +$72.42, PF 1.75,
  win rate 47.1%, worst day −$26.57, halves +$47.08 / +$25.35, exits
  TP 5 / SL 7 / TIME 4 / HALT 1 — exact reproduction of the validated
  result (±$0.05 asserted, exact match).** All 5 pre-registered criteria pass.
- **Paper replay: 17 entries, 17 exits, net +$72.42, same exit split,
  idempotent on re-run, clean audit.**
- v3-A (16 trades, −$28.41), v3-C (50 trades, +$9.12, fails criteria) and
  v2 r15 (28 trades, −$141.25, worst day −$35.01) also reproduce their stored
  numbers.
- v1.0 port is **not bit-exact**: 162 trades / −$710.17 / 29.0% WR vs stored
  158 / −$826.17 / 27.2%. The verdict (large loss, FAILED) matches and the
  worst day reproduces exactly (−$69.15 on 2026-08-16). Stored numbers remain
  authoritative; the port difference is documented in
  `server/src/engines/backtest.ts`.

**Single validated TP:** the signal carries one `takeProfit` (3.0×ATR = +2R)
plus `exitConditions: ['SL', 'TIME 96h', 'HALT']` and `signalTimestamp`.
No TP2/TP3 anywhere in code, docs, or the built bundle.

## 3. Live data observed (real numbers, not placeholders)

19 Nov 2026 ~16:50 UTC, source `binance-rest (https://data-api.binance.vision)`:

| Symbol | Price | 24h |
|---|---|---|
| BTCUSDT | $63,143.64 | +0.93% |
| ETHUSDT | $1,780.66 | +2.11% |
| SOLUSDT | $73.76 | +1.51% |
| BNBUSDT | $586.91 | +1.45% |
| XRPUSDT | $0.9756 | +0.99% |
| DOGEUSDT | $0.05885 | +1.20% |
| TONUSDT | $1.60 | −0.19% |
| PAXGUSDT | $3,684.00 | −1.44% |

- At ~17:05 UTC BTC had moved to **$62,495.37 (−0.61%)** — the feed is live.
- `/api/signals`: `marketCondition: NEUTRAL`, **0 signals — honest NO TRADE**,
  paper `{openPositions: 0, todayPnl: 0, tradesToday: 0, halted: false}`.
  Consistent with zero November trades in the validated backtest.
- `/api/indicator`: 8 symbols — mostly `UNSUITABLE_TRENDING` (BTC RSI 37.6,
  range 3.28×ATR), TON `NO_TRADE`.
- `/api/gold`: PAXG **$3,684 (−1.44%)**, New York session active, labelled
  gold proxy (not spot XAUUSD); support $3,689.60, resistance $3,881.
- `/api/news`: `LIVE` — 63 Fed events + 30 crypto items (latest CoinDesk
  16:09 UTC).
- `/api/risk/status`: 0 trades today, not halted, daily loss limit $25,
  risk/trade $15, source `paper-harness (paper-state.json)`.
- `/api/alerts`: `[]` — correct: no signal transitions yet, paper log has no exits.
- `POST /api/backtest/run {variant:'b', days:30}`: `source: engine-live-run`,
  3 trades, 2 wins, WR 66.7%, PF 14.46, net +$33.83 — the 3 trades reproduce
  the stored v3-B trades exactly (same entry times/prices).

## 4. UI smoke test — all 12 routes

Headless-Chromium pass over every route, zero page errors after fixes:

| Route | Result |
|---|---|
| `/` Overview | ✅ renders, NEUTRAL, NO TRADE, live movers, Fed warnings |
| `/markets` Live Markets | ✅ renders |
| `/signals` Trading Signals | ✅ renders |
| `/indicator` Trading Indicator — v3-B | ✅ renders: NO TRADE cards, indicator state table, alerts feed, verified performance panel |
| `/gold` Gold Intelligence | ✅ renders (after fix — see §5) |
| `/scanner` Market Scanner | ✅ renders |
| `/news` News & Fed | ✅ renders (63 events + 30 items) |
| `/charts` Advanced Charts | ✅ renders, real BTC 4h candles, EMA/volume/RSI |
| `/risk` Risk Management | ✅ renders |
| `/backtest` Backtesting | ✅ renders, all 5 variants with real numbers; live run works |
| `/history` Trade History | ✅ renders |
| `/settings` Settings | ✅ renders |

## 5. Bugs found & fixed during integration verification

1. **Chart time axis showed raw numbers** (e.g. "58728") instead of dates.
   Cause: API returns candle open time in **milliseconds**; the client cast
   it directly to Lightweight Charts `UTCTimestamp` (seconds). Fixed in
   `client/src/pages/Charts.tsx` (ms → s once, shared by candles/volume/
   EMA/BB/RSI/MACD). Re-screenshot confirms real dates (Oct 5 → Nov 17).
2. **Backtest table showed "—" for every number.** Cause: the API nests
   metrics under `v.metrics` (and max drawdown is `maxDrawdownPct`), while
   the page read flat fields; the verdict badge also compared against the
   wrong field (`verdict` is the long text, `status` is FAILED/VALIDATED).
   Fixed in `client/src/pages/Backtest.tsx` + `BacktestVariant` type in
   `client/src/lib/api.ts`. Table now shows: v1.0 158/+27.2%/0.43/−$826.17/
   −18.27%, v2.0 28/+14.3%/0.44/−$141.25/−3.36%, v3-A 16/+25%/0.79/−$28.41/
   −1.32%, **v3-B 17/+47.1%/1.75/+$72.42/−1.25%**, v3-C 50/+32%/1.02/+$9.12/
   −3.87%.
3. **"Run backtest" crashed the page to a black screen.** Cause: the equity
   curve had **duplicate timestamps** (two exits on the same 4h candle) and
   Lightweight Charts requires strictly ascending times; also the equity
   points are `{time: ISO string, equity: number}` while the page expected
   `{time: number, value: number}`. Fixed with ISO → seconds conversion +
   sort + duplicate collapse in `Backtest.tsx`. Also fixed
   `metric('maxDrawdown')` → `metric('maxDrawdownPct')` in the run-result grid.
   Live 240-day run now renders: Net P&L $46.91, WR 38.10%, PF 1.39,
   21 trades, Max DD −1.26%, equity curve + trades table.
4. **Gold page crashed blank** (`data.support.map is not a function`).
   Cause: the API returns `support`/`resistance` as single numbers (nearest
   swing level), the page expected arrays. Fixed defensively in
   `client/src/pages/Gold.tsx`; type updated in `api.ts`.

## 6. Honest discrepancies & known limitations

- **Fresh-data re-run ≠ stored validated result.** A live 240-day re-run
  over fresh Binance data returns **21 trades / +$46.91 / 38.1% WR** vs the
  stored validated **17 trades / +$72.42 / 47.1% WR**. The stored-data replay
  reproduces exactly (§2), so the difference is fresh-data window/coverage
  (klines fetched to "now" vs the stored snapshot ending 19 Nov 12:00 UTC),
  not engine logic. The stored validated numbers remain the reference;
  live re-runs are labelled `engine-live-run` by the API.
- **Binance WebSocket is blocked by this VM's egress proxy**
  (`stream.binance.com:9443` fails the TLS handshake). The server correctly
  reports `DEGRADED` and polls REST every 5s; all data stays live and honest.
  The UI shows the `API DEGRADED · BINANCE LIVE/DEGRADED` badge. If the proxy
  ever allows wss, the wired WS path takes over automatically.
- **No live signal exists right now** (market is trending, not ranging), so
  the Entry/SL/TP overlay lines cannot be shown on a live chart — the chart
  screenshot shows the real chart without signal lines, and the overlay code
  is verified by reading it (it draws Entry/SL/single-TP lines when a signal
  is active). The live signal cards show the honest NO TRADE state.
- **better-sqlite3 on Node 24:** v11.10.0 ships no Node 24 prebuild and the
  source build can fail on `fchown EPERM` in sandboxed environments; the
  workaround is documented in `docs/deployment.md` §8.
- Minor nits: the Overview "Losers" column lists the bottom 3 by 24h change,
  which can include a positive mover (XRP +0.79% appeared under Losers —
  correct as bottom-3, slightly confusing labelling); a favicon 404 appears
  in the dev-server console (harmless); one transient HTTP 502 from the Vite
  proxy was seen once during screenshot runs and did not recur.
- The v1.0 engine port is not bit-exact (see §2).

## 7. Screenshots

In `docs/screenshots/` (captured with headless Chromium against the running
dev server + live backend, 1440×900):

- `01-overview.png` — Overview: NEUTRAL, NO TRADE, live movers, Fed warnings.
- `02-indicator.png` — Trading Indicator v3-B: NO TRADE cards (BTC/SOL),
  indicator state table (all symbols `UNSUITABLE — trending` / `NO_TRADE`).
- `03-charts.png` — Advanced Charts: real BTC/USDT 4h candles, EMA, volume,
  RSI pane, date axis (after fix).
- `04-backtesting.png` — Backtesting: all 5 variants FAILED/VALIDATED with
  real numbers.
- `05-backtest-run.png` — live 240-day v3-B re-run: metrics grid, equity
  curve, trades table.
- `06-gold.png` — Gold Intelligence: PAXG $3,670.00, support $3,689.60,
  resistance $3,881.00, New York session LIVE NOW.

## 8. How to run

```bash
cd crypto-trading-intelligence-terminal
cp .env.example .env        # defaults work locally; no keys needed
cd server && npm install && npm run build && npm start   # :3001, serves API + built frontend
cd ../client && npm install && npm run build              # or `npm run dev` for :5173
npm test   # in server/ — 99 tests
```

No API keys, no live trading, no orders — intelligence + paper trading only.
