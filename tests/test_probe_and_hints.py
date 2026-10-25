import pytest

from backend.diagnostics import Diagnostics, redact_text, redact_url
from backend.media_probe import classify_media_bytes, explain_failure, preflight_problem


def _ts(packets: int = 4, prefix: bytes = b'') -> bytes:
    return prefix + (b'\x47' + b'\x00' * 187) * packets


@pytest.mark.parametrize('data,kind', [
    (_ts(), 'ts'),
    (_ts(prefix=b'\x89PNG fake image header' * 3), 'ts'),
    (b'\x00\x00\x00\x18ftypisom' + b'\x00' * 32, 'fmp4-init'),
    (b'\x00\x00\x00\x18moof' + b'\x00' * 32, 'fmp4-fragment'),
    (b'\x00\x00\x00\x18styp' + b'\x00' * 32, 'fmp4-fragment'),
    (b'  <!DOCTYPE html><html><body>403</body></html>', 'html'),
    (b'{"error": "expired"}', 'json'),
    (b'ID3\x04\x00\x00\x00\x00\x00\x02ab' + b'\xff\xf1\x50\x80' + b'\x00' * 20, 'aac'),
    (b'', 'empty'),
    (b'random bytes', 'unknown'),
])
def test_classify_media_bytes(data, kind):
    assert classify_media_bytes(data) == kind


def test_preflight_rules():
    assert 'Webseite' in preflight_problem('html', False)
    assert 'Init' in preflight_problem('fmp4-fragment', False)
    assert preflight_problem('fmp4-fragment', True) == ''
    assert preflight_problem('ts', False) == ''
    assert preflight_problem('unknown', False) == ''


@pytest.mark.parametrize('raw,needle', [
    ('ffmpeg concat failed: [mov] no tfhd found', 'Init-Segment'),
    ('segment download failed: HTTP Error 410: Gone', 'lehnt die Anfrage ab'),
    ('preserve copy failed: HTTP 403', '403'),
    ('Server returned 404 Not Found', '404'),
    ('urlopen error [Errno -2] Name or service not known', 'DNS'),
    ('The read operation timed out', 'CDN antwortet zu langsam'),
    ('<urlopen error timed out>', 'CDN antwortet zu langsam'),
    ('rerender timeout (>30 min)', 'Verarbeitung mit ffmpeg'),
    ('ffmpeg concat timeout (>30 min)', 'Verarbeitung mit ffmpeg'),
    ('exact trim timeout', 'Verarbeitung mit ffmpeg'),
    ('ffmpeg timeout (>1800s)', 'Verarbeitung mit ffmpeg'),
    ('ffmpeg-copy: Invalid data found when processing input', 'Codec'),
])
def test_explain_failure_adds_hint(raw, needle):
    out = explain_failure(raw)
    assert out.startswith('Hinweis:') and needle in out and raw[:40] in out


def test_local_ffmpeg_timeouts_are_not_blamed_on_the_cdn():
    for raw in ('rerender timeout (>30 min)', 'ffmpeg copy remux timeout (>30 min)'):
        assert 'CDN' not in explain_failure(raw), raw


def test_explain_failure_leaves_unknown_and_is_idempotent():
    assert explain_failure('something odd') == 'something odd'
    once = explain_failure('HTTP Error 403: Forbidden')
    assert explain_failure(once) == once


def test_redaction_masks_query_values():
    assert redact_url('https://cdn.x/a/b.m3u8?h=SECRET&e=123') == 'https://cdn.x/a/b.m3u8?h=…&e=…'
    text = redact_text('#EXTINF:2,\nhttps://cdn.x/s.ts?token=SECRET\n')
    assert 'SECRET' not in text and 'token=…' in text


def test_diagnostics_redacts_and_caps():
    diag = Diagnostics()
    for i in range(300):
        diag.note('http', url=f'https://cdn.x/{i}.ts?sig=SECRET')
    report = diag.to_dict()
    assert len(report['events']) == 200
    assert report['counters']['dropped_events'] == 100
    assert 'SECRET' not in str(report)
