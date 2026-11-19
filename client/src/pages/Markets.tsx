import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useApi, useTickers } from '../lib/hooks'
import { SYMBOLS, fmt, fmtPct, fmtPrice, fmtTime, shortSymbol } from '../lib/api'
import type { OverviewResp } from '../lib/api'
import { ApiStatus, ErrorState, LoadingState, SectionHeader, SourceLine } from '../components/ui'

export default function Markets() {
  const { data, loading, error, updatedAt, refetch } = useApi<OverviewResp>('/api/markets/overview', 5)
  const { ticks, wsStatus, lastTs } = useTickers([...SYMBOLS], 5)
  const prev = useRef<Record<string, number>>({})
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({})

  useEffect(() => {
    const next: Record<string, 'up' | 'down'> = {}
    for (const [sym, t] of Object.entries(ticks)) {
      const p = prev.current[sym]
      if (p !== undefined && t.price !== p) next[sym] = t.price > p ? 'up' : 'down'
      prev.current[sym] = t.price
    }
    if (Object.keys(next).length) {
      setFlash(next)
      const id = setTimeout(() => setFlash({}), 900)
      return () => clearTimeout(id)
    }
  }, [ticks])

  const rows = data?.symbols ?? []
  const status = error ? 'UNAVAILABLE' : wsStatus === 'LIVE' ? 'LIVE' : 'DEGRADED'

  return (
    <div>
      <SectionHeader
        title="Live Markets"
        subtitle="All 8 tracked symbols from Binance public data. Prices tick live via WebSocket; if WS drops, the feed falls back to 5-second REST polling."
        right={
          <div className="flex flex-col items-end gap-1.5">
            <ApiStatus status={status} label={wsStatus === 'LIVE' ? 'LIVE · WS' : wsStatus === 'DEGRADED' ? 'DEGRADED · REST POLLING' : 'UNAVAILABLE'} />
            <SourceLine source={data?.source ?? 'Binance public API'} updatedAt={updatedAt} />
            {lastTs && <span className="text-[11px] text-slate-400">Last tick {fmtTime(new Date(lastTs).toISOString())}</span>}
          </div>
        }
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {rows.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-widest text-slate-400">
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">24h %</th>
                <th className="px-4 py-3 text-right">24h High / Low</th>
                <th className="px-4 py-3 text-right">24h Volume</th>
                <th className="px-4 py-3 text-right">Funding</th>
                <th className="px-4 py-3 text-right">Open interest</th>
                <th className="px-4 py-3 text-right">Market cap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const live = ticks[s.symbol]
                const price = live?.price ?? s.price
                const chg = live?.change24hPct ?? s.change24hPct
                const f = flash[s.symbol]
                return (
                  <tr key={s.symbol} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-bold">{shortSymbol(s.symbol)}<span className="ml-1 text-xs font-normal text-slate-500">/ USDT</span></td>
                    <td className={`tnum px-4 py-3 text-right font-semibold ${f ? (f === 'up' ? 'tick-up text-emerald-300' : 'tick-down text-red-300') : ''}`}>${fmtPrice(price)}</td>
                    <td className={`tnum px-4 py-3 text-right font-semibold ${chg >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtPct(chg)}</td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">${fmtPrice(s.high24h)} / ${fmtPrice(s.low24h)}</td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">{fmt(s.volume24h, 0)}</td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">{s.fundingRate === null ? '—' : `${(s.fundingRate * 100).toFixed(4)}%`}</td>
                    <td className="tnum px-4 py-3 text-right text-slate-300">{s.openInterest === null ? '—' : fmt(s.openInterest, 0)}</td>
                    <td className="px-4 py-3 text-right text-slate-500">—</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </motion.div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Market cap is not provided by Binance spot data, so it is shown as "—" rather than invented. Funding and open interest are null when the spot feed does not carry them.
      </p>
    </div>
  )
}
