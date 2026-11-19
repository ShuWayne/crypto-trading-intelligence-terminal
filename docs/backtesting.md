# Backtesting

How the terminal's backtest engine works, how to run a backtest, how to
read the metrics, and the full, honest results for every variant ever
tested. **Four of the five variants FAILED.** Only v3-B validated — and
even it has not yet passed forward paper trading, so there is no live
trading.

## 1. Engine design

The backtest engine (`server/src/engines/`, ported from
`backtest_v3.py` / `backtest.py` in `~/workspace/trading/binance-system/`)
implements the exact pre-registered strategy rules — the strategy
documents were written **before** any backtest was run.

| Design rule | Implementation |
|---|---|
| Chronological train/test split | Results are reported per calendar half: H1 = 24 Mar – 21 Jul 2026, H2 = 22 Jul – 19 Nov 2026. A variant validates only if net P&L > 0 in **both** halves. There is no random split and no shuffling. |
| No lookahead | All decisions use **closed candles only**. Warm-up: 100 closed 4h candles before the first signal (trading starts ~10 Apr 2026 on the 240-day dataset). |
| No repainting | Indicators (SMA, RSI(14) Wilder, ATR(14) Wilder, 20-candle swing high/low, volume SMA) are computed from closed candles; a signal, once emitted on a closed candle, never changes. |
| Exit convention (conservative) | Within a candle, **SL is checked before TP** — if both would trigger, the loss counts. |
| Fees | 0.1% taker fee per side. |
| Slippage | 0.05% per side, always against the trader. |
| Round-trip cost | 0.3% of notional (fees + slippage, both sides). |
| Start equity | $5,000 (BitFunded Base challenge size — the numbers scale linearly; on a $100 account the same system risks $0.30/trade). |
| Data | Binance public klines via `data-api.binance.vision`, 4h (v1.0: 1h + 4h), 24 Mar – 19 Nov 2026 (240 days, 1,440 candles per symbol, 0 gaps) for v2.0/v3; 22 Jul – 19 Nov 2026 (120 days) for v1.0. |

## 2. How to run a backtest

### In the terminal UI

Backtesting section → choose a variant → choose symbols and days →
Run. The report appears in the list with its metrics and a CSV/JSON
download.

### Via the API

```bash
curl -X POST http://localhost:3001/api/backtest/run \
  -H 'Content-Type: application/json' \
  -d '{"variant": "b", "symbols": ["BTCUSDT", "SOLUSDT"], "days": 240}'
```

`variant`: `v1` | `v2` | `a` | `b` | `c` (default `"b"`).
`days`: 30–240 (default `240`). Response and download endpoints:
[docs/api.md](api.md) § Backtesting.

### Reproducing the reference results

The replay test feeds the stored 240-day data through the
paper-trading harness and must reproduce the v3-B backtest exactly:
**17 entries, 17 exits, 8 wins, net +$72.41 vs backtest +$72.42**
($0.01 = per-trade rounding to cents), entry times identical, exit
reasons identical (TP 5 / SL 7 / TIME 4 / HALT 1), rejects identical
(2× `COST_FILTER` + 1× `DAILY_ENTRY_CAP`). Run it with:

```bash
npm test   # server tests (vitest), includes the replay test
```

## 3. How to read the metrics

| Metric | Meaning |
|---|---|
| Trades | Total entries taken. |
| Wins / losses | Trades closed with net P&L > 0 / < 0 (net of fees). |
| Win rate | Wins ÷ trades. At fixed 1:2 R:R the breakeven win rate is 33.3% before costs, ~40% after costs — which is why the bar is 40%. |
| Average win / average loss | Mean net P&L of winning / losing trades. |
| Gross profit / gross loss | Sum of winning / losing trade P&L. |
| Profit factor (PF) | Gross profit ÷ gross loss. PF ≥ 1.2 is the v3 bar; PF < 1 means the system loses money. |
| Net P&L | Gross profit − gross loss (net of all fees/slippage). |
| Total fees paid | Fees + slippage actually paid. Compare with net P&L: in v1.0 fees were 67% of the net loss. |
| Average R | Mean P&L per trade in units of risk (R = $15 for v2.0/v3, $10 for v1.0). |
| Max drawdown | Largest peak-to-trough equity decline, $ and %. |
| Longest losing streak | Most consecutive losing trades. |
| Exits TP / SL / TIME / HALT | How trades ended: take-profit, stop-loss, 96h max-hold timeout, daily-loss halt close. |
| Best day / worst day | Best/worst single UTC-day net P&L. Worst day must be ≥ −$30. |
| H1 / H2 net | Net P&L in each calendar half — both must be positive. |

