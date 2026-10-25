import json
import subprocess
import sys

from backend import hls_clipper, pc_render


def test_ffmpeg_children_get_no_console_window_and_no_inherited_stdin():
    kwargs = hls_clipper.spawn_kwargs()
    assert kwargs['stdin'] is subprocess.DEVNULL
    if sys.platform == 'win32':
        assert kwargs['creationflags'] & subprocess.CREATE_NO_WINDOW
    else:
        assert 'creationflags' not in kwargs


def test_config_maps_onto_backend_environment_without_overriding_explicit_values():
    cfg = {
        'downloadDir': r'\\nas\docker\clip-direct\downloads',
        'tempDir': r'C:\Users\me\AppData\Local\clip-direct\tmp',
        'port': 8090,
        'bindHost': '127.0.0.1',
        'token': '',
        'repo': r'E:\clip-direct',
    }
    env = pc_render.apply_config(cfg, {'PORT': '9000'})
    assert env['DOWNLOAD_DIR'] == cfg['downloadDir']
    assert env['TEMP_DIR'] == cfg['tempDir']
    assert env['HOST'] == '127.0.0.1'
    # an explicitly set variable wins, an empty token sets nothing
    assert env['PORT'] == '9000'
    assert 'CLIP_DIRECT_TOKEN' not in env


def test_config_path_can_be_overridden_for_tests(tmp_path, monkeypatch):
    path = tmp_path / 'pc.json'
    # written like Windows PowerShell 5.1 does it: with a UTF-8 BOM
    path.write_text(json.dumps({'downloadDir': 'X:\\dl', 'port': 8098}), encoding='utf-8-sig')
    monkeypatch.setenv(pc_render.CONFIG_ENV, str(path))
    assert pc_render.config_path() == path
    assert pc_render.load_config()['port'] == 8098
    monkeypatch.delenv(pc_render.CONFIG_ENV)
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    assert pc_render.config_path() == tmp_path / 'clip-direct' / 'pc-render.json'
