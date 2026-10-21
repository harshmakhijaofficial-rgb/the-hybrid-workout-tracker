"""Regression tests for storage, backups, Sheets synchronization, and the HTTP app.

Run with ``python test_app.py``; no Google account or third-party packages needed.
"""
import copy
import importlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request


class Execute:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class MockSheets:
    def __init__(self, kinds):
        self.values_by_tab = {tab: [list(fields)] for tab, fields in kinds.values()}
        self.calls = []

    def spreadsheets(self):
        return self

    def values(self):
        return self

    def get(self, **kwargs):
        tab = kwargs['range'].split('!')[0].strip("'")
        return Execute(lambda: {'values': copy.deepcopy(self.values_by_tab[tab])})

    def clear(self, **kwargs):
        tab = kwargs['range'].split('!')[0].strip("'")

        def execute():
            self.calls.append(('clear', tab))
            self.values_by_tab[tab] = self.values_by_tab[tab][:1]
            return {}

        return Execute(execute)

    def update(self, **kwargs):
        tab = kwargs['range'].split('!')[0].strip("'")
        data = kwargs['body']['values']

        def execute():
            self.calls.append(('update', tab))
            self.values_by_tab[tab] = self.values_by_tab[tab][:1] + copy.deepcopy(data)
            return {}

        return Execute(execute)


class TrackerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.import_directory = tempfile.TemporaryDirectory()
        with mock.patch.dict(os.environ, {'HYBRID_DATA_DIR': cls.import_directory.name}):
            cls.server = importlib.import_module('server')

    @classmethod
    def tearDownClass(cls):
        cls.import_directory.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name)
        patcher = mock.patch.multiple(self.server, DATA=self.data, DB=self.data / 'workouts.sqlite3')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server.initialize()
        self.first = {
            'id': '2026-10-20__tue_legpress__1', 'date': '2026-10-20',
            'day': 'Tuesday', 'exercise_id': 'tue_legpress', 'exercise': 'Leg Press',
            'set_number': '1', 'weight_kg': '18', 'reps': '12', 'rir': '2',
            'completed': 'TRUE', 'note': 'Smooth',
        }
        self.sheets = MockSheets(self.server.KIND)
        patcher = mock.patch.object(self.server, 'google_service', return_value=self.sheets)
        patcher.start()
        self.addCleanup(patcher.stop)

    def records(self):
        return self.server.state()['records']

    def note(self, identifier='note_1', **extra):
        return {'id': identifier, 'date': '2026-10-24', 'day': 'Saturday',
                'category': 'Recovery', 'note': 'Rest day', **extra}

    def test_sqlite_persists_and_connections_close(self):
        saved = self.server.save('sets', self.first)
        self.assertEqual(self.records()['sets'], [saved])
        # Windows cannot rename/delete this file while a SQLite handle is open.
        moved = self.data / 'moved.sqlite3'
        self.server.DB.rename(moved)
        moved.rename(self.server.DB)
        self.server.initialize()
        self.assertEqual(self.records()['sets'][0]['weight_kg'], '18')

    def test_numeric_and_calendar_validation(self):
        invalid = [
            {'date': '2026-02-30'}, {'date': 'invalid'}, {'set_number': '31'},
            {'weight_kg': '-1'}, {'weight_kg': 'NaN'}, {'weight_kg': 'Infinity'},
            {'weight_kg': 'junk'}, {'reps': '2.5'}, {'reps': ''}, {'reps': '0'},
            {'rir': '11'}, {'rir': '1.5'}, {'completed': 'unknown'},
        ]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.server.save('sets', {**self.first, **changes})
        self.assertEqual(self.records()['sets'], [])
        self.server.save('sets', {**self.first, 'completed': False, 'reps': '', 'weight_kg': '0'})
        self.assertEqual(self.records()['sets'][0]['completed'], 'FALSE')

    def test_weekend_journal_and_measurement_validation(self):
        self.server.save('notes', self.note())
        checkin = {'id': 'checkin__2026-10-24', 'date': '2026-10-24', 'day': 'Saturday',
                   'bodyweight_kg': '70.2', 'sleep_hours': '7.5', 'energy': '4', 'duration_min': '0'}
        self.server.save('checkins', checkin)
        self.assertEqual(len(self.records()['notes']), 1)
        self.assertEqual(len(self.records()['checkins']), 1)
        for field, value in [('sleep_hours', '25'), ('energy', '6'), ('duration_min', '-1'), ('bodyweight_kg', 'NaN')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.server.save('checkins', {**checkin, field: value})
        with self.assertRaises(ValueError):
            self.server.save('notes', self.note(note='   '))
        with self.assertRaises(ValueError):
            self.server.save('sets', {**self.first, 'day': 'Saturday'})
        cardio = {'id': 'cardio_1', 'date': '2026-10-20', 'day': 'Tuesday', 'type': 'Bike', 'minutes': '20'}
        for changes in [{'day': 'Sunday'}, {'minutes': '-5'}, {'level': '101'}, {'effort': '11'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.server.save('cardio', {**cardio, **changes})
        self.server.save('cardio', cardio)

    def test_invalid_backup_does_not_partially_modify_existing_records(self):
        self.server.save('sets', self.first)
        before = self.records()
        backup = {'version': 1, 'records': {
            'sets': [{**self.first, 'weight_kg': '99'}],
            'notes': [self.note('valid_note'), self.note('invalid_note', date='invalid')],
        }}
        with self.assertRaises(ValueError):
            self.server.import_backup(backup)
        self.assertEqual(self.records(), before)
        for malformed in [[], {'version': 1, 'records': {'unknown': []}},
                          {'version': 1, 'records': {'sets': {}}},
                          {'version': 1, 'records': {'notes': [self.note(), self.note()]}}]:
            with self.subTest(backup=malformed), self.assertRaises(ValueError):
                self.server.import_backup(malformed)
        self.assertEqual(self.records(), before)

    def test_backup_transaction_rolls_back_write_failures(self):
        original_save = self.server.save_item

        def fail_second(conn, kind, item):
            if item['id'] == 'second':
                raise sqlite3.OperationalError('Simulated disk error')
            original_save(conn, kind, item)

        with mock.patch.object(self.server, 'save_item', side_effect=fail_second):
            with self.assertRaises(sqlite3.OperationalError):
                self.server.import_backup({'version': 1, 'records': {
                    'notes': [self.note('first'), self.note('second')],
                }})
        self.assertEqual(self.records()['notes'], [])
        result = self.server.import_backup({'version': 1, 'records': {'notes': [self.note()]}})
        self.assertEqual(result['imported'], {'notes': 1})

    def test_google_sync_push_pull_conflict_delete_and_manual_note(self):
        self.server.save('sets', self.first)
        self.assertEqual(self.server.sync()['pushed'], 1)
        self.assertEqual(len(self.sheets.values_by_tab['Workout Logs']), 2)
        self.sheets.calls.clear()
        repeated = self.server.sync()
        self.assertEqual((repeated['pushed'], repeated['pulled']), (0, 0))
        self.assertEqual(self.sheets.calls, [])
        weight_column = list(self.server.KIND['sets'][1]).index('weight_kg')
        self.sheets.values_by_tab['Workout Logs'][1][weight_column] = '20'
        self.assertEqual(self.server.sync()['pulled'], 1)
        self.assertEqual(self.records()['sets'][0]['weight_kg'], '20')
        self.server.save('sets', {**self.first, 'weight_kg': '22'})
        self.sheets.values_by_tab['Workout Logs'][1][weight_column] = '25'
        self.assertEqual(self.server.sync()['conflicts'], 1)
        self.assertEqual(self.records()['sets'][0]['weight_kg'], '22')
        conflicts = json.loads((self.data / 'sync_conflicts.json').read_text(encoding='utf-8'))
        self.assertEqual(conflicts[0]['google']['weight_kg'], '25')
        self.server.remove('sets', self.first['id'])
        self.server.sync()
        self.assertEqual(len(self.sheets.values_by_tab['Workout Logs']), 1)
        self.sheets.values_by_tab['Daily Notes'].append(['', '2026-10-24', 'Saturday', 'Recovery', 'Added in Sheets', ''])
        self.assertEqual(self.server.sync()['pulled'], 1)
        self.assertTrue(self.sheets.values_by_tab['Daily Notes'][1][0].startswith('sheetnote__'))
        self.assertEqual(self.records()['notes'][0]['note'], 'Added in Sheets')

    def test_schedule_shift_preserves_historical_set_identity(self):
        # Exercise IDs retain their original weekday prefixes after the programme
        # moves to Tue–Mon. Historical day labels must remain importable.
        historical = {**self.first, 'id': '2026-10-20__mon_chest_press__1',
                      'day': 'Monday', 'exercise_id': 'mon_chest_press',
                      'exercise': 'Machine Chest Press'}
        self.server.import_backup({'version': 1, 'records': {'sets': [historical]}})
        self.server.sync()
        self.server.save('sets', {**historical, 'day': 'Tuesday', 'weight_kg': '20'})
        result = self.server.sync()
        self.assertEqual(result['pushed'], 1)
        self.assertEqual(result['conflicts'], 0)
        records = self.records()['sets']
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['id'], historical['id'])
        self.assertEqual(records[0]['day'], 'Tuesday')
        self.assertEqual(records[0]['weight_kg'], '20')
        self.assertEqual(len(self.sheets.values_by_tab['Workout Logs']), 2)

    def test_remote_bad_headers_fail_before_any_tab_is_changed(self):
        self.server.save('sets', self.first)  # First tab would otherwise be written.
        headers = self.sheets.values_by_tab['Check-ins'][0]
        headers[0], headers[1] = headers[1], headers[0]
        before = copy.deepcopy(self.sheets.values_by_tab)
        with self.assertRaisesRegex(ValueError, 'column names and order'):
            self.server.sync()
        self.assertEqual(self.sheets.calls, [])
        self.assertEqual(self.sheets.values_by_tab, before)
        self.assertIsNone(self.server.state()['last_sync'])

    def test_merged_sync_limit_fails_before_any_tab_is_cleared(self):
        self.server.save('sets', self.first)  # Earlier tab would otherwise be cleared.
        for number in range(3):
            self.server.save('notes', self.note(f'note_{number}'))
        before = self.records()
        with mock.patch.object(self.server, 'MAX_SYNC_ROWS', 2):
            with self.assertRaisesRegex(ValueError, 'Too many entries'):
                self.server.sync()
        self.assertEqual(self.sheets.calls, [])
        self.assertEqual(self.records(), before)
        self.assertIsNone(self.server.state()['last_sync'])

    def test_remote_overflow_and_invalid_rows_are_rejected_without_writes(self):
        self.server.save('sets', self.first)
        fields = self.server.KIND['notes'][1]
        for number in range(3):
            note = self.note(f'remote_{number}')
            self.sheets.values_by_tab['Daily Notes'].append([note.get(field, '') for field in fields])
        with mock.patch.object(self.server, 'MAX_SYNC_ROWS', 2):
            with self.assertRaisesRegex(ValueError, 'Too many entries'):
                self.server.sync()
        self.assertEqual(self.sheets.calls, [])
        self.sheets.values_by_tab['Daily Notes'][1][list(fields).index('date')] = 'invalid'
        with self.assertRaisesRegex(ValueError, 'Daily Notes row 2'):
            self.server.sync()
        self.assertEqual(self.sheets.calls, [])
        self.assertEqual(self.records()['notes'], [])

    def test_token_alone_does_not_claim_google_is_connected(self):
        (self.data / 'token.json').write_text('{}', encoding='utf-8')
        with mock.patch.object(self.server, 'SPREADSHEET_ID', ''):
            self.assertFalse(self.server.state()['connected'])

    def test_http_assets_save_export_and_atomic_import(self):
        httpd = self.server.ThreadingHTTPServer(('127.0.0.1', 0), self.server.Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        base = f'http://127.0.0.1:{httpd.server_port}'

        def request(path, data=None):
            body = json.dumps(data).encode('utf-8') if data is not None else None
            with urllib.request.urlopen(urllib.request.Request(
                    base + path, data=body, headers={'Content-Type': 'application/json'}), timeout=5) as response:
                return response.status, response.read()

        try:
            asset_files = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
                           '/style.css': 'style.css', '/storage.js': 'storage.js',
                           '/schedule.js': 'schedule.js', '/plan.json': 'plan.json'}
            for path, filename in asset_files.items():
                status, payload = request(path)
                self.assertEqual(status, 200)
                self.assertEqual(payload, (self.server.WEBROOT / filename).read_bytes())
            static_runtime = (self.server.WEBROOT / 'runtime-config.js').read_text(encoding='utf-8')
            self.assertRegex(static_runtime, r"""HYBRID_STORAGE_MODE\s*=\s*['"]browser['"]""")
            status, payload = request('/runtime-config.js')
            self.assertEqual(status, 200)
            local_runtime = payload.decode('utf-8')
            self.assertRegex(local_runtime, r"""HYBRID_STORAGE_MODE\s*=\s*['"]server['"]""")
            self.assertNotRegex(local_runtime, r"""HYBRID_STORAGE_MODE\s*=\s*['"]browser['"]""")
            # Serving the local mode must leave the FTP-ready source untouched.
            self.assertEqual((self.server.WEBROOT / 'runtime-config.js').read_text(encoding='utf-8'), static_runtime)
            _, payload = request('/api/state')
            self.assertEqual(json.loads(payload)['plan'], json.loads((self.server.WEBROOT / 'plan.json').read_text(encoding='utf-8')))
            _, payload = request('/api/records/sets', self.first)
            self.assertTrue(json.loads(payload)['ok'])
            _, payload = request('/api/export')
            backup = json.loads(payload)
            self.assertEqual(backup['records']['sets'][0]['weight_kg'], '18')
            before = self.records()
            for invalid in [[], {'version': 1, 'records': {'sets': [self.first, {**self.first, 'id': 'bad', 'reps': '-1'}]}}]:
                with self.assertRaises(urllib.error.HTTPError) as result:
                    request('/api/import', invalid)
                with result.exception as error_response:
                    self.assertEqual(error_response.code, 400)
                    self.assertIn('error', json.loads(error_response.read()))
                self.assertEqual(self.records(), before)
            _, payload = request('/api/import', backup)
            self.assertEqual(json.loads(payload)['imported']['sets'], 1)
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