## 4. Full results tables

### 4.1 Summary — all variants

| Variant | Design | Trades | Win rate | Profit factor | Net P&L | H1 / H2 | Worst day | Criteria | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| v1.0 | Daily-trend pullback (1h) | 158 | 27.2% | 0.43 | **−$826.17** | all months negative | −$69.15 | 0 of 6 | ❌ FAILED |
| v2.0 (r15 primary) | 4h trend breakout pullback | 28 | 14.3% | 0.44 | **−$141.25** | −$16.64 / −$124.60 | −$35.01 | 1 of 6 | ❌ FAILED |
| v3-A | BTC-only trend pullback | 16 | 25.0% | 0.79 | **−$28.41** | +$38.20 / −$66.61 | −$18.59 | 1 of 5 | ❌ FAILED |
| **v3-B** | **Range mean-reversion** | **17** | **47.1%** | **1.75** | **+$72.42** | **+$47.08 / +$25.35** | **−$26.57** | **5 of 5** | ✅ **VALIDATED** |
| v3-C | Momentum breakout + retest | 50 | 32.0% | 1.02 | **+$9.12** | +$33.38 / −$24.26 | −$34.73 | 1 of 5 | ❌ FAILED |

### 4.2 v1.0 — "Daily-Trend Pullback" ❌ FAILED

120 days (22 Jul – 19 Nov 2026), 1h + 4h, $10 risk/trade, start $5,000.

| Metric | Value |
|---|---|
| Total trades | 158 (BTC 47, ETH 37, SOL 34, PAXG 40) |
| Wins / losses | 43 / 115 |
| Win rate | **27.2%** (breakeven needed ~40% after costs) |
| Average win / loss | +$14.26 / −$12.52 |
| Gross profit / gross loss | $613.16 / $1,439.33 |
| Profit factor | **0.43** |
| Net P&L | **−$826.17** |
| Total fees + slippage | **$555.81 (67% of the net loss)** |
| Average R | −0.52R |
| Start / end equity | $5,000.00 → **$4,173.83 (−16.5%)** |
| Max drawdown | −$915.65 (−18.3%) |
| Longest losing streak | 12 trades |
| Exits TP / SL / TIME | 40 / 111 / 5 (+ 2 closed at end of data) |
| Best day / worst day | +$52.56 (12 Nov) / **−$69.15 (16 Aug)** |

Per symbol: BTC −$170.45 (31.9% WR), ETH −$123.01 (29.7%),
SOL −$48.78 (29.4%), **PAXG −$483.93 (17.5% WR — 59% of the total
loss)**. Longs 22.2% WR, shorts 30.5% WR — **both directions lose**.

Failure modes (verified): (a) costs ate small-ATR entries — worst
trade PAXG long 16 Aug, **−$46.87 on a "$10 risk" trade** (ATR $2.37 →
notional $12,302 → fees $24.58 + slippage ~$12.30); 70 of 158 trades
paid fees > 30% of risk. Even with zero fees the strategy would still
be down ~−$270 (PF ~0.57). (b) The daily loss cap didn't cap daily
loss — worst day −$69.15, because the cap only blocked NEW entries
while positions opened on previous days all exited the same day
(up to 4 open at once).

### 4.3 v2.0 — "4h Trend Breakout Pullback" ❌ FAILED

240 days (24 Mar – 19 Nov 2026), 4h, $15 risk/trade, start $5,000.
Primary run r15 (max 2 concurrent); other runs in parentheses.

