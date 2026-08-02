"""Human-readable output filenames for download jobs."""

from __future__ import annotations

import os
import re
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


def allocate_unique_stem(base_dir: str, stem: str) -> str:
    """Return stem or stem-2, stem-3, … if a matching file already exists."""
    if not stem:
        stem = 'clip'
    if not os.path.isdir(base_dir):
        return stem

    existing = os.listdir(base_dir)
    if not _stem_conflict(existing, stem):
        return stem

    n = 2
    while True:
        candidate = f'{stem}-{n}'
        if not _stem_conflict(existing, candidate):
            return candidate
        n += 1


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
