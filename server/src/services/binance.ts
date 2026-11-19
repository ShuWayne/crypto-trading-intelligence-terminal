/**
 * Binance PUBLIC market-data client — no API keys, no orders, no trading.
 *
 * REST primary: https://data-api.binance.vision
 * REST fallback: https://api.binance.us
 * (api.binance.com is geo-blocked from this VM — never used as primary.)
 *
 * WS primary: wss://stream.binance.com:9443/ws/!ticker@arr
 * WS fallback: wss://data-stream.binance.vision/ws/!ticker@arr
 * If WS fails: REST polling every 5s, status DEGRADED.
 * If REST also fails: status UNAVAILABLE — never invent data.
 */
import WebSocket from 'ws';

export type BinanceStatus = 'LIVE' | 'DEGRADED' | 'UNAVAILABLE';

export interface Candle {
  time: number; // open time (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker24h {
  symbol: string;
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  quoteVolume24h: number;
}

export const OVERVIEW_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'TONUSDT',
  'PAXGUSDT',
] as const;

export const SIGNAL_SYMBOLS = ['BTCUSDT', 'SOLUSDT'] as const;

const REST_BASES = ['https://data-api.binance.vision', 'https://api.binance.us'];
const WS_URLS = [
  'wss://stream.binance.com:9443/ws/!ticker@arr',
  'wss://data-stream.binance.vision/ws/!ticker@arr',
];

const TICKER_TTL_MS = 5_000;
const KLINE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

type Listener = (tick: Ticker24h) => void;

interface CacheEntry<T> {
  data: T;
  ts: number;
}

class BinanceClient {
  restStatus: BinanceStatus = 'UNAVAILABLE';
  wsStatus: 'LIVE' | 'DOWN' = 'DOWN';
  lastRestBase = REST_BASES[0];
  lastRestOkAt: string | null = null;
  lastWsMsgAt: string | null = null;

  private tickerCache = new Map<string, CacheEntry<Ticker24h>>();
  private klineCache = new Map<string, CacheEntry<Candle[]>>();
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private wsUrlIdx = 0;
  private wsRetryMs = 2_000;
  private pollTimer: NodeJS.Timeout | null = null;
  private wsStarted = false;

