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


@pytest.mark.parametrize(
    'stream', ['ts', 'fmp4', 'byterange', 'fmp4_byterange', 'aes', 'discontinuity', 'separate_audio'],
)
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


def test_redirected_playlist_resolves_segments_against_final_url(hls_server, tmp_path):
    ok, msg, out = _clip(hls_server, tmp_path, 'ts', 'preserve', prefix='redirect')
    assert ok, msg
    assert 'ffmpeg' not in msg, f'segments must come from the redirect target, not the fallback: {msg}'
    assert probe(out)[1] == {'video', 'audio'}


def test_bom_crlf_playlist_clips_like_a_plain_one(hls_server, tmp_path):
    ok, msg, out = _clip(hls_server, tmp_path, 'bom', 'exact')
    assert ok, msg
    assert 'ffmpeg' not in msg, msg
    duration, kinds = probe(out)
    assert kinds == {'video', 'audio'}
    assert abs(duration - (END - START)) < 0.5, (duration, msg)


def test_exact_end_past_stream_end_is_not_reported_too_short(hls_server, tmp_path):
    out = str(tmp_path / 'tail.mp4')
    ok, msg = clip_hls_to_file(
        f'{hls_server}/range/ts/index.m3u8', {}, 15.0, 40.0,
        str(tmp_path / 'raw.ts'), out, encode_mode='exact',
    )
    assert ok, msg
    duration, _ = probe(out)
    assert 4.0 <= duration <= 5.6, (duration, msg)


def test_encrypted_audio_rendition_fails_clearly(hls_server, tmp_path):
    ok, msg, out = _clip(hls_server, tmp_path, 'separate_audio_drm', 'preserve')
    assert not ok
    assert 'Tonspur' in msg and 'SAMPLE-AES' in msg, msg
    assert not os.path.exists(out)


@pytest.mark.parametrize('mode', ['preserve', 'exact'])
def test_mp3_audio_ts_clips_without_the_aac_bitstream_filter(hls_server, tmp_path, mode):
    ok, msg, out = _clip(hls_server, tmp_path, 'ts_mp3', mode)
    assert ok, msg
    assert 'ffmpeg' not in msg, msg
    duration, kinds = probe(out)
    assert kinds == {'video', 'audio'}, msg
    assert END - START - 0.5 <= duration <= END - START + 4.5, (duration, msg)


def test_truncated_segment_is_retried_not_kept(hls_server):
    fetcher = HttpFetcher({})
    full = fetcher.get_bytes(f'{hls_server}/range/ts/seg_002.ts')
    assert fetcher.get_bytes(f'{hls_server}/flaky/ts/seg_002.ts') == full


def test_persistently_truncated_segment_raises(hls_server):
    fetcher = HttpFetcher({})
    with pytest.raises(RuntimeError, match='unvollständig'):
        fetcher.get_bytes(f'{hls_server}/truncated/ts/seg_002.ts')


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
