"""Download jobs: yt-dlp clips with smart_clip HLS fallback.

Regression-sensitive behavior — see docs/BEHAVIOR.md:
- Clipped HLS: smart_clip first (single + merge parts), not yt-dlp download_ranges.
- Merge: postprocessor_hooks must not mark job ready per part.
- HLS detection: _treat_as_hls() (URL or extension overrides).
"""

import glob
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import yt_dlp

from .filename import allocate_unique_stem, build_output_stem
from .hls_clipper import (
    DEFAULT_USER_AGENT,
    apply_page_referer,
    clip_local_media_window,
    concat_local_mp4s,
    ffmpeg_header_args,
    ffmpeg_http_input_extras,
    finalize_mp4_for_editor,
    normalize_http_headers,
    probe_progressive_media_url,
    remux_browser_payload,
    rerender_for_editing,
    run_ffmpeg_with_progress,
    trim_media_to_duration,
)
from .smart_clip import is_hls_url, smart_clip_hls

log = logging.getLogger('clip_direct')

# Media extension in a URL path, incl. trailing-slash form: `.../x_720p.mp4/?rnd=..`
_MEDIA_FILE_EXT_RE = re.compile(r'\.(mp4|webm|mkv|mov|m4v)(?:$|/)', re.IGNORECASE)


def _progress_payload(*, fraction: float, msg: str, eta: Optional[float] = None) -> dict:
    fraction = max(0.0, min(1.0, fraction))
    return {
        'status': 'downloading',
        'msg': msg,
        'downloaded_bytes': int(fraction * 1_000_000),
        'total_bytes_estimate': 1_000_000,
        'eta': eta,
    }


@dataclass
class JobSpec:
    url: str
    clip_start: Optional[float] = None
    clip_end: Optional[float] = None
    clip_ranges: list[tuple[float, float]] = field(default_factory=list)
    merge_clips: bool = False
    custom_name_prefix: str = ''
    folder: str = ''
    format: str = 'bestvideo*+bestaudio/best'
    clip_encode_mode: str = 'preserve'
    post_render: bool = False
    ytdl_opts: dict = field(default_factory=dict)
    title: str = ''
    page_title: str = ''
    page_url: str = ''
    clip_index: Optional[int] = None
    clip_count: Optional[int] = None


@dataclass
class JobState:
    id: str
    spec: JobSpec
    status: str = 'pending'
    msg: str = ''
    filename: Optional[str] = None
    filepath: Optional[str] = None
    size: Optional[int] = None
    error: Optional[str] = None
    progress: float = 0.0


