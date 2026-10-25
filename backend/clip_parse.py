"""Parse clip timestamps from API / extension payloads."""

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, urlparse


class ClipParseError(ValueError):
    pass


@dataclass(frozen=True)
class IngestPiece:
    """Self-contained media inside one uploaded window: 'v' video (+muxed audio) or 'a' audio."""
    kind: str
    size: int
    timeline_start: Optional[float] = None


@dataclass(frozen=True)
class IngestPart:
    timeline_start: float
    size: int
    pieces: tuple[IngestPiece, ...] = ()


_PIECE_RE = re.compile(r'([va])(\d+)(?:@(-?[\d.]+))?')


def parse_ingest_parts(raw: str) -> list[IngestPart]:
    """`timeline:bytes[:v<bytes>,a<bytes>@<timeline>,…]` per window, `;`-separated.

    Malformed windows are skipped; pieces must add up to the window size.
    """
    parts: list[IngestPart] = []
    for chunk in (raw or '').split(';'):
        fields = chunk.strip().split(':')
        if len(fields) < 2:
            continue
        try:
            timeline, size = float(fields[0]), int(fields[1])
        except ValueError:
            continue
        pieces: list[IngestPiece] = []
        if len(fields) > 2 and fields[2]:
            for token in fields[2].split(','):
                match = _PIECE_RE.fullmatch(token.strip())
                if not match:
                    pieces = []
                    break
                pieces.append(IngestPiece(
                    match.group(1),
                    int(match.group(2)),
                    float(match.group(3)) if match.group(3) else None,
                ))
            if sum(p.size for p in pieces) != size or not any(p.kind == 'v' for p in pieces):
                continue
        parts.append(IngestPart(timeline, size, tuple(pieces)))
    return parts


_EMBED_SHELL_SUFFIXES = (
    'dood.video',
    'doodstream.com',
    'dood.watch',
    'emturbovid.com',
    'turboviplay.com',
)


def validate_job_media_url(url: str) -> None:
    """Reject embed player pages mistaken for direct media URLs."""
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower().replace('www.', '')
    for suffix in _EMBED_SHELL_SUFFIXES:
        if host == suffix or host.endswith(f'.{suffix}'):
            raise ClipParseError(
                'Embed-Seiten-URL statt Videostream — Video abspielen, '
                'dann cloudatacdn.com unter Erkannte Streams senden',
            )


def _parse_clock_timestamp(s: str) -> float:
    parts = s.strip().split(':')
    nums = [float(p) for p in parts]
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    raise ClipParseError('invalid clock format')


def _parse_youtube_t_compact(s: str) -> float | None:
    m = re.fullmatch(r'(\d+)([hms])?', s.strip().lower())
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2) or 's'
    if unit == 'h':
        return float(n * 3600)
    if unit == 'm':
        return float(n * 60)
    return float(n)


def parse_clip_timestamp(value) -> float:
    if isinstance(value, bool):
        raise ClipParseError('clip timestamp must be a number or string')
    if isinstance(value, (int, float)):
        if value < 0:
            raise ClipParseError('clip timestamp must be non-negative')
        return float(value)
    s = str(value).strip()
    if not s:
        raise ClipParseError('clip timestamp cannot be empty')
    if ':' in s:
        return _parse_clock_timestamp(s)
    compact = _parse_youtube_t_compact(s)
    if compact is not None:
        return compact
    raise ClipParseError('invalid clip timestamp format')


def optional_clip_field(raw) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, str) and not raw.strip():
        return None
    return parse_clip_timestamp(raw)


def parse_clips_list(raw) -> list[tuple[float, float]]:
    if not isinstance(raw, list) or not raw:
        raise ClipParseError('clips must be a non-empty list')
    parsed = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ClipParseError(f'clips[{index}] must be an object')
        try:
            start = parse_clip_timestamp(item.get('start'))
            end = parse_clip_timestamp(item.get('end'))
        except ClipParseError as exc:
            raise ClipParseError(f'clips[{index}]: {exc}') from exc
        if end <= start:
            raise ClipParseError(f'clips[{index}]: end must be greater than start')
        parsed.append((start, end))
    return parsed


def clip_autoname_prefix(clip_start=None, clip_end=None) -> str:
    def fmt(v):
        if v is None:
            return 'inf'
        if v == float('inf'):
            return 'inf'
        s = int(v) if v == int(v) else v
        mins, sec = divmod(int(v), 60)
        hrs, mins = divmod(mins, 60)
        if hrs:
            return f'{hrs}-{mins:02d}-{sec:02d}'
        return f'{mins}-{sec:02d}'

    if clip_start is None and clip_end is None:
        return ''
    return f'clip_{fmt(clip_start)}-{fmt(clip_end)}_'
