# Recipe extractor

Vendored extraction pipeline used by the Recipetor server. It downloads a social
post, transcribes the audio, OCRs on-screen text, asks an OpenAI-compatible LLM
for a strict recipe JSON, validates it, and writes a 480 px thumbnail.

Setup:

```sh
./setup.sh
```

Manual run:

```sh
./extract-recipe '<post-url>' --compute-nutrition --thumbnail-dir ../data/media
```

The Node server drives this script as a child process and parses its stderr
progress lines (`[3/7] Transcribing audio ...`) to update the queue. Stdout is a
single JSON object: either a recipe or `{"error": "...", "message": "..."}`.

Environment variables used by the server when spawning the script:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECIPE_EXTRACTOR_PYTHON` | `extractor/.venv/bin/python` | Python interpreter |
| `RECIPE_EXTRACTOR_SCRIPT` | `extractor/recipe_extract.py` | Script path |
| `RECIPE_EXTRACTOR_MODEL` | `beam-free` | LLM model |
| `RECIPE_EXTRACTOR_BASE_URL` | `https://opencode.ai/zen/go/v1` | LLM base URL |
| `RECIPE_EXTRACTOR_API_KEY` | `RECIPE_API_KEY` / `OPENCODE_GO_API_KEY` / `~/.hermes/.env` | LLM key |
| `RECIPE_EXTRACTOR_WHISPER_MODEL` | `medium` | faster-whisper model |
| `RECIPE_EXTRACTOR_LANGUAGE` | `auto` | `auto` or a language code |
| `RECIPE_EXTRACTOR_OCR_LANGS` | `por+eng` | tesseract languages |
| `RECIPE_EXTRACTOR_COMPUTE_NUTRITION` | `1` | estimate calories/macros |
| `RECIPE_EXTRACTOR_TIMEOUT_MS` | `900000` | per-job timeout |

## HTTP job service

The optional FastAPI wrapper adds a job API with live progress:

```sh
RECIPE_API_TOKEN=<token> \
RECIPE_MEDIA_DIR=$HOME/recipe-extractor-media \
RECIPE_WHISPER_MODEL=medium \
RECIPE_LANGUAGE=auto \
RECIPE_COMPUTE_NUTRITION=1 \
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8099 --workers 1
```

Endpoints: `POST /jobs`, `GET /jobs/{id}`, `GET /thumbnails/{id}.jpg`,
`GET /healthz`, and the synchronous `POST /extract` compatibility route.

When the app host has less RAM than the extractor host, run this service on the
stronger machine and expose it to the app through a reverse SSH tunnel (see
`SERVER.md`).
