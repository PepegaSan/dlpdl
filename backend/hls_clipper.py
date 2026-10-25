"""
HLS time-range clipper (clean-room).

Primary path: ffmpeg reads the media playlist directly (-ss / -to on the HLS
timeline). Fallback: download TS segments + ffmpeg concat demuxer + cut.
Spec: docs/BEHAVIOR.md
"""

from __future__ import annotations

import http.client
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

from . import diagnostics
from .media_probe import classify_media_bytes, preflight_problem

log = logging.getLogger('clip_direct.hls')

DEFAULT_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
)
TS_PACKET_SIZE = 188
PREFIX_SCAN_BYTES = 8192
BYTES_PER_SEGMENT_GUESS = 950_000
ENCODE_SHARE_OF_PROGRESS = 0.12
DURATION_TOLERANCE_SEC = 2.5
# Decode this many seconds before the cut so the encoder sees a keyframe (fixes blocky start).
DECODE_PREROLL_SEC = 10.0
PREROLL_HLS_SEGMENTS = 2
M3U8_RE = re.compile(r'\.m3u8(\?|$)', re.IGNORECASE)
SEGMENT_FETCH_DELAY_SEC = 0.5
SEGMENT_FETCH_RETRY_MAX = 6
SEGMENT_FETCH_RETRY_BASE_SEC = 2.5
SEGMENT_READ_CHUNK = 64 * 1024
FFMPEG_TIMEOUT_SEC = float(os.environ.get('FFMPEG_TIMEOUT_SEC', '1800'))
FFPROBE_TIMEOUT_SEC = 60.0


class JobCancelled(BaseException):
    """Raised inside a job thread after the user cancelled it.

    BaseException so the many `except Exception` fallbacks in the clip paths
    do not turn a cancel into "try the next strategy".
    """


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._procs: set[subprocess.Popen] = set()
        self._lock = threading.Lock()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            procs = list(self._procs)
        for proc in procs:
            try:
                proc.kill()
            except OSError:
                pass

    def register(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.add(proc)
        if self.cancelled:
            try:
                proc.kill()
            except OSError:
                pass

    def unregister(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.discard(proc)


_job_ctx = threading.local()


def set_cancel_token(token: Optional[CancelToken]) -> None:
    _job_ctx.token = token


def current_cancel_token() -> Optional[CancelToken]:
    return getattr(_job_ctx, 'token', None)


def raise_if_cancelled() -> None:
    token = current_cancel_token()
    if token is not None and token.cancelled:
        raise JobCancelled()


@dataclass(frozen=True)
class InitSection:
    """fMP4 / CMAF #EXT-X-MAP: the moov every following fragment needs."""
    uri: str
    byterange: Optional[tuple[int, int]] = None  # (length, offset)


@dataclass(frozen=True)
class SegmentKey:
    method: str  # only AES-128 is decrypted
    uri: str
    iv: Optional[bytes] = None  # None: IV = media sequence number


@dataclass(frozen=True)
class MediaSegment:
    timeline_start: float
    duration: float
    uri: str
    byterange: Optional[tuple[int, int]] = None  # (length, offset)
    init: Optional[InitSection] = None
    key: Optional[SegmentKey] = None
    sequence: int = 0
    discontinuity: int = 0


@dataclass
class ParsedPlaylist:
    segments: list[MediaSegment]
    duration: float
    encrypted: bool  # True only for encryption we cannot handle (e.g. SAMPLE-AES)
    init_uri: Optional[str] = None
    init_byterange: Optional[tuple[int, int]] = None
    key_method: str = ''
    # Separate audio rendition (#EXT-X-MEDIA TYPE=AUDIO) of the chosen variant.
    audio_url: Optional[str] = None


def url_looks_like_hls(url: Optional[str]) -> bool:
    if not url:
        return False
    low = urllib.parse.unquote(url).lower()
    # Single .ts chunks (e.g. phncdn seg-NNN.ts) are not playlists.
    if re.search(r'\.ts(\?|$|&)', low) and '.m3u8' not in low:
        return False
    return bool(M3U8_RE.search(url)) or '.m3u8' in low


def is_hls_url(url: Optional[str]) -> bool:
    """Public alias used by downloader."""
    return url_looks_like_hls(url)


def _is_retryable_network_error(exc: BaseException) -> bool:
    """CDN drops / truncated bodies (IncompleteRead) are transient, not a bad clip."""
    if isinstance(exc, http.client.IncompleteRead):
        return True
    if isinstance(exc, (TimeoutError, socket.timeout, ConnectionError, BrokenPipeError)):
        return True
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, 'reason', None)
        if isinstance(reason, BaseException) and _is_retryable_network_error(reason):
            return True
        msg = str(exc).lower()
        return any(
            token in msg
            for token in (
                'timed out',
                'timeout',
                'incomplete',
                'connection reset',
                'broken pipe',
                'temporarily unavailable',
                'eof occurred',
                'remote end closed',
            )
        )
    return False


def build_progress_event(
    *,
    fraction: float,
    msg: str,
    speed: float = 0.0,
    eta: Optional[float] = None,
) -> dict:
    fraction = max(0.0, min(1.0, fraction))
    total = 1_000_000
    payload = {
        'status': 'downloading',
        'msg': msg,
        'downloaded_bytes': int(fraction * total),
        'total_bytes_estimate': total,
    }
    if speed > 0:
        payload['speed'] = speed
    if eta is not None and eta >= 0:
        payload['eta'] = eta
    return payload


class HttpFetcher:
    def __init__(
        self,
        headers: Optional[dict],
        timeout: int = 30,
        segment_delay: float = SEGMENT_FETCH_DELAY_SEC,
    ):
        self._headers = dict(headers or {})
        self._headers.setdefault('User-Agent', DEFAULT_USER_AGENT)
        self._timeout = timeout
        self._segment_delay = max(0.0, float(segment_delay))
        self._last_fetch_at = 0.0
        self.key_cache: dict[str, bytes] = {}
        self.init_cache: dict[InitSection, bytes] = {}
        self.prefetched: dict[MediaSegment, bytes] = {}
        self.last_final_url = ''

    @property
    def header_names(self) -> list[str]:
        return sorted(self._headers)

    def get_text(self, url: str) -> str:
        return self.get_text_final(url)[0]

    def get_text_final(self, url: str) -> tuple[str, str]:
        """Text plus the URL it was actually served from (after redirects)."""
        text = self.get_bytes(url).decode('utf-8', 'ignore').lstrip('﻿')
        return text, self.last_final_url or url

    def _throttle(self) -> None:
        if self._segment_delay <= 0:
            return
        elapsed = time.monotonic() - self._last_fetch_at
        if elapsed < self._segment_delay:
            time.sleep(self._segment_delay - elapsed)

    def _retry_wait(self, attempt: int, exc: Optional[urllib.error.HTTPError] = None) -> float:
        if exc is not None:
            retry_after = exc.headers.get('Retry-After') if exc.headers else None
            if retry_after:
                try:
                    return min(max(float(retry_after), 1.0), 60.0)
                except ValueError:
                    pass
        return min(SEGMENT_FETCH_RETRY_BASE_SEC * (2 ** attempt), 45.0)

    def _open(self, url: str, extra_headers: Optional[dict] = None):
        headers = dict(self._headers)
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, headers=headers)
        return urllib.request.urlopen(req, timeout=self._timeout)

    def _read_body(self, resp) -> tuple[bytes, bool]:
        """Body bytes and whether the server delivered all of it (no dropped connection)."""
        chunks: list[bytes] = []
        complete = True
        while True:
            try:
                chunk = resp.read(SEGMENT_READ_CHUNK)
            except http.client.IncompleteRead as inc:
                if inc.partial:
                    chunks.append(inc.partial)
                complete = False
                break
            if not chunk:
                break
            chunks.append(chunk)
        return b''.join(chunks), complete

    def _resume_range(self, url: str, got: bytes, declared: int) -> tuple[bytes, bool]:
        """Append remaining bytes after a dropped connection.

        Returns (data, complete). A 416 means nothing exists beyond `got`: the
        Content-Length was wrong and the body is complete as it is.
        """
        data = got
        for _ in range(3):
            if len(data) >= declared:
                return data, True
            if not data:
                return data, False
            self._throttle()
            try:
                with self._open(url, {'Range': f'bytes={len(data)}-'}) as resp:
                    extra, _ = self._read_body(resp)
                    status = getattr(resp, 'status', None) or resp.getcode()
            except urllib.error.HTTPError as exc:
                if exc.code == 416:
                    log.warning('CDN Content-Length lie (%d/%d) for %s', len(data), declared, url[:96])
                    return data, True
                raise
            self._last_fetch_at = time.monotonic()
            if not extra:
                return data, False
            if status == 206:
                data += extra
                continue
            # CDN ignored Range and re-sent the whole file.
            if len(extra) > len(data):
                return extra, len(extra) >= declared
            return data, False
        return data, len(data) >= declared

    def get_bytes(self, url: str, byte_range: Optional[tuple[int, int]] = None) -> bytes:
        """GET a resource; byte_range=(length, offset) for #EXT-X-BYTERANGE segments.

        A body shorter than announced is retried, never returned: a truncated
        segment would show up as a glitch in the clip instead of an error.
        """
        last_exc: Optional[BaseException] = None
        range_header = None
        if byte_range:
            length, offset = byte_range
            range_header = {'Range': f'bytes={offset}-{offset + length - 1}'}
        for attempt in range(SEGMENT_FETCH_RETRY_MAX):
            raise_if_cancelled()
            self._throttle()
            try:
                with self._open(url, range_header) as resp:
                    status = getattr(resp, 'status', None) or resp.getcode()
                    final_url = resp.geturl() or url
                    declared = None
                    raw_len = resp.headers.get('Content-Length')
                    if raw_len:
                        try:
                            declared = int(raw_len)
                        except ValueError:
                            declared = None
                    data, complete = self._read_body(resp)
                self._last_fetch_at = time.monotonic()
                self.last_final_url = final_url
                diagnostics.count(f'http_{status}')
                expected = declared
                if byte_range and status == 206 and expected is None:
                    expected = byte_range[0]
                if expected is not None and 0 < len(data) < expected:
                    if byte_range and status == 206:
                        complete = False
                    else:
                        try:
                            data, complete = self._resume_range(url, data, expected)
                        except Exception as resume_exc:
                            log.warning('range resume failed for %s: %s', url[:96], resume_exc)
                            complete = False
                if byte_range and status != 206:
                    length, offset = byte_range
                    whole = data
                    data = data[offset:offset + length]
                    # A drop behind our range leaves the range itself intact.
                    if len(whole) >= offset + length:
                        complete = True
                if data and complete:
                    return data
                diagnostics.note(
                    'truncated', url=url, got=len(data), expected=expected, attempt=attempt + 1,
                )
                last_exc = RuntimeError(
                    f'Segment unvollständig ({len(data)} von '
                    f'{expected if expected is not None else "?"} Bytes) nach '
                    f'{SEGMENT_FETCH_RETRY_MAX} Versuchen — CDN bricht die Verbindung ab',
                )
            except urllib.error.HTTPError as exc:
                last_exc = exc
                diagnostics.count(f'http_{exc.code}')
                diagnostics.note('http_error', url=url, status=exc.code, attempt=attempt + 1)
                if exc.code not in (429, 500, 502, 503, 504) or attempt >= SEGMENT_FETCH_RETRY_MAX - 1:
                    if exc.code == 429:
                        raise RuntimeError(
                            'CDN limitiert Anfragen (429) — 1–2 Minuten warten, '
                            'dann erneut senden (nur ein Job gleichzeitig)',
                        ) from exc
                    raise
                wait = self._retry_wait(attempt, exc)
                log.warning(
                    'HTTP %s for %s — retry in %.1fs (%d/%d)',
                    exc.code,
                    url[:96],
                    wait,
                    attempt + 1,
                    SEGMENT_FETCH_RETRY_MAX,
                )
                time.sleep(wait)
                continue
            except Exception as exc:
                last_exc = exc
                if not _is_retryable_network_error(exc) or attempt >= SEGMENT_FETCH_RETRY_MAX - 1:
                    raise
            wait = self._retry_wait(attempt)
            log.warning(
                'truncated/dropped segment %s — retry in %.1fs (%d/%d): %s',
                url[:96],
                wait,
                attempt + 1,
                SEGMENT_FETCH_RETRY_MAX,
                last_exc,
            )
            time.sleep(wait)
        if last_exc:
            raise last_exc
        raise RuntimeError('segment fetch failed')


