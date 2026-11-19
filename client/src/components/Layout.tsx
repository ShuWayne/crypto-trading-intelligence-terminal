import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useApi } from '../lib/hooks'
import type { HealthResp } from '../lib/api'
import { ApiStatus } from './ui'

export const NAV = [
  { to: '/', label: 'Overview', icon: '◈', end: true },
  { to: '/markets', label: 'Live Markets', icon: '◉' },
  { to: '/signals', label: 'Trading Signals', icon: '⚡' },
  { to: '/indicator', label: 'Indicator', icon: '◐' },
  { to: '/gold', label: 'Gold Intelligence', icon: '◆' },
  { to: '/scanner', label: 'Market Scanner', icon: '◎' },
  { to: '/news', label: 'News & Fed', icon: '📰' },
  { to: '/charts', label: 'Advanced Charts', icon: '📈' },
  { to: '/risk', label: 'Risk Management', icon: '🛡' },
  { to: '/backtest', label: 'Backtesting', icon: '🧪' },
  { to: '/history', label: 'Trade History', icon: '≡' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

function HealthBadge() {
  const { data, error } = useApi<HealthResp>('/api/health', 30)
  if (error || !data) return <ApiStatus status="UNAVAILABLE" label="API UNAVAILABLE" />
  const rest = data.binance?.rest === 'ok' || data.binance?.rest === 'LIVE' ? 'LIVE' : 'DEGRADED'
  const ws = data.binance?.ws === 'ok' || data.binance?.ws === 'LIVE' ? 'LIVE' : 'DEGRADED'
  const status = rest === 'LIVE' && ws === 'LIVE' ? 'LIVE' : 'DEGRADED'
  return <ApiStatus status={status} label={`API ${status} · BINANCE ${rest}/${ws}`} />
}

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const loc = useLocation()
  const current = NAV.find((n) => (n.end ? loc.pathname === '/' : loc.pathname.startsWith(n.to))) ?? NAV[0]

  const navList = (
    <nav className="space-y-1 px-3 py-4">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
              isActive
                ? 'border border-sky-500/40 bg-sky-500/15 text-sky-200 shadow-glow'
                : 'border border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-100'
            }`
          }
        >
          <span className="w-5 text-center">{n.icon}</span>
          {n.label}
        </NavLink>
      ))}
      <div className="px-3 pt-6 text-[11px] leading-relaxed text-slate-500">
        Paper trading only.
        <br />No live orders. No API keys.
        <br />Signals: validated strategy v3-B (BTC + SOL, 4h).
      </div>
    </nav>
  )

  return (
    <div className="aurora min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#05070d]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-3">
          <button className="rounded-lg border border-white/10 px-2.5 py-1.5 text-slate-200 lg:hidden" onClick={() => setMobileOpen((v) => !v)} aria-label="Toggle navigation">☰</button>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-electric via-cyanx to-violetx text-lg font-black text-white shadow-glow">C</span>
            <div className="leading-tight">
              <div className="text-[15px] font-extrabold tracking-tight text-white">CTIT <span className="text-slate-400 font-semibold">— Crypto Trading Intelligence Terminal</span></div>
              <div className="text-[11px] text-slate-400">Institutional-grade signals · paper trading only</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-slate-400 sm:inline">{current.label}</span>
            <HealthBadge />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1500px]">
        {/* Desktop sidebar */}
        <aside className="sticky top-[57px] hidden h-[calc(100vh-57px)] w-60 shrink-0 overflow-y-auto border-r border-white/5 lg:block">
          {navList}
        </aside>
        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setMobileOpen(false)}>
            <div className="absolute inset-0 bg-black/70" />
            <aside className="absolute left-0 top-0 h-full w-64 overflow-y-auto border-r border-white/10 bg-[#070b14]" onClick={(e) => e.stopPropagation()}>
              {navList}
            </aside>
          </div>
        )}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6">
          <Outlet />
          <footer className="mt-10 border-t border-white/5 pt-4 text-[11px] text-slate-500">
            CTIT · Market data: Binance public REST/WebSocket (no keys). PAXG is a gold proxy on Binance, not spot XAUUSD.
            Signals follow validated strategy v3-B only. Nothing here is financial advice. Paper trading only — no live orders.
          </footer>
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex justify-around border-t border-white/10 bg-[#05070d]/95 px-1 py-2 backdrop-blur-xl lg:hidden">
        {NAV.slice(0, 6).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `flex flex-col items-center px-1 text-[10px] ${isActive ? 'text-sky-300' : 'text-slate-400'}`}>
            <span className="text-base leading-none">{n.icon}</span>
            <span className="mt-0.5">{n.label.split(' ')[0]}</span>
          </NavLink>
        ))}
      </nav>
      <div className="h-14 lg:hidden" />
    </div>
  )
}
