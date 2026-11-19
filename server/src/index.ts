/**
 * Crypto Trading Intelligence Terminal — backend entry point.
 * Express + TypeScript (ESM). Public Binance data only, no keys, no live
 * trading, no orders. Paper trading only.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { binance } from './services/binance.js';
import { initDb } from './services/db.js';
import { getSignals } from './services/signals.js';
import router from './routes.js';
import { attachWs } from './ws.js';

const PORT = Number(process.env.PORT ?? 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const db = await initDb();
  console.log(`[server] persistence backend: ${db.backend}`);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  // Light per-IP rate limit: 300 requests / minute.
  const hits = new Map<string, { count: number; resetAt: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > 300) {
      res.status(429).json({ error: 'Rate limit exceeded (300 req/min). Retry shortly.' });
      return;
    }
    next();
  });

  app.use('/api', router);

  // Production: serve the built frontend if present.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
    console.log('[server] serving client/dist');
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[server] error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  });

  const server = http.createServer(app);
  const hub = attachWs(server);

  binance.start();

  // Broadcast genuinely new signals over WS (diffed by id, every 60s).
  const seenSignals = new Set<string>();
  const signalTimer = setInterval(() => {
    void getSignals()
      .then((out) => {
        for (const s of out.signals) {
          if (!seenSignals.has(s.id)) {
            seenSignals.add(s.id);
            hub.broadcast({ type: 'signal', ...s });
          }
        }
      })
      .catch(() => undefined);
  }, 60_000);
  signalTimer.unref?.();

  server.listen(PORT, () => {
    console.log(`[server] CTIT backend listening on http://localhost:${PORT}`);
    console.log(`[server] binance rest=${binance.restStatus} ws=${binance.wsStatus}`);
  });

  const shutdown = (): void => {
    clearInterval(signalTimer);
    binance.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
