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
| **Cancel / delete** | `CancelToken` per job kills registered ffmpeg/yt-dlp processes; `JobCancelled` is a `BaseException` so `except Exception` fallbacks don't swallow it | A cancelled job must not flip back to `running`/`ready` |
| **Concurrency** | `MAX_PARALLEL_JOBS` (default 2) worker slots; filename stems reserved until the job ends | Two jobs with the same title must not write the same file |
| **Browser ingest** | Body streamed to `<tmp>/<job>/browser.bin` (limit `MAX_INGEST_MB`), processed in a thread, `202` | Never read the upload into RAM or remux inside the aiohttp handler |
| **Output folder** | `resolve_output_dir` keeps `folder` inside `DOWNLOAD_DIR` | No `..` escapes |

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
| **`preserve`** (default) | Download whole segments → concat demuxer → **`-c copy`** only; window snaps to segment boundaries | Pixel comparison / forensic (Oxco) |
| **`exact`** | Docker: download segments (+2 preroll) → concat demuxer → `trim`/`atrim`, libx264 CRF 20. Browser HLS: remux segments, then `clip_local_media_window` to the marked times | Frame-accurate in/out at marked times |

**Order (both modes):** Python downloads the segments first — it handles fMP4 init, BYTERANGE, AES-128, discontinuities and CDNs that reject ffmpeg (phncdn: 410). The first segment is checked by its bytes; an HTML/JSON error page fails at once with advice. Only if the segment path fails does ffmpeg read the **`.m3u8` URL** directly (`ok (copy-ffmpeg)` / `ok (ffmpeg-hls)`). Normal messages: **`ok (copy-segments)`** (preserve), **`ok (segments)`** (exact).

**Separate audio:** if the chosen master variant has an `#EXT-X-MEDIA:TYPE=AUDIO` playlist, video and audio are clipped separately and muxed (`+ separate audio`).

**Errors:** known patterns (`no tfhd`, 403/404/410/429, HTML instead of video, DNS, timeout) get a `Hinweis: …` in plain German before the technical text. Each failed job stores a diagnose report (`DOWNLOAD_DIR/.diag/<id>.json`, 7 days, deleted with the job).

**Preserve mode:** clip may start/end slightly earlier/later than markers (whole HLS segments only).

**Post-render (`post_render`, optional, orthogonal to encode mode):** when enabled, after the clip/merge is written the MP4 is re-encoded once via `rerender_for_editing()` (`hls_clipper.py`): constant frame rate (`-vsync cfr` at the source `r_frame_rate`), PTS reset to 0 (`setpts=PTS-STARTPTS`), audio re-synced (`aresample=async=1:first_pts=0`), libx264 CRF 18 + `+faststart`. This replaces the stream-copy faststart remux for that file. Fixes editors/ML pipelines that freeze the last frame for ~2s or choke on open-GOP / non-keyframe starts. Finished message gets **`+ rerender cfr`** appended. On failure it falls back to the normal faststart remux. Runs on every completion path (single, clip, merge, progressive) because it lives in `_mark_finished`.

**Start quality (exact):** the segment path prepends **two** HLS segments and uses `trim`/`atrim` on the concat demuxer; the ffmpeg-direct fallback uses ~10s decode preroll (`-ss` before + after `-i`).

**Duration check:** output much shorter than the window fails with “nur Xs von ~Ys geladen”.

**Browser HLS (`browser_fetch`):** remux is stream-copy of whole segments. With **`exact`**, ingest then re-encodes a trim using `timeline_start` (first downloaded segment) so a later time edit (e.g. −10s) is actually cut. **Merge** posts `parts=timeline:bytes;…` and trims each scene before concat. Changing times on an already finished job does nothing — send again. The popup sends whatever is in the time fields at click (so 16:55 → 16:45 is not lost if Merge is clicked before blur finishes).

Docker dev: `deploy/docker-compose.yml` mounts `../backend` into the container so rebuild is not required for Python-only changes (restart container after edits).

## Web UI (`ui/app.js`)

- Auto-save: claim job id in `localStorage` **before** fetch; `navigator.locks` so only one tab auto-downloads; skip when `document.hidden`.
- Manual **Auf PC speichern** always works.
- Keep a **single** tab on `http://localhost:8090/` when using auto-save.
- Jobs sorted by `created_at` (ids are random). Running jobs get **Cancel** (`POST /api/jobs/{id}/cancel`).
- Failed jobs with a report get **Diagnose** (downloads `GET /api/jobs/{id}/diagnose`).
- With `CLIP_DIRECT_TOKEN` set, a 401 prompts once for the token (stored in `localStorage`, sent as header and `?token=` on file links).

## HLS implementation (`backend/hls_clipper.py`)

HLS clipping is implemented in **`hls_clipper.py`** (clean-room). [`smart_clip.py`](../backend/smart_clip.py) re-exports `is_hls_url` and `smart_clip_hls`.