def align_transport_stream(payload: bytes) -> bytes:
    """Drop leading junk until MPEG-TS sync (0x47) repeats at packet boundaries."""
    scan = min(len(payload), PREFIX_SCAN_BYTES)
    for offset in range(scan):
        if offset + 3 * TS_PACKET_SIZE >= len(payload):
            break
        if (
            payload[offset] == 0x47
            and payload[offset + TS_PACKET_SIZE] == 0x47
            and payload[offset + 2 * TS_PACKET_SIZE] == 0x47
            and payload[offset + 3 * TS_PACKET_SIZE] == 0x47
        ):
            return payload[offset:]
    return payload


def resolve_hls_uri(base_url: str, ref: str) -> str:
    """
    Resolve a playlist/segment reference against the parent playlist URL.

    Signed CDNs (e.g. Softvelum `.urlset/master.m3u8?t=…&s=…`) put the auth
    query on the playlist. Relative child URIs rarely repeat it — plain
    urljoin drops the query and subsequent fetches only get the first
    cached segment (~6–10s) before 403s. Inherit the parent query when the
    child has none (same-host only for absolute refs).
    """
    ref = (ref or '').strip()
    if not ref:
        return base_url
    joined = urllib.parse.urljoin(base_url, ref)
    base = urllib.parse.urlsplit(base_url)
    ref_p = urllib.parse.urlsplit(ref)
    out = urllib.parse.urlsplit(joined)
    if not base.query:
        return joined
    if ref_p.query or out.query:
        return joined
    # Other hosts (also protocol-relative //cdn/…) and data:/skd: URIs keep their own form.
    if out.scheme.lower() not in ('http', 'https'):
        return joined
    if (out.netloc or '').lower() != (base.netloc or '').lower():
        return joined
    return urllib.parse.urlunsplit(
        (out.scheme, out.netloc, out.path, base.query, out.fragment),
    )


_ATTR_RE = re.compile(r'([A-Za-z0-9-]+)=("([^"]*)"|[^,]*)')
_VIDEO_CODEC_HINTS = ('avc', 'hvc', 'hev', 'av01', 'vp09', 'vp9', 'mp4v', 'dvh')


def _hls_attrs(line: str) -> dict[str, str]:
    body = line.split(':', 1)[1] if ':' in line else ''
    return {
        m.group(1).upper(): (m.group(3) if m.group(3) is not None else m.group(2)).strip()
        for m in _ATTR_RE.finditer(body)
    }


def _parse_byterange(value: Optional[str]) -> Optional[tuple[int, Optional[int]]]:
    match = re.fullmatch(r'\s*(\d+)(?:@(\d+))?\s*', value or '')
    if not match:
        return None
    return int(match.group(1)), (int(match.group(2)) if match.group(2) else None)


def select_master_variant(text: str, base_url: str) -> tuple[Optional[str], Optional[str]]:
    """Best video variant (resolution, then bandwidth) and its separate audio rendition."""
    audio_groups: dict[str, list[tuple[bool, str]]] = {}
    variants: list[tuple[dict[str, str], str]] = []
    pending: Optional[dict[str, str]] = None
    for line in text.lstrip('﻿').splitlines():
        stripped = line.strip()
        if stripped.startswith('#EXT-X-MEDIA:'):
            attrs = _hls_attrs(stripped)
            if attrs.get('TYPE', '').upper() == 'AUDIO' and attrs.get('URI'):
                audio_groups.setdefault(attrs.get('GROUP-ID', ''), []).append(
                    (attrs.get('DEFAULT', 'NO').upper() == 'YES', resolve_hls_uri(base_url, attrs['URI'])),
                )
        elif stripped.startswith('#EXT-X-STREAM-INF'):
            pending = _hls_attrs(stripped)
        elif stripped and not stripped.startswith('#') and pending is not None:
            variants.append((pending, resolve_hls_uri(base_url, stripped)))
            pending = None
    if not variants:
        return None, None

    def has_video(attrs: dict[str, str]) -> bool:
        codecs = attrs.get('CODECS', '').lower()
        return bool(attrs.get('RESOLUTION')) or not codecs or any(h in codecs for h in _VIDEO_CODEC_HINTS)

    def rank(item: tuple[dict[str, str], str]) -> tuple[int, int]:
        attrs = item[0]
        res = re.match(r'(\d+)x(\d+)', attrs.get('RESOLUTION', ''))
        area = int(res.group(1)) * int(res.group(2)) if res else 0
        try:
            bandwidth = int(attrs.get('BANDWIDTH') or attrs.get('AVERAGE-BANDWIDTH') or 0)
        except ValueError:
            bandwidth = 0
        return area, bandwidth

    pool = [v for v in variants if has_video(v[0])] or variants
    best_attrs, best_uri = max(pool, key=rank)
    audio_url = None
    group = audio_groups.get(best_attrs.get('AUDIO', ''))
    if group:
        audio_url = next((uri for is_default, uri in group if is_default), group[0][1])
    return best_uri, audio_url


def resolve_master_playlist(text: str, base_url: str) -> Optional[str]:
    return select_master_variant(text, base_url)[0]


def parse_media_playlist(text: str, base_url: str) -> ParsedPlaylist:
    # str.strip() keeps U+FEFF, so a BOM would turn "#EXTM3U" into segment 0
    # and shift every AES sequence-number IV by one.
    text = text.lstrip('﻿')
    segments: list[MediaSegment] = []
    timeline = 0.0
    pending_duration: Optional[float] = None
    pending_range: Optional[tuple[int, Optional[int]]] = None
    media_sequence = 0
    discontinuity = 0
    init: Optional[InitSection] = None
    key: Optional[SegmentKey] = None
    key_method = ''
    encrypted = False
    range_end: dict[str, int] = {}

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('#EXT-X-MEDIA-SEQUENCE:'):
            try:
                media_sequence = int(stripped.split(':', 1)[1])
            except ValueError:
                media_sequence = 0
        elif stripped.startswith('#EXT-X-KEY:'):
            attrs = _hls_attrs(stripped)
            method = attrs.get('METHOD', 'NONE').upper()
            if method == 'NONE':
                key = None
            elif method == 'AES-128' and attrs.get('URI'):
                iv_hex = attrs.get('IV', '')
                iv = None
                if iv_hex:
                    try:
                        iv = bytes.fromhex(iv_hex[2:] if iv_hex.lower().startswith('0x') else iv_hex)
                    except ValueError:
                        raise ValueError(f'#EXT-X-KEY: ungültiger IV {iv_hex!r}') from None
                    if len(iv) > 16:
                        raise ValueError(f'#EXT-X-KEY: IV länger als 16 Bytes ({iv_hex!r})')
                    iv = iv.rjust(16, b'\0')
                key = SegmentKey('AES-128', resolve_hls_uri(base_url, attrs['URI']), iv)
                key_method = key_method or 'AES-128'
            else:
                encrypted = True
                key_method = method
                key = None
        elif stripped.startswith('#EXT-X-MAP:'):
            attrs = _hls_attrs(stripped)
            if attrs.get('URI'):
                rng = _parse_byterange(attrs.get('BYTERANGE'))
                init = InitSection(
                    resolve_hls_uri(base_url, attrs['URI']),
                    (rng[0], rng[1] or 0) if rng else None,
                )
        elif stripped == '#EXT-X-DISCONTINUITY':
            discontinuity += 1
        elif stripped.startswith('#EXT-X-BYTERANGE:'):
            pending_range = _parse_byterange(stripped.split(':', 1)[1])
        elif stripped.startswith('#EXTINF:'):
            try:
                pending_duration = float(stripped[len('#EXTINF:'):].split(',')[0])
            except ValueError:
                pending_duration = 0.0
        elif stripped and not stripped.startswith('#'):
            uri = resolve_hls_uri(base_url, stripped)
            byterange = None
            if pending_range:
                length, offset = pending_range
                if offset is None:
                    offset = range_end.get(uri, 0)
                byterange = (length, offset)
                range_end[uri] = offset + length
            duration = pending_duration or 0.0
            segments.append(
                MediaSegment(
                    timeline_start=timeline,
                    duration=duration,
                    uri=uri,
                    byterange=byterange,
                    init=init,
                    key=key,
                    sequence=media_sequence + len(segments),
                    discontinuity=discontinuity,
                ),
            )
            timeline += duration
            pending_duration = None
            pending_range = None

    first_init = next((s.init for s in segments if s.init), None)
    return ParsedPlaylist(
        segments=segments,
        duration=timeline,
        encrypted=encrypted,
        init_uri=first_init.uri if first_init else None,
        init_byterange=first_init.byterange if first_init else None,
        key_method=key_method,
    )


