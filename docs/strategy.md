# Strategy — v3-B "Range Mean-Reversion"

**Status: the ONLY validated design in this project.** Pre-registered
(written before any v3 backtest was run), backtested 19 Nov 2026 over
240 days, and advanced to Phase 2 forward paper trading. No live
trading.

Source of truth: `STRATEGY-v3-b.md` in `~/workspace/trading/binance-system/`.
This document is a faithful summary of it for the terminal; if the two
ever disagree, `STRATEGY-v3-b.md` wins.

## 1. The idea in one paragraph

v1.0 and v2.0 were both trend/pullback designs and both lost money. The
240-day window (24 Mar – 19 Nov 2026) turned out to be choppy and
range-bound-to-down: breakouts get faded, trend filters flip late, and
both directions of pullback entries lose. A market that fades breakouts
is, by definition, a market that rewards fading the extremes — so v3-B
tests the opposite family: **mean-reversion inside a range**. It only
trades when there is NO strong trend, and only enters AGAINST the last
move, at a tested range boundary, with an RSI extreme and a rejection
candle as confirmation. No rule from v2.0's entry survives except the
shared indicators (SMA/RSI/ATR/swing levels) and the unchanged risk
engine.

## 2. Scope and hard constraints

| Constraint | Value |
|---|---|
| Markets | **BTCUSDT, SOLUSDT only.** ETH EXCLUDED (0 wins in 18 trades across all v2.0 runs). PAXG EXCLUDED (cost-filter evidence — see §8). |
| Timeframe | **4h** for everything |
| Max trades | 2 entries per UTC day |
| Max concurrent positions | **2 total** |
| Risk per trade | **$15 USDT** |
| Daily loss cap | **$20–30 USDT hard** (daily halt at −$20 counting open positions; worst day must be ≥ −$30) |
| Risk/reward | Fixed **1:2** on every trade (TP = 2 × risk) |
| Stop-loss | Set BEFORE entry, never widened, never moved except to breakeven |
| Revenge trading | After 2 losing trades in a day: STOP — no more entries that day |
| Costs (backtest) | 0.1% taker fee + 0.05% slippage per side (= 0.3% round-trip on notional) |

## 3. Indicators (closed candles only — no lookahead, no repainting)

All on **4h** candles:

- **SMA20(4h)**, **SMA50(4h)** — simple moving averages of 4h closes.
- **RSI(14, 4h)** — Wilder's RSI, 14 periods, on 4h closes.
- **ATR(14, 4h)** — Wilder's ATR, 14 periods, on 4h candles.
- **Swing levels (4h)** — last 20 closed 4h candles, excluding the
  current one: `swing_high = max(high of last 20)`,
  `swing_low = min(low of last 20)`.
- **Range width** = `swing_high − swing_low`.
- **Warm-up:** no signals until **100 closed 4h candles** have passed.
  On the 240-day dataset trading starts ~10 Apr 2026.

## 4. Entry rules — LONG (fade the range low; mirror for SHORT)

All conditions must be true on the same closed 4h candle (the
**confirmation candle**). Entry is at that candle's close.

### 4.1 Ranging regime — NO strong trend (evaluated at each 4h close)

- `|SMA20 − SMA50| ≤ 1.0% of close` (the two averages are flat against
  each other — no strong trend), **AND**
- `range width ≥ 4 × ATR(14,4h)` (the range is wide enough to trade: a
  1.5×ATR stop is less than half the range).
- If either fails → NO trades in either direction for that symbol.

### 4.2 Boundary touch (current or previous 4h candle)

- LONG: `min(low of current and previous 4h candle) ≤ swing_low + 0.5 × ATR`
  (price has probed the range low).
- SHORT: `max(high of current and previous 4h candle) ≥ swing_high − 0.5 × ATR`
  (price has probed the range high).

### 4.3 RSI extreme (over the same 2 candles)

- LONG: `min(RSI(14,4h) over current and previous candle) < 32`.
- SHORT: `max(RSI(14,4h) over current and previous candle) > 68`.
- These are the conventional 30/70 extremes, widened slightly to 32/68
  so the test has enough trades to judge; the values were chosen before
  running and were **NOT tuned to the data**.

### 4.4 Rejection confirmation (current 4h candle)

- LONG: `close > open` AND `close > (high + low) / 2` (the candle
  rejected the low and closed in its upper half), AND `RSI at entry ≤ 40`.
