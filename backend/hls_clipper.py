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
DURATION_TOLERANCE_SEC = 2.5
# Decode this many seconds before the cut so the encoder sees a keyframe (fixes blocky start).
DECODE_PREROLL_SEC = 10.0
PREROLL_HLS_SEGMENTS = 2
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
    if not url:
        return False
    low = urllib.parse.unquote(url).lower()
    return bool(M3U8_RE.search(url)) or '.m3u8' in low or 'm3u8' in low


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


def resolve_hls_playlist(
    playlist_url: str,
    headers: Optional[dict],
) -> tuple[str, ParsedPlaylist, HttpFetcher]:
    fetcher = HttpFetcher(headers)
    body = fetcher.get_text(playlist_url)
    media_url = playlist_url
    if '#EXT-X-STREAM-INF' in body:
        variant = resolve_master_playlist(body, playlist_url)
        if not variant:
            raise ValueError('no variant in master playlist')
        media_url = variant
        body = fetcher.get_text(media_url)
    parsed = parse_media_playlist(body, media_url)
    return media_url, parsed, fetcher


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


def ffmpeg_header_args(headers: Optional[dict]) -> list[str]:
    if not headers:
        return []
    lines: list[str] = []
    seen: set[str] = set()
    for key in ('User-Agent', 'Referer', 'Origin', 'Cookie'):
        value = headers.get(key)
        if value:
            lines.append(f'{key}: {value}')
            seen.add(key)
    for key, value in headers.items():
        if key in seen or not value:
            continue
        lines.append(f'{key}: {value}')
    if not lines:
        return []
    return ['-headers', '\r\n'.join(lines) + '\r\n']


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


def remux_concat_demuxer(
    concat_list_path: str,
    out_mp4: str,
    *,
    seek: float,
    duration: Optional[float],
) -> tuple[bool, str]:
    if duration is None:
        copy_args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts+discardcorrupt',
            '-f', 'concat', '-safe', '0', '-i', concat_list_path,
            '-c', 'copy', '-movflags', '+faststart', out_mp4,
        ]
        proc = run_ffmpeg(copy_args)
        if proc.returncode == 0 and os.path.isfile(out_mp4) and os.path.getsize(out_mp4) > 0:
            return True, 'ok'
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

    total = len(picked)
    bytes_done = 0
    t0 = time.monotonic()
    report(0.0, f'Segments 0/{total}…')

    segment_paths: list[str] = []
    try:
        for index, seg in enumerate(picked):
            part_path = os.path.join(parts_dir, f'seg_{index:04d}.ts')
            chunk = align_transport_stream(fetcher.get_bytes(seg.uri))
            with open(part_path, 'wb') as fh:
                fh.write(chunk)
            segment_paths.append(part_path)
            bytes_done += len(chunk)
            elapsed = time.monotonic() - t0
            speed = bytes_done / max(elapsed, 0.25)
            dl_frac = ((index + 1) / total) * (1.0 - ENCODE_SHARE_OF_PROGRESS)
            eta = (max(total * BYTES_PER_SEGMENT_GUESS - bytes_done, 0) / speed) if speed > 0 else None
            report(dl_frac, f'Segments {index + 1}/{total}', speed=speed, eta=eta)

        list_path = os.path.join(parts_dir, 'concat.txt')
        with open(list_path, 'w', encoding='utf-8') as fh:
            for path in segment_paths:
                escaped = path.replace('\\', '/').replace("'", "'\\''")
                fh.write(f"file '{escaped}'\n")

        clip_len = max(end_eff - start_sec, 1.0) if not full_span else max(parsed.duration, 1.0)
        report(1.0 - ENCODE_SHARE_OF_PROGRESS, 'Encoding…', eta=clip_len * 0.45)

        if full_span:
            ok, err = remux_concat_demuxer(list_path, output_mp4, seek=0.0, duration=None)
        else:
            seek = max(0.0, start_sec - picked[0].timeline_start)
            ok, err = remux_concat_demuxer(
                list_path,
                output_mp4,
                seek=seek,
                duration=end_eff - start_sec,
            )
        if ok:
            report(1.0, 'Done')
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
) -> tuple[bool, str]:
    def report(frac: float, message: str, speed: float = 0.0, eta: Optional[float] = None) -> None:
        if not progress:
            return
        overall = progress_base + progress_scale * max(0.0, min(1.0, frac))
        progress(build_progress_event(fraction=overall, msg=message, speed=speed, eta=eta))

    try:
        media_url, parsed, fetcher = resolve_hls_playlist(playlist_url, headers)
    except Exception as exc:
        return False, f'playlist fetch failed: {exc}'

    if parsed.encrypted:
        return False, 'encrypted HLS (EXT-X-KEY) is not supported'
    if not parsed.segments:
        return False, 'empty media playlist'

    end_eff = end_sec if end_sec != float('inf') else parsed.duration
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