def fetch_init_bytes(fetcher: 'HttpFetcher', init: InitSection) -> bytes:
    cached = fetcher.init_cache.get(init)
    if cached is None:
        cached = fetcher.get_bytes(init.uri, byte_range=init.byterange)
        fetcher.init_cache[init] = cached
    return cached


def _decrypt_aes128(fetcher: 'HttpFetcher', key: SegmentKey, sequence: int, data: bytes) -> bytes:
    try:
        from Cryptodome.Cipher import AES
    except ImportError as exc:  # pragma: no cover - shipped with yt-dlp[default]
        raise RuntimeError('AES-128 HLS braucht pycryptodomex (kommt mit yt-dlp[default])') from exc
    secret = fetcher.key_cache.get(key.uri)
    if secret is None:
        secret = fetcher.get_bytes(key.uri)
        if len(secret) != 16:
            raise RuntimeError(f'HLS-Schlüssel hat {len(secret)} statt 16 Bytes (Login/Token nötig?)')
        fetcher.key_cache[key.uri] = secret
    iv = key.iv or sequence.to_bytes(16, 'big')
    plain = AES.new(secret, AES.MODE_CBC, iv).decrypt(data[: len(data) - len(data) % 16])
    pad = plain[-1] if plain else 0
    if 1 <= pad <= 16 and plain.endswith(bytes([pad]) * pad):
        plain = plain[:-pad]
    return plain


def fetch_segment_bytes(fetcher: 'HttpFetcher', seg: MediaSegment) -> bytes:
    """Segment payload ready for ffmpeg: byte range applied, AES-128 decrypted."""
    cached = fetcher.prefetched.pop(seg, None)
    if cached is not None:
        return cached
    data = fetcher.get_bytes(seg.uri, byte_range=seg.byterange)
    if seg.key is not None:
        data = _decrypt_aes128(fetcher, seg.key, seg.sequence, data)
    return data


def _needs_turboviplay_cookies(url: str) -> bool:
    low = (url or '').lower()
    return any(host in low for host in ('turboviplay.com', 'turbosplayer.com'))


def _cookie_header_present(headers: Optional[dict]) -> bool:
    if not headers:
        return False
    for key, value in headers.items():
        if key.lower() == 'cookie' and str(value or '').strip():
            return True
    return False


def _segment_uri_looks_like_playlist(uri: str) -> bool:
    return bool(M3U8_RE.search(uri.lower()))


def _fetch_resolved_media_playlist(
    fetcher: HttpFetcher,
    playlist_url: str,
    depth: int = 0,
) -> tuple[str, ParsedPlaylist]:
    if depth > 4:
        raise ValueError('too many nested HLS playlists')
    body, final_url = fetcher.get_text_final(playlist_url)
    diagnostics.note('playlist', url=playlist_url, depth=depth, text=body[:3000], final_url=final_url)
    # Relative URIs resolve against the URL the playlist was served from; a
    # redirect that dropped the signed query still passes it on to the children.
    media_url = _redirected_base(playlist_url, final_url)
    if '#EXT-X-STREAM-INF' in body:
        variant, audio_url = select_master_variant(body, media_url)
        if not variant:
            raise ValueError('no variant in master playlist')
        diagnostics.note('variant', video=variant, audio=audio_url or '')
        media_url, parsed = _fetch_resolved_media_playlist(fetcher, variant, depth + 1)
        if audio_url and not parsed.audio_url:
            parsed.audio_url = audio_url
        return media_url, parsed
    parsed = parse_media_playlist(body, media_url)
    if parsed.segments:
        sample = parsed.segments[: min(3, len(parsed.segments))]
        if all(_segment_uri_looks_like_playlist(seg.uri) for seg in sample):
            return _fetch_resolved_media_playlist(fetcher, sample[0].uri, depth + 1)
    return media_url, parsed


def _redirected_base(requested: str, final: str) -> str:
    if not final or final == requested:
        return requested
    req_q = urllib.parse.urlsplit(requested).query
    fin = urllib.parse.urlsplit(final)
    if req_q and not fin.query:
        return urllib.parse.urlunsplit((fin.scheme, fin.netloc, fin.path, req_q, ''))
    return final


def resolve_hls_playlist(
    playlist_url: str,
    headers: Optional[dict],
) -> tuple[str, ParsedPlaylist, HttpFetcher]:
    fetcher = HttpFetcher(headers)
    media_url, parsed = _fetch_resolved_media_playlist(fetcher, playlist_url)
    if not _playlist_segments_look_valid(parsed):
        log.warning(
            'playlist segments look invalid for %s (first=%s, cookie=%s)',
            media_url[:96],
            parsed.segments[0].uri[:96] if parsed.segments else 'none',
            'yes' if _cookie_header_present(headers) else 'no',
        )
    return media_url, parsed, fetcher


