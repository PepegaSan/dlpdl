"""The extension's browser HLS fetch, run under Node against the local HLS server."""

import json
import os
import shutil
import subprocess

import pytest
from conftest import needs_ffmpeg, probe

from backend.hls_clipper import remux_browser_payload

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE = os.path.join(ROOT, 'extension', 'lib', 'hls-browser-fetch.js')
RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'browser_fetch_runner.mjs')

pytestmark = [
    needs_ffmpeg,
    pytest.mark.skipif(not shutil.which('node'), reason='node not installed'),
]


def _browser_fetch(url, windows, out):
    proc = subprocess.run(
        ['node', RUNNER, MODULE, url, json.dumps(windows), str(out)],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


@pytest.mark.parametrize('stream', ['ts', 'fmp4', 'byterange', 'fmp4_byterange'])
@pytest.mark.parametrize('prefix', ['range', 'plain'])
def test_browser_fetch_single_window(hls_server, tmp_path, stream, prefix):
    raw = tmp_path / 'browser.bin'
    info = _browser_fetch(f'{hls_server}/{prefix}/{stream}/index.m3u8', [{'start': 5, 'end': 11}], raw)
    assert info['timelineStart'] == pytest.approx(4.0, abs=0.1)
    out = str(tmp_path / 'out.mp4')
    ok, msg = remux_browser_payload(str(raw), out)
    assert ok, msg
    duration, kinds = probe(out)
    assert kinds == {'video', 'audio'}
    assert 5.5 <= duration <= 8.5, duration


@pytest.mark.parametrize('stream', ['byterange', 'fmp4_byterange'])
def test_browser_fetch_merge_windows(hls_server, tmp_path, stream):
    raw = tmp_path / 'browser.bin'
    info = _browser_fetch(
        f'{hls_server}/plain/{stream}/index.m3u8',
        [{'start': 2, 'end': 4}, {'start': 12, 'end': 14}],
        raw,
    )
    assert len(info['parts']) == 2
    assert [p['timelineStart'] for p in info['parts']] == pytest.approx([2.0, 12.0], abs=0.1)
    data = raw.read_bytes()
    first = info['parts'][0]['size']
    for i, chunk in enumerate((data[:first], data[first:])):
        part = tmp_path / f'part{i}.bin'
        part.write_bytes(chunk)
        out = str(tmp_path / f'part{i}.mp4')
        ok, msg = remux_browser_payload(str(part), out)
        assert ok, msg
        assert probe(out)[1] == {'video', 'audio'}
