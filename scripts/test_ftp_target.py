"""Mocked, network-free checks for read-only FTP deployment target discovery."""
import contextlib
import ftplib
import importlib.util
import io
from pathlib import Path
import posixpath
import ssl
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('ftp_target', Path(__file__).with_name('ftp-target.py'))
target = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = target
spec.loader.exec_module(target)


class FakeFTP:
    def __init__(self, root='/', paths=()):
        self.current = root
        self.paths = {root, *paths}
        self.commands = []

    def connect(self, host, port):
        self.commands.append(('connect', host, port))

    def login(self, username, password):
        self.commands.append(('login', username, password))

    def auth(self):
        self.commands.append(('auth',))

    def prot_p(self):
        self.commands.append(('prot_p',))

    def pwd(self):
        self.commands.append(('pwd',))
        return self.current

    def cwd(self, path):
        self.commands.append(('cwd', path))
        destination = posixpath.normpath(posixpath.join(self.current, path))
        if destination not in self.paths:
            raise ftplib.error_perm('550 rejected ftp.example.invalid fake-user fake-password')
        self.current = destination

    def quit(self):
        self.commands.append(('quit',))

    def close(self):
        self.commands.append(('close',))


class FTPPreflightTests(unittest.TestCase):
    def environ(self, **overrides):
        return {'FTP_SERVER': 'ftp.example.invalid', 'FTP_USERNAME': 'fake-user',
                'FTP_PASSWORD': 'fake-password', 'FTP_WEBSITE_URL': 'https://cleaninglondon.online/', **overrides}

    def settings(self, **overrides):
        return target.settings_from(self.environ(**overrides))

    def test_parses_host_and_explicit_ports_without_exposing_credentials(self):
        settings = self.settings(FTP_SERVER='ftps://FTP.EXAMPLE.INVALID:2121/')
        self.assertEqual((settings.server, settings.port, settings.protocol), ('ftp.example.invalid', 2121, 'ftps'))
        self.assertNotIn('fake-password', repr(settings))
        plain = self.settings(FTP_SERVER='ftp://ftp.example.invalid:21', FTP_PROTOCOL='ftp')
        self.assertEqual(plain.protocol, 'ftp')
        for server in ['ftp://fake-user:fake-password@ftp.example.invalid', 'ftps://ftp.example.invalid/htdocs/',
                       'ftps://ftp.example.invalid?query=x', 'ftps://ftp.example.invalid#fragment',
                       'ftp.example.invalid\n', 'ftp.example.invalid:0', 'ftp.example.invalid:65536',
                       'https://ftp.example.invalid', 'ftp://ftp.example.invalid']:
            with self.subTest(server=server), self.assertRaises(target.PreflightError):
                self.settings(FTP_SERVER=server)

    def test_domain_specific_webroot_wins_and_only_working_directory_probes_are_used(self):
        client = FakeFTP(paths=['/cleaninglondon.online/htdocs', '/htdocs'])
        self.assertEqual(target.find_target(client, self.settings()), './cleaninglondon.online/htdocs/')
        self.assertEqual(client.current, '/')
        self.assertEqual(client.commands, [('pwd',), ('cwd', './cleaninglondon.online/htdocs/'), ('pwd',), ('cwd', '/')])

    def test_falls_back_to_existing_htdocs_relative_to_login_root(self):
        client = FakeFTP('/accounts/login', ['/accounts/login/htdocs'])
        self.assertEqual(target.find_target(client, self.settings()), './htdocs/')
        self.assertEqual(client.current, '/accounts/login')
        self.assertIn(('cwd', '/accounts/login'), client.commands)
        self.assertTrue(all(command[0] in ('pwd', 'cwd') for command in client.commands))

    def test_already_jailed_known_webroots_use_current_directory(self):
        for root in ['/accounts/site/htdocs', '/accounts/site/public_html/']:
            with self.subTest(root=root):
                client = FakeFTP(root)
                self.assertEqual(target.find_target(client, self.settings()), './')
                self.assertEqual(client.commands, [('pwd',)])

    def test_explicit_directory_must_exist_and_unknown_targets_are_rejected(self):
        client = FakeFTP(paths=['/custom/webroot'])
        self.assertEqual(target.find_target(client, self.settings(FTP_SERVER_DIR='/custom/webroot')), '/custom/webroot/')
        for settings in [self.settings(), self.settings(FTP_SERVER_DIR='/missing')]:
            with self.subTest(override=settings.server_dir), self.assertRaises(target.PreflightError):
                target.find_target(FakeFTP(), settings)
        for path in ['/htdocs/\n', './*', './htdocs\\', ' ./htdocs/']:
            with self.subTest(path=path), self.assertRaises(target.PreflightError):
                self.settings(FTP_SERVER_DIR=path)

    def test_ftps_verifies_certificates_and_requires_private_data_channel(self):
        client = FakeFTP(paths=['/htdocs'])
        with mock.patch.object(target.ftplib, 'FTP_TLS', return_value=client) as secure, \
                mock.patch.object(target.ftplib, 'FTP') as plain:
            self.assertEqual(target.preflight(self.settings()), './htdocs/')
        context = secure.call_args.kwargs['context']
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        plain.assert_not_called()
        self.assertEqual([command[0] for command in client.commands[:4]], ['connect', 'auth', 'login', 'prot_p'])
        self.assertEqual(client.commands[-1], ('quit',))

    def test_plain_ftp_is_available_only_when_explicitly_selected(self):
        client = FakeFTP('/public_html')
        with mock.patch.object(target.ftplib, 'FTP', return_value=client) as plain, \
                mock.patch.object(target.ftplib, 'FTP_TLS') as secure:
            self.assertEqual(target.preflight(self.settings(FTP_PROTOCOL='ftp')), './')
        plain.assert_called_once_with(timeout=30)
        secure.assert_not_called()
        self.assertNotIn(('prot_p',), client.commands)

    def test_certificate_or_login_failure_never_downgrades_or_prints_server_responses(self):
        for method, failure, message in [
                ('auth', ssl.SSLCertVerificationError('ftp.example.invalid fake-user fake-password'), 'certificate verification failed'),
                ('auth', ftplib.error_perm('500 ftp.example.invalid fake-user fake-password'), 'TLS negotiation failed'),
                ('login', ftplib.error_perm('530 ftp.example.invalid fake-user fake-password'), 'authentication failed')]:
            with self.subTest(method=method, failure=type(failure).__name__):
                client = FakeFTP()
                setattr(client, method, mock.Mock(side_effect=failure))
                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.object(target.ftplib, 'FTP_TLS', return_value=client), \
                        mock.patch.object(target.ftplib, 'FTP') as plain, \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    self.assertEqual(target.main(self.environ()), 1)
                plain.assert_not_called()
                self.assertIn('::add-mask::ftp.example.invalid', output.getvalue())
                for secret in ['ftp.example.invalid', 'fake-user', 'fake-password']:
                    self.assertNotIn(secret, errors.getvalue())
                self.assertIn(message, errors.getvalue())
                if isinstance(failure, ftplib.Error):
                    self.assertIn('FTP status ' + str(failure)[:3], errors.getvalue())
                self.assertEqual(client.commands[-1], ('quit',))

    def test_outputs_verified_action_inputs_and_logs_no_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            output_file = Path(temporary) / 'github-output'
            output, errors = io.StringIO(), io.StringIO()
            client = FakeFTP(paths=['/htdocs'])
            with mock.patch.object(target.ftplib, 'FTP_TLS', return_value=client), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                result = target.main(self.environ(GITHUB_OUTPUT=str(output_file)))
            self.assertEqual(result, 0)
            self.assertEqual(errors.getvalue(), '')
            self.assertEqual(dict(line.split('=', 1) for line in output_file.read_text().splitlines()),
                             {'server': 'ftp.example.invalid', 'port': '21', 'protocol': 'ftps', 'server_dir': './htdocs/'})
            self.assertIn('Existing FTP webroot verified: ./htdocs/', output.getvalue())
            for secret in ['fake-user', 'fake-password']:
                self.assertNotIn(secret, output.getvalue())
            self.assertTrue(all(command[0] in ('connect', 'auth', 'login', 'prot_p', 'pwd', 'cwd', 'quit') for command in client.commands))

    def test_ambiguous_directory_and_unsanitized_server_text_are_never_accepted(self):
        client = FakeFTP()
        client.cwd = mock.Mock()  # A broken server claims success but stays at /.
        with self.assertRaisesRegex(target.PreflightError, 'did not distinguish'):
            target.find_target(client, self.settings())
        self.assertEqual(target.ftp_status(ftplib.error_perm('550\n::error::fake-password')), ' (FTP status 550)')
        self.assertEqual(target.ftp_status(ftplib.error_perm('fake-password 550')), '')


if __name__ == '__main__':
    unittest.main(verbosity=2)
