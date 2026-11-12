# Recipetor extraction bridge

A small, stateless HTTP service that turns a public Instagram link into a
validated recipe. Hermes is the only backend for now, but the HTTP contract and
the adapter interface keep the app independent of the model and provider.

```
Recipetor app  ->  bridge (127.0.0.1:8790)  ->  Hermes CLI  ->  model/provider
```

The app keeps its queue, auth, deduplication, and SQLite storage. The bridge
only extracts. It is not exposed publicly.

## Requirements

- Node.js 22.18 or newer (native TypeScript, no build step).
- Hermes installed and configured (`hermes setup`).

## Configure

```sh
cd bridge
npm install
cp .env.example .env
```

`BRIDGE_TOKEN` is required and must not be the example value. Generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address. Keep this on loopback. |
| `BRIDGE_PORT` | `8790` | HTTP port. |
| `BRIDGE_TOKEN` | — | Bearer token required by `POST /v1/extract`. |
| `BRIDGE_BACKEND` | `hermes` | Extraction backend. Only `hermes` is supported. |
| `BRIDGE_MODEL` | Hermes default | Passed to Hermes as `-m`. |
| `BRIDGE_PROVIDER` | Hermes default | Passed to Hermes as `--provider`. |
| `BRIDGE_TIMEOUT_MS` | `180000` | Timeout per attempt. |
| `BRIDGE_MAX_ATTEMPTS` | `2` | Retries for retryable model failures. |
| `BRIDGE_MAX_CONCURRENCY` | `1` | Simultaneous model calls. |
| `BRIDGE_RATE_LIMIT` | `30` | Global requests per window. `0` disables it. |
| `BRIDGE_RATE_WINDOW_MS` | `3600000` | Rate-limit window. |
| `HERMES_BIN` | `hermes` | Hermes executable. Use an absolute path for systemd. |
| `BRIDGE_VERBOSE` | `true` | Log extraction progress and heartbeats. |
| `BRIDGE_PROGRESS_INTERVAL_MS` | `15000` | How often to log that Hermes is still running. |

The app's `RECIPE_BRIDGE_TIMEOUT_MS` should be larger than
`BRIDGE_TIMEOUT_MS * BRIDGE_MAX_ATTEMPTS`, because the app waits for the bridge
to finish retrying.

## Run

```sh
# development, restarts on changes
npm run dev

# production-style
npm start
```

Health check:

```sh
curl -s http://127.0.0.1:8790/health
```

```json
{
  "status": "ok",
  "version": "0.1.0",
  "backend": "hermes",
  "model": "claude-sonnet-4",
  "provider": "anthropic",
  "hermesAvailable": true
}
```

`status` is `degraded` when the bridge is up but the Hermes executable cannot be
run.

## Extract a recipe

```sh
curl -s -X POST http://127.0.0.1:8790/v1/extract \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.instagram.com/reel/ABC123/"}'
```

```json
{
  "recipe": {
    "title": "Lemon Butter Pasta",
    "description": "A bright lemon pasta.",
    "category": "Dinner",
    "prepTimeMinutes": 25,
    "basePortions": 4,
    "ingredients": [
      {
        "amount": 200,
        "unit": "g",
        "name": "spaghetti",
        "nutrition": { "calories": 300, "protein": 10, "carbs": 60, "fat": 1 }
      }
    ],
    "instructions": ["Boil the pasta.", "Toss with lemon and butter."],
    "totals": { "calories": 500, "protein": 20, "carbs": 70, "fat": 10 }
  },
  "meta": {
    "backend": "hermes",
    "model": "claude-sonnet-4",
    "provider": "anthropic",
    "durationMs": 12345,
    "promptVersion": "2026-11-11",
    "attempts": 1
  }
}
```

Errors always use the same shape:

```json
{
  "error": {
    "code": "NO_RECIPE",
    "message": "No recipe found in this post.",
    "retryable": false
  }
}
```

| Code | HTTP | Retryable | Meaning |
| --- | --- | --- | --- |
| `INVALID_URL` | 400 | no | Not a public Instagram post/reel link. |
| `UNAUTHORIZED` | 401 | no | Missing or wrong bearer token. |
| `RATE_LIMITED` | 429 | no | Global bridge limit hit. |
| `BAD_REQUEST` | 400 | no | Malformed or oversized request body. |
| `NOT_FOUND` | 404 | no | Unknown route. |
| `METHOD_NOT_ALLOWED` | 405 | no | Wrong HTTP method. |
| `POST_INACCESSIBLE` | 422 | no | Private, deleted, or login-gated post. |
| `NO_RECIPE` | 422 | no | Post is accessible but has no recipe. |
| `MODEL_TIMEOUT` | 504 | no | Model exceeded `BRIDGE_TIMEOUT_MS`. |
| `MODEL_ERROR` | 502 | yes | Hermes or the provider failed. |
| `INVALID_MODEL_OUTPUT` | 502 | yes | Model returned unparseable or invalid JSON. |
| `INTERNAL` | 500 | no | Unexpected bridge failure. |

