import { useEffect, useState } from 'react'
import { apiPost, SYMBOLS } from '../lib/api'
import { useApi } from '../lib/hooks'
import type { SettingsResp } from '../lib/api'
import { ErrorState, LoadingState, SectionHeader, SourceLine } from '../components/ui'

export default function Settings() {
  const { data, loading, error, refetch } = useApi<SettingsResp>('/api/settings', 0)
  const [dailyLossLimit, setDailyLossLimit] = useState(25)
  const [riskPerTrade, setRiskPerTrade] = useState(15)
  const [symbols, setSymbols] = useState<string[]>([...SYMBOLS])
  const [refreshSec, setRefreshSec] = useState(10)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data) {
      setDailyLossLimit(data.dailyLossLimit)
      setRiskPerTrade(data.riskPerTrade)
      setSymbols(data.symbols?.length ? data.symbols : [...SYMBOLS])
      setRefreshSec(data.refreshSec)
    }
  }, [data])

  const toggleSymbol = (s: string) =>
    setSymbols((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))

  const save = async () => {
    setSaving(true); setMsg('Saving…')
    try {
      await apiPost('/api/settings', { dailyLossLimit, riskPerTrade, symbols, refreshSec })
      await apiPost('/api/risk/config', { dailyLossLimit, riskPerTrade })
      setMsg('Settings saved — daily loss limit $' + dailyLossLimit + ', risk $' + riskPerTrade + '/trade, refresh every ' + refreshSec + 's.')
      refetch()
    } catch (e) {
      setMsg('Save failed: ' + (e instanceof Error ? e.message : 'unknown error'))
    }
    setSaving(false)
  }

  return (
    <div>
      <SectionHeader
        title="Settings"
        subtitle="Risk limits, tracked symbols and refresh rate. Saved to the backend (POST /api/settings and POST /api/risk/config) and persisted in SQLite — not just in the browser."
        right={<SourceLine source="Backend settings store" status={error ? 'UNAVAILABLE' : data ? 'LIVE' : 'DEGRADED'} />}
      />
      {error && <ErrorState error={error} onRetry={refetch} />}
      {loading && !data && <LoadingState />}

      {data && (
        <div className="grid max-w-3xl gap-4">
          <div className="glass p-5">
            <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Risk limits</h2>
            <div className="mt-4 space-y-5 text-sm">
              <label className="block">Daily loss limit — <b className="tnum">${dailyLossLimit}</b> <span className="text-slate-400">(allowed $20–$30 — enforced by the backend)</span>
                <input type="range" min={20} max={30} step={1} value={dailyLossLimit} onChange={(e) => setDailyLossLimit(Number(e.target.value))} className="mt-1 w-full" />
                <span className="text-xs text-slate-500">Hitting this halts all new entries for the day. Absolute cap −$30/day is a NO-GO for live.</span>
              </label>
              <label className="block">Risk per trade — <b className="tnum">${riskPerTrade}</b>
                <input type="range" min={5} max={30} step={1} value={riskPerTrade} onChange={(e) => setRiskPerTrade(Number(e.target.value))} className="mt-1 w-full" />
                <span className="text-xs text-slate-500">Validated v3-B uses $15/trade. Changing this changes paper sizing, not the validated backtest.</span>
              </label>
            </div>
          </div>

          <div className="glass p-5">
            <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Tracked symbols</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {SYMBOLS.map((s) => (
                <button key={s} onClick={() => toggleSymbol(s)}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold ${symbols.includes(s) ? 'border-sky-500/50 bg-sky-500/15 text-sky-200' : 'border-white/10 bg-white/5 text-slate-400'}`}>
                  {s.replace('USDT', '')}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Signal engine still only trades BTC + SOL — the validated v3-B universe. Unchecking a symbol removes it from markets/scanner views, not from validation.</p>
          </div>

          <div className="glass p-5">
            <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Refresh rate</h2>
            <div className="mt-3 flex gap-2">
              {[5, 10, 30, 60].map((n) => (
                <button key={n} onClick={() => setRefreshSec(n)} className={`rounded-xl px-3.5 py-2 text-sm font-semibold ${refreshSec === n ? 'bg-electric text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>
                  {n}s
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Polling interval for REST-backed views. Live tickers use WebSocket when available and fall back to 5s polling.</p>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving} className="rounded-xl bg-electric px-5 py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            {msg && <p className="text-sm text-slate-300">{msg}</p>}
          </div>

          <div className="glass p-5 text-xs leading-relaxed text-slate-500">
            About this terminal: market data is Binance public REST/WebSocket only — no API keys, no auth. Paper trading only; there is no order code anywhere.
            PAXG is a gold proxy on Binance, not spot XAUUSD. Signals come only from validated strategy v3-B (47.1% WR, PF 1.75, +$72.42 over 240 days, 17 trades).
            Nothing here is financial advice.
          </div>
        </div>
      )}
    </div>
  )
}
