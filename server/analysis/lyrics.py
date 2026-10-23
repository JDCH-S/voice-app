"""Lyrics (lrclib.net) and song identification (YouTube / Spotify oEmbed).

Only metadata is ever fetched: no audio is downloaded, no API keys are used.
All network failures surface as LookupError with a readable message.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse

import httpx

USER_AGENT = "VoiceCoach/0.1 (https://github.com/jdch-s/voice-app)"
TIMEOUT = 10.0
LRCLIB_GET = "https://lrclib.net/api/get"
LRCLIB_SEARCH = "https://lrclib.net/api/search"
YT_OEMBED = "https://www.youtube.com/oembed"
SP_OEMBED = "https://open.spotify.com/oembed"


class LookupError(RuntimeError):
    """Remote lookup failed (network, proxy, upstream error)."""


def _client() -> httpx.Client:
    # trust_env=True picks up HTTPS_PROXY and the CA bundle variables.
    return httpx.Client(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True, trust_env=True)


def _get_json(client: httpx.Client, url: str, params: Dict[str, Any]) -> Optional[Any]:
    """GET json; None for 404, LookupError for other failures."""
    try:
        r = client.get(url, params=params)
    except httpx.HTTPError as e:
        raise LookupError(f"request to {urlparse(url).netloc} failed: {e.__class__.__name__}: {e}") from e
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        raise LookupError(f"{urlparse(url).netloc} answered HTTP {r.status_code}")
    try:
        return r.json()
    except ValueError as e:
        raise LookupError(f"{urlparse(url).netloc} returned invalid JSON") from e


# ---------------------------------------------------------------- lyrics

def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def search_lyrics(title: str, artist: str, duration: Optional[float] = None) -> Dict[str, Any]:
    """lrclib.net lookup: exact /get first, then /search picking the first synced result."""
    title, artist = _norm(title), _norm(artist)
    out: Dict[str, Any] = {"found": False, "synced": None, "plain": None,
                           "title": title, "artist": artist, "source": "lrclib"}
    if not title:
        return out
    with _client() as client:
        hit = None
        if artist and duration and duration > 0:
            params = {"artist_name": artist, "track_name": title, "duration": int(round(duration))}
            data = _get_json(client, LRCLIB_GET, params)
            if isinstance(data, dict) and (data.get("syncedLyrics") or data.get("plainLyrics")):
                hit = data
        if hit is None:
            params = {"track_name": title}
            if artist:
                params["artist_name"] = artist
            data = _get_json(client, LRCLIB_SEARCH, params)
            results = data if isinstance(data, list) else []
            results = [r for r in results if isinstance(r, dict) and not r.get("instrumental")]
            if duration and duration > 0:
                # prefer results whose duration is close to ours (within 10 s)
                close = [r for r in results if isinstance(r.get("duration"), (int, float))
                         and abs(float(r["duration"]) - float(duration)) <= 10]
                if close:
                    results = close + [r for r in results if r not in close]
            hit = next((r for r in results if r.get("syncedLyrics")), None)
            if hit is None:
                hit = next((r for r in results if r.get("plainLyrics")), None)
    if hit is None:
        return out
    out.update({
        "found": True,
        "synced": hit.get("syncedLyrics") or None,
        "plain": hit.get("plainLyrics") or None,
        "title": _norm(hit.get("trackName")) or title,
        "artist": _norm(hit.get("artistName")) or artist,
    })
    return out


# ---------------------------------------------------------------- identify

_JUNK = re.compile(
    r"\s*[\(\[\{][^\)\]\}]*(official|video|audio|lyric|lyrics|visuali[sz]er|hd|hq|4k|remaster(ed)?|"
    r"live|mv|m/v|clip|version|explicit|clean|feat\.?|ft\.?)[^\)\]\}]*[\)\]\}]",
    re.IGNORECASE,
)
_TRAILING = re.compile(r"\s*[\|\-–—]\s*(official\s+(music\s+)?video|official\s+audio|lyrics?|lyric\s+video|"
                       r"audio|hd|hq|4k|visuali[sz]er)\s*$", re.IGNORECASE)
_QUOTES = re.compile(r"[\"“”]")


def clean_title(s: str) -> str:
    s = _norm(s)
    prev = None
    while prev != s:
        prev = s
        s = _JUNK.sub("", s)
        s = _TRAILING.sub("", s)
    s = _QUOTES.sub("", s)
    return _norm(s.strip(" -–—|"))


def clean_artist(s: str) -> str:
    s = _norm(s)
    s = re.sub(r"\s*-\s*Topic$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"VEVO$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*\((official|music)\)$", "", s, flags=re.IGNORECASE)
    return _norm(s)


def split_title(raw: str) -> tuple[Optional[str], Optional[str]]:
    """'Artist - Title' or 'Title by Artist' -> (title, artist); either may be None."""
    s = clean_title(raw)
    for sep in (" - ", " – ", " — ", " | "):
        if sep in s:
            a, b = s.split(sep, 1)
            return clean_title(b), clean_artist(a)
    m = re.match(r"^(.*?)\s+by\s+(.+)$", s, flags=re.IGNORECASE)
    if m:
        return clean_title(m.group(1)), clean_artist(m.group(2))
    return (s or None), None


def detect_source(url: str) -> str:
    host = (urlparse(url).netloc or "").lower()
    if any(h in host for h in ("youtube.com", "youtu.be", "youtube-nocookie.com")):
        return "youtube"
    if "spotify.com" in host or "spotify.link" in host:
        return "spotify"
    return "unknown"


def identify(url: str) -> Dict[str, Any]:
    """{title, artist, source} from the public oEmbed endpoints. Never downloads audio."""
    url = (url or "").strip()
    source = detect_source(url)
    result: Dict[str, Any] = {"title": None, "artist": None, "source": source}
    if source == "unknown" or not url.lower().startswith(("http://", "https://")):
        return result
    with _client() as client:
        if source == "youtube":
            data = _get_json(client, YT_OEMBED, {"url": url, "format": "json"})
        else:
            data = _get_json(client, SP_OEMBED, {"url": url})
    if not isinstance(data, dict):
        return result
    raw_title = _norm(str(data.get("title") or ""))
    author = clean_artist(str(data.get("author_name") or ""))
    title, artist = split_title(raw_title)
    if source == "youtube":
        if not artist and author:
            artist = author
    else:
        # Spotify oEmbed: title is the track name, author_name is the artist (when present)
        if author:
            artist = author
            title = clean_title(raw_title) or title
    result["title"] = title or None
    result["artist"] = artist or None
    return result


def oembed_url(url: str) -> str:  # exposed for tests / debugging
    source = detect_source(url)
    if source == "youtube":
        return f"{YT_OEMBED}?{urlencode({'url': url, 'format': 'json'})}"
    if source == "spotify":
        return f"{SP_OEMBED}?{urlencode({'url': url})}"
    return ""
