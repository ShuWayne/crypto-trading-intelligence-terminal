import { useState } from 'react'
import { useApi } from '../lib/hooks'
import { fmt, fmtPrice, fmtTime, shortSymbol } from '../lib/api'
import type { PaperTrade } from '../lib/api'
import { ErrorState, LoadingState, SectionHeader, SourceLine, StatCard } from '../components/ui'

export default function History() {
  const [limit, setLimit] = useState(50)
  const { data, loading, error, updatedAt, refetch } = useApi<{ trades: PaperTrade[]; updatedAt?: string }>(`/api/signals/history?limit=${limit}`, 30)
  const trades = data?.trades ?? []
  const closed = trades.filter((t) => t.pnl !== null && t.pnl !== undefined)
  const net = closed.reduce((a, t) => a + (t.pnl ?? 0), 0)
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length

  return (
    <div>
      <SectionHeader
        title="Trade History"
        subtitle="Append-only paper-trade log from SQLite. Every entry and exit carries its reason — entries follow v3-B, exits are SL / TP / TIME (96h max hold) / HALT. No order code exists anywhere in this terminal."
        right={<SourceLine source="SQLite paper_trades · backend" updatedAt={updatedAt} status={error ? 'UNAVAILABLE' : data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {data && (
        <>
          <div className="mb-5 grid gap-4 md:grid-cols-4">
            <StatCard label="Trades logged" value={String(trades.length)} sub={`showing last ${limit}`} />
            <StatCard label="Closed trades" value={String(closed.length)} sub={`${wins} wins`} />
            <StatCard label="Net paper P&L" value={`$${fmt(net)}`} tone={net < 0 ? 'red' : 'green'} />
            <StatCard label="Win rate" value={closed.length ? `${((wins / closed.length) * 100).toFixed(1)}%` : '—'} sub="paper only — not live results" />
          </div>
          <div className="mb-4 flex items-center gap-2 text-sm">
            <label>Show
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="ml-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                {[25, 50, 100, 250].map((n) => <option key={n} value={n}>last {n}</option>)}
              </select>
            </label>
          </div>
          {trades.length === 0 ? (
            <div className="glass p-6 text-center text-sm text-slate-400">No paper trades logged yet. The paper engine opens positions only on validated v3-B signals — zero trades is a normal state, not missing data.</div>
          ) : (
            <div className="glass overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-[11px] uppercase tracking-widest text-slate-400">
                    <th className="px-4 py-3">Symbol</th><th className="px-4 py-3">Side</th>
                    <th className="px-4 py-3 text-right">Entry</th><th className="px-4 py-3 text-right">Exit</th>
                    <th className="px-4 py-3">Entry reason</th><th className="px-4 py-3">Exit reason</th>
                    <th className="px-4 py-3 text-right">P&L</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                      <td className="px-4 py-3 font-bold">{shortSymbol(t.symbol)}</td>
                      <td className={`px-4 py-3 font-semibold ${t.side === 'BUY' || t.side === 'LONG' ? 'text-emerald-300' : 'text-red-300'}`}>{t.side}</td>
                      <td className="tnum px-4 py-3 text-right">${fmtPrice(t.entry)}</td>
                      <td className="tnum px-4 py-3 text-right">{t.exit ? `$${fmtPrice(t.exit)}` : '—'}</td>
                      <td className="px-4 py-3 text-slate-300">{t.reason ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-300">{t.exitReason ?? '—'}</td>
                      <td className={`tnum px-4 py-3 text-right font-semibold ${t.pnl === null || t.pnl === undefined ? 'text-slate-400' : t.pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{t.pnl === null || t.pnl === undefined ? '—' : `$${fmt(t.pnl)}`}</td>
                      <td className="px-4 py-3">{t.status ?? (t.exit ? 'CLOSED' : 'OPEN')}</td>
                      <td className="tnum px-4 py-3 text-slate-400">{fmtTime(t.entryAt ?? t.createdAt ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
