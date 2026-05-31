# Behavior and regression safeguards

This document records flows that were fixed during development so they are not accidentally broken again.

## Extension

| Scenario | How to queue | Why |
| --- | --- | --- |
| **Normal page with `<video>`** (YouTube, direct MP4, etc.) | Clip bar or popup → send clips; uses **page URL** if no sniffed stream | yt-dlp handles the page URL; worked without iframe sniffer |
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

## Web UI (`ui/app.js`)

- Auto-save: claim job id in `localStorage` **before** fetch; `navigator.locks` so only one tab auto-downloads; skip when `document.hidden`.
- Manual **Auf PC speichern** always works.
- Keep a **single** tab on `http://localhost:8090/` when using auto-save.

## What MeTube contributed (Variant A — keep current code)

MeTube was **inspiration** and an early source for HLS smart-clip and extension UX patterns. The **working** split today is mostly Clip-Direct logic:

- REST job API and minimal UI are Clip-Direct-only.
- Single-clip HLS uses the **merge part** path (fix added here).
- Stream auto-pick for `queueClips` is Clip-Direct-only.

Direct **non-iframe** video did not depend on MeTube’s queue UI; it uses page URL + yt-dlp like any yt-dlp-based tool.
