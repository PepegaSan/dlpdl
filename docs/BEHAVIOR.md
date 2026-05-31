# Behavior and regression safeguards

This document records flows that were fixed during development so they are not accidentally broken again.

## Extension

| Scenario | How to queue | Why |
| --- | --- | --- |
| **Normal page with `<video>`** (YouTube, Vimeo, …) | **In Queue** | **Page URL** to yt-dlp (same as MeTube) — not auto-replaced by sniffed CDN URLs. |
| **Shell pages** (`.php` / `.html` player) | **In Queue** | Needs a **usable** sniffed stream or `<video src>`; page URL alone would hit yt-dlp `php` extension errors. Use **Mit Schnitt** on a listed stream if queue fails. |
| **Embed / iframe hosters** (StreamSB, Streamtape, …) | Mark times in iframe bar → popup → **Mit Schnitt** on a **detected stream** | Page URL is not downloadable; need `.m3u8` + Referer from sniffer |
| **Queue buttons** (`In Queue einzeln/merged`) on embed pages | Auto-uses best **HLS stream** for the tab when available (`queueClips` → `queueStream`) | Avoids sending only the aggregator page URL |

Sniffer: `onBeforeSendHeaders` (primary) + `onCompleted` (fallback). Do not clear stream list on every `tabs.onUpdated` navigation — that broke detection.

Branding: UI strings and DOM ids use `clip-direct-*`, not `metube-*`. Reload hint says **Clip-Direct Extension**.

## Backend

| Case | Path | Must not regress |
| --- | --- | --- |
| **Single HLS clip** | `_clip_hls_like_merge` (same as one merge part) | Do not run yt-dlp first on clipped HLS (hangs / never finishes) |
| **Merge (2+ ranges)** | Per-part smart_clip + ffmpeg concat | `_pp_hook` must **ignore** partial `MoveFiles` until final concat |
| **HLS detection** | `_treat_as_hls()` (URL `.m3u8` or `external_downloader.m3u8`) | Extension sends overrides even if URL is opaque |
| **Non-HLS clip** | yt-dlp `download_ranges`, then smart_clip fallback if HLS | Direct video sites keep using yt-dlp |
| **Job status** | Status pump ignores `running` after `ready` | Prevents UI flicker and duplicate auto-downloads |

Output filenames use `clip_MM-SS-MM-SS_` (no `:`) for cross-platform safety.

### HLS clipping (`hls_clipper.py`)

**Primary:** ffmpeg reads the **`.m3u8` URL** directly (`-ss` / `-to` on the playlist timeline). Job status may show `HLS: ffmpeg schneidet…`; finished message includes **`ok (ffmpeg-hls)`** when this path succeeded.

**Fallback:** download TS segments → **ffmpeg concat demuxer** (not raw byte concat) → `-ss` / `-t` on the merged timeline. Message: **`ok (segments)`**.

**Start quality:** native path uses ~10s decode preroll (`-ss` before + after `-i`). Fallback prepends **two** HLS segments and uses `trim`/`atrim` on the concat demuxer.

**Duration check:** if native ffmpeg output is much longer than `end − start`, fallback runs automatically.

Docker dev: `deploy/docker-compose.yml` mounts `../backend` into the container so rebuild is not required for Python-only changes (restart container after edits).

## Web UI (`ui/app.js`)

- Auto-save: claim job id in `localStorage` **before** fetch; `navigator.locks` so only one tab auto-downloads; skip when `document.hidden`.
- Manual **Auf PC speichern** always works.
- Keep a **single** tab on `http://localhost:8090/` when using auto-save.

## HLS implementation (`backend/hls_clipper.py`)

HLS clipping is implemented in **`hls_clipper.py`** (clean-room). [`smart_clip.py`](../backend/smart_clip.py) re-exports `is_hls_url` and `smart_clip_hls`.

## Extension (clean-room modules)

| Module | Role |
| --- | --- |
| `lib/tab-session.js` | Per-tab streams + clip bundles |
| `lib/media-sniffer.js` | URL classification + HLS preference |
| `lib/jobs-client.js` | REST job payloads |
| `lib/page-url.js` | Draft keys + submit URLs |
| `lib/format-time.js` | Clock formatting for markers |
| `background.js` | Service worker wiring |

Legacy filenames (`page-key.js`, `clip-direct-api.js`, `time.js`) are thin re-exports only.

Content script (`content.js`) must **not** use ES `import` — run as a classic script in `manifest.json` (no `type: "module"`). Helpers are inlined at the top of `content.js`.

## Non-iframe video

Direct **non-iframe** pages use the **page URL** and yt-dlp — no HLS clipper required for typical YouTube-style sites.
