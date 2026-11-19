# Deployment

## 1. Local run

Prerequisites: Node.js 20+, npm. No API keys, no accounts, no sign-in.

```bash
cp .env.example .env   # optional; defaults work out of the box
npm install --prefix server
npm install --prefix client
npm run dev            # server :3001, client :5173
```

Open http://localhost:5173. The Vite dev server proxies `/api` and
`/ws` to `localhost:3001`.

To run each package separately:

```bash
npm run dev:server   # cd server && npm run dev (tsx watch)
npm run dev:client   # cd client && npm run dev (Vite --port 5173)
```

## 2. Production build

The server serves the built frontend — a single process on one port:

```bash
npm run build   # builds server (tsc), then client (tsc + vite build)
npm start       # node server: API + client/dist on PORT (default 3001)
```

What `npm run build` does:

1. `npm --prefix server run build` → `tsc -p tsconfig.json` → `server/dist/`
2. `npm --prefix client run build` → `tsc -p tsconfig.json && vite build` → `client/dist/`

`npm start` runs `node server/dist/index.js` (via `npm --prefix server
start`). In production the Express server serves `client/dist` as
static files and falls back to `index.html` for client-side routes.

## 3. Docker

No `Dockerfile` is shipped yet — the image below is the reference
configuration for whoever adds one (it uses the `node:20` image and
contains **no secrets**: there are no API keys in this project).

Reference `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix server && npm ci --prefix client
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
# Persist the SQLite database outside the container:
VOLUME ["/app/server/data"]
CMD ["npm", "start"]
```

Reference `docker-compose.yml`:

```yaml
services:
  terminal:
    build: .
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - BINANCE_REST_BASE=https://data-api.binance.vision
      - BINANCE_WS_URL=wss://stream.binance.com:9443
      - DB_PATH=./server/data/terminal.db
      - PAPER_RISK_PER_TRADE=15
      - PAPER_DAILY_LOSS_LIMIT=25
    volumes:
      - terminal-data:/app/server/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  terminal-data:
```

Build and run:

```bash
docker compose up --build -d
curl http://localhost:3001/api/health
```

Notes:

- The SQLite database (`server/data/terminal.db`) must live on a
  persistent volume — otherwise paper trades, signals, settings and
  backtest reports are lost on every container recreate.
- Never bake a `.env` file into the image. Pass configuration via
  `environment:` (see §5). There are no secrets to inject.

## 4. VPS deployment notes

1. Provision a VPS with Node.js 20+ (or use the Docker setup above).
2. Clone the repo, `npm install --prefix server && npm install --prefix client`,
   `npm run build`.
3. Run the server as a service so it survives reboots and restarts on
   crash. Example systemd unit (`/etc/systemd/system/ctit.service`):

```ini
[Unit]
Description=Crypto Trading Intelligence Terminal
After=network.target

[Service]
Type=simple
User=ctit
WorkingDirectory=/opt/crypto-trading-intelligence-terminal
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
Environment=PORT=3001
Environment=NODE_ENV=production
Environment=BINANCE_REST_BASE=https://data-api.binance.vision
Environment=BINANCE_WS_URL=wss://stream.binance.com:9443
Environment=DB_PATH=/opt/crypto-trading-intelligence-terminal/server/data/terminal.db

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ctit
sudo systemctl status ctit
```

4. Back up `server/data/terminal.db` regularly — it is the only
   persistent state (paper trades, signals, settings, backtest reports).
   A nightly `cp` to a backup directory (or a volume snapshot) is enough.
5. Keep Node at 20+; the server uses modern Node APIs and TypeScript
   `~5.6`.

## 5. Reverse proxy (nginx)

Example — serves the terminal at `https://terminal.example.com`,
proxying HTTP and WebSocket to the Node server:

```nginx
server {
    listen 443 ssl;
    server_name terminal.example.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

The `Upgrade` / `Connection` headers are required for the `/ws`
WebSocket. `proxy_read_timeout` is set high so long-lived WS
connections are not cut. If TLS terminates at a load balancer instead,
make sure it also forwards WebSocket upgrades.

## 6. Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Server port. |
| `CLIENT_PORT` | `5173` | Vite dev-server port (dev only). |
| `BINANCE_REST_BASE` | `https://data-api.binance.vision` | Binance public REST endpoint. Fallback: `https://api.binance.us`. |
| `BINANCE_WS_URL` | `wss://stream.binance.com:9443` | Binance public WebSocket endpoint. |
| `DB_PATH` | `./server/data/terminal.db` | SQLite database file (created on first run; seed settings `dailyLossLimit=25, riskPerTrade=15`). |
| `PAPER_RISK_PER_TRADE` | `15` | Paper-trade risk per trade, USD. The validated value is 15; changing it means paper trading no longer tests the validated design. |
| `PAPER_DAILY_LOSS_LIMIT` | `25` | Paper daily loss limit, USD (configurable 20–30 via `POST /api/risk/config`). |

