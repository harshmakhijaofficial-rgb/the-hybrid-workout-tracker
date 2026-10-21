import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../htdocs/storage.js', import.meta.url), 'utf8');
const plan = JSON.parse(await readFile(new URL('../htdocs/plan.json', import.meta.url), 'utf8'));
const key = 'the-hybrid-workouts-v1';
const copy = value => JSON.parse(JSON.stringify(value));
const emptyRecords = () => ({ sets: [], cardio: [], notes: [], checkins: [] });
const trainingDay = plan.days.find(day => day.day === 'Tuesday');
const exercise = trainingDay.exercises[0];

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    failRead: false,
    failWrite: false,
    writes: 0,
    getItem(name) {
      if (this.failRead) throw Error('Storage disabled');
      return values.get(name) ?? null;
    },
    setItem(name, value) {
      if (this.failWrite) throw Error('Quota exceeded');
      values.set(name, String(value));
      this.writes++;
    },
    removeItem(name) { values.delete(name); }
  };
}

function loadBrowser(storage = fakeStorage(), fetchPlan) {
  const fetched = [];
  const window = { localStorage: storage, HYBRID_STORAGE_MODE: 'browser' };
  const fetch = async path => {
    fetched.push(path);
    return fetchPlan ? fetchPlan(path) : { ok: true, json: async () => copy(plan) };
  };
  vm.runInNewContext(source, { window, fetch }, { filename: 'htdocs/storage.js' });
  return { request: window.HybridBrowserStorage.request, storage, fetched };
}

const setRecord = overrides => ({
  id: `2026-10-20__${exercise.id}__1`, date: '2026-10-20', day: 'Tuesday',
  exercise_id: exercise.id, exercise: exercise.name, set_number: '1',
  weight_kg: '80.5', reps: '10', rir: '2', completed: 'TRUE', note: 'Controlled reps',
  ...overrides
});
const cardioRecord = overrides => ({
  id: '2026-10-20__stairmaster', date: '2026-10-20', day: 'Tuesday',
  type: 'StairMaster', minutes: '15', level: '5', effort: '6', note: 'Steady pace',
  ...overrides
});
const checkinRecord = overrides => ({
  id: 'checkin__2026-10-20', date: '2026-10-20', day: 'Tuesday',
  bodyweight_kg: '70.2', sleep_hours: '7.5', energy: '4', duration_min: '65', note: 'Recovered',
  ...overrides
});
const noteRecord = overrides => ({
  id: 'note__first', date: '2026-10-20', day: 'Tuesday', category: 'Training',
  note: 'More controlled than last week.', ...overrides
});
const save = (browser, kind, record) => browser.request(`/api/records/${kind}`, {
  method: 'POST', body: JSON.stringify(record)
});
const restore = (browser, backup) => browser.request('/api/import', {
  method: 'POST', body: JSON.stringify(backup)
});
const recordsOf = async browser => copy((await browser.request('/api/state')).records);

test('loads the bundled plan relative to its deployment and persists real records across page reloads', async () => {
  const storage = fakeStorage();
  const browser = loadBrowser(storage);
  const initial = await browser.request('/api/state');
  assert.equal(initial.plan.name, plan.name);
  assert.equal(initial.storage_mode, 'browser');
  assert.equal(initial.connected, false);
  assert.deepEqual(copy(initial.records), emptyRecords());
  const { record } = await save(browser, 'sets', setRecord());
  assert.equal(record.completed, 'TRUE');
  assert.equal(record.weight_kg, '80.5');
  assert.ok(Number.isFinite(Date.parse(record.updated_at)));
  assert.deepEqual(browser.fetched, ['./plan.json']);

  const reloaded = loadBrowser(storage);
  assert.deepEqual((await recordsOf(reloaded)).sets, [copy(record)]);
  assert.equal(JSON.parse(storage.getItem(key)).version, 1);

  initial.plan.days.length = 0;
  assert.equal((await browser.request('/api/state')).plan.days.length, plan.days.length);
  const state = await reloaded.request('/api/state');
  state.records.sets[0].reps = '999';
  assert.equal((await recordsOf(reloaded)).sets[0].reps, '10');
  assert.equal((await reloaded.request('/api/state')).plan.days.length, plan.days.length);
});

test('upserts matching IDs, deletes only the requested record and persists deletion', async () => {
  const browser = loadBrowser();
  await save(browser, 'notes', noteRecord());
  await save(browser, 'notes', noteRecord({ note: 'Updated observation.' }));
  await save(browser, 'notes', noteRecord({ id: 'note__second', note: 'Keep this note.' }));
  let notes = (await recordsOf(browser)).notes;
  assert.equal(notes.length, 2);
  assert.equal(notes.find(note => note.id === 'note__first').note, 'Updated observation.');
  const result = await browser.request('/api/records/notes/note__first', { method: 'DELETE' });
  assert.equal(result.deleted, true);
  notes = (await recordsOf(loadBrowser(browser.storage))).notes;
  assert.deepEqual(notes.map(note => note.id), ['note__second']);
  await browser.request('/api/records/notes/missing', { method: 'DELETE' });
  assert.equal((await recordsOf(browser)).notes.length, 1);
});