**Hoster quirks handled by both the Python and the browser fetch:** a playlist that redirects resolves relative URIs against the URL it was served from (a signed query dropped by the redirect is passed on); a UTF-8 BOM or CRLF never produces a phantom segment (that would shift every AES sequence-number IV); the signed query is inherited only by children on the playlist host, never by `//other-cdn/…` or `data:` URIs; a segment body shorter than announced is retried and after `SEGMENT_FETCH_RETRY_MAX` attempts fails with “Segment unvollständig” — it is never kept, since a truncated segment would be a glitch in the clip, not an error. The only exception is a `416` on the resume request, which proves the Content-Length itself was wrong. **`preserve`** never re-encodes: when the copy-trim fails the container stays long rather than losing its original frames. A separate audio rendition is checked (DRM, empty) before the video is downloaded. Stream-copy remuxes pass `-bsf:a aac_adtstoasc` for ADTS AAC and repeat without it when ffmpeg refuses the filter (MP3/MP2 audio in TS). Browser fetch: 403/404 are not retried (only network errors and 429/5xx), a failed segment stops the other workers, and the on-page Referer is replaced by the HTML page only for KVS-style tokenized CDNs. The per-tab stream list evicts fragments before playlists. Every downloaded segment is checked by its bytes: an HTML/JSON page for segment N (token expired mid-download) fails with the same advice as the preflight and does not fall back to ffmpeg, which would get the same page.

**Known limits:** the clip timeline is the sum of `#EXTINF` durations, not the PTS a player reports — hosters that round every segment to whole seconds drift by a few seconds per hour, so a clip marked late in a long video may sit slightly off. Live and EVENT playlists are not handled: `#EXT-X-ENDLIST`/`#EXT-X-PLAYLIST-TYPE` are not checked, timeline 0 is the first segment currently listed, and with a sliding window the cut lands on the wrong part. Clip VOD playlists only.

## Extension (clean-room modules)

| Module | Role |
| --- | --- |
| `lib/tab-session.js` | Per-tab streams + clip bundles |
| `lib/media-sniffer.js` | URL classification + HLS preference |
| `lib/jobs-client.js` | REST job payloads |
| `lib/page-url.js` | Draft keys + submit URLs |
| `lib/format-time.js` | Clock formatting for markers |
| `background.js` | Service worker wiring |

All backend calls go through `apiFetch` in `lib/jobs-client.js` (optional `X-Clip-Direct-Token`, network failure → `error.backendUnreachable`).

**Browser HLS jobs** run in the service worker after the popup/bar already got "queued": one at a time, keepalive while working, active ids in `chrome.storage.session` so a restarted worker fails orphans instead of leaving them "running". DNR header rules are per job and only match extension requests (`tabIds: [-1]`).

**Cookies for stream jobs** (`lib/browser-cookies.js`, tab jar in `lib/tab-session.js`): only what the browser itself would send to the stream host — its own cookies, parent-domain cookies, CHIPS-partitioned ones under the page's top-level site, and known CDN roots of the same domain family. The embedding page's session cookies are never forwarded.

**Keep playback** (`lib/keep-playback-boot.js` → `lib/keep-playback.js`, MAIN world): injected only once the page shows a `<video>`; fakes `document.hidden`/`visibilityState` and swallows `visibilitychange`, nothing else (`pagehide`/`freeze` reach the page). After the window loses focus, a programmatic `pause()` within 2 s resumes that one video; user pauses are respected.

**Fast server** (`lib/server-select.js`): with `fastServerEnabled` every queue path (`queueClips`, `queueStream`, browser fetch, page bar) first probes `fastServerUrl` (`GET api/jobs`, 1.5 s, result cached 10 s) and swaps `clipDirectBaseUrl` in the settings copy it hands on, so progress/ingest/fail of a browser job reach the same instance. `postJob` results carry `serverRole` (`main`/`fast`) for the `→ PC` tag; `cdLastServerUrl` in `storage.local` tells the popup which Web-UI to open; orphaned browser jobs are failed on the instance that created them. The popup's **PC** pill probes `fastServerUrl` every 5 s while open and toggles `fastServerEnabled`. `setup-pc.ps1` writes `%LOCALAPPDATA%\clip-direct\pc-render.json` (UNC download dir, local temp dir, port, bind host, token); `backend/pc_render.py` maps it onto the environment and starts `backend.main`, logging to `pc-render.log` (used by the autostart task via `pythonw`, by `start.bat`, and read by `start.ps1` unless overridden). Under `pythonw` every ffmpeg/ffprobe child would get its own console window (a flash per call; many calls in a row end in `0xc0000142`), so `spawn_kwargs()` in `hls_clipper.py` starts children with `CREATE_NO_WINDOW` and `stdin=DEVNULL`, and `pc_render` sets an error mode that children inherit, so a crashing ffmpeg fails the job instead of blocking on a modal dialog.

**Shortcuts** (`manifest.json` `commands`): Alt+Shift+S mark start, Alt+Shift+E mark end (changeable at `chrome://extensions/shortcuts`).

Content script (`content.js`) must **not** use ES `import` — run as a classic script in `manifest.json` (no `type: "module"`). Helpers are inlined at the top of `content.js`.

## Non-iframe video

Direct **non-iframe** pages use the **page URL** and yt-dlp — no HLS clipper required for typical YouTube-style sites.