- SHORT: `close < open` AND `close < (high + low) / 2`, AND
  `RSI at entry ≥ 60`.

### 4.5 Volatility guard

- Skip the entry if the confirmation candle's true range
  `> 2.5 × ATR(14,4h)`.

## 5. Position definition — fixed BEFORE entry

Computed at the confirmation candle's close, using that candle's
ATR(14,4h):

- **Entry price** = close of confirmation candle (fill with 0.05%
  slippage against the trader).
- **Stop-loss** = entry − 1.5 × ATR (long) / entry + 1.5 × ATR (short).
  The stop sits just beyond the range boundary that was faded.
- **Take-profit** = entry + 3.0 × ATR (long) / entry − 3.0 × ATR (short).
  → Risk = 1.5 × ATR, reward = 3.0 × ATR, **R:R = 1:2 exactly**.
  (Deliberately the same 1:2 as v2.0 so the ONLY thing varying across
  v3 variants is the entry design. A range-midpoint TP is a different
  design and is NOT tested here.)
- **Position size** = `$15 / (1.5 × ATR)` units of the base asset.
- **Max holding time: 96 hours** (24 × 4h candles). If neither SL nor TP
  is hit within 24 closed 4h candles after entry, exit at the close of
  the 24th candle (exit reason `TIME`).

### Trade management after entry

- **SL is never widened and never removed.** The only permitted move:
  once price has reached 1 × risk in profit (i.e. +1.5 × ATR from
  entry), the SL **MAY** be moved to breakeven (entry price).
- **TP is never moved.** Close at TP when hit; do not hold for more.
  The single validated take-profit is +2R (3.0×ATR) — see
  [docs/api.md](api.md) for the take-profit convention.
- **No adding to a position.** One open position per symbol at a time.
- **No re-entry** in a symbol on the same 4h candle it closed a position.

## 6. Confidence score

`confidence` (0–100, integer) is computed deterministically from the
backtest win rate and setup quality. **It is not a probability of
winning, it was not itself backtested, and it is never random.**
It exists to rank setups, not to predict them. A signal is emitted only
when all entry rules pass; a low score never creates a signal and a high
score never overrides the risk engine.

> **Honesty note:** the pre-registered strategy document
> (`STRATEGY-v3-b.md`) defines the entry, SL/TP and risk rules, but does
> not specify a confidence formula. The formula below is the terminal's
> implementation convention, documented here so it is auditable — not a
> backtested result. Do not quote it as evidence the strategy works.

```
confidence = min(95, 30 + rsiDepth + rejection + rangeWidth)

  rsiDepth   (0–20): LONG:  min(20, (32 − RSI_min) / 32 × 20)
                         SHORT: min(20, (RSI_max − 68) / 32 × 20)
                         Deeper RSI extreme → higher score.
  rejection  (0–25): LONG:  ((close − low) / (high − low)) × 25
                         SHORT: ((high − close) / (high − low)) × 25
                         Stronger close away from the probed
                         boundary → higher score.
  rangeWidth (0–25): min(25, (rangeWidthAtr − 4) / 4 × 25)
                         Wider range (in ATRs) → higher score.
```

- Base `30` reflects that any emitted signal already passed every
  entry rule on a design whose backtest win rate was 47.1%.
- The cap at `95` is deliberate: no setup is ever presented as certain.
- NO TRADE has no score — the absence of a signal is itself the output.

## 7. Validation criteria (pre-registered — all five must pass)

1. Overall net P&L > 0 over the full 240-day window.
2. Net P&L > 0 in **BOTH** calendar halves: H1 = 24 Mar – 21 Jul 2026
   and H2 = 22 Jul – 19 Nov 2026.
3. Profit factor ≥ 1.2.
4. Worst single day ≥ −$30.
5. Win rate ≥ 40%.

v3-B passed **5 of 5**: net +$72.42; H1 +$47.08, H2 +$25.35; PF 1.75;
worst day −$26.57; win rate 47.1%. Full tables:
[docs/backtesting.md](backtesting.md).

## 8. Why v1.0 / v2.0 / v3-A / v3-C failed

All four FAILED and are never traded. Summary — full numbers in
[docs/backtesting.md](backtesting.md):

