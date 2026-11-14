# Server setup

Recipetor runs a Node app and uses a vendored Python extractor:

```
Browser -> Recipetor app (Node/SQLite) -> extractor/recipe_extract.py
          -> yt-dlp -> ffmpeg -> faster-whisper -> tesseract -> LLM
```

The Node app owns auth, the import queue, deduplication, favorites/history,
ratings, thumbnails, and storage. The Python pipeline downloads the post,
transcribes narration, OCRs on-screen text, asks an OpenAI-compatible LLM for a
strict recipe JSON, validates it, and writes a 480 px JPEG thumbnail.

The extractor can run in two modes:

1. **Local script** — the app spawns `extractor/recipe_extract.py` for each
   queued job. This gives live progress directly from stderr, but needs enough
   RAM/CPU for whisper (a 2 GB board cannot run `medium`).
2. **Remote job service** — the extractor service runs on a stronger machine and
   exposes a small HTTP job API. The app polls it for progress and stores the
   downloaded thumbnail. This is the recommended mode for low-RAM app hosts and
   is what the `renegade` deployment uses via a reverse SSH tunnel.

## Requirements

- Node.js 22.18 or newer.
- Python 3.10+ with `python3-venv`.
- `ffmpeg`, `ffprobe`, `tesseract-ocr`, and `tesseract-ocr-por` (extractor host).
- Network access to Instagram (or TikTok/YouTube if you extend the allowlist).
- An API key for an OpenAI-compatible LLM endpoint.
- Enough RAM for the chosen whisper model. `medium` needs ~2 GB; a 2 GB host
  should use the remote mode or a smaller model.

## 1. Set up the extractor

```sh
bash extractor/setup.sh
```

This installs the Python dependencies into `extractor/.venv`, including the
optional FastAPI/uvicorn job server. The first extraction also downloads the
faster-whisper model (about 500 MB for `small`, more for `medium`).

Run one extraction manually to warm the model and verify access:

```sh
extractor/extract-recipe 'https://www.instagram.com/reel/ABC123/' \
  --whisper-model medium --language auto --compute-nutrition \
  --thumbnail-dir data/media
```

stdout is recipe JSON; progress is printed to stderr as `[1/7] ...` steps.

## 2. Remote extractor service (recommended for low-RAM hosts)

On the extractor host (for example the home server at `192.168.1.190`):

```sh
cd extractor
RECIPE_API_TOKEN=<long random value> \
RECIPE_MEDIA_DIR=$HOME/recipe-extractor-media \
RECIPE_MODEL=beam-free \
RECIPE_BASE_URL=https://opencode.ai/zen/go/v1 \
RECIPE_API_KEY=<opencode-go key> \
RECIPE_WHISPER_MODEL=medium \
RECIPE_LANGUAGE=auto \
RECIPE_COMPUTE_NUTRITION=1 \
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8099 --workers 1
```

Endpoints:

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | no | liveness + config |
| `POST` | `/jobs` | `X-API-Token` | queue an extraction, returns `{job_id}` |
| `GET` | `/jobs/{id}` | `X-API-Token` | status, `stage`, `progress`, `label`, recipe |
| `GET` | `/thumbnails/{id}.jpg` | no | cached 480 px JPEG |
| `POST` | `/extract` | `X-API-Token` | synchronous compatibility endpoint |

The current deployment lets the app host reach the extractor directly on the
LAN. Restrict the port to the app host at the firewall:

```sh
sudo ufw allow from <app-host-ip> to any port 8099 proto tcp
```

If the app host cannot reach the extractor host directly (for example, a Wi-Fi
client-isolation network), open a reverse tunnel from the extractor host to the
app host:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -R 127.0.0.1:8099:127.0.0.1:8099 coxinha@<app-host>
```

Run both the service and the tunnel under systemd (or `autossh`) so they survive
reboots. The forwarded port is bound to the app host's loopback only.

## 3. Configure the app

```sh
npm ci
npm run build
cp .env.example .env
```

### Remote mode (app host)

```sh
# Direct LAN connection:
RECIPE_EXTRACTOR_URL=http://192.168.1.190:8099
# Or through the reverse tunnel:
# RECIPE_EXTRACTOR_URL=http://127.0.0.1:8099
RECIPE_EXTRACTOR_TOKEN=<same value as RECIPE_API_TOKEN>
RECIPE_EXTRACTOR_COMPUTE_NUTRITION=1
RECIPE_EXTRACTOR_TIMEOUT_MS=900000
RECIPETOR_MEDIA_DIR=./data/media
```

### Local mode (extractor on the same host)

```sh
RECIPE_EXTRACTOR_PYTHON=./extractor/.venv/bin/python
RECIPE_EXTRACTOR_SCRIPT=./extractor/recipe_extract.py
RECIPE_EXTRACTOR_MODEL=beam-free
RECIPE_EXTRACTOR_BASE_URL=https://opencode.ai/zen/go/v1
RECIPE_EXTRACTOR_API_KEY=<your key>
RECIPE_EXTRACTOR_WHISPER_MODEL=small
RECIPE_EXTRACTOR_LANGUAGE=auto
RECIPE_EXTRACTOR_OCR_LANGS=por+eng
RECIPE_EXTRACTOR_COMPUTE_NUTRITION=1
RECIPE_EXTRACTOR_TIMEOUT_MS=900000
RECIPETOR_MEDIA_DIR=./data/media
```

When `RECIPE_EXTRACTOR_URL` is set it takes precedence over the local script.
The health endpoint reports `extractor.backend` as `http` or `script`.

Set `RECIPETOR_HOST=0.0.0.0` and `RECIPETOR_PORT=8787` only if a reverse proxy on
the home network needs to reach the app. Set `RECIPETOR_JWT_SECRET` to a long
random value so login sessions survive restarts. Configure `SMTP_*` so
verification and password reset codes can be delivered.

`RECIPETOR_ORIGIN` may be set to the exact public origin (for example
`https://recipes.example.com`) to further restrict browser import requests. The
app also limits imports to 10 per source connection per hour.

## 4. Run locally

```sh
npm run dev
```

The development command starts Vite and the app API. In local mode the extractor
is spawned per queued job; in remote mode the app polls the extractor service.
The database is created at `data/recipetor.sqlite`; thumbnails are written to
`data/media`.

## 5. Deploy

On the app host, install the app, configure `.env`, then restart the service:

```sh
sudo systemctl restart recipetor
```

The deploy script (`auto-pull.sh`) pulls the repo, rebuilds the app, and
restarts the Node service. `extractor/.venv/` and `data/` are gitignored, so
they survive the deploy's `git clean`.

On the extractor host, keep the extractor service and the reverse tunnel running
under systemd. The extractor's `extractor/.venv` and media directory are also
local to that host.

## Queue progress

Each queued job records its stage and a live `stageLabel` from the extractor:

```text
[1/7] Fetching post metadata (yt-dlp)
[2/7] Downloading media (yt-dlp)
[3/7] Transcribing audio (faster-whisper: medium)
[4/7] Reading on-screen text (tesseract: por+eng)
[5/7] Generating thumbnail (480px JPEG)
[6/7] Extracting recipe (LLM: beam-free)
[7/7] Validating recipe JSON
```

The queue UI shows the current step name and percentage while the four stage
bars track fetching, extracting, and saving. The remote job API exposes the same
`stage`, `progress`, and `label` fields.

## Testing

```sh
# app
npm test
npm run build

# extractor
extractor/extract-recipe 'https://www.instagram.com/reel/ABC123/' --raw
```

## Security

- Keep the extractor API key in the app environment or `~/.hermes/.env`; it is
  never sent to the browser.
- Keep `RECIPE_API_TOKEN` in the extractor service environment and use the same
  value in the app's `RECIPE_EXTRACTOR_TOKEN`.
- Bind the extractor service to loopback and expose it only through the reverse
  tunnel. Do not publish port 8099 through the firewall.
- Thumbnail URLs are unguessable hashes served from `/media/` and are intended
  to be public.
- Point the app's HTTPS reverse proxy at port 8787 only.
- Back up `data/recipetor.sqlite`, `data/media/`, and the app `.env`.
