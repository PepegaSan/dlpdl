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
import subprocess
import sys
import time
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


def parse_netstat_listener(text: str, port: int) -> int | None:
    """PID of the socket listening on `port` in `netstat -ano -p TCP` output.

    Matched by addresses only — the state column is localized ("ABHÖREN").
    """
    suffix = f':{port}'
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != 'TCP':
            continue
        local, remote, pid = parts[1], parts[2], parts[-1]
        if local.endswith(suffix) and remote.endswith(':0') and pid.isdigit() and int(pid) > 0:
            return int(pid)
    return None


def _port_listener_pid(port: int) -> int | None:
    if sys.platform != 'win32':
        return None
    try:
        out = subprocess.run(
            ['netstat', '-ano', '-p', 'TCP'], capture_output=True, text=True, timeout=15,
            stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
        ).stdout
    except Exception:
        return None
    return parse_netstat_listener(out, port)


def _process_image(pid: int) -> str:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
        return ''
    finally:
        kernel32.CloseHandle(handle)


def _take_over_port(port: int, log: logging.Logger) -> bool:
    """A start while a previous PC instance still holds the port is a restart:
    stop it (only if it is python/pythonw) and wait for the socket to close.
    Anything else on the port is reported, never killed."""
    pid = _port_listener_pid(port)
    if not pid or pid == os.getpid():
        return True
    image = os.path.basename(_process_image(pid)).lower()
    if image not in ('python.exe', 'pythonw.exe'):
        log.error('port %s is used by %s (PID %s) — pick another port: setup-pc.ps1 -Port …', port, image or '?', pid)
        return False
    log.info('previous instance PID %s holds port %s — stopping it (restart after update)', pid, port)
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
    if handle:
        kernel32.TerminateProcess(handle, 1)
        kernel32.CloseHandle(handle)
    for _ in range(20):
        time.sleep(0.25)
        if _port_listener_pid(port) in (None, os.getpid()):
            return True
    log.error('port %s still busy after stopping PID %s', port, pid)
    return False


def main() -> None:
    path = config_path()
    _setup_logging(path.with_name(LOG_NAME))
    _suppress_child_error_dialogs()
    if not path.is_file():
        logging.getLogger('clip_direct').error('no PC-render config at %s — run setup-pc.ps1 first', path)
        sys.exit(2)
    apply_config(load_config(path))
    log = logging.getLogger('clip_direct')
    if not _take_over_port(int(os.environ.get('PORT', '8090')), log):
        sys.exit(3)
    log.info('PC render instance, config %s', path)
    from .main import main as run_backend  # reads the environment at import time

    run_backend()


if __name__ == '__main__':
    main()
