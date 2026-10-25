"""Human-readable output filenames for download jobs."""

from __future__ import annotations

import os
import re
import threading
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .downloader import JobSpec

_INVALID_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WHITESPACE = re.compile(r'\s+')


def format_time_point(value: Optional[float]) -> str:
    if value is None:
        return 'inf'
    if value == float('inf'):
        return 'inf'
    total = int(value)
    sec = total % 60
    mins = total // 60 % 60
    hrs = total // 3600
    if hrs:
        return f'{hrs}-{mins:02d}-{sec:02d}'
    return f'{mins}-{sec:02d}'


def format_time_span(start: Optional[float], end: Optional[float]) -> str:
    return f'{format_time_point(start)}-{format_time_point(end)}'


def sanitize_title(title: str, max_len: int = 60) -> str:
    text = (title or '').strip()
    text = _INVALID_CHARS.sub('', text)
    text = _WHITESPACE.sub(' ', text).strip(' .')
    if not text:
        return 'clip'
    if len(text) > max_len:
        text = text[:max_len].rstrip(' .')
    return text or 'clip'


def safe_subfolder(folder: str) -> str:
    """Relative folder below DOWNLOAD_DIR: no drive letters, no `..`, no absolute paths."""
    parts = []
    for raw in re.split(r'[\\/]+', folder or ''):
        piece = _INVALID_CHARS.sub('', raw).strip(' .')
        if piece:
            parts.append(piece[:80])
    return '/'.join(parts[:8])


def resolve_output_dir(download_dir: str, folder: str) -> str:
    """Absolute output dir that is guaranteed to stay inside download_dir."""
    root = os.path.realpath(download_dir)
    sub = safe_subfolder(folder)
    target = os.path.realpath(os.path.join(root, sub)) if sub else root
    if os.path.commonpath([root, target]) != root:
        target = root
    os.makedirs(target, exist_ok=True)
    return target


def build_output_stem(spec: JobSpec) -> str:
    parts: list[str] = []

    title = sanitize_title(spec.page_title or spec.title or '')
    if spec.custom_name_prefix:
        prefix = sanitize_title(spec.custom_name_prefix, max_len=30)
        if prefix and prefix != 'clip':
            parts.append(prefix)
    if title:
        parts.append(title)

    if spec.merge_clips and spec.clip_ranges:
        count = len(spec.clip_ranges)
        parts.append(f'merge{count}parts')
        parts.append(format_time_span(spec.clip_ranges[0][0], spec.clip_ranges[-1][1]))
    elif spec.clip_count and spec.clip_count > 1 and spec.clip_index:
        parts.append(f'scene{spec.clip_index}of{spec.clip_count}')

    if not parts:
        return 'clip'
    return '_'.join(parts)


_reserve_lock = threading.Lock()
_reserved: set[str] = set()


def _reserve_key(base_dir: str, stem: str) -> str:
    return os.path.normcase(os.path.join(os.path.abspath(base_dir), stem))


def allocate_unique_stem(base_dir: str, stem: str) -> str:
    """Return stem or stem-2, stem-3, … if a file exists or another running job holds it.

    The name stays reserved until release_stem(); concurrent jobs with the same
    title would otherwise both pick `stem` and overwrite each other.
    """
    if not stem:
        stem = 'clip'
    with _reserve_lock:
        existing = os.listdir(base_dir) if os.path.isdir(base_dir) else []
        reserved_here = [
            os.path.basename(key)
            for key in _reserved
            if os.path.dirname(key) == os.path.normcase(os.path.abspath(base_dir))
        ]
        taken = existing + reserved_here
        candidate = stem
        n = 2
        while _stem_conflict(taken, candidate):
            candidate = f'{stem}-{n}'
            n += 1
        _reserved.add(_reserve_key(base_dir, candidate))
        return candidate


def release_stem(base_dir: str, stem: str) -> None:
    with _reserve_lock:
        _reserved.discard(_reserve_key(base_dir, stem))


def _stem_conflict(filenames: list[str], stem: str) -> bool:
    prefix = stem + '.'
    alt = stem + '-'
    for name in filenames:
        if name == stem:
            return True
        if name.startswith(prefix):
            return True
        if name.startswith(alt):
            return True
    return False
