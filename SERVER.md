# Server setup

Recipetor runs one Node service and uses a vendored Python extractor:

```
Browser -> Recipetor app (Node/SQLite) -> extractor/recipe_extract.py
          -> yt-dlp -> ffmpeg -> faster-whisper -> tesseract -> LLM
```

The Node app owns auth, the import queue, deduplication, favorites/history,
ratings, thumbnails, and storage. The Python pipeline downloads the post,
transcribes narration, OCRs on-screen text, asks an OpenAI-compatible LLM for a
strict recipe JSON, validates it, and writes a 480 px JPEG thumbnail.

The extractor runs as a child process of the app for each queued job. Its stderr
step lines are parsed live and surfaced in the queue UI.

## Requirements

- Node.js 22.18 or newer.
- Python 3.10+ with `python3-venv`.
- `ffmpeg`, `ffprobe`, `tesseract-ocr`, and `tesseract-ocr-por`.
- Network access to Instagram (or TikTok/YouTube if you extend the allowlist).
- An API key for an OpenAI-compatible LLM endpoint.

## 1. Set up the extractor

```sh
bash extractor/setup.sh
```

This installs the Python dependencies into `extractor/.venv` and creates the
thumbnail media directory when the app first runs. The first extraction also
downloads the faster-whisper model (about 500 MB for `small`, more for `medium`).

Run one extraction manually to warm the model and verify access:

```sh
extractor/.venv/bin/python extractor/recipe_extract.py \
  'https://www.instagram.com/reel/ABC123/' \
  --whisper-model medium --language auto --compute-nutrition \
  --thumbnail-dir data/media
```

stdout is recipe JSON; progress is printed to stderr as `[1/7] ...` steps.

## 2. Configure the app

```sh
npm ci
npm run build
cp .env.example .env
```

Add the extractor settings to the app's `.env`:

```sh
RECIPE_EXTRACTOR_PYTHON=./extractor/.venv/bin/python
RECIPE_EXTRACTOR_SCRIPT=./extractor/recipe_extract.py
RECIPE_EXTRACTOR_MODEL=beam-free
RECIPE_EXTRACTOR_BASE_URL=https://opencode.ai/zen/go/v1
RECIPE_EXTRACTOR_API_KEY=<your key>
RECIPE_EXTRACTOR_WHISPER_MODEL=medium
RECIPE_EXTRACTOR_LANGUAGE=auto
RECIPE_EXTRACTOR_OCR_LANGS=por+eng
RECIPE_EXTRACTOR_COMPUTE_NUTRITION=1
RECIPE_EXTRACTOR_TIMEOUT_MS=900000
RECIPETOR_MEDIA_DIR=./data/media
```

If `RECIPE_EXTRACTOR_API_KEY` is empty, the script falls back to
`OPENCODE_GO_API_KEY` or `~/.hermes/.env`.

Set `RECIPETOR_HOST=0.0.0.0` and `RECIPETOR_PORT=8787` only if a reverse proxy on
the home network needs to reach the app. Set `RECIPETOR_JWT_SECRET` to a long
random value so login sessions survive restarts. Configure `SMTP_*` so
verification and password reset codes can be delivered.

`RECIPETOR_ORIGIN` may be set to the exact public origin (for example
`https://recipes.example.com`) to further restrict browser import requests. The
app also limits imports to 10 per source connection per hour.

## 3. Run locally

```sh
npm run dev
```

The development command starts Vite and the app API. The extractor is spawned
per queued job, so no separate service is needed. The database is created at
`data/recipetor.sqlite`; thumbnails are written to `data/media`.

## 4. Deploy with systemd

Install the app, run `extractor/setup.sh` once, then start the app service:

```sh
sudo systemctl restart recipetor
```

The deploy script (`auto-pull.sh`) pulls the repo, rebuilds the app, and
restarts the Node server. `extractor/.venv/` and `data/` are gitignored, so they
survive the deploy's `git clean`.

## Changing the model

Model and pipeline options live in the app environment:

```sh
RECIPE_EXTRACTOR_MODEL=beam-free
RECIPE_EXTRACTOR_WHISPER_MODEL=medium
RECIPE_EXTRACTOR_LANGUAGE=auto
```

Restart the app after changing them. Check the active configuration:

```sh
curl -s http://127.0.0.1:8787/api/health
```

The health response reports `extractor.backend: "script"` and whether the
configured interpreter and script are present.

## Queue progress

Each queued job records its stage and a live `stageLabel` derived from the
extractor's stderr:

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
bars track fetching, extracting, and saving.

## Testing

```sh
# app
npm test
npm run build

# extractor
extractor/.venv/bin/python extractor/recipe_extract.py \
  'https://www.instagram.com/reel/ABC123/' --raw
```

## Security

- Keep the extractor API key in the app environment or `~/.hermes/.env`; it is
  never sent to the browser.
- Thumbnail URLs are unguessable hashes served from `/media/` and are intended
  to be public.
- Point the app's HTTPS reverse proxy at port 8787 only.
- Back up `data/recipetor.sqlite`, `data/media/`, and the app `.env`.
