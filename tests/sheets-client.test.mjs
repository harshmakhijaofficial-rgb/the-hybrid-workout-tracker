import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../htdocs/app.js', import.meta.url), 'utf8');
const scheduleSource = await readFile(new URL('../htdocs/schedule.js', import.meta.url), 'utf8');
const plan = JSON.parse(await readFile(new URL('../htdocs/plan.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const empty = () => ({sets: [], cardio: [], notes: [], checkins: []});
const state = records => ({plan: copy(plan), records: {...empty(), ...records},
  connected: true, sheet_url: 'https://docs.google.com/spreadsheets/d/private-workbook/edit',
  storage_mode: 'sheets', last_sync: null});
const cardio = extra => ({id: '2026-10-20__stairmaster', date: '2026-10-20', day: 'Tuesday',
  type: 'StairMaster', minutes: '15', level: '6', effort: '5', note: '',
  updated_at: '2026-10-20T12:00:00.000Z', ...extra});

function element() {
  return {innerHTML: '', textContent: '', className: '', hidden: false, dataset: {},
    classList: {toggle() {}, remove() {}}, setAttribute() {}};
}

function dashboard({rpc = true} = {}) {
  const elements = new Map(['#view', '#toast', '#header-date', '#sync-state',
    '#storage-mode-pill', '#connected-dashboard-link'].map(selector => [selector, element()]));
  const action = element();
  elements.set('.top-actions [data-action]', action);
  const listeners = new Map();
  const requests = [];
  const blocked = {fetch: 0, browser: 0, writes: 0};
  const document = {
    querySelector: selector => elements.get(selector) ?? null,
    querySelectorAll: () => [],
    getElementById: id => elements.get('#' + id) ?? null,
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    }
  };
  function runner(success, failure) {
    return {
      withSuccessHandler(handler) {return runner(handler, failure);},
      withFailureHandler(handler) {return runner(success, handler);},
      hybridRequest(payload) {requests.push({payload: copy(payload), success, failure});}
    };
  }
  const localStorage = {getItem: () => null, setItem() {blocked.writes++; throw Error('Unexpected browser write');}};
  const window = {
    HYBRID_STORAGE_MODE: 'sheets', localStorage,
    HybridBrowserStorage: {request() {blocked.browser++; throw Error('Unexpected local fallback');}},
    addEventListener() {}, scrollTo() {},
    ...(rpc ? {google: {script: {run: runner()}}} : {})
  };
  const context = vm.createContext({window, document, localStorage,
    location: {hash: '#dashboard'}, console,
    FormData: class {constructor(form) {this.form = form;} entries() {return this.form.values[Symbol.iterator]();}},
    fetch() {blocked.fetch++; throw Error('Unexpected fetch');},
    setTimeout: () => 0, clearTimeout() {}, confirm: () => true});
  vm.runInContext(scheduleSource, context, {filename: 'htdocs/schedule.js'});
  vm.runInContext(appSource, context, {filename: 'htdocs/app.js'});
  return {
    context, elements, requests, blocked, action,
    evaluate: expression => vm.runInContext(expression, context),
    clickAction: () => Promise.all((listeners.get('click') ?? []).map(handler => handler({
      target: {closest: selector => selector === '[data-action]' ? action : null}, preventDefault() {}
    }))),
    async boot(records = {}) {
      assert.equal(requests.length, 1);
      assert.equal(requests[0].payload.path, '/api/state');
      requests.shift().success(state(records));
      await tick();
      vm.runInContext('selectedDate="2026-10-20";selectedDay="Tuesday";draw();', context);
    }
  };
}

test('Sheets mode renders workbook records and uses its authenticated RPC transport exclusively', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio({minutes: '77'})]});
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '77');
  assert.match(page.elements.get('#view').innerHTML, /77/);
  assert.match(page.elements.get('#sync-state').innerHTML, /Google Sheets/);
  assert.equal(page.action.dataset.action, 'refresh-sheets');
  assert.deepEqual(page.blocked, {fetch: 0, browser: 0, writes: 0});
});

