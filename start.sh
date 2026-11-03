#!/usr/bin/env bash
# Voice Coach for Mac and Linux: sets everything up on first run, then starts the app.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-5173}"
VENV="server/.venv"
VPY="$VENV/bin/python"

if [ ! -x "$VPY" ]; then
  PY=""
  for v in python3.12 python3.13 python3.11 python3.10 python3; do
    if command -v "$v" >/dev/null 2>&1 && "$v" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)'; then PY="$v"; break; fi
  done
  if [ -z "$PY" ]; then echo "Python 3.10 to 3.13 is needed (3.12 recommended): https://www.python.org/downloads/"; exit 1; fi
  echo "Setting up Voice Coach for the first time..."
  "$PY" -m venv "$VENV"
fi

if ! cmp -s server/requirements.txt "$VENV/req-installed.txt"; then
  echo "Installing the analysis engine..."
  "$VPY" -m pip install --disable-pip-version-check -r server/requirements.txt
  cp server/requirements.txt "$VENV/req-installed.txt"
fi

if [ ! -f "$VENV/separation-installed.txt" ]; then
  echo "Installing vocal separation (first time only, several hundred MB)..."
  if [ "$(uname)" = "Darwin" ]; then
    "$VPY" -m pip install --disable-pip-version-check torch torchaudio
  else
    "$VPY" -m pip install --disable-pip-version-check torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
  "$VPY" -m pip install --disable-pip-version-check -r server/requirements-separation.txt
  echo ok > "$VENV/separation-installed.txt"
fi

command -v npm >/dev/null 2>&1 || { echo "Node.js is needed: https://nodejs.org"; exit 1; }
echo "Preparing the app..."
(cd web && npm install --no-audit --no-fund --loglevel=error && npm run build --silent)

echo
echo "Voice Coach is running at http://localhost:$PORT  (Ctrl+C to stop)"
VOICECOACH_OPEN_BROWSER="http://localhost:$PORT/" exec "$VPY" -m uvicorn main:app --app-dir server --host 127.0.0.1 --port "$PORT" --log-level warning