def _remove_quiet(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _output_usable(path: str, min_bytes: int = 4096) -> bool:
    return os.path.isfile(path) and os.path.getsize(path) >= min_bytes


def _playlist_segments_look_valid(parsed: ParsedPlaylist) -> bool:
    if not parsed.segments:
        return False
    for seg in parsed.segments[:6]:
        low = seg.uri.lower()
        if re.search(
            r'\.(ts|m4s|mp4|aac|cmfv|cmfa|image|jpeg|jpg|gif|bin)(\?|$|&)',
            low,
        ):
            return True
        if M3U8_RE.search(low):
            return True
        if any(
            hint in low
            for hint in (
                'turbosplayer',
                'turboviplay',
                '/file/',
                '/hls/',
                '/seg',
                'tiktokcdn',
            )
        ):
            return True
        if re.search(r'/(seg|segment|file|hls|data|chunk|part)(/|$)', low):
            return True
        if re.search(r'/\d+(\?|$)', low):
            return True
    if len(parsed.segments) >= 3 and parsed.duration >= 8:
        timed = sum(1 for seg in parsed.segments[:12] if seg.duration > 0)
        if timed >= 3:
            return True
    return False


def segments_for_window(
    playlist: ParsedPlaylist,
    start: float,
    end: float,
) -> list[MediaSegment]:
    end_eff = end if end != float('inf') else playlist.duration
    if end_eff <= start:
        return []
    return [
        seg
        for seg in playlist.segments
        if (seg.timeline_start + seg.duration) > start + 0.02 and seg.timeline_start < end_eff - 0.02
    ]


def _segment_index(playlist: ParsedPlaylist, seg: MediaSegment) -> int:
    for index, candidate in enumerate(playlist.segments):
        if candidate == seg:
            return index
    return -1


def segments_for_window_preserve(
    playlist: ParsedPlaylist,
    start: float,
    end: float,
) -> list[MediaSegment]:
    """Whole HLS segments only — snaps clip window to segment boundaries (for stream copy)."""
    picked = segments_for_window(playlist, start, end)
    if not picked:
        return []
    first = _segment_index(playlist, picked[0])
    last = _segment_index(playlist, picked[-1])
    if first < 0 or last < 0:
        return picked
    return playlist.segments[first:last + 1]


def segments_with_preroll(
    playlist: ParsedPlaylist,
    picked: list[MediaSegment],
    extra_segments: int = PREROLL_HLS_SEGMENTS,
) -> list[MediaSegment]:
    if not picked or extra_segments <= 0:
        return picked
    first = picked[0]
    before: list[MediaSegment] = []
    for seg in playlist.segments:
        if seg.timeline_start + seg.duration <= first.timeline_start + 0.01:
            before.append(seg)
        elif seg.timeline_start >= first.timeline_start:
            break
    if not before:
        return picked
    preroll = before[-extra_segments:]
    if preroll and preroll[-1] == picked[0]:
        return picked
    return [*preroll, *picked]


def spawn_kwargs() -> dict:
    """Popen options for ffmpeg/ffprobe children.

    Under pythonw (PC render instance) Windows would open a console window for
    every child — a flash per call, and with many calls in a row the loader
    fails with 0xc0000142. No window and no inherited stdin fix both.
    """
    if sys.platform != 'win32':
        return {'stdin': subprocess.DEVNULL}
    return {'stdin': subprocess.DEVNULL, 'creationflags': subprocess.CREATE_NO_WINDOW}


def run_ffmpeg(args: list[str], timeout: float = FFMPEG_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    """Run ffmpeg/ffprobe with a hard timeout; killed when the job is cancelled."""
    raise_if_cancelled()
    token = current_cancel_token()
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **spawn_kwargs(),
    )
    if token is not None:
        token.register(proc)
    try:
        out, err = proc.communicate(timeout=timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        code = 124
        err = f'{err or ""}\n{args[0]} timeout (>{int(timeout)}s)'.strip()
    finally:
        if token is not None:
            token.unregister(proc)
    raise_if_cancelled()
    if code != 0:
        _note_ffmpeg_failure(args, code, err or '')
    return subprocess.CompletedProcess(args, code, out or '', err or '')


AAC_ADTS_BSF = ('-bsf:a', 'aac_adtstoasc')


def _without_aac_bsf(args: list[str]) -> list[str]:
    out: list[str] = []
    skip = False
    for i, arg in enumerate(args):
        if skip:
            skip = False
            continue
        if arg == AAC_ADTS_BSF[0] and i + 1 < len(args) and args[i + 1] == AAC_ADTS_BSF[1]:
            skip = True
            continue
        out.append(arg)
    return out


def run_ffmpeg_copy(
    args: list[str],
    run: Callable[..., subprocess.CompletedProcess] = run_ffmpeg,
    **kwargs,
) -> subprocess.CompletedProcess:
    """Stream copy TS → MP4.

    `-bsf:a aac_adtstoasc` is needed for ADTS AAC on older ffmpeg builds but is
    refused for MP3/MP2 audio ("not supported by the bitstream filter"), so a
    failed run is repeated without it.
    """
    proc = run(args, **kwargs)
    if proc.returncode != 0 and AAC_ADTS_BSF[1] in args:
        proc = run(_without_aac_bsf(args), **kwargs)
    return proc


def _note_ffmpeg_failure(args: list[str], code: int, stderr: str) -> None:
    diagnostics.note(
        'ffmpeg_failed',
        tool=os.path.basename(args[0]) if args else '',
        code=code,
        args=' '.join(
            '<hidden>' if prev in ('-headers', '-user_agent', '-referer', '-cookies') else a
            for prev, a in zip(args, args[1:])
        )[:1500],
        stderr=stderr[-2000:],
    )


def run_ffmpeg_with_progress(
    args: list[str],
    *,
    duration_sec: float,
    on_progress: Optional[Callable[[float, str], None]] = None,
    timeout: float = 900,
) -> subprocess.CompletedProcess:
    """Run ffmpeg and parse -progress pipe:1 for live out_time updates."""
    cmd = list(args)
    insert_at = 2 if len(cmd) > 1 and cmd[1] == '-y' else 1
    if '-progress' not in cmd:
        cmd[insert_at:insert_at] = ['-progress', 'pipe:1', '-nostats']

    raise_if_cancelled()
    token = current_cancel_token()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        **spawn_kwargs(),
    )
    if token is not None:
        token.register(proc)
    out_us = 0
    started = time.monotonic()
    last_emit = 0.0
    stop = threading.Event()

    def read_stdout() -> None:
        nonlocal out_us
        if not proc.stdout:
            return
        for line in proc.stdout:
            if stop.is_set():
                break
            line = line.strip()
            if line.startswith('out_time_us='):
                try:
                    out_us = int(line.split('=', 1)[1])
                except ValueError:
                    pass
            elif line.startswith('out_time_ms='):
                try:
                    # ffmpeg reports microseconds in out_time_ms despite the name
                    out_us = int(line.split('=', 1)[1])
                except ValueError:
                    pass
            elif line == 'progress=end':
                out_us = int(max(duration_sec, 0.1) * 1_000_000)

    # stderr has to be drained live as well: a corrupt TS yields thousands of
    # "non monotonically increasing dts" lines, the pipe fills up and ffmpeg
    # blocks until the timeout. Keep the head and the tail for the report.
    err_head: list[str] = []
    err_tail: list[str] = []

    def read_stderr() -> None:
        if not proc.stderr:
            return
        for line in proc.stderr:
            if len(err_head) < 50:
                err_head.append(line)
                continue
            err_tail.append(line)
            if len(err_tail) > 400:
                del err_tail[:200]

    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()
    err_reader = threading.Thread(target=read_stderr, daemon=True)
    err_reader.start()

    try:
        while proc.poll() is None:
            now = time.monotonic()
            if on_progress and now - last_emit >= 0.8:
                last_emit = now
                elapsed = int(now - started)
                if duration_sec > 0 and out_us > 0:
                    frac = min(out_us / 1_000_000 / duration_sec, 0.99)
                    on_progress(frac, f'{int(frac * 100)}% · {elapsed}s')
                else:
                    on_progress(0.0, f'{elapsed}s…')
            if now - started > timeout:
                proc.kill()
                stop.set()
                raise subprocess.TimeoutExpired(cmd, timeout)
            time.sleep(0.2)
    finally:
        stop.set()
        reader.join(timeout=2)
        err_reader.join(timeout=2)
        if token is not None:
            token.unregister(proc)

    raise_if_cancelled()
    stderr = ''.join(err_head) + ('…\n' if len(err_tail) > 200 else '') + ''.join(err_tail[-200:])
    proc.wait(timeout=5)
    code = proc.returncode if proc.returncode is not None else 1
    if code != 0:
        _note_ffmpeg_failure(cmd, code, stderr)
    return subprocess.CompletedProcess(cmd, code, '', stderr)


# libx264 + concat remux: one at a time so N jobs don't all freeze at "Encoding 83%".
_FFMPEG_ENCODE_SLOTS = threading.Semaphore(1)


def run_ffmpeg_serialized(
    args: list[str],
    *,
    duration_sec: float,
    on_progress: Optional[Callable[[float, str], None]] = None,
    timeout: float = 1800,
) -> subprocess.CompletedProcess:
    acquired = _FFMPEG_ENCODE_SLOTS.acquire(blocking=False)
    if not acquired:
        if on_progress:
            on_progress(0.0, 'wartet auf freien Encoder…')
        while not _FFMPEG_ENCODE_SLOTS.acquire(timeout=1.0):
            raise_if_cancelled()
    try:
        return run_ffmpeg_with_progress(
            args,
            duration_sec=duration_sec,
            on_progress=on_progress,
            timeout=timeout,
        )
    finally:
        _FFMPEG_ENCODE_SLOTS.release()


_EMBED_REFERER_ROOTS = {
    'dood.video': 'https://dood.video/',
    'doodstream.com': 'https://doodstream.com/',
    'dood.watch': 'https://dood.watch/',
}


def normalize_referer_url(referer: str) -> str:
    try:
        parsed = urllib.parse.urlparse(referer)
        host = (parsed.hostname or '').lower().replace('www.', '')
        for suffix, root in _EMBED_REFERER_ROOTS.items():
            if host == suffix or host.endswith(f'.{suffix}'):
                return root
        return referer
    except Exception:
        return referer


def _header_value(headers: Optional[dict], name: str) -> str:
    if not headers:
        return ''
    want = name.lower()
    for key, value in headers.items():
        if str(key).lower() == want:
            return str(value or '').strip()
    return ''


def _url_hostname(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url).hostname or '').lower()
    except Exception:
        return ''


def _hosts_related(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    return a.endswith(f'.{b}') or b.endswith(f'.{a}')


def _looks_like_media_url(url: str) -> bool:
    low = (url or '').lower()
    path = urllib.parse.urlparse(url).path.lower() if url else ''
    return (
        '.m3u8' in low
        or '/hls2' in path
        or path.endswith('.mp4')
        or path.endswith('.ts')
        or path.endswith('.m4s')
    )


def apply_page_referer(
    headers: Optional[dict],
    media_url: str,
    page_url: str,
) -> dict:
    """Prefer the HTML page as Referer when the media host is a separate CDN."""
    out = dict(headers or {})
    page = (page_url or '').strip()
    if not page or _looks_like_media_url(page):
        return out
    media_host = _url_hostname(media_url)
    page_host = _url_hostname(page)
    if not media_host or not page_host or _hosts_related(media_host, page_host):
        return out
    ref_host = _url_hostname(_header_value(out, 'Referer'))
    if ref_host and any(
        hint in ref_host
        for hint in (
            'turboviplay',
            'turbosplayer',
            'emturbovid',
            'dood.video',
            'doodstream',
            'cloudatacdn',
        )
    ):
        return out
    if not ref_host or _hosts_related(ref_host, media_host):
        out['Referer'] = page
        try:
            parsed = urllib.parse.urlparse(page)
            if parsed.scheme and parsed.netloc:
                out['Origin'] = f'{parsed.scheme}://{parsed.netloc}'
        except Exception:
            pass
    return out


def normalize_http_headers(headers: Optional[dict]) -> dict:
    merged = dict(headers or {})
    merged.setdefault('User-Agent', DEFAULT_USER_AGENT)
    merged.setdefault('Accept', '*/*')
    merged.setdefault('Accept-Language', 'en-US,en;q=0.9')
    for key in list(merged.keys()):
        if key.lower() == 'referer' and merged[key]:
            merged[key] = normalize_referer_url(str(merged[key]))
            try:
                parsed = urllib.parse.urlparse(merged[key])
                if parsed.scheme and parsed.netloc:
                    merged['Origin'] = f'{parsed.scheme}://{parsed.netloc}'
            except Exception:
                pass
            break
    return merged


def _format_playlist_error(exc: BaseException, headers: Optional[dict]) -> str:
    has_cookie = _cookie_header_present(headers)
    has_referer = bool(_header_value(headers, 'Referer'))
    code = getattr(exc, 'code', None)
    detail = str(exc)
    if isinstance(exc, ValueError) and code is None:
        # Parse errors (bad IV, no variant, nesting): replaying the page won't help.
        return f'Playlist nicht verarbeitbar: {detail}'
    if code == 403:
        if not has_cookie or not has_referer:
            return (
                f'{detail} — Referer/Cookies missing on the server. '
                'Play the video on the original site, reload the extension, '
                'then send again (do not open the .m3u8 URL as its own tab).'
            )
        return (
            f'{detail} — CDN rejected the server request (headers were sent). '
            'Play on the original page and send immediately via the extension. '
            'If Clip-Direct runs on the NAS, the CDN may see a different IP '
            'than the browser — use Docker on the PC (http://localhost:8090/).'
        )
    return (
        f'{detail} — play the video on the original page, then send again'
    )


class _BlockCrossHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        orig = urllib.parse.urlparse(req.full_url)
        dest = urllib.parse.urlparse(newurl)
        if (
            orig.hostname
            and dest.hostname
            and orig.hostname.lower() != dest.hostname.lower()
        ):
            raise urllib.error.HTTPError(
                req.full_url,
                code,
                f'redirect to {dest.hostname} blocked',
                hdrs,
                fp,
            )
        return super().redirect_request(req, fp, code, msg, hdrs, newurl)


def probe_progressive_media_url(url: str, headers: Optional[dict]) -> tuple[bool, str]:
    """Verify CDN returns media bytes (not an HTML redirect to dood.video)."""
    h = normalize_http_headers(headers)
    opener = urllib.request.build_opener(_BlockCrossHostRedirect())
    req = urllib.request.Request(url, headers={**h, 'Range': 'bytes=0-8191'})
    try:
        with opener.open(req, timeout=12) as resp:
            chunk = resp.read(8192)
            ctype = (resp.headers.get('Content-Type') or '').lower()
    except urllib.error.HTTPError as exc:
        detail = str(exc.reason or exc)
        if 'redirect' in detail.lower() or exc.code in (301, 302, 303, 307, 308):
            return False, (
                'CDN leitet auf Embed-Seite um — Video abspielen, '
                'sofort erneut senden (Token abgelaufen?)'
            )
        if exc.code in (403, 401):
            return False, 'CDN verweigert Zugriff (403) — Referer/Cookies prüfen, Video abspielen, erneut senden'
        return False, f'CDN probe failed: HTTP {exc.code} {detail}'
    except Exception as exc:
        low = str(exc).lower()
        if 'dood.video' in low:
            return False, (
                'CDN verweist auf dood.video — Video abspielen, '
                'sofort erneut senden (Token abgelaufen?)'
            )
        return False, f'CDN probe failed: {exc}'

    if not chunk:
        return False, 'CDN lieferte leere Antwort — Token abgelaufen? Video abspielen, erneut senden'
    head = chunk.lstrip()[:64].lower()
    if head.startswith(b'<!doctype') or head.startswith(b'<html') or b'<html' in head:
        return False, 'CDN lieferte HTML statt Video — Token abgelaufen, erneut senden'
    if 'video' in ctype or 'octet-stream' in ctype or 'mp4' in ctype:
        return True, 'ok'
    if chunk[0:1] == b'\x00' or b'ftyp' in chunk[:32]:
        return True, 'ok'
    return True, 'ok'


def ffmpeg_header_args(headers: Optional[dict]) -> list[str]:
    merged = normalize_http_headers(headers)
    lines: list[str] = []
    seen: set[str] = set()
    for key in ('User-Agent', 'Referer', 'Origin', 'Cookie'):
        value = merged.get(key)
        if value:
            lines.append(f'{key}: {value}')
            seen.add(key)
    for key, value in merged.items():
        if key in seen or not value:
            continue
        lines.append(f'{key}: {value}')
    if not lines:
        return []
    return ['-headers', '\r\n'.join(lines) + '\r\n']


_ffmpeg_http_extras_cache: Optional[list[str]] = None


def ffmpeg_http_input_extras() -> list[str]:
    """HTTP demuxer flags safe across ffmpeg builds (Debian slim lacks max_http_redirections)."""
    global _ffmpeg_http_extras_cache
    if _ffmpeg_http_extras_cache is not None:
        return list(_ffmpeg_http_extras_cache)

    extras: list[str] = []
    try:
        proc = subprocess.run(
            ['ffmpeg', '-h', 'demuxer=http'],
            capture_output=True,
            text=True,
            timeout=10,
            **spawn_kwargs(),
        )
        help_text = (proc.stdout or '') + (proc.stderr or '')
        if 'max_http_redirections' in help_text:
            # Follow redirects (e.g. get_file/… -> remote_control). 0 disabled
            # them entirely and broke any redirecting CDN.
            extras.extend(['-max_http_redirections', '8'])
        if 'http_persistent' in help_text:
            extras.extend(['-http_persistent', '0'])
    except (OSError, subprocess.TimeoutExpired):
        pass

    _ffmpeg_http_extras_cache = extras
    return list(extras)


def probe_duration_seconds(path: str) -> Optional[float]:
    proc = run_ffmpeg(
        [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            path,
        ],
        timeout=FFPROBE_TIMEOUT_SEC,
    )
    if proc.returncode != 0:
        return None
    try:
        return float((proc.stdout or '').strip())
    except ValueError:
        return None


def finalize_mp4_for_editor(path: str) -> tuple[bool, str]:
    """
    Remux MP4 with moov at the start (faststart) so NLEs (DaVinci, Premiere) show
    thumbnails and import reliably. Stream copy only — compressed samples unchanged.
    """
    if not path or not os.path.isfile(path):
        return True, 'skip'
    if not path.lower().endswith('.mp4'):
        return True, 'skip'
    tmp = f'{path}.nlemux.mp4'
    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-i', path,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        tmp,
    ]
    proc = run_ffmpeg_copy(args)
    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:300]
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False, f'finalize: {err}'
    if not os.path.isfile(tmp) or os.path.getsize(tmp) == 0:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False, 'finalize: empty output'
    try:
        os.replace(tmp, path)
    except OSError as exc:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False, f'finalize: replace failed: {exc}'
    return True, 'finalize faststart'


