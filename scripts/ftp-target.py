#!/usr/bin/env python3
"""Locate an existing FTP webroot without uploading or changing remote files.

The script deliberately has no listing, mkdir, upload, or delete operations.
FTP_PROTOCOL defaults to certificate-verified explicit FTPS; plain FTP must be
selected explicitly. Successful discovery emits GitHub Action outputs only.
"""
from dataclasses import dataclass
import ftplib
import ipaddress
import os
import posixpath
import re
import ssl
import sys
from urllib.parse import urlsplit


class PreflightError(Exception):
    """An actionable error safe to show without raw FTP responses or secrets."""


@dataclass(repr=False, frozen=True)
class Settings:
    server: str
    port: int
    protocol: str
    username: str
    password: str
    website_host: str
    server_dir: str | None


def required(environ, name):
    value = environ.get(name, '')
    if not isinstance(value, str) or not value:
        raise PreflightError(f'Set the {name} repository secret before deploying.')
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise PreflightError(f'{name} cannot contain newlines or control characters.')
    return value


def hostname(value):
    try:
        host = value.rstrip('.').encode('idna').decode('ascii').lower()
        if ':' in host:
            ipaddress.ip_address(host)
        elif not host or len(host) > 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.')):
            raise ValueError()
        return host
    except (AttributeError, UnicodeError, ValueError):
        raise PreflightError('FTP_SERVER must contain a valid hostname or IP address, without credentials.') from None


def directory(value):
    if not isinstance(value, str) or not value or value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value) or any(char in value for char in '\\*?[]'):
        raise PreflightError('FTP_SERVER_DIR must be one existing directory path without wildcards, backslashes, or control characters.')
    if value in ('.', './'):
        return './'
    return value.rstrip('/') + '/' if value.rstrip('/') else '/'


def settings_from(environ):
    raw = required(environ, 'FTP_SERVER')
    if any(char.isspace() for char in raw):
        raise PreflightError('FTP_SERVER must be a hostname or FTP URL without whitespace.')
    protocol = environ.get('FTP_PROTOCOL', 'ftps').lower()
    if protocol not in ('ftp', 'ftps'):
        raise PreflightError('FTP_PROTOCOL must be ftps or ftp. FTPS is the default; no automatic downgrade is allowed.')
    try:
        address = urlsplit(raw if '://' in raw else '//' + raw)
        if address.scheme and address.scheme not in ('ftp', 'ftps'):
            raise ValueError()
        if address.username is not None or address.password is not None or address.path not in ('', '/') or address.query or address.fragment:
            raise ValueError()
        host = hostname(address.hostname)
        port = address.port if address.port is not None else 21
        if not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, TypeError):
        raise PreflightError('FTP_SERVER must be a hostname or ftp:// or ftps:// address with an optional port and no credentials or directory path.') from None
    if address.scheme and address.scheme != protocol:
        raise PreflightError('The FTP_SERVER URL scheme and FTP_PROTOCOL differ. Choose matching protocols; FTPS will never silently fall back to FTP.')
    website = environ.get('FTP_WEBSITE_URL', 'https://cleaninglondon.online/')
    try:
        if not isinstance(website, str) or any(char.isspace() for char in website):
            raise ValueError()
        parsed = urlsplit(website)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment or ':' in parsed.hostname:
            raise ValueError()
        website_host = hostname(parsed.hostname)
    except (ValueError, TypeError, PreflightError):
        raise PreflightError('FTP_WEBSITE_URL must be your website root URL, for example https://cleaninglondon.online/.') from None
    override = environ.get('FTP_SERVER_DIR')
    return Settings(host, port, protocol, required(environ, 'FTP_USERNAME'), required(environ, 'FTP_PASSWORD'), website_host, directory(override) if override else None)


def pwd(client):
    value = client.pwd()
    if not isinstance(value, str) or not value.startswith('/') or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise PreflightError('The FTP server returned an ambiguous working directory. Set FTP_SERVER_DIR to a known existing webroot.')
    return value


def ftp_status(error):
    match = re.match(r'^([1-6][0-9]{2})(?:\D|$)', str(error)) if isinstance(error, ftplib.Error) else None
    return f' (FTP status {match.group(1)})' if match else ''


