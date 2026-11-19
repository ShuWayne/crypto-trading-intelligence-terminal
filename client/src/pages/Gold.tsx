import { useApi } from '../lib/hooks'
import { fmt, fmtPct, fmtPrice } from '../lib/api'
import type { GoldResp } from '../lib/api'
import { ErrorState, LoadingState, SectionHeader, SourceLine, StatCard } from '../components/ui'

export default function Gold() {
  const { data, loading, error, updatedAt, refetch } = useApi<GoldResp>('/api/gold', 10)
  const sessions = data ? [
    { key: 'asian', label: 'Asian session', ...data.sessions.asian },
    { key: 'london', label: 'London session', ...data.sessions.london },
    { key: 'newYork', label: 'New York session', ...data.sessions.newYork },
  ] : []

  return (
    <div>
      <SectionHeader
        title="Gold Intelligence"
        subtitle="PAXG — gold proxy (Binance). This is NOT spot XAUUSD: PAXG is a tokenised gold token traded on Binance, so prices track gold but are not the spot quote. Crypto never closes; session labels are clock-based context only."
        right={<SourceLine source="Binance PAXGUSDT · public API" updatedAt={updatedAt} status={error ? 'UNAVAILABLE' : data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard label="PAXG price" value={`$${fmtPrice(data.price)}`} sub={`${fmtPct(data.change24hPct)} · 24h`} tone={data.change24hPct >= 0 ? 'green' : 'red'} glow />
            {/* API returns the nearest swing level as a single number, not an array — normalise defensively. */}
            <StatCard label="Support level" value={(Array.isArray(data.support) ? data.support : [data.support]).filter((v) => v !== undefined && v !== null).map((v) => `$${fmtPrice(v as number)}`).join(' · ') || '—'} sub="Nearest 4h swing support" tone="green" />
            <StatCard label="Resistance level" value={(Array.isArray(data.resistance) ? data.resistance : [data.resistance]).filter((v) => v !== undefined && v !== null).map((v) => `$${fmtPrice(v as number)}`).join(' · ') || '—'} sub="Nearest 4h swing resistance" tone="red" />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="glass p-5">
              <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Trading sessions (UTC clock)</h2>
              <div className="mt-4 space-y-3">
                {sessions.map((s) => (
                  <div key={s.key} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${s.active ? 'border-cyan-400/50 bg-cyan-400/10' : 'border-white/10 bg-white/[0.02]'}`}>
                    <div>
                      <div className="font-semibold">{s.label}</div>
                      <div className="tnum text-xs text-slate-400">{s.open} – {s.close} UTC</div>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${s.active ? 'bg-cyan-400/20 text-cyan-200' : 'bg-white/5 text-slate-400'}`}>
                      {s.active ? '● LIVE NOW' : 'INACTIVE'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-500">Sessions are computed from the UTC clock. PAXG trades 24/7 on Binance — it is never "closed" the way spot gold is on weekends.</p>
            </div>
            <div className="glass p-5">
              <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Analyst notes</h2>
              {data.notes.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">No notes in the feed.</p>
              ) : (
                <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-200">
                  {data.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
              <div className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed text-slate-500">
                Note: PAXG is excluded from the v3-B signal engine by backtest evidence — gold signals are intelligence only, not trade signals. Gold context (Fed expectations, dollar strength) feeds the News &amp; Fed view.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