test('rejects invalid set values without changing persisted history', async () => {
  const browser = loadBrowser();
  await save(browser, 'sets', setRecord());
  const before = browser.storage.getItem(key);
  const invalid = [
    { date: '2026-02-30' }, { date: '20/10/2026' }, { date: '0000-01-01' }, { id: '../secret' },
    { day: 'Funday' }, { exercise_id: '' }, { exercise: '   ' },
    { set_number: '0' }, { set_number: '31' }, { set_number: '1.5' },
    { weight_kg: '-1' }, { weight_kg: 'NaN' }, { weight_kg: 'Infinity' },
    { reps: '1.5' }, { reps: '0', completed: 'TRUE' }, { reps: '', completed: 'TRUE' },
    { rir: '11' }, { completed: 'maybe' }, { note: 'x'.repeat(5001) },
    { note: { value: 'Invalid nested value' } }, { unexpected_field: 'value' }
  ];
  for (const patch of invalid) {
    await assert.rejects(save(browser, 'sets', setRecord(patch)), undefined, JSON.stringify(patch));
    assert.equal(browser.storage.getItem(key), before, `Rejected value changed history: ${JSON.stringify(patch)}`);
  }
  const { record } = await save(browser, 'sets', setRecord({ completed: false, reps: '', weight_kg: '0', rir: '0' }));
  assert.equal(record.completed, 'FALSE');
  assert.equal(record.weight_kg, '0');
});

test('validates cardio, check-ins and notes and accepts their valid boundaries', async () => {
  const browser = loadBrowser();
  await save(browser, 'cardio', cardioRecord());
  await save(browser, 'checkins', checkinRecord());
  await save(browser, 'notes', noteRecord());
  const before = browser.storage.getItem(key);
  const invalid = [
    ['cardio', cardioRecord, { type: '' }],
    ['cardio', cardioRecord, { minutes: '-1' }],
    ['cardio', cardioRecord, { minutes: 'Infinity' }],
    ['cardio', cardioRecord, { effort: '11' }],
    ['checkins', checkinRecord, { bodyweight_kg: '-1' }],
    ['checkins', checkinRecord, { sleep_hours: '25' }],
    ['checkins', checkinRecord, { energy: '0' }],
    ['checkins', checkinRecord, { energy: '1.5' }],
    ['checkins', checkinRecord, { duration_min: '-1' }],
    ['notes', noteRecord, { note: '   ' }]
  ];
  for (const [kind, create, patch] of invalid) {
    await assert.rejects(save(browser, kind, create(patch)), undefined, `${kind}: ${JSON.stringify(patch)}`);
    assert.equal(browser.storage.getItem(key), before);
  }
  await save(browser, 'checkins', checkinRecord({ sleep_hours: '24', energy: '5', bodyweight_kg: '0', duration_min: '0' }));
  await save(browser, 'cardio', cardioRecord({ minutes: '0', level: '0', effort: '1' }));
  await save(browser, 'notes', noteRecord({ category: '' }));
  assert.equal((await recordsOf(browser)).checkins[0].sleep_hours, '24');
});

test('historical exercises remain restorable after the plan changes', async () => {
  const browser = loadBrowser();
  const historical = setRecord({ id: '2026-10-20__retired_exercise__1', exercise_id: 'retired_exercise', exercise: 'Historical machine variant' });
  await restore(browser, { version: 1, records: { ...emptyRecords(), sets: [historical] } });
  const saved = (await recordsOf(loadBrowser(browser.storage))).sets[0];
  assert.equal(saved.exercise_id, historical.exercise_id);
  assert.equal(saved.exercise, historical.exercise);
});

test('weekend recovery notes and check-ins keep their actual calendar weekday', async () => {
  const browser = loadBrowser();
  await save(browser, 'notes', noteRecord({ id: 'note__saturday', date: '2026-10-24', day: 'Saturday', category: 'Recovery' }));
  await save(browser, 'checkins', checkinRecord({ id: 'checkin__2026-10-25', date: '2026-10-25', day: 'Sunday', duration_min: '0' }));
  const reloaded = await recordsOf(loadBrowser(browser.storage));
  assert.equal(reloaded.notes[0].day, 'Saturday');
  assert.equal(reloaded.checkins[0].day, 'Sunday');
});