| Metric | r15 PRIMARY | r20 ($20, max 1 conc.) | r12 ($12, max 2 conc.) | w30 (SL 3×ATR, 10% filter) |
|---|---|---|---|---|
| Total trades | **28** | 20 | 27 | 23 |
| Wins / losses | 4 / 24 | 4 / 16 | 4 / 23 | 9 / 14 |
| Win rate | **14.3%** | 20.0% | 14.8% | 39.1% |
| Average win / loss | +$27.46 / −$10.46 | +$36.62 / −$14.29 | +$21.97 / −$8.52 | +$11.48 / −$10.82 |
| Profit factor | **0.44** | 0.64 | 0.45 | 0.68 |
| Net P&L | **−$141.25** | −$82.19 | −$108.12 | −$48.14 |
| Max drawdown | −$168.76 (−3.4%) | −$148.13 (−3.0%) | −$130.13 (−2.6%) | −$98.05 (−1.9%) |
| Longest losing streak | 10 | 8 | 10 | 8 |
| Exits TP / SL / TIME / HALT | 4 / 22 / 0 / 2 | 4 / 16 / 0 / 0 | 4 / 23 / 0 / 0 | 1 / 5 / 14 / 3 |
| Best / worst day | +$27.47 / **−$35.01** | +$36.80 / −$24.78 | +$21.98 / −$28.01 | +$39.30 / −$23.07 |
| H1 / H2 net | −$16.64 / −$124.60 | +$36.42 / −$118.61 | −$8.44 / −$99.68 | +$33.89 / −$82.03 |

Validation (r15): **1 of 6 criteria pass** (only max drawdown < 10%).
ETH won **0 of 8 trades** (0 in 18 across r15+r20+r12); BTC H1 was the
only profitable pocket (5 trades, 60% WR, +$47.39) and BTC H2 was its
mirror (6 trades, 0 wins, −$62.55).

What the risk controls fixed: cost blowups gone (worst trade −$18.59
vs −$46.87 in v1.0), drawdown −3.4% vs −18.3%, PAXG produced ZERO
trades under the cost filter (19 setups → 18 cost-filter skips).
What failed: the entry. Requiring a close above the previous five 4h
candles' range high means entering AFTER a 20-hour rally leg — buying
the top of the range in a market that fades breakouts. H2 win rate
7.1% (1 of 14).

### 4.4 v3-A — "BTC-Only Trend Pullback" ❌ FAILED

240 days, 4h, BTC only, $15 risk, start $5,000.

| Metric | Value |
|---|---|
| Total trades | 16 (BTC only) |
| Wins / losses | 4 / 12 |
| Win rate | **25.0%** (needs ≥ 40%) |
| Average win / loss | +$27.39 / −$11.50 |
| Gross profit / gross loss | $109.57 / $137.98 |
| Profit factor | **0.79** (needs ≥ 1.2) |
| Net P&L | **−$28.41** |
| Total fees paid | $30.49 |
| Average R | −0.12R |
| Start / end equity | $5,000.00 → $4,971.59 (−0.57%) |
| Max drawdown | −$66.61 (−1.32%) |
| Longest losing streak | 8 trades |
| Exits TP / SL / TIME / HALT | 4 / 12 / 0 / 0 |
| Best day / worst day | +$27.51 (14 Apr) / −$18.59 (13 Oct) |
| H1 / H2 | +$38.20 (50.0% WR) / **−$66.61 (0.0% WR — 0 of 8)** |

Validation: **1 of 5 pass** (only the daily cap). All 4 wins came in H1;
the last win was 24 Jun 2026, then 8 consecutive losses. The "profitable
BTC pocket" that motivated v3-A was pure H1 noise.

### 4.5 v3-B — "Range Mean-Reversion" ✅ VALIDATED

240 days, 4h, BTC + SOL, $15 risk, start $5,000. Full rules:
[docs/strategy.md](strategy.md).

| Metric | Value |
|---|---|
| Total trades | **17** (BTC 9, SOL 8) |
| Wins / losses | 8 / 9 |
| Win rate | **47.1%** (needs ≥ 40%) |
| Average win / loss | +$21.06 / −$10.68 |
| Gross profit / gross loss | $168.51 / $96.09 |
| Profit factor | **1.75** (needs ≥ 1.2) |
| Net P&L | **+$72.42** |
| Total fees paid | $28.16 (29% of gross loss) |
| Average R | +0.28R |
| Start / end equity | $5,000.00 → **$5,072.42 (+1.45%)** |
| Max drawdown | −$64.00 (−1.25%) |
| Longest losing streak | 5 trades |
| Exits TP / SL / TIME / HALT | 5 / 7 / 4 / 1 |
| Breakeven SL moves | 10 of 17 trades |
| Best day / worst day | +$55.19 (23 May) / **−$26.57 (8 Oct)** |

Validation: **5 of 5 pass** — net > 0; H1 +$47.08 and H2 +$25.35 both
positive; PF 1.75; worst day −$26.57 ≥ −$30; WR 47.1%.