class JobRunner:
    def __init__(self, download_dir: str, temp_dir: str):
        self.download_dir = download_dir
        self.temp_dir = temp_dir
        os.makedirs(download_dir, exist_ok=True)
        os.makedirs(temp_dir, exist_ok=True)
        self._jobs: dict[str, JobState] = {}
        self._lock = threading.Lock()

    def list_jobs(self) -> list[dict]:
        with self._lock:
            return [self._job_dict(j) for j in self._jobs.values()]

    def get_job(self, job_id: str) -> Optional[dict]:
        with self._lock:
            j = self._jobs.get(job_id)
            return self._job_dict(j) if j else None

    def effective_filepath(self, j: JobState) -> Optional[str]:
        """Resolve on-disk path (fixes legacy jobs that stored basename only)."""
        if j.filepath and os.path.isfile(j.filepath):
            return j.filepath
        if j.filename:
            cand = os.path.join(self.download_dir, j.filename)
            if os.path.isfile(cand):
                return cand
        return None

    def _job_dict(self, j: JobState) -> dict:
        file_path = self.effective_filepath(j)
        return {
            'id': j.id,
            'url': j.spec.url,
            'status': j.status,
            'msg': j.msg,
            'filename': j.filename,
            'size': j.size,
            'error': j.error,
            'progress': j.progress,
            'clip_start': j.spec.clip_start,
            'clip_end': j.spec.clip_end,
            'clip_ranges': j.spec.clip_ranges,
            'merge_clips': j.spec.merge_clips,
            'clip_encode_mode': j.spec.clip_encode_mode,
            'post_render': j.spec.post_render,
            'downloadable': bool(j.status == 'ready' and file_path),
        }

    def create_job(self, spec: JobSpec) -> str:
        job_id = str(uuid.uuid4())[:12]
        state = JobState(id=job_id, spec=spec)
        with self._lock:
            self._jobs[job_id] = state
        t = threading.Thread(target=self._run_job, args=(job_id,), daemon=True)
        t.start()
        return job_id

    def create_waiting_job(self, spec: JobSpec) -> str:
        """Job waits for the extension to POST the browser-downloaded media."""
        job_id = str(uuid.uuid4())[:12]
        state = JobState(
            id=job_id,
            spec=spec,
            status='running',
            msg='Browser download…',
            progress=0.02,
        )
        with self._lock:
            self._jobs[job_id] = state
        return job_id

    def update_progress(self, job_id: str, msg: str, progress: float) -> bool:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j or j.status not in ('pending', 'running'):
                return False
        self._update(
            job_id,
            status='running',
            msg=(msg or 'Browser download…')[:200],
            progress=max(0.0, min(1.0, float(progress))),
        )
        return True

    def fail_job(self, job_id: str, message: str) -> bool:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j or j.status == 'ready':
                return False
        detail = (message or 'Browser download failed').strip()
        self._update(job_id, status='error', error=detail, msg=detail)
        return True

    def _exact_trim_local(
        self,
        job_id: str,
        src_mp4: str,
        clip_start: float,
        clip_end: float,
        timeline_start: Optional[float],
        progress_base: float = 0.91,
    ) -> tuple[bool, str]:
        if timeline_start is None:
            file_ss = 0.0
        else:
            file_ss = max(0.0, float(clip_start) - float(timeline_start))
        clip_dur = max(0.1, float(clip_end) - float(clip_start))

        def _trim_progress(frac: float, info: str) -> None:
            self._update(
                job_id,
                status='running',
                msg=f'Exakter Schnitt… ({info})',
                progress=progress_base + 0.02 * max(0.0, min(frac, 1.0)),
            )

        self._update(job_id, status='running', msg='Exakter Schnitt…', progress=progress_base)
        exact_tmp = f'{src_mp4}.exact.mp4'
        ok_t, trim_detail = clip_local_media_window(
            src_mp4,
            exact_tmp,
            file_ss,
            clip_dur,
            on_progress=_trim_progress,
        )
        if not ok_t:
            return False, trim_detail
        os.replace(exact_tmp, src_mp4)
        return True, trim_detail

    def _maybe_exact_trim_browser(
        self,
        job_id: str,
        spec: JobSpec,
        out_mp4: str,
        timeline_start: Optional[float],
        detail: str,
    ) -> tuple[bool, str]:
        if spec.clip_encode_mode != 'exact':
            return True, detail
        start = spec.clip_start
        end = spec.clip_end
        if (start is None or end is None) and len(spec.clip_ranges) == 1:
            start, end = spec.clip_ranges[0]
        if start is None or end is None or end == float('inf') or end <= start:
            return True, detail
        ok_t, trim_detail = self._exact_trim_local(
            job_id, out_mp4, float(start), float(end), timeline_start,
        )
        if not ok_t:
            return False, trim_detail
        return True, f'{detail} + {trim_detail}'

    def _ingest_browser_parts(
        self,
        job_id: str,
        spec: JobSpec,
        payload: bytes,
        part_specs: list[tuple[float, int]],
        job_tmp: str,
        out_mp4: str,
    ) -> tuple[bool, str]:
        expected = sum(n for _tl, n in part_specs)
        if expected > len(payload):
            return False, 'browser merge parts larger than payload'
        offset = 0
        remuxed: list[str] = []
        details: list[str] = []
        ranges = list(spec.clip_ranges or [])
        total = len(part_specs)
        for i, (tl, nbytes) in enumerate(part_specs):
            chunk = payload[offset:offset + nbytes]
            offset += nbytes
            if len(chunk) < 4096:
                return False, f'merge part {i + 1} empty'
            raw_i = os.path.join(job_tmp, f'part_{i:03d}.bin')
            mp4_i = os.path.join(job_tmp, f'part_{i:03d}.mp4')
            with open(raw_i, 'wb') as fh:
                fh.write(chunk)
            self._update(
                job_id,
                status='running',
                msg=f'Remux Teil {i + 1}/{total}…',
                progress=0.90 + 0.02 * (i / max(total, 1)),
            )
            ok, detail = remux_browser_payload(raw_i, mp4_i)
            try:
                os.remove(raw_i)
            except OSError:
                pass
            if not ok:
                return False, f'Teil {i + 1}: {detail}'
            if (
                spec.clip_encode_mode == 'exact'
                and i < len(ranges)
                and ranges[i][1] != float('inf')
                and ranges[i][1] > ranges[i][0]
            ):
                ok_t, trim_detail = self._exact_trim_local(
                    job_id,
                    mp4_i,
                    float(ranges[i][0]),
                    float(ranges[i][1]),
                    float(tl),
                    progress_base=0.91 + 0.02 * (i / max(total, 1)),
                )
                if not ok_t:
                    return False, f'Teil {i + 1}: {trim_detail}'
                detail = f'{detail} + {trim_detail}'
            remuxed.append(mp4_i)
            details.append(detail)

        self._update(job_id, status='running', msg=f'Merge {total} Teile…', progress=0.94)
        ok, concat_detail = concat_local_mp4s(remuxed, out_mp4)
        if not ok:
            return False, concat_detail
        return True, f'{concat_detail}; {"; ".join(details)}'

    def ingest_browser_media(
        self,
        job_id: str,
        payload: bytes,
        *,
        timeline_start: Optional[float] = None,
        parts: Optional[list[tuple[float, int]]] = None,
    ) -> tuple[bool, str]:
        with self._lock:
            state = self._jobs.get(job_id)
        if not state:
            return False, 'unknown job'
        if state.status == 'ready':
            return False, 'job already finished'
        if not payload or len(payload) < 4096:
            self.fail_job(job_id, 'Browser sent an empty download')
            return False, 'empty payload'

        spec = state.spec
        remux_msg = (
            'Neu rendern (Keyframe-Fix)…'
            if spec.post_render
            else 'Remux…'
        )
        self._update(job_id, status='running', msg=remux_msg, progress=0.90)
        job_tmp = os.path.join(self.temp_dir, job_id)
        os.makedirs(job_tmp, exist_ok=True)

        out_dir = self.download_dir
        if spec.folder:
            out_dir = os.path.join(self.download_dir, spec.folder.strip().strip('/\\'))
            os.makedirs(out_dir, exist_ok=True)
        stem = allocate_unique_stem(out_dir, build_output_stem(spec))
        out_mp4 = os.path.join(out_dir, f'{stem}.mp4')
        part_specs = [p for p in (parts or []) if p[1] > 0]

        try:
            if len(part_specs) > 1:
                ok, detail = self._ingest_browser_parts(
                    job_id, spec, payload, part_specs, job_tmp, out_mp4,
                )
            else:
                raw_path = os.path.join(job_tmp, 'browser.bin')
                with open(raw_path, 'wb') as fh:
                    fh.write(payload)
                ok, detail = remux_browser_payload(raw_path, out_mp4)
                try:
                    os.remove(raw_path)
                except OSError:
                    pass
                if ok:
                    ok, detail = self._maybe_exact_trim_browser(
                        job_id, spec, out_mp4, timeline_start, detail,
                    )
        except Exception as exc:
            log.exception('job %s browser remux crashed', job_id)
            self.fail_job(job_id, str(exc))
            return False, str(exc)
        if not ok:
            self.fail_job(job_id, detail)
            return False, detail

        msg = f'Done ({detail}, {spec.clip_encode_mode})'
        if spec.post_render:
            def _rerender_progress(frac: float, info: str) -> None:
                self._update(
                    job_id,
                    status='running',
                    msg=f'Neu rendern (Keyframe-Fix)… ({info})',
                    progress=0.93 + 0.06 * max(0.0, min(frac, 1.0)),
                )

            self._update(
                job_id,
                status='running',
                msg='Neu rendern (Keyframe-Fix)…',
                progress=0.93,
            )
            ok_r, r_detail, new_path = rerender_for_editing(
                out_mp4,
                on_progress=_rerender_progress,
            )
            if ok_r:
                out_mp4 = new_path
                msg = f'{msg} + {r_detail}'
            else:
                log.warning('job %s rerender failed: %s', job_id, r_detail)
                ok2, d2 = finalize_mp4_for_editor(out_mp4)
                if not ok2:
                    log.warning('job %s: %s', job_id, d2)
        else:
            ok2, d2 = finalize_mp4_for_editor(out_mp4)
            if not ok2:
                log.warning('job %s: %s', job_id, d2)

        size = os.path.getsize(out_mp4) if os.path.isfile(out_mp4) else None
        self._update(
            job_id,
            status='ready',
            msg=msg,
            filename=os.path.basename(out_mp4),
            filepath=out_mp4,
            size=size,
            progress=1.0,
            error='',
        )
        shutil.rmtree(job_tmp, ignore_errors=True)
        return True, msg

    def delete_job(self, job_id: str) -> bool:
        with self._lock:
            j = self._jobs.pop(job_id, None)
        if not j:
            return False
        if j.filepath and os.path.isfile(j.filepath):
            try:
                os.remove(j.filepath)
            except OSError:
                pass
        return True

    def _update(self, job_id: str, **kwargs) -> None:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j:
                return
            # Late progress events must not reset a finished job to "running".
            if j.status == 'ready' and kwargs.get('status') == 'running':
                return
            for k, v in kwargs.items():
                setattr(j, k, v)

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            state = self._jobs.get(job_id)
        if not state:
            return
        spec = state.spec
        status_q: queue.Queue = queue.Queue()

        def pump_status():
            while True:
                st = status_q.get()
                if st is None:
                    break
                msg = st.get('msg', '')
                if st.get('status') == 'downloading':
                    total = st.get('total_bytes_estimate') or 1
                    done = st.get('downloaded_bytes') or 0
                    prog = done / total
                    self._update(job_id, status='running', msg=msg, progress=prog)
                elif st.get('status') == 'finished' and (st.get('filepath') or st.get('filename')):
                    fp = st.get('filepath') or st['filename']
                    size = os.path.getsize(fp) if os.path.exists(fp) else None
                    self._update(
                        job_id,
                        status='ready',
                        msg=st.get('msg') or 'Done',
                        filename=os.path.basename(fp),
                        filepath=fp,
                        size=size,
                        progress=1.0,
                    )
                elif st.get('status') == 'error':
                    detail = (st.get('msg') or st.get('error') or '').strip()
                    if not detail or detail.lower() == 'error':
                        detail = 'Download fehlgeschlagen (keine Details)'
                    self._update(job_id, status='error', error=detail, msg=detail)

        pump = threading.Thread(target=pump_status, daemon=True)
        pump.start()

        def on_progress(msg: str, progress: float) -> None:
            self._update(
                job_id,
                status='running',
                msg=msg,
                progress=max(0.0, min(1.0, progress)),
            )

        self._update(job_id, status='running', msg='Starting download…', progress=0.0)
        try:
            worker = _DownloadWorker(
                spec=spec,
                job_id=job_id,
                download_dir=self.download_dir,
                temp_dir=os.path.join(self.temp_dir, job_id),
                status_queue=status_q,
                progress_callback=on_progress,
            )
            code = worker.run()
            last_error = getattr(worker, '_last_error', '')
            status_q.put(None)
            pump.join(timeout=600)
            with self._lock:
                j = self._jobs.get(job_id)
            if j and j.status == 'running':
                if code != 0:
                    detail = (last_error or j.msg or j.error or '').strip()
                    if not detail or detail.lower() == 'error':
                        detail = 'Download fehlgeschlagen'
                    self._update(job_id, status='error', error=detail, msg=detail)
                else:
                    self._update(
                        job_id,
                        status='error',
                        error='Keine Ausgabedatei erzeugt',
                        msg='Keine Ausgabedatei erzeugt',
                    )
        except Exception as exc:
            log.exception('job %s failed', job_id)
            self._update(job_id, status='error', error=str(exc), msg=str(exc))
            status_q.put(None)


