import pytest

from backend.hls_clipper import (
    InitSection,
    parse_media_playlist,
    resolve_hls_uri,
    segments_with_preroll,
    segments_for_window,
    select_master_variant,
)

BASE = 'https://cdn.example/path/index.m3u8'


def test_bom_and_crlf_do_not_create_a_phantom_segment():
    parsed = parse_media_playlist(
        '﻿#EXTM3U\r\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\r\n'
        '#EXTINF:2,\r\na.ts\r\n#EXTINF:2,\r\nb.ts\r\n',
        BASE,
    )
    assert [s.uri.rsplit('/', 1)[1] for s in parsed.segments] == ['a.ts', 'b.ts']
    # the sequence number is the AES IV: a phantom segment 0 would shift every IV
    assert [s.sequence for s in parsed.segments] == [0, 1]
    video, _ = select_master_variant('﻿#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', BASE)
    assert video == 'https://cdn.example/path/v.m3u8'


def test_malformed_iv_is_a_clear_parse_error():
    with pytest.raises(ValueError, match='IV'):
        parse_media_playlist(
            '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0xABC\n#EXTINF:2,\na.ts\n', BASE,
        )


def test_signed_query_stays_on_the_playlist_host():
    signed = f'{BASE}?t=1&s=2'
    assert resolve_hls_uri(signed, 'seg1.ts') == 'https://cdn.example/path/seg1.ts?t=1&s=2'
    assert resolve_hls_uri(signed, '//other.cdn/seg1.ts') == 'https://other.cdn/seg1.ts'
    assert resolve_hls_uri(signed, 'data:text/plain;base64,AAAA') == 'data:text/plain;base64,AAAA'


def test_signed_query_is_inherited_by_relative_uris():
    parsed = parse_media_playlist(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n', f'{BASE}?token=abc',
    )
    assert parsed.segments[0].uri.endswith('a.m4s?token=abc')
    assert parsed.init_uri.endswith('init.mp4?token=abc')


def test_byterange_offsets_and_sequence():
    parsed = parse_media_playlist(
        '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n'
        '#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\nall.ts\n'
        '#EXTINF:2,\n#EXT-X-BYTERANGE:50\nall.ts\n'
        '#EXTINF:2,\n#EXT-X-BYTERANGE:30@500\nall.ts\n',
        BASE,
    )
    assert [s.byterange for s in parsed.segments] == [(100, 0), (50, 100), (30, 500)]
    assert [s.sequence for s in parsed.segments] == [7, 8, 9]
    assert parsed.segments[0].uri == 'https://cdn.example/path/all.ts'


def test_aes_key_with_and_without_iv():
    parsed = parse_media_playlist(
        '#EXTM3U\n'
        '#EXT-X-KEY:METHOD=AES-128,URI="k1.key"\n#EXTINF:2,\na.ts\n'
        '#EXT-X-KEY:METHOD=AES-128,URI="k2.key",IV=0x0000000000000000000000000000000F\n#EXTINF:2,\nb.ts\n'
        '#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nc.ts\n',
        BASE,
    )
    a, b, c = parsed.segments
    assert a.key.uri.endswith('/k1.key') and a.key.iv is None
    assert b.key.iv == (15).to_bytes(16, 'big')
    assert c.key is None
    assert not parsed.encrypted and parsed.key_method == 'AES-128'


def test_sample_aes_is_flagged_unsupported():
    parsed = parse_media_playlist(
        '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:2,\na.ts\n', BASE,
    )
    assert parsed.encrypted and parsed.key_method == 'SAMPLE-AES'


def test_multiple_maps_and_discontinuities():
    parsed = parse_media_playlist(
        '#EXTM3U\n#EXT-X-MAP:URI="init1.mp4"\n#EXTINF:2,\na.m4s\n#EXTINF:2,\nb.m4s\n'
        '#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init2.mp4",BYTERANGE="800@0"\n#EXTINF:2,\nc.m4s\n',
        BASE,
    )
    a, b, c = parsed.segments
    assert a.init == b.init == InitSection('https://cdn.example/path/init1.mp4')
    assert c.init == InitSection('https://cdn.example/path/init2.mp4', (800, 0))
    assert (a.discontinuity, c.discontinuity) == (0, 1)
    assert parsed.init_uri.endswith('init1.mp4')


def test_preroll_keeps_byterange_segments_of_same_file():
    parsed = parse_media_playlist(
        '#EXTM3U\n' + ''.join(f'#EXTINF:2,\n#EXT-X-BYTERANGE:10@{i * 10}\nall.ts\n' for i in range(6)),
        BASE,
    )
    picked = segments_for_window(parsed, 6.5, 8.0)
    assert len(segments_with_preroll(parsed, picked)) == len(picked) + 2


def test_master_prefers_resolution_then_bandwidth_and_picks_audio():
    master = (
        '#EXTM3U\n'
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=NO,URI="audio_en.m3u8"\n'
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="de",DEFAULT=YES,URI="audio_de.m3u8"\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="mp4a.40.2"\naudio_only.m3u8\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="aud"\nhd.m3u8\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720,AUDIO="aud"\nmid.m3u8\n'
    )
    video, audio = select_master_variant(master, BASE)
    assert video == 'https://cdn.example/path/hd.m3u8'
    assert audio == 'https://cdn.example/path/audio_de.m3u8'


def test_master_without_audio_group_has_no_audio_url():
    video, audio = select_master_variant(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhigh.m3u8\n', BASE,
    )
    assert video.endswith('high.m3u8') and audio is None