All variables are documented in `.env.example`. **No secrets, no API
keys** — none are needed, and none should ever be added: market data is
Binance public data only, and there is no execution path.

## 7. Health checks

- `GET /api/health` → `{ status, time, binance: { rest, ws }, uptimeSec }`.
  `status` is `"ok"` while the server is up even if Binance is down —
  check `binance.rest` / `binance.ws` for upstream health.
- Docker healthcheck: see §3 (polls `/api/health` every 30s).
- Uptime monitoring: alert on HTTP 5xx from `/api/health` or on
  `binance.rest === "UNAVAILABLE"` persisting for more than a few
  minutes (see §8).

## 8. Troubleshooting

### Binance geo-block — `api.binance.com` unreachable

`api.binance.com` is geo-blocked from some networks. This project uses
Binance's official public-data endpoint instead:

```
BINANCE_REST_BASE=https://data-api.binance.vision
```

If that also fails, the fallback is `https://api.binance.us`. The server
reports the active source in every response (`source` field) and in
`/api/health` — check which endpoint is actually serving before
assuming a code bug.

### WebSocket fails → status DEGRADED

If `wss://stream.binance.com:9443` cannot connect (firewall, proxy
dropping upgrades, TLS interception), the server falls back to REST
polling every 5s and reports status `DEGRADED`. The terminal keeps
working with slightly stale data, and the UI shows the degraded state.
Check: (a) outbound port 9443 is open; (b) the reverse proxy forwards
`Upgrade` headers (see §5); (c) no corporate proxy is stripping
WebSocket frames.

### REST also fails → status UNAVAILABLE

If both WS and REST fail, the server reports `UNAVAILABLE` and the UI
shows an UNAVAILABLE badge. **It never invents data to fill the gap.**
Check network egress to `data-api.binance.vision` first
(`curl https://data-api.binance.vision/api/v3/ping` should return `{}`),
then DNS, then whether the host's IP is rate-limited by Binance.

### Port already in use

- `EADDRINUSE :3001` — another server instance is running; stop it or
  set `PORT`.
- `EADDRINUSE :5173` — another Vite dev server is running; stop it or
  set `CLIENT_PORT` (and update the proxy target accordingly).

### Database locked / missing

- `server/data/` must exist and be writable by the server process. The
  database file is created on first run.
- SQLite "database is locked" usually means two server processes share
  one `DB_PATH` — run exactly one server per database file.

### Build failures

- `tsc` errors in `client/` or `server/`: run `npm ci` (or `npm
  install` if no lockfile exists yet) in that package first — a stale
  `node_modules` is the usual cause.
- Vite build OOM on a small VPS: set `NODE_OPTIONS=--max-old-space-size=2048`
  for the build step only.

### better-sqlite3 — no Node 24 prebuild / `fchown EPERM` on source build

`better-sqlite3` v11.10.0 ships **no prebuilt binary for Node 24**, so
`npm install` falls back to a source build with `node-gyp`. In
sandboxed environments that build can fail with `fchown EPERM`
(the build process cannot change ownership of files under the
node-gyp cache / build directory).

Workarounds (in order of preference):

1. **Pre-extract the Node headers with `--no-same-owner`, then rebuild:**
   ```bash
   # Download and extract the Node 24 headers into the node-gyp cache
   # without preserving the tarball's ownership:
   mkdir -p ~/.cache/node-gyp/24.x.x
   curl -fsSL https://nodejs.org/dist/v24.x.x/node-v24.x.x-headers.tar.gz \
     | tar -xz --no-same-owner -C ~/.cache/node-gyp/24.x.x --strip-components=1
   # Then rebuild better-sqlite3 against those headers:
   cd server
   npx node-gyp rebuild --nodedir="$HOME/.cache/node-gyp/24.x.x"
   ```
   Replace `24.x.x` with the exact Node version (`node --version`).
   The `--no-same-owner` extraction is what avoids the `fchown EPERM`
   failure; the `--nodedir` flag points `node-gyp` at the pre-extracted
   headers instead of downloading (and chown-ing) them itself.
2. **Use a newer better-sqlite3** that ships Node 24 prebuilds
   (check the release notes for your Node version) and re-run
   `npm install --prefix server`.
3. **Use Node 20** (the reference Docker image and CI use `node:20`),
   for which v11.10.0 does ship a prebuild — no source build needed.
