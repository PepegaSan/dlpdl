"""Start the backend with the PC-render configuration written by setup-pc.ps1.

`pythonw -m backend.pc_render` runs without a console window (autostart task,
Start-menu shortcut); output then goes to pc-render.log next to the config.
`python -m backend.pc_render` (start.bat) logs to the console as well.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import sys
from pathlib import Path

CONFIG_ENV = 'CLIP_DIRECT_PC_CONFIG'
CONFIG_NAME = 'pc-render.json'
LOG_NAME = 'pc-render.log'

# config key -> environment variable read by backend.main at import time
ENV_FOR_KEY = {
    'downloadDir': 'DOWNLOAD_DIR',
    'tempDir': 'TEMP_DIR',
    'port': 'PORT',
    'bindHost': 'HOST',
    'token': 'CLIP_DIRECT_TOKEN',
}


def config_dir() -> Path:
    base = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), '.config')
    return Path(base) / 'clip-direct'


def config_path() -> Path:
    override = os.environ.get(CONFIG_ENV)
    return Path(override) if override else config_dir() / CONFIG_NAME


def load_config(path: Path | None = None) -> dict:
    # Windows PowerShell 5.1 writes a UTF-8 BOM with -Encoding UTF8; utf-8-sig accepts both.
    with open(path or config_path(), encoding='utf-8-sig') as fh:
        return json.load(fh)


def apply_config(cfg: dict, environ: dict | None = None) -> dict:
    """Put the config into the environment; variables set explicitly win."""
    env = os.environ if environ is None else environ
    for key, var in ENV_FOR_KEY.items():
        value = cfg.get(key)
        if value is None or value == '':
            continue
        env.setdefault(var, str(value))
    return env


def _setup_logging(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s')
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    file_handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=2_000_000, backupCount=2, encoding='utf-8',
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)
    if sys.stderr is not None:
        console = logging.StreamHandler()
        console.setFormatter(fmt)
        root.addHandler(console)
    else:
        # pythonw has no console: stray prints and tracebacks go to the log too.
        stream = open(log_path, 'a', encoding='utf-8', buffering=1)
        sys.stdout = stream
        sys.stderr = stream


def _suppress_child_error_dialogs() -> None:
    """A crashing ffmpeg/ffprobe must fail the job, not block it with a modal
    "Application Error" box nobody sees behind a windowless instance. The error
    mode is inherited by child processes."""
    if sys.platform != 'win32':
        return
    try:
        import ctypes

        sem_failcriticalerrors = 0x0001
        sem_nogpfaulterrorbox = 0x0002
        sem_noopenfileerrorbox = 0x8000
        ctypes.windll.kernel32.SetErrorMode(sem_failcriticalerrors | sem_nogpfaulterrorbox | sem_noopenfileerrorbox)
    except Exception:  # pragma: no cover - best effort
        pass


def main() -> None:
    path = config_path()
    _setup_logging(path.with_name(LOG_NAME))
    _suppress_child_error_dialogs()
    if not path.is_file():
        logging.getLogger('clip_direct').error('no PC-render config at %s — run setup-pc.ps1 first', path)
        sys.exit(2)
    apply_config(load_config(path))
    logging.getLogger('clip_direct').info('PC render instance, config %s', path)
    from .main import main as run_backend  # reads the environment at import time

    run_backend()


if __name__ == '__main__':
    main()
