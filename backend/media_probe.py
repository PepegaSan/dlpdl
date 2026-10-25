"""Recognise what a CDN actually sent (by bytes, not by file extension) and
translate known failure patterns into advice a user can act on."""

from __future__ import annotations

import re

TS_PACKET = 188


def _ts_sync_at(data: bytes, offset: int) -> bool:
    return all(
        offset + i * TS_PACKET < len(data) and data[offset + i * TS_PACKET] == 0x47
        for i in range(3)
    )


def _skip_id3(data: bytes) -> bytes:
    """Packed-audio HLS segments start with an ID3 tag (syncsafe size)."""
    if data[:3] != b'ID3' or len(data) < 10:
        return data
    size = 0
    for byte in data[6:10]:
        size = (size << 7) | (byte & 0x7F)
    return data[10 + size:]


def classify_media_bytes(data: bytes) -> str:
    """Return one of: ts, fmp4-init, fmp4-fragment, aac, mp3, html, json, empty, unknown."""
    if not data:
        return 'empty'
    head = data[:2048]
    box = head[4:8]
    if box in (b'ftyp', b'moov'):
        return 'fmp4-init'
    if box in (b'styp', b'moof', b'sidx', b'emsg', b'prft'):
        return 'fmp4-fragment'
    stripped = head.lstrip()[:512].lower()
    if stripped.startswith((b'<!doctype', b'<html', b'<?xml', b'<head', b'<body')) or b'<html' in stripped:
        return 'html'
    if stripped.startswith((b'{', b'[')):
        return 'json'
    # MPEG-TS may hide behind a fake image/junk prefix (some CDNs); scan for sync.
    for offset in range(min(len(data), 8192)):
        if data[offset] == 0x47 and _ts_sync_at(data, offset):
            return 'ts'
    payload = _skip_id3(data)
    if len(payload) >= 2 and payload[0] == 0xFF and (payload[1] & 0xF6) == 0xF0:
        return 'aac'
    if len(payload) >= 2 and payload[0] == 0xFF and (payload[1] & 0xE0) == 0xE0:
        return 'mp3'
    return 'unknown'


def preflight_problem(kind: str, has_init: bool) -> str:
    """Empty string when the segment looks processable, else a German user message."""
    if kind == 'html':
        return (
            'CDN lieferte eine Webseite statt Video — Link/Token abgelaufen oder Referer fehlt. '
            'Video auf der Originalseite kurz abspielen und erneut senden'
        )
    if kind == 'json':
        return 'CDN lieferte eine Fehlermeldung (JSON) statt Video — Video neu abspielen und erneut senden'
    if kind == 'empty':
        return 'CDN lieferte ein leeres Segment — Video neu abspielen und erneut senden'
    if kind == 'fmp4-fragment' and not has_init:
        return 'Stream ist fMP4, aber die Playlist nennt kein Init-Segment (#EXT-X-MAP) — nicht verarbeitbar'
    return ''


_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'no tfhd|trun track id unknown|could not find corresponding trex', re.I),
     'Stream ist fMP4 und das Init-Segment fehlte'),
    (re.compile(r'HTTP (Error )?410|\b410\b.*Gone|Server returned 4XX', re.I),
     'CDN lehnt die Anfrage ab (Link abgelaufen oder Download-Programm erkannt) — '
     'Video neu abspielen und erneut senden'),
    (re.compile(r'HTTP (Error )?403|\b403\b.*Forbidden|Server returned 403', re.I),
     'CDN verweigert den Zugriff (403) — Token/Referer/Cookies passen nicht. '
     'Video auf der Originalseite abspielen und erneut senden'),
    (re.compile(r'HTTP (Error )?404|Server returned 404', re.I),
     'Playlist oder Segment nicht gefunden (404) — Link abgelaufen, erneut senden'),
    (re.compile(r'HTTP (Error )?401|Server returned 401', re.I),
     'CDN verlangt eine Anmeldung (401) — im Browser eingeloggt abspielen und erneut senden'),
    (re.compile(r'Invalid data found when processing input|moov atom not found', re.I),
     'ffmpeg konnte die Daten nicht lesen — Fehlerseite statt Video, abgebrochener Download, '
     'verschlüsseltes Init-Segment oder ein Codec, den ffmpeg nicht kennt'),
    (re.compile(r'Name or service not known|getaddrinfo failed|Temporary failure in name resolution', re.I),
     'Server kann den CDN-Host nicht auflösen (DNS) — Netzwerk des NAS prüfen'),
    (re.compile(r'CERTIFICATE_VERIFY_FAILED|certificate verify failed', re.I),
     'TLS-Zertifikat des CDN wird nicht akzeptiert'),
    # Local processing limits first: "ffmpeg concat timeout (>30 min)" is not the CDN's fault.
    (re.compile(r'(ffmpeg|rerender|trim|concat|remux)[^|]*timeout|timeout \(>', re.I),
     'Verarbeitung mit ffmpeg hat zu lange gedauert — kürzeren Clip oder einen Modus '
     'ohne Re-Encode versuchen'),
    (re.compile(r'timed out|ETIMEDOUT|connection timeout', re.I),
     'CDN antwortet zu langsam (Timeout) — später erneut senden'),
]


def explain_failure(message: str) -> str:
    """Prefix a raw technical error with plain-language advice when we recognise it."""
    msg = (message or '').strip()
    if not msg or msg.startswith('Hinweis:'):
        return msg
    for pattern, hint in _HINTS:
        if pattern.search(msg):
            return f'Hinweis: {hint}. (technisch: {msg[:300]})'
    return msg
