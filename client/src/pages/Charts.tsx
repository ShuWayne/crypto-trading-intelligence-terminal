import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { INTERVALS, SYMBOLS, fmtPrice, shortSymbol } from '../lib/api'
import type { Candle, KlinesResp, SignalsResp } from '../lib/api'
import { useApi } from '../lib/hooks'
import { ErrorState, LoadingState, SectionHeader, SourceLine } from '../components/ui'

// --- client-side indicators (closed candles only, no lookahead) ---
function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1)
  const out: (number | null)[] = new Array(values.length).fill(null)
  let prev: number | null = null
  values.forEach((v, i) => {
    if (i < period - 1) return
    if (prev === null) {
      let s = 0
      for (let j = i - period + 1; j <= i; j++) s += values[j]
      prev = s / period
    } else prev = v * k + prev * (1 - k)
    out[i] = prev
  })
  return out
}
function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  let gain = 0, loss = 0
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const g = Math.max(d, 0), l = Math.max(-d, 0)
    if (i <= period) { gain += g; loss += l; if (i === period) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) }
    else {
      gain = (gain * (period - 1) + g) / period
      loss = (loss * (period - 1) + l) / period
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
    }
  }
  return out
}
function atr(candles: Candle[], period = 14): (number | null)[] {
  const tr: number[] = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)))
  const out: (number | null)[] = new Array(candles.length).fill(null)
  let prev: number | null = null
  tr.forEach((v, i) => {
    if (i < period - 1) return
    if (prev === null) { let s = 0; for (let j = 0; j < period; j++) s += tr[j]; prev = s / period }
    else prev = (prev * (period - 1) + v) / period
    out[i] = prev
  })
  return out
}
function swingLevels(candles: Candle[], n = 20): { support: number; resistance: number } {
  const win = candles.slice(-60)
  let hi = -Infinity, lo = Infinity
  for (const c of win) { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low) }
  void n
  return { support: lo, resistance: hi }
}

type Overlay = 'EMA' | 'BB' | 'RSI' | 'MACD' | 'ATR' | 'SR'