## Test without HTTP

The CLI uses the same adapter, prompt, validation, timeout, and retries:

```sh
npm run cli -- "https://www.instagram.com/reel/ABC123/"
```

It prints `{ "recipe": ..., "meta": ... }` or exits non-zero with the error code.

The CLI reads `bridge/.env` when present. If you have not created it, pass the
model and provider inline so it does not fall back to the Hermes defaults:

```sh
BRIDGE_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b BRIDGE_PROVIDER=nvidia \
  npm run cli -- "https://www.instagram.com/reel/ABC123/"
```

Progress messages go to stderr, so stdout stays valid JSON. Set
`BRIDGE_VERBOSE=false` to silence them.

## Change the model

Model choice lives entirely in the bridge:

```sh
# /etc/recipetor-bridge.env
BRIDGE_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
BRIDGE_PROVIDER=nvidia
```

Then restart the service:

```sh
sudo systemctl restart recipetor-bridge
curl -s http://127.0.0.1:8790/health
```

The health response includes the configured `model` and `provider`.

Leave both values empty to use the model/provider configured by `hermes model`.
The app does not need to be redeployed.

### Pick a model

Extraction is one short tool call followed by one JSON response. Some models
spend thousands of hidden reasoning tokens before writing that JSON, so a single
extraction can take several minutes. Check the model's behavior before deploying
it:

```sh
npm run cli -- "https://www.instagram.com/reel/ABC123/"
```

The `meta.durationMs` field shows the end-to-end time.

On the NVIDIA NIM free tier:

- `nvidia/nemotron-3.5-lightning-30b-a3b` (current) reasons heavily and usually
  takes 1–2 minutes per post, but can take longer. Give it a large
  `BRIDGE_TIMEOUT_MS` (for example `900000`) and keep a retry
  (`BRIDGE_MAX_ATTEMPTS=2`) because it occasionally returns an empty
  instruction list.
- `poolside/laguna-xs-2.1` finishes in about 10 seconds with no reasoning
  tokens, but often leaves per-ingredient nutrition empty.

With a slow model, `BRIDGE_VERBOSE=true` logs a heartbeat every
`BRIDGE_PROGRESS_INTERVAL_MS` so you can see that the call is still alive:

```text
[hermes] starting: url=... model=nvidia/nemotron-3.5-lightning-30b-a3b ... timeout=900s
[hermes] still running after 15.0s (no output yet)
[hermes] still running after 30.0s (no output yet)
[hermes] first output after 284.6s
[hermes] finished code=0 after 284.6s (stdout=2311 bytes, stderr=0 chars)
[hermes] parsed recipe "..." (13 ingredients, 8 steps)
```

If the chosen model is unavailable, the bridge returns `MODEL_ERROR`; point
`BRIDGE_MODEL`/`BRIDGE_PROVIDER` at another model and restart.

## Run the tests

```sh
npm test
npm run typecheck
```

The tests use fake Hermes executables and a fake adapter. They do not call a real
model or the network.

## Deploy with systemd

```sh
sudo useradd --system --home /opt/recipetor-bridge --shell /usr/sbin/nologin recipetor
sudo mkdir -p /opt/recipetor-bridge
sudo cp -r package.json package-lock.json src /opt/recipetor-bridge/
sudo cp .env.example /etc/recipetor-bridge.env
sudo chmod 600 /etc/recipetor-bridge.env
sudo chown -R recipetor:recipetor /opt/recipetor-bridge
sudo cp systemd/recipetor-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now recipetor-bridge
```

Edit `/etc/recipetor-bridge.env` first. Use an absolute `HERMES_BIN` if Hermes is
not on the service `PATH` (for example
`HERMES_BIN=/home/coxinha/.local/bin/hermes`).

The service user must be able to read the Hermes configuration and execute the
Hermes binary. Either run the service as the user that owns that configuration,
or grant the `recipetor` user access. If Hermes looks for its config under
`$HOME`, add `Environment=HOME=/home/<hermes-user>` to the unit.

Logs:

```sh
journalctl -u recipetor-bridge -f
```

The bridge runs with Node's native TypeScript support, so `ExecStart` points at
`src/server.ts` and there is no build step. Adjust `ExecStart` if Node is not at
`/usr/bin/node` (for example when using nvm).

## Security notes

- Bind to `127.0.0.1` and do not publish the port through the reverse proxy,
  Cloudflare tunnel, or firewall.
- Keep `BRIDGE_TOKEN` in `/etc/recipetor-bridge.env` with mode `0600`.
- The app sends the token; the browser never sees it.
- Provider credentials stay in Hermes' own configuration, not in the app.
- The bridge re-validates Instagram URLs, caps request size and model output,
  kills timed-out process groups, and never logs the token.
- The bridge rate limit is a global safety net. The app still enforces its
  per-connection import limit.
