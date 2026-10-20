/* Private, browser-local persistence for the hosted THE HYBRID dashboard. */
(function (global) {
  'use strict';
  const KEY = 'the-hybrid-workouts-v1';
  const KINDS = ['sets', 'cardio', 'notes', 'checkins'];
  const FIELDS = {
    sets: ['id', 'date', 'day', 'exercise_id', 'exercise', 'set_number', 'weight_kg', 'reps', 'rir', 'completed', 'note', 'updated_at'],
    cardio: ['id', 'date', 'day', 'type', 'minutes', 'level', 'effort', 'note', 'updated_at'],
    notes: ['id', 'date', 'day', 'category', 'note', 'updated_at'],
    checkins: ['id', 'date', 'day', 'bodyweight_kg', 'sleep_hours', 'energy', 'duration_min', 'note', 'updated_at']
  };
  const LIMITS = {
    sets: {set_number: [1, 30, true], weight_kg: [0, 9999], reps: [0, 9999, true], rir: [0, 10, true]},
    cardio: {minutes: [0, 500], level: [0, 100], effort: [1, 10, true]},
    checkins: {bodyweight_kg: [0, 500], sleep_hours: [0, 24], energy: [1, 5, true], duration_min: [0, 500]}
  };
  let planPromise;
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const empty = () => Object.fromEntries(KINDS.map(kind => [kind, []]));
  function validDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  }
  function textField(value, name, max = 5000) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw Error(`${name} must be text or a number.`);
    const text = String(value);
    if (text.length > max) throw Error(`${name} is too long (maximum ${max} characters).`);
    return text;
  }
  function normalize(kind, incoming, plan, preserveTimestamp = false) {
    if (!KINDS.includes(kind) || !object(incoming)) throw Error('Invalid record type or record object.');
    if (Object.keys(incoming).some(key => !FIELDS[kind].includes(key))) throw Error(`Unexpected field in ${kind} record.`);
    const item = Object.fromEntries(FIELDS[kind].map(field => [field, textField(incoming[field], field)]));
    if (!/^[\w.:-]{1,150}$/.test(item.id)) throw Error('Invalid record ID.');
    if (!validDate(item.date)) throw Error('Enter a valid calendar date in YYYY-MM-DD format.');
    const allowedDays = ['notes', 'checkins'].includes(kind) ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : plan.days.map(day => day.day);
    if (!allowedDays.includes(item.day)) throw Error('Select a valid training or journal day.');
    for (const [field, [min, max, integer]] of Object.entries(LIMITS[kind] || {})) {
      const value = item[field].trim();
      if (value === '' && field !== 'set_number') { item[field] = ''; continue; }
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max || (integer && !Number.isInteger(Number(value)))) {
        throw Error(`${field.replace(/_/g, ' ')} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
      }
      item[field] = String(Number(value));
    }
    if (kind === 'sets') {
      // Keep historical exercise names usable when the read-only plan changes.
      if (!item.exercise_id.trim() || !item.exercise.trim()) throw Error('Exercise ID and name cannot be empty.');
      const completed = item.completed.toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(completed)) throw Error('Completed must be TRUE or FALSE.');
      item.completed = ['true', '1', 'yes'].includes(completed) ? 'TRUE' : 'FALSE';
      if (item.completed === 'TRUE' && (!item.reps || Number(item.reps) <= 0)) throw Error('Enter reps before marking a set complete.');
    }
    if (kind === 'cardio' && (!item.type.trim() || item.type.length > 120)) throw Error('Enter a cardio activity (maximum 120 characters).');
    if (kind === 'notes' && (item.category.length > 120 || !item.note.trim())) throw Error('Add some note text (category maximum 120 characters).');
    if (preserveTimestamp && item.updated_at) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.updated_at) || !validDate(item.updated_at.slice(0, 10)) || !Number.isFinite(Date.parse(item.updated_at))) throw Error('Invalid record update timestamp.');
    } else item.updated_at = new Date().toISOString();
    return item;
  }
  function validateRecords(records, plan) {
    if (!object(records) || Object.keys(records).length !== KINDS.length || KINDS.some(kind => !Array.isArray(records[kind]))) throw Error('A backup must contain sets, cardio, notes and checkins arrays.');
    const clean = empty();
    for (const kind of KINDS) {
      const ids = new Set();
      if (records[kind].length > 50000) throw Error('This backup contains too many records.');
      clean[kind] = records[kind].map(record => {
        const item = normalize(kind, record, plan, true);
        if (ids.has(item.id)) throw Error(`Duplicate ${kind} record ID: ${item.id}`);
        ids.add(item.id);
        return item;
      });
    }
    return clean;
  }
  function read(plan, checkPersistence = false) {
    let raw;
    try { raw = global.localStorage.getItem(KEY); }
    catch { throw Error('Browser storage is unavailable. Allow site storage, then reload this dashboard.'); }
    if (!raw) {
      // Probe persistence before showing a ready dashboard, including private-mode restrictions.
      if (checkPersistence) commit(empty());
      return empty();
    }
    try {
      const saved = JSON.parse(raw);
      if (!object(saved) || saved.version !== 1) throw Error('Invalid stored data version.');
      return validateRecords(saved.records, plan);
    } catch (error) { throw Error('Saved browser data could not be read: ' + error.message + ' Your stored data has been kept.'); }
  }
  function commit(records) {
    try { global.localStorage.setItem(KEY, JSON.stringify({version: 1, records})); }
    catch { throw Error('Could not save to this browser. Storage may be blocked or full. Free space or allow site storage and try again.'); }
  }
  async function getPlan() {
    if (!planPromise) planPromise = fetch('./plan.json').then(async response => {
      if (!response.ok) throw Error('The training plan could not be loaded. Please reload the dashboard.');
      const plan = await response.json();
      if (!Array.isArray(plan.days) || !plan.days.length || !Array.isArray(plan.weeks)) throw Error('The training plan is invalid.');
      return plan;
    }).catch(error => { planPromise = undefined; throw error; });
    return planPromise;
  }
  async function request(path, opts = {}) {
    const plan = await getPlan();
    const method = (opts.method || 'GET').toUpperCase();
    const records = read(plan, path === '/api/state' && method === 'GET');
    if (path === '/api/state' && method === 'GET') return {plan: clone(plan), records, connected: false, last_sync: null, offline: true, storage_mode: 'browser'};
    if (path === '/api/export' && method === 'GET') return {version: 1, exported_at: new Date().toISOString(), records};
    let incoming;
    if (method === 'POST') {
      try { incoming = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body; }
      catch { throw Error('Invalid JSON data.'); }
    }
    if (path === '/api/import' && method === 'POST') {
      if (!object(incoming) || incoming.version !== 1) throw Error('Invalid backup format or version.');
      // Validate everything before the single atomic setItem, so a bad row cannot partly import.
      const imported = validateRecords(incoming.records, plan);
      const next = clone(records);
      for (const kind of KINDS) {
        const merged = new Map(next[kind].map(record => [record.id, record]));
        imported[kind].forEach(record => merged.set(record.id, record));
        next[kind] = [...merged.values()];
      }
      commit(next);
      return {ok: true, imported: Object.fromEntries(KINDS.map(kind => [kind, imported[kind].length]))};
    }
    const match = path.match(/^\/api\/records\/(sets|cardio|notes|checkins)(?:\/([^/]+))?$/);
    if (match && method === 'POST' && !match[2]) {
      const kind = match[1], record = normalize(kind, incoming, plan);
      records[kind] = records[kind].filter(item => item.id !== record.id).concat(record);
      commit(records);
      return {ok: true, record};
    }
    if (match && method === 'DELETE' && match[2]) {
      const kind = match[1], id = decodeURIComponent(match[2]);
      records[kind] = records[kind].filter(item => item.id !== id);
      commit(records);
      return {deleted: true};
    }
    throw Error('This action is only available in the local Python version.');
  }
  global.HybridBrowserStorage = Object.freeze({request, storageKey: KEY});
})(window);