def probe_video_fps(path: str) -> Optional[float]:
    proc = run_ffmpeg(
        [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            path,
        ],
        timeout=FFPROBE_TIMEOUT_SEC,
    )
    raw = (proc.stdout or '').strip()
    if not raw:
        return None
    if '/' in raw:
        num, den = raw.split('/', 1)
        try:
            n, d = float(num), float(den)
        except ValueError:
            return None
        if d == 0:
            return None
        return n / d
    try:
        return float(raw)
    except ValueError:
        return None


def _safe_remove(path: str) -> None:
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


def rerender_for_editing(
    path: str,
    *,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> tuple[bool, str, str]:
    """
    Re-encode a finished clip so NLE / ML pipelines get a clean file:
    constant frame rate, PTS starting at 0, a keyframe at the start, and
    re-synced audio. Fixes the "last frame frozen for ~2s" and open-GOP
    keyframe bugs that stream-copy clips leave behind.

    Always outputs an .mp4. Returns (ok, detail, output_path); output_path
    may differ from the input when the source container was not .mp4.
    """
    if not path or not os.path.isfile(path):
        return True, 'skip', path

    is_mp4 = path.lower().endswith('.mp4')
    target = path if is_mp4 else f'{os.path.splitext(path)[0]}.mp4'
    tmp = f'{target}.rerender.mp4'

    duration = probe_duration_seconds(path) or 0.0
    fps = probe_video_fps(path)

    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-fflags', '+genpts',
        '-i', path,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-vf', 'setpts=PTS-STARTPTS',
        '-af', 'aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-vsync', 'cfr',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
    ]
    if fps and fps > 0:
        args.extend(['-r', f'{fps:.6f}'])
    args.append(tmp)

    try:
        proc = run_ffmpeg_serialized(
            args,
            duration_sec=duration,
            on_progress=on_progress,
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        _safe_remove(tmp)
        return False, 'rerender timeout (>30 min)', path

    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:300]
        _safe_remove(tmp)
        return False, f'rerender: {err}', path
    if not os.path.isfile(tmp) or os.path.getsize(tmp) == 0:
        _safe_remove(tmp)
        return False, 'rerender: empty output', path
    try:
        os.replace(tmp, target)
    except OSError as exc:
        _safe_remove(tmp)
        return False, f'rerender: replace failed: {exc}', path

    if not is_mp4 and target != path:
        _safe_remove(path)
    return True, 'rerender cfr', target


def output_duration_acceptable(path: str, expected_sec: Optional[float]) -> bool:
    if expected_sec is None or expected_sec <= 0:
        return True
    actual = probe_duration_seconds(path)
    if actual is None:
        return True
    if actual > expected_sec + DURATION_TOLERANCE_SEC:
        log.warning(
            'clip output too long: %.2fs > expected %.2fs + %.1fs',
            actual,
            expected_sec,
            DURATION_TOLERANCE_SEC,
        )
        return False
    return True


def trim_media_to_duration(
    path: str,
    duration_sec: float,
    *,
    encode_mode: str = 'preserve',
) -> tuple[bool, str]:
    """
    Shorten output when the container duration exceeds the clip window.
    Fixes merged/single clips that show the first frame frozen for a few seconds at the end.
    """
    if duration_sec <= 0 or not os.path.isfile(path):
        return True, 'ok'
    actual = probe_duration_seconds(path)
    if actual is None or actual <= duration_sec + DURATION_TOLERANCE_SEC:
        return True, 'ok'

    tmp = f'{path}.trimtmp.mp4'
    base = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-i', path,
        '-t', f'{duration_sec:.3f}',
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-avoid_negative_ts', 'make_zero',
        '-shortest',
    ]

    def _try(cmd: list[str]) -> bool:
        proc = run_ffmpeg(cmd)
        if proc.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            os.replace(tmp, path)
            return True
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False

    if _try([*base, '-c', 'copy', '-movflags', '+faststart', tmp]):
        log.info('trimmed %s: %.2fs -> %.2fs (copy)', path, actual, duration_sec)
        return True, 'trim copy'

    # preserve promises untouched frames: a long container beats a re-encode.
    if encode_mode == 'exact':
        encode_cmd = [
            *base,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            tmp,
        ]
        if _try(encode_cmd):
            log.info('trimmed %s: %.2fs -> %.2fs (encode)', path, actual, duration_sec)
            return True, 'trim encode'

    err = f'container {actual:.2f}s > expected {duration_sec:.2f}s, trim failed'
    log.warning(err)
    return False, err


def clip_local_media_window(
    src_path: str,
    dest_path: str,
    start_in_file: float,
    duration_sec: float,
    *,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> tuple[bool, str]:
    """
    Frame-accurate trim of a remuxed local file.

    Browser HLS downloads whole segments. File t=0 is the first picked
    segment, not the playlist clock. start_in_file is clip_start minus
    that first-segment timeline.
    """
    if not os.path.isfile(src_path):
        return False, 'exact trim: missing remux'
    seek = max(0.0, float(start_in_file))
    dur = max(0.1, float(duration_sec))
    actual = probe_duration_seconds(src_path)
    if (
        actual is not None
        and seek <= 0.05
        and actual <= dur + DURATION_TOLERANCE_SEC
    ):
        if dest_path != src_path:
            shutil.copy2(src_path, dest_path)
        return True, 'ok (already exact)'

    seek_s = f'{seek:.3f}'
    dur_s = f'{dur:.3f}'
    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-fflags', '+genpts+discardcorrupt',
        '-i', src_path,
        '-vf', f'trim=start={seek_s}:duration={dur_s},setpts=PTS-STARTPTS',
        '-af', (
            f'atrim=start={seek_s}:duration={dur_s},asetpts=PTS-STARTPTS,'
            'aresample=async=1:first_pts=0'
        ),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        dest_path,
    ]
    try:
        proc = run_ffmpeg_serialized(
            args,
            duration_sec=dur,
            on_progress=on_progress,
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return False, 'exact trim timeout (>30 min)'
    if proc.returncode != 0 or not os.path.isfile(dest_path) or os.path.getsize(dest_path) < 4096:
        err = (proc.stderr or '').strip()[:300]
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except OSError:
                pass
        return False, f'exact trim failed: {err}'
    log.info(
        'exact trim %s: file_ss=%.3f dur=%.3f (src was %s)',
        dest_path,
        seek,
        dur,
        f'{actual:.2f}s' if actual is not None else 'unknown',
    )
    return True, 'ok (exact-trim)'


def concat_local_mp4s(
    paths: list[str],
    dest: str,
    *,
    allow_encode: bool = True,
    shortest: bool = False,
) -> tuple[bool, str]:
    """Concatenate local media files; stream copy first, optional re-encode fallback."""
    usable = [p for p in paths if p and os.path.isfile(p) and os.path.getsize(p) > 0]
    if not usable:
        return False, 'concat: no parts'
    if len(usable) == 1:
        if os.path.abspath(usable[0]) != os.path.abspath(dest):
            shutil.copy2(usable[0], dest)
        return True, 'ok (one part)'
    list_path = f'{dest}.concat.txt'
    with open(list_path, 'w', encoding='utf-8') as fh:
        for path in usable:
            escaped = path.replace('\\', '/').replace("'", "'\\''")
            fh.write(f"file '{escaped}'\n")
    tail = ['-shortest'] if shortest else []
    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', list_path,
        '-c', 'copy', *tail,
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        dest,
    ]
    try:
        proc = run_ffmpeg(args)
        if proc.returncode == 0 and os.path.isfile(dest) and os.path.getsize(dest) > 0:
            return True, 'ok (concat copy)'
        err = (proc.stderr or '').strip()[:300]
        if not allow_encode:
            return False, f'concat (copy) failed: {err}'
        retry = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-f', 'concat', '-safe', '0', '-i', list_path,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', *tail,
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            dest,
        ]
        proc = run_ffmpeg(retry)
        if proc.returncode != 0 or not os.path.isfile(dest) or os.path.getsize(dest) == 0:
            err2 = (proc.stderr or '').strip()[:300]
            return False, f'concat failed: {err2 or err}'
        return True, 'ok (concat encode)'
    finally:
        try:
            os.remove(list_path)
        except OSError:
            pass


