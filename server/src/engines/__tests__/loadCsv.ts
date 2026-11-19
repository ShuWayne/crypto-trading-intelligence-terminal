import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../../ta/indicators.js';

/** Stored 240-day 4h / 120-day 1h Binance klines from the Phase 1 backtests. */
export const BINANCE_DATA_DIR = join(process.cwd(), '..', '..', 'binance-system', 'data');

export function loadCsvCandles(symbol: string, interval: '4h' | '1h'): Candle[] {
  const text = readFileSync(join(BINANCE_DATA_DIR, `${symbol}_${interval}.csv`), 'utf8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = (name: string) => header.indexOf(name);
  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    candles.push({
      time: Date.parse(cols[idx('open_time')]),
      open: Number(cols[idx('open')]),
      high: Number(cols[idx('high')]),
      low: Number(cols[idx('low')]),
      close: Number(cols[idx('close')]),
      volume: Number(cols[idx('volume')]),
    });
  }
  return candles;
}
