// API types + fetch helpers. Contract: ~/workspace/trading/terminal/ARCHITECTURE.md
export const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','TONUSDT','PAXGUSDT'] as const
export const SIGNAL_SYMBOLS = ['BTCUSDT','SOLUSDT'] as const
export const INTERVALS = ['1m','5m','15m','1h','4h','1d'] as const

export interface MarketSymbol {
  symbol: string; price: number; change24hPct: number; high24h: number; low24h: number
  volume24h: number; quoteVolume24h: number; fundingRate: number | null
  openInterest: number | null; marketCap: number | null
}
export interface OverviewResp { updatedAt: string; source: string; symbols: MarketSymbol[] }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface KlinesResp { symbol: string; interval: string; candles: Candle[] }
export interface ScannerRow {
  symbol: string; price: number; change24hPct: number; rsi14_4h: number; atr14_4h: number
  sma20: number; sma50: number; regime: 'RANGING' | 'TRENDING_UP' | 'TRENDING_DOWN'
  rangeWidthAtr: number; volumeSpike: boolean; signal: 'LONG_SETUP' | 'SHORT_SETUP' | 'NONE'; reason: string
}
export interface ScannerResp { updatedAt: string; rows: ScannerRow[] }
export interface Signal {
  id: string; symbol: string; side: 'BUY' | 'SELL'; entry: number; stopLoss: number
  takeProfit: number; riskReward: '1:2' | number; confidence: number
  timeframe: '4h'; expiresAt: string; structure: string; reason: string; invalidation: string
  exitConditions: string[]; signalTimestamp: string
  status: 'ACTIVE' | 'EXPIRED' | 'INVALIDATED'
}
export type MarketCondition = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'HIGH_VOLATILITY' | 'NO_TRADE'
export interface SignalsResp {
  updatedAt: string; marketCondition: MarketCondition; signals: Signal[]
  paper: { openPositions: number; todayPnl: number; tradesToday: number; halted: boolean; tradingDisabled: boolean }
}
export interface PaperTrade {
  id: string | number; symbol: string; side: string; entry: number; exit?: number | null
  entryAt?: string; exitAt?: string; reason?: string; exitReason?: string; pnl?: number | null
  status?: string; createdAt?: string
}
export interface GoldSession { open: string; close: string; active: boolean }
export interface GoldResp {
  symbol: 'PAXGUSDT'; label: string; price: number; change24hPct: number
  sessions: { asian: GoldSession; london: GoldSession; newYork: GoldSession }
  support: number[] | number; resistance: number[] | number; notes: string[]
}
export interface FedEvent {
  id: string; title: string; date: string; time: string; actual: string | number | null
  forecast: string | number | null; previous: string | number | null
  impact: 'HIGH' | 'MEDIUM' | 'LOW'; assets: string; source: string; url: string
}
export interface CryptoNewsItem { title: string; source: string; url: string; publishedAt: string; summary: string }
export interface NewsResp {
  updatedAt: string; fedEvents: FedEvent[]; cryptoNews: CryptoNewsItem[]
  status: 'LIVE' | 'DEGRADED' | 'UNAVAILABLE'
}
export interface RiskStatus {
  date: string; tradesToday: number; lossesToday: number; realizedToday: number
  openPositions: number; halted: boolean; tradingDisabled: boolean; dailyLossLimit: number
  riskPerTrade: number; maxDrawdown: number; cooldownUntil: string | null
}
export interface BacktestVariant {
  id: string; name: string; verdict: 'VALIDATED' | 'FAILED'; trades: number; winRate: number
  profitFactor: number; netPnl: number; maxDrawdown: number; worstDay?: number; notes?: string
  status?: 'VALIDATED' | 'FAILED'
  metrics?: { trades?: number; winRate?: number; profitFactor?: number; netPnl?: number; maxDrawdownPct?: number; [k: string]: unknown }
  [k: string]: unknown
}
export interface BacktestVariantsResp { variants: BacktestVariant[] }
export interface BacktestReport { id: string; variant: string; createdAt: string; metrics?: Record<string, unknown>; url?: string }
export interface SettingsResp { dailyLossLimit: number; riskPerTrade: number; symbols: string[]; refreshSec: number }
export interface HealthResp { status: string; time: string; binance: { rest: string; ws: string }; uptimeSec: number }

export type IndicatorRegime = 'RANGING' | 'TRENDING'
export type IndicatorState =
  | 'VALID_RANGE' | 'APPROACHING_LOW' | 'APPROACHING_HIGH'
  | 'CONFIRMED_BUY' | 'CONFIRMED_SELL' | 'BREAKDOWN_AVOID'
  | 'UNSUITABLE_TRENDING' | 'UNSUITABLE_VOLATILITY' | 'NO_TRADE'
export interface IndicatorSymbol {
  symbol: string; regime: IndicatorRegime; rangeLow: number | null; rangeHigh: number | null
  rangeWidthAtr: number | null; rsi: number | null; distanceToLowAtr: number | null
  distanceToHighAtr: number | null; state: IndicatorState; reason: string
}
export interface IndicatorResp {
  updatedAt: string; source?: string; status?: string; strategy?: string
  symbols: IndicatorSymbol[]
}
export type AlertType = 'BUY_SETUP' | 'EXIT_TRIGGER' | 'SL_HIT' | 'TP_HIT' | 'RANGE_INVALID' | 'VOLATILITY_UNSUITABLE'
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL'
export interface AlertItem { id: string; type: AlertType; symbol: string; message: string; time: string; severity: AlertSeverity }
export interface AlertsResp { updatedAt?: string; alerts: AlertItem[] }

export function fetchIndicator(): Promise<IndicatorResp> { return apiGet<IndicatorResp>('/api/indicator') }
export function fetchAlerts(limit = 50): Promise<AlertsResp> { return apiGet<AlertsResp>(`/api/alerts?limit=${limit}`) }

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`)
  return res.json() as Promise<T>
}
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`)
  return res.json() as Promise<T>
}

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const d = n >= 1000 ? 2 : n >= 10 ? 3 : 4
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}
export function shortSymbol(s: string): string {
  return s.replace('USDT', '')
}
