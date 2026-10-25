"""The extension's browser HLS fetch, run under Node against the local HLS
server, then fed through the backend's real ingest path."""

import json
import os
import shutil
import subprocess

import pytest
from conftest import needs_ffmpeg, probe

from backend.clip_parse import parse_ingest_parts
from backend.downloader import JobRunner, JobSpec

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE = os.path.join(ROOT, 'extension', 'lib', 'hls-browser-fetch.js')
RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'browser_fetch_runner.mjs')

pytestmark = [
    needs_ffmpeg,
    pytest.mark.skipif(not shutil.which('node'), reason='node not installed'),
]

STREAMS = ['ts', 'fmp4', 'byterange', 'fmp4_byterange', 'aes', 'discontinuity', 'separate_audio']


def _browser_fetch(url, windows, out):
    proc = subprocess.run(
        ['node', RUNNER, MODULE, url, json.dumps(windows), str(out)],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _ingest(tmp_path, windows, info, raw, mode):
    """Same steps as POST /api/jobs + /ingest for a browser_fetch job."""
    runner = JobRunner(str(tmp_path / 'dl'), str(tmp_path / 'tmp'))
    merge = len(windows) > 1
    spec = JobSpec(
        url='https://cdn.example/index.m3u8',
        clip_start=None if merge else windows[0]['start'],
        clip_end=None if merge else windows[0]['end'],
        clip_ranges=[(w['start'], w['end']) for w in windows] if merge else [],
        merge_clips=merge,
        clip_encode_mode=mode,
        title='test',
    )
    job_id = runner.create_waiting_job(spec)
    assert runner.begin_ingest(job_id)[0]
    raw_path = os.path.join(runner.ingest_tmp_dir(job_id), 'browser.bin')
    shutil.copy(raw, raw_path)
    ok, msg = runner.ingest_browser_media(
        job_id, raw_path,
        timeline_start=info['timelineStart'],
        parts=parse_ingest_parts(info['query']) or None,
    )
    job = runner.get_job(job_id)
    assert ok, job['error'] or msg
    return runner.effective_filepath(runner._jobs[job_id]), msg


@pytest.mark.parametrize('stream', STREAMS)
@pytest.mark.parametrize('mode', ['preserve', 'exact'])
def test_browser_fetch_single_window(hls_server, tmp_path, stream, mode):
    windows = [{'start': 5, 'end': 11}]
    raw = tmp_path / 'browser.bin'
    info = _browser_fetch(f'{hls_server}/range/{stream}/index.m3u8', windows, raw)
    assert info['timelineStart'] == pytest.approx(4.0, abs=0.1)
    out, msg = _ingest(tmp_path, windows, info, raw, mode)
    duration, kinds = probe(out)
    assert kinds == {'video', 'audio'}, msg
    if mode == 'exact':
        assert abs(duration - 6.0) < 0.5, (duration, msg)
    else:
        assert 5.5 <= duration <= 8.5, (duration, msg)


@pytest.mark.parametrize('stream', ['byterange', 'fmp4_byterange', 'aes', 'discontinuity', 'separate_audio'])
def test_browser_fetch_merge_windows(hls_server, tmp_path, stream):
    windows = [{'start': 2, 'end': 4}, {'start': 12, 'end': 14}]
    raw = tmp_path / 'browser.bin'
    info = _browser_fetch(f'{hls_server}/plain/{stream}/index.m3u8', windows, raw)
    assert len(info['parts']) == 2
    assert [p['timelineStart'] for p in info['parts']] == pytest.approx([2.0, 12.0], abs=0.1)
    out, msg = _ingest(tmp_path, windows, info, raw, 'exact')
    duration, kinds = probe(out)
    assert kinds == {'video', 'audio'}, msg
    assert abs(duration - 4.0) < 0.6, (duration, msg)


def test_discontinuity_window_is_split_into_pieces(hls_server, tmp_path):
    info = _browser_fetch(
        f'{hls_server}/range/discontinuity/index.m3u8', [{'start': 8, 'end': 12}], tmp_path / 'b.bin',
    )
    pieces = info['parts'][0]['pieces']
    assert [p['kind'] for p in pieces] == ['v', 'v']


def test_separate_audio_piece_carries_its_timeline(hls_server, tmp_path):
    info = _browser_fetch(
        f'{hls_server}/range/separate_audio/index.m3u8', [{'start': 5, 'end': 11}], tmp_path / 'b.bin',
    )
    pieces = info['parts'][0]['pieces']
    assert [p['kind'] for p in pieces] == ['v', 'a']
    assert pieces[1]['timelineStart'] == pytest.approx(4.0, abs=0.1)


def test_parse_ingest_parts():
    parts = parse_ingest_parts('4.0:300:v100,v150,a50@3.98;12:500;bad;1:10:v5,x5')
    assert len(parts) == 2
    first, second = parts
    assert [p.kind for p in first.pieces] == ['v', 'v', 'a']
    assert first.pieces[2].timeline_start == pytest.approx(3.98)
    assert second.pieces == ()
    # pieces not adding up to the window size are rejected
    assert parse_ingest_parts('4:300:v100') == []