def clip_hls_ffmpeg_native(
    media_url: str,
    headers: Optional[dict],
    start_sec: float,
    end_sec: float,
    end_eff: float,
    output_mp4: str,
) -> tuple[bool, str]:
    """
    ffmpeg demuxes HLS. Use input -ss (segment/keyframe) plus output -ss (fine cut)
    so the first seconds decode from a real keyframe, not orphaned P-frames.
    """
    clip_dur = max(end_eff - start_sec, 0.1)
    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        *ffmpeg_header_args(headers),
        *ffmpeg_http_input_extras(),
        '-allowed_extensions', 'ALL',
    ]
    if start_sec > 0.01:
        preroll = min(start_sec, DECODE_PREROLL_SEC)
        lead_in = max(0.0, start_sec - preroll)
        args.extend(['-ss', f'{lead_in:.3f}'])
    args.extend(['-i', media_url])
    if start_sec > 0.01:
        preroll = min(start_sec, DECODE_PREROLL_SEC)
        args.extend(['-ss', f'{preroll:.3f}'])
    if end_sec != float('inf'):
        args.extend(['-t', f'{clip_dur:.3f}'])
    elif start_sec <= 0.01:
        args.extend(['-to', f'{end_eff:.3f}'])
    args.extend([
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        output_mp4,
    ])
    log.info(
        'HLS native clip: %s start=%.2f dur=%.2f (preroll=%.2fs)',
        media_url[:96],
        start_sec,
        clip_dur,
        min(start_sec, DECODE_PREROLL_SEC) if start_sec > 0.01 else 0.0,
    )
    proc = run_ffmpeg(args)
    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:400]
        return False, f'ffmpeg-hls: {err}'
    if not os.path.isfile(output_mp4) or os.path.getsize(output_mp4) == 0:
        return False, 'ffmpeg-hls: no output'
    return True, 'ok (ffmpeg-hls)'


def clip_hls_ffmpeg_stream_copy(
    media_url: str,
    headers: Optional[dict],
    start_sec: float,
    end_sec: float,
    end_eff: float,
    output_mp4: str,
) -> tuple[bool, str]:
    """
    HLS clip with stream copy only (-ss before -i snaps to segment/keyframe).
    No libx264 — original compressed pixels are kept (forensic / Oxco).
    """
    clip_dur = max(end_eff - start_sec, 0.1)
    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        *ffmpeg_header_args(headers),
        *ffmpeg_http_input_extras(),
        '-allowed_extensions', 'ALL',
    ]
    if start_sec > 0.01:
        args.extend(['-ss', f'{start_sec:.3f}'])
    args.extend(['-i', media_url])
    if end_sec != float('inf'):
        args.extend(['-t', f'{clip_dur:.3f}'])
    elif start_sec <= 0.01:
        args.extend(['-to', f'{end_eff:.3f}'])
    args.extend([
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        output_mp4,
    ])
    log.info(
        'HLS stream copy: %s start=%.2f dur=%.2f',
        media_url[:96],
        start_sec,
        clip_dur,
    )
    proc = run_ffmpeg_copy(args)
    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:400]
        return False, f'ffmpeg-copy: {err}'
    if not os.path.isfile(output_mp4) or os.path.getsize(output_mp4) == 0:
        return False, 'ffmpeg-copy: no output'
    return True, 'ok (copy-ffmpeg)'


def remux_browser_payload(src_path: str, out_mp4: str) -> tuple[bool, str]:
    """Remux a browser-downloaded MPEG-TS (or MP4) blob to a playable MP4."""
    if not src_path or not os.path.isfile(src_path):
        return False, 'browser ingest: empty payload'
    head = b''
    with open(src_path, 'rb') as fh:
        head = fh.read(64)
    looks_mp4 = b'ftyp' in head[:64]
    args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-fflags', '+genpts+discardcorrupt',
    ]
    if not looks_mp4:
        args.extend(['-f', 'mpegts'])
    args.extend([
        '-i', src_path,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        out_mp4,
    ])
    proc = run_ffmpeg(args)
    if proc.returncode != 0:
        retry = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts+discardcorrupt',
            '-i', src_path,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            out_mp4,
        ]
        proc = run_ffmpeg(retry)
        if proc.returncode != 0:
            err = (proc.stderr or '').strip()[:300]
            return False, f'browser remux failed: {err}'
    if not os.path.isfile(out_mp4) or os.path.getsize(out_mp4) < 4096:
        return False, 'browser remux produced no output'
    return True, 'ok (browser-hls)'


def remux_concat_copy_only(
    concat_list_path: str,
    out_mp4: str,
    *,
    duration_sec: float = 0.0,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> tuple[bool, str]:
    copy_args = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-fflags', '+genpts+discardcorrupt',
        '-f', 'concat', '-safe', '0', '-i', concat_list_path,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        out_mp4,
    ]
    try:
        proc = run_ffmpeg_copy(
            copy_args,
            run=run_ffmpeg_serialized,
            duration_sec=duration_sec,
            on_progress=on_progress,
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return False, 'ffmpeg copy remux timeout (>30 min)'
    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:300]
        return False, f'ffmpeg copy remux failed: {err}'
    if not os.path.isfile(out_mp4) or os.path.getsize(out_mp4) == 0:
        return False, 'ffmpeg copy remux produced no output'
    return True, 'ok (copy-segments)'


def effective_preserve_window(
    picked: list[MediaSegment],
) -> tuple[float, float]:
    if not picked:
        return 0.0, 0.0
    start = picked[0].timeline_start
    end = picked[-1].timeline_start + picked[-1].duration
    return start, end


def remux_concat_demuxer(
    concat_list_path: str,
    out_mp4: str,
    *,
    seek: float,
    duration: Optional[float],
    encode_mode: str = 'exact',
    duration_sec: float = 0.0,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> tuple[bool, str]:
    progress_duration = duration_sec or (duration or 0.0)
    if duration is None:
        ok, err = remux_concat_copy_only(
            concat_list_path,
            out_mp4,
            duration_sec=progress_duration,
            on_progress=on_progress,
        )
        if ok:
            return True, err
        if encode_mode == 'preserve':
            return False, err
        encode_args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts+discardcorrupt',
            '-f', 'concat', '-safe', '0', '-i', concat_list_path,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0',
            '-shortest',
            '-movflags', '+faststart', out_mp4,
        ]
        try:
            proc = run_ffmpeg_serialized(
                encode_args,
                duration_sec=progress_duration,
                on_progress=on_progress,
                timeout=1800,
            )
        except subprocess.TimeoutExpired:
            return False, 'ffmpeg concat timeout (>30 min)'
    elif encode_mode == 'preserve':
        return False, 'preserve mode cannot trim partial segments; use segment boundaries'
    else:
        seek_s = f'{seek:.3f}'
        dur_s = f'{duration:.3f}'
        # Decode full concat (incl. preroll segments), trim to exact window.
        encode_args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts+discardcorrupt',
            '-f', 'concat', '-safe', '0', '-i', concat_list_path,
            '-vf', f'trim=start={seek_s}:duration={dur_s},setpts=PTS-STARTPTS',
            '-af', (
                f'atrim=start={seek_s}:duration={dur_s},asetpts=PTS-STARTPTS,'
                'aresample=async=1:first_pts=0'
            ),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart', out_mp4,
        ]
        try:
            proc = run_ffmpeg_serialized(
                encode_args,
                duration_sec=progress_duration or duration,
                on_progress=on_progress,
                timeout=1800,
            )
        except subprocess.TimeoutExpired:
            return False, 'ffmpeg concat timeout (>30 min)'

    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:300]
        return False, f'ffmpeg concat failed: {err}'
    if not os.path.isfile(out_mp4) or os.path.getsize(out_mp4) == 0:
        return False, 'ffmpeg concat produced no output'
    return True, 'ok (segments)'


class _PreflightRejected(Exception):
    """A segment is not media (HTML error page, missing init…): no fallback helps."""