| Version | Design | Trades | Win rate | Profit factor | Net P&L | Why it failed |
|---|---|---|---|---|---|---|
| v1.0 | Daily-trend pullback (1h) | 158 | 27.2% | 0.43 | **−$826.17** | Weak entry (both directions lose); costs ate small-ATR entries — worst trade −$46.87 on a "$10 risk" trade; daily cap didn't cap open positions (worst day −$69.15); PAXG alone lost −$483.93 at 17.5% WR. |
| v2.0 | 4h trend breakout pullback | 28 | 14.3% | 0.44 | **−$141.25** | Strengthened confirmation made entries WORSE — buying a breakout above the previous five 4h candles' range high buys the top of the range and gets faded; H2 win rate 7.1% (1 of 14). Risk controls fixed the blowups (worst trade −$18.59, drawdown −3.4% vs −18.3%) but the entry collapsed. |
| v3-A | BTC-only trend pullback | 16 | 25.0% | 0.79 | **−$28.41** | The "profitable BTC pocket" from v2.0 (BTC H1, 60% WR, +$47.39 on 5 trades) was H1 noise: v3-A won **0 of 8 trades in H2** (−$66.61). Three pullback confirmations, three losing designs — the pullback family is exhausted. |
| v3-C | Momentum breakout + retest | 50 | 32.0% | 1.02 | **+$9.12** | Positive overall but failed 4 of 5 criteria: H2 −$24.26, win rate 32.0% (< 40%), PF 1.02 (< 1.2), worst day −$34.73 (< −$30). The +$9.12 is entirely a November artifact (+$143.60 in 19 days vs −$134.48 in the prior 220). The retest improved v2.0 (WR 14.3% → 32.0%, PF 0.44 → 1.02) but not enough. |

Also dead (do not revisit without new evidence): ETH (0 wins in 18
v2.0 trades); PAXG under ATR-based stops (v2.0 diagnostic: 19 setups,
18 killed by the cost filter, 0 trades — measured 4h ATR only 0.55% of
price, so round-trip costs run at a median 36.6% of risk); breakout
entries without a retest (v2.0); any version on live capital before a
validating backtest + paper trading.

## 9. Honest caveats on v3-B

These do not overturn the verdict — the pre-registered criteria were
met, all five, with both symbols positive in both halves — but they are
exactly why the next step is paper trading on unseen data, not live
capital:

1. **17 trades is a small sample.** One trade flips the win rate by
   ~6 points. The H2 win rate (41.7%) passes the 40% bar by a single
   trade.
2. **Thin margins on two criteria.** Worst day −$26.57 is $3.43 inside
   the −$30 line; H2 profit factor 1.30 is close to the 1.2 bar. A
   slightly worse draw would fail both.
3. **The best day carries 76% of the profit.** 23 May 2026: BTC long TP
   +$26.98 and SOL long TP +$28.20 on the same day = +$55.19 of the
   +$72.42 net. BUT the result survives removing it: net without the
   best day is **+$17.24** (still positive), and net without the best
   single trade is **+$44.22**. It is concentrated, not carried.
4. **H1 rests on 5 trades.** Its +$47.08 and 4.95 profit factor are not
   evidence of anything on their own; H2 (12 trades) is the real test,
   and it passes — narrowly.
5. **It trades rarely: ~1 trade per 14 days.** Phase 2 paper trading
   will take weeks to accumulate confirming trades.
6. **No November trades.** The strategy took 0 trades in Nov 2026 (to
   the 19th) — the regime filter kept it out. Correct behaviour if the
   market was trending, but it means the most recent data adds no
   confirmation either way.

## 10. Parameters (single set, no optimization)

| Parameter | Value |
|---|---|
| Trend SMAs | 20 / 50 on 4h (ranging iff spread ≤ 1.0% of close) |
| Range | 20-candle swing high/low; width must be ≥ 4×ATR |
| RSI | 14 on 4h; extreme < 32 / > 68 (2-candle window); entry cap ≤ 40 / ≥ 60 |
| ATR | 14 on 4h; SL = 1.5×ATR, TP = 3.0×ATR |
| Boundary touch | Within 0.5×ATR of swing low/high (current or previous candle) |
| Rejection | Close beyond open AND beyond candle midpoint |
| Volatility guard | True range ≤ 2.5 × ATR |
| Max hold | 24 × 4h candles (96h) |
| Risk/trade | $15 |
| Max concurrent | 2 |
| Daily halt | Realized + unrealized ≤ −$20 → close all, stop |
| Cost filter | Round-trip costs ≤ 25% of risk; notional ≤ $2,000 |

No parameter was tuned to the data. The regime, RSI and touch
thresholds were fixed before running.