test('pending saves do not claim success; the server acknowledgement supplies the saved record', async () => {
  const page = dashboard();
  await page.boot();
  const button = {disabled: false};
  page.context.form = {isConnected: false, querySelector: () => button};
  page.context.record = cardio({minutes: '15'});
  const saving = page.evaluate('saveForm(form,"cardio",record)');
  assert.equal(button.disabled, true);
  assert.equal(page.evaluate('model.records.cardio.length'), 0);
  assert.doesNotMatch(page.elements.get('#toast').textContent, /saved|added/i);
  const request = page.requests.shift();
  assert.equal(request.payload.path, '/api/records/cardio');
  assert.equal(request.payload.method, 'POST');
  assert.equal(JSON.parse(request.payload.body).minutes, '15');
  request.success({ok: true, record: cardio({minutes: '16', note: 'Normalized by server'})});
  await saving;
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '16');
  assert.equal(page.evaluate('model.records.cardio[0].note'), 'Normalized by server');
  assert.equal(button.disabled, false);
  assert.match(page.elements.get('#toast').textContent, /Google Sheets/i);
  assert.doesNotMatch(page.elements.get('#toast').textContent, /locally|browser/i);
  assert.deepEqual(page.blocked, {fetch: 0, browser: 0, writes: 0});
});

test('a failed Google save preserves displayed history and reports failure without a local fallback', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio()]});
  const before = page.evaluate('JSON.stringify(model.records)');
  const button = {disabled: false};
  page.context.form = {isConnected: false, querySelector: () => button};
  page.context.record = cardio({minutes: '99'});
  const saving = page.evaluate('saveForm(form,"cardio",record)');
  page.requests.shift().failure({message: 'Google authorization expired. Reopen the dashboard.'});
  await saving;
  assert.equal(page.evaluate('JSON.stringify(model.records)'), before);
  assert.equal(button.disabled, false);
  assert.match(page.elements.get('#toast').textContent, /authorization expired/);
  assert.match(page.elements.get('#toast').className, /error/);
  assert.doesNotMatch(page.elements.get('#toast').textContent, /saved locally|saved to Google/i);
  assert.deepEqual(page.blocked, {fetch: 0, browser: 0, writes: 0});
});

test('server-reported errors reject writes before changing the current model', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio()]});
  const before = page.evaluate('JSON.stringify(model.records)');
  page.context.record = cardio({minutes: '99'});
  const saving = page.evaluate('write("cardio",record)');
  page.requests.shift().success({error: 'Workbook headers changed. Restore the original columns.'});
  await assert.rejects(saving, /Workbook headers changed/);
  assert.equal(page.evaluate('JSON.stringify(model.records)'), before);
});

test('an incomplete save acknowledgement cannot corrupt history or claim that Sheets saved it', async () => {
  for (const response of [{ok: false}, {ok: true}, {ok: true, record: cardio({id: 'wrong-record'})}]) {
    const page = dashboard();
    await page.boot({cardio: [cardio()]});
    const before = page.evaluate('JSON.stringify(model.records)');
    const button = {disabled: false};
    page.context.form = {isConnected: false, querySelector: () => button};
    page.context.record = cardio({minutes: '99'});
    const saving = page.evaluate('saveForm(form,"cardio",record)');
    page.requests.shift().success(response);
    await saving;
    assert.equal(page.evaluate('JSON.stringify(model.records)'), before);
    assert.equal(button.disabled, false);
    assert.match(page.elements.get('#toast').className, /error/);
    assert.doesNotMatch(page.elements.get('#sync-state').innerHTML, /Saved to Google Sheets/);
  }
});