Per half/symbol: H1 5 trades, 60.0% WR, +$47.08, PF 4.95; H2 12 trades,
41.7% WR, +$25.35, PF 1.30. BTC +$32.45 (44.4%), SOL +$39.97 (50.0%).
All four symbol-half cells positive. Monthly: Apr +$3.81, May +$55.19,
Jun −$10.60, Jul +$53.88, Aug −$17.66, Sep −$16.35, Oct +$4.14,
Nov $0.00 (0 trades). Exit P&L: TP 5 trades +$137.32; TIME 4 trades
+$20.60; SL 7 trades −$76.04; HALT 1 trade −$9.46.

Caveats (mandatory reading): 17 trades is a small sample; H2 win rate
passes by one trade; worst day passes by $3.43; the best day carries
76% of the profit (net without it is still +$17.24); ~1 trade per 14
days; zero November trades. See [docs/strategy.md](strategy.md) §9.

### 4.6 v3-C — "Momentum Breakout with Retest" ❌ FAILED

240 days, 4h, BTC + SOL, $15 risk, start $5,000.

| Metric | Value |
|---|---|
| Total trades | 50 (BTC 22, SOL 28) |
| Wins / losses | 16 / 34 |
| Win rate | **32.0%** (needs ≥ 40%) |
| Average win / loss | +$25.31 / −$11.64 |
| Gross profit / gross loss | $404.94 / $395.82 |
| Profit factor | **1.02** (needs ≥ 1.2) |
| Net P&L | **+$9.12** |
| Total fees paid | $65.20 |
| Average R | +0.01R |
| Start / end equity | $5,000.00 → $5,009.12 (+0.18%) |
| Max drawdown | −$195.96 (−3.87%) |
| Longest losing streak | 14 trades |
| Exits TP / SL / TIME / HALT | 13 / 28 / 4 / 5 |
| Best day / worst day | +$29.06 (4 Jun) / **−$34.73 (11 Sep)** |
| H1 / H2 | +$33.38 (32.1% WR) / **−$24.26 (31.8% WR)** |

Validation: **1 of 5 pass** (only overall net > 0). The +$9.12 is an
artifact of a single month: November alone made +$143.60 (6 wins of 7
trades) while the previous 220 days netted −$134.48. BTC loses in both
halves (−$38.43); SOL carries the design (PF 1.21) and is breakeven in
H2 (PF 1.04). The retest idea was a real improvement over v2.0 (WR
14.3% → 32.0%, PF 0.44 → 1.02) but not enough: 32% at 1:2 R:R cannot
break even after costs, and the same-candle double-SL hole produced a
−$34.73 day.

## 5. Report formats

Every backtest run saves a report (SQLite `backtest_reports`) and can
be downloaded:

- **CSV** — `GET /api/backtest/reports/:id/download?format=csv`:
  one row per trade (`id, symbol, side, entry, exit, entryTime,
  exitTime, exitReason, pnl, fees`) plus a metrics header.
- **JSON** — `GET /api/backtest/reports/:id/download?format=json`:
  the full report object (`{ reportId, variant, metrics, trades,
  equity }`).

The reference outputs for the original Phase 1 runs live in
`~/workspace/trading/binance-system/` (`trades-v3-a/b/c.csv`,
`equity-v3-a/b/c.csv`, `metrics-v3-a/b/c.json`, and the v1.0/v2.0
equivalents).

## 6. Out-of-sample / forward paper-trading requirement

A backtest — even a validating one — is not proof. It is a filter that
caught four losing designs before any real money touched them. The
v3-B validation has thin margins (see §4.5 caveats), so the design must
now prove itself on **unseen forward data**:

1. **Minimum 2 weeks of forward paper trading** (from 19 Nov 2026),
   run every 4h (5 minutes after each 4h candle close) with no missed days.
2. **At least 5 closed paper trades** (at ~1 trade/14 days this may take
   longer than 2 weeks — do not rush it).
3. **Zero rule violations** in the paper-trade log.
4. **No paper day worse than −$30**.
5. **Paper P&L ≥ $0**, with win rate ≥ 40% if ≥ 5 trades exist.
6. **No missed halt.**

Full GO/NO-GO criteria: [docs/risk.md](risk.md) §4. A losing paper run
sends v3-B back to the drawing board — it does not get "fixed" by
tweaking parameters. **No live trading until paper trading confirms
and Shu explicitly decides otherwise.**
