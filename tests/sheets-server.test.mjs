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
  const filled = value => value !== '' && value !== undefined && value !== null;
  class Sheet {
    constructor(name, headers) { this.name = name; this.cells = [headers.slice()]; this.maxRows = 1000; this.maxColumns = 26; this.charts = []; this.formats = []; }
    getLastRow() {
      for (let row = this.cells.length - 1; row >= 0; row--) if (this.cells[row]?.some(filled)) return row + 1;
      return 0;
    }
    getLastColumn() { return Math.max(0, ...this.cells.map(row => (row || []).reduce((last, value, index) => filled(value) ? index + 1 : last, 0))); }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertColumnAfter(column) { assert.equal(state.held, true); assert.equal(column, this.maxColumns); this.maxColumns++; mutations.push({ type: 'insert-column', tab: this.name }); }
    deleteColumn(column) { assert.equal(state.held, true); this.cells.forEach(row => row?.splice(column - 1, 1)); this.maxColumns--; mutations.push({ type: 'delete-column', tab: this.name }); }
    getCharts() { return this.charts.slice(); }
    insertChart(chart) { assert.equal(state.held, true); this.charts.push(chart); mutations.push({ type: 'chart', tab: this.name }); }
    newChart() {
      const chart = { type: '', ranges: [], options: {}, headers: 0, position: null };
      const builder = {
        asLineChart() { chart.type = 'line'; return builder; },
        addRange(range) { chart.ranges.push(range.a1); return builder; },
        setNumHeaders(count) { chart.headers = count; return builder; },
        setPosition(...args) { chart.position = args; return builder; },
        setOption(key, value) { chart.options[key] = value; return builder; },
        build() { return chart; }
      };
      return builder;
    }
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
        a1: [row, column, rowCount, columnCount],
        setNumberFormat(format) { assert.equal(state.held, true); sheet.formats.push([row, column, rowCount, columnCount, format]); return this; },
        sort(spec) {
          // Like Range.sort: reorders only this block's cells, by one column, blanks last.
          assert.equal(state.held, true);
          events.push('sort');
          mutations.push({ type: 'sort', tab: sheet.name, row, rowCount });
          const block = Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => sheet.cells[row + r - 1]?.[column + c - 1] ?? ''));
          const key = spec.column - column;
          block.sort((a, b) => !filled(a[key]) - !filled(b[key]) || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (spec.ascending === false ? -1 : 1));
          block.forEach((values, r) => values.forEach((value, c) => {
            if (!sheet.cells[row + r - 1]) sheet.cells[row + r - 1] = [];
            sheet.cells[row + r - 1][column + c - 1] = value;
          }));
          return this;
        },
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
      openById(id) {
        assert.equal(state.held, true); opened.push(id);
        return {
          getSpreadsheetTimeZone: () => 'Europe/London', getSheetByName: name => sheets.get(name) ?? null,
          insertSheet(name) { assert.equal(state.held, true); assert.ok(!sheets.has(name)); const sheet = new Sheet(name, []); sheets.set(name, sheet); mutations.push({ type: 'insert-sheet', tab: name }); return sheet; }
        };
      },
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
    request: context.hybridRequest, doGet: context.doGet, sheets, state, events, mutations, opened, html, Sheet,
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

test('a save that lands out of date order sorts its tab; whole rows move and same-day rows keep their order', () => {
  const server = createServer();
  const sheet = server.sheets.get(tabs.sets);
  server.add('sets', setRecord({ id: 'b__20' }), 'extra for b');
  server.add('sets', setRecord({ id: 'a__22', date: '2026-10-22', day: 'Thursday' }), 'extra for a');
  save(server, 'sets', setRecord({ id: 'z__23', date: '2026-10-23', day: 'Friday' }));
  assert.equal(server.mutations.some(mutation => mutation.type === 'sort'), false, 'an in-order save does not sort');
  save(server, 'sets', setRecord({ id: 'c__20' }));
  assert.deepEqual(server.records().sets.map(row => row.id), ['b__20', 'c__20', 'a__22', 'z__23']);
  assert.equal(sheet.cells[1][fields.sets.length], 'extra for b');
  assert.equal(sheet.cells[3][fields.sets.length], 'extra for a');
  assert.equal(sheet.getLastColumn(), fields.sets.length + 1, 'the temporary sort column is cleared');
  assert.equal(server.state.held, false);
});

