"""
HLS time-range clipper (clean-room).

Primary path: ffmpeg reads the media playlist directly (-ss / -to on the HLS
timeline). Fallback: download TS segments + ffmpeg concat demuxer + cut.
Spec: docs/BEHAVIOR.md
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

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


@dataclass(frozen=True)
class MediaSegment:
    timeline_start: float
    duration: float
    uri: str


@dataclass
class ParsedPlaylist:
    segments: list[MediaSegment]
    duration: float
    encrypted: bool


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

    def get_text(self, url: str) -> str:
        return self.get_bytes(url).decode('utf-8', 'ignore')

    def _throttle(self) -> None:
        if self._segment_delay <= 0:
            return
        elapsed = time.monotonic() - self._last_fetch_at
        if elapsed < self._segment_delay:
            time.sleep(self._segment_delay - elapsed)

    def _retry_wait(self, attempt: int, exc: urllib.error.HTTPError) -> float:
        retry_after = exc.headers.get('Retry-After') if exc.headers else None
        if retry_after:
            try:
                return min(max(float(retry_after), 1.0), 60.0)
            except ValueError:
                pass
        return min(SEGMENT_FETCH_RETRY_BASE_SEC * (2 ** attempt), 45.0)

    def get_bytes(self, url: str) -> bytes:
        last_exc: Optional[BaseException] = None
        for attempt in range(SEGMENT_FETCH_RETRY_MAX):
            self._throttle()
            try:
                req = urllib.request.Request(url, headers=self._headers)
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    data = resp.read()
                self._last_fetch_at = time.monotonic()
                return data
            except urllib.error.HTTPError as exc:
                last_exc = exc
                if exc.code not in (429, 502, 503) or attempt >= SEGMENT_FETCH_RETRY_MAX - 1:
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
            except Exception as exc:
                last_exc = exc
                raise
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


def resolve_master_playlist(text: str, base_url: str) -> Optional[str]:
    best_uri: Optional[str] = None
    best_bw = -1
    pending_bw: Optional[int] = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('#EXT-X-STREAM-INF'):
            match = re.search(r'BANDWIDTH=(\d+)', stripped)
            pending_bw = int(match.group(1)) if match else 0
        elif stripped and not stripped.startswith('#'):
            if pending_bw is not None and pending_bw > best_bw:
                best_bw = pending_bw
                best_uri = urllib.parse.urljoin(base_url, stripped)
            pending_bw = None
    return best_uri


def parse_media_playlist(text: str, base_url: str) -> ParsedPlaylist:
    segments: list[MediaSegment] = []
    timeline = 0.0
    pending_duration: Optional[float] = None
    encrypted = False

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('#EXT-X-KEY') and 'METHOD=NONE' not in stripped.upper():
            encrypted = True
        elif stripped.startswith('#EXTINF:'):
            try:
                pending_duration = float(stripped[len('#EXTINF:'):].split(',')[0])
            except ValueError:
                pending_duration = 0.0
        elif stripped and not stripped.startswith('#'):
            duration = pending_duration or 0.0
            segments.append(
                MediaSegment(
                    timeline_start=timeline,
                    duration=duration,
                    uri=urllib.parse.urljoin(base_url, stripped),
                ),
            )
            timeline += duration
            pending_duration = None

    return ParsedPlaylist(segments=segments, duration=timeline, encrypted=encrypted)


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
    body = fetcher.get_text(playlist_url)
    media_url = playlist_url
    if '#EXT-X-STREAM-INF' in body:
        variant = resolve_master_playlist(body, playlist_url)
        if not variant:
            raise ValueError('no variant in master playlist')
        return _fetch_resolved_media_playlist(fetcher, variant, depth + 1)
    parsed = parse_media_playlist(body, media_url)
    if parsed.segments:
        sample = parsed.segments[: min(3, len(parsed.segments))]
        if all(_segment_uri_looks_like_playlist(seg.uri) for seg in sample):
            return _fetch_resolved_media_playlist(fetcher, sample[0].uri, depth + 1)
    return media_url, parsed


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
        if candidate.uri == seg.uri and abs(candidate.timeline_start - seg.timeline_start) < 0.02:
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
    if preroll and preroll[-1].uri == picked[0].uri:
        return picked
    return [*preroll, *picked]


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True)


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

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
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

    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()

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

    stderr = proc.stderr.read() if proc.stderr else ''
    proc.wait(timeout=5)
    return subprocess.CompletedProcess(cmd, proc.returncode if proc.returncode is not None else 1, '', stderr)


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


def normalize_http_headers(headers: Optional[dict]) -> dict:
    merged = dict(headers or {})
    merged.setdefault('User-Agent', DEFAULT_USER_AGENT)
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
    proc = subprocess.run(
        [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            path,
        ],
        capture_output=True,
        text=True,
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
    proc = run_ffmpeg(args)
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
    proc = subprocess.run(
        [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            path,
        ],
        capture_output=True,
        text=True,
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
        proc = run_ffmpeg_with_progress(
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

    if encode_mode == 'exact' or encode_mode == 'preserve':
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
    proc = run_ffmpeg(args)
    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:400]
        return False, f'ffmpeg-copy: {err}'
    if not os.path.isfile(output_mp4) or os.path.getsize(output_mp4) == 0:
        return False, 'ffmpeg-copy: no output'
    return True, 'ok (copy-ffmpeg)'


def remux_concat_copy_only(concat_list_path: str, out_mp4: str) -> tuple[bool, str]:
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
    proc = run_ffmpeg(copy_args)
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
) -> tuple[bool, str]:
    if duration is None:
        ok, err = remux_concat_copy_only(concat_list_path, out_mp4)
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
        proc = run_ffmpeg(encode_args)
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
        proc = run_ffmpeg(encode_args)

    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:300]
        return False, f'ffmpeg concat failed: {err}'
    if not os.path.isfile(out_mp4) or os.path.getsize(out_mp4) == 0:
        return False, 'ffmpeg concat produced no output'
    return True, 'ok (segments)'


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

    segment_paths: list[str] = []
    for index, seg in enumerate(picked):
        part_path = os.path.join(parts_dir, f'seg_{index:04d}.ts')
        chunk = align_transport_stream(fetcher.get_bytes(seg.uri))
        with open(part_path, 'wb') as fh:
            fh.write(chunk)
        segment_paths.append(part_path)
        bytes_done += len(chunk)
        if progress:
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

    list_path = os.path.join(parts_dir, 'concat.txt')
    with open(list_path, 'w', encoding='utf-8') as fh:
        for path in segment_paths:
            escaped = path.replace('\\', '/').replace("'", "'\\''")
            fh.write(f"file '{escaped}'\n")
    return list_path, segment_paths


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
        if progress:
            progress(build_progress_event(
                fraction=progress_base + progress_scale * (1.0 - ENCODE_SHARE_OF_PROGRESS),
                msg='Remuxing (copy)…',
            ))
        ok, err = remux_concat_copy_only(list_path, output_mp4)
        if ok and progress:
            progress(build_progress_event(fraction=progress_base + progress_scale, msg='Done'))
        return ok, err
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
        report(1.0 - ENCODE_SHARE_OF_PROGRESS, 'Encoding…', eta=clip_len * 0.45)

        if full_span:
            ok, err = remux_concat_demuxer(
                list_path, output_mp4, seek=0.0, duration=None, encode_mode=encode_mode,
            )
        else:
            seek = max(0.0, start_sec - picked[0].timeline_start)
            ok, err = remux_concat_demuxer(
                list_path,
                output_mp4,
                seek=seek,
                duration=end_eff - start_sec,
                encode_mode=encode_mode,
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
    except Exception as exc:
        return False, f'segment download failed: {exc}'
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


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

    report(0.02, 'HLS: direct ffmpeg…')
    if mode == 'preserve':
        ok_direct, err_direct = clip_hls_ffmpeg_stream_copy(
            playlist_url,
            headers,
            start_sec,
            end_sec,
            end_sec if end_sec != float('inf') else 1e7,
            output_mp4,
        )
    else:
        ok_direct, err_direct = clip_hls_ffmpeg_native(
            playlist_url,
            headers,
            start_sec,
            end_sec,
            end_sec if end_sec != float('inf') else 1e7,
            output_mp4,
        )
    if ok_direct and _output_usable(output_mp4):
        if end_sec != float('inf'):
            trim_media_to_duration(
                output_mp4,
                max(end_sec - start_sec, 0.1),
                encode_mode=mode,
            )
        report(1.0, 'Done')
        return True, err_direct
    if ok_direct:
        try:
            os.remove(output_mp4)
        except OSError:
            pass
    log.info('HLS direct ffmpeg did not produce output (%s), parsing playlist', err_direct)

    try:
        media_url, parsed, fetcher = resolve_hls_playlist(playlist_url, headers)
    except Exception as exc:
        hint = (
            'CDN blockiert ohne Browser-Cookies — Video im Tab 20s abspielen, '
            'dann erneut senden'
        )
        return False, f'{exc} ({hint})'

    if parsed.encrypted:
        return False, 'encrypted HLS (EXT-X-KEY) is not supported'
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

    end_eff = end_sec if end_sec != float('inf') else parsed.duration
    if mode == 'preserve':
        picked = segments_for_window_preserve(parsed, start_sec, end_sec)
        if not picked:
            return False, 'no segments in time window'
        eff_start, eff_end = effective_preserve_window(picked)
        report(0.05, f'HLS: stream copy (preserve, ~{eff_start:.1f}–{eff_end:.1f}s)…')
        ok, err = clip_hls_ffmpeg_stream_copy(
            media_url, headers, start_sec, end_sec, end_eff, output_mp4,
        )
        if ok:
            expected = max(end_eff - start_sec, 0.1)
            trim_media_to_duration(output_mp4, expected, encode_mode=mode)
            report(1.0, 'Done')
            return True, err
        log.warning('HLS stream copy failed (%s), trying segment copy', err)
        report(0.08, 'HLS: segment copy fallback…')
        ok, err = clip_hls_preserve_copy(
            fetcher,
            picked,
            raw_ts_path,
            output_mp4,
            progress=progress,
            progress_base=progress_base,
            progress_scale=progress_scale,
        )
        if ok:
            expected = max(eff_end - eff_start, 0.1)
            trim_media_to_duration(output_mp4, expected, encode_mode=mode)
            report(1.0, 'Done')
        return ok, err

    picked = segments_for_window(parsed, start_sec, end_sec)
    if not picked:
        return False, 'no segments in time window'

    full_span = start_sec <= 0.01 and end_eff >= parsed.duration - 0.5
    expected_duration = None if full_span else max(end_eff - start_sec, 0.1)

    if not full_span:
        report(0.05, 'HLS: cutting with ffmpeg…', eta=expected_duration * 0.6 if expected_duration else None)
        ok, err = clip_hls_ffmpeg_native(
            media_url, headers, start_sec, end_sec, end_eff, output_mp4,
        )
        if ok and output_duration_acceptable(output_mp4, expected_duration):
            trim_media_to_duration(
                output_mp4,
                expected_duration,
                encode_mode='exact',
            )
            report(1.0, 'Done')
            return True, err
        if ok:
            try:
                os.remove(output_mp4)
            except OSError:
                pass
            log.warning('ffmpeg-hls duration check failed, using segment fallback')
        else:
            log.warning('ffmpeg-hls failed (%s), using segment fallback', err)

    if not full_span:
        picked = segments_with_preroll(parsed, picked)

    return clip_hls_segment_fallback(
        fetcher,
        parsed,
        picked,
        start_sec=start_sec,
        end_sec=end_sec,
        end_eff=end_eff,
        raw_ts_path=raw_ts_path,
        output_mp4=output_mp4,
        progress=progress,
        progress_base=progress_base,
        progress_scale=progress_scale,
        encode_mode='exact',
    )


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
