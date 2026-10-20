"""THE HYBRID — localhost-only workout tracker with optional two-way Sheets sync.

The standard library serves the UI and stores data in SQLite. Google libraries
are imported only during sync, so offline tracking works without pip installs.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('HYBRID_DATA_DIR', str(ROOT / 'data'))).resolve()
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'workouts.sqlite3'
CONFIG = json.loads((ROOT / 'config.json').read_text(encoding='utf-8'))
PLAN = json.loads((ROOT / 'plan.json').read_text(encoding='utf-8'))
SPREADSHEET_ID = str(CONFIG.get('spreadsheet_id') or '').strip()
SHEET_URL = f'https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit' if SPREADSHEET_ID else ''
LOCK = threading.RLock()
KIND = {
    'sets': ('Workout Logs', ('id', 'date', 'day', 'exercise_id', 'exercise', 'set_number', 'weight_kg', 'reps', 'rir', 'completed', 'note', 'updated_at')),
    'cardio': ('Cardio', ('id', 'date', 'day', 'type', 'minutes', 'level', 'effort', 'note', 'updated_at')),
    'notes': ('Daily Notes', ('id', 'date', 'day', 'category', 'note', 'updated_at')),
    'checkins': ('Check-ins', ('id', 'date', 'day', 'bodyweight_kg', 'sleep_hours', 'energy', 'duration_min', 'note', 'updated_at')),
}
DAYS = {day['day'] for day in PLAN['days']}
CALENDAR_DAYS = DAYS | {'Saturday', 'Sunday'}
MAX_SYNC_ROWS = 4999


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


@contextmanager
def db():
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    with db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, baseline TEXT, PRIMARY KEY (kind, id))')
        conn.execute('CREATE TABLE IF NOT EXISTS deletions (kind TEXT NOT NULL, id TEXT NOT NULL, baseline TEXT, PRIMARY KEY (kind, id))')
        conn.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')


def valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Date must be YYYY-MM-DD.')
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError('Invalid calendar date.')
    return value


def numeric(item, field, minimum, maximum, *, integer=False):
    value = item[field]
    if value == '':
        return
    try:
        number = float(value)
    except (ValueError, OverflowError):
        raise ValueError(f'{field} must be a number.')
    if not math.isfinite(number) or not minimum <= number <= maximum or (integer and not number.is_integer()):
        unit = 'whole number' if integer else 'number'
        raise ValueError(f'{field} must be a {unit} between {minimum} and {maximum}.')


def sanitize(kind, incoming, *, preserve_timestamp=False):
    if kind not in KIND:
        raise ValueError('Unknown record type.')
    if not isinstance(incoming, dict):
        raise ValueError('Provide a record object.')
    fields = KIND[kind][1]
    item = {}
    for key in fields:
        value = incoming.get(key, '')
        if value is None:
            value = ''
        if isinstance(value, (dict, list, tuple)):
            raise ValueError(f'{key} must be a text or numeric value.')
        value = str(value).strip()
        if len(value) > 5000:
            raise ValueError(f'{key} cannot exceed 5,000 characters.')
        item[key] = value
    if not item['id'] or len(item['id']) > 150 or not re.fullmatch(r'[\w.:-]+', item['id']):
        raise ValueError('Invalid record ID.')
    valid_date(item['date'])
    allowed_days = DAYS if kind in ('sets', 'cardio') else CALENDAR_DAYS
    if item['day'] not in allowed_days:
        raise ValueError('Select a weekday in the plan.' if kind in ('sets', 'cardio') else 'Select a valid day of the week.')
    if kind == 'sets':
        if not item['exercise_id'] or not item['exercise']:
            raise ValueError('Exercise ID/name cannot be empty.')
        if not item['set_number'].isdigit() or not (1 <= int(item['set_number']) <= 30):
            raise ValueError('Set number must be 1–30.')
        numeric(item, 'weight_kg', 0, 9999)
        numeric(item, 'reps', 0, 9999, integer=True)
        numeric(item, 'rir', 0, 10, integer=True)
        if item['completed'].lower() not in ('', 'false', '0', 'no', 'true', '1', 'yes'):
            raise ValueError('Completed must be true or false.')
        item['completed'] = 'TRUE' if item['completed'].lower() in ('true', '1', 'yes') else 'FALSE'
        if item['completed'] == 'TRUE' and (item['reps'] == '' or float(item['reps']) <= 0):
            raise ValueError('Enter reps before marking a set complete.')
    elif kind == 'cardio':
        if not item['type']:
            raise ValueError('Select a cardio activity.')
        numeric(item, 'minutes', 0, 500)
        numeric(item, 'level', 0, 100)
        numeric(item, 'effort', 1, 10, integer=True)
    elif kind == 'checkins':
        numeric(item, 'bodyweight_kg', 0, 500)
        numeric(item, 'sleep_hours', 0, 24)
        numeric(item, 'energy', 1, 5, integer=True)
        numeric(item, 'duration_min', 0, 500)
    elif kind == 'notes' and not item['note']:
        raise ValueError('Add a note first.')
    if not preserve_timestamp:
        item['updated_at'] = utc()
    return item


def save(kind, incoming):
    item = sanitize(kind, incoming)
    with LOCK, db() as conn:
        save_item(conn, kind, item)
    return item


def save_item(conn, kind, item):
    old = conn.execute('SELECT baseline FROM records WHERE kind=? AND id=?', (kind, item['id'])).fetchone()
    conn.execute('INSERT INTO records (kind,id,payload,baseline) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload',
                 (kind,item['id'],json.dumps(item,ensure_ascii=False),old['baseline'] if old else None))
    conn.execute('DELETE FROM deletions WHERE kind=? AND id=?', (kind,item['id']))


def import_backup(raw):
    if not isinstance(raw, dict) or type(raw.get('version')) is not int or raw['version'] != 1 or not isinstance(raw.get('records'), dict):
        raise ValueError('Invalid backup format.')
    prepared = {}
    for kind, items in raw['records'].items():
        if kind not in KIND or not isinstance(items, list):
            raise ValueError('Backup record types must be recognized lists.')
        prepared[kind] = [sanitize(kind, item) for item in items]
        if len({item['id'] for item in prepared[kind]}) != len(items):
            raise ValueError(f'Duplicate record ID in {kind} backup.')
    # Validate the complete backup first, then commit every record together.
    with LOCK, db() as conn:
        for kind, items in prepared.items():
            for item in items:
                save_item(conn, kind, item)
    return {'ok': True, 'imported': {kind: len(items) for kind, items in prepared.items()}}


def remove(kind, rid):
    if kind not in KIND:
        raise ValueError('Unknown record type.')
    with LOCK, db() as conn:
        old=conn.execute('SELECT baseline FROM records WHERE kind=? AND id=?',(kind,rid)).fetchone()
        if old and old['baseline']:
            conn.execute('INSERT OR REPLACE INTO deletions(kind,id,baseline) VALUES (?,?,?)',(kind,rid,old['baseline']))
        conn.execute('DELETE FROM records WHERE kind=? AND id=?',(kind,rid))
    return {'deleted':True}


def state():
    with LOCK, db() as conn:
        records={kind:[] for kind in KIND}
        for row in conn.execute('SELECT kind,payload FROM records'):
            records[row['kind']].append(json.loads(row['payload']))
        last=conn.execute("SELECT value FROM settings WHERE key='last_sync'").fetchone()
        return {'plan':PLAN,'records':records,'sheet_url':SHEET_URL,'connected':bool(SPREADSHEET_ID) and (DATA/'token.json').exists(),
                'last_sync':last['value'] if last else None,'offline':True}


def sig(payload):
    if payload is None:
        return None
    # The updated_at column should not need to be manually edited in Sheets.
    return json.dumps({k: str(v) for k,v in sorted(payload.items()) if k != 'updated_at'},sort_keys=True,ensure_ascii=False)


def values_to_records(values, fields, tab):
    if not values or len(values[0]) < len(fields):
        raise ValueError(f'Google Sheet "{tab}" is missing its header row. Please restore the original columns.')
    heads = [str(x).strip() for x in values[0]]
    if heads[:len(fields)] != list(fields):
        raise ValueError(f'Google Sheet "{tab}" has altered headers. Restore the original sync column names and order.')
    if len(values) - 1 > MAX_SYNC_ROWS:
        raise ValueError(f'Too many entries in {tab} (maximum {MAX_SYNC_ROWS:,}). Export/archive older data.')
    indexes = range(len(fields))
    kind = next(key for key, (name, _) in KIND.items() if name == tab)
    out={}
    repaired_ids=False
    for n,row in enumerate(values[1:],start=2):
        item={f: str(row[i]).strip() if i<len(row) and row[i] is not None else '' for f,i in zip(fields,indexes)}
        if not any(item.values()):
            continue
        if not item['id']:
            # If someone manually adds a new row in Google Sheets, assign its ID.
            # This ID is written back to Sheets during the same sync.
            date=item.get('date','')
            if not date or not item.get('day'):
                raise ValueError(f'{tab} row {n} needs a date and weekday before syncing.')
            if tab=='Workout Logs' and item.get('exercise_id') and item.get('set_number'):
                item['id']=f"{date}__{item['exercise_id']}__{item['set_number']}"
            elif tab=='Cardio' and item.get('type'):
                item['id']=f"{date}__{re.sub(r'[^a-z0-9]+', '_', item['type'].lower())}"
            elif tab=='Check-ins':
                item['id']=f'checkin__{date}'
            elif tab=='Daily Notes' and item.get('note'):
                unique=json.dumps([tab,n,row],ensure_ascii=False)
                item['id']='sheetnote__'+hashlib.sha256(unique.encode('utf-8')).hexdigest()[:22]
            else:
                raise ValueError(f'{tab} row {n} needs enough detail to create an ID. Fill the required fields.')
            repaired_ids=True
        if item['id'] in out:
            raise ValueError(f'Duplicate ID in {tab} row {n}. Resolve duplicates in Sheets before syncing.')
        try:
            item = sanitize(kind, item, preserve_timestamp=True)
        except ValueError as exc:
            raise ValueError(f'{tab} row {n}: {exc}') from exc
        out[item['id']]=item
    return out,repaired_ids


def column_letter(n):
    chars=''
    while n:
        n,rem=divmod(n-1,26)
        chars=chr(65+rem)+chars
    return chars


def google_service():
    if not SPREADSHEET_ID:
        raise ValueError('Add your spreadsheet_id to config.json before connecting Google Sheets.')
    token=DATA/'token.json'
    if not token.exists():
        raise ValueError('Google is not connected. Add OAuth credentials and run: python connect_google.py')
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
    except ImportError:
        raise ValueError('Install Google sync requirements: pip install -r requirements.txt')
    creds=Credentials.from_authorized_user_file(str(token),['https://www.googleapis.com/auth/spreadsheets'])
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token.write_text(creds.to_json(),encoding='utf-8')
    if not creds.valid:
        raise ValueError('Your Google authorization expired. Run python connect_google.py to reconnect.')
    return build('sheets','v4',credentials=creds,cache_discovery=False)


def sync():
    with LOCK:
        service=google_service()
        # Fetch all tabs before any changes, so a missing/renamed tab fails safely.
        remote={}
        repaired_tabs={}
        for kind,(tab,fields) in KIND.items():
            column=column_letter(len(fields))
            # Include all rows so records beyond the supported limit cannot be silently omitted.
            response=service.spreadsheets().values().get(spreadsheetId=SPREADSHEET_ID,range=f"'{tab}'!A1:{column}",valueRenderOption='FORMATTED_VALUE').execute()
            remote[kind],repaired_tabs[kind]=values_to_records(response.get('values',[]),fields,tab)
        with db() as conn:
            locals_by_kind={kind:{} for kind in KIND}
            deleted_by_kind={kind:{} for kind in KIND}
            for r in conn.execute('SELECT kind,id,payload,baseline FROM records'):
                locals_by_kind[r['kind']][r['id']]=(json.loads(r['payload']),json.loads(r['baseline']) if r['baseline'] else None)
            for r in conn.execute('SELECT kind,id,baseline FROM deletions'):
                deleted_by_kind[r['kind']][r['id']]=json.loads(r['baseline']) if r['baseline'] else None

        resolved={}
        conflicts=[]
        pulled=pushed=deleted=0
        for kind in KIND:
            result={}
            for rid in sorted(set(remote[kind]) | set(locals_by_kind[kind]) | set(deleted_by_kind[kind])):
                r=remote[kind].get(rid)
                local=locals_by_kind[kind].get(rid)
                tomb=deleted_by_kind[kind].get(rid,'NOT_DELETED')
                if tomb != 'NOT_DELETED':
                    if r is not None:
                        deleted+=1
                    continue  # local deletion wins, including unsynced remote edits
                if local is None:
                    if r is not None:
                        result[rid]=r; pulled+=1
                    continue
                p,b=local
                if r is None:
                    if b is None or sig(p)!=sig(b):
                        result[rid]=p; pushed+=1
                    else:
                        deleted+=1  # remote deletion; local record unchanged since sync
                    continue
                if b is None:
                    if sig(p)!=sig(r):
                        conflicts.append({'kind':kind,'id':rid,'local':p,'google':r,'reason':'both newly added'})
                        result[rid]=p; pushed+=1
                    else:
                        result[rid]=p
                    continue
                lc=sig(p)!=sig(b); rc=sig(r)!=sig(b)
                if rc and not lc:
                    result[rid]=r; pulled+=1
                elif lc and not rc:
                    result[rid]=p; pushed+=1
                elif lc and rc and sig(p)!=sig(r):
                    conflicts.append({'kind':kind,'id':rid,'local':p,'google':r,'reason':'both edited'})
                    result[rid]=p; pushed+=1
                else:
                    result[rid]=p if lc else r
            resolved[kind]=result

        # Check every resolved tab before changing any remote data.
        for kind, items in resolved.items():
            if len(items) > MAX_SYNC_ROWS:
                raise ValueError(f'Too many entries in {KIND[kind][0]} (maximum {MAX_SYNC_ROWS:,}). Export/archive older data.')

        # Persist any manual remote edits before overwriting conflicting rows.
        if conflicts:
            history=DATA/'sync_conflicts.json'
            existing=json.loads(history.read_text(encoding='utf-8')) if history.exists() else []
            existing.extend([{'detected_at':utc(),**c} for c in conflicts])
            history.write_text(json.dumps(existing,indent=2,ensure_ascii=False),encoding='utf-8')

        # Only rewrite tables whose row content changed. The PLAN and START HERE tabs are untouched.
        for kind,(tab,fields) in KIND.items():
            sorted_rows=sorted(resolved[kind].values(),key=lambda x:(x.get('date',''),x.get('id','')))
            sorted_remote=sorted(remote[kind].values(),key=lambda x:(x.get('date',''),x.get('id','')))
            wanted=[[str(x.get(f,'')) for f in fields] for x in sorted_rows]
            have=[[str(x.get(f,'')) for f in fields] for x in sorted_remote]
            if wanted == have and not repaired_tabs[kind]: continue
            end=column_letter(len(fields))
            service.spreadsheets().values().clear(spreadsheetId=SPREADSHEET_ID,range=f"'{tab}'!A2:{end}5000",body={}).execute()
            if wanted:
                service.spreadsheets().values().update(spreadsheetId=SPREADSHEET_ID,range=f"'{tab}'!A2:{end}{len(wanted)+1}",valueInputOption='RAW',body={'values':wanted}).execute()

        # Only mark records clean after every Google write succeeds.
        now=utc()
        with db() as conn:
            for kind,items in resolved.items():
                conn.execute('DELETE FROM records WHERE kind=?',(kind,))
                conn.executemany('INSERT INTO records(kind,id,payload,baseline) VALUES (?,?,?,?)',[(kind,id,json.dumps(p,ensure_ascii=False),json.dumps(p,ensure_ascii=False)) for id,p in items.items()])
                conn.execute('DELETE FROM deletions WHERE kind=?',(kind,))
            conn.execute("INSERT INTO settings(key,value) VALUES ('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(now,))
        return {'ok':True,'last_sync':now,'pulled':pulled,'pushed':pushed,'deleted':deleted,'conflicts':len(conflicts)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logging.info('%s %s',self.address_string(),format%args)

    def json(self,obj,status=200):
        data=json.dumps(obj,ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers();self.wfile.write(data)

    def body(self):
        length=int(self.headers.get('Content-Length','0'))
        if length > 1_000_000 or length<=0: raise ValueError('Invalid request body size.')
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def do_GET(self):
        path=urllib.parse.urlsplit(self.path).path
        try:
            if path=='/api/state':return self.json(state())
            if path=='/api/export':
                data=json.dumps({'version':1,'exported_at':utc(),'records':state()['records']},ensure_ascii=False,indent=2).encode('utf-8')
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Disposition','attachment; filename="hybrid-workout-backup.json"');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
            files={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js',
                   '/runtime-config.js':'runtime-config.js','/storage.js':'storage.js'}
            if path not in files:return self.json({'error':'Not found'},404)
            fp=ROOT/'public'/files[path]
            payload=fp.read_bytes()
            mime='text/html; charset=utf-8' if path in ('/','/index.html') else ('text/css; charset=utf-8' if path.endswith('.css') else 'application/javascript; charset=utf-8')
            self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-cache');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        except Exception as exc:
            logging.exception('GET failed');self.json({'error':str(exc)},500)

    def do_POST(self):
        path=urllib.parse.urlsplit(self.path).path
        try:
            if path=='/api/sync':return self.json(sync())
            if path=='/api/import':
                return self.json(import_backup(self.body()))
            if path.startswith('/api/records/'):
                kind=path.split('/')[-1]
                return self.json({'ok':True,'record':save(kind,self.body())})
            self.json({'error':'Unknown endpoint'},404)
        except ValueError as exc:self.json({'error':str(exc)},400)
        except Exception as exc:
            logging.exception('POST failed');self.json({'error':str(exc)},500)

    def do_DELETE(self):
        bits=urllib.parse.urlsplit(self.path).path.split('/')
        try:
            if len(bits)==5 and bits[1]=='api' and bits[2]=='records':
                return self.json(remove(bits[3],urllib.parse.unquote(bits[4])))
            return self.json({'error':'Not found'},404)
        except ValueError as exc:self.json({'error':str(exc)},400)


def main():
    parser=argparse.ArgumentParser(description='Run THE HYBRID on your own computer.')
    parser.add_argument('--port',type=int,default=8787)
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args()
    initialize()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    url=f'http://127.0.0.1:{args.port}'
    print(f'\nTHE HYBRID is running locally: {url}')
    print('Your data remains on this computer; use Google Sync when connected.')
    print('Press Ctrl+C to stop.\n')
    if not args.no_browser:threading.Timer(0.8,lambda:webbrowser.open(url)).start()
    try:server.serve_forever()
    except KeyboardInterrupt:print('\nStopped.')
    finally:server.server_close()


if __name__=='__main__':main()
