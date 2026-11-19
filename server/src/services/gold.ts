/**
 * Gold service — PAXGUSDT as a gold proxy on Binance.
 * PAXG is a gold-backed token, NOT spot XAUUSD — every response says so.
 * Sessions are labelled from the UTC clock (DST varies); crypto never
 * shows as "closed". Support/resistance come from recent 4h swing levels.
 */
import { binance } from './binance.js';
import { computeIndicators } from '../ta/indicators.js';

export interface SessionInfo {
  open: string;
  close: string;
  active: boolean;
}

function sessionActive(nowUtcMinutes: number, openH: number, openM: number, closeH: number, closeM: number): boolean {
  const open = openH * 60 + openM;
  const close = closeH * 60 + closeM;
  return nowUtcMinutes >= open && nowUtcMinutes < close;
}

export async function getGold(): Promise<{
  updatedAt: string;
  source: string;
  symbol: string;
  label: string;
  price: number;
  change24hPct: number;
  sessions: { asian: SessionInfo; london: SessionInfo; newYork: SessionInfo };
  support: number | null;
  resistance: number | null;
  notes: string[];
}> {
  const ticker = await binance.getTicker('PAXGUSDT');
  const candles = await binance.getClosedKlines('PAXGUSDT', '4h', 100);
  const ind = computeIndicators(candles);
  const last = (values: number[]): number | null => {
    if (!values.length) return null;
    const v = values[values.length - 1];
    return Number.isFinite(v) ? v : null;
  };
  const support = last(ind.swingLow);
  const resistance = last(ind.swingHigh);

  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  return {
    updatedAt: new Date().toISOString(),
    source: binance.source(),
    symbol: 'PAXGUSDT',
    label: 'PAXG (gold proxy)',
    price: ticker.price,
    change24hPct: ticker.change24hPct,
    sessions: {
      asian: { open: '00:00 UTC', close: '08:00 UTC', active: sessionActive(mins, 0, 0, 8, 0) },
      london: { open: '08:00 UTC', close: '16:30 UTC', active: sessionActive(mins, 8, 0, 16, 30) },
      newYork: { open: '13:00 UTC', close: '21:00 UTC', active: sessionActive(mins, 13, 0, 21, 0) },
    },
    support,
    resistance,
    notes: [
      'PAXG is a gold-backed token traded on Binance — a proxy for gold, not spot XAUUSD.',
      'Session hours are indicative (UTC); daylight-saving changes shift local times.',
      'Support/resistance are 20-candle 4h swing levels on PAXGUSDT, not spot gold levels.',
      'Crypto markets never close; session labels describe traditional gold-market hours only.',
    ],
  };
}
