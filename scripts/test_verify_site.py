"""Focused verifier tests: mocked HTTP only, without network access or real sleeps."""
import importlib.util
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse


spec = importlib.util.spec_from_file_location('verify_site', Path(__file__).with_name('verify-site.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class Clock:
    def __init__(self):
        self.now = 0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class VerifySiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.webroot = Path(self.temp.name)
        self.expected = {name: ('THE HYBRID\n' if name == 'index.html' else name + '\n').encode() for name in verify.FILES}
        for name, body in self.expected.items():
            (self.webroot / name).write_bytes(body)
        self.clock = Clock()
        self.logs = []
        self.requests = []

    def good_fetch(self, url, timeout, bypass_cache):
        self.requests.append((url, timeout, bypass_cache))
        name = urllib.parse.urlsplit(url).path.rsplit('/', 1)[-1] or 'index.html'
        return 200, self.expected[name].replace(b'\n', b'\r\n'), '', False

    def run_check(self, fetch=None, **kwargs):
        return verify.verify_site('https://example.com/tracker/', 'release / label', self.webroot,
                                  fetch=fetch or self.good_fetch, clock=self.clock,
                                  sleep=self.clock.sleep, emit=self.logs.append, **kwargs)

    def test_current_root_and_seven_files_use_cache_queries_and_plain_homepage_is_normal(self):
        self.assertTrue(self.run_check())
        self.assertEqual(len(self.requests), 9)
        for url, timeout, bypass in self.requests[:-1]:
            parsed = urllib.parse.urlsplit(url)
            self.assertEqual(parsed.scheme, 'https')
            self.assertTrue(parsed.path.startswith('/tracker/'))
            self.assertEqual(urllib.parse.parse_qs(parsed.query)['hybrid_verify'], ['release / label'])
            self.assertTrue(bypass)
            self.assertLessEqual(timeout, 5)
        self.assertEqual(self.requests[-1], ('https://example.com/tracker/', 5.0, False))
        self.assertEqual(self.clock.sleeps, [])

    def test_transient_status_and_stale_asset_retry_only_failed_paths(self):
        seen = {}

        def fetch(url, timeout, bypass):
            path = urllib.parse.urlsplit(url).path
            seen[path] = seen.get(path, 0) + 1
            if bypass and path.endswith('/app.js') and seen[path] == 1:
                return 200, b'outdated application SECRET_BODY', '', False
            if path.endswith('/plan.json') and seen[path] == 1:
                return 403, b'SECRET_BODY', 'unexpected HTTP status', True
            return self.good_fetch(url, timeout, bypass)

        self.assertTrue(self.run_check(fetch))
        self.assertEqual(self.clock.sleeps, [10])
        self.assertEqual(seen['/tracker/app.js'], 2)
        self.assertEqual(seen['/tracker/plan.json'], 2)
        self.assertEqual(seen['/tracker/style.css'], 1)
        self.assertNotIn('SECRET_BODY', '\n'.join(self.logs))
        self.assertNotIn('release / label', '\n'.join(self.logs))

    def test_persistent_mismatch_fails_after_three_attempts_and_twenty_seconds_backoff(self):
        def fetch(url, timeout, bypass):
            if url.split('?', 1)[0].endswith('/app.js'):
                return 200, b'stale', '', False
            return self.good_fetch(url, timeout, bypass)

        self.assertFalse(self.run_check(fetch))
        self.assertEqual(self.clock.sleeps, [10, 10])
        self.assertLessEqual(self.clock.now, 30)

    def test_deadline_bounds_requests_and_does_not_start_a_long_backoff(self):
        def fetch(url, timeout, bypass):
            self.requests.append((url, timeout, bypass))
            self.clock.now += timeout
            return None, b'', 'request timed out', True

        self.assertFalse(self.run_check(fetch, budget=3))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.clock.now, 3)
        self.assertEqual(self.clock.sleeps, [])

    def test_invalid_or_credential_bearing_url_is_rejected_without_echoing_it(self):
        for url in ['http://example.com/', 'https://user:SECRET_PASSWORD@example.com/', 'https://example.com/?secret=value']:
            logs = []
            self.assertFalse(verify.verify_site(url, webroot=self.webroot, fetch=self.good_fetch, emit=logs.append))
            self.assertNotIn('SECRET_PASSWORD', '\n'.join(logs))
        self.assertEqual(self.requests, [])

    def test_https_transport_checks_certificates_and_never_logs_raw_tls_errors(self):
        failure = urllib.error.URLError(ssl.SSLCertVerificationError(1, 'SECRET_SERVER_DETAILS'))
        with patch.object(verify.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = failure
            status, body, reason, retry = verify.read_https('https://example.com/', 2, True)
            context = build.call_args.args[0]._context
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertIsNone(status)
            self.assertEqual(body, b'')
            self.assertEqual(reason, 'TLS certificate verification failed')
            self.assertFalse(retry)
        with self.assertRaises(ValueError):
            verify.HTTPSOnlyRedirect().redirect_request(None, None, 302, '', {}, 'http://example.com/')

    def test_a_plain_homepage_without_the_dashboard_marker_fails(self):
        def fetch(url, timeout, bypass):
            return self.good_fetch(url, timeout, bypass) if bypass else (200, b'Hosting default page', '', False)

        self.assertFalse(self.run_check(fetch))
        self.assertEqual(self.clock.sleeps, [10, 10])
        self.assertIn('normal homepage', '\n'.join(self.logs))


if __name__ == '__main__':
    unittest.main()