def _download_segments_to_list(
    fetcher: HttpFetcher,
    picked: list[MediaSegment],
    parts_dir: str,
    progress: Optional[Callable[[dict], None]],
    progress_base: float,
    progress_scale: float,
) -> tuple[Optional[str], list[str]]:
    total = len(picked)
    bytes_done = 0
    t0 = time.monotonic()
    if progress:
        progress(build_progress_event(
            fraction=progress_base,
            msg=f'Segments 0/{total}…',
        ))

    # fMP4 fragments are not standalone files: init + fragments go into one
    # fragmented MP4 per (init, discontinuity) run, like a player would buffer.
    segment_paths: list[str] = []
    fmp4 = None
    fmp4_group: Optional[tuple[InitSection, int]] = None
    try:
        for index, seg in enumerate(picked):
            chunk = fetch_segment_bytes(fetcher, seg)
            kind = classify_media_bytes(chunk[:PREFIX_SCAN_BYTES * 2])
            # Tokens expire mid-download too: an HTML/JSON page for segment N
            # must stop here with advice, not surface as "ffmpeg concat failed".
            problem = preflight_problem(kind, seg.init is not None)
            if problem:
                diagnostics.note('segment_rejected', index=index, total=total, media=kind, url=seg.uri)
                raise _PreflightRejected(
                    f'{problem} (Segment {index + 1}/{total} — Zugang während des Downloads abgelaufen?)',
                )
            if seg.init is not None:
                group = (seg.init, seg.discontinuity)
                if group != fmp4_group:
                    if fmp4:
                        fmp4.close()
                    path = os.path.join(parts_dir, f'part_{len(segment_paths):04d}.mp4')
                    fmp4 = open(path, 'wb')
                    fmp4.write(fetch_init_bytes(fetcher, seg.init))
                    segment_paths.append(path)
                    fmp4_group = group
                fmp4.write(chunk)
            else:
                if fmp4:
                    fmp4.close()
                    fmp4, fmp4_group = None, None
                ext = kind if kind in ('aac', 'mp3') else 'ts'
                if ext == 'ts':
                    chunk = align_transport_stream(chunk)
                part_path = os.path.join(parts_dir, f'seg_{index:04d}.{ext}')
                with open(part_path, 'wb') as fh:
                    fh.write(chunk)
                segment_paths.append(part_path)
            bytes_done += len(chunk)
            _report_segment_progress(
                progress, index, total, bytes_done, t0, progress_base, progress_scale,
            )
    finally:
        if fmp4:
            fmp4.close()

    list_path = os.path.join(parts_dir, 'concat.txt')
    with open(list_path, 'w', encoding='utf-8') as fh:
        for path in segment_paths:
            escaped = path.replace('\\', '/').replace("'", "'\\''")
            fh.write(f"file '{escaped}'\n")
    return list_path, segment_paths


def _report_segment_progress(
    progress: Optional[Callable[[dict], None]],
    index: int,
    total: int,
    bytes_done: int,
    t0: float,
    progress_base: float,
    progress_scale: float,
) -> None:
    if not progress:
        return
    elapsed = time.monotonic() - t0
    speed = bytes_done / max(elapsed, 0.25)
    dl_frac = ((index + 1) / total) * (1.0 - ENCODE_SHARE_OF_PROGRESS)
    overall = progress_base + progress_scale * max(0.0, min(1.0, dl_frac))
    eta = (max(total * BYTES_PER_SEGMENT_GUESS - bytes_done, 0) / speed) if speed > 0 else None
    progress(build_progress_event(
        fraction=overall,
        msg=f'Segments {index + 1}/{total}',
        speed=speed,
        eta=eta,
    ))


def clip_hls_preserve_copy(
    fetcher: HttpFetcher,
    picked: list[MediaSegment],
    raw_ts_path: str,
    output_mp4: str,
    progress: Optional[Callable[[dict], None]] = None,
    progress_base: float = 0.0,
    progress_scale: float = 1.0,
) -> tuple[bool, str]:
    """Download whole TS segments and remux with stream copy (forensic / pixel-stable)."""
    parts_dir = os.path.splitext(raw_ts_path)[0] + '_parts'
    shutil.rmtree(parts_dir, ignore_errors=True)
    os.makedirs(parts_dir, exist_ok=True)
    try:
        list_path, _paths = _download_segments_to_list(
            fetcher, picked, parts_dir, progress, progress_base, progress_scale,
        )
        if not list_path:
            return False, 'no segments downloaded'
        encode_start = 1.0 - ENCODE_SHARE_OF_PROGRESS
        remux_duration = sum(max(seg.duration, 0.1) for seg in picked)

        def remux_progress(frac: float, detail: str) -> None:
            if not progress:
                return
            overall = encode_start + ENCODE_SHARE_OF_PROGRESS * max(0.0, min(frac, 1.0))
            progress(build_progress_event(
                fraction=progress_base + progress_scale * overall,
                msg=f'Remuxing (copy)… ({detail})',
            ))

        if progress:
            remux_progress(0.0, 'start')
        ok, err = remux_concat_copy_only(
            list_path,
            output_mp4,
            duration_sec=remux_duration,
            on_progress=remux_progress,
        )
        if ok and progress:
            progress(build_progress_event(fraction=progress_base + progress_scale, msg='Done'))
        return ok, err
    except _PreflightRejected:
        raise
    except RuntimeError as exc:
        return False, str(exc)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            return False, (
                'CDN limitiert Anfragen (429) — 1–2 Minuten warten, '
                'dann erneut senden (nur ein Job gleichzeitig)'
            )
        return False, f'preserve copy failed: HTTP {exc.code}'
    except Exception as exc:
        return False, f'preserve copy failed: {exc}'
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


def clip_hls_segment_fallback(
    fetcher: HttpFetcher,
    parsed: ParsedPlaylist,
    picked: list[MediaSegment],
    *,
    start_sec: float,
    end_sec: float,
    end_eff: float,
    raw_ts_path: str,
    output_mp4: str,
    progress: Optional[Callable[[dict], None]],
    progress_base: float,
    progress_scale: float,
    encode_mode: str = 'exact',
) -> tuple[bool, str]:
    def report(frac: float, message: str, speed: float = 0.0, eta: Optional[float] = None) -> None:
        if not progress:
            return
        overall = progress_base + progress_scale * max(0.0, min(1.0, frac))
        progress(build_progress_event(fraction=overall, msg=message, speed=speed, eta=eta))

    full_span = start_sec <= 0.01 and end_eff >= parsed.duration - 0.5
    parts_dir = os.path.splitext(raw_ts_path)[0] + '_parts'
    shutil.rmtree(parts_dir, ignore_errors=True)
    os.makedirs(parts_dir, exist_ok=True)

    try:
        list_path, _segment_paths = _download_segments_to_list(
            fetcher,
            picked,
            parts_dir,
            progress,
            progress_base,
            progress_scale,
        )
        if not list_path:
            return False, 'no segments downloaded'

        clip_len = max(end_eff - start_sec, 1.0) if not full_span else max(parsed.duration, 1.0)
        encode_start = 1.0 - ENCODE_SHARE_OF_PROGRESS
        encode_duration = sum(max(seg.duration, 0.1) for seg in picked) or clip_len

        def encode_progress(frac: float, detail: str) -> None:
            report(
                encode_start + ENCODE_SHARE_OF_PROGRESS * max(0.0, min(frac, 1.0)),
                f'Encoding… ({detail})',
            )

        encode_progress(0.0, 'start')

        if full_span:
            ok, err = remux_concat_demuxer(
                list_path, output_mp4, seek=0.0, duration=None, encode_mode=encode_mode,
                duration_sec=encode_duration,
                on_progress=encode_progress,
            )
        else:
            seek = max(0.0, start_sec - picked[0].timeline_start)
            ok, err = remux_concat_demuxer(
                list_path,
                output_mp4,
                seek=seek,
                duration=end_eff - start_sec,
                encode_mode=encode_mode,
                duration_sec=clip_len,
                on_progress=encode_progress,
            )
        if ok:
            report(1.0, 'Done')
            if not full_span:
                trim_media_to_duration(
                    output_mp4,
                    max(end_eff - start_sec, 0.1),
                    encode_mode=encode_mode,
                )
        return ok, err
    except _PreflightRejected:
        raise
    except Exception as exc:
        return False, f'segment download failed: {exc}'
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


def _output_covers_expected(path: str, expected_sec: float, *, min_ratio: float = 0.85) -> bool:
    """Reject truncated HLS downloads (e.g. only the first ~7s segment)."""
    if expected_sec <= 0:
        return True
    # Short clips: keep the absolute tolerance used elsewhere.
    if expected_sec <= 15:
        return output_duration_acceptable(path, expected_sec)
    actual = probe_duration_seconds(path)
    if actual is None:
        return True
    if actual + DURATION_TOLERANCE_SEC < expected_sec * min_ratio:
        log.warning(
            'HLS output too short: %.2fs < %.0f%% of expected %.2fs',
            actual,
            min_ratio * 100,
            expected_sec,
        )
        return False
    return True


def clip_hls_to_file(
    playlist_url: str,
    headers: Optional[dict],
    start_sec: float,
    end_sec: float,
    raw_ts_path: str,
    output_mp4: str,
    progress: Optional[Callable[[dict], None]] = None,
    progress_base: float = 0.0,
    progress_scale: float = 1.0,
    encode_mode: str = 'preserve',
) -> tuple[bool, str]:
    def report(frac: float, message: str, speed: float = 0.0, eta: Optional[float] = None) -> None:
        if not progress:
            return
        overall = progress_base + progress_scale * max(0.0, min(1.0, frac))
        progress(build_progress_event(fraction=overall, msg=message, speed=speed, eta=eta))

    mode = encode_mode if encode_mode in ('preserve', 'exact') else 'preserve'

    # Resolve master → media playlist first so signed query params (t/s/e/…)
    # are inherited onto the variant URL before ffmpeg/segment fetches.
    report(0.02, 'HLS: loading playlist…')
    try:
        media_url, parsed, fetcher = resolve_hls_playlist(playlist_url, headers)
    except Exception as exc:
        return False, _format_playlist_error(exc, headers)

    diagnostics.note(
        'media_playlist',
        url=media_url,
        segments=len(parsed.segments),
        duration=round(parsed.duration, 2),
        fmp4=bool(parsed.init_uri),
        byterange=any(s.byterange for s in parsed.segments[:5]),
        key=parsed.key_method,
        discontinuities=parsed.segments[-1].discontinuity if parsed.segments else 0,
        audio_rendition=bool(parsed.audio_url),
        header_names=fetcher.header_names,
    )
    if parsed.encrypted:
        return False, (
            f'Stream ist mit {parsed.key_method or "DRM"} verschlüsselt — '
            'nur AES-128 wird unterstützt, DRM-Streams lassen sich nicht schneiden'
        )
    if not parsed.segments:
        return False, 'empty media playlist'
    if not _playlist_segments_look_valid(parsed):
        if _needs_turboviplay_cookies(playlist_url) and not _cookie_header_present(headers):
            return False, (
                'Keine Browser-Cookies beim Server angekommen — '
                'Extension auf 1.3.10+ aktualisieren (Neu laden), Video abspielen, erneut senden'
            )
        first = parsed.segments[0].uri[:120] if parsed.segments else ''
        return False, (
            'CDN lieferte keine echten Video-Segmente — '
            f'Video im Tab abspielen, Extension neu laden, erneut senden'
            + (f' (erstes Segment: {first})' if first else '')
        )

    if not parsed.audio_url:
        ok, msg, _ = _clip_rendition(
            media_url, parsed, fetcher, headers, start_sec, end_sec,
            raw_ts_path, output_mp4, progress, progress_base, progress_scale, mode,
        )
        return ok, msg
    return _clip_with_audio_rendition(
        media_url, parsed, fetcher, headers, start_sec, end_sec,
        raw_ts_path, output_mp4, progress, progress_base, progress_scale, mode,
    )


