"""Per-job diagnostics: what the clipper saw and tried, saved when a job fails.

Secrets never leave this module: URLs keep scheme/host/path but query values
are masked, and only header *names* are recorded.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.parse
from typing import Any, Optional

MAX_EVENTS = 200
MAX_TEXT = 4000
RETENTION_SEC = 7 * 24 * 3600

_ctx = threading.local()
_URL_RE = re.compile(r'https?://[^\s"\'<>]+')


def redact_url(url: str) -> str:
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return '<invalid url>'
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    masked = '&'.join(f'{k}=…' for k, _ in query)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, masked, ''))


def redact_text(text: str) -> str:
    """Mask query values of every URL inside free text (playlists, ffmpeg stderr)."""
    return _URL_RE.sub(lambda m: redact_url(m.group(0)), text or '')


class Diagnostics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: list[dict[str, Any]] = []
        self._counters: dict[str, int] = {}
        self._t0 = time.time()

    def note(self, event: str, /, **detail: Any) -> None:
        clean = {k: _clean(v) for k, v in detail.items()}
        with self._lock:
            if len(self._events) >= MAX_EVENTS:
                self._counters['dropped_events'] = self._counters.get('dropped_events', 0) + 1
                return
            self._events.append({'t': round(time.time() - self._t0, 2), **clean, 'kind': event})

    def count(self, key: str, n: int = 1) -> None:
        with self._lock:
            self._counters[key] = self._counters.get(key, 0) + n

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {'events': list(self._events), 'counters': dict(self._counters)}


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)[:MAX_TEXT]
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value][:50]
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in list(value.items())[:50]}
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact_text(str(value))[:MAX_TEXT]


def set_diagnostics(diag: Optional[Diagnostics]) -> None:
    _ctx.diag = diag


def current_diagnostics() -> Optional[Diagnostics]:
    return getattr(_ctx, 'diag', None)


def note(event: str, /, **detail: Any) -> None:
    diag = current_diagnostics()
    if diag is not None:
        diag.note(event, **detail)


def count(key: str, n: int = 1) -> None:
    diag = current_diagnostics()
    if diag is not None:
        diag.count(key, n)


def diag_dir(download_dir: str) -> str:
    return os.path.join(download_dir, '.diag')


def save_report(download_dir: str, job_id: str, report: dict[str, Any]) -> Optional[str]:
    if not re.fullmatch(r'[A-Za-z0-9_-]{6,64}', job_id or ''):
        return None
    folder = diag_dir(download_dir)
    try:
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f'{job_id}.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        return path
    except OSError:
        return None


def report_path(download_dir: str, job_id: str) -> Optional[str]:
    if not re.fullmatch(r'[A-Za-z0-9_-]{6,64}', job_id or ''):
        return None
    path = os.path.join(diag_dir(download_dir), f'{job_id}.json')
    return path if os.path.isfile(path) else None


def remove_report(download_dir: str, job_id: str) -> None:
    path = report_path(download_dir, job_id)
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def purge_old_reports(download_dir: str, max_age_sec: float = RETENTION_SEC) -> None:
    folder = diag_dir(download_dir)
    if not os.path.isdir(folder):
        return
    cutoff = time.time() - max_age_sec
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        try:
            if name.endswith('.json') and os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass
