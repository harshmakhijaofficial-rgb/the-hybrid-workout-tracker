import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const plan = JSON.parse(await readFile(new URL('../htdocs/plan.json', import.meta.url), 'utf8'));
const workbookId = '17VglmaSdddJHB_tSFtQir2CiUSEiWJ9yfkavgTJRNOk';
const fields = {
  sets: ['id', 'date', 'day', 'exercise_id', 'exercise', 'set_number', 'weight_kg', 'reps', 'rir', 'completed', 'note', 'updated_at'],
  cardio: ['id', 'date', 'day', 'type', 'minutes', 'level', 'effort', 'note', 'updated_at'],
  notes: ['id', 'date', 'day', 'category', 'note', 'updated_at'],
  checkins: ['id', 'date', 'day', 'bodyweight_kg', 'sleep_hours', 'energy', 'duration_min', 'note', 'updated_at']
};
const tabs = { sets: 'Workout Logs', cardio: 'Cardio', notes: 'Daily Notes', checkins: 'Check-ins' };
const copy = value => JSON.parse(JSON.stringify(value));
const exercise = plan.days[0].exercises[0];
const setRecord = patch => ({ id: `2026-10-20__${exercise.id}__1`, date: '2026-10-20', day: 'Tuesday', exercise_id: exercise.id, exercise: exercise.name, set_number: '1', weight_kg: '80.5', reps: '10', rir: '2', completed: 'TRUE', note: 'Controlled', ...patch });
const noteRecord = patch => ({ id: 'note__first', date: '2026-10-20', day: 'Tuesday', category: 'Training', note: 'Felt stronger', ...patch });
const cardioRecord = patch => ({ id: '2026-10-20__stairmaster', date: '2026-10-20', day: 'Tuesday', type: 'StairMaster', minutes: '15', level: '5', effort: '6', note: '', ...patch });
const checkinRecord = patch => ({ id: 'checkin__2026-10-20', date: '2026-10-20', day: 'Tuesday', bodyweight_kg: '70.2', sleep_hours: '7.5', energy: '4', duration_min: '65', note: 'Recovered', ...patch });

function createServer() {
  const events = [], mutations = [], opened = [], sheets = new Map();
  const state = { held: false, failWait: false, failWrite: false, failFlush: false, releases: 0 };
  class Sheet {
    constructor(name, headers) { this.name = name; this.cells = [headers.slice()]; this.maxRows = 1000; }
    getLastRow() {
      for (let row = this.cells.length - 1; row >= 0; row--) if (this.cells[row]?.some(value => value !== '' && value !== undefined && value !== null)) return row + 1;
      return 0;
    }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(after, count) {
      assert.equal(state.held, true);
      assert.equal(after, this.maxRows);
      mutations.push({ type: 'insert', tab: this.name, after, count });
      this.maxRows += count;
    }
    getRange(row, column, rowCount = 1, columnCount = 1) {
      assert.ok(row > 0 && column > 0 && rowCount > 0 && columnCount > 0);
      const sheet = this;
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => {
            const value = sheet.cells[row + r - 1]?.[column + c - 1] ?? '';
            return value instanceof Date ? new Date(value) : value;
          }));
        },
        setValues(values) {
          assert.equal(state.held, true, 'Every Sheet write must hold the script lock');
          if (state.failWrite) throw Error('Simulated Sheets write failure');
          assert.equal(values.length, rowCount);
          values.forEach(values => assert.equal(values.length, columnCount));
          events.push('write');
          mutations.push({ type: 'write', tab: sheet.name, row, column, values: copy(values) });
          values.forEach((values, r) => values.forEach((value, c) => {
            if (typeof value === 'string' && value.startsWith('=')) throw Error('Unescaped formula reached setValues');
            if (!sheet.cells[row + r - 1]) sheet.cells[row + r - 1] = [];
            // Sheets consumes one leading apostrophe as a literal-text marker.
            sheet.cells[row + r - 1][column + c - 1] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
          }));
          return this;
        },
        clearContent() {
          assert.equal(state.held, true);
          events.push('clear');
          mutations.push({ type: 'clear', tab: sheet.name, row, column, rowCount, columnCount });
          for (let r = 0; r < rowCount; r++) for (let c = 0; c < columnCount; c++) {
            if (!sheet.cells[row + r - 1]) sheet.cells[row + r - 1] = [];
            sheet.cells[row + r - 1][column + c - 1] = '';
          }
          return this;
        }
      };
    }
  }
  for (const kind of Object.keys(fields)) sheets.set(tabs[kind], new Sheet(tabs[kind], fields[kind]));
  sheets.set('PLAN', new Sheet('PLAN', ['Read-only training plan', 'Do not change']));
  const html = { file: null, title: '', meta: [], setTitle(title) { this.title = title; return this; }, addMetaTag(name, value) { this.meta.push([name, value]); return this; } };
  const context = vm.createContext({
    HYBRID_PLAN: copy(plan), Date,
    HtmlService: { createHtmlOutputFromFile(file) { html.file = file; return html; } },
    LockService: { getScriptLock() { return {
      waitLock(timeout) {
        assert.ok(timeout > 0 && timeout <= 30000);
        if (state.failWait) throw Error('Lock timeout');
        assert.equal(state.held, false);
        state.held = true; events.push('lock');
      },
      releaseLock() { assert.equal(state.held, true); state.held = false; state.releases++; events.push('release'); }
    }; } },
    SpreadsheetApp: {
      openById(id) { assert.equal(state.held, true); opened.push(id); return { getSpreadsheetTimeZone: () => 'Europe/London', getSheetByName: name => sheets.get(name) ?? null }; },
      flush() { assert.equal(state.held, true); events.push('flush'); if (state.failFlush) throw Error('Simulated flush failure'); }
    },
    Utilities: { formatDate(date, timezone, format) {
      assert.equal(format, 'yyyy-MM-dd');
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } }
  });
  vm.runInContext(source, context, { filename: 'apps-script/Code.gs' });
  return {
    request: context.hybridRequest, doGet: context.doGet, sheets, state, events, mutations, opened, html,
    add(kind, record, extra) {
      const sheet = sheets.get(tabs[kind]);
      const row = fields[kind].map(field => record[field] ?? '');
      if (extra !== undefined) row.push(extra);
      sheet.cells.push(row);
    },
    records() { return copy(context.hybridRequest({ path: '/api/state' }).records); }
  };
}
const save = (server, kind, record) => server.request({ path: `/api/records/${kind}`, method: 'POST', body: JSON.stringify(record) });

test('serves the bundled dashboard and exposes only the intended RPC entrypoints', () => {
  const server = createServer();
  const html = server.doGet();
  assert.equal(html.file, 'Index');
  assert.match(html.title, /THE HYBRID/);
  assert.deepEqual(html.meta, [['viewport', 'width=device-width,initial-scale=1,viewport-fit=cover']]);
  const publicFunctions = [...source.matchAll(/^function (\w+)\(/gm)].map(match => match[1]).filter(name => !name.endsWith('_')).sort();
  assert.deepEqual(publicFunctions, ['doGet', 'hybridRequest']);
});

test('reads all four tables from the fixed workbook with no hidden mutations', () => {
  const server = createServer();
  server.add('sets', setRecord());
  server.add('cardio', cardioRecord());
  server.add('notes', noteRecord());
  server.add('checkins', checkinRecord());
  const result = server.request({ path: '/api/state' });
  assert.equal(result.storage_mode, 'sheets');
  assert.equal(result.connected, true);
  assert.equal(result.offline, false);
  assert.equal(result.sheet_url, `https://docs.google.com/spreadsheets/d/${workbookId}/edit`);
  for (const kind of Object.keys(fields)) assert.equal(result.records[kind].length, 1);
  assert.deepEqual(server.opened, [workbookId]);
  assert.equal(server.mutations.length, 0);
  assert.equal(server.state.held, false);
  result.plan.days.length = 0;
  assert.equal(server.request({ path: '/api/state' }).plan.days.length, plan.days.length);
  assert.throws(() => server.request({ path: '/api/state', spreadsheetId: 'another-workbook' }), /unexpected/i);
});

test('serializes manually entered Sheet dates, booleans and numbers into RPC-safe strings', () => {
  const server = createServer();
  server.add('sets', setRecord({ date: new Date('2026-10-20T23:00:00Z'), day: 'Wednesday', weight_kg: 80.5, reps: 10, completed: true, updated_at: new Date('2026-10-21T09:30:00Z') }));
  const record = server.records().sets[0];
  assert.equal(record.date, '2026-10-21', 'Date cells use the spreadsheet timezone, not the server timezone');
  assert.equal(record.updated_at, '2026-10-21T09:30:00.000Z');
  assert.equal(record.completed, 'TRUE');
  assert.equal(record.weight_kg, '80.5');
  assert.ok(Object.values(record).every(value => typeof value === 'string'));
});

test('saves each record kind and updates its ID in place while preserving unrelated cells', () => {
  const server = createServer();
  const untouchedPlan = copy(server.sheets.get('PLAN').cells);
  server.add('sets', setRecord({ id: 'keep__second', weight_kg: '30' }), 'Keep extra column');
  server.add('sets', setRecord(), 'Extra column on the updated row');
  const unchangedRow = copy(server.sheets.get(tabs.sets).cells[1]);
  for (const [kind, create] of [['sets', setRecord], ['cardio', cardioRecord], ['notes', noteRecord], ['checkins', checkinRecord]]) {
    const first = save(server, kind, create());
    assert.equal(first.ok, true);
    assert.ok(Number.isFinite(Date.parse(first.record.updated_at)));
    save(server, kind, create({ note: 'Updated by ID' }));
    const rows = server.records()[kind];
    assert.equal(rows.filter(row => row.id === first.record.id).length, 1);
    assert.equal(rows.find(row => row.id === first.record.id).note, 'Updated by ID');
  }
  assert.deepEqual(server.sheets.get(tabs.sets).cells[1], unchangedRow);
  assert.equal(server.sheets.get(tabs.sets).cells[2][fields.sets.length], 'Extra column on the updated row');
  assert.deepEqual(server.sheets.get('PLAN').cells, untouchedPlan);
  assert.ok(server.mutations.every(mutation => mutation.type === 'write' && mutation.column === 1 && mutation.values.length === 1));
  for (let index = 0; index < server.events.length; index++) if (server.events[index] === 'write') {
    assert.equal(server.events[index + 1], 'flush');
    assert.equal(server.events[index + 2], 'release');
  }
});

test('deleting a note clears only its schema cells and a later save reuses the empty slot', () => {
  const server = createServer();
  server.add('notes', noteRecord(), 'Retain this unrelated column');
  server.add('notes', noteRecord({ id: 'note__second', note: 'Keep second note' }), 'Second extra column');
  const other = copy(server.sheets.get(tabs.notes).cells[2]);
  assert.equal(server.request({ path: '/api/records/notes/note__first', method: 'DELETE' }).deleted, true);
  assert.deepEqual(server.records().notes.map(note => note.id), ['note__second']);
  assert.equal(server.sheets.get(tabs.notes).cells[1][fields.notes.length], 'Retain this unrelated column');
  assert.deepEqual(server.sheets.get(tabs.notes).cells[2], other);
  save(server, 'notes', noteRecord({ id: 'note__replacement' }));
  assert.equal(server.sheets.get(tabs.notes).cells[1][0], 'note__replacement');
  assert.equal(server.sheets.get(tabs.notes).cells[1][fields.notes.length], 'Retain this unrelated column');
  const mutationCount = server.mutations.length;
  server.request({ path: '/api/records/notes/missing', method: 'DELETE' });
  assert.equal(server.mutations.length, mutationCount);
  assert.throws(() => server.request({ path: '/api/records/sets/keep', method: 'DELETE' }), /not supported/i);
});

test('validates records before writes and permits genuine weekend journal entries', () => {
  const server = createServer();
  const invalid = [
    ['sets', setRecord({ id: '../unsafe' })], ['sets', setRecord({ date: '2026-02-30' })],
    ['sets', setRecord({ date: '0000-01-01' })], ['sets', setRecord({ day: 'Saturday' })],
    ['sets', setRecord({ set_number: '31' })], ['sets', setRecord({ reps: '1.5' })],
    ['sets', setRecord({ reps: '0' })], ['sets', setRecord({ reps: '' })],
    ['sets', setRecord({ weight_kg: '-1' })], ['sets', setRecord({ weight_kg: 'Infinity' })],
    ['sets', setRecord({ rir: '11' })], ['sets', setRecord({ completed: 'sometimes' })],
    ['sets', setRecord({ exercise_id: '' })], ['sets', setRecord({ extra: 'invalid' })],
    ['cardio', cardioRecord({ type: '' })], ['cardio', cardioRecord({ minutes: '-1' })],
    ['cardio', cardioRecord({ effort: '11' })], ['checkins', checkinRecord({ sleep_hours: '25' })],
    ['checkins', checkinRecord({ energy: '1.5' })], ['checkins', checkinRecord({ bodyweight_kg: '-1' })],
    ['notes', noteRecord({ note: '   ' })], ['notes', noteRecord({ note: 'x'.repeat(5001) })],
    ['notes', noteRecord({ note: { nested: 'invalid' } })]
  ];
  for (const [kind, record] of invalid) assert.throws(() => save(server, kind, record), undefined, `${kind}: ${JSON.stringify(record)}`);
  assert.equal(server.mutations.length, 0);
  save(server, 'notes', noteRecord({ date: '2026-10-24', day: 'Saturday' }));
  save(server, 'checkins', checkinRecord({ id: 'checkin__2026-10-25', date: '2026-10-25', day: 'Sunday', duration_min: '0' }));
  assert.equal(server.records().notes[0].day, 'Saturday');
  assert.equal(server.records().checkins[0].day, 'Sunday');
});

test('formula-shaped notes are literal strings and preserve their exact displayed text', () => {
  const server = createServer();
  for (const note of ['=HYPERLINK("https://example.com","label")', '+SUM(A1:A2)', '-1+2', '@mention', ' \t=IMPORTXML("url","path")', "'A quoted thought"]) {
    const result = save(server, 'notes', noteRecord({ note }));
    assert.equal(result.record.note, note);
    const write = server.mutations.at(-1);
    assert.equal(write.values[0][fields.notes.indexOf('note')], "'" + note);
    assert.equal(server.records().notes[0].note, note);
  }
});

test('malformed headers in any tab, missing tabs and incomplete manual rows fail before mutation', () => {
  const changedHeaders = createServer();
  changedHeaders.sheets.get(tabs.checkins).cells[0][1] = 'renamed date';
  assert.throws(() => save(changedHeaders, 'sets', setRecord()), /Check-ins.*header/i);
  assert.equal(changedHeaders.mutations.length, 0);
  assert.equal(changedHeaders.state.held, false);

  const missingTab = createServer();
  missingTab.sheets.delete(tabs.cardio);
  assert.throws(() => save(missingTab, 'notes', noteRecord()), /missing.*Cardio/i);
  assert.equal(missingTab.mutations.length, 0);

  const manual = createServer();
  manual.add('notes', noteRecord({ id: '' }));
  assert.throws(() => save(manual, 'sets', setRecord()), /Daily Notes row 2 needs a record ID/i);
  assert.equal(manual.mutations.length, 0);
  manual.sheets.get(tabs.notes).cells[1][0] = 'duplicate';
  manual.add('notes', noteRecord({ id: 'duplicate' }));
  assert.throws(() => manual.records(), /duplicate ID/i);
});

test('a full tab rejects inserts before mutation while existing IDs can still be updated', () => {
  const server = createServer();
  const notes = server.sheets.get(tabs.notes);
  notes.maxRows = 5000;
  for (let index = 0; index < 4999; index++) server.add('notes', noteRecord({ id: `note__${index}` }));
  assert.throws(() => save(server, 'notes', noteRecord({ id: 'one__too_many' })), /full|4,999/i);
  assert.equal(server.mutations.length, 0);
  save(server, 'notes', noteRecord({ id: 'note__0', note: 'Edited at capacity' }));
  assert.equal(notes.cells[1][fields.notes.indexOf('note')], 'Edited at capacity');
  assert.equal(server.mutations.length, 1);
  assert.equal(server.mutations[0].row, 2);
});

test('write, flush and validation failures always release an acquired lock; lock timeout does not touch Sheets', () => {
  const writeFailure = createServer();
  writeFailure.state.failWrite = true;
  assert.throws(() => save(writeFailure, 'notes', noteRecord()), /write failure/i);
  assert.equal(writeFailure.state.held, false);
  assert.equal(writeFailure.state.releases, 1);
  writeFailure.state.failWrite = false;
  save(writeFailure, 'notes', noteRecord());
  assert.equal(writeFailure.state.releases, 2);

  const flushFailure = createServer();
  flushFailure.state.failFlush = true;
  assert.throws(() => save(flushFailure, 'notes', noteRecord()), /flush failure/i);
  assert.equal(flushFailure.state.held, false);
  assert.equal(flushFailure.state.releases, 1);

  const timeout = createServer();
  timeout.state.failWait = true;
  assert.throws(() => save(timeout, 'notes', noteRecord()), /save is in progress/i);
  assert.equal(timeout.opened.length, 0);
  assert.equal(timeout.mutations.length, 0);
  assert.equal(timeout.state.releases, 0);
});

test('refresh and export read current Sheet data without rewriting it and reject unsupported imports', () => {
  const server = createServer();
  server.add('notes', noteRecord());
  const refreshed = server.request({ path: '/api/sync', method: 'POST' });
  assert.deepEqual(copy(refreshed), { ok: true, last_sync: refreshed.last_sync, pulled: 0, pushed: 0, deleted: 0, conflicts: 0 });
  const backup = server.request({ path: '/api/export' });
  assert.equal(backup.version, 1);
  assert.equal(backup.records.notes[0].note, noteRecord().note);
  assert.ok(Number.isFinite(Date.parse(backup.exported_at)));
  assert.equal(server.mutations.length, 0);
  assert.throws(() => server.request({ path: '/api/import', method: 'POST', body: '{}' }), /not supported/i);
  assert.throws(() => server.request({ path: '/api/records/notes', method: 'POST', body: '{invalid' }), /JSON/i);
});
