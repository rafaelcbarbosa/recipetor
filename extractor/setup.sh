#!/usr/bin/env bash
# One-time setup for the vendored recipe extractor.
# Installs the system tools it needs and creates extractor/.venv.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

missing=()
for bin in ffmpeg ffprobe tesseract; do
  command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing system tools: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    echo "Installing with apt..."
    if [ "$(id -u)" -eq 0 ]; then
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg tesseract-ocr tesseract-ocr-por
    else
      sudo apt-get update -qq
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg tesseract-ocr tesseract-ocr-por
    fi
  else
    echo "Install them manually: ffmpeg and tesseract-ocr (+ Portuguese pack)." >&2
    exit 1
  fi
fi

if [ ! -d "$DIR/.venv" ]; then
  echo "Creating Python virtualenv..."
  python3 -m venv "$DIR/.venv"
fi

echo "Installing Python dependencies..."
"$DIR/.venv/bin/pip" install --quiet --upgrade pip
"$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt"
if [ -f "$DIR/requirements-server.txt" ]; then
  "$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements-server.txt"
fi

echo
echo "Done."
echo "  Test: $DIR/extract-recipe <url> --compute-nutrition"
