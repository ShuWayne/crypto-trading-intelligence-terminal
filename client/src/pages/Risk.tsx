import { useMemo, useState } from 'react'
import { useApi } from '../lib/hooks'
import { apiPost, fmt } from '../lib/api'
import type { RiskStatus } from '../lib/api'
import { ErrorState, LoadingState, SectionHeader, SourceLine, StatCard } from '../components/ui'

export default function Risk() {
  const { data, loading, error, updatedAt, refetch } = useApi<RiskStatus>('/api/risk/status', 15)
  const [accountSize, setAccountSize] = useState(5000)
  const [riskPct, setRiskPct] = useState(0.3)
  const [entry, setEntry] = useState(62000)
  const [sl, setSl] = useState(60500)
  const [saveMsg, setSaveMsg] = useState('')
  const [limit, setLimit] = useState(25)
  const [riskPerTrade, setRiskPerTrade] = useState(15)

  const riskUsd = useMemo(() => (accountSize * riskPct) / 100, [accountSize, riskPct])
  const dist = Math.abs(entry - sl)
  const size = dist > 0 ? riskUsd / dist : 0
  const notional = size * entry
  const disabled = !!data?.tradingDisabled || !!data?.halted

  const saveConfig = async () => {
    setSaveMsg('Saving…')
    try {
      await apiPost('/api/risk/config', { dailyLossLimit: limit, riskPerTrade })
      setSaveMsg('Saved — daily loss limit $' + limit + ', risk $' + riskPerTrade + '/trade.')
      refetch()
    } catch (e) {
      setSaveMsg('Save failed: ' + (e instanceof Error ? e.message : 'unknown error'))
    }
  }

  return (
    <div>
      <SectionHeader
        title="Risk Management"
        subtitle="The risk engine is the port of risk_engine.py: $15/trade, max 2 entries/day, max 2 concurrent, 2-loss anti-revenge stop, daily halt at realised + unrealised ≤ −$20 counting open positions, absolute cap −$30 (a day worse than this is a NO-GO), 25% cost filter, $2,000 notional cap, breakeven SL at +1R — SL never widened, TP never moved."
        right={<SourceLine source="Risk engine · SQLite paper log" updatedAt={updatedAt} status={error ? 'UNAVAILABLE' : data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {disabled && data && (
        <div className="mb-5 rounded-2xl border-2 border-red-500/60 bg-red-500/15 p-6 text-center shadow-glowred">
          <div className="text-3xl font-black tracking-tight text-red-200">⛔ TRADING DISABLED FOR TODAY</div>
          <p className="mx-auto mt-2 max-w-xl text-sm text-red-200/80">
            The daily loss limit has been hit (realised {`$${fmt(data.realizedToday)}`} vs limit ${data.dailyLossLimit}). No new entries are allowed until the next UTC day.
            This is the rule working as designed — not a bug. Do not revenge-trade.
          </p>
          <p className="mt-2 text-xs text-red-200/60">Cooldown until: {data.cooldownUntil ?? 'next UTC day 00:00'}</p>
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Realised P&L today" value={`$${fmt(data.realizedToday)}`} sub={`${data.date}`} tone={data.realizedToday < 0 ? 'red' : 'green'} />
            <StatCard label="Trades / losses today" value={`${data.tradesToday} / ${data.lossesToday}`} sub="Max 2 entries/day · 2-loss anti-revenge stop" tone={data.lossesToday >= 2 ? 'red' : 'neutral'} />
            <StatCard label="Open positions" value={String(data.openPositions)} sub="Max 2 concurrent" />
            <StatCard label="Max drawdown" value={`${fmt(data.maxDrawdown, 1)}%`} sub={`Daily loss limit $${data.dailyLossLimit} · risk $${data.riskPerTrade}/trade`} tone={data.maxDrawdown > 5 ? 'red' : 'neutral'} />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {/* Position size calculator */}
            <div className="glass p-5">
              <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Position-size calculator</h2>
              <div className="mt-4 space-y-4 text-sm">
                <label className="block">Account size — <b className="tnum">${fmt(accountSize, 0)}</b>
                  <input type="range" min={100} max={20000} step={50} value={accountSize} onChange={(e) => setAccountSize(Number(e.target.value))} className="mt-1 w-full" />
                </label>
                <label className="block">Risk per trade — <b className="tnum">{riskPct.toFixed(2)}% (${fmt(riskUsd)})</b>
                  <input type="range" min={0.1} max={2} step={0.05} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="mt-1 w-full" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label>Entry price<input type="number" value={entry} onChange={(e) => setEntry(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 tnum" /></label>
                  <label>Stop loss<input type="number" value={sl} onChange={(e) => setSl(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 tnum" /></label>
                </div>
                <dl className="tnum space-y-1 border-t border-white/10 pt-3">
                  <div className="flex justify-between"><dt className="text-slate-400">Risk amount</dt><dd className="font-bold">${fmt(riskUsd)}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-400">Position size</dt><dd className="font-bold">{fmt(size, 4)} units</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-400">Notional</dt><dd className={`font-bold ${notional > 2000 ? 'text-red-300' : ''}`}>${fmt(notional, 0)}{notional > 2000 ? ' — EXCEEDS $2,000 CAP' : ''}</dd></div>
                </dl>
                {notional > 2000 && <p className="text-xs text-red-300">Notional cap $2,000 would block this trade. Reduce size or widen the stop distance is not allowed — reduce the position.</p>}
              </div>
            </div>

            {/* Risk config */}
            <div className="glass p-5">
              <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Risk configuration</h2>
              <p className="mt-2 text-xs text-slate-500">Saved via POST /api/risk/config. Daily loss limit is clamped to $20–$30 by the backend.</p>
              <div className="mt-4 space-y-4 text-sm">
                <label className="block">Daily loss limit — <b className="tnum">${limit}</b> (allowed $20–$30)
                  <input type="range" min={20} max={30} step={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="mt-1 w-full" />
                </label>
                <label className="block">Risk per trade — <b className="tnum">${riskPerTrade}</b>
                  <input type="range" min={5} max={30} step={1} value={riskPerTrade} onChange={(e) => setRiskPerTrade(Number(e.target.value))} className="mt-1 w-full" />
                </label>
                <button onClick={saveConfig} className="rounded-xl bg-electric px-4 py-2 font-semibold text-white hover:brightness-110">Save risk config</button>
                {saveMsg && <p className="text-xs text-slate-300">{saveMsg}</p>}
              </div>
              <div className="mt-5 border-t border-white/10 pt-4 text-xs leading-relaxed text-slate-500">
                Hard rules, no exceptions: 2-loss anti-revenge stop · daily halt at −$20 (realised + unrealised, open positions counted) ·
                absolute cap −$30/day (a day worse than this = NO-GO for live) · 25% cost filter · $2,000 notional cap ·
                breakeven SL at +1R · SL never widened · TP never moved · max hold 96h.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
