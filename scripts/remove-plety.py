#!/usr/bin/env python3
"""One-time cleanup: delete the plety/ folder a past deploy left in the FTP webroot.

FTP-Deploy-Action tried to remove it as "/plety" (from the FTP root rather than
the webroot), skipped it, and recorded it as gone, so later deploys never retry.
Only the fixed plety/ folder is touched, and only after the webroot is confirmed.
"""
import ftplib
import importlib.util
import os
import posixpath
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location('ftp_target', Path(__file__).with_name('ftp-target.py'))
target = importlib.util.module_from_spec(spec)
sys.modules['ftp_target'] = target
spec.loader.exec_module(target)

FOLDER = 'plety'


def connect(settings):
    client = ftplib.FTP_TLS(context=ssl.create_default_context(), timeout=30) if settings.protocol == 'ftps' else ftplib.FTP(timeout=30)
    client.connect(settings.server, settings.port)
    if settings.protocol == 'ftps':
        client.auth()
    client.login(settings.username, settings.password)
    if settings.protocol == 'ftps':
        client.prot_p()
    return client


def names(client, path=''):
    return {posixpath.basename(name.rstrip('/')) for name in (client.nlst(path) if path else client.nlst())}


def entries(client, path):
    try:
        return [(name, facts.get('type')) for name, facts in client.mlsd(path, facts=['type'])
                if name not in ('.', '..') and facts.get('type') not in ('cdir', 'pdir')]
    except ftplib.error_perm as error:
        if not str(error).startswith(('500', '501', '502')):
            raise
    # No MLSD support: a child is a directory when we can change into it.
    found = []
    here = client.pwd()
    for name in names(client, path) - {'.', '..'}:
        try:
            client.cwd(f'{path}/{name}')
            client.cwd(here)
            found.append((name, 'dir'))
        except ftplib.error_perm:
            found.append((name, 'file'))
    return found


def remove_tree(client, path):
    removed = 0
    for name, kind in entries(client, path):
        child = f'{path}/{name}'
        if kind == 'dir':
            removed += remove_tree(client, child)
        else:
            client.delete(child)
            removed += 1
    client.rmd(path)
    return removed


def live_status(host):
    url = f'https://{host}/{FOLDER}/?cleanup=1'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main():
    try:
        settings = target.settings_from(os.environ)
    except target.PreflightError as error:
        print('::error::' + str(error), file=sys.stderr)
        return 1
    print('::add-mask::' + settings.server, flush=True)
    client = None
    try:
        client = connect(settings)
        webroot = target.find_target(client, settings)
        if settings.server_dir is None and webroot != './':
            client.cwd(webroot)
        listing = names(client)
        if 'index.html' not in listing:
            print('::error::The FTP webroot does not contain index.html, so nothing was deleted.', file=sys.stderr)
            return 1
        if FOLDER not in listing:
            print(f'{FOLDER}/ is not in the webroot. Nothing to delete.')
        else:
            print(f'Deleted {remove_tree(client, FOLDER)} files and the {FOLDER}/ folder from the webroot.')
    except target.PreflightError as error:
        print('::error::' + str(error), file=sys.stderr)
        return 1
    except ftplib.all_errors as error:
        print('::error::FTP cleanup failed' + target.ftp_status(error) + '. Raw server responses were withheld.', file=sys.stderr)
        return 1
    finally:
        if client is not None:
            target.close(client)
    status = live_status(settings.website_host)
    if status == 200:
        print(f'::error::https://{settings.website_host}/{FOLDER}/ still returns HTTP 200.', file=sys.stderr)
        return 1
    print(f'https://{settings.website_host}/{FOLDER}/ now returns HTTP {status}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