def _preflight_first_segment(fetcher: HttpFetcher, seg: MediaSegment) -> None:
    chunk = fetch_segment_bytes(fetcher, seg)
    kind = classify_media_bytes(chunk)
    diagnostics.note(
        'preflight', media=kind, bytes=len(chunk), has_init=seg.init is not None,
        head=chunk[:16].hex(),
    )
    problem = preflight_problem(kind, seg.init is not None)
    if problem:
        raise _PreflightRejected(problem)
    fetcher.prefetched[seg] = chunk


def _clip_rendition(
    media_url: str,
    parsed: ParsedPlaylist,
    fetcher: HttpFetcher,
    headers: Optional[dict],
    start_sec: float,
    end_sec: float,
    raw_ts_path: str,
    output_mp4: str,
    progress: Optional[Callable[[dict], None]],
    progress_base: float,
    progress_scale: float,
    mode: str,
) -> tuple[bool, str, float]:
    """Clip one media playlist. Returns (ok, message, timeline start of the output)."""
    def report(frac: float, message: str) -> None:
        if progress:
            overall = progress_base + progress_scale * max(0.0, min(1.0, frac))
            progress(build_progress_event(fraction=overall, msg=message))

    end_eff = end_sec if end_sec != float('inf') else parsed.duration
    if parsed.duration > 0:
        # A typed end past the stream end must not make a correct clip "too short".
        end_eff = min(end_eff, parsed.duration)
    expected_span = max(end_eff - start_sec, 0.1)
    too_short = (
        lambda expected: f'nur {probe_duration_seconds(output_mp4) or 0:.1f}s von '
        f'~{expected:.0f}s geladen — CDN-Token/Query prüfen, Video abspielen, erneut senden'
    )

    if mode == 'preserve':
        picked = segments_for_window_preserve(parsed, start_sec, end_sec)
    else:
        picked = segments_for_window(parsed, start_sec, end_sec)
    if not picked:
        return False, 'no segments in time window', start_sec
    full_span = start_sec <= 0.01 and end_eff >= parsed.duration - 0.5
    if mode == 'exact' and not full_span:
        picked = segments_with_preroll(parsed, picked)

    # Segments via Python first: it handles fMP4 init, byte ranges, AES-128 and
    # CDNs that reject ffmpeg's HTTP client (phncdn answers ffmpeg with 410).
    segment_error = ''
    try:
        _preflight_first_segment(fetcher, picked[0])
    except _PreflightRejected as exc:
        return False, str(exc), start_sec
    except JobCancelled:
        raise
    except Exception as exc:
        segment_error = f'segment download failed: {exc}'

    try:
        if not segment_error and mode == 'preserve':
            eff_start, eff_end = effective_preserve_window(picked)
            report(0.08, f'HLS: segment copy (preserve, ~{eff_start:.1f}–{eff_end:.1f}s)…')
            ok, err = clip_hls_preserve_copy(
                fetcher, picked, raw_ts_path, output_mp4,
                progress=progress, progress_base=progress_base, progress_scale=progress_scale,
            )
            if ok:
                expected = max(eff_end - eff_start, 0.1)
                trim_media_to_duration(output_mp4, expected, encode_mode=mode)
                if not _output_covers_expected(output_mp4, expected):
                    return False, too_short(expected), eff_start
                report(1.0, 'Done')
                return True, err, eff_start
            segment_error = err
        elif not segment_error:
            ok, err = clip_hls_segment_fallback(
                fetcher, parsed, picked,
                start_sec=start_sec, end_sec=end_sec, end_eff=end_eff,
                raw_ts_path=raw_ts_path, output_mp4=output_mp4,
                progress=progress, progress_base=progress_base, progress_scale=progress_scale,
                encode_mode='exact',
            )
            if ok:
                if not _output_covers_expected(output_mp4, expected_span):
                    return False, too_short(expected_span), start_sec
                return True, err, start_sec
            segment_error = err
    except _PreflightRejected as exc:
        # The CDN answered a later segment with a page: ffmpeg would get the same.
        return False, str(exc), start_sec

    fetcher.prefetched.clear()
    diagnostics.note('attempt', path='segments', ok=False, error=segment_error)
    if any(s.byterange or s.key for s in picked[:3]) or len({s.init for s in picked}) > 1:
        return False, segment_error, start_sec

    log.info('HLS segment path failed (%s) — trying direct ffmpeg', segment_error[:200])
    report(0.5, 'HLS: Segmente abgelehnt, versuche ffmpeg direkt…')
    _remove_quiet(output_mp4)
    clip = clip_hls_ffmpeg_stream_copy if mode == 'preserve' else clip_hls_ffmpeg_native
    ok_direct, err_direct = clip(
        media_url, headers, start_sec, end_sec,
        end_eff if end_eff != float('inf') else 1e7, output_mp4,
    )
    diagnostics.note('attempt', path='ffmpeg-direct', ok=ok_direct, error='' if ok_direct else err_direct)
    if ok_direct and _output_usable(output_mp4) and _output_covers_expected(output_mp4, expected_span):
        if end_sec != float('inf'):
            trim_media_to_duration(output_mp4, expected_span, encode_mode=mode)
        report(1.0, 'Done')
        return True, err_direct, start_sec
    _remove_quiet(output_mp4)
    return False, f'{segment_error} | {err_direct if not ok_direct else too_short(expected_span)}', start_sec


def mux_video_audio(video_mp4: str, audio_mp4: str, output_mp4: str, audio_offset: float) -> tuple[bool, str]:
    """Video of the first file + audio of the second; audio_offset = audio start − video start.

    Audio segment boundaries rarely match video ones, so the result is cut to the video length.
    """
    args = ['ffmpeg', '-y', '-loglevel', 'error', '-i', video_mp4]
    # Audio that starts early is dropped, not shifted below zero: an edit list
    # would hide it, but concat of merge parts ignores edit lists.
    if audio_offset < -0.01:
        args += ['-ss', f'{-audio_offset:.3f}']
    elif audio_offset > 0.01:
        args += ['-itsoffset', f'{audio_offset:.3f}']
    args += ['-i', audio_mp4, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy']
    video_duration = probe_duration_seconds(video_mp4)
    if video_duration:
        args += ['-t', f'{video_duration:.3f}']
    args += ['-movflags', '+faststart', output_mp4]
    proc = run_ffmpeg(args)
    if proc.returncode != 0 or not _output_usable(output_mp4):
        return False, f'Video+Ton zusammenführen fehlgeschlagen: {(proc.stderr or "").strip()[:300]}'
    return True, 'ok (video+audio)'


def _clip_with_audio_rendition(
    media_url: str,
    parsed: ParsedPlaylist,
    fetcher: HttpFetcher,
    headers: Optional[dict],
    start_sec: float,
    end_sec: float,
    raw_ts_path: str,
    output_mp4: str,
    progress: Optional[Callable[[dict], None]],
    progress_base: float,
    progress_scale: float,
    mode: str,
) -> tuple[bool, str]:
    """Video and audio come from separate playlists: clip both, then mux."""
    stem = os.path.splitext(output_mp4)[0]
    video_tmp, audio_tmp = f'{stem}.video.mp4', f'{stem}.audio.mp4'
    try:
        # Audio playlist first: a DRM'd or empty rendition must not cost a video download.
        try:
            audio_url, audio_parsed = _fetch_resolved_media_playlist(fetcher, parsed.audio_url or '')
        except JobCancelled:
            raise
        except Exception as exc:
            return False, f'Tonspur-Playlist nicht ladbar: {exc}'
        if audio_parsed.encrypted:
            return False, (
                f'Tonspur ist mit {audio_parsed.key_method or "DRM"} verschlüsselt — '
                'nur AES-128 wird unterstützt'
            )
        if not audio_parsed.segments:
            return False, 'Tonspur: empty media playlist'
        ok, msg, video_start = _clip_rendition(
            media_url, parsed, fetcher, headers, start_sec, end_sec,
            raw_ts_path, video_tmp, progress, progress_base, progress_scale * 0.75, mode,
        )
        if not ok:
            return False, msg
        ok, audio_msg, audio_start = _clip_rendition(
            audio_url, audio_parsed, fetcher, headers, start_sec, end_sec,
            os.path.splitext(raw_ts_path)[0] + '_audio.ts', audio_tmp,
            progress, progress_base + progress_scale * 0.75, progress_scale * 0.2, mode,
        )
        if not ok:
            return False, f'Tonspur: {audio_msg}'
        ok, mux_msg = mux_video_audio(video_tmp, audio_tmp, output_mp4, audio_start - video_start)
        if not ok:
            return False, mux_msg
        if progress:
            progress(build_progress_event(fraction=progress_base + progress_scale, msg='Done'))
        return True, f'{msg} + separate audio'
    finally:
        _remove_quiet(video_tmp)
        _remove_quiet(audio_tmp)


def smart_clip_hls(
    url: str,
    headers: Optional[dict],
    start: float,
    end: float,
    raw_ts_path: str,
    out_path: str,
    progress: Optional[Callable[[dict], None]] = None,
    progress_base: float = 0.0,
    progress_scale: float = 1.0,
    encode_mode: str = 'preserve',
) -> tuple[bool, str]:
    """Stable entry point for downloader.py."""
    return clip_hls_to_file(
        url,
        headers,
        start,
        end,
        raw_ts_path,
        out_path,
        progress=progress,
        progress_base=progress_base,
        progress_scale=progress_scale,
        encode_mode=encode_mode,
    )
