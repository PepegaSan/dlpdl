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
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import yt_dlp

from .clip_parse import clip_autoname_prefix
from .smart_clip import is_hls_url, smart_clip_hls

log = logging.getLogger('clip_direct')


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
    ytdl_opts: dict = field(default_factory=dict)
    title: str = ''


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

    def _job_dict(self, j: JobState) -> dict:
        return {
            'id': j.id,
            'url': j.spec.url,
            'status': j.status,
            'msg': j.msg,
            'filename': j.filename,
            'size': j.size,
            'error': j.error,
            'progress': j.progress,
            'clip_ranges': j.spec.clip_ranges,
            'merge_clips': j.spec.merge_clips,
        }

    def create_job(self, spec: JobSpec) -> str:
        job_id = str(uuid.uuid4())[:12]
        state = JobState(id=job_id, spec=spec)
        with self._lock:
            self._jobs[job_id] = state
        t = threading.Thread(target=self._run_job, args=(job_id,), daemon=True)
        t.start()
        return job_id

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
                elif st.get('status') == 'finished' and st.get('filename'):
                    fp = st['filename']
                    size = os.path.getsize(fp) if os.path.exists(fp) else None
                    self._update(
                        job_id,
                        status='ready',
                        msg=st.get('msg') or 'Fertig',
                        filename=os.path.basename(fp),
                        filepath=fp,
                        size=size,
                        progress=1.0,
                    )
                elif st.get('status') == 'error':
                    self._update(job_id, status='error', error=st.get('msg', 'error'), msg=msg)

        pump = threading.Thread(target=pump_status, daemon=True)
        pump.start()

        self._update(job_id, status='running', msg='Starte Download…')
        try:
            worker = _DownloadWorker(
                spec=spec,
                job_id=job_id,
                download_dir=self.download_dir,
                temp_dir=os.path.join(self.temp_dir, job_id),
                status_queue=status_q,
            )
            code = worker.run()
            status_q.put(None)
            pump.join(timeout=600)
            with self._lock:
                j = self._jobs.get(job_id)
            if j and j.status == 'running':
                if code != 0:
                    self._update(job_id, status='error', error='download failed', msg='Download fehlgeschlagen')
                else:
                    self._update(job_id, status='error', error='no output', msg='Keine Ausgabedatei')
        except Exception as exc:
            log.exception('job %s failed', job_id)
            self._update(job_id, status='error', error=str(exc), msg=str(exc))
            status_q.put(None)


