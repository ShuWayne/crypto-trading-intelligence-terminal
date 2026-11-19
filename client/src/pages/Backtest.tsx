import { useEffect, useRef, useState } from 'react'
import { createChart } from 'lightweight-charts'
import type { UTCTimestamp } from 'lightweight-charts'
import { apiGet, apiPost, fmt, fmtPct } from '../lib/api'
import { useApi } from '../lib/hooks'
import type { BacktestReport, BacktestVariantsResp } from '../lib/api'
import { ErrorState, LoadingState, SectionHeader, SourceLine } from '../components/ui'

interface RunResult {
  metrics?: Record<string, number | string>
  trades?: { time?: number; pnl?: number; symbol?: string; side?: string; entry?: number; exit?: number }[]
  // Engine returns equity points as {time: ISO string, equity: number}.
  equity?: { time: string; equity: number }[]
  [k: string]: unknown
}

const VARIANT_META: Record<string, { label: string; verdict: string; blurb: string }> = {
  'v1.0': { label: 'v1.0 — Trend Breakout', verdict: 'FAILED', blurb: '120 days, 158 trades, 27.2% WR, PF 0.43, net −$826.17. Fees ate small-ATR entries; daily cap did not cap open positions.' },
  'v2.0': { label: 'v2.0 — 4h Trend Breakout Pullback', verdict: 'FAILED', blurb: '240 days, 28 trades, 14.3% WR, PF 0.44, net −$141.25. Strengthened confirmation made entries worse (bought range tops).' },
  'v3-a': { label: 'v3-A — BTC-only Pullback', verdict: 'FAILED', blurb: '25% WR, −$28.41. The BTC pocket was H1 noise — 0/8 in H2.' },
  'v3-b': { label: 'v3-B — Range Mean-Reversion', verdict: 'VALIDATED', blurb: '240 days, 17 trades, 47.1% WR, PF 1.75, net +$72.42. The only variant passing all 5 criteria. Advances to paper trading.' },
  'v3-c': { label: 'v3-C — Momentum Breakout + Retest', verdict: 'FAILED', blurb: '32% WR, +$9.12 — all November artifact; worst day −$34.73 breaks the daily cap.' },
}

