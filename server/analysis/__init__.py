"""Voice coach analysis pipeline.

Modules:
  audio_io  - ffmpeg based decoding / encoding
  melody    - frame-wise f0 extraction (librosa.pyin) with cleanup
  notes     - note segmentation and per-note features
  phrases   - breath points and practice phrases
  features  - key / tempo / range and the SongAnalysis assembly
  separate  - optional Demucs vocal separation
  lyrics    - lrclib.net lyrics and oEmbed identification clients
"""
