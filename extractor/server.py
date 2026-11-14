#!/usr/bin/env python3
"""FastAPI wrapper around ``recipe_extract``.

Endpoints
---------
GET  /healthz                 -> {"status": "ok", ...}
POST /extract                 -> recipe JSON (synchronous)
POST /jobs                    -> {"job_id": "..."} (queued, with live progress)
GET  /jobs/{job_id}           -> status, progress, recipe, error
GET  /thumbnails/{id}.jpg     -> cached 480px JPEG thumbnail

Run with::

    uvicorn server:app --host 127.0.0.1 --port 8099 --workers 1
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, HttpUrl
from starlette.concurrency import run_in_threadpool

import recipe_extract as rx

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

API_TOKEN = os.getenv("RECIPE_API_TOKEN", "").strip()
MEDIA_DIR = Path(os.getenv("RECIPE_MEDIA_DIR", "/var/lib/recipe-extractor/media"))
PUBLIC_BASE = os.getenv("RECIPE_PUBLIC_BASE_URL", "").strip().rstrip("/")

MODEL = os.getenv("RECIPE_MODEL", "beam-free")
BASE_URL = os.getenv("RECIPE_BASE_URL", "https://opencode.ai/zen/go/v1")
WHISPER_MODEL = os.getenv("RECIPE_WHISPER_MODEL", "small")
LANGUAGE = os.getenv("RECIPE_LANGUAGE", "pt")
OCR_LANGS = os.getenv("RECIPE_OCR_LANGS", "por+eng")
THUMB_WIDTH = int(os.getenv("RECIPE_THUMBNAIL_WIDTH", "480"))
VERBOSE = os.getenv("RECIPE_VERBOSE", "").lower() in {"1", "true", "yes", "on"}
COMPUTE_NUTRITION = os.getenv("RECIPE_COMPUTE_NUTRITION", "").lower() in {"1", "true", "yes", "on"}

MAX_CONCURRENT = max(1, int(os.getenv("RECIPE_MAX_CONCURRENT", "1")))
QUEUE_TIMEOUT = float(os.getenv("RECIPE_QUEUE_TIMEOUT", "30"))
JOB_TIMEOUT = float(os.getenv("RECIPE_JOB_TIMEOUT", "600"))

DEFAULT_HOSTS = {
    "instagram.com", "www.instagram.com", "m.instagram.com",
    "tiktok.com", "www.tiktok.com", "vm.tiktok.com",
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
}
_env_hosts = os.getenv("RECIPE_ALLOWED_HOSTS", "").strip()
ALLOWED_HOSTS = (
    DEFAULT_HOSTS
    if not _env_hosts
    else {h.strip().lower() for h in _env_hosts.split(",") if h.strip()}
)
ALLOW_ALL_HOSTS = "*" in ALLOWED_HOSTS

THUMB_ID_RE = re.compile(r"^[0-9a-f]{16,64}$")

_semaphore = asyncio.Semaphore(MAX_CONCURRENT)


def _host_allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    if ALLOW_ALL_HOSTS:
        return True
    return host in ALLOWED_HOSTS


# --------------------------------------------------------------------------- #
# Background jobs (used by the Recipetor app for live queue progress)
# --------------------------------------------------------------------------- #

SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_PATH = SCRIPT_DIR / "recipe_extract.py"
VENV_BIN = str(Path(sys.executable).parent)
STEP_RE = re.compile(r"^\[(\d+)/(\d+)\]\s+(.+)$")
THUMBNAIL_RE = re.compile(
    r"thumbnail:\s*(?:cache hit\s*→\s*|using [^→]+→\s*)?(.+?\.jpg)(?:\s+\([^)]*\))?\s*$",
    re.IGNORECASE,
)
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
JOB_SEMAPHORE = threading.Semaphore(MAX_CONCURRENT)


def _set_job(job_id: str, **updates: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updated_at"] = time.time()


def _stage_for(label: str) -> str:
    text = label.strip().lower()
    if text.startswith(("fetching", "downloading")):
        return "fetching"
    if text.startswith("validating"):
        return "saving"
    return "extracting"


def _progress_for(index: int, total: int) -> int:
    if total <= 0:
        return 5
    return max(5, min(95, round(index / total * 100)))


def _extract_command(url: str, compute_nutrition: bool) -> list[str]:
    cmd = [
        sys.executable,
        str(SCRIPT_PATH),
        url,
        "--model", MODEL,
        "--whisper-model", WHISPER_MODEL,
        "--language", LANGUAGE,
        "--ocr-langs", OCR_LANGS,
        "--thumbnail-dir", str(MEDIA_DIR),
        "--thumbnail-width", str(THUMB_WIDTH),
    ]
    if BASE_URL:
        cmd += ["--base-url", BASE_URL]
    if compute_nutrition:
        cmd.append("--compute-nutrition")
    if VERBOSE:
        cmd.append("--verbose")
    return cmd


def _run_job(job_id: str, url: str, compute_nutrition: bool) -> None:
    JOB_SEMAPHORE.acquire()
    try:
        _set_job(job_id, status="processing", stage="queued", progress=5, label="Starting recipe extraction")
        env = {
            **os.environ,
            "PATH": f"{VENV_BIN}:{os.environ.get('PATH', '')}",
        }
        proc = subprocess.Popen(
            _extract_command(url, compute_nutrition),
            cwd=str(SCRIPT_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )

        stderr_lines: list[str] = []
        thumbnail_path: str | None = None

        def read_stderr() -> None:
            nonlocal thumbnail_path
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_lines.append(line.rstrip("\n"))
                if len(stderr_lines) > 200:
                    del stderr_lines[:50]
                thumb = THUMBNAIL_RE.search(line)
                if thumb:
                    thumbnail_path = thumb.group(1).strip()
                step = STEP_RE.match(line.strip())
                if step:
                    label = step.group(3).strip()
                    _set_job(
                        job_id,
                        status="processing",
                        stage=_stage_for(label),
                        progress=_progress_for(int(step.group(1)), int(step.group(2))),
                        label=label,
                    )

        reader = threading.Thread(target=read_stderr, daemon=True)
        reader.start()

        timed_out = False
        try:
            proc.wait(timeout=JOB_TIMEOUT)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)
        reader.join(timeout=5)

        if timed_out:
            _set_job(
                job_id,
                status="error",
                stage="failed",
                progress=100,
                label=None,
                error="The recipe extractor timed out.",
                error_code="TIMEOUT",
            )
            return

        stdout = proc.stdout.read() if proc.stdout else ""
        payload: Any = None
        try:
            payload = json.loads(stdout.strip()) if stdout.strip() else None
        except json.JSONDecodeError:
            start = stdout.find("{")
            end = stdout.rfind("}")
            if start >= 0 and end > start:
                try:
                    payload = json.loads(stdout[start:end + 1])
                except json.JSONDecodeError:
                    payload = None

        if not isinstance(payload, dict):
            tail = stderr_lines[-1] if stderr_lines else "The recipe extractor returned an invalid response."
            _set_job(job_id, status="error", stage="failed", progress=100, label=None, error=tail, error_code="INVALID_RESPONSE")
            return

        if "error" in payload:
            _set_job(
                job_id,
                status="error",
                stage="failed",
                progress=100,
                label=None,
                error=str(payload.get("message") or "The recipe extractor failed.")[:500],
                error_code=str(payload.get("error") or "EXTRACTION_FAILED"),
            )
            return

        thumb_id = None
        if thumbnail_path and Path(thumbnail_path).is_file():
            thumb_id = Path(thumbnail_path).stem
        else:
            key = hashlib.sha256(f"{url}|{THUMB_WIDTH}".encode("utf-8")).hexdigest()[:32]
            expected = MEDIA_DIR / f"{key}.jpg"
            if expected.is_file():
                thumb_id = expected.stem

        _set_job(
            job_id,
            status="done",
            stage="completed",
            progress=100,
            label=None,
            recipe=payload,
            thumbnail_id=thumb_id,
        )
    except Exception as exc:  # noqa: BLE001
        _set_job(
            job_id,
            status="error",
            stage="failed",
            progress=100,
            label=None,
            error=str(exc)[:500],
            error_code="EXTRACTION_FAILED",
        )
    finally:
        JOB_SEMAPHORE.release()


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(_app: FastAPI):
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(
    title="Recipe Extractor",
    version="1.0.0",
    lifespan=lifespan,
)

_cors = [o.strip() for o in os.getenv("RECIPE_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
        expose_headers=["X-Thumbnail-URL", "X-Thumbnail-Id"],
    )


def require_token(x_api_token: str | None = Header(default=None, alias="X-API-Token")) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="RECIPE_API_TOKEN is not configured")
    if not x_api_token or not hmac.compare_digest(x_api_token, API_TOKEN):
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Token")


class JobRequest(BaseModel):
    url: HttpUrl
    compute_nutrition: bool | None = None


@app.post("/jobs", status_code=202)
async def create_job(body: JobRequest, _: None = Depends(require_token)) -> dict:
    url = str(body.url)
    host = (urlparse(url).hostname or "").lower()
    if not _host_allowed(host):
        raise HTTPException(status_code=400, detail=f"host not allowed: {host or '(none)'}")

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "label": "Waiting in queue",
            "recipe": None,
            "error": None,
            "error_code": None,
            "thumbnail_id": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
    compute_nutrition = COMPUTE_NUTRITION if body.compute_nutrition is None else body.compute_nutrition
    threading.Thread(target=_run_job, args=(job_id, url, compute_nutrition), daemon=True).start()
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, _: None = Depends(require_token)) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        snapshot = dict(job)
    return {
        "job_id": snapshot["id"],
        "status": snapshot["status"],
        "stage": snapshot["stage"],
        "progress": snapshot["progress"],
        "label": snapshot["label"],
        "recipe": snapshot["recipe"],
        "error": snapshot["error"],
        "error_code": snapshot["error_code"],
        "thumbnail_id": snapshot["thumbnail_id"],
    }


class ExtractRequest(BaseModel):
    url: HttpUrl
    compute_nutrition: bool | None = None


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "status": "ok",
        "model": MODEL,
        "whisper_model": WHISPER_MODEL,
        "token_configured": bool(API_TOKEN),
        "compute_nutrition_default": COMPUTE_NUTRITION,
        "media_dir": str(MEDIA_DIR),
    }


@app.post("/extract")
async def extract(
    body: ExtractRequest,
    request: Request,
    _: None = Depends(require_token),
):
    url = str(body.url)
    host = (urlparse(url).hostname or "").lower()
    if not _host_allowed(host):
        raise HTTPException(status_code=400, detail=f"host not allowed: {host or '(none)'}")

    compute_nutrition = (
        COMPUTE_NUTRITION if body.compute_nutrition is None else body.compute_nutrition
    )

    try:
        await asyncio.wait_for(_semaphore.acquire(), timeout=QUEUE_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=429, detail="server busy; retry later")

    try:
        result = await asyncio.wait_for(
            run_in_threadpool(
                rx.extract_recipe,
                url,
                model=MODEL,
                base_url=BASE_URL,
                whisper_model=WHISPER_MODEL,
                language=None if LANGUAGE.lower() in {"auto", ""} else LANGUAGE,
                ocr_langs=OCR_LANGS,
                thumbnail_dir=str(MEDIA_DIR),
                thumbnail_width=THUMB_WIDTH,
                compute_nutrition=compute_nutrition,
                verbose=VERBOSE,
            ),
            timeout=JOB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="extraction timed out")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)[:500]) from exc
    finally:
        _semaphore.release()

    response = JSONResponse(result.recipe)
    if result.thumbnail_path and result.thumbnail_path.is_file():
        thumb_id = result.thumbnail_path.stem
        base = PUBLIC_BASE or str(request.base_url).rstrip("/")
        response.headers["X-Thumbnail-URL"] = f"{base}/thumbnails/{thumb_id}.jpg"
        response.headers["X-Thumbnail-Id"] = thumb_id
    return response


@app.get("/thumbnails/{thumb_id}.jpg")
async def thumbnail(thumb_id: str) -> FileResponse:
    if not THUMB_ID_RE.fullmatch(thumb_id):
        raise HTTPException(status_code=404, detail="thumbnail not found")
    path = MEDIA_DIR / f"{thumb_id}.jpg"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="thumbnail not found")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=2592000, immutable"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.getenv("RECIPE_HOST", "127.0.0.1"),
        port=int(os.getenv("RECIPE_PORT", "8099")),
        workers=1,
    )
