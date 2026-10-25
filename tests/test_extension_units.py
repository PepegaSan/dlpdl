"""Extension helpers without a DOM, run under Node against the real modules."""

import json
import os
import pathlib
import shutil
import subprocess

import pytest

LIB = pathlib.Path(__file__).resolve().parent.parent / 'extension' / 'lib'

pytestmark = pytest.mark.skipif(not shutil.which('node'), reason='node not installed')


def _node(script: str, **modules: str) -> dict:
    """Run an ES-module snippet; `__NAME__` placeholders become file URLs of lib modules."""
    for name, filename in modules.items():
        script = script.replace(f'__{name}__', json.dumps((LIB / filename).as_uri()))
    proc = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True, text=True, timeout=60, cwd=os.fspath(LIB),
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_referer_keeps_the_players_own_referer_for_same_domain_cdns():
    res = _node('''
import { httpHeadersForStream } from __HEADERS__;
const page = 'https://tube-site.com/video/123';
const referer = (url, observed) => httpHeadersForStream({ url, referer: observed }, page, page).Referer;
console.log(JSON.stringify({
  sameHost: referer('https://hoster.com/hls/v/abc/index.m3u8', 'https://hoster.com/e/abc'),
  apexToCdn: referer('https://cdn.hoster.com/hls/abc/index.m3u8', 'https://hoster.com/e/abc'),
  kvs: referer('https://cdn.tnmr.org/hls2/x/index.m3u8?t=1&s=2&e=3', 'https://cdn.tnmr.org/embed/x'),
}));
''', HEADERS='stream-headers.js')
    assert res['sameHost'] == 'https://hoster.com/e/abc'
    assert res['apexToCdn'] == 'https://hoster.com/e/abc'
    # KVS CDNs reject their own host as Referer: there the HTML page wins.
    assert res['kvs'] == 'https://tube-site.com/video/123'


def test_stream_list_keeps_the_playlist_when_fragments_flood_in():
    res = _node('''
globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };
const { TabSessionStore } = await import(__SESSION__);
const store = new TabSessionStore();
store.addStream(7, { url: 'https://cdn.hoster.com/hls/abc/master.m3u8', kind: 'hls', ts: 1 });
for (let i = 1; i <= 40; i += 1) {
  store.addStream(7, { url: `https://cdn.hoster.com/hls/abc/seg-${i}.mp4`, kind: 'file', ts: 1 + i });
}
const list = store.streams(7);
console.log(JSON.stringify({
  n: list.length,
  playlists: list.filter((s) => s.kind === 'hls').length,
  newest: list[0].url,
}));
''', SESSION='tab-session.js')
    assert res['n'] == 30
    assert res['playlists'] == 1
    assert res['newest'].endswith('seg-40.mp4')


def test_forbidden_segment_is_not_retried_and_stops_the_other_workers():
    res = _node('''
import { createServer } from 'node:http';
const { downloadHlsWindows } = await import(__FETCH__);
const hits = [];
let rejected = false;
const server = createServer((req, res) => {
  hits.push({ url: req.url, late: rejected });
  if (req.url === '/index.m3u8') {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4'];
    for (let i = 0; i < 12; i += 1) lines.push('#EXTINF:4,', `seg${i}.ts`);
    lines.push('#EXT-X-ENDLIST', '');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(lines.join('\\n'));
  } else if (req.url === '/seg0.ts') {
    res.writeHead(403);
    res.end('forbidden');
  } else {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(1880, 0x47));
    }, 300);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let error = '';
try {
  await downloadHlsWindows(`http://127.0.0.1:${server.address().port}/index.m3u8`, [{ start: 0, end: 48 }]);
} catch (err) {
  rejected = true;
  error = err.message;
}
await new Promise((r) => setTimeout(r, 1500));
const seg = hits.filter((h) => h.url !== '/index.m3u8');
console.log(JSON.stringify({
  error,
  forbiddenRequests: seg.filter((h) => h.url === '/seg0.ts').length,
  afterRejection: seg.filter((h) => h.late).length,
  total: seg.length,
}));
server.close();
''', FETCH='hls-browser-fetch.js')
    assert 'HTTP 403' in res['error']
    assert res['forbiddenRequests'] == 1
    assert res['afterRejection'] == 0
    # seg0 plus whatever the other two workers had in flight
    assert res['total'] <= 4