class _DownloadWorker:
    def __init__(
        self,
        spec: JobSpec,
        job_id: str,
        download_dir: str,
        temp_dir: str,
        status_queue: queue.Queue,
        progress_callback: Optional[Callable[[str, float], None]] = None,
    ):
        self.spec = spec
        self.job_id = job_id
        self.download_dir = download_dir
        self.temp_dir = temp_dir
        self.status_queue = status_queue
        self._progress_callback = progress_callback
        os.makedirs(temp_dir, exist_ok=True)

        base = download_dir
        if spec.folder:
            base = os.path.join(download_dir, spec.folder.strip().strip('/\\'))
            os.makedirs(base, exist_ok=True)
        self._output_base = base
        stem = build_output_stem(spec)
        self._file_stem = allocate_unique_stem(base, stem)
        self.output_template = os.path.join(
            base,
            f'{self._file_stem}.%(ext)s',
        )
        self._result_file: Optional[str] = None
        self._reported_finished = False
        self._last_progress_put = 0.0
        self._last_progress_msg = ''
        self._last_error = ''

    def _notify_progress(self, msg: str, fraction: float) -> None:
        fraction = max(0.0, min(1.0, fraction))
        if self._progress_callback:
            self._progress_callback(msg, fraction)

    def _fail(self, message: str) -> int:
        text = (message or 'Download fehlgeschlagen').strip()
        self._last_error = text
        self._put({'status': 'error', 'msg': text, 'error': text})
        return 1

    def _headers(self) -> dict:
        h = dict(self.spec.ytdl_opts.get('http_headers') or {})
        h.setdefault('User-Agent', DEFAULT_USER_AGENT)
        url_low = (self.spec.url or '').lower()
        if any(host in url_low for host in ('turboviplay.com', 'turbosplayer.com')):
            h.setdefault('Referer', 'https://emturbovid.com/')
            try:
                h.setdefault('Origin', 'https://emturbovid.com')
            except OSError:
                pass
            if not any(k.lower() == 'cookie' and str(v or '').strip() for k, v in h.items()):
                log.warning(
                    'job %s: turboviplay without Cookie header — CDN will return dummy playlist',
                    self.job_id,
                )
        if 'cloudatacdn.com' in url_low or 'cloudatacdn.net' in url_low:
            if not h.get('Referer'):
                log.warning(
                    'job %s: cloudatacdn without Referer — send from page with playing video',
                    self.job_id,
                )
        h = apply_page_referer(h, self.spec.url, self.spec.page_url)
        has_cookie = any(k.lower() == 'cookie' and str(v or '').strip() for k, v in h.items())
        referer = ''
        for key, value in h.items():
            if key.lower() == 'referer':
                referer = str(value or '')
                break
        log.info(
            'job %s headers: cookie=%s referer=%s',
            self.job_id,
            'yes' if has_cookie else 'no',
            referer[:96] or '-',
        )
        return h

    def _normalized_headers(self) -> dict:
        return normalize_http_headers(self._headers())

    def _is_progressive_cdn_url(self) -> bool:
        url_low = (self.spec.url or '').lower()
        return 'cloudatacdn.com' in url_low or 'cloudatacdn.net' in url_low

    def _direct_media_ext(self) -> Optional[str]:
        """Media extension in the URL *path* (e.g. `.../x_720p.mp4/?rnd=..`)."""
        url = self.spec.url or ''
        path = url.split('?', 1)[0].split('#', 1)[0]
        m = _MEDIA_FILE_EXT_RE.search(path)
        if not m:
            return None
        ext = m.group(1).lower()
        return 'mp4' if ext == 'm4v' else ext

    def _is_direct_media_file_url(self) -> bool:
        """A plain progressive media file (not HLS) — download via ffmpeg, not yt-dlp."""
        if self._treat_as_hls():
            return False
        if self._is_progressive_cdn_url():
            return True
        return self._direct_media_ext() is not None

    def _ffmpeg_full_download(self, output_path: str) -> tuple[bool, str]:
        """Copy a full progressive media file via ffmpeg (headers + redirects)."""
        headers = self._normalized_headers()
        if self._is_progressive_cdn_url():
            ok_probe, probe_err = probe_progressive_media_url(self.spec.url, headers)
            if not ok_probe:
                return False, probe_err

        def report(local_frac: float, detail: str) -> None:
            self._put(_progress_payload(
                fraction=0.05 + 0.88 * max(0.0, min(local_frac, 1.0)),
                msg=f'Direkt-Download: ffmpeg… ({detail})',
            ))

        report(0.0, 'start')
        args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            *ffmpeg_header_args(headers),
            *ffmpeg_http_input_extras(),
            '-i', self.spec.url,
            '-map', '0:v:0?', '-map', '0:a:0?',
            '-c', 'copy',
            '-movflags', '+faststart',
            output_path,
        ]
        try:
            proc = run_ffmpeg_with_progress(
                args,
                duration_sec=0.0,
                on_progress=report,
                timeout=1800,
            )
        except subprocess.TimeoutExpired:
            return False, 'ffmpeg timeout (>30 min)'
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or '').strip()[:400]
            return False, err or 'ffmpeg direct download failed'
        if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
            return False, 'ffmpeg direct download produced no output'
        return True, 'ffmpeg-direct'

    def _ffmpeg_clip_range(
        self,
        start: float,
        end: float,
        output_path: str,
        *,
        progress_label: str = 'Progressive CDN',
        progress_base: float = 0.05,
        progress_scale: float = 0.9,
    ) -> tuple[bool, str]:
        # end=inf means "to EOF" — never pass -t inf to ffmpeg.
        has_end = end is not None and end != float('inf') and end > start
        duration = max(end - start, 0.1) if has_end else 0.0
        headers = self._normalized_headers()

        def report(local_frac: float, detail: str) -> None:
            fraction = progress_base + progress_scale * max(0.0, min(local_frac, 1.0))
            self._put(_progress_payload(
                fraction=fraction,
                msg=f'{progress_label}: ffmpeg clip… ({detail})',
            ))

        report(0.0, 'start')
        if self._is_progressive_cdn_url():
            ok_probe, probe_err = probe_progressive_media_url(self.spec.url, headers)
            if not ok_probe:
                return False, probe_err

        args = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            *ffmpeg_header_args(headers),
            *ffmpeg_http_input_extras(),
            '-ss', f'{start:.3f}',
            '-i', self.spec.url,
        ]
        if has_end:
            args.extend(['-t', f'{duration:.3f}'])
        args.extend(['-map', '0:v:0?', '-map', '0:a:0?'])
        if self.spec.clip_encode_mode == 'preserve':
            args.extend([
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                '-movflags', '+faststart',
                output_path,
            ])
        else:
            args.extend([
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                '-c:a', 'aac',
                '-movflags', '+faststart',
                output_path,
            ])
        try:
            proc = run_ffmpeg_with_progress(
                args,
                duration_sec=duration,
                on_progress=report,
                timeout=900,
            )
        except subprocess.TimeoutExpired:
            return False, 'ffmpeg timeout (>15 min) — kürzeren Clip versuchen'
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or '').strip()[:400]
            if 'dood.video' in err.lower():
                return False, (
                    'CDN/ffmpeg verweist auf dood.video — Video abspielen, '
                    'sofort erneut senden (Token abgelaufen?)'
                )
            return False, err or 'ffmpeg progressive clip failed'
        if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
            return False, 'ffmpeg progressive clip produced no output'
        if output_path.lower().endswith('.mp4'):
            finalize_mp4_for_editor(output_path)
        return True, 'ffmpeg-progressive'

    def _treat_as_hls(self) -> bool:
        if is_hls_url(self.spec.url):
            return True
        ext = self.spec.ytdl_opts.get('external_downloader')
        return isinstance(ext, dict) and bool(ext.get('m3u8'))

    def _put(self, payload: dict) -> None:
        if self._reported_finished and payload.get('status') == 'downloading':
            return
        msg = (payload.get('msg') or '').strip()
        if payload.get('status') == 'downloading':
            now = time.monotonic()
            if msg == self._last_progress_msg and now - self._last_progress_put < 0.35:
                return
            self._last_progress_put = now
            self._last_progress_msg = msg
            total = payload.get('total_bytes_estimate') or 1
            done = payload.get('downloaded_bytes') or 0
            self._notify_progress(msg or 'Downloading…', done / total)
        self.status_queue.put(payload)

    def run(self) -> int:
        ytdl_params = {
            'quiet': True,
            'no_color': True,
            'paths': {'home': self.download_dir, 'temp': self.temp_dir},
            'outtmpl': {'default': self.output_template},
            'format': self.spec.format,
            'socket_timeout': 30,
            'ignore_no_formats_error': True,
            'progress_hooks': [self._progress_hook],
            'postprocessor_hooks': [self._pp_hook],
            **self.spec.ytdl_opts,
        }
        if self.spec.clip_encode_mode == 'preserve':
            ytdl_params.setdefault('postprocessor_args', {'ffmpeg': ['-c', 'copy']})

        log.info(
            'job %s encode_mode=%s post_render=%s url=%s merge=%s',
            self.job_id,
            self.spec.clip_encode_mode,
            self.spec.post_render,
            self.spec.url[:80],
            self.spec.merge_clips,
        )

        if self.spec.merge_clips and self.spec.clip_ranges:
            code = self._merge_clips(ytdl_params)
        else:
            code = self._single_or_clip(ytdl_params)
        self._ensure_finished(code)
        return code

    def _mark_finished(self, filepath: str, msg: str = 'Done') -> None:
        if self._reported_finished or not filepath:
            return
        if self.spec.post_render:
            def _rerender_progress(frac: float, detail: str) -> None:
                self._put(_progress_payload(
                    fraction=0.93 + 0.06 * max(0.0, min(frac, 1.0)),
                    msg=f'Neu rendern (Keyframe-Fix)… ({detail})',
                ))

            self._put(_progress_payload(fraction=0.93, msg='Neu rendern (Keyframe-Fix)…'))
            ok, detail, new_path = rerender_for_editing(filepath, on_progress=_rerender_progress)
            if ok:
                filepath = new_path
                msg = f'{msg} + {detail}'
            else:
                log.warning('job %s rerender failed: %s', self.job_id, detail)
                if filepath.lower().endswith('.mp4'):
                    ok2, detail2 = finalize_mp4_for_editor(filepath)
                    if not ok2:
                        log.warning('job %s: %s', self.job_id, detail2)
        elif filepath.lower().endswith('.mp4'):
            ok, detail = finalize_mp4_for_editor(filepath)
            if not ok:
                log.warning('job %s: %s', self.job_id, detail)
        self._result_file = filepath
        self._reported_finished = True
        self._put({
            'status': 'finished',
            'filename': os.path.basename(filepath),
            'filepath': filepath,
            'msg': msg,
        })

    def _ensure_finished(self, code: int) -> None:
        if self._reported_finished:
            return
        if code != 0:
            return
        if self._result_file and os.path.isfile(self._result_file):
            self._mark_finished(self._result_file)
            return
        base = os.path.dirname(self.output_template) or self.download_dir
        stem = self._file_stem
        candidates = []
        for name in os.listdir(base):
            if not name.startswith(stem + '.'):
                continue
            path = os.path.join(base, name)
            if os.path.isfile(path) and name.lower().endswith(('.mp4', '.mkv', '.webm', '.m4a', '.mp3')):
                candidates.append(path)
        if len(candidates) == 1:
            self._mark_finished(candidates[0])
            return
        if candidates:
            log.error(
                'job %s: ambiguous output files for stem %s (%d matches)',
                self.job_id,
                stem,
                len(candidates),
            )
        self._put({'status': 'error', 'msg': 'Download abgeschlossen, aber keine Ausgabedatei gefunden', 'error': 'Download abgeschlossen, aber keine Ausgabedatei gefunden'})

    def _progress_hook(self, d: dict) -> None:
        if self._reported_finished:
            return
        if d.get('status') == 'downloading':
            self._put({
                'status': 'downloading',
                'msg': 'Downloading…',
                'downloaded_bytes': d.get('downloaded_bytes') or 0,
                'total_bytes_estimate': d.get('total_bytes') or d.get('total_bytes_estimate') or 1_000_000,
            })

    def _pp_hook(self, d: dict) -> None:
        # During merge, each part triggers MoveFiles — must not mark the job ready yet.
        if self.spec.merge_clips and len(self.spec.clip_ranges or []) > 1:
            return
        if d.get('postprocessor') == 'MoveFiles' and d.get('status') == 'finished':
            filepath = d['info_dict'].get('filepath')
            if filepath:
                self._mark_finished(filepath)

    def _final_clip_output_path(self, ext: str = 'mp4') -> str:
        base = os.path.dirname(self.output_template) or self._output_base or self.download_dir
        os.makedirs(base, exist_ok=True)
        ext = ext.lstrip('.') or 'mp4'
        return os.path.join(base, f'{self._file_stem}.{ext}')

    def _clip_hls_like_merge(self, start: float, end: float, ytdl_params: dict) -> tuple[bool, str]:
        """Same smart_clip path as merge parts — avoids yt-dlp hangs on clipped HLS."""
        batch_dir = os.path.join(self.temp_dir, 'clip')
        os.makedirs(batch_dir, exist_ok=True)
        try:
            produced, detail = self._merge_part(
                0, start, end, batch_dir, 0.0, 0.94, 1, ytdl_params,
            )
            if not produced or not os.path.isfile(produced):
                return False, detail or 'Smart-Clip failed'
            final = self._final_clip_output_path()
            if os.path.abspath(produced) != os.path.abspath(final):
                if os.path.exists(final):
                    os.remove(final)
                shutil.move(produced, final)
            self._mark_finished(final, msg=f'Done ({detail}, {self.spec.clip_encode_mode})')
            return True, detail
        finally:
            shutil.rmtree(batch_dir, ignore_errors=True)

    def _smart_fallback(self, start: float, end: float) -> tuple[bool, str]:
        raw_ts = os.path.join(self.temp_dir, 'smartclip.ts')
        out_name = self._final_clip_output_path()

        self._put({'status': 'downloading', 'msg': 'Smart-Clip: loading playlist…', 'downloaded_bytes': 0, 'total_bytes_estimate': 1_000_000})

        def progress(payload):
            if self._reported_finished:
                return
            self._put(payload)

        ok, msg = smart_clip_hls(
            self.spec.url,
            self._normalized_headers(),
            start,
            end,
            raw_ts,
            out_name,
            progress=progress,
            encode_mode=self.spec.clip_encode_mode,
        )
        if raw_ts and os.path.exists(raw_ts):
            try:
                os.remove(raw_ts)
            except OSError:
                pass
        if ok:
            self._mark_finished(out_name, msg=f'Done ({msg}, {self.spec.clip_encode_mode})')
            return True, msg
        log.error('smart-clip failed: %s', msg)
        return False, msg

    def _single_or_clip(self, ytdl_params: dict) -> int:
        is_clip = self.spec.clip_start is not None or self.spec.clip_end is not None
        start = float(self.spec.clip_start) if self.spec.clip_start is not None else 0.0
        end = float(self.spec.clip_end) if self.spec.clip_end is not None else float('inf')

        if self._treat_as_hls():
            log.info('HLS: smart_clip for %s', self.spec.url[:80])
            if is_clip:
                ok, err = self._clip_hls_like_merge(start, end, ytdl_params)
            else:
                ok, err = self._smart_fallback(start, end)
            if ok:
                return 0
            detail = err or 'Smart-Clip fehlgeschlagen'
            return self._fail(detail)

        if is_clip:
            ytdl_params['download_ranges'] = yt_dlp.utils.download_range_func(
                None, [(start, end)],
            )

        if is_clip and self._is_direct_media_file_url():
            ext = self._direct_media_ext() or 'mp4'
            out = self._final_clip_output_path(ext)
            ok, err = self._ffmpeg_clip_range(
                start, end, out,
                progress_base=0.05,
                progress_scale=0.9,
            )
            if ok:
                self._mark_finished(out, msg=f'Done ({err})')
                return 0
            return self._fail(err or 'progressive clip failed')

        if not is_clip and self._is_direct_media_file_url():
            ext = self._direct_media_ext() or 'mp4'
            out = self._final_clip_output_path(ext)
            ok, err = self._ffmpeg_full_download(out)
            if ok:
                self._mark_finished(out, msg=f'Done ({err})')
                return 0
            return self._fail(err or 'direct download failed')

        ytdl_params['progress_hooks'] = []
        ytdl_params['postprocessor_hooks'] = [self._pp_hook]

        clip_dl_error = None
        try:
            ret = yt_dlp.YoutubeDL(params=ytdl_params).download([self.spec.url])
        except yt_dlp.utils.YoutubeDLError as exc:
            ret = 1
            clip_dl_error = exc

        if ret != 0 and clip_dl_error:
            return self._fail(str(clip_dl_error))
        return ret

    def _merge_part(
        self,
        index: int,
        start: float,
        end: float,
        batch_dir: str,
        part_base: float,
        part_scale: float,
        total_parts: int,
        ytdl_params: dict,
    ) -> tuple[Optional[str], str]:
        """Download one merge segment. HLS uses smart_clip directly (yt-dlp often hangs on clipped HLS)."""
        part_ext = (self._direct_media_ext() if self._is_direct_media_file_url() else None) or 'mp4'
        part_out = os.path.join(batch_dir, f'part_{index:03d}.{part_ext}')
        if self._treat_as_hls():
            raw_ts = os.path.join(batch_dir, f'part_{index:03d}_raw.ts')
            self._put(_progress_payload(
                fraction=part_base,
                msg=f'Part {index + 1}/{total_parts}: Smart-Clip…',
            ))

            def _part_progress(payload):
                if self._reported_finished:
                    return
                self._put({**payload, 'msg': f'Part {index + 1}/{total_parts}: {payload.get("msg", "")}'})

            ok, err = smart_clip_hls(
                self.spec.url,
                self._normalized_headers(),
                float(start),
                float(end),
                raw_ts,
                part_out,
                progress=_part_progress,
                progress_base=part_base,
                progress_scale=part_scale,
                encode_mode=self.spec.clip_encode_mode,
            )
            if os.path.exists(raw_ts):
                try:
                    os.remove(raw_ts)
                except OSError:
                    pass
            if ok and os.path.isfile(part_out):
                return part_out, err
            log.error('merge part %s smart-clip failed: %s', index, err)
            return None, err

        if self._is_direct_media_file_url():
            ok, err = self._ffmpeg_clip_range(
                float(start), float(end), part_out,
                progress_label=f'Part {index + 1}/{total_parts}',
                progress_base=part_base,
                progress_scale=part_scale,
            )
            if ok and os.path.isfile(part_out):
                return part_out, err
            return None, err or 'progressive clip failed'

        part_tmpl = os.path.join(batch_dir, f'part_{index:03d}.%(ext)s')
        part_params = {
            **ytdl_params,
            'outtmpl': {'default': part_tmpl},
            'download_ranges': yt_dlp.utils.download_range_func(None, [(float(start), float(end))]),
            'progress_hooks': [],
            'postprocessor_hooks': [],
        }
        produced = None
        ytdl_err = ''
        try:
            code = yt_dlp.YoutubeDL(params=part_params).download([self.spec.url])
        except yt_dlp.utils.YoutubeDLError as exc:
            code = 1
            ytdl_err = str(exc).strip()[:300]
            log.warning('merge part %s yt-dlp: %s', index, exc)
        if code == 0:
            matches = sorted(glob.glob(os.path.join(batch_dir, f'part_{index:03d}.*')))
            produced = matches[0] if matches else None
        if produced and os.path.isfile(produced):
            return produced, 'yt-dlp'
        return None, ytdl_err or 'yt-dlp produced no output'

    def _merge_clips(self, ytdl_params: dict) -> int:
        ranges = list(self.spec.clip_ranges)
        if not ranges:
            return self._fail('Keine Clip-Bereiche für Zusammenschnitt')
        batch_dir = os.path.join(self.temp_dir, 'merge')
        os.makedirs(batch_dir, exist_ok=True)
        part_paths = []
        total_parts = len(ranges)
        hls = self._treat_as_hls()
        try:
            for i, (start, end) in enumerate(ranges):
                part_scale = 0.88 / max(total_parts, 1)
                part_base = i * part_scale
                self._put(_progress_payload(
                    fraction=part_base,
                    msg=f'Part {i + 1}/{total_parts}: start…',
                ))
                produced, detail = self._merge_part(i, start, end, batch_dir, part_base, part_scale, total_parts, ytdl_params)
                if produced is None:
                    part_msg = detail or 'unbekannt'
                    return self._fail(f'Teil {i + 1}/{total_parts} fehlgeschlagen: {part_msg}')
                part_paths.append(produced)
                if hls and i + 1 < total_parts:
                    time.sleep(2.0)

            self._put(_progress_payload(fraction=0.92, msg=f'Merging {len(part_paths)} parts…', eta=10))

            list_path = os.path.join(batch_dir, 'concat.txt')
            with open(list_path, 'w', encoding='utf-8') as fh:
                for path in part_paths:
                    escaped = path.replace('\\', '/').replace("'", "'\\''")
                    fh.write(f"file '{escaped}'\n")

            ext = os.path.splitext(part_paths[0])[1] or '.mp4'
            merged_name = self._final_clip_output_path(ext.lstrip('.') or 'mp4')
            os.makedirs(os.path.dirname(merged_name) or self.download_dir, exist_ok=True)

            expected_total = sum(
                max(float(end) - float(start), 0.1) for start, end in ranges
            )

            cmd = [
                'ffmpeg', '-y', '-loglevel', 'error',
                '-f', 'concat', '-safe', '0', '-i', list_path,
                '-c', 'copy', '-shortest',
                '-avoid_negative_ts', 'make_zero',
                '-movflags', '+faststart',
                merged_name,
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                err = (proc.stderr or '').strip()[:400]
                if self.spec.clip_encode_mode != 'exact':
                    log.error('merge copy failed in preserve mode: %s', err[:200])
                    return self._fail(err or 'ffmpeg concat (copy) failed')
                cmd = [
                    'ffmpeg', '-y', '-loglevel', 'error',
                    '-f', 'concat', '-safe', '0', '-i', list_path,
                    '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
                    '-avoid_negative_ts', 'make_zero',
                    '-movflags', '+faststart',
                    merged_name,
                ]
                proc = subprocess.run(cmd, capture_output=True, text=True)
                if proc.returncode != 0:
                    err2 = (proc.stderr or '').strip()[:400]
                    return self._fail(err2 or 'ffmpeg concat (re-encode) failed')

            trim_ok, trim_detail = trim_media_to_duration(
                merged_name,
                expected_total,
                encode_mode=self.spec.clip_encode_mode,
            )
            if not trim_ok:
                log.warning('merge tail trim: %s', trim_detail)

            self._mark_finished(
                merged_name,
                msg=f'Merged: {len(part_paths)} parts ({self.spec.clip_encode_mode})',
            )
            log.info('merge job %s: %d parts -> %s', self.job_id, len(part_paths), merged_name)
            return 0
        finally:
            shutil.rmtree(batch_dir, ignore_errors=True)


def parse_ytdl_overrides(raw: Any) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        return json.loads(s)
    return {}
