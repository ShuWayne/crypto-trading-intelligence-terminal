import { useApi } from '../lib/hooks'
import { fmt, fmtPct, fmtPrice, shortSymbol } from '../lib/api'
import type { ScannerResp } from '../lib/api'
import { ApiStatus, ErrorState, LoadingState, SectionHeader, SourceLine } from '../components/ui'

const REGIME_CLS: Record<string, string> = {
  RANGING: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  TRENDING_UP: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  TRENDING_DOWN: 'bg-red-500/15 text-red-300 border-red-500/30',
}
const SETUP_CLS: Record<string, string> = {
  LONG_SETUP: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  SHORT_SETUP: 'bg-red-500/15 text-red-300 border-red-500/30',
  NONE: 'bg-white/5 text-slate-400 border-white/10',
}

export default function Scanner() {
  const { data, loading, error, updatedAt, refetch } = useApi<ScannerResp>('/api/scanner', 30)

  return (
    <div>
      <SectionHeader
        title="Market Scanner"
        subtitle="Per-symbol regime on the 4h timeframe: ranging vs trending, RSI(14), ATR(14), volume spikes and v3-B setup flags. Only BTC and SOL can produce validated signals; other symbols are context."
        right={<SourceLine source="Scanner engine · Binance 4h candles" updatedAt={updatedAt} status={error ? 'UNAVAILABLE' : data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {data && data.rows.length > 0 && (
        <div className="glass overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-widest text-slate-400">
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">24h %</th>
                <th className="px-4 py-3 text-right">RSI 14 · 4h</th>
                <th className="px-4 py-3 text-right">ATR 14 · 4h</th>
                <th className="px-4 py-3 text-right">SMA 20 / 50</th>
                <th className="px-4 py-3">Regime</th>
                <th className="px-4 py-3 text-right">Range width</th>
                <th className="px-4 py-3">Volume spike</th>
                <th className="px-4 py-3">Setup</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const rsiTone = r.rsi14_4h < 32 || r.rsi14_4h > 68 ? 'text-amber-300 font-bold' : 'text-slate-200'
                return (
                  <tr key={r.symbol} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-bold">{shortSymbol(r.symbol)}</td>
                    <td className="tnum px-4 py-3 text-right font-semibold">${fmtPrice(r.price)}</td>
                    <td className={`tnum px-4 py-3 text-right font-semibold ${r.change24hPct >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtPct(r.change24hPct)}</td>
                    <td className={`tnum px-4 py-3 text-right ${rsiTone}`}>{fmt(r.rsi14_4h, 1)}{(r.rsi14_4h < 32 || r.rsi14_4h > 68) ? ' ⚠' : ''}</td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">${fmt(r.atr14_4h, 2)}</td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">${fmtPrice(r.sma20)} / ${fmtPrice(r.sma50)}</td>
                    <td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REGIME_CLS[r.regime] ?? ''}`}>{r.regime.replace('_', ' ')}</span></td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">{fmt(r.rangeWidthAtr, 1)}× ATR</td>
                    <td className="px-4 py-3">{r.volumeSpike ? <span className="font-semibold text-amber-300">SPIKE</span> : <span className="text-slate-500">—</span>}</td>
                    <td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SETUP_CLS[r.signal] ?? ''}`}>{r.signal.replace('_', ' ')}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {data.rows.filter((r) => r.signal !== 'NONE').map((r) => (
            <div key={r.symbol} className="glass border-amber-500/30 p-4 text-sm">
              <b>{shortSymbol(r.symbol)}</b> — {r.signal.replace('_', ' ')}: {r.reason}
            </div>
          ))}
          {data.rows.every((r) => r.signal === 'NONE') && (
            <div className="glass p-4 text-sm text-slate-400 md:col-span-2">No setup flags on any symbol right now. v3-B requires a ranging regime with a boundary touch and an RSI extreme — absence of a flag is normal.</div>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">RSI extremes (&lt;32 / &gt;68) are highlighted — they are one of the v3-B entry conditions, not a signal on their own.</p>
    </div>
  )
}
