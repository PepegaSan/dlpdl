"""Clip-Direct API: plugin-driven clips, direct PC download."""

import json
import logging
import os
from pathlib import Path

from aiohttp import web

from .clip_parse import ClipParseError, optional_clip_field, parse_clips_list, validate_job_media_url
from .downloader import JobRunner, JobSpec, parse_ytdl_overrides
from .filename import sanitize_title
from .smart_clip import is_hls_url

log = logging.getLogger('clip_direct')

DOWNLOAD_DIR = os.environ.get('DOWNLOAD_DIR', os.path.join(os.getcwd(), 'downloads'))
TEMP_DIR = os.environ.get('TEMP_DIR', os.path.join(DOWNLOAD_DIR, '.tmp'))
PORT = int(os.environ.get('PORT', '8090'))
UI_DIR = Path(__file__).resolve().parent.parent / 'ui'

runner = JobRunner(DOWNLOAD_DIR, TEMP_DIR)


def _cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }


@web.middleware
async def cors_middleware(request, handler):
    if request.method == 'OPTIONS':
        return web.Response(status=204, headers=_cors_headers())
    try:
        resp = await handler(request)
    except web.HTTPException as exc:
        exc.headers.update(_cors_headers())
        raise
    except Exception:
        log.exception('unhandled error')
        resp = web.json_response({'error': 'internal error'}, status=500)
    resp.headers.update(_cors_headers())
    return resp


def _as_bool(raw) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw != 0
    if isinstance(raw, str):
        return raw.strip().lower() in ('1', 'true', 'yes', 'on')
    return bool(raw)


def _optional_positive_int(raw, field_name: str) -> int | None:
    if raw is None or raw == '':
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ClipParseError(f'{field_name} must be a positive integer') from exc
    if value < 1:
        raise ClipParseError(f'{field_name} must be a positive integer')
    return value


def _job_spec_from_post(post: dict) -> JobSpec:
    url = (post.get('url') or '').strip()
    if not url:
        raise ClipParseError('url is required')
    validate_job_media_url(url)

    merge_clips = bool(post.get('merge_clips', False))
    clips_raw = post.get('clips')
    clip_ranges: list[tuple[float, float]] = []

    clip_start = optional_clip_field(post.get('clip_start'))
    clip_end = optional_clip_field(post.get('clip_end'))

    if clips_raw:
        clip_ranges = parse_clips_list(clips_raw)
        if merge_clips:
            clip_start = clip_end = None
        elif len(clip_ranges) == 1:
            clip_start, clip_end = clip_ranges[0]
            clip_ranges = []
    elif clip_start is not None or clip_end is not None:
        if clip_end is not None and clip_start is not None and clip_end <= clip_start:
            raise ClipParseError('clip_end must be greater than clip_start')
        if clip_start is None and clip_end is not None:
            clip_start = 0.0

    overrides = parse_ytdl_overrides(post.get('ytdl_options_overrides'))
    if is_hls_url(url):
        overrides.setdefault('hls_use_mpegts', True)
        overrides.setdefault('external_downloader', {'m3u8': 'ffmpeg'})

    prefix = (post.get('custom_name_prefix') or '').strip()
    fmt = post.get('format') or 'bestvideo*+bestaudio/best'
    if post.get('download_type') == 'audio':
        fmt = 'bestaudio/best'

    save_target = (post.get('save_target') or 'browser').strip().lower()
    folder = (post.get('folder') or '').strip() if save_target == 'nas' else ''

    encode_mode = (post.get('clip_encode_mode') or 'preserve').strip().lower()
    if encode_mode not in ('preserve', 'exact'):
        encode_mode = 'preserve'

    post_render = _as_bool(post.get('post_render', False))

    page_title = sanitize_title((post.get('page_title') or '').strip())
    page_url = (post.get('page_url') or '').strip()
    if page_url and not page_url.lower().startswith(('http://', 'https://')):
        page_url = ''
    page_url = page_url[:2000]
    clip_index = _optional_positive_int(post.get('clip_index'), 'clip_index')
    clip_count = _optional_positive_int(post.get('clip_count'), 'clip_count')
    if merge_clips and clip_ranges and clip_count is None:
        clip_count = len(clip_ranges)

    return JobSpec(
        url=url,
        clip_start=clip_start,
        clip_end=clip_end,
        clip_ranges=clip_ranges if merge_clips else (clip_ranges if len(clip_ranges) > 1 else []),
        merge_clips=merge_clips and bool(clip_ranges),
        custom_name_prefix=prefix,
        folder=folder,
        format=fmt,
        clip_encode_mode=encode_mode,
        post_render=post_render,
        ytdl_opts=overrides,
        title=page_title or url[:120],
        page_title=page_title,
        page_url=page_url,
        clip_index=clip_index,
        clip_count=clip_count,
    )


async def api_create_job(request: web.Request) -> web.Response:
    try:
        post = await request.json()
    except json.JSONDecodeError:
        return web.json_response({'error': 'invalid json'}, status=400)
    try:
        spec = _job_spec_from_post(post)
    except ClipParseError as exc:
        return web.json_response({'error': str(exc)}, status=400)

    clips_raw = post.get('clips')
    merge_clips = bool(post.get('merge_clips', False))
    browser_fetch = _as_bool(post.get('browser_fetch'))
    if clips_raw and not merge_clips and len(parse_clips_list(clips_raw)) > 1 and not browser_fetch:
        ids = []
        ranges = parse_clips_list(clips_raw)
        total = len(ranges)
        for index, (start, end) in enumerate(ranges, start=1):
            single = {
                **post,
                'clips': None,
                'merge_clips': False,
                'clip_start': start,
                'clip_end': end,
                'clip_index': index,
                'clip_count': total,
            }
            ids.append(runner.create_job(_job_spec_from_post(single)))
        return web.json_response({'ids': ids, 'status': 'pending'})

    job_id = runner.create_waiting_job(spec) if browser_fetch else runner.create_job(spec)
    return web.json_response({'id': job_id, 'status': 'pending'})


