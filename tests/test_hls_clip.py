"""End-to-end clips against locally generated HLS streams (needs ffmpeg)."""

import os

import pytest
from conftest import needs_ffmpeg, probe

from backend import diagnostics
from backend.hls_clipper import HttpFetcher, clip_hls_to_file, remux_browser_payload

pytestmark = needs_ffmpeg

START, END = 5.0, 11.0


def _clip(base, tmp_path, stream, mode, prefix='range'):
    out = str(tmp_path / f'{stream}-{mode}.mp4')
    ok, msg = clip_hls_to_file(
        f'{base}/{prefix}/{stream}/index.m3u8', {}, START, END,
        str(tmp_path / 'raw.ts'), out, encode_mode=mode,
    )
    return ok, msg, out


@pytest.mark.parametrize('stream', ['ts', 'fmp4', 'byterange', 'aes', 'discontinuity', 'separate_audio'])
@pytest.mark.parametrize('mode', ['preserve', 'exact'])
def test_clip_variants(hls_server, tmp_path, stream, mode):
    ok, msg, out = _clip(hls_server, tmp_path, stream, mode)
    assert ok, msg
    assert 'ffmpeg' not in msg, f'segment path should not need the ffmpeg fallback: {msg}'
    duration, kinds = probe(out)
    assert kinds == {'video', 'audio'}, msg
    if mode == 'exact':
        assert abs(duration - (END - START)) < 0.5, (duration, msg)
    else:
        assert END - START - 0.3 <= duration <= END - START + 4.5, (duration, msg)


def test_byterange_works_when_cdn_ignores_range(hls_server, tmp_path):
    ok, msg, out = _clip(hls_server, tmp_path, 'byterange', 'preserve', prefix='plain')
    assert ok, msg
    assert probe(out)[1] == {'video', 'audio'}


def test_cdn_rejecting_python_falls_back_to_ffmpeg(hls_server, tmp_path):
    ok, msg, out = _clip(hls_server, tmp_path, 'ts', 'preserve', prefix='needrange')
    assert ok, msg
    assert 'ffmpeg' in msg
    assert probe(out)[1] == {'video', 'audio'}


def test_html_instead_of_video_fails_fast_with_advice(hls_server, tmp_path):
    diag = diagnostics.Diagnostics()
    diagnostics.set_diagnostics(diag)
    try:
        ok, msg, out = _clip(hls_server, tmp_path, 'ts', 'exact', prefix='html')
    finally:
        diagnostics.set_diagnostics(None)
    assert not ok
    assert 'Webseite' in msg
    assert not os.path.exists(out)
    kinds = [e['kind'] for e in diag.to_dict()['events']]
    assert 'preflight' in kinds and 'ffmpeg_failed' not in kinds


def test_browser_ingest_fmp4_payload(hls_server, tmp_path):
    fetcher = HttpFetcher({})
    base = f'{hls_server}/range/fmp4'
    payload = fetcher.get_bytes(f'{base}/init.mp4') + b''.join(
        fetcher.get_bytes(f'{base}/seg_{i:03d}.m4s') for i in range(2, 5)
    )
    raw = tmp_path / 'browser.bin'
    raw.write_bytes(payload)
    out = str(tmp_path / 'ingest.mp4')
    ok, msg = remux_browser_payload(str(raw), out)
    assert ok, msg
    assert probe(out)[1] == {'video', 'audio'}
