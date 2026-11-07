# Deploying Voice Coach

Voice Coach is one program: the Python analysis service serves the built web app and its API on
one port (8765 in the container). This page covers running it with Docker on your own machine or
a server, putting HTTPS in front of it, and what hardware it needs.

## 1. Why HTTPS matters

Browsers only allow microphone access (`getUserMedia`) on **secure origins**: `https://…`, or
`http://localhost`. If you open the app over plain `http://` from any other address (for example
`http://192.168.1.20:8765` from a phone on the same Wi-Fi, or a VPS by IP), the microphone button
will fail and nothing can be recorded. So:

* on the same machine, `http://localhost:8765` is fine;
* for any other device or a public server you need a TLS certificate. The easiest way is a reverse
  proxy that gets one automatically (Caddy below).

Everything a user records stays in their browser (IndexedDB). The server only sees the song file
that is uploaded for analysis, keeps it for the lifetime of the job (at most 2 hours) and, when the
AI coach is used, the coach messages and the compact practice summary sent with them.

## 2. Run it with Docker

```bash
git clone https://github.com/jdch-s/voice-app && cd voice-app
docker compose up -d --build        # first build takes 5-10 minutes (torch CPU wheels ~200 MB)
docker compose logs -f voicecoach    # wait for "Uvicorn running"
```

Open http://localhost:8765. The first vocal isolation downloads the Demucs weights (~80 MB) and
the first word-timing run downloads the whisper `small` model (~480 MB); both land in the `models`
volume and are reused.

What the compose file sets up:

| | |
|---|---|
| image | multi-stage `Dockerfile`: Node 22 builds `web/`, Python 3.12 runs the service as the non-root user `voicecoach` (uid 1000). ffmpeg comes from the `imageio-ffmpeg` wheel, torch from the CPU index, Demucs and faster-whisper from `requirements-separation.txt` / `requirements-words.txt`. |
| port | `8765` |
| volumes | `jobs` (`/data/jobs`: uploads and stems while a job is alive), `secrets` (`/data/secrets`: the Anthropic key saved from Settings, mode 600), `models` (`/data/models`: Demucs and whisper weights) |
| health | `GET /health` every 30 s |

Environment variables you may want to change (in `docker-compose.yml` or a `.env` file next to it):

| variable | default | meaning |
|---|---|---|
| `VOICECOACH_ORIGINS` | `*` | comma-separated browser origins allowed by CORS. Keep `*` when this container also serves the web app (same origin); set `https://sing.example.com` when the app is hosted elsewhere. `localhost` origins are always allowed. |
| `ANTHROPIC_API_KEY` | empty | key for the AI coach. Alternatively users save a key from the app's Settings page; it is stored in the `secrets` volume. Without either, the coach says so and the rest of the app works normally. |
| `VOICECOACH_COACH_MODEL` | `claude-sonnet-5-5` | the model used by the coach |
| `VOICECOACH_WHISPER_MODEL` | `small` | speech model for word timing: `tiny` / `base` (faster, less accurate), `small` (default), `medium` (slower, better). |
| `VOICECOACH_WHISPER_THREADS`, `DEMUCS_THREADS` | 4 | CPU threads for recognition / separation |
| `VOICE_MAX_UPLOAD_MB` | 200 | upload size limit |
| `VOICECOACH_SECRETS_DIR`, `VOICE_JOBS_DIR` | `/data/secrets`, `/data/jobs` | where the key file and job files live (volumes) |

To run without separation or without word timing, remove the matching `pip install` from the
`Dockerfile`; the service detects what is installed and `/health` reports it.

## 3. A VPS with Caddy for TLS

A single small VPS can serve one household. You need a domain name pointing at the server
(an `A` record, e.g. `sing.example.com`), ports 80 and 443 open, and Docker installed.

Add Caddy to the compose file and stop publishing 8765 directly:

