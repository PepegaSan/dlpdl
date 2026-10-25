import json
import os
import time

from backend import diagnostics
from backend.downloader import JobRunner, JobSpec


def test_failed_job_gets_hint_and_diagnose_report(tmp_path):
    runner = JobRunner(str(tmp_path / 'dl'), str(tmp_path / 'tmp'))
    job_id = runner.create_waiting_job(
        JobSpec(url='https://cdn.example/v.m3u8?token=SECRET', page_url='https://site.example/watch?id=1'),
    )
    with runner._lock:
        runner._jobs[job_id].diag.note('playlist', url='https://cdn.example/v.m3u8?token=SECRET')

    assert runner.fail_job(job_id, 'segment download failed: HTTP Error 403: Forbidden')

    job = runner.get_job(job_id)
    assert job['status'] == 'error'
    assert job['error'].startswith('Hinweis:') and '403' in job['error']
    assert job['has_diagnose'] is True

    path = runner.diagnose_path(job_id)
    report = json.loads(open(path, encoding='utf-8').read())
    assert report['error'] == 'segment download failed: HTTP Error 403: Forbidden'
    assert report['events'][0]['kind'] == 'playlist'
    assert 'SECRET' not in json.dumps(report)

    assert runner.delete_job(job_id)
    assert runner.diagnose_path(job_id) is None


def test_old_reports_are_purged(tmp_path):
    dl = str(tmp_path)
    path = diagnostics.save_report(dl, 'abcdef123456', {'x': 1})
    old = time.time() - diagnostics.RETENTION_SEC - 10
    os.utime(path, (old, old))
    diagnostics.purge_old_reports(dl)
    assert diagnostics.report_path(dl, 'abcdef123456') is None


def test_diagnose_id_must_be_safe(tmp_path):
    assert diagnostics.save_report(str(tmp_path), '../evil', {}) is None
    assert diagnostics.report_path(str(tmp_path), '../evil') is None
