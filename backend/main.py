"""Clip-Direct API: plugin-driven clips, direct PC download."""

import json
import logging
import os
from pathlib import Path

from aiohttp import web

from .clip_parse import ClipParseError, optional_clip_field, parse_clips_list
from .downloader import JobRunner, JobSpec, parse_ytdl_overrides
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


def _job_spec_from_post(post: dict) -> JobSpec:
    url = (post.get('url') or '').strip()
    if not url:
        raise ClipParseError('url is required')

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

    return JobSpec(
        url=url,
        clip_start=clip_start,
        clip_end=clip_end,
        clip_ranges=clip_ranges if merge_clips else (clip_ranges if len(clip_ranges) > 1 else []),
        merge_clips=merge_clips and bool(clip_ranges),
        custom_name_prefix=prefix,
        folder=folder,
        format=fmt,
        ytdl_opts=overrides,
        title=url[:120],
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
    if clips_raw and not merge_clips and len(parse_clips_list(clips_raw)) > 1:
        ids = []
        for start, end in parse_clips_list(clips_raw):
            single = {**post, 'clips': None, 'merge_clips': False, 'clip_start': start, 'clip_end': end}
            ids.append(runner.create_job(_job_spec_from_post(single)))
        return web.json_response({'ids': ids, 'status': 'pending'})

    job_id = runner.create_job(spec)
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


async def api_download_file(request: web.Request) -> web.Response:
    job_id = request.match_info['id']
    with runner._lock:
        state = runner._jobs.get(job_id)
    if not state or state.status != 'ready' or not state.filepath or not os.path.isfile(state.filepath):
        raise web.HTTPNotFound(reason='file not ready')
    name = state.filename or os.path.basename(state.filepath)
    return web.FileResponse(
        state.filepath,
        headers={'Content-Disposition': f'attachment; filename="{name}"'},
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
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_post('/api/jobs', api_create_job)
    app.router.add_get('/api/jobs', api_list_jobs)
    app.router.add_get('/api/jobs/{id}', api_get_job)
    app.router.add_get('/api/jobs/{id}/file', api_download_file)
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
