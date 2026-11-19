import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApi } from '../lib/hooks'
import { fmt, fmtPrice, fmtTime, shortSymbol, timeAgo } from '../lib/api'
import type { AlertsResp, IndicatorResp, IndicatorState, Signal, SignalsResp } from '../lib/api'
import { EmptyState, ErrorState, LoadingState, SectionHeader, SourceLine, StatCard } from '../components/ui'

const SIGNAL_SYMBOLS = ['BTCUSDT', 'SOLUSDT'] as const

const STATE_STYLE: Record<IndicatorState, { cls: string; label: string }> = {
  VALID_RANGE: { cls: 'border-sky-500/50 bg-sky-500/10 text-sky-200', label: 'Valid range' },
  APPROACHING_LOW: { cls: 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200', label: 'Approaching range low' },
  APPROACHING_HIGH: { cls: 'border-amber-500/50 bg-amber-500/10 text-amber-200', label: 'Approaching range high' },
  CONFIRMED_BUY: { cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200', label: 'Confirmed BUY' },
  CONFIRMED_SELL: { cls: 'border-red-500/50 bg-red-500/10 text-red-200', label: 'Confirmed SELL' },
  BREAKDOWN_AVOID: { cls: 'border-red-500/50 bg-red-500/10 text-red-200', label: 'Breakdown — avoid' },
  UNSUITABLE_TRENDING: { cls: 'border-amber-500/50 bg-amber-500/10 text-amber-200', label: 'Unsuitable — trending' },
  UNSUITABLE_VOLATILITY: { cls: 'border-amber-500/50 bg-amber-500/10 text-amber-200', label: 'Unsuitable — volatility' },
  NO_TRADE: { cls: 'border-slate-400/40 bg-white/5 text-slate-200', label: 'No trade' },
}

const SEVERITY_STYLE: Record<string, string> = {
  INFO: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  WARNING: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  CRITICAL: 'border-red-500/40 bg-red-500/10 text-red-200',
}

function rr(s: Signal): string {
  return typeof s.riskReward === 'number' ? `1:${s.riskReward.toFixed(2)}` : s.riskReward
}

function SignalCard({ symbol, signal }: { symbol: string; signal: Signal | undefined }) {
  if (!signal) {
    return (
      <div className="glass p-5">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-white/10 px-3 py-1.5 text-base font-black text-slate-300">NO TRADE</span>
          <span className="text-xl font-extrabold">{shortSymbol(symbol)}</span>
          <span className="ml-auto rounded-full border border-white/15 px-2.5 py-1 text-xs text-slate-300">v3-B · 4h</span>
        </div>
        <p className="mt-3 text-sm text-slate-400">
          No validated v3-B setup for {shortSymbol(symbol)} right now. A signal needs a ranging-boundary
          touch (within 0.5× ATR) with an RSI extreme (&lt;32 / &gt;68), a rejection candle and a volatility
          guard (true range ≤ 2.5× ATR). NO TRADE is a valid output — never manufactured.
        </p>
      </div>
    )
  }
  const buy = signal.side === 'BUY'
  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass p-5 ${buy ? 'shadow-glowgreen border-emerald-500/40' : 'shadow-glowred border-red-500/40'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <motion.span
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-base font-black ${buy ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}
        >
          <span className={`h-2 w-2 rounded-full ${buy ? 'bg-emerald-400' : 'bg-red-400'} live-dot`} />
          {signal.side}
        </motion.span>
        <span className="text-xl font-extrabold">{shortSymbol(signal.symbol)}</span>
        <span className="ml-auto rounded-full border border-white/15 px-2.5 py-1 text-xs text-slate-300">
          v3-B · {signal.confidence}% confidence · {signal.timeframe}
        </span>
      </div>
      <div className="tnum mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Entry</div><div className="font-bold">${fmtPrice(signal.entry)}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Stop loss</div><div className="font-bold text-red-300">${fmtPrice(signal.stopLoss)}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Take profit — validated target 3.0×ATR</div><div className="font-bold text-emerald-300">${fmtPrice(signal.takeProfit)}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">R:R</div><div className="font-bold">{rr(signal)}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Timeframe</div><div className="font-bold">{signal.timeframe}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Signal time</div><div className="font-bold">{fmtTime(signal.signalTimestamp)}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Expires</div><div className="font-bold">{fmtTime(signal.expiresAt)}</div></div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Exit conditions</div><div className="font-bold">{signal.exitConditions.join(' · ')}</div></div>
      </div>
      <p className="mt-4 text-sm text-slate-300">{signal.reason}</p>
      <p className="mt-1 text-sm text-red-200">Invalidation: {signal.invalidation}</p>
      <p className="mt-4 text-[11px] text-slate-500">Paper signal only. SL is never widened, TP is never moved. Max hold 96h; breakeven SL at +1R is a management rule, not a target.</p>
    </motion.article>
  )
}

export default function Indicator() {
  const signals = useApi<SignalsResp>('/api/signals', 30)
  const indicator = useApi<IndicatorResp>('/api/indicator', 30)
  const alerts = useApi<AlertsResp>('/api/alerts?limit=30', 60)

  const active = (signals.data?.signals ?? []).filter((s) => s.status === 'ACTIVE')
  const indRows = indicator.data?.symbols ?? []
  const alertList = alerts.data?.alerts ?? []
  const error = signals.error ?? indicator.error ?? alerts.error

  return (
    <div>
      <SectionHeader
        title="Trading Indicator — v3-B"
        subtitle="Range Mean-Reversion indicator (v3-B, 4h, closed candles only). BUY at the range low / oversold, SELL/EXIT at the range high / overbought, with a single validated TP at 3.0×ATR (+2R). No repainting, no look-ahead. ETH and PAXG are outside the validated v3-B universe."
        right={<SourceLine source="v3-B indicator engine · Binance 4h candles" updatedAt={indicator.updatedAt ?? signals.updatedAt} status={error ? 'UNAVAILABLE' : indicator.data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={() => { signals.refetch(); indicator.refetch(); alerts.refetch() }} />}
      {signals.loading && !signals.data && indicator.loading && !indicator.data && <LoadingState />}

      {/* (a) Live signal cards — BTC/SOL */}
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-slate-400">Live v3-B signals</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {SIGNAL_SYMBOLS.map((sym) => (
          <SignalCard key={sym} symbol={sym} signal={active.find((s) => s.symbol === sym)} />
        ))}
      </div>

      {/* (b) Per-symbol indicator state */}
      <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-widest text-slate-400">Indicator state — all symbols (v3-B)</h2>
      {indicator.loading && !indicator.data ? (
        <LoadingState label="Loading indicator state…" />
      ) : indRows.length === 0 ? (
        <EmptyState title="Indicator feed unavailable" body="No per-symbol indicator state was returned. The backend needs Binance 4h candles — check /api/health before assuming a code bug." tone="amber" />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Regime</th>
                <th className="px-4 py-3">Range low</th>
                <th className="px-4 py-3">Range high</th>
                <th className="px-4 py-3">Range width</th>
                <th className="px-4 py-3">RSI (14)</th>
                <th className="px-4 py-3">Dist. to low</th>
                <th className="px-4 py-3">Dist. to high</th>
                <th className="px-4 py-3">State</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {indRows.map((row) => {
                const st = STATE_STYLE[row.state]
                return (
                  <tr key={row.symbol} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-bold">{shortSymbol(row.symbol)}</td>
                    <td className="px-4 py-3">
                      <span className={row.regime === 'RANGING' ? 'text-sky-300' : 'text-amber-300'}>{row.regime}</span>
                    </td>
                    <td className="px-4 py-3">{row.rangeLow !== null ? `$${fmtPrice(row.rangeLow)}` : '—'}</td>
                    <td className="px-4 py-3">{row.rangeHigh !== null ? `$${fmtPrice(row.rangeHigh)}` : '—'}</td>
                    <td className="px-4 py-3">{row.rangeWidthAtr !== null ? `${fmt(row.rangeWidthAtr)}× ATR` : '—'}</td>
                    <td className="px-4 py-3">{row.rsi !== null ? fmt(row.rsi, 1) : '—'}</td>
                    <td className="px-4 py-3">{row.distanceToLowAtr !== null ? `${fmt(row.distanceToLowAtr)}× ATR` : '—'}</td>
                    <td className="px-4 py-3">{row.distanceToHighAtr !== null ? `${fmt(row.distanceToHighAtr)}× ATR` : '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full border px-2.5 py-1 text-[11px] font-semibold ${st.cls}`} title={row.reason}>
                        {st.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {indRows.length > 0 && (
        <div className="mt-3 space-y-1 text-xs text-slate-400">
          {indRows.filter((r) => r.reason).map((r) => (
            <p key={r.symbol}><b className="text-slate-200">{shortSymbol(r.symbol)}:</b> {r.reason}</p>
          ))}
        </div>
      )}

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {/* (c) Alerts feed */}
        <div className="glass p-5">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">v3-B alerts</h2>
          {alerts.loading && !alerts.data ? (
            <p className="mt-3 text-sm text-slate-400">Loading alerts…</p>
          ) : alertList.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No alerts yet — alerts fire on real state transitions only (BUY_SETUP, EXIT_TRIGGER, SL_HIT, TP_HIT, RANGE_INVALID, VOLATILITY_UNSUITABLE). Nothing is fabricated to fill the feed.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {alertList.map((a) => (
                <li key={a.id} className={`rounded-xl border p-3 text-sm ${SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.INFO}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-black">{a.type.replace(/_/g, ' ')}</span>
                    <span className="font-semibold">{shortSymbol(a.symbol)}</span>
                    <span className="ml-auto text-xs opacity-80" title={fmtTime(a.time)}>{timeAgo(a.time)}</span>
                  </div>
                  <p className="mt-1 text-[13px] opacity-90">{a.message}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* (d) Strategy performance — verified baseline, separated from live paper stats */}
        <div>
          <div className="rounded-2xl border border-violet-500/40 bg-violet-500/5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-widest text-violet-200">Strategy performance — v3-B</h2>
              <span className="rounded-full border border-violet-400/50 bg-violet-500/15 px-2.5 py-1 text-[11px] font-semibold text-violet-200">Historical backtest — not live performance</span>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Verified baseline from the pre-registered 240-day backtest (24 Mar – 19 Nov 2026). These numbers
              describe the past test window only — they are <b className="text-slate-200">not</b> live results and
              not a promise of future performance. Live paper-trading stats are tracked separately below.
            </p>
            <div className="tnum mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Backtest window" value="240 days" sub="24 Mar – 19 Nov 2026" />
              <StatCard label="Trades" value="17" sub="8 wins · 9 losses" />
              <StatCard label="Win rate" value="47.1%" sub="criterion ≥ 40%" tone="green" />
              <StatCard label="Profit factor" value="1.75" sub="criterion ≥ 1.2" tone="green" />
              <StatCard label="Net P&L" value="+$72.42" sub="H1 +$47.08 · H2 +$25.35" tone="green" />
              <StatCard label="Max drawdown" value="−1.25%" sub="worst day −$26.57" tone="amber" />
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              v3-B passed all 5 pre-registered criteria; v1.0, v2.0, v3-A and v3-C FAILED and are never traded.
              17 trades is a small sample — forward paper trading on unseen data is the next validation step.
            </p>
          </div>

          {/* Live paper stats — kept visually separate from the backtest baseline */}
          <div className="glass mt-4 p-5">
            <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Live paper trading (forward — separate from backtest)</h3>
            {signals.data ? (
              <dl className="tnum mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Open positions</dt><dd className="font-bold">{signals.data.paper.openPositions} / 2</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Trades today</dt><dd className="font-bold">{signals.data.paper.tradesToday} / 2</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Today&apos;s P&L</dt><dd className={`font-bold ${signals.data.paper.todayPnl < 0 ? 'text-red-300' : 'text-emerald-300'}`}>${fmt(signals.data.paper.todayPnl)}</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Status</dt><dd className="font-bold">{signals.data.paper.tradingDisabled || signals.data.paper.halted ? 'HALTED' : 'ACTIVE'}</dd></div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-slate-400">Paper stats unavailable — feed error.</p>
            )}
          </div>
        </div>
      </div>

      {/* (e) Link to Advanced Charts */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link to="/charts" className="rounded-xl bg-electric px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110">
          Open Advanced Charts →
        </Link>
        <Link to="/signals" className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10">
          All v3-B signals →
        </Link>
        <span className="text-xs text-slate-500">Chart overlays draw the active v3-B signal&apos;s entry / SL / single validated TP (3.0×ATR) lines for the selected symbol.</span>
      </div>
    </div>
  )
}
