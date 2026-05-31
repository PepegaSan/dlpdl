# Changelog

## 1.3.0 — English UI + optional German

- Extension popup, options, and on-page clip bar: **English by default**, Deutsch in settings (`uiLocale`)
- Web UI: English default, language selector, i18n via `/locales/{en,de}.json`
- Backend job status messages in English
- README: Responsible use section

## 1.2.5 — License

- Project license changed from AGPL-3.0 to **GPL-3.0-or-later** (aligned with yt-dlp; see LICENSE and COPYRIGHT)

## 1.2.3 — HLS clip start quality

- HLS clips: one preroll segment + ffmpeg keyframe-aligned seek (fixes blocky first 3–5s)

## 1.2.0 — Variant B extension (clean-room modules)

- New extension libs: `tab-session`, `media-sniffer`, `jobs-client`, `page-url`, `format-time`
- Rewritten `background.js` (same behavior, new structure)
- `content.js` uses clean-room URL/time helpers
- Extension **1.2.0** — reload extension + F5 on video tabs after update

## 1.1.0 — Variant A (release-ready, AGPL)

### Extension (1.1.0)

- Clip-Direct branding (no MeTube UI messages)
- **Web-UI** button and configurable server URL in options
- `queueClips` auto-routes through best sniffed HLS stream when present
- Stream sniffer: before-send + completed fallback

### Backend / UI

- Single HLS clips use the same smart-clip path as merge parts
- Merge: partial downloads no longer mark job `ready` early
- HLS jobs detected via URL or yt-dlp overrides from extension
- Web UI: auto-save with per-job claim, Web Locks, single-tab guidance
- Safe clip filename prefixes (no colon)

### Docs

- English README, AGPL `LICENSE`, `NOTICES.md`, `docs/BEHAVIOR.md`

## 1.0.x

Initial Clip-Direct scaffold and fixes during beta testing.
