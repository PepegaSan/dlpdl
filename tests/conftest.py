"""Local HLS fixtures: real streams generated with ffmpeg, served by a tiny HTTP
server whose behaviour per URL prefix mimics hoster quirks:

  /plain/...      200 for everything, ignores Range (like many CDNs)
  /range/...      honours Range with 206
  /needrange/...  media without a Range header -> 410 (phncdn vs. Python)
  /html/...       media requests return an HTML error page
  /redirect/...   .m3u8 -> 302 to /range/..., media 404 (relative URIs must follow the redirect)
  /flaky/...      first media response per URL is cut short, Range -> 403, then complete
  /truncated/...  every media response is cut short, Range -> 403
  /expire/...     segments from seg_004 on return an HTML page (token expired mid-download)
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from Cryptodome.Cipher import AES

from backend import hls_clipper

HAS_FFMPEG = bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason='ffmpeg/ffprobe not installed')

AES_KEY = bytes(range(16))


def _ffmpeg(*args: str, cwd: str) -> None:
    proc = subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', *args],
        cwd=cwd, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg {" ".join(args)} failed: {proc.stderr}')


def _hls(src: str, out_dir: str, *extra: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    _ffmpeg(
        '-i', src, '-c', 'copy',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        *extra, 'index.m3u8',
        cwd=out_dir,
    )


def _build_streams(root: str) -> None:
    src = os.path.join(root, 'src.mp4')
    _ffmpeg(
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
        '-c:a', 'aac', '-shortest', src,
        cwd=root,
    )
    _hls(src, os.path.join(root, 'ts'), '-hls_segment_filename', 'seg_%03d.ts')
    # MP3 audio in TS: `-bsf:a aac_adtstoasc` is refused for it by modern ffmpeg.
    mp3_dir = os.path.join(root, 'ts_mp3')
    os.makedirs(mp3_dir)
    _ffmpeg(
        '-i', src, '-c:v', 'copy', '-c:a', 'libmp3lame',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', 'seg_%03d.ts', 'index.m3u8',
        cwd=mp3_dir,
    )
    _hls(
        src, os.path.join(root, 'fmp4'),
        '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', 'seg_%03d.m4s',
    )
    _hls(src, os.path.join(root, 'byterange'), '-hls_flags', 'single_file')
    _hls(
        src, os.path.join(root, 'fmp4_byterange'),
        '-hls_segment_type', 'fmp4', '-hls_flags', 'single_file',
    )

    aes_dir = os.path.join(root, 'aes')
    os.makedirs(aes_dir)
    with open(os.path.join(aes_dir, 'clip.key'), 'wb') as fh:
        fh.write(AES_KEY)
    # No IV line: segments use the media sequence number as IV (HLS default).
    with open(os.path.join(aes_dir, 'keyinfo.txt'), 'w', encoding='utf-8') as fh:
        fh.write(f'clip.key\n{os.path.join(aes_dir, "clip.key")}\n')
    _hls(src, aes_dir, '-hls_key_info_file', 'keyinfo.txt', '-hls_segment_filename', 'seg_%03d.ts')

    # Ad-insertion style: the same five TS segments twice, timestamps restart.
    ts_lines = open(os.path.join(root, 'ts', 'index.m3u8'), encoding='utf-8').read().splitlines()
    body: list[str] = []
    pairs = [(ts_lines[i], ts_lines[i + 1]) for i, line in enumerate(ts_lines) if line.startswith('#EXTINF')]
    for extinf, uri in pairs[:5]:
        body += [extinf, f'../ts/{uri}']
    body.append('#EXT-X-DISCONTINUITY')
    for extinf, uri in pairs[:5]:
        body += [extinf, f'../ts/{uri}']
    disc_dir = os.path.join(root, 'discontinuity')
    os.makedirs(disc_dir)
    with open(os.path.join(disc_dir, 'index.m3u8'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
                            '#EXT-X-PLAYLIST-TYPE:VOD', *body, '#EXT-X-ENDLIST', '']))

    # Windows-made playlist: UTF-8 BOM and CRLF line endings.
    bom_dir = os.path.join(root, 'bom')
    os.makedirs(bom_dir)
    with open(os.path.join(bom_dir, 'index.m3u8'), 'w', encoding='utf-8-sig', newline='\r\n') as fh:
        fh.write('\n'.join(line if line.startswith('#') else f'../ts/{line}' for line in ts_lines) + '\n')

    audio_dir = os.path.join(root, 'separate_audio')
    os.makedirs(audio_dir)
    _ffmpeg(
        '-i', src, '-map', '0:v', '-map', '0:a', '-c', 'copy',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes',
        '-master_pl_name', 'index.m3u8',
        '-hls_segment_filename', 'stream_%v/seg_%03d.ts',
        'stream_%v/media.m3u8',
        cwd=audio_dir,
    )

    # Same video, but the audio rendition is SAMPLE-AES (DRM) encrypted.
    drm_dir = os.path.join(root, 'separate_audio_drm')
    os.makedirs(drm_dir)
    master = open(os.path.join(audio_dir, 'index.m3u8'), encoding='utf-8').read()
    master = master.replace('stream_0/media.m3u8', '../separate_audio/stream_0/media.m3u8')
    master = master.replace('stream_1/media.m3u8', 'audio_drm.m3u8')
    with open(os.path.join(drm_dir, 'index.m3u8'), 'w', encoding='utf-8') as fh:
        fh.write(master)
    audio_lines = open(os.path.join(audio_dir, 'stream_1', 'media.m3u8'), encoding='utf-8').read().splitlines()
    drm_audio: list[str] = []
    for line in audio_lines:
        drm_audio.append(line if line.startswith('#') else f'../separate_audio/stream_1/{line}')
        if line == '#EXTM3U':
            drm_audio.append('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm"')
    with open(os.path.join(drm_dir, 'audio_drm.m3u8'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(drm_audio) + '\n')

    # AES-128 with an explicit IV, then a key change (IV = sequence number) mid-stream.
    rot_dir = os.path.join(root, 'aes_rot')
    os.makedirs(rot_dir)
    k1, k2 = bytes(range(16)), bytes(range(16, 32))
    iv1 = bytes.fromhex('000102030405060708090a0b0c0d0e0f')
    for name, key in (('k1.key', k1), ('k2.key', k2)):
        with open(os.path.join(rot_dir, name), 'wb') as fh:
            fh.write(key)
    rot = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
           '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
    for index, (extinf, uri) in enumerate(pairs):
        if index == 0:
            rot.append(f'#EXT-X-KEY:METHOD=AES-128,URI="k1.key",IV=0x{iv1.hex()}')
        if index == 5:
            rot.append('#EXT-X-KEY:METHOD=AES-128,URI="k2.key"')
        key, iv = (k1, iv1) if index < 5 else (k2, index.to_bytes(16, 'big'))
        with open(os.path.join(root, 'ts', uri), 'rb') as fh:
            plain = fh.read()
        pad = 16 - len(plain) % 16
        with open(os.path.join(rot_dir, uri), 'wb') as fh:
            fh.write(AES.new(key, AES.MODE_CBC, iv).encrypt(plain + bytes([pad]) * pad))
        rot += [extinf, uri]
    with open(os.path.join(rot_dir, 'index.m3u8'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join([*rot, '#EXT-X-ENDLIST', '']))

    # fMP4 whose second half (another encode, own init) follows a discontinuity.
    src_b = os.path.join(root, 'src_b.mp4')
    _ffmpeg(
        '-i', src, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'copy', src_b,
        cwd=root,
    )
    _hls(
        src_b, os.path.join(root, 'fmp4_b'),
        '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', 'seg_%03d.m4s',
    )

    def _extinf_pairs(name: str) -> list[tuple[str, str]]:
        lines = open(os.path.join(root, name, 'index.m3u8'), encoding='utf-8').read().splitlines()
        return [(lines[i], lines[i + 1]) for i, line in enumerate(lines) if line.startswith('#EXTINF')]

    fdisc = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD',
             '#EXT-X-MAP:URI="../fmp4/init.mp4"']
    for extinf, uri in _extinf_pairs('fmp4')[:5]:
        fdisc += [extinf, f'../fmp4/{uri}']
    fdisc += ['#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="../fmp4_b/init.mp4"']
    for extinf, uri in _extinf_pairs('fmp4_b')[:5]:
        fdisc += [extinf, f'../fmp4_b/{uri}']
    fdisc_dir = os.path.join(root, 'fmp4_disc')
    os.makedirs(fdisc_dir)
    with open(os.path.join(fdisc_dir, 'index.m3u8'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join([*fdisc, '#EXT-X-ENDLIST', '']))

    # Separate audio rendition whose segments (3 s) do not line up with the video's (2 s).
    len_dir = os.path.join(root, 'separate_audio_len')
    os.makedirs(os.path.join(len_dir, 'video'))
    os.makedirs(os.path.join(len_dir, 'audio'))
    _ffmpeg(
        '-i', src, '-an', '-c:v', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', 'video/seg_%03d.ts', 'video/index.m3u8', cwd=len_dir,
    )
    _ffmpeg(
        '-i', src, '-vn', '-c:a', 'aac', '-f', 'hls', '-hls_time', '3', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', 'audio/seg_%03d.ts', 'audio/index.m3u8', cwd=len_dir,
    )
    with open(os.path.join(len_dir, 'index.m3u8'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join([
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x240,CODECS="avc1.42e01e,mp4a.40.2",AUDIO="aud"',
            'video/index.m3u8',
            '',
        ]))


class _Handler(BaseHTTPRequestHandler):
    root = ''
    hits: dict[str, int] = {}

    def log_message(self, *_args) -> None:
        pass

    def _send_cut_short(self, file_path: str) -> None:
        """Announce the full length, deliver half, drop the connection."""
        with open(file_path, 'rb') as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data[: len(data) // 2])
        self.close_connection = True

    def _send(self, status: int, data: bytes, ctype: str = 'application/octet-stream', extra=None) -> None:
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path.lstrip('/')
        mode, _, rel = path.partition('/')
        if mode == 'redirect':
            if rel.endswith('.m3u8'):
                self.send_response(302)
                self.send_header('Location', f'/range/{rel}')
                self.send_header('Content-Length', '0')
                self.end_headers()
            else:
                self._send(404, b'not found', 'text/plain')
            return
        file_path = os.path.normpath(os.path.join(self.root, rel))
        if not file_path.startswith(self.root) or not os.path.isfile(file_path):
            self._send(404, b'not found', 'text/plain')
            return
        is_media = not rel.endswith(('.m3u8', '.key'))
        rng = self.headers.get('Range')
        if mode in ('flaky', 'truncated') and is_media:
            if rng:
                self._send(403, b'no ranges', 'text/plain')
                return
            self.hits[path] = self.hits.get(path, 0) + 1
            if mode == 'truncated' or self.hits[path] == 1:
                self._send_cut_short(file_path)
                return
        expired = mode == 'expire' and is_media and (
            (match := re.search(r'seg_(\d+)\.', rel)) is not None and int(match.group(1)) >= 4
        )
        if (mode == 'html' and is_media) or expired:
            self._send(200, b'<!DOCTYPE html><html><body>Access denied</body></html>' + b' ' * 4096, 'text/html')
            return
        if mode == 'needrange' and is_media and not rng:
            self._send(410, b'gone', 'text/plain')
            return
        with open(file_path, 'rb') as fh:
            data = fh.read()
        ctype = 'application/vnd.apple.mpegurl' if rel.endswith('.m3u8') else 'application/octet-stream'
        if rng and mode in ('range', 'needrange'):
            start_s, _, end_s = rng.split('=', 1)[1].partition('-')
            start = int(start_s)
            end = int(end_s) if end_s else len(data) - 1
            self._send(206, data[start:end + 1], ctype,
                       {'Content-Range': f'bytes {start}-{end}/{len(data)}'})
            return
        self._send(200, data, ctype)


@pytest.fixture(scope='session')
def hls_server(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip('ffmpeg/ffprobe not installed')
    root = str(tmp_path_factory.mktemp('hls'))
    _build_streams(root)
    handler = type('Handler', (_Handler,), {'root': os.path.normpath(root)})
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    yield base
    server.shutdown()


@pytest.fixture(autouse=True)
def _no_fetch_delay(monkeypatch):
    monkeypatch.setattr(hls_clipper.HttpFetcher, '_throttle', lambda self: None)
    monkeypatch.setattr(hls_clipper.HttpFetcher, '_retry_wait', lambda self, attempt, exc=None: 0.0)


def probe(path: str) -> tuple[float, set[str]]:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
         '-of', 'default=nw=1', path],
        capture_output=True, text=True, check=True,
    ).stdout
    duration = 0.0
    kinds: set[str] = set()
    for line in out.splitlines():
        key, _, value = line.partition('=')
        if key == 'duration':
            duration = float(value)
        elif key == 'codec_type':
            kinds.add(value)
    return duration, kinds
