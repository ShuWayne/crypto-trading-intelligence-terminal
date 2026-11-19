/**
 * WebSocket server on /ws — live ticker broadcasts + new-signal events.
 * Clients receive {type:'ticker', symbol, price, change24hPct, ts} and
 * {type:'signal', ...signal}. No auth (local terminal, public data only).
 */
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { binance } from './services/binance.js';

export interface WsHub {
  broadcast: (msg: Record<string, unknown>) => void;
  clients: () => number;
}

export function attachWs(server: Server): WsHub {
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(msg: Record<string, unknown>): void {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  }

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'status',
        binance: { rest: binance.restStatus, ws: binance.wsStatus },
        ts: new Date().toISOString(),
      }),
    );
    ws.on('error', () => undefined);
  });

  // Live tickers from the Binance WS feed (or REST polling fallback).
  binance.onTicker((t) => {
    broadcast({
      type: 'ticker',
      symbol: t.symbol,
      price: t.price,
      change24hPct: t.change24hPct,
      ts: new Date().toISOString(),
    });
  });

  return {
    broadcast,
    clients: () => wss.clients.size,
  };
}
