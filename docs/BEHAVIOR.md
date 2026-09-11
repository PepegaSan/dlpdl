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

**Merge clip list:** each clip has an **Include in merge** checkbox (default on). Unchecked clips remain in the list but are omitted from **Queue (merged)** and stream **Merge** only; **Queue (each)** still sends all clips.

Branding: UI strings and DOM ids use `clip-direct-*`, not `metube-*`. Reload hint says **Clip-Direct Extension**.

## Backend

| Case | Path | Must not regress |
| --- | --- | --- |
| **Single HLS clip** | `_clip_hls_like_merge` (same as one merge part) | Do not run yt-dlp first on clipped HLS (hangs / never finishes) |
| **Merge (2+ ranges)** | Per-part smart_clip + ffmpeg concat | `_pp_hook` must **ignore** partial `MoveFiles` until final concat |
| **HLS detection** | `_treat_as_hls()` (URL `.m3u8` or `external_downloader.m3u8`) | Extension sends overrides even if URL is opaque |
| **Non-HLS clip** | yt-dlp `download_ranges`, then smart_clip fallback if HLS | Direct video sites keep using yt-dlp |
| **Job status** | Status pump ignores `running` after `ready` | Prevents UI flicker and duplicate auto-downloads |

Output filenames are built from the **browser tab title** (sanitized, max ~60 chars), plus optional scene/merge tags:

| Case | Pattern |
| --- | --- |
| Single clip (only one on page) | `{Title}.mp4` |
| One of several clips | `{Title}_scene{N}of{M}.mp4` |
| Merge | `{Title}_merge{N}parts_{start}-{end}.mp4` |
| Full stream (no cut) | `{Title}.mp4` |

Times in merge names use `M-SS` or `H-MM-SS` (no colons). If a file already exists, `-2`, `-3`, … is appended. Extension sends `page_title`, `clip_index`, and `clip_count` with each job.

### HLS clipping (`hls_clipper.py`)

**Encode modes** (`clip_encode_mode` from extension / API):

| Mode | HLS path | Use when |
| --- | --- | --- |
| **`preserve`** (default) | Download whole TS segments → concat demuxer → **`-c copy`** only; window snaps to segment boundaries | Pixel comparison / forensic (Oxco) |
| **`exact`** | Docker: ffmpeg reads `.m3u8` with libx264 CRF 20 (+ segment fallback with trim). Browser HLS: remux segments, then `clip_local_media_window` to the marked times | Frame-accurate in/out at marked times |

**Exact mode — primary:** ffmpeg reads the **`.m3u8` URL** directly (`-ss` / `-to` on the playlist timeline). Finished message includes **`ok (ffmpeg-hls)`** when this path succeeded.

**Exact mode — fallback:** download TS segments → **ffmpeg concat demuxer** → trim/`atrim` or re-encode. Message: **`ok (segments)`**.

**Preserve mode:** finished message **`ok (copy)`**. Clip may start/end slightly earlier/later than markers (whole HLS segments only).

**Post-render (`post_render`, optional, orthogonal to encode mode):** when enabled, after the clip/merge is written the MP4 is re-encoded once via `rerender_for_editing()` (`hls_clipper.py`): constant frame rate (`-vsync cfr` at the source `r_frame_rate`), PTS reset to 0 (`setpts=PTS-STARTPTS`), audio re-synced (`aresample=async=1:first_pts=0`), libx264 CRF 18 + `+faststart`. This replaces the stream-copy faststart remux for that file. Fixes editors/ML pipelines that freeze the last frame for ~2s or choke on open-GOP / non-keyframe starts. Finished message gets **`+ rerender cfr`** appended. On failure it falls back to the normal faststart remux. Runs on every completion path (single, clip, merge, progressive) because it lives in `_mark_finished`.

**Start quality (exact):** native path uses ~10s decode preroll (`-ss` before + after `-i`). Fallback prepends **two** HLS segments and uses `trim`/`atrim` on the concat demuxer.

**Duration check (exact):** if native ffmpeg output is much longer than `end − start`, fallback runs automatically.

**Browser HLS (`browser_fetch`):** remux is stream-copy of whole segments. With **`exact`**, ingest then re-encodes a trim using `timeline_start` (first downloaded segment) so a later time edit (e.g. −10s) is actually cut. **Merge** posts `parts=timeline:bytes;…` and trims each scene before concat. Changing times on an already finished job does nothing — send again. The popup sends whatever is in the time fields at click (so 16:55 → 16:45 is not lost if Merge is clicked before blur finishes).

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
