# Voice Coach: one image that serves the web app and runs the analysis service.
#
#   docker build -t voicecoach .
#   docker run -p 8765:8765 -v voicecoach-data:/data voicecoach
#
# See docs/DEPLOY.md. Stage 1 builds the web app, stage 2 is the Python runtime
# (ffmpeg comes from imageio-ffmpeg, torch from the CPU wheel index).

# ---------------------------------------------------------------- stage 1: web app
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- stage 2: python runtime
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # where the service keeps its state; mount a volume at /data
    VOICE_JOBS_DIR=/data/jobs \
    VOICECOACH_SECRETS_DIR=/data/secrets \
    TORCH_HOME=/data/models/torch \
    HF_HOME=/data/models/huggingface \
    HF_HUB_DISABLE_XET=1 \
    VOICECOACH_WEB_DIST=/app/web/dist \
    DEMUCS_THREADS=4 \
    VOICECOACH_WHISPER_THREADS=4 \
    PORT=8765

# libgomp is needed by torch / ctranslate2 on CPU; curl only for the health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin voicecoach \
    && mkdir -p /app /data/jobs /data/secrets /data/models \
    && chown -R voicecoach:voicecoach /app /data

WORKDIR /app/server
COPY server/requirements.txt server/requirements-separation.txt server/requirements-words.txt ./
RUN pip install -r requirements.txt \
    && pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements-separation.txt -r requirements-words.txt

COPY --chown=voicecoach:voicecoach server/ /app/server/
COPY --from=web --chown=voicecoach:voicecoach /build/web/dist /app/web/dist

USER voicecoach
VOLUME ["/data"]
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# Model weights (Demucs ~80 MB, whisper 'small' ~480 MB) download into /data/models on first use;
# to bake them into the image instead, uncomment:
# RUN python -c "import torch; from demucs.pretrained import get_model; get_model('htdemucs')" \
#  && python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

CMD ["sh", "-c", "exec python -m uvicorn main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