test('editing a manually entered cardio row preserves its existing workbook identity', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio({id: 'manually_created_cardio'})]});
  const button = {disabled: false};
  page.context.form = {id: 'cardio-form', isConnected: false,
    values: [['type', 'StairMaster'], ['minutes', '20'], ['level', '5'], ['effort', '6'], ['note', 'Edited through dashboard']],
    querySelector: () => button};
  const saving = page.evaluate('processForm(form)');
  const request = page.requests.shift();
  const sent = JSON.parse(request.payload.body);
  assert.equal(sent.id, 'manually_created_cardio');
  request.success({ok: true, record: {...sent, updated_at: '2026-10-20T13:00:00.000Z'}});
  await saving;
  assert.equal(page.evaluate('model.records.cardio.length'), 1);
  assert.equal(page.evaluate('model.records.cardio[0].id'), 'manually_created_cardio');
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '20');
});

test('Refresh Sheets reads manual workbook edits and replaces stale displayed records', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio({minutes: '15'})]});
  const refreshing = page.clickAction();
  await tick();
  assert.equal(page.requests.length, 1);
  const request = page.requests.shift();
  assert.deepEqual(request.payload, {path: '/api/state', method: 'GET', body: null});
  request.success(state({cardio: [cardio({minutes: '77'})], notes: [{id: 'manual-note',
    date: '2026-10-20', day: 'Tuesday', category: 'Training', note: 'Edited in Sheets',
    updated_at: '2026-10-20T12:00:00.000Z'}]}));
  await refreshing;
  await tick();
  assert.equal(page.evaluate('model.records.cardio.length'), 1);
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '77');
  assert.equal(page.evaluate('model.records.notes[0].note'), 'Edited in Sheets');
  assert.match(page.elements.get('#view').innerHTML, /77/);
  assert.deepEqual(page.blocked, {fetch: 0, browser: 0, writes: 0});
});

test('a refresh in flight cannot overwrite a newer save because writes wait for the read to finish', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio()]});
  const refreshing = page.clickAction();
  await tick();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].payload.method, 'GET');
  const button = {disabled: false};
  page.context.form = {isConnected: false, querySelector: () => button};
  page.context.record = cardio({minutes: '99'});
  await page.evaluate('saveForm(form,"cardio",record)');
  assert.equal(page.requests.length, 1, 'A simultaneous write could race the old state response.');
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '15');
  assert.equal(button.disabled, false);
  assert.match(page.elements.get('#toast').textContent, /refresh|wait/i);
  page.requests.shift().success(state({cardio: [cardio({minutes: '20'})]}));
  await refreshing;
  const saving = page.evaluate('saveForm(form,"cardio",record)');
  assert.equal(page.requests.length, 1, 'Saving should resume after the refresh.');
  page.requests.shift().success({ok: true, record: cardio({minutes: '99'})});
  await saving;
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '99');
});

test('refreshing while a save is awaiting Google acknowledgement does not load stale records', async () => {
  const page = dashboard();
  await page.boot({cardio: [cardio()]});
  const button = {disabled: false};
  page.context.form = {isConnected: false, querySelector: () => button};
  page.context.record = cardio({minutes: '99'});
  const saving = page.evaluate('saveForm(form,"cardio",record)');
  await page.clickAction();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].payload.method, 'POST');
  assert.match(page.elements.get('#toast').textContent, /wait.*save|save.*finish/i);
  page.requests.shift().success({ok: true, record: cardio({minutes: '99'})});
  await saving;
  assert.equal(page.evaluate('model.records.cardio[0].minutes'), '99');
});

test('opening Sheets mode outside Apps Script shows a useful connection error without pretending to save locally', async () => {
  const page = dashboard({rpc: false});
  await tick();
  const message = page.elements.get('#view').innerHTML;
  assert.match(message, /Google Apps Script|connected dashboard/i);
  assert.doesNotMatch(message, /python server|local tracker/i);
  const reading = page.evaluate('api("/api/state")');
  await assert.rejects(reading, /Google Apps Script|connected dashboard/i);
  assert.deepEqual(page.blocked, {fetch: 0, browser: 0, writes: 0});
});