  onTicker(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Overall feed status: LIVE when WS is up, DEGRADED on REST polling, UNAVAILABLE when REST is down. */
  status(): BinanceStatus {
    if (this.restStatus === 'UNAVAILABLE') return 'UNAVAILABLE';
    return this.wsStatus === 'LIVE' ? 'LIVE' : 'DEGRADED';
  }

  source(): string {
    return this.wsStatus === 'LIVE'
      ? `binance-ws (${WS_URLS[this.wsUrlIdx]})`
      : `binance-rest (${this.lastRestBase})`;
  }

  start(): void {
    if (this.wsStarted) return;
    this.wsStarted = true;
    this.connectWs();
    // REST polling keeps the ticker cache warm whenever WS is down.
    this.pollTimer = setInterval(() => {
      if (this.wsStatus !== 'LIVE') {
        void this.refreshTickers([...OVERVIEW_SYMBOLS]).catch(() => undefined);
      }
    }, 5_000);
    this.pollTimer.unref?.();
    // Warm the cache immediately.
    void this.refreshTickers([...OVERVIEW_SYMBOLS]).catch(() => undefined);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.ws?.close();
    this.ws = null;
  }

  // ---------------------------------------------------------------- REST ---

  private async fetchJson<T>(path: string): Promise<{ data: T; base: string }> {
    let lastErr: unknown = null;
    for (const base of REST_BASES) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}${path}`);
          const data = (await res.json()) as T;
          this.restStatus = 'LIVE';
          this.lastRestBase = base;
          this.lastRestOkAt = new Date().toISOString();
          return { data, base };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
      }
    }
    this.restStatus = 'UNAVAILABLE';
    throw lastErr instanceof Error ? lastErr : new Error('Binance REST unreachable');
  }

  async getTickers(symbols: string[]): Promise<Ticker24h[]> {
    const now = Date.now();
    const fresh: Ticker24h[] = [];
    const missing: string[] = [];
    for (const s of symbols) {
      const c = this.tickerCache.get(s);
      if (c && now - c.ts < TICKER_TTL_MS) fresh.push(c.data);
      else missing.push(s);
    }
    if (missing.length === 0) return symbols.map((s) => this.tickerCache.get(s)!.data);
    const refreshed = await this.refreshTickers(missing);
    const bySymbol = new Map(refreshed.map((t) => [t.symbol, t]));
    return symbols.map((s) => bySymbol.get(s) ?? this.tickerCache.get(s)?.data).filter(Boolean) as Ticker24h[];
  }

  async refreshTickers(symbols: string[]): Promise<Ticker24h[]> {
    const params = new URLSearchParams();
    params.set('symbols', JSON.stringify(symbols));
    const { data } = await this.fetchJson<Record<string, string | number>[]>(`/api/v3/ticker/24hr?${params}`);
    const out: Ticker24h[] = data.map((r) => {
      const t: Ticker24h = {
        symbol: String(r.symbol),
        price: Number(r.lastPrice),
        change24hPct: Number(r.priceChangePercent),
        high24h: Number(r.highPrice),
        low24h: Number(r.lowPrice),
        volume24h: Number(r.volume),
        quoteVolume24h: Number(r.quoteVolume),
      };
      this.tickerCache.set(t.symbol, { data: t, ts: Date.now() });
      return t;
    });
    // Notify /ws listeners too, so the local feed keeps broadcasting while
    // the Binance WS is down and REST polling is the fallback.
    for (const t of out) {
      for (const fn of this.listeners) {
        try {
          fn(t);
        } catch {
          /* listener errors must not kill the feed */
        }
      }
    }
    return out;
  }

  async getTicker(symbol: string): Promise<Ticker24h> {
    const [t] = await this.getTickers([symbol.toUpperCase()]);
    if (!t) throw new Error(`No ticker for ${symbol}`);
    return t;
  }

  async getKlines(symbol: string, interval: string, limit: number, endTime?: number): Promise<Candle[]> {
    const key = `${symbol}:${interval}:${limit}:${endTime ?? 'latest'}`;
    const cached = this.klineCache.get(key);
    if (cached && Date.now() - cached.ts < KLINE_TTL_MS) return cached.data;
    const params = new URLSearchParams({ symbol: symbol.toUpperCase(), interval, limit: String(limit) });
    if (endTime !== undefined) params.set('endTime', String(endTime));
    const { data } = await this.fetchJson<(string | number)[][]>(`/api/v3/klines?${params}`);
    const candles: Candle[] = data.map((k) => ({
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    this.klineCache.set(key, { data: candles, ts: Date.now() });
    return candles;
  }

  /** Closed 4h candles only (drops the still-forming candle). */
  async getClosedKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const all = await this.getKlines(symbol, interval, limit + 1);
    return all.slice(0, -1);
  }

  // ------------------------------------------------------------------ WS ---

  private connectWs(): void {
    const url = WS_URLS[this.wsUrlIdx];
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleWsReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.wsStatus = 'LIVE';
      this.wsRetryMs = 2_000;
    });

    ws.on('message', (raw) => {
      try {
        const arr = JSON.parse(raw.toString()) as Record<string, string>[];
        if (!Array.isArray(arr)) return;
        this.lastWsMsgAt = new Date().toISOString();
        for (const r of arr) {
          const symbol = String(r.s);
          if (!OVERVIEW_SYMBOLS.includes(symbol as (typeof OVERVIEW_SYMBOLS)[number])) continue;
          const t: Ticker24h = {
            symbol,
            price: Number(r.c),
            change24hPct: Number(r.P),
            high24h: Number(r.h),
            low24h: Number(r.l),
            volume24h: Number(r.v),
            quoteVolume24h: Number(r.q),
          };
          this.tickerCache.set(symbol, { data: t, ts: Date.now() });
          for (const fn of this.listeners) {
            try {
              fn(t);
            } catch {
              /* listener errors must not kill the feed */
            }
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on('close', () => {
      if (this.ws === ws) {
        this.wsStatus = 'DOWN';
        this.ws = null;
        this.scheduleWsReconnect();
      }
    });

    ws.on('error', () => {
      // 'close' follows; reconnect is scheduled there.
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    });
  }

  private scheduleWsReconnect(): void {
    // Try the other WS endpoint on the next attempt, then back off to 30s.
    this.wsUrlIdx = (this.wsUrlIdx + 1) % WS_URLS.length;
    const delay = this.wsRetryMs;
    this.wsRetryMs = Math.min(this.wsRetryMs * 2, 30_000);
    setTimeout(() => this.connectWs(), delay).unref?.();
  }
}

export const binance = new BinanceClient();
