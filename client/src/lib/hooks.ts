import { useCallback, useEffect, useRef, useState } from 'react'

export type ApiState<T> = { data: T | null; loading: boolean; error: string | null; updatedAt: string | null }

/** Polling fetch hook with loading/error states. `refreshSec` 0 disables polling. */
export function useApi<T>(url: string | null, refreshSec = 0): ApiState<T> & { refetch: () => void } {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null, updatedAt: null })
  const tick = useRef(0)
  const load = useCallback(async () => {
    if (!url) return
    const my = ++tick.current
    setState((s) => ({ ...s, loading: s.data === null, error: null }))
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as T & { updatedAt?: string }
      if (tick.current !== my) return
      setState({ data: json, loading: false, error: null, updatedAt: json.updatedAt ?? new Date().toISOString() })
    } catch (e) {
      if (tick.current !== my) return
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : 'Fetch failed' }))
    }
  }, [url])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!refreshSec || !url) return
    const id = setInterval(load, refreshSec * 1000)
    return () => clearInterval(id)
  }, [refreshSec, url, load])
  return { ...state, refetch: load }
}

export interface TickMsg { type: 'ticker'; symbol: string; price: number; change24hPct: number; ts: number }
export type WsStatus = 'LIVE' | 'DEGRADED' | 'UNAVAILABLE'

/** Live ticker WebSocket via the Vite /ws proxy; falls back to REST polling (DEGRADED). */
export function useTickers(symbols: string[], refreshSec = 5): { ticks: Record<string, TickMsg>; wsStatus: WsStatus; lastTs: number | null } {
  const [ticks, setTicks] = useState<Record<string, TickMsg>>({})
  const [wsStatus, setWsStatus] = useState<WsStatus>('UNAVAILABLE')
  const [lastTs, setLastTs] = useState<number | null>(null)
  const wsOk = useRef(false)

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`)
    ws.onopen = () => { wsOk.current = true; setWsStatus('LIVE') }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as TickMsg | { type: string }
        if (msg.type === 'ticker') {
          const t = msg as TickMsg
          setTicks((p) => ({ ...p, [t.symbol]: t }))
          setLastTs(t.ts)
        }
      } catch { /* ignore malformed frames */ }
    }
    ws.onerror = () => { wsOk.current = false; setWsStatus('DEGRADED') }
    ws.onclose = () => { wsOk.current = false; setWsStatus((s) => (s === 'LIVE' ? 'DEGRADED' : s)) }
    return () => ws.close()
  }, [])

  // REST polling fallback when WS is not live
  useEffect(() => {
    if (wsStatus === 'LIVE') return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/api/markets/overview')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as { symbols: { symbol: string; price: number; change24hPct: number }[] }
        if (cancelled) return
        const now = Date.now()
        const next: Record<string, TickMsg> = {}
        for (const s of json.symbols) next[s.symbol] = { type: 'ticker', symbol: s.symbol, price: s.price, change24hPct: s.change24hPct, ts: now }
        setTicks((p) => ({ ...next, ...p }))
        setLastTs(now)
        setWsStatus((s) => (s === 'LIVE' ? s : 'DEGRADED'))
      } catch {
        if (!cancelled) setWsStatus('UNAVAILABLE')
      }
    }
    poll()
    const id = setInterval(poll, refreshSec * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [wsStatus, refreshSec, symbols.join(',')])

  return { ticks, wsStatus, lastTs }
}
