import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApi } from '../lib/hooks'
import { fmt, fmtPct, fmtPrice, shortSymbol } from '../lib/api'
import type { MarketCondition, NewsResp, OverviewResp, RiskStatus, SignalsResp } from '../lib/api'
import { ApiStatus, EmptyState, ErrorState, LoadingState, SectionHeader, SourceLine, StatCard } from '../components/ui'

const CONDITION_STYLE: Record<MarketCondition, { cls: string; blurb: string }> = {
  BULLISH: { cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200', blurb: 'Momentum is up across the board. Validated v3-B setups are long-biased only when a ranging boundary + RSI extreme confirms.' },
  BEARISH: { cls: 'border-red-500/50 bg-red-500/10 text-red-200', blurb: 'Momentum is down. v3-B short setups need a ranging top + RSI extreme — no chasing breakdowns.' },
  NEUTRAL: { cls: 'border-slate-400/40 bg-white/5 text-slate-200', blurb: 'No clear directional edge. v3-B only trades confirmed range-boundary reversals.' },
  HIGH_VOLATILITY: { cls: 'border-amber-500/50 bg-amber-500/10 text-amber-200', blurb: 'Volatility guard is active — true range above 2.5× ATR blocks new entries. Stand by.' },
  NO_TRADE: { cls: 'border-amber-500/50 bg-amber-500/10 text-amber-200', blurb: 'No validated setup right now. NO TRADE is a valid, disciplined output — capital preserved is capital kept.' },
}

export default function Overview() {
  const overview = useApi<OverviewResp>('/api/markets/overview', 10)
  const signals = useApi<SignalsResp>('/api/signals', 30)
  const risk = useApi<RiskStatus>('/api/risk/status', 30)
  const news = useApi<NewsResp>('/api/news', 300)

  const syms = overview.data?.symbols ?? []
  const sorted = [...syms].sort((a, b) => b.change24hPct - a.change24hPct)
  const gainers = sorted.slice(0, 3)
  const losers = sorted.slice(-3).reverse()
  const best = signals.data?.signals.find((s) => s.status === 'ACTIVE')
  const cond = signals.data?.marketCondition ?? 'NO_TRADE'
  const condStyle = CONDITION_STYLE[cond]
  const upcoming = (news.data?.fedEvents ?? []).slice(0, 4)
  const highImpact = (news.data?.fedEvents ?? []).filter((e) => e.impact === 'HIGH').slice(0, 2)

  return (
    <div>
      <SectionHeader
        title="Overview"
        subtitle="Market condition, best validated opportunity, risk status and what's ahead — at a glance."
        right={<SourceLine source={overview.data?.source ?? 'Binance public API'} updatedAt={overview.updatedAt} status={overview.error ? 'UNAVAILABLE' : overview.data ? 'LIVE' : 'DEGRADED'} />}
      />

      {overview.error && <ErrorState error={overview.error} onRetry={overview.refetch} />}
      {overview.loading && !overview.data && <LoadingState />}

      {/* Market condition banner */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`glass ${condStyle.cls} mb-5 flex flex-wrap items-center gap-4 p-5`}>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest opacity-80">Market condition</div>
          <div className="text-3xl font-black tracking-tight">{cond.replace('_', ' ')}</div>
        </div>
        <p className="max-w-xl flex-1 text-sm opacity-90">{condStyle.blurb}</p>
        <Link to="/signals" className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">View signals →</Link>
      </motion.div>

      {highImpact.length > 0 && (
        <div className="mb-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          ⚠ HIGH IMPACT event ahead: {highImpact.map((e) => `${e.title} — ${e.date} ${e.time}`).join(' · ')} — expect volatility; v3-B entries are blocked around major releases.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Symbols tracked" value={String(syms.length || '—')} sub="BTC ETH SOL BNB XRP DOGE TON PAXG" />
        <StatCard label="Active signals (v3-B)" value={String(signals.data?.signals.filter((s) => s.status === 'ACTIVE').length ?? '—')} sub="BTC + SOL only — validated strategy" tone={best ? 'green' : 'neutral'} glow={!!best} />
        <StatCard label="Today's paper P&L" value={risk.data ? `$${fmt(risk.data.realizedToday)}` : '—'} sub={risk.data ? `${risk.data.tradesToday} trades · ${risk.data.lossesToday} losses` : 'Risk feed'} tone={risk.data && risk.data.realizedToday < 0 ? 'red' : 'green'} />
        <StatCard label="Trading status" value={risk.data ? (risk.data.tradingDisabled || risk.data.halted ? 'DISABLED' : 'ENABLED') : '—'} sub={risk.data ? `Daily loss limit $${risk.data.dailyLossLimit} · risk $${risk.data.riskPerTrade}/trade` : 'Risk feed'} tone={risk.data?.tradingDisabled ? 'red' : 'green'} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {/* Best opportunity */}
        <div className="glass p-5">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Best opportunity</h2>
          {signals.loading && !signals.data ? (
            <p className="mt-3 text-sm text-slate-400">Loading signals…</p>
          ) : best ? (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <span className={`rounded-lg px-2.5 py-1 text-sm font-black ${best.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{best.side} {shortSymbol(best.symbol)}</span>
                <span className="text-xs text-slate-400">{best.confidence}% confidence · 4h</span>
              </div>
              <dl className="tnum mt-3 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-slate-400">Entry</dt><dd className="font-semibold">${fmtPrice(best.entry)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Stop loss</dt><dd className="font-semibold text-red-300">${fmtPrice(best.stopLoss)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">TP — validated target (3.0×ATR)</dt><dd className="font-semibold text-emerald-300">${fmtPrice(best.takeProfit)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">R:R</dt><dd className="font-semibold">{typeof best.riskReward === 'number' ? `1:${best.riskReward.toFixed(2)}` : best.riskReward}</dd></div>
              </dl>
              <Link to="/signals" className="mt-4 inline-block text-sm font-semibold text-sky-300 hover:underline">Full signal card →</Link>
            </div>
          ) : (
            <EmptyState title="NO TRADE" body="No validated v3-B setup is active. The engine only fires on a ranging-boundary touch with an RSI extreme and a rejection candle — it will not manufacture a signal." tone="amber" />
          )}
        </div>

        {/* Gainers / losers */}
        <div className="glass p-5">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Top movers · 24h</h2>
          {syms.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No market data — feed unavailable.</p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-semibold text-emerald-300">Gainers</div>
                {gainers.map((s) => (
                  <div key={s.symbol} className="tnum mt-1.5 flex justify-between text-sm"><span>{shortSymbol(s.symbol)}</span><span className="text-emerald-300">{fmtPct(s.change24hPct)}</span></div>
                ))}
              </div>
              <div>
                <div className="text-xs font-semibold text-red-300">Losers</div>
                {losers.map((s) => (
                  <div key={s.symbol} className="tnum mt-1.5 flex justify-between text-sm"><span>{shortSymbol(s.symbol)}</span><span className="text-red-300">{fmtPct(s.change24hPct)}</span></div>
                ))}
              </div>
            </div>
          )}
          <Link to="/markets" className="mt-4 inline-block text-sm font-semibold text-sky-300 hover:underline">All markets →</Link>
        </div>

        {/* Upcoming events + risk */}
        <div className="glass p-5">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Upcoming economic events</h2>
          {upcoming.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No upcoming events in the feed.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {upcoming.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-2">
                  <span>{e.title}<span className="block text-xs text-slate-400">{e.date} · {e.time}</span></span>
                  <ApiStatus status={e.impact === 'HIGH' ? 'UNAVAILABLE' : 'DEGRADED'} label={e.impact} />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-white/10 pt-3 text-sm">
            <span className="text-slate-400">Daily risk: </span>
            {risk.data ? (
              <span className="tnum font-semibold">{risk.data.tradesToday}/2 trades · {risk.data.lossesToday} losses · P&L ${fmt(risk.data.realizedToday)} · {risk.data.openPositions} open</span>
            ) : (
              <span className="text-slate-400">risk feed unavailable</span>
            )}
          </div>
          <Link to="/news" className="mt-3 inline-block text-sm font-semibold text-sky-300 hover:underline">News & Fed →</Link>
        </div>
      </div>
    </div>
  )
}