test('check-in saves refresh an existing Weight Trend tab with the 7-day average', () => {
  const server = createServer();
  save(server, 'checkins', checkinRecord({ bodyweight_kg: '80' }));
  assert.equal(server.sheets.has('Weight Trend'), false, 'saves never create the tab');
  server.request({ path: '/api/organise', method: 'POST' });
  const trend = server.sheets.get('Weight Trend');
  for (const [date, day, kg] of [['2026-10-21', 'Wednesday', '80.4'], ['2026-10-23', 'Friday', '79.8'], ['2026-10-24', 'Saturday', ''], ['2026-10-28', 'Wednesday', '79']]) {
    save(server, 'checkins', checkinRecord({ id: `checkin__${date}`, date, day, bodyweight_kg: kg }));
  }
  // The 24 Oct check-in has no weight, so it is left out; 28 Oct averages 23 Oct (79.8) and 28 Oct (79.0).
  assert.deepEqual(trend.cells.slice(0, 5), [
    ['Date', 'Daily weigh-in (kg)', '7-day average (kg)'],
    ['2026-10-20', 80, 80], ['2026-10-21', 80.4, 80.2], ['2026-10-23', 79.8, 80.07], ['2026-10-28', 79, 79.4]
  ]);
  assert.equal(trend.getLastRow(), 5);
  save(server, 'checkins', checkinRecord({ id: 'checkin__2026-10-28', date: '2026-10-28', day: 'Wednesday', bodyweight_kg: '78.6' }));
  assert.deepEqual(trend.cells[4], ['2026-10-28', 78.6, 79.2]);
  assert.equal(trend.getLastRow(), 5);
});

test('organising orders PLAN and START HERE Monday first, sorts logs and adds one Weight Trend chart', () => {
  const server = createServer();
  const planTab = new server.Sheet('PLAN', ['day', 'focus', 'exercise_id', 'exercise']);
  [['Tuesday', 'Chest + Back A', 'mon_chest_press', 'Machine Chest Press'], ['Tuesday', 'Chest + Back A', 'mon_pulldown', 'Lat Pulldown'],
    ['Wednesday', 'Legs A + Core', 'tue_legpress', 'Leg Press'], ['Friday', 'Chest + Back B', 'thu_row', 'Seated Cable Row'],
    ['Monday', 'Legs B + Core', 'fri_goblet', 'Goblet Squat'], ['Monday', 'Legs B + Core', 'fri_hip', 'Hip Thrust']].forEach(row => planTab.cells.push(row));
  planTab.maxColumns = 4;
  server.sheets.set('PLAN', planTab);
  const start = new server.Sheet('START HERE', ['THE HYBRID — WORKOUT TRACKER', '4 weeks']);
  [['PLAN', 'Monday–Friday programme'], ['TUESDAY', 'Chest + Back A'], ['WEDNESDAY', 'Legs A + Core'], ['THURSDAY', 'Shoulders + Arms'],
    ['FRIDAY', 'Chest + Back B'], ['MONDAY', 'Legs B + Core'], ['WEEK 1', 'Listed sets'], ['START DATE', 'Tuesday 20 October 2026'],
    ['WEEK 1 CYCLE', 'Tue 20, Wed 21, Thu 22, Fri 23, Mon 26 October 2026']].forEach(row => start.cells.push(row));
  server.sheets.set('START HERE', start);
  server.add('cardio', cardioRecord({ id: 'late', date: '2026-10-23', day: 'Friday' }));
  server.add('cardio', cardioRecord({ id: 'early' }));
  assert.throws(() => server.request({ path: '/api/organise' }), /not supported/i);

  assert.deepEqual(copy(server.request({ path: '/api/organise', method: 'POST' })), { ok: true, organised: true });
  assert.deepEqual(planTab.cells.slice(1).map(row => row[2]), ['fri_goblet', 'fri_hip', 'mon_chest_press', 'mon_pulldown', 'tue_legpress', 'thu_row']);
  assert.equal(planTab.maxColumns, 4, 'the temporary column is removed');
  assert.equal(planTab.getLastColumn(), 4);
  assert.deepEqual(start.cells.slice(2, 7), [['MONDAY', 'Legs B + Core'], ['TUESDAY', 'Chest + Back A'], ['WEDNESDAY', 'Legs A + Core'], ['THURSDAY', 'Shoulders + Arms'], ['FRIDAY', 'Chest + Back B']]);
  assert.deepEqual(start.cells[7], ['WEEK 1', 'Listed sets']);
  assert.deepEqual(start.cells[9], ['WEEK 1 DATES', 'Mon 19 Oct (before start), Tue 20 Oct, Wed 21 Oct, Thu 22 Oct, Fri 23 Oct 2026']);
  assert.deepEqual(server.records().cardio.map(row => row.id), ['early', 'late']);
  const trend = server.sheets.get('Weight Trend');
  assert.equal(trend.charts.length, 1);
  assert.equal(trend.charts[0].type, 'line');
  assert.equal(trend.charts[0].headers, 1);
  assert.equal(server.state.held, false);

  const before = server.mutations.length;
  server.request({ path: '/api/organise', method: 'POST' });
  assert.equal(trend.charts.length, 1, 'running again adds no second chart');
  assert.ok(server.mutations.slice(before).every(mutation => mutation.tab === 'Weight Trend'), 'an organised workbook only has its trend refreshed');
});
