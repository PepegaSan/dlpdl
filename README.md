# Clip-Direct

Browser-extension-driven video clips: mark start/end on a page, send a detected stream URL to a small server, and save the finished file to your PC (or to a folder on your NAS).

> **Dependencies:** You do **not** need to download [yt-dlp](https://github.com/yt-dlp/yt-dlp) separately for the usual setup — it is installed automatically via `pip install -r requirements.txt` (Python package `yt-dlp[default]`) or is already included in the **Docker** image. For a **local** install (without Docker), you **must** install [ffmpeg](https://ffmpeg.org/) yourself and have it on your `PATH`. To update yt-dlp later: `pip install -U yt-dlp` or rebuild the Docker image.

> **Pixel comparison (Oxco etc.):** In extension settings, use **Preserve source** clip encoding (default). Clip both source and deepfake the same way; compare those exports — not uncut originals vs clipped files.

## Acknowledgments

Inspired by [MeTube](https://github.com/alexta69/metube) — thanks for the idea of combining a browser helper with yt-dlp. Clip-Direct is an independent project (different API, UI, and goals).

## How downloads are sent

| Site type | What to use | Server receives |
| --- | --- | --- |
| **Normal video page** (YouTube, direct player) | Clip bar → popup → queue | **Page URL** — yt-dlp clips the video (typical path, no iframe needed) |
| **Embed / iframe hosters** | Mark in iframe bar → **Mit Schnitt** on a detected stream | **Stream URL** + Referer (from sniffer) |

See [docs/BEHAVIOR.md](docs/BEHAVIOR.md) for details and regression notes.

## Components

| Path | Role |
| --- | --- |
| `backend/` | HTTP API, job runner, [yt-dlp](https://github.com/yt-dlp/yt-dlp), HLS smart-clip fallback |
| `ui/` | Minimal web UI (progress + save to PC) |
| `extension/` | Chrome extension (stream sniffer, clip bar, merge) |
| `deploy/` | Docker Compose |

## Requirements

- Python 3.11+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — via `pip install -r requirements.txt` (no separate download)
- [ffmpeg](https://ffmpeg.org/) on `PATH` — install separately (not bundled with pip)
- Chrome / Chromium for the extension

## Quick start (local)

```bash
git clone https://github.com/PepegaSan/dlpdl.git
cd clip-direct
pip install -r requirements.txt
```

**Windows (PowerShell):**

```powershell
.\start.ps1
```

**Or manually:**

```bash
export DOWNLOAD_DIR="$(pwd)/downloads"   # optional
python -m backend.main
```

Open **http://localhost:8090/** for the web UI.

## Chrome extension

1. Open `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. **Options:** set server URL (e.g. `http://localhost:8090/`), storage target **PC** (default)
4. On embed/hoster pages, use **Mit Schnitt** on a detected stream (not only the page URL)

Reload the extension after updates; refresh video tabs once (F5).

**Language:** Extension and web UI default to **English**. Choose **Deutsch** in extension settings or the language dropdown on the web UI (`http://localhost:8090/`).

## Docker

```bash
cd deploy
docker compose up -d --build
```

Default port: **8090**. Map `downloads` volume as needed (see `deploy/SYNOLOGY.md`).

`docker-compose.yml` mounts `backend/` and `ui/` from your clone so UI/i18n updates apply after **container restart** without a full rebuild.

## Rendering on your PC while the server runs on the NAS (optional)

`exact` clips, post-render and merge fallbacks re-encode with libx264 — slow on a NAS CPU. A second Clip-Direct instance on the PC writes into the **same NAS folder** the container uses, and the extension prefers it whenever it answers.

### Setup

1. Map the NAS share that holds the clone as a network drive (compose mounts `../downloads`, so the target is `<drive>:\<clone>\downloads`). A UNC path (`\\<nas>\<share>\<clone>\downloads`) works as well.
2. Double-click **`setup-pc.bat`** in your PC clone. It
   - searches the mapped drives for a Clip-Direct clone (`deploy\docker-compose.yml` + `downloads`) and asks you to confirm, or to type the path if nothing is found;
   - checks Python 3.11+ and ffmpeg on `PATH`, installs the Python dependencies if missing;
   - writes `%LOCALAPPDATA%\clip-direct\pc-render.json` (download folder as UNC path, local temp folder, port, bind address, token);
   - asks whether to **start at logon** and then registers a Task Scheduler job that runs `pythonw -m backend.pc_render` without a window (20 s after logon, restarted on failure);
   - adds Start-menu entries *Clip-Direct → PC Render starten / beenden*;
   - starts the instance (bound to `127.0.0.1:8090`, log in `%LOCALAPPDATA%\clip-direct\pc-render.log`) and prints the values for the extension.
3. In the extension popup click the **PC** dot (grey → green), or use the options page (*Fast server on this PC*, *Prefer the PC when reachable*, *Test reachability*).

`setup-pc.bat -Remove` removes task, shortcuts and configuration; `setup-pc.bat -Stop` only stops the instance. `start.bat` and `start.ps1` pick the configuration up as well, so a visible console start keeps working.

### What you may need to change

| Situation | What to do |
| --- | --- |
| Port 8090 is taken on the PC (e.g. a local Docker instance) | `setup-pc.bat -Port 8091`, then enter `http://localhost:8091/` in the extension |
| The NAS runs with `CLIP_DIRECT_TOKEN` | `setup-pc.bat -Token <same token>` — both instances must use the same token (or none) |
| The clone is not on a mapped drive | `setup-pc.bat -DownloadDir "\\<nas>\<share>\<clone>\downloads"` |
| Other PCs in the LAN should use this instance too | `setup-pc.bat -BindHost 0.0.0.0` (consider a token) |
| No autostart wanted | answer `n`, or `setup-pc.bat -NoAutostart`; use the Start-menu entry instead |
| Task Scheduler reports an error | the account name is taken from `WindowsIdentity` (`PC-NAME\User`), which also works when the PC is named like the user; if it still fails, copy the Start-menu shortcut *PC Render starten* into `shell:startup` |
| Re-run or change settings | just run `setup-pc.bat` again with the new parameters — it overwrites the configuration and restarts the instance |
| Updated the code (`git pull`) | click *PC Render starten* once — a new instance stops the previous one and takes over the port; the running process never reloads code by itself |

The NAS address stays the main server in the extension. Each job probes the PC (`GET /api/jobs`, 1.5 s, cached 10 s); if it answers, download *and* encode run there (also with the browser's IP, which helps CDNs that bind tokens to it), otherwise the job goes to the NAS as before. The popup and the on-page bar show `→ PC`, the PC dot turns orange when the instance is preferred but silent, and the Web-UI button opens the instance that took the last job. Both instances keep their own job list.

## API (summary)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/jobs` | Create job (`url`, `clip_start` / `clip_end`, `clips`, `merge_clips`, `ytdl_options_overrides`, …) |
| `GET` | `/api/jobs` | List jobs |
| `GET` | `/api/jobs/{id}` | Job status |
| `GET` | `/api/jobs/{id}/file` | Download finished file |
| `POST` | `/api/jobs/{id}/cancel` | Stop a pending/running job (kills ffmpeg/yt-dlp) |
| `GET` | `/api/jobs/{id}/diagnose` | JSON report of a failed job (playlist excerpt, HTTP statuses, attempts, ffmpeg errors; tokens masked) |
| `DELETE` | `/api/jobs/{id}` | Remove job (cancels it if still running) |

`POST` bodies must be `application/json` (except the extension's `/ingest` upload). Only `http(s)` URLs are accepted; `ytdl_options_overrides` is limited to a whitelist (headers, HLS/downloader options).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOWNLOAD_DIR` | `./downloads` | Finished files (`folder` from the extension stays inside it) |
| `PORT` / `HOST` | `8090` / `0.0.0.0` | Listen address (`127.0.0.1` = this PC only) |
| `CLIP_DIRECT_TOKEN` | empty | Optional shared secret. Set it in the extension options; the web UI asks once |
| `MAX_PARALLEL_JOBS` | `2` | Jobs processed at the same time |
| `MAX_INGEST_MB` | `4096` | Max browser-HLS upload size |
| `BROWSER_FETCH_IDLE_SEC` | `600` | Fail browser jobs that stopped reporting (tab closed / extension reloaded) |
| `FFMPEG_TIMEOUT_SEC` | `1800` | Hard limit per ffmpeg call |

Requests from other websites (foreign `Origin`) are rejected; the extension and the bundled UI are allowed.

### Tests

`pip install -r requirements-dev.txt`, then `python -m pytest`. The HLS tests generate real streams with ffmpeg (skipped if ffmpeg is missing) and serve them locally with typical CDN quirks.

## Publishing your own repository

**Yes — use your own Git repo** (GitHub, GitLab, Gitea, etc.). This project is not tied to the MeTube repository.

Suggested steps:

```bash
cd clip-direct
git remote add origin git@github.com:YOUR_USER/clip-direct.git
git add .
git commit -m "Initial release"
git push -u origin main
```

Do **not** push into the MeTube repo unless you are intentionally contributing upstream.

## Responsible use

Clip-Direct is a technical tool for marking time ranges and saving media you choose to process on your own server.

**You are responsible** for complying with applicable laws, copyright, and the terms of service of any site or content provider.

Use it only for content you have the right to access and copy (your own work, explicit permission, or licenses that allow downloading and clipping).

The authors do not encourage or support copyright infringement, unauthorized redistribution, or circumventing technical protection measures.

This section is not legal advice; if unsure, check the rules that apply to you.

## License

This project is released under the **[GNU General Public License v3.0 or later](LICENSE)** (GPL-3.0-or-later). See [NOTICES.md](NOTICES.md) for yt-dlp (GPL) and ffmpeg. [COPYRIGHT](COPYRIGHT) lists the project copyright holder.

When you distribute Clip-Direct (including Docker images), provide source code under the same license. **This is not legal advice.**

## Synology / NAS

See [deploy/SYNOLOGY.md](deploy/SYNOLOGY.md).