test('exports and restores every record kind without losing saved timestamps', async () => {
  const original = loadBrowser();
  await save(original, 'sets', setRecord());
  await save(original, 'cardio', cardioRecord());
  await save(original, 'checkins', checkinRecord());
  await save(original, 'notes', noteRecord());
  const exported = copy(await original.request('/api/export'));
  assert.equal(exported.version, 1);
  assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
  const restored = loadBrowser();
  const result = await restore(restored, exported);
  assert.equal(result.ok, true);
  assert.deepEqual(copy(result.imported), { sets: 1, cardio: 1, notes: 1, checkins: 1 });
  assert.deepEqual(await recordsOf(loadBrowser(restored.storage)), exported.records);

  exported.records.notes[0].note = 'Imported correction';
  await save(restored, 'notes', noteRecord({ id: 'note__keep', note: 'Keep existing local record' }));
  await restore(restored, exported);
  const notes = (await recordsOf(restored)).notes;
  assert.equal(notes.length, 2);
  assert.equal(notes.find(note => note.id === 'note__first').note, 'Imported correction');
  assert.equal(notes.find(note => note.id === 'note__keep').note, 'Keep existing local record');
});

test('invalid backup import is atomic, including a later bad row and malformed structures', async () => {
  const browser = loadBrowser();
  await save(browser, 'notes', noteRecord());
  const before = browser.storage.getItem(key);
  const writesBefore = browser.storage.writes;
  const invalidBackups = [
    { version: 2, records: emptyRecords() },
    { version: 1, records: { sets: [] } },
    { version: 1, records: { ...emptyRecords(), cardio: {} } },
    { version: 1, records: { ...emptyRecords(), unknown: [] } },
    { version: 1, records: { ...emptyRecords(), sets: [setRecord()], notes: [noteRecord({ id: 'note__valid_new' }), noteRecord({ id: 'note__invalid', date: 'invalid' })] } },
    { version: 1, records: { ...emptyRecords(), notes: [noteRecord(), noteRecord()] } },
    { version: 1, records: { ...emptyRecords(), notes: [noteRecord({ updated_at: 'bad timestamp' })] } },
    { version: 1, records: { ...emptyRecords(), notes: [null] } }
  ];
  for (const backup of invalidBackups) {
    await assert.rejects(restore(browser, backup));
    assert.equal(browser.storage.getItem(key), before);
    assert.equal(browser.storage.writes, writesBefore, 'Rejected import must never commit a partial result');
  }
  await assert.rejects(browser.request('/api/import', { method: 'POST', body: '{bad json' }), /JSON/i);
});

test('storage read failures and corrupt saved data preserve existing bytes and report a useful error', async () => {
  const blocked = fakeStorage();
  blocked.failRead = true;
  await assert.rejects(loadBrowser(blocked).request('/api/state'), /storage.*unavailable|storage.*blocked/i);
  assert.equal(blocked.writes, 0);

  for (const bytes of ['{broken json', JSON.stringify({ version: 99, records: emptyRecords() }), JSON.stringify({ version: 1, records: { ...emptyRecords(), notes: [noteRecord({ date: 'bad' })] } })]) {
    const storage = fakeStorage({ [key]: bytes });
    await assert.rejects(loadBrowser(storage).request('/api/state'), /saved.*data|stored.*data/i);
    assert.equal(storage.getItem(key), bytes);
    assert.equal(storage.writes, 0);
  }
});

test('quota failures reject initial readiness and each mutation without losing earlier records', async () => {
  const unavailable = fakeStorage();
  unavailable.failWrite = true;
  await assert.rejects(loadBrowser(unavailable).request('/api/state'), /save.*browser|storage.*full/i);

  const browser = loadBrowser();
  await save(browser, 'notes', noteRecord());
  const before = browser.storage.getItem(key);
  browser.storage.failWrite = true;
  await assert.rejects(save(browser, 'notes', noteRecord({ note: 'Unsaved edit' })), /save.*browser|storage.*full/i);
  await assert.rejects(browser.request('/api/records/notes/note__first', { method: 'DELETE' }), /save.*browser|storage.*full/i);
  await assert.rejects(restore(browser, { version: 1, records: { ...emptyRecords(), sets: [setRecord()] } }), /save.*browser|storage.*full/i);
  assert.equal(browser.storage.getItem(key), before);
  browser.storage.failWrite = false;
  assert.equal((await recordsOf(browser)).notes[0].note, noteRecord().note);
  await save(browser, 'notes', noteRecord({ note: 'Saved after freeing space' }));
  assert.equal((await recordsOf(loadBrowser(browser.storage))).notes[0].note, 'Saved after freeing space');
});

test('plan fetch failures can be retried and hosted mode rejects unsupported server actions', async () => {
  let attempts = 0;
  const browser = loadBrowser(fakeStorage(), async () => {
    attempts++;
    return attempts === 1 ? { ok: false } : { ok: true, json: async () => copy(plan) };
  });
  await assert.rejects(browser.request('/api/state'), /plan.*loaded|plan.*load/i);
  assert.equal((await browser.request('/api/state')).plan.name, plan.name);
  assert.equal(attempts, 2);
  await assert.rejects(browser.request('/api/sync', { method: 'POST', body: '{}' }), /local|sync|unsupported/i);
  await assert.rejects(browser.request('/api/records/unknown', { method: 'POST', body: '{}' }));
});
