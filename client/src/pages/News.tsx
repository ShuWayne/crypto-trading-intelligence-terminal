import { useApi } from '../lib/hooks'
import { fmtTime } from '../lib/api'
import type { NewsResp } from '../lib/api'
import { ApiStatus, ErrorState, LoadingState, SectionHeader, SourceLine } from '../components/ui'

const IMPACT_CLS: Record<string, string> = {
  HIGH: 'bg-red-500/15 text-red-300 border-red-500/30',
  MEDIUM: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  LOW: 'bg-white/5 text-slate-300 border-white/10',
}

export default function News() {
  const { data, loading, error, updatedAt, refetch } = useApi<NewsResp>('/api/news', 300)
  const high = (data?.fedEvents ?? []).filter((e) => e.impact === 'HIGH')
  const status = error ? 'UNAVAILABLE' : data?.status ?? 'DEGRADED'

  return (
    <div>
      <SectionHeader
        title="News & Fed"
        subtitle="Fed and economic events from official schedules only (federalreserve.gov, BLS, BEA) plus crypto news from public RSS (CoinDesk / CoinTelegraph). Actual / forecast / previous values are null unless the source provides them — never invented."
        right={<SourceLine source="Fed schedules + crypto RSS" updatedAt={updatedAt} status={status} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {high.length > 0 && (
        <div className="mb-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
          <div className="font-bold text-red-200">⚠ HIGH IMPACT warning — {high.length} high-impact event{high.length > 1 ? 's' : ''} ahead</div>
          <p className="mt-1 text-sm text-red-200/80">Expect sharp volatility in BTC, gold and the dollar around these releases. The v3-B volatility guard blocks entries when true range exceeds 2.5× ATR.</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-slate-400">Fed & economic events</h2>
          {(data?.fedEvents ?? []).length === 0 && !loading && (
            <div className="glass p-5 text-sm text-slate-400">No Fed/economic events in the feed.</div>
          )}
          <div className="space-y-3">
            {(data?.fedEvents ?? []).map((e) => (
              <article key={e.id} className="glass p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="font-semibold">{e.title}</div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${IMPACT_CLS[e.impact]}`}>{e.impact}</span>
                </div>
                <div className="tnum mt-1 text-xs text-slate-400">{e.date} · {e.time} · Assets: {e.assets}</div>
                <dl className="tnum mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-slate-500">Actual</dt><dd className="font-semibold">{e.actual ?? '—'}</dd></div>
                  <div><dt className="text-slate-500">Forecast</dt><dd className="font-semibold">{e.forecast ?? '—'}</dd></div>
                  <div><dt className="text-slate-500">Previous</dt><dd className="font-semibold">{e.previous ?? '—'}</dd></div>
                </dl>
                <a href={e.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-sky-300 hover:underline">Source: {e.source} ↗</a>
              </article>
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-slate-400">Crypto news</h2>
          {(data?.cryptoNews ?? []).length === 0 && !loading && (
            <div className="glass p-5 text-sm text-slate-400">No crypto news in the feed — RSS unavailable, not invented.</div>
          )}
          <div className="space-y-3">
            {(data?.cryptoNews ?? []).map((n, i) => (
              <article key={`${n.url}-${i}`} className="glass p-4">
                <a href={n.url} target="_blank" rel="noreferrer" className="font-semibold text-slate-100 hover:text-sky-300 hover:underline">{n.title}</a>
                {n.summary && <p className="mt-1 text-sm text-slate-400">{n.summary}</p>}
                <div className="mt-2 text-xs text-slate-500">{n.source} · {fmtTime(n.publishedAt)}</div>
              </article>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            Feed status: <ApiStatus status={status} />
          </div>
        </div>
      </div>
    </div>
  )
}
