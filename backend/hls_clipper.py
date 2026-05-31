"""
HLS time-range clipper (clean-room).

Fetches an M3U8 playlist, downloads overlapping MPEG-TS segments, optionally
strips a decoy prefix before sync bytes, and cuts to MP4 with ffmpeg.
Spec: docs/BEHAVIOR.md — do not open third-party MeTube sources when maintaining.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
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
M3U8_RE = re.compile(r'\.m3u8(\?|$)', re.IGNORECASE)


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
    return bool(url) and bool(M3U8_RE.search(url))


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
    def __init__(self, headers: Optional[dict], timeout: int = 30):
        self._headers = dict(headers or {})
        self._headers.setdefault('User-Agent', DEFAULT_USER_AGENT)
        self._timeout = timeout

    def get_text(self, url: str) -> str:
        return self.get_bytes(url).decode('utf-8', 'ignore')

    def get_bytes(self, url: str) -> bytes:
        req = urllib.request.Request(url, headers=self._headers)
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            return resp.read()


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


def segments_for_window(
    playlist: ParsedPlaylist,
    start: float,
    end: float,
) -> list[MediaSegment]:
    end_eff = end if end != float('inf') else playlist.duration
    if end_eff <= start:
        return []
    # Overlap [start, end_eff); do not add a segment that only starts at/after the cut end.
    return [
        seg
        for seg in playlist.segments
        if (seg.timeline_start + seg.duration) > start + 0.02 and seg.timeline_start < end_eff - 0.02
    ]


def segments_with_preroll(
    playlist: ParsedPlaylist,
    picked: list[MediaSegment],
) -> list[MediaSegment]:
    """
    Prepend one HLS segment before the clip window so the first seconds decode
    from a keyframe instead of orphaned P-frames (blocky / smeared picture).
    """
    if not picked:
        return picked
    first = picked[0]
    prev = None
    for seg in playlist.segments:
        if seg.timeline_start + seg.duration <= first.timeline_start + 0.01:
            prev = seg
        elif seg.timeline_start >= first.timeline_start:
            break
    if prev is None or picked[0].uri == prev.uri:
        return picked
    return [prev, *picked]


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True)


def remux_or_encode(raw_ts: str, out_mp4: str, *, seek: float, duration: Optional[float]) -> tuple[bool, str]:
    if duration is None:
        copy_args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-i', raw_ts, '-c', 'copy', '-movflags', '+faststart', out_mp4,
        ]
        proc = run_ffmpeg(copy_args)
        if proc.returncode == 0 and os.path.isfile(out_mp4) and os.path.getsize(out_mp4) > 0:
            return True, 'ok'
        encode_args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts+discardcorrupt',
            '-i', raw_ts,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0',
            '-shortest',
            '-movflags', '+faststart', out_mp4,
        ]
        proc = run_ffmpeg(encode_args)
    else:
        # -ss before -i: keyframe-aligned start; -shortest: stop when video ends (no frozen last frame + long audio).
        encode_args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts+discardcorrupt',
            '-ss', f'{seek:.3f}',
            '-i', raw_ts,
            '-t', f'{duration:.3f}',
            '-avoid_negative_ts', 'make_zero',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0',
            '-shortest',
            '-movflags', '+faststart', out_mp4,
        ]
        proc = run_ffmpeg(encode_args)

    if proc.returncode != 0:
        err = (proc.stderr or '').strip()[:300]
        return False, f'ffmpeg failed: {err}'
    if not os.path.isfile(out_mp4) or os.path.getsize(out_mp4) == 0:
        return False, 'ffmpeg produced no output'
    return True, 'ok'


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
) -> tuple[bool, str]:
    fetcher = HttpFetcher(headers)

    def report(frac: float, message: str, speed: float = 0.0, eta: Optional[float] = None) -> None:
        if not progress:
            return
        overall = progress_base + progress_scale * max(0.0, min(1.0, frac))
        progress(build_progress_event(fraction=overall, msg=message, speed=speed, eta=eta))

    try:
        body = fetcher.get_text(playlist_url)
    except Exception as exc:
        return False, f'playlist fetch failed: {exc}'

    media_url = playlist_url
    if '#EXT-X-STREAM-INF' in body:
        variant = resolve_master_playlist(body, playlist_url)
        if not variant:
            return False, 'no variant in master playlist'
        media_url = variant
        try:
            body = fetcher.get_text(media_url)
        except Exception as exc:
            return False, f'variant playlist fetch failed: {exc}'

    parsed = parse_media_playlist(body, media_url)
    if parsed.encrypted:
        return False, 'encrypted HLS (EXT-X-KEY) is not supported'
    if not parsed.segments:
        return False, 'empty media playlist'

    end_eff = end_sec if end_sec != float('inf') else parsed.duration
    picked = segments_for_window(parsed, start_sec, end_sec)
    if not picked:
        return False, 'no segments in time window'

    full_span = start_sec <= 0.01 and end_eff >= parsed.duration - 0.5
    if not full_span:
        picked = segments_with_preroll(parsed, picked)
    total = len(picked)
    bytes_done = 0
    t0 = time.monotonic()
    report(0.0, f'Downloading segments 0/{total}…')

    try:
        with open(raw_ts_path, 'wb') as ts_out:
            for index, seg in enumerate(picked):
                chunk = align_transport_stream(fetcher.get_bytes(seg.uri))
                ts_out.write(chunk)
                bytes_done += len(chunk)
                elapsed = time.monotonic() - t0
                speed = bytes_done / max(elapsed, 0.25)
                dl_frac = ((index + 1) / total) * (1.0 - ENCODE_SHARE_OF_PROGRESS)
                eta = (max(total * BYTES_PER_SEGMENT_GUESS - bytes_done, 0) / speed) if speed > 0 else None
                report(dl_frac, f'Segments {index + 1}/{total}', speed=speed, eta=eta)
    except Exception as exc:
        return False, f'segment download failed: {exc}'

    encode_start_frac = 1.0 - ENCODE_SHARE_OF_PROGRESS
    clip_len = max(end_eff - start_sec, 1.0) if not full_span else max(parsed.duration, 1.0)
    report(encode_start_frac, 'Encoding…', eta=clip_len * 0.45)

    if full_span:
        ok, err = remux_or_encode(raw_ts_path, output_mp4, seek=0.0, duration=None)
    else:
        seek = max(0.0, start_sec - picked[0].timeline_start)
        ok, err = remux_or_encode(
            raw_ts_path,
            output_mp4,
            seek=seek,
            duration=end_eff - start_sec,
        )

    if ok:
        report(1.0, 'Done')
    return ok, err


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
    )
