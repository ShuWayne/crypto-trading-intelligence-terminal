import { fmtTime, timeAgo } from '../lib/api'

export type FeedStatus = 'LIVE' | 'DEGRADED' | 'UNAVAILABLE'

const styles: Record<FeedStatus, string> = {
  LIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  DEGRADED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  UNAVAILABLE: 'bg-red-500/15 text-red-300 border-red-500/30',
}
const dots: Record<FeedStatus, string> = {
  LIVE: 'bg-emerald-400 live-dot',
  DEGRADED: 'bg-amber-400',
  UNAVAILABLE: 'bg-red-400',
}

export function ApiStatus({ status, label }: { status: FeedStatus; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${styles[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dots[status]}`} />
      {label ?? status}
    </span>
  )
}

export function SourceLine({ source, updatedAt, status }: { source?: string | null; updatedAt?: string | null; status?: FeedStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
      {status && <ApiStatus status={status} />}
      {source && <span>Source: <span className="text-slate-300">{source}</span></span>}
      {updatedAt && (
        <span title={fmtTime(updatedAt)}>
          Updated {timeAgo(updatedAt)} · {fmtTime(updatedAt)}
        </span>
      )}
    </div>
  )
}

export function StatCard({ label, value, sub, tone = 'neutral', glow = false }: {
  label: string; value: string; sub?: string; tone?: 'neutral' | 'green' | 'red' | 'amber' | 'blue'; glow?: boolean
}) {
  const toneCls: Record<string, string> = {
    neutral: 'text-slate-100', green: 'text-emerald-300', red: 'text-red-300',
    amber: 'text-amber-300', blue: 'text-sky-300',
  }
  return (
    <div className={`glass glass-hover p-4 ${glow ? 'shadow-glow' : ''}`}>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`tnum mt-1 text-2xl font-bold ${toneCls[tone]}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </div>
  )
}

export function SectionHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="bg-gradient-to-r from-white via-sky-200 to-cyan-300 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-400">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function EmptyState({ title, body, tone = 'neutral' }: { title: string; body: string; tone?: 'neutral' | 'amber' | 'red' }) {
  const border = tone === 'red' ? 'border-red-500/40' : tone === 'amber' ? 'border-amber-500/40' : 'border-white/10'
  return (
    <div className={`glass ${border} p-6 text-center`}>
      <div className="text-lg font-bold text-slate-100">{title}</div>
      <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">{body}</p>
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="glass border-red-500/40 p-6 text-center">
      <ApiStatus status="UNAVAILABLE" />
      <div className="mt-3 text-sm font-semibold text-red-200">Feed unavailable — no data shown rather than invented data.</div>
      <p className="mt-1 text-xs text-slate-400">{error}. Check that the backend is running on port 3001.</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-4 rounded-lg bg-electric px-4 py-2 text-sm font-semibold text-white hover:brightness-110">Retry</button>
      )}
    </div>
  )
}

export function LoadingState({ label = 'Loading live data…' }: { label?: string }) {
  return (
    <div className="glass p-6 text-center text-sm text-slate-400">
      <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent align-middle" />
      {label}
    </div>
  )
}