async def api_list_jobs(_request: web.Request) -> web.Response:
    return web.json_response({'jobs': runner.list_jobs()})


async def api_get_job(request: web.Request) -> web.Response:
    job = runner.get_job(request.match_info['id'])
    if not job:
        raise web.HTTPNotFound()
    return web.json_response(job)


async def api_delete_job(request: web.Request) -> web.Response:
    if not runner.delete_job(request.match_info['id']):
        raise web.HTTPNotFound()
    return web.json_response({'ok': True})


async def api_job_progress(request: web.Request) -> web.Response:
    try:
        post = await request.json()
    except json.JSONDecodeError:
        return web.json_response({'error': 'invalid json'}, status=400)
    job_id = request.match_info['id']
    msg = str(post.get('msg') or 'Browser download…')
    try:
        progress = float(post.get('progress') or 0)
    except (TypeError, ValueError):
        progress = 0.0
    if not runner.update_progress(job_id, msg, progress):
        raise web.HTTPNotFound()
    return web.json_response({'ok': True})


async def api_job_fail(request: web.Request) -> web.Response:
    try:
        post = await request.json()
    except json.JSONDecodeError:
        return web.json_response({'error': 'invalid json'}, status=400)
    job_id = request.match_info['id']
    detail = str(post.get('error') or post.get('msg') or 'Browser download failed')
    if not runner.fail_job(job_id, detail):
        raise web.HTTPNotFound()
    return web.json_response({'ok': True})


async def api_job_ingest(request: web.Request) -> web.Response:
    job_id = request.match_info['id']
    payload = await request.read()
    timeline_start = None
    raw_tl = request.query.get('timeline_start')
    if raw_tl not in (None, ''):
        try:
            timeline_start = float(raw_tl)
        except (TypeError, ValueError):
            timeline_start = None
    parts: list[tuple[float, int]] = []
    for chunk in (request.query.get('parts') or '').split(';'):
        piece = chunk.strip()
        if not piece or ':' not in piece:
            continue
        tl_s, _, len_s = piece.partition(':')
        try:
            parts.append((float(tl_s), int(len_s)))
        except (TypeError, ValueError):
            continue
    ok, detail = runner.ingest_browser_media(
        job_id,
        payload,
        timeline_start=timeline_start,
        parts=parts or None,
    )
    if not ok:
        status = 404 if detail == 'unknown job' else 400
        return web.json_response({'error': detail}, status=status)
    return web.json_response({'ok': True, 'msg': detail})


async def api_download_file(request: web.Request) -> web.Response:
    job_id = request.match_info['id']
    with runner._lock:
        state = runner._jobs.get(job_id)
    file_path = runner.effective_filepath(state) if state else None
    if not state or state.status != 'ready' or not file_path:
        raise web.HTTPNotFound(reason='file not ready')
    name = state.filename or os.path.basename(file_path)
    return web.FileResponse(
        file_path,
        headers={
            'Content-Disposition': f'attachment; filename="{name}"',
            'Cache-Control': 'no-store, must-revalidate',
        },
    )


_NO_CACHE = {'Cache-Control': 'no-store, must-revalidate'}


async def serve_index(_request: web.Request) -> web.Response:
    return web.FileResponse(UI_DIR / 'index.html', headers=_NO_CACHE)


async def serve_style(_request: web.Request) -> web.Response:
    return web.FileResponse(UI_DIR / 'style.css', headers=_NO_CACHE)


async def serve_app_js(_request: web.Request) -> web.Response:
    return web.FileResponse(UI_DIR / 'app.js', headers=_NO_CACHE)


async def serve_ui_i18n(_request: web.Request) -> web.Response:
    return web.FileResponse(UI_DIR / 'i18n.js', headers=_NO_CACHE)


async def serve_ui_locale(request: web.Request) -> web.Response:
    name = request.match_info.get('name', '')
    if name not in ('en.json', 'de.json'):
        raise web.HTTPNotFound()
    return web.FileResponse(UI_DIR / 'locales' / name, headers=_NO_CACHE)


def create_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware], client_max_size=2 * 1024 * 1024 * 1024)
    app.router.add_post('/api/jobs', api_create_job)
    app.router.add_get('/api/jobs', api_list_jobs)
    app.router.add_get('/api/jobs/{id}', api_get_job)
    app.router.add_get('/api/jobs/{id}/file', api_download_file)
    app.router.add_post('/api/jobs/{id}/progress', api_job_progress)
    app.router.add_post('/api/jobs/{id}/fail', api_job_fail)
    app.router.add_post('/api/jobs/{id}/ingest', api_job_ingest)
    app.router.add_delete('/api/jobs/{id}', api_delete_job)
    app.router.add_get('/', serve_index)
    app.router.add_get('/index.html', serve_index)
    app.router.add_get('/style.css', serve_style)
    app.router.add_get('/app.js', serve_app_js)
    app.router.add_get('/i18n.js', serve_ui_i18n)
    app.router.add_get('/locales/{name}', serve_ui_locale)
    return app


def main():
    logging.basicConfig(level=logging.INFO)
    log.info('Clip-Direct on :%s, downloads=%s', PORT, DOWNLOAD_DIR)
    web.run_app(create_app(), host='0.0.0.0', port=PORT)


if __name__ == '__main__':
    main()
