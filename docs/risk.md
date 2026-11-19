# Risk Management

Every rule in this document comes from `risk_engine.py` and `PHASE2.md`
in `~/workspace/trading/binance-system/` (the v2.0 risk engine,
unchanged for v3-B). The terminal ports the same constants and the same
reason codes. **Paper trading only — there is no execution path, so
these rules gate paper entries, not real orders.**

## 1. The rules (all of them)

| # | Rule | Value | Reason code |
|---|---|---|---|
| 1 | Risk per trade | **$15 USDT**, fixed 1:2 R:R (SL 1.5×ATR, TP 3.0×ATR) | — |
| 2 | Max entries | **2 per UTC calendar day** | `DAILY_ENTRY_CAP` |
| 3 | Max concurrent positions | **2 total** (not per symbol) | `CONCURRENT_CAP` |
| 4 | One position per symbol | At most one open position per symbol at a time | `SYMBOL_ALREADY_OPEN` |
| 5 | Anti-revenge | After **2 losing trades in a day**: no more entries that day | `LOSS_STOP_2` |
| 6 | Daily realized loss | At **−$20 realized** in a day: stop for the day | `DAILY_REALIZED_LOSS` |
| 7 | Daily loss halt (counts OPEN positions) | Realized + unrealized ≤ **−$20** → close ALL open positions at the close (exit reason `HALT`) and block all new entries for the rest of the UTC day | `HALTED_DAY`, `HALT_THRESHOLD` |
| 8 | Absolute daily loss cap | **−$30**. A day worse than this is a NO-GO signal (see §4) | — |
| 9 | Cost filter | Round-trip costs (0.3% of notional) ≤ **25% of risk** ($3.75 on $15 risk); otherwise the entry is skipped | `COST_FILTER` |
| 10 | Notional cap | Absolute cap **$2,000** per trade | `NOTIONAL_CAP` |
| 11 | Breakeven SL | At **+1R** in profit (+1.5×ATR from entry), SL **MAY** move to entry price (breakeven). Never widened, never moved again | — |
| 12 | SL never widened | SL is set before entry and never moved away from entry | — |
| 13 | TP never moved | Close at TP when hit; do not hold for more | — |
| 14 | Volatility guard | Skip the entry if the confirmation candle's true range > **2.5×ATR** | `VOL_GUARD` |
| 15 | Max hold | **96h** (24 × 4h candles) → exit at close (reason `TIME`) | — |
| 16 | Costs | 0.1% taker fee + 0.05% slippage per side (0.3% round-trip) | — |
| 17 | No re-entry | No re-entry in a symbol on the same 4h candle it closed a position | — |

Additional reason codes: `INVALID_TRADE` (bad price/ATR/side inputs).

### How the halt works, precisely

At each 4h close the engine computes:

```
day_total = realized P&L today + unrealized P&L of open positions
            (marked at the close, net of estimated exit fees)
```

If `day_total ≤ −$20`, **all** open positions are closed at the close
(exit reason `HALT`) and the day is flagged halted — no new entries for
the rest of the UTC day. This is what saved the worst day in the v3-B
backtest: on 8 Oct 2026 the SOL long hit SL (−$17.11) and the BTC long
was HALT-closed at −$9.46 instead of running to a full −$18 SL — that is
why the worst day is −$26.57 and not −$35+.

### The pre-trade checklist

`check_entry(day_state, proposed_trade, open_positions, marks)` returns
`(allowed, reasons)`. A paper trade opens **ONLY** if `allowed` is true.
Every rejection is logged with its reason code, so the paper-trade log
is a complete audit trail. The checklist runs in this order: halted day,
daily entry cap, anti-revenge (2 losses), daily realized loss, concurrent
cap, symbol already open, cost filter, notional cap, halt threshold
(if marks are provided).

## 2. Position-size calculator

Size is computed **before** entry, from the confirmation candle's ATR:

```
risk_dist  = 1.5 × ATR(14, 4h)
SL         = entry − risk_dist (long) / entry + risk_dist (short)
TP         = entry + 3.0 × ATR (long) / entry − 3.0 × ATR (short)
size       = $15 / risk_dist          (units of the base asset)
notional   = size × entry
round_trip_cost = 0.3% × notional
```

Worked example (BTC, entry $62,885.50, ATR $512.30):

```
risk_dist       = 1.5 × 512.30 = $768.45
SL (long)       = 62,885.50 − 768.45 = $62,117.05
TP (long)       = 62,885.50 + 3.0 × 512.30 = $64,422.40
size            = 15 / 768.45 = 0.019520 BTC
notional        = 0.019520 × 62,885.50 ≈ $1,227.54
round-trip cost = 0.3% × 1,227.54 ≈ $3.68  (≤ $3.75 → cost filter PASSES)
```

If the round-trip cost exceeded $3.75 (25% of $15 risk) or the notional
exceeded $2,000, the entry would be skipped — this is the filter that
excluded every PAXG trade in v2.0 (measured 4h ATR on PAXG is only
0.55% of price, so costs run at a median 36.6% of risk).

