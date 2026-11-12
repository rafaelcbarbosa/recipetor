# Server setup

Recipetor has two local services:

```
Browser -> Recipetor app (Node/SQLite) -> extraction bridge -> Hermes -> model/provider
```

The app owns auth, the import queue, deduplication, favorites/history, and
storage. The bridge owns the prompt, model/provider choice, retries, timeouts,
and Instagram extraction. The bridge is stateless and is never exposed publicly.

## Requirements

- Node.js 22.18 or newer (the bridge uses native TypeScript).
- Hermes Agent installed and configured with `hermes setup`.
- A Hermes web-search/extraction provider that can access public Instagram posts.

## 1. Run the bridge

```sh
cd bridge
npm install
cp .env.example .env
```

Set at least:

```sh
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8790
BRIDGE_TOKEN=<long random value>
HERMES_BIN=/home/coxinha/.local/bin/hermes
```

Set the model explicitly:

```sh
BRIDGE_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
BRIDGE_PROVIDER=nvidia
BRIDGE_TIMEOUT_MS=900000
BRIDGE_MAX_ATTEMPTS=2
BRIDGE_VERBOSE=true
```

This model reasons heavily and can take several minutes per post, so it needs a
large timeout. Retries are useful because it occasionally returns an empty
instruction list. For a much faster extraction, use `poolside/laguna-xs-2.1`
instead. Leaving `BRIDGE_MODEL`/`BRIDGE_PROVIDER` empty uses the model/provider
configured by `hermes model`.

Start it:

```sh
npm start
curl -s http://127.0.0.1:8790/health
```

See [`bridge/README.md`](bridge/README.md) for all bridge options, the HTTP
contract, error codes, and systemd installation.

## 2. Configure the app

```sh
npm ci
npm run build
cp .env.example .env
```

Add the bridge settings to the app's `.env`:

```sh
RECIPE_EXTRACTOR=bridge
RECIPE_BRIDGE_URL=http://127.0.0.1:8790
RECIPE_BRIDGE_TOKEN=<same token as the bridge>
RECIPE_BRIDGE_TIMEOUT_MS=1860000
```

`RECIPE_BRIDGE_TIMEOUT_MS` should exceed
`BRIDGE_TIMEOUT_MS * BRIDGE_MAX_ATTEMPTS`, because the app waits for the bridge
to finish retrying.

Set `RECIPETOR_HOST=0.0.0.0` and `RECIPETOR_PORT=8787` only if a reverse proxy on
the home network needs to reach the app. Set `RECIPETOR_JWT_SECRET` to a long
random value so login sessions survive restarts. Configure `SMTP_*` so
verification and password reset codes can be delivered.

`RECIPETOR_ORIGIN` may be set to the exact public origin (for example
`https://recipes.example.com`) to further restrict browser import requests. The
app also limits imports to 10 per source connection per hour.

## 3. Run both locally

Terminal 1:

```sh
cd bridge
npm run dev
```

Terminal 2:

```sh
npm run dev
```

The development command starts Vite and the app API. The database is created at
`data/recipetor.sqlite`.

## 4. Deploy with systemd

Install the bridge first, then the app.

Bridge:

```sh
sudo cp bridge/systemd/recipetor-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now recipetor-bridge
journalctl -u recipetor-bridge -f
```

App:

```sh
sudo systemctl restart recipetor
```

The bridge unit expects `/opt/recipetor-bridge` and
`/etc/recipetor-bridge.env`. Restart the app service (or process) so it picks
up `RECIPE_BRIDGE_URL` and `RECIPE_BRIDGE_TOKEN` from its environment.

## Changing the model

Model choice lives in the bridge, not the app:

```sh
# /etc/recipetor-bridge.env
BRIDGE_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
BRIDGE_PROVIDER=nvidia
BRIDGE_TIMEOUT_MS=900000
BRIDGE_MAX_ATTEMPTS=2
BRIDGE_VERBOSE=true
```

```sh
sudo systemctl restart recipetor-bridge
curl -s http://127.0.0.1:8790/health
```

The app does not need to be rebuilt or restarted. The health response shows the
active model and provider.

Check the model before deploying it with the bridge CLI:

```sh
cd bridge
npm run cli -- "https://www.instagram.com/reel/ABC123/"
```

`meta.durationMs` shows the end-to-end time. The NVIDIA NIM
`nvidia/nemotron-3.5-lightning-30b-a3b` model reasons for thousands of tokens
and can take 5–10 minutes. `poolside/laguna-xs-2.1` completes real extractions
in about 10 seconds but often omits per-ingredient nutrition.

While a slow call runs, `BRIDGE_VERBOSE=true` logs a heartbeat to the journal:

```sh
sudo journalctl -u recipetor-bridge -f
```

```text
[extract] https://... accepted (active=0, queued=0, timeout=900s, attempts=1)
[hermes] starting: url=https://... model=nvidia/nemotron-3.5-lightning-30b-a3b ... timeout=900s
[hermes] still running after 15.0s (no output yet)
[hermes] first output after 284.6s
[hermes] finished code=0 after 284.6s (stdout=2311 bytes, stderr=0 chars)
[extract] https://... ok backend=hermes model=... attempts=1 duration=284700ms
```

## Testing

```sh
# app
npm test
npm run build

# bridge
cd bridge
npm test
npm run typecheck
```

Extract without the app or HTTP server:

```sh
cd bridge
npm run cli -- "https://www.instagram.com/reel/ABC123/"
```

Extract through the bridge:

```sh
curl -s -X POST http://127.0.0.1:8790/v1/extract \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.instagram.com/reel/ABC123/"}'
```

## Rollback

The old in-process Hermes path is still available temporarily:

```sh
# app .env
RECIPE_EXTRACTOR=hermes
HERMES_BIN=/home/coxinha/.local/bin/hermes
HERMES_TIMEOUT_MS=120000
```

Restart the app. Once the bridge has been stable, `server/hermes.js` and the
`RECIPE_EXTRACTOR=hermes` path can be removed.

## Security

- Bind the bridge to `127.0.0.1` and do not publish port 8790 through the
  reverse proxy, Cloudflare tunnel, or firewall.
- Keep the bridge token in `/etc/recipetor-bridge.env` with mode `0600`, and in
  the app environment with the same value.
- The browser never receives the bridge token or Hermes credentials.
- Keep Hermes/provider credentials in Hermes' own configuration.
- Point the app's HTTPS reverse proxy at port 8787 only.
- Back up `data/recipetor.sqlite` and `/etc/recipetor-bridge.env`.