export default function Backtest() {
  const { data, loading, error, refetch } = useApi<BacktestVariantsResp>('/api/backtest/variants', 0)
  const [reports, setReports] = useState<BacktestReport[]>([])
  const [reportsError, setReportsError] = useState('')
  const [selected, setSelected] = useState('v3-b')
  const [days, setDays] = useState(240)
  const [symbols, setSymbols] = useState('BTCUSDT,SOLUSDT')
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [runError, setRunError] = useState('')
  const equityRef = useRef<HTMLDivElement>(null)

  const loadReports = async () => {
    try {
      const r = await apiGet<{ reports: BacktestReport[] }>('/api/backtest/reports')
      setReports(r.reports ?? [])
    } catch (e) { setReportsError(e instanceof Error ? e.message : 'Failed to load reports') }
  }
  useEffect(() => { loadReports() }, [])

  const variants = data?.variants ?? []
  const selectedVariant = variants.find((v) => v.id === selected || v.name?.toLowerCase().includes(selected))
  const meta = VARIANT_META[selected] ?? VARIANT_META['v3-b']

  const run = async () => {
    setRunning(true); setRunError(''); setRunResult(null)
    try {
      const res = await apiPost<RunResult>('/api/backtest/run', { variant: selected.replace('v3-', ''), symbols: symbols.split(',').map((s) => s.trim()).filter(Boolean), days })
      setRunResult(res)
      loadReports()
    } catch (e) { setRunError(e instanceof Error ? e.message : 'Backtest run failed') }
    setRunning(false)
  }

  // Equity curve
  useEffect(() => {
    const eq = runResult?.equity
    if (!equityRef.current || !eq || eq.length === 0) return
    const el = equityRef.current
    const chart = createChart(el, {
      width: el.clientWidth, height: 260,
      layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.12)' },
    })
    const series = chart.addAreaSeries({ lineColor: '#22d3ee', topColor: 'rgba(34,211,238,0.35)', bottomColor: 'rgba(34,211,238,0.02)', lineWidth: 2 })
    // Equity time is an ISO string; Lightweight Charts wants seconds.
    // The engine can emit two points on the same candle (e.g. two exits
    // in one 4h bar) — the chart requires strictly ascending times, so
    // sort and collapse duplicates, keeping the last value per timestamp.
    const pts = eq
      .map((p) => ({ time: Math.floor(new Date(p.time).getTime() / 1000) as UTCTimestamp, value: p.equity }))
      .sort((a, b) => a.time - b.time)
    const deduped: typeof pts = []
    for (const p of pts) {
      const last = deduped[deduped.length - 1]
      if (last && last.time === p.time) last.value = p.value
      else deduped.push(p)
    }
    series.setData(deduped)
    chart.timeScale().fitContent()
    const onResize = () => chart.applyOptions({ width: el.clientWidth })
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); chart.remove() }
  }, [runResult])

  const metric = (k: string): string => {
    const m = runResult?.metrics
    if (!m || m[k] === undefined) return '—'
    const v = m[k]
    return typeof v === 'number' ? fmt(v) : String(v)
  }

  return (
    <div>
      <SectionHeader
        title="Backtesting"
        subtitle="Honest results, stored from the validated runs. v1.0, v2.0, v3-A and v3-C FAILED — their numbers are shown, not hidden. Only v3-B validated and only v3-B is used for live signals. Re-runs use chronological train/test splits, no lookahead, 0.1% fee + 0.05% slippage per side."
        right={<SourceLine source="Backtest engine · stored 240-day data" status={error ? 'UNAVAILABLE' : 'LIVE'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(VARIANT_META).map(([id, m]) => (
          <button key={id} onClick={() => setSelected(id)}
            className={`rounded-xl border px-3.5 py-2 text-sm font-semibold ${selected === id ? 'border-sky-500/50 bg-sky-500/15 text-sky-200' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}`}>
            {m.label} · <span className={m.verdict === 'VALIDATED' ? 'text-emerald-300' : 'text-red-300'}>{m.verdict}</span>
          </button>
        ))}
      </div>

      {variants.length > 0 && (
        <div className="glass overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-widest text-slate-400">
                <th className="px-4 py-3">Variant</th><th className="px-4 py-3">Verdict</th><th className="px-4 py-3 text-right">Trades</th>
                <th className="px-4 py-3 text-right">Win rate</th><th className="px-4 py-3 text-right">Profit factor</th>
                <th className="px-4 py-3 text-right">Net P&L</th><th className="px-4 py-3 text-right">Max DD</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => {
                // API shape: status is 'VALIDATED'|'FAILED'; numbers live in
                // v.metrics (maxDrawdownPct, not maxDrawdown). Flat fields
                // are a legacy shape kept as fallback.
                const m = (v as unknown as { metrics?: Record<string, number> }).metrics ?? {}
                const status = (v as unknown as { status?: string }).status ?? (v.verdict === 'FAILED' ? 'FAILED' : 'VALIDATED')
                const failed = status === 'FAILED'
                const isSel = selectedVariant?.id === v.id
                const trades = m.trades ?? v.trades
                const winRate = m.winRate ?? v.winRate
                const pf = m.profitFactor ?? v.profitFactor
                const net = m.netPnl ?? v.netPnl
                const dd = m.maxDrawdownPct ?? v.maxDrawdown
                return (
                  <tr key={v.id} onClick={() => setSelected(v.id)} className={`cursor-pointer border-b border-white/5 last:border-0 hover:bg-white/[0.03] ${isSel ? 'bg-sky-500/5' : ''}`}>
                    <td className="px-4 py-3 font-semibold">{v.name}</td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${failed ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'}`}>{status}</span></td>
                    <td className="tnum px-4 py-3 text-right">{trades ?? '—'}</td>
                    <td className="tnum px-4 py-3 text-right">{winRate === undefined ? '—' : fmtPct(winRate > 1 ? winRate : winRate * 100)}</td>
                    <td className="tnum px-4 py-3 text-right">{pf === undefined ? '—' : fmt(pf)}</td>
                    <td className={`tnum px-4 py-3 text-right font-semibold ${net === undefined || net >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{net === undefined ? '—' : `$${fmt(net)}`}</td>
                    <td className="tnum px-4 py-3 text-right">{dd === undefined ? '—' : fmtPct(-Math.abs(dd))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="glass mt-4 border-amber-500/30 p-4 text-sm">
        <b>{meta.label} — {meta.verdict}</b>
        <p className="mt-1 text-slate-300">{meta.blurb}</p>
        {selectedVariant?.notes && <p className="mt-1 text-slate-400">{String(selectedVariant.notes)}</p>}
      </div>

      {/* Run new backtest */}
      <div className="glass mt-5 p-5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Run a new backtest</h2>
        <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
          <label>Variant
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className="ml-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              {Object.entries(VARIANT_META).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
            </select>
          </label>
          <label>Symbols
            <input type="text" value={symbols} onChange={(e) => setSymbols(e.target.value)} className="ml-2 w-48 rounded-lg border border-white/10 bg-white/5 px-3 py-2 tnum" />
          </label>
          <label>Days
            <input type="number" min={30} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-2 w-24 rounded-lg border border-white/10 bg-white/5 px-3 py-2 tnum" />
          </label>
          <button onClick={run} disabled={running} className="rounded-xl bg-electric px-4 py-2 font-semibold text-white hover:brightness-110 disabled:opacity-50">
            {running ? 'Running…' : 'Run backtest'}
          </button>
        </div>
        {runError && <p className="mt-3 text-sm text-red-300">{runError}</p>}
        {runResult && (
          <div className="mt-5">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[['Net P&L', `$${metric('netPnl')}`], ['Win rate', `${metric('winRate')}%`], ['Profit factor', metric('profitFactor')], ['Trades', metric('trades')], ['Max DD', `${metric('maxDrawdownPct')}%`], ['Avg R', metric('avgR')]].map(([l, v]) => (
                <div key={l} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400">{l}</div>
                  <div className="tnum mt-1 text-lg font-bold">{v}</div>
                </div>
              ))}
            </div>
            {runResult.equity && runResult.equity.length > 0 && (
              <div className="mt-4"><div className="mb-1 text-xs font-semibold uppercase tracking-widest text-slate-400">Equity curve</div><div ref={equityRef} className="w-full" /></div>
            )}
            {runResult.trades && runResult.trades.length > 0 && (
              <div className="mt-4 max-h-64 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead><tr className="text-slate-400"><th className="py-1">Symbol</th><th>Side</th><th className="text-right">Entry</th><th className="text-right">Exit</th><th className="text-right">P&L</th></tr></thead>
                  <tbody>{runResult.trades.map((t, i) => (
                    <tr key={i} className="tnum border-t border-white/5"><td className="py-1">{t.symbol ?? '—'}</td><td>{t.side ?? '—'}</td><td className="text-right">${fmt(t.entry ?? 0)}</td><td className="text-right">${fmt(t.exit ?? 0)}</td><td className={`text-right font-semibold ${(t.pnl ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>${fmt(t.pnl ?? 0)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reports */}
      <div className="glass mt-5 p-5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Saved reports</h2>
        {reportsError && <p className="mt-2 text-sm text-red-300">{reportsError}</p>}
        {reports.length === 0 && !reportsError && <p className="mt-2 text-sm text-slate-400">No saved backtest reports yet — run one above to generate the first.</p>}
        <ul className="mt-3 space-y-2 text-sm">
          {reports.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2 last:border-0">
              <span><b>{r.variant}</b> · {r.createdAt}</span>
              <a href={`/api/backtest/reports/${r.id}/download`} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20">Download report ⬇</a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
