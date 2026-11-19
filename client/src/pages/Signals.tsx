import { motion } from 'framer-motion'
import { useApi } from '../lib/hooks'
import { fmt, fmtPrice, fmtTime, shortSymbol } from '../lib/api'
import type { SignalsResp } from '../lib/api'
import { EmptyState, ErrorState, LoadingState, SectionHeader, SourceLine, StatCard } from '../components/ui'

export default function Signals() {
  const { data, loading, error, updatedAt, refetch } = useApi<SignalsResp>('/api/signals', 30)
  const active = (data?.signals ?? []).filter((s) => s.status === 'ACTIVE')
  const past = (data?.signals ?? []).filter((s) => s.status !== 'ACTIVE')

  return (
    <div>
      <SectionHeader
        title="Trading Signals"
        subtitle="Validated strategy v3-B — Range Mean-Reversion, 4h, BTC + SOL only. ETH and PAXG are excluded by the strategy (backtest evidence), not silently included. v3-B has ONE validated take-profit at +2R (3.0×ATR); the validated exits are TP + SL + TIME (96h) + HALT. The breakeven SL move at +1R is a management rule, not a target."
        right={<SourceLine source="Signal engine v3-B · Binance 4h candles" updatedAt={updatedAt} status={error ? 'UNAVAILABLE' : data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {data && (
        <div className="mb-5 grid gap-4 md:grid-cols-4">
          <StatCard label="Market condition" value={data.marketCondition.replace('_', ' ')} tone={data.marketCondition === 'BULLISH' ? 'green' : data.marketCondition === 'BEARISH' ? 'red' : 'amber'} />
          <StatCard label="Open paper positions" value={String(data.paper.openPositions)} sub="max 2 concurrent" />
          <StatCard label="Trades today" value={String(data.paper.tradesToday)} sub="max 2 entries/day" />
          <StatCard label="Today's paper P&L" value={`$${fmt(data.paper.todayPnl)}`} sub={data.paper.tradingDisabled ? 'Trading disabled — daily halt' : 'Daily halt at −$20'} tone={data.paper.todayPnl < 0 ? 'red' : 'green'} />
        </div>
      )}

      {data && active.length === 0 && (
        <EmptyState
          title="NO TRADE — no validated setup right now"
          body="The v3-B engine only fires on a ranging-boundary touch (within 0.5× ATR) with an RSI extreme (<32 / >68), a rejection candle and a volatility guard (true range ≤ 2.5× ATR). When none of that is present, the correct output is NO TRADE. Never manufactured, never chased."
          tone="amber"
        />
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {active.map((s) => (
          <motion.article key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className={`glass p-5 ${s.side === 'BUY' ? 'shadow-glowgreen border-emerald-500/40' : 'shadow-glowred border-red-500/40'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-lg px-3 py-1.5 text-base font-black ${s.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{s.side}</span>
              <span className="text-xl font-extrabold">{shortSymbol(s.symbol)}</span>
              <span className="ml-auto rounded-full border border-white/15 px-2.5 py-1 text-xs text-slate-300">{s.confidence}% confidence · {s.timeframe}</span>
            </div>
            <div className="tnum mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Entry</div><div className="font-bold">${fmtPrice(s.entry)}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Stop loss</div><div className="font-bold text-red-300">${fmtPrice(s.stopLoss)}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Take profit — validated target 3.0×ATR</div><div className="font-bold text-emerald-300">${fmtPrice(s.takeProfit)}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">R:R</div><div className="font-bold">{typeof s.riskReward === 'number' ? `1:${s.riskReward.toFixed(2)}` : s.riskReward}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Timeframe</div><div className="font-bold">{s.timeframe}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Signal time</div><div className="font-bold">{fmtTime(s.signalTimestamp)}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Expires</div><div className="font-bold">{fmtTime(s.expiresAt)}</div></div>
              <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Exit conditions</div><div className="font-bold">{s.exitConditions.join(' · ')}</div></div>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Structure</dt><dd className="text-slate-200">{s.structure}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Reason</dt><dd className="text-slate-200">{s.reason}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-wider text-slate-400">Invalidation</dt><dd className="text-red-200">{s.invalidation}</dd></div>
            </dl>
            <p className="mt-4 text-[11px] text-slate-500">Paper signal only. SL is never widened, TP is never moved. Max hold 96h; breakeven SL at +1R.</p>
          </motion.article>
        ))}
      </div>

      {past.length > 0 && (
        <div className="glass mt-6 p-5">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Expired / invalidated signals</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {past.map((s) => (
              <li key={s.id} className="flex flex-wrap justify-between gap-2 border-b border-white/5 pb-2 last:border-0">
                <span><b>{s.side}</b> {shortSymbol(s.symbol)} @ ${fmtPrice(s.entry)} — {s.status}</span>
                <span className="text-slate-400">expired {fmtTime(s.expiresAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
