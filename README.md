# Clip-Direct

Browser-extension-driven video clips: mark start/end on a page, send a detected stream URL to a small server, and save the finished file to your PC (or to a folder on your NAS).

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
- [ffmpeg](https://ffmpeg.org/) on `PATH`
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

## Docker

```bash
cd deploy
docker compose up -d --build
```

Default port: **8090**. Map `downloads` volume as needed (see `deploy/SYNOLOGY.md`).

## API (summary)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/jobs` | Create job (`url`, `clip_start` / `clip_end`, `clips`, `merge_clips`, `ytdl_options_overrides`, …) |
| `GET` | `/api/jobs` | List jobs |
| `GET` | `/api/jobs/{id}` | Job status |
| `GET` | `/api/jobs/{id}/file` | Download finished file |
| `DELETE` | `/api/jobs/{id}` | Remove job |

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

## License

This project is released under **[AGPL-3.0](LICENSE)**. See [NOTICES.md](NOTICES.md) for yt-dlp and ffmpeg. When you distribute or run it as a network service, comply with AGPL source-offer requirements.

**This is not legal advice.**

## Synology / NAS

See [deploy/SYNOLOGY.md](deploy/SYNOLOGY.md).