export default function Charts() {
  const [symbol, setSymbol] = useState<string>('BTCUSDT')
  const [interval, setInterval] = useState<string>('4h')
  const [overlays, setOverlays] = useState<Overlay[]>(['EMA', 'RSI', 'SR'])
  const klines = useApi<KlinesResp>(`/api/markets/klines?symbol=${symbol}&interval=${interval}&limit=300`, 30)
  const signals = useApi<SignalsResp>('/api/signals', 60)
  const chartRef = useRef<HTMLDivElement>(null)
  const rsiRef = useRef<HTMLDivElement>(null)
  const macdRef = useRef<HTMLDivElement>(null)
  const chartApi = useRef<IChartApi | null>(null)

  const candles = useMemo(() => klines.data?.candles ?? [], [klines.data])
  const activeSignal = (signals.data?.signals ?? []).find((s) => s.symbol === symbol && s.status === 'ACTIVE')

  useEffect(() => {
    if (!chartRef.current || candles.length === 0) return
    const el = chartRef.current
    const chart = createChart(el, {
      width: el.clientWidth, height: 460,
      layout: { background: { color: 'transparent' }, textColor: '#94a3b8', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.12)', timeVisible: true },
      crosshair: { mode: 0 },
    })
    chartApi.current = chart
    // NOTE: API returns candle open time in milliseconds; Lightweight Charts
    // wants UTCTimestamp in SECONDS — dividing once here fixes the time axis.
    const times = candles.map((c) => Math.floor(c.time / 1000) as UTCTimestamp)
    const candleSeries = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false })
    candleSeries.setData(candles.map((c, i) => ({ time: times[i], open: c.open, high: c.high, low: c.low, close: c.close })))
    const volSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' })
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    volSeries.setData(candles.map((c, i) => ({ time: times[i], value: c.volume, color: c.close >= c.open ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)' })))
    const closes = candles.map((c) => c.close)

    if (overlays.includes('EMA')) {
      const mk = (period: number, color: string) => {
        const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
        s.setData(ema(closes, period).map((v, i) => ({ time: times[i], value: v ?? NaN })).filter((p) => !Number.isNaN(p.value)))
      }
      mk(20, '#22d3ee'); mk(50, '#8b5cf6'); mk(200, '#f59e0b')
    }
    if (overlays.includes('BB')) {
      const sma20 = ema(closes, 20)
      const upper = chart.addLineSeries({ color: 'rgba(47,123,255,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      const lower = chart.addLineSeries({ color: 'rgba(47,123,255,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      const up: { time: UTCTimestamp; value: number }[] = []
      const dn: { time: UTCTimestamp; value: number }[] = []
      closes.forEach((_, i) => {
        if (i < 19 || sma20[i] === null) return
        const slice = closes.slice(i - 19, i + 1)
        const mean = slice.reduce((a, b) => a + b, 0) / 20
        const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20)
        up.push({ time: times[i], value: mean + 2 * sd })
        dn.push({ time: times[i], value: mean - 2 * sd })
      })
      upper.setData(up); lower.setData(dn)
    }
    if (overlays.includes('SR')) {
      const { support, resistance } = swingLevels(candles)
      const mkLine = (price: number, color: string, title: string) => {
        const s = chart.addLineSeries({ color, lineWidth: 1, lineStyle: 2, priceLineVisible: true, lastValueVisible: false, crosshairMarkerVisible: false, title })
        s.setData([{ time: times[0], value: price }, { time: times[times.length - 1], value: price }])
      }
      mkLine(support, '#22c55e', 'S')
      mkLine(resistance, '#ef4444', 'R')
    }
    if (activeSignal) {
      const mk = (price: number, color: string, title: string) => {
        const s = chart.addLineSeries({ color, lineWidth: 2, lineStyle: 0, priceLineVisible: true, lastValueVisible: true, crosshairMarkerVisible: false, title })
        s.setData([{ time: times[0], value: price }, { time: times[times.length - 1], value: price }])
      }
      mk(activeSignal.entry, '#22d3ee', 'ENTRY')
      mk(activeSignal.stopLoss, '#ef4444', 'SL')
      mk(activeSignal.takeProfit, '#22c55e', 'TP validated 3.0xATR')
    }
    chart.timeScale().fitContent()

    // RSI pane
    let rsiChart: IChartApi | null = null
    if (overlays.includes('RSI') && rsiRef.current) {
      rsiChart = createChart(rsiRef.current, { width: rsiRef.current.clientWidth, height: 140, layout: { background: { color: 'transparent' }, textColor: '#94a3b8' }, grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } }, rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' }, timeScale: { borderColor: 'rgba(255,255,255,0.12)' } })
      const rs = rsiChart.addLineSeries({ color: '#8b5cf6', lineWidth: 1, priceLineVisible: false })
      rs.setData(rsi(closes).map((v, i) => ({ time: times[i], value: v ?? NaN })).filter((p) => !Number.isNaN(p.value)))
      rsiChart.timeScale().fitContent()
    }
    // MACD pane
    let macdChart: IChartApi | null = null
    if (overlays.includes('MACD') && macdRef.current) {
      macdChart = createChart(macdRef.current, { width: macdRef.current.clientWidth, height: 140, layout: { background: { color: 'transparent' }, textColor: '#94a3b8' }, grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } }, rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' }, timeScale: { borderColor: 'rgba(255,255,255,0.12)' } })
      const e12 = ema(closes, 12), e26 = ema(closes, 26)
      const macdLine = closes.map((_, i) => (e12[i] !== null && e26[i] !== null ? (e12[i] as number) - (e26[i] as number) : NaN))
      const sig = ema(macdLine.map((v) => (Number.isNaN(v) ? 0 : v)), 9)
      const ms = macdChart.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceLineVisible: false })
      ms.setData(macdLine.map((v, i) => ({ time: times[i], value: v })).filter((p) => !Number.isNaN(p.value)))
      const ss = macdChart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false })
      ss.setData(sig.map((v, i) => ({ time: times[i], value: v ?? NaN })).filter((p) => !Number.isNaN(p.value)))
      macdChart.timeScale().fitContent()
    }

    const onResize = () => { chart.applyOptions({ width: el.clientWidth }); rsiChart?.applyOptions({ width: rsiRef.current?.clientWidth ?? 0 }); macdChart?.applyOptions({ width: macdRef.current?.clientWidth ?? 0 }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove(); rsiChart?.remove(); macdChart?.remove()
      chartApi.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, overlays, activeSignal?.id])

  const atrVals = useMemo(() => atr(candles), [candles])
  const lastAtr = [...atrVals].reverse().find((v) => v !== null) ?? null
  const lastClose = candles.length ? candles[candles.length - 1].close : null
  const toggle = (o: Overlay) => setOverlays((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))

  return (
    <div>
      <SectionHeader
        title="Advanced Charts"
        subtitle="TradingView Lightweight Charts — candlesticks + volume, EMA 20/50/200, Bollinger Bands, RSI, MACD, ATR and swing S/R. When a v3-B signal is active for the selected symbol, its entry / SL / TP overlay lines are drawn on the chart (single validated TP at 3.0×ATR)."
        right={<SourceLine source="Binance klines · public API" updatedAt={klines.updatedAt} status={klines.error ? 'UNAVAILABLE' : klines.data ? 'LIVE' : 'DEGRADED'} />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold">
          {SYMBOLS.map((s) => <option key={s} value={s}>{shortSymbol(s)} / USDT</option>)}
        </select>
        <div className="flex gap-1">
          {INTERVALS.map((iv) => (
            <button key={iv} onClick={() => setInterval(iv)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${interval === iv ? 'bg-electric text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{iv}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['EMA', 'BB', 'RSI', 'MACD', 'ATR', 'SR'] as Overlay[]).map((o) => (
            <button key={o} onClick={() => toggle(o)} className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${overlays.includes(o) ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200' : 'border-white/10 bg-white/5 text-slate-400'}`}>{o}</button>
          ))}
        </div>
      </div>

      {klines.error && <ErrorState error={klines.error} onRetry={klines.refetch} />}
      {klines.loading && !klines.data && <LoadingState label="Loading candles…" />}

      {candles.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            <span className="tnum">Last close <b>${fmtPrice(lastClose)}</b></span>
            <span className="tnum">ATR(14) <b>{lastAtr !== null ? `$${lastAtr.toFixed(2)}` : '—'}</b></span>
            <span className="tnum">Candles <b>{candles.length}</b></span>
            {activeSignal && <span className="font-semibold text-cyan-300">● Active {activeSignal.side} signal overlaid (entry ${fmtPrice(activeSignal.entry)} · SL ${fmtPrice(activeSignal.stopLoss)} · TP ${fmtPrice(activeSignal.takeProfit)})</span>}
          </div>
          <div className="glass overflow-hidden p-2">
            <div ref={chartRef} className="w-full" />
            {overlays.includes('RSI') && <div className="mt-1 border-t border-white/10 pt-1"><div className="px-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">RSI (14) — extremes &lt;32 / &gt;68</div><div ref={rsiRef} className="w-full" /></div>}
            {overlays.includes('MACD') && <div className="mt-1 border-t border-white/10 pt-1"><div className="px-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">MACD (12, 26, 9)</div><div ref={macdRef} className="w-full" /></div>}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
            <span><span className="text-cyan-300">—</span> EMA 20</span><span><span className="text-violet-300">—</span> EMA 50</span><span><span className="text-amber-300">—</span> EMA 200</span>
            <span><span className="text-emerald-300">┄</span> Support (60-candle swing low)</span><span><span className="text-red-300">┄</span> Resistance (60-candle swing high)</span>
            {activeSignal && <><span><span className="text-cyan-300">—</span> Entry</span><span><span className="text-red-300">—</span> SL</span><span><span className="text-emerald-300">—</span> TP validated (3.0×ATR)</span></>}
          </div>
        </>
      )}
    </div>
  )
}