A full SL hit loses exactly the $15 risk plus ~$2–3.50 of costs (worst
v3-B trade: −$17.66). A full TP win gains ~$27–28 net.

## 3. Daily states — what the UI shows

`GET /api/risk/status` returns the current UTC day's state. The Risk
Management section displays:

- **Trading enabled** — normal state; entries allowed if the checklist passes.
- **Halted** — the daily halt fired (realized + unrealized ≤ −$20);
  all positions closed, no new entries today.
- **TRADING DISABLED FOR TODAY** — the terminal state for the rest of
  the UTC day once any of these hold: day halted, 2 losses taken, or
  realized loss ≤ −$20. The state resets at 00:00 UTC. It is a
  **state, not an error** — the UI shows it plainly and does not offer
  a way to override it from the terminal.
- **Cooldown** — `cooldownUntil` is set when a cooldown is active
  (e.g. after a halt); entries are blocked until it passes.

## 4. GO / NO-GO criteria for ever considering live trading

Live trading is considered **ONLY** when ALL of these hold, and ONLY by
Shu's explicit decision after reviewing the paper results. Meeting them
does **not** auto-enable anything — there is still no execution path
(no API key exists).

**GO requires ALL:**

1. **Minimum 2 weeks of forward paper trading** (from 19 Nov 2026),
   run on the 4-hourly schedule with no missed days.
2. **At least 5 paper trades closed** (the strategy trades ~1×/14 days,
   so this may take longer than 2 weeks — do not rush it).
3. **Zero rule violations** in `paper-trades.csv`
   (`python3 paper_trade.py --audit` exits clean, in the reference
   harness; the terminal's equivalent is an empty rejection/violation
   list in Trade History).
4. **No paper day worse than −$30** (the daily loss cap, hard).
5. **Paper P&L ≥ $0** over the period, with win rate ≥ 40% if ≥ 5
   trades exist (mirrors the backtest bars).
6. **No missed halt:** every day the halt condition was met, all
   positions were closed the same candle (check the log).

**NO-GO (stop, do not go live) if ANY holds:**

- Any rule violation, any day worse than −$30, or any halt missed.
- Paper P&L negative after ≥ 5 trades, or win rate < 40%.
- Fewer than 5 trades in 6 weeks (edge too rare to confirm — extend
  paper trading, do not force it).
- Any manual edit to the paper-trade log / state (the audit trail must
  stay append-only and machine-generated).

## 5. Known limitations — the residual hole (documented, not hidden)

**The daily-cap hole (validated design, not a bug):** the halt only
fires when positions are OPEN at a candle close — it is evaluated on
4h closes. Two full-SL losses can in theory land on the same UTC day
(**~−$35**) if the first loss is realized early and the second trade
is entered and stopped the same day, before any 4h close gives the halt
a chance to act. The backtest never hit it in 240 days (worst day
−$26.57), and the same failure mode is what sank v2.0's primary run
(−$35.01 on 29 Oct 2026) and v3-C (−$34.73 on 11 Sep 2026) — but it is
possible under the validated rules.

Why it is not "fixed" by blocking such trades in advance: an extra
"absolute-cap projection" rule (block a trade whose full SL loss
*could* push today past −$30) was tried and **deliberately removed**.
It is not part of the validated `STRATEGY-v3-b.md` §6 rules, and the
replay test proved it changes trade selection vs the backtest (it
rejected the 2026-09-18 BTC short the backtest took). Paper trading
must test the VALIDATED design, not a stricter redesign. **Do not
re-add this rule** — it is not in the validated design (see
`ARCHITECTURE.md` and `PHASE2.md` §1/§5).

What protects against the hole in practice:

- The audit flags **any paper day worse than −$30** as a NO-GO signal
  (§4). That is what Phase 2 is for.
- The 2-loss anti-revenge stop and the 2-entries-per-day cap limit how
  fast losses can stack.
- The halt still catches the common case (positions open at a close
  while the day is already down), as it did on 8 Oct 2026 in the
  backtest.

Other limitations:

- **Live fills will differ from paper fills.** Paper uses the
  backtest's 0.1% fee + 0.05% slippage convention; real fills vary.
- **The harness is not monitored 24/7.** If the VM or cron misses runs,
  exits are evaluated late. Gaps are visible in the state
  (`last_processed` vs current candle) and must be disclosed in any GO
  review.
- **No execution path exists.** Even after GO, live trading needs Shu
  to create a trade-only Binance API key (withdrawals disabled) and a
  separate, reviewed execution module. That is out of scope.

## 6. Never widen SL, no revenge trading — the non-negotiables

- **SL is never widened and never removed.** The only permitted move is
  to breakeven at +1R, once, and never back.
- **TP is never moved.** Close at TP when hit.
- **After 2 losing trades in a day: stop.** No "one more to win it
  back". The anti-revenge rule is enforced by the checklist, not by
  discipline.
- **The daily halt counts open positions.** Mark-to-market losses count
  toward the −$20 line — unrealized losses cannot be hidden by leaving
  a position open.