def find_target(client, settings):
    login_root = pwd(client)
    if settings.server_dir is not None:
        try:
            client.cwd(settings.server_dir)
            pwd(client)
        except ftplib.error_perm as error:
            raise PreflightError('FTP_SERVER_DIR does not exist or is inaccessible. Create the correct webroot in your hosting panel or supply its existing FTP path' + ftp_status(error) + '.') from None
        return settings.server_dir
    # A jailed account already in its webroot must not receive a nested htdocs.
    if posixpath.basename(login_root.rstrip('/')).lower() in ('htdocs', 'public_html'):
        return './'
    last_status = ''
    for candidate in (f'./{settings.website_host}/htdocs/', './htdocs/'):
        try:
            client.cwd(candidate)
            discovered = pwd(client)
        except ftplib.error_perm as error:
            # Each candidate is relative to the login directory, never a prior
            # failed probe or a path guessed from a listing.
            client.cwd(login_root)
            last_status = ftp_status(error)
            continue
        client.cwd(login_root)
        if discovered == login_root:
            raise PreflightError('The FTP server did not distinguish the candidate directory from the login root. Set FTP_SERVER_DIR to the exact existing webroot.')
        return candidate
    raise PreflightError('No existing webroot was identified. Set FTP_SERVER_DIR to the existing directory serving your website (usually ./cleaninglondon.online/htdocs/ or ./htdocs/); no remote directories were created' + last_status + '.')


def close(client):
    try:
        client.quit()
    except ftplib.all_errors:
        try:
            client.close()
        except ftplib.all_errors:
            pass


def preflight(settings):
    client = None
    stage = 'connect'
    try:
        client = ftplib.FTP_TLS(context=ssl.create_default_context(), timeout=30) if settings.protocol == 'ftps' else ftplib.FTP(timeout=30)
        client.connect(settings.server, settings.port)
        if settings.protocol == 'ftps':
            stage = 'TLS negotiation'
            client.auth()
        stage = 'login'
        client.login(settings.username, settings.password)
        if settings.protocol == 'ftps':
            stage = 'TLS negotiation'
            client.prot_p()
        stage = 'directory'
        return find_target(client, settings)
    except PreflightError:
        raise
    except ssl.SSLCertVerificationError:
        raise PreflightError('FTPS certificate verification failed. Confirm that FTP_SERVER matches the host covered by the hosting provider certificate; certificate checks were not disabled.') from None
    except ssl.SSLError:
        raise PreflightError('The server did not complete a secure FTPS connection. Confirm the FTPS host and port with your provider. Select ftp explicitly only if your hosting service requires plain FTP.') from None
    except ftplib.all_errors as error:
        messages = {
            'connect': 'Could not connect to the FTP server. Check FTP_SERVER, its port, and the selected protocol with your hosting provider.',
            'TLS negotiation': 'FTPS TLS negotiation failed. Confirm the host and port support explicit FTPS (AUTH TLS) with your hosting provider.',
            'login': 'FTP authentication failed. Check FTP_USERNAME, FTP_PASSWORD, and the account permissions.',
            'directory': 'The existing FTP webroot could not be verified. Check directory permissions or set FTP_SERVER_DIR to its exact existing path.',
        }
        raise PreflightError(messages[stage].rstrip('.') + ftp_status(error) + '.') from None
    finally:
        if client is not None:
            close(client)


def write_outputs(path, settings, target):
    if not path:
        raise PreflightError('GITHUB_OUTPUT is required so the deployment receives the verified target.')
    try:
        with open(path, 'a', encoding='utf-8') as output:
            output.write(f'server={settings.server}\nport={settings.port}\nprotocol={settings.protocol}\nserver_dir={target}\n')
    except OSError:
        raise PreflightError('The verified FTP target could not be written to GITHUB_OUTPUT.') from None


def main(environ=None):
    environ = os.environ if environ is None else environ
    try:
        settings = settings_from(environ)
        # Register the parsed host before connecting; exception text from FTP or
        # TLS is never printed because it may include credentials or hostnames.
        print('::add-mask::' + settings.server, flush=True)
        target = preflight(settings)
        write_outputs(environ.get('GITHUB_OUTPUT'), settings, target)
        print(f'Existing FTP webroot verified: {target} ({settings.protocol.upper()}). No remote files were changed.')
        return 0
    except PreflightError as error:
        print('::error::' + str(error), file=sys.stderr)
        return 1
    except Exception:
        print('::error::FTP preflight could not complete. Review the FTP settings and existing webroot; raw server responses were withheld.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