class _DownloadWorker:
    def __init__(self, spec: JobSpec, job_id: str, download_dir: str, temp_dir: str, status_queue: queue.Queue):
        self.spec = spec
        self.job_id = job_id
        self.download_dir = download_dir
        self.temp_dir = temp_dir
        self.status_queue = status_queue
        os.makedirs(temp_dir, exist_ok=True)

        prefix = spec.custom_name_prefix or ''
        if spec.clip_ranges and spec.merge_clips:
            prefix = prefix or 'clipbatch_merged_'
        elif spec.clip_ranges and len(spec.clip_ranges) == 1:
            s, e = spec.clip_ranges[0]
            prefix = (prefix or '') + clip_autoname_prefix(s, e)
        elif spec.clip_start is not None or spec.clip_end is not None:
            prefix = (prefix or '') + clip_autoname_prefix(spec.clip_start, spec.clip_end)

        base = download_dir
        if spec.folder:
            base = os.path.join(download_dir, spec.folder.strip().strip('/\\'))
            os.makedirs(base, exist_ok=True)
        self.output_template = os.path.join(
            base,
            f'{prefix}%(title).200B-%(id)s.%(ext)s',
        )
        self._result_file: Optional[str] = None
        self._reported_finished = False
        self._last_progress_put = 0.0

    def _headers(self) -> Optional[dict]:
        h = self.spec.ytdl_opts.get('http_headers')
        return dict(h) if isinstance(h, dict) else None

    def _treat_as_hls(self) -> bool:
        if is_hls_url(self.spec.url):
            return True
        ext = self.spec.ytdl_opts.get('external_downloader')
        return isinstance(ext, dict) and bool(ext.get('m3u8'))

    def _put(self, payload: dict) -> None:
        if self._reported_finished and payload.get('status') == 'downloading':
            return
        if payload.get('status') == 'downloading':
            now = time.monotonic()
            if now - self._last_progress_put < 0.35:
                return
            self._last_progress_put = now
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

        if self.spec.merge_clips and self.spec.clip_ranges:
            code = self._merge_clips(ytdl_params)
        else:
            code = self._single_or_clip(ytdl_params)
        self._ensure_finished(code)
        return code

    def _mark_finished(self, filepath: str, msg: str = 'Fertig') -> None:
        if self._reported_finished or not filepath:
            return
        self._result_file = filepath
        self._reported_finished = True
        self._put({'status': 'finished', 'filename': filepath, 'msg': msg})

    def _ensure_finished(self, code: int) -> None:
        if self._reported_finished:
            return
        if code != 0:
            return
        if self._result_file and os.path.isfile(self._result_file):
            self._mark_finished(self._result_file)
            return
        base = os.path.dirname(self.output_template) or self.download_dir
        prefix = os.path.basename(self.output_template).split('%', 1)[0]
        candidates = []
        for name in os.listdir(base):
            if prefix and not name.startswith(prefix):
                continue
            path = os.path.join(base, name)
            if os.path.isfile(path) and name.lower().endswith(('.mp4', '.mkv', '.webm', '.m4a', '.mp3')):
                candidates.append(path)
        if candidates:
            newest = max(candidates, key=os.path.getmtime)
            self._mark_finished(newest)
            return
        self._put({'status': 'error', 'msg': 'Download beendet, aber keine Ausgabedatei gefunden'})

    def _progress_hook(self, d: dict) -> None:
        if self._reported_finished:
            return
        if d.get('status') == 'downloading':
            self._put({
                'status': 'downloading',
                'msg': 'Lade…',
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

    def _final_clip_output_path(self) -> str:
        name_info = {'title': 'clip', 'id': self.job_id, 'ext': 'mp4'}
        out_name = yt_dlp.YoutubeDL({
            'quiet': True,
            'paths': {'home': self.download_dir},
        }).prepare_filename(name_info, outtmpl=self.output_template)
        if not os.path.isabs(out_name):
            out_name = os.path.join(self.download_dir, out_name)
        os.makedirs(os.path.dirname(out_name) or self.download_dir, exist_ok=True)
        return out_name

    def _clip_hls_like_merge(self, start: float, end: float, ytdl_params: dict) -> bool:
        """Same smart_clip path as merge parts — avoids yt-dlp hangs on clipped HLS."""
        batch_dir = os.path.join(self.temp_dir, 'clip')
        os.makedirs(batch_dir, exist_ok=True)
        try:
            produced = self._merge_part(
                0, start, end, batch_dir, 0.0, 0.94, 1, ytdl_params,
            )
            if not produced or not os.path.isfile(produced):
                return False
            final = self._final_clip_output_path()
            if os.path.abspath(produced) != os.path.abspath(final):
                if os.path.exists(final):
                    os.remove(final)
                shutil.move(produced, final)
            self._mark_finished(final, msg='Fertig (Smart-Clip)')
            return True
        finally:
            shutil.rmtree(batch_dir, ignore_errors=True)

    def _smart_fallback(self, start: float, end: float) -> bool:
        raw_ts = os.path.join(self.temp_dir, 'smartclip.ts')
        out_name = self._final_clip_output_path()

        self._put({'status': 'downloading', 'msg': 'Smart-Clip: Playlist laden…', 'downloaded_bytes': 0, 'total_bytes_estimate': 1_000_000})

        def progress(payload):
            if self._reported_finished:
                return
            self._put(payload)

        ok, msg = smart_clip_hls(
            self.spec.url,
            self._headers(),
            start,
            end,
            raw_ts,
            out_name,
            progress=progress,
        )
        if raw_ts and os.path.exists(raw_ts):
            try:
                os.remove(raw_ts)
            except OSError:
                pass
        if ok:
            self._mark_finished(out_name, msg='Fertig (Smart-Clip)')
            return True
        log.error('smart-clip failed: %s', msg)
        return False

    def _single_or_clip(self, ytdl_params: dict) -> int:
        is_clip = self.spec.clip_start is not None or self.spec.clip_end is not None
        start = float(self.spec.clip_start) if self.spec.clip_start is not None else 0.0
        end = float(self.spec.clip_end) if self.spec.clip_end is not None else float('inf')

        # Clipped HLS: same path as merge parts (yt-dlp often hangs on clipped HLS).
        if is_clip and self._treat_as_hls():
            log.info('single clip HLS: smart_clip (merge path) for %s', self.spec.url[:80])
            if self._clip_hls_like_merge(start, end, ytdl_params):
                return 0
            self._put({'status': 'error', 'msg': 'Smart-Clip fehlgeschlagen'})
            return 1

        if is_clip:
            ytdl_params['download_ranges'] = yt_dlp.utils.download_range_func(
                None, [(start, end)],
            )

        ytdl_params['progress_hooks'] = []
        ytdl_params['postprocessor_hooks'] = [self._pp_hook]

        clip_dl_error = None
        try:
            ret = yt_dlp.YoutubeDL(params=ytdl_params).download([self.spec.url])
        except yt_dlp.utils.YoutubeDLError as exc:
            ret = 1
            clip_dl_error = exc

        if ret != 0 and self._treat_as_hls():
            fb_start = start if is_clip else 0.0
            fb_end = end if is_clip else float('inf')
            if self._smart_fallback(fb_start, fb_end):
                return 0
        if ret != 0 and clip_dl_error:
            self._put({'status': 'error', 'msg': str(clip_dl_error)})
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
    ) -> Optional[str]:
        """Download one merge segment. HLS uses smart_clip directly (yt-dlp often hangs on clipped HLS)."""
        part_out = os.path.join(batch_dir, f'part_{index:03d}.mp4')
        if self._treat_as_hls():
            raw_ts = os.path.join(batch_dir, f'part_{index:03d}_raw.ts')
            self._put(_progress_payload(
                fraction=part_base,
                msg=f'Teil {index + 1}/{total_parts}: Smart-Clip…',
            ))

            def _part_progress(payload):
                if self._reported_finished:
                    return
                self._put({**payload, 'msg': f'Teil {index + 1}/{total_parts}: {payload.get("msg", "")}'})

            ok, err = smart_clip_hls(
                self.spec.url,
                self._headers(),
                float(start),
                float(end),
                raw_ts,
                part_out,
                progress=_part_progress,
                progress_base=part_base,
                progress_scale=part_scale,
            )
            if os.path.exists(raw_ts):
                try:
                    os.remove(raw_ts)
                except OSError:
                    pass
            if ok and os.path.isfile(part_out):
                return part_out
            log.error('merge part %s smart-clip failed: %s', index, err)
            return None

        part_tmpl = os.path.join(batch_dir, f'part_{index:03d}.%(ext)s')
        part_params = {
            **ytdl_params,
            'outtmpl': {'default': part_tmpl},
            'download_ranges': yt_dlp.utils.download_range_func(None, [(float(start), float(end))]),
            'progress_hooks': [],
            'postprocessor_hooks': [],
        }
        produced = None
        try:
            code = yt_dlp.YoutubeDL(params=part_params).download([self.spec.url])
        except yt_dlp.utils.YoutubeDLError as exc:
            code = 1
            log.warning('merge part %s yt-dlp: %s', index, exc)
        if code == 0:
            matches = sorted(glob.glob(os.path.join(batch_dir, f'part_{index:03d}.*')))
            produced = matches[0] if matches else None
        return produced

    def _merge_clips(self, ytdl_params: dict) -> int:
        ranges = list(self.spec.clip_ranges)
        if not ranges:
            self._put({'status': 'error', 'msg': 'Keine Clip-Bereiche für Merge'})
            return 1
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
                    msg=f'Teil {i + 1}/{total_parts}: starte…',
                ))
                produced = self._merge_part(i, start, end, batch_dir, part_base, part_scale, total_parts, ytdl_params)
                if produced is None:
                    self._put({'status': 'error', 'msg': f'Teil {i + 1}/{total_parts} fehlgeschlagen'})
                    return 1
                part_paths.append(produced)

            self._put(_progress_payload(fraction=0.92, msg=f'Füge {len(part_paths)} Teile zusammen…', eta=10))

            list_path = os.path.join(batch_dir, 'concat.txt')
            with open(list_path, 'w', encoding='utf-8') as fh:
                for path in part_paths:
                    escaped = path.replace('\\', '/').replace("'", "'\\''")
                    fh.write(f"file '{escaped}'\n")

            ext = os.path.splitext(part_paths[0])[1] or '.mp4'
            name_info = {'title': 'merged', 'id': self.job_id, 'ext': ext.lstrip('.') or 'mp4'}
            merged_name = yt_dlp.YoutubeDL({'quiet': True, 'paths': {'home': self.download_dir}}).prepare_filename(
                name_info, outtmpl=self.output_template,
            )
            if not os.path.isabs(merged_name):
                merged_name = os.path.join(self.download_dir, merged_name)
            os.makedirs(os.path.dirname(merged_name) or self.download_dir, exist_ok=True)

            cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list_path, '-c', 'copy', merged_name]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list_path, '-c:v', 'libx264', '-c:a', 'aac', merged_name]
                proc = subprocess.run(cmd, capture_output=True, text=True)
                if proc.returncode != 0:
                    return 1
            self._mark_finished(merged_name, msg=f'Zusammenschnitt: {len(part_paths)} Teile')
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