```yaml
services:
  voicecoach:
    build: .
    restart: unless-stopped
    expose: ["8765"]            # reachable by caddy only, not published
    environment:
      VOICECOACH_ORIGINS: "https://sing.example.com"
    volumes: [jobs:/data/jobs, secrets:/data/secrets, models:/data/models]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes: {jobs: {}, secrets: {}, models: {}, caddy_data: {}, caddy_config: {}}
```

`Caddyfile`:

```
sing.example.com {
    encode zstd gzip
    request_body {
        max_size 220MB
    }
    reverse_proxy voicecoach:8765 {
        transport http {
            read_timeout 10m
        }
    }
}
```

`docker compose up -d` and Caddy obtains and renews a Let's Encrypt certificate on its own; open
https://sing.example.com. The read timeout matters because analysis requests are long polls only
on the client side, but stem downloads of long songs can take a while on slow links.

If you prefer nginx, the equivalent is `proxy_pass http://127.0.0.1:8765;` with
`client_max_body_size 220m;` and a certificate from certbot.

Keep the service private if it is for you and your family: Voice Coach has no accounts. Anyone who
can reach the URL can upload songs for analysis and, if a coach key is saved, spend your Anthropic
credit. Put HTTP basic auth in Caddy (`basicauth`), a VPN, or an allow-list in front of it.

## 4. CPU, RAM and disk

Measured on a 4-core x86 machine without a GPU:

| task | time | memory |
|---|---|---|
| quick analysis (pYIN on the full mix), 4-minute song | 30-60 s | < 1 GB |
| vocal separation (Demucs `htdemucs`), 4-minute song | 3-6 min (the very first job adds ~3 min of model loading) | 4-6 GB peak |
| word timing (faster-whisper `small`, int8), 4-minute song | 40-90 s | ~1.5 GB |
| AI coach request | 3-15 s (network) | negligible |

Recommendations:

* **Minimum**: 2 vCPU, 4 GB RAM, 5 GB disk, no separation (fallback mode works in the browser).
* **Comfortable for one household**: 4 vCPU, 8 GB RAM, 10 GB disk. The compose file caps memory at
  8 GB; separation jobs run one at a time so the CPU is never oversubscribed.
* Disk: the image is about 3 GB (torch), models add 0.6 GB, jobs are deleted after 2 hours.

## 5. Many users need a GPU box

Separation is the only heavy step, and it is strictly serialised (one song at a time, several
minutes each on CPU). Ten people importing songs at once would wait an hour. For a hosted service
with more than a handful of users:

* run the service on a machine with a GPU (an NVIDIA T4/L4 class card separates a 4-minute song in
  10-20 s; Demucs picks CUDA up automatically, `/health` shows `"device": "cuda"`). Build the image
  with CUDA torch wheels instead of the CPU index and start the container with `--gpus all`;
* or split the architecture: keep the web app and the quick analysis on a small web box and send
  separation jobs to a GPU worker behind a queue. `POST /analyze` / `GET /jobs/{id}` are already
  asynchronous, so the client side does not change;
* give each user a job limit, and remember that the stems are copyrighted material: the service
  only ever processes files the user uploads and deletes them after the job.

User accounts, payments, a licensed catalogue and a privacy policy are product decisions outside
this repository; the export/import feature in the app prepares data portability for them.

## 6. Without Docker

The repository's `start.sh` / `Start Voice Coach.bat` do the same thing on a laptop (venv + npm
build + uvicorn on port 5173). On a server use the same commands under a systemd unit and put
Caddy in front exactly as above, with `reverse_proxy 127.0.0.1:5173`.

## 7. Checking a deployment

```bash
curl -s https://sing.example.com/health
# {"ok":true,"separation":"demucs","device":"cpu","version":"0.2.0","whisper":true,"whisperModel":"small","coach":true}
curl -s https://sing.example.com/coach/status
# {"available":false,"model":"claude-sonnet-5-5","keySource":"none","message":"The coach needs an Anthropic API key: ..."}
cd server && .venv/bin/python tests/test_pipeline.py      # full pipeline + HTTP smoke test against a local server
```
