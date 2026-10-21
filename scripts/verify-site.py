"""Verify an FTP deployment against htdocs without printing response bodies or secrets.

WEBSITE_URL defaults to https://cleaninglondon.online/. RELEASE_SHA is an optional
cache-busting label. No FTP credentials are read by this script.
"""
import os
from pathlib import Path
import queue
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


FILES = ('index.html', 'app.js', 'style.css', 'storage.js', 'schedule.js',
         'runtime-config.js', 'plan.json')
WEBROOT = Path(__file__).resolve().parents[1] / 'htdocs'
DEFAULT_URL = 'https://cleaninglondon.online/'
MAX_BYTES = 2_000_000


class HTTPSOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme.lower() != 'https':
            raise ValueError('HTTPS redirect required')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def base_url(value):
    parsed = urllib.parse.urlsplit(value.strip())
    if (parsed.scheme.lower() != 'https' or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment):
        raise ValueError('WEBSITE_URL must be an HTTPS directory URL without credentials, query or fragment.')
    return urllib.parse.urlunsplit(('https', parsed.netloc, parsed.path.rstrip('/') + '/', '', ''))


def read_https(url, timeout, bypass_cache):
    """Return (status, body, safe reason, retryable); never return raw error text."""
    headers = {'User-Agent': 'THE-HYBRID-Deploy-Check/1.0'}
    if bypass_cache:
        headers.update({'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    context = ssl.create_default_context()
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), HTTPSOnlyRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            if urllib.parse.urlsplit(response.geturl()).scheme.lower() != 'https':
                return None, b'', 'HTTPS redirect required', False
            status = response.status
            if status != 200:
                return status, b'', 'unexpected HTTP status', status in (403, 404, 408, 429) or status >= 500
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                return status, b'', 'response exceeds size limit', False
            return status, body, '', False
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, b'', 'unexpected HTTP status', status in (403, 404, 408, 429) or status >= 500
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            return None, b'', 'TLS certificate verification failed', False
        return None, b'', 'network connection failed', True
    except ssl.SSLCertVerificationError:
        return None, b'', 'TLS certificate verification failed', False
    except (TimeoutError, socket.timeout):
        return None, b'', 'request timed out', True
    except ssl.SSLError:
        return None, b'', 'TLS connection failed', False
    except ValueError:
        return None, b'', 'HTTPS redirect required', False
    except OSError:
        return None, b'', 'network connection failed', True


def fetch_bytes(url, timeout, bypass_cache):
    # A daemon worker bounds the whole response, including a slow/trickling body.
    # urllib's own timeout also bounds sockets; an expired worker cannot delay exit.
    result = queue.Queue(maxsize=1)

    def work():
        try:
            result.put(read_https(url, timeout, bypass_cache))
        except Exception:
            result.put((None, b'', 'request failed', False))

    threading.Thread(target=work, daemon=True).start()
    try:
        return result.get(timeout=timeout)
    except queue.Empty:
        return None, b'', 'request timed out', True


def verify_site(website_url=DEFAULT_URL, release_sha='', webroot=WEBROOT, *,
                attempts=3, retry_delay=10, budget=30, fetch=fetch_bytes,
                clock=time.monotonic, sleep=time.sleep, emit=print):
    try:
        base = base_url(website_url)
        expected = {name: (Path(webroot) / name).read_bytes().replace(b'\r\n', b'\n') for name in FILES}
    except (OSError, ValueError):
        emit('FAIL configuration: use an HTTPS WEBSITE_URL and a complete local htdocs folder.')
        return False
    # None is the ordinary homepage: no cache query and no cache-bypassing headers.
    pending = [('', 'index.html')] + [(name, name) for name in FILES] + [(None, None)]
    deadline = clock() + budget
    nonce = uuid.uuid4().hex
    for attempt in range(1, attempts + 1):
        retry = []
        permanent = False
        for path, filename in pending:
            label = '/' + (path or '') + (' (normal homepage)' if path is None else '')
            remaining = deadline - clock()
            if remaining <= 0:
                emit('FAIL ' + label + ': verification time budget reached.')
                return False
            url = urllib.parse.urljoin(base, path or '')
            if path is not None:
                query = urllib.parse.urlencode({'hybrid_verify': release_sha[:128] or nonce,
                                               'attempt': attempt, 'nonce': nonce})
                url += '?' + query
            status, body, reason, retryable = fetch(url, min(5.0, remaining), path is not None)
            if status == 200 and not reason:
                if path is None:
                    current = b'THE HYBRID' in body.upper()
                    reason = '' if current else 'homepage does not identify THE HYBRID'
                else:
                    current = body.replace(b'\r\n', b'\n') == expected[filename]
                    reason = '' if current else 'content differs from htdocs'
                retryable = not current
            if status == 200 and not reason:
                emit('PASS ' + label + ': HTTP 200, current.')
            else:
                status_label = 'HTTP ' + str(status) if status is not None else 'request failed'
                emit('FAIL ' + label + ': ' + status_label + ', ' + reason + '.')
                if retryable:
                    retry.append((path, filename))
                else:
                    permanent = True
        if permanent:
            return False
        if not retry:
            emit('Verified the current dashboard and all seven website files.')
            return True
        if attempt == attempts:
            return False
        remaining = deadline - clock()
        if remaining <= retry_delay:
            emit('FAIL deployment: verification time budget reached.')
            return False
        emit('Retrying outstanding paths in ' + str(retry_delay) + ' seconds.')
        sleep(retry_delay)
        pending = retry
    return False


def main():
    return 0 if verify_site(os.environ.get('WEBSITE_URL', DEFAULT_URL),
                            os.environ.get('RELEASE_SHA', '')) else 1


if __name__ == '__main__':
    raise SystemExit(main())
