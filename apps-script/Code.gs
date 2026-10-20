/* HYBRID_PLAN is prepended by the Apps Script build. Keep workbook access server-side. */
const HYBRID_BOOK_ID_ = '17VglmaSdddJHB_tSFtQir2CiUSEiWJ9yfkavgTJRNOk';
const HYBRID_MAX_ROWS_ = 4999;
const HYBRID_SCHEMA_ = {
  sets: {tab: 'Workout Logs', fields: ['id', 'date', 'day', 'exercise_id', 'exercise', 'set_number', 'weight_kg', 'reps', 'rir', 'completed', 'note', 'updated_at']},
  cardio: {tab: 'Cardio', fields: ['id', 'date', 'day', 'type', 'minutes', 'level', 'effort', 'note', 'updated_at']},
  notes: {tab: 'Daily Notes', fields: ['id', 'date', 'day', 'category', 'note', 'updated_at']},
  checkins: {tab: 'Check-ins', fields: ['id', 'date', 'day', 'bodyweight_kg', 'sleep_hours', 'energy', 'duration_min', 'note', 'updated_at']}
};
const HYBRID_LIMITS_ = {
  sets: {set_number: [1, 30, true], weight_kg: [0, 9999], reps: [0, 9999, true], rir: [0, 10, true]},
  cardio: {minutes: [0, 500], level: [0, 100], effort: [1, 10, true]},
  checkins: {bodyweight_kg: [0, 500], sleep_hours: [0, 24], energy: [1, 5, true], duration_min: [0, 500]}
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('THE HYBRID — Gym Command Centre')
    .addMetaTag('viewport', 'width=device-width,initial-scale=1,viewport-fit=cover');
}

/** The only client-callable data function. Deployment access is restricted to the owner. */
function hybridRequest(request) {
  if (!hybridObject_(request) || typeof request.path !== 'string') throw Error('Provide a valid dashboard request.');
  if (Object.keys(request).some(key => !['path', 'method', 'body'].includes(key))) throw Error('Unexpected dashboard request field.');
  const path = request.path, method = String(request.method || 'GET').toUpperCase();
  const match = path.match(/^\/api\/records\/(sets|cardio|notes|checkins)(?:\/([^/]+))?$/);
  const stateRequest = path === '/api/state' && method === 'GET';
  const exportRequest = path === '/api/export' && method === 'GET';
  const refreshRequest = path === '/api/sync' && method === 'POST';
  const saveRequest = match && method === 'POST' && !match[2];
  const deleteRequest = match && match[1] === 'notes' && method === 'DELETE' && match[2];
  if (!stateRequest && !exportRequest && !refreshRequest && !saveRequest && !deleteRequest) throw Error('This dashboard action is not supported.');
  const plan = hybridPlan_();
  let item, deleteId;
  if (saveRequest) {
    let incoming;
    try { incoming = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
    catch (_) { throw Error('Invalid JSON record.'); }
    item = hybridNormalize_(match[1], incoming, plan, false);
  }
  if (deleteRequest) {
    try { deleteId = decodeURIComponent(match[2]); }
    catch (_) { throw Error('Invalid record ID.'); }
    if (!/^[\w.:-]{1,150}$/.test(deleteId)) throw Error('Invalid record ID.');
  }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (_) { throw Error('Another save is in progress. Please try again in a moment.'); }
  let changed = false;
  try {
    const book = SpreadsheetApp.openById(HYBRID_BOOK_ID_);
    // Validate every tab before a write so malformed headers cannot partly update a workbook.
    const tables = hybridTables_(book, plan);
    const now = new Date().toISOString();
    if (stateRequest) return {plan: JSON.parse(JSON.stringify(plan)), records: hybridRecords_(tables), connected: true, sheet_url: hybridSheetUrl_(), last_sync: now, offline: false, storage_mode: 'sheets'};
    if (exportRequest) return {version: 1, exported_at: now, records: hybridRecords_(tables)};
    if (refreshRequest) return {ok: true, last_sync: now, pulled: 0, pushed: 0, deleted: 0, conflicts: 0};
    const kind = match[1], table = tables[kind];
    if (saveRequest) {
      const found = table.entries.find(entry => entry.record.id === item.id);
      const row = found ? found.row : hybridFreeRow_(table);
      if (row > HYBRID_MAX_ROWS_ + 1) throw Error('The ' + table.tab + ' tab is full (maximum 4,999 records). Archive older records before adding more.');
      const maxRows = table.sheet.getMaxRows();
      if (row > maxRows) {
        changed = true;
        table.sheet.insertRowsAfter(maxRows, row - maxRows);
      }
      // Restrict writes to this record's schema cells; extra columns and formatting remain intact.
      const values = table.fields.map(field => hybridLiteral_(item[field]));
      changed = true;
      table.sheet.getRange(row, 1, 1, table.fields.length).setValues([values]);
      return {ok: true, record: item};
    }
    const found = table.entries.find(entry => entry.record.id === deleteId);
    if (found) {
      changed = true;
      // Leave the row and its unrelated columns in place. A later insert can reuse the empty slot.
      table.sheet.getRange(found.row, 1, 1, table.fields.length).clearContent();
    }
    return {deleted: true};
  } finally {
    try { if (changed) SpreadsheetApp.flush(); }
    finally { lock.releaseLock(); }
  }
}

function hybridPlan_() {
  if (typeof HYBRID_PLAN === 'undefined' || !HYBRID_PLAN || !Array.isArray(HYBRID_PLAN.days) || !Array.isArray(HYBRID_PLAN.weeks)) throw Error('The training plan is not configured.');
  return HYBRID_PLAN;
}

function hybridSheetUrl_() { return 'https://docs.google.com/spreadsheets/d/' + HYBRID_BOOK_ID_ + '/edit'; }
function hybridObject_(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hybridValidDate_(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function hybridText_(value, name) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw Error(name + ' must be text or a number.');
  const text = String(value);
  if (text.length > 5000) throw Error(name + ' is too long (maximum 5,000 characters).');
  return text;
}

function hybridNormalize_(kind, incoming, plan, preserveTimestamp) {
  const schema = HYBRID_SCHEMA_[kind];
  if (!schema || !hybridObject_(incoming)) throw Error('Provide a valid record object.');
  if (Object.keys(incoming).some(key => !schema.fields.includes(key))) throw Error('Unexpected field in ' + kind + ' record.');
  const item = {};
  schema.fields.forEach(field => { item[field] = hybridText_(incoming[field], field); });
  if (!/^[\w.:-]{1,150}$/.test(item.id)) throw Error('Invalid record ID.');
  if (!hybridValidDate_(item.date)) throw Error('Enter a valid calendar date in YYYY-MM-DD format.');
  const days = ['notes', 'checkins'].includes(kind) ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : plan.days.map(day => day.day);
  if (!days.includes(item.day)) throw Error('Select a valid training or journal day.');
  Object.keys(HYBRID_LIMITS_[kind] || {}).forEach(field => {
    const bounds = HYBRID_LIMITS_[kind][field], value = item[field].trim();
    if (value === '' && field !== 'set_number') { item[field] = ''; return; }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < bounds[0] || Number(value) > bounds[1] || (bounds[2] && !Number.isInteger(Number(value)))) {
      throw Error(field.replace(/_/g, ' ') + ' must be ' + (bounds[2] ? 'a whole number' : 'a number') + ' from ' + bounds[0] + ' to ' + bounds[1] + '.');
    }
    item[field] = String(Number(value));
  });
  if (kind === 'sets') {
    // Existing exercise IDs remain valid when the plan's weekdays or labels change.
    if (!item.exercise_id.trim() || !item.exercise.trim()) throw Error('Exercise ID and name cannot be empty.');
    const completed = item.completed.toLowerCase();
    if (!['true', 'false', '1', '0', 'yes', 'no'].includes(completed)) throw Error('Completed must be TRUE or FALSE.');
    item.completed = ['true', '1', 'yes'].includes(completed) ? 'TRUE' : 'FALSE';
    if (item.completed === 'TRUE' && (!item.reps || Number(item.reps) <= 0)) throw Error('Enter reps before marking a set complete.');
  }
  if (kind === 'cardio' && (!item.type.trim() || item.type.length > 120)) throw Error('Enter a cardio activity (maximum 120 characters).');
  if (kind === 'notes' && (!item.note.trim() || item.category.length > 120)) throw Error('Add some note text (category maximum 120 characters).');
  if (preserveTimestamp) {
    if (item.updated_at && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.updated_at) || !hybridValidDate_(item.updated_at.slice(0, 10)) || !Number.isFinite(Date.parse(item.updated_at)))) throw Error('Invalid record update timestamp.');
  } else item.updated_at = new Date().toISOString();
  return item;
}

function hybridCellText_(value, field, timezone) {
  if (value instanceof Date) {
    if (!Number.isFinite(+value)) throw Error('Invalid date cell.');
    return field === 'date' ? Utilities.formatDate(value, timezone, 'yyyy-MM-dd') : value.toISOString();
  }
  return hybridText_(value, field);
}

function hybridTables_(book, plan) {
  const tables = {}, timezone = book.getSpreadsheetTimeZone();
  Object.keys(HYBRID_SCHEMA_).forEach(kind => {
    const schema = HYBRID_SCHEMA_[kind], sheet = book.getSheetByName(schema.tab);
    if (!sheet) throw Error('Missing worksheet: ' + schema.tab + '. Restore the original tab before saving.');
    const headers = sheet.getRange(1, 1, 1, schema.fields.length).getValues()[0];
    if (schema.fields.some((field, index) => headers[index] !== field)) throw Error('The ' + schema.tab + ' header row has changed. Restore its original columns before saving.');
    const lastRow = sheet.getLastRow();
    if (lastRow > HYBRID_MAX_ROWS_ + 1) throw Error('The ' + schema.tab + ' tab exceeds the 4,999-record limit. Archive older records before saving.');
    const values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, schema.fields.length).getValues() : [];
    const ids = new Set(), entries = [], blankRows = [];
    values.forEach((values, index) => {
      const row = index + 2, raw = {};
      schema.fields.forEach((field, column) => { raw[field] = hybridCellText_(values[column], field, timezone); });
      if (schema.fields.every(field => raw[field] === '')) { blankRows.push(row); return; }
      if (!raw.id) throw Error(schema.tab + ' row ' + row + ' needs a record ID. Fill the id column or remove the incomplete row before saving.');
      if (ids.has(raw.id)) throw Error('Duplicate ID in ' + schema.tab + ' row ' + row + '. Resolve duplicate records before saving.');
      let record;
      try { record = hybridNormalize_(kind, raw, plan, true); }
      catch (error) { throw Error(schema.tab + ' row ' + row + ': ' + error.message); }
      ids.add(record.id);
      entries.push({row: row, record: record});
    });
    tables[kind] = {sheet: sheet, tab: schema.tab, fields: schema.fields, entries: entries, blankRows: blankRows, lastRow: lastRow};
  });
  return tables;
}

function hybridRecords_(tables) {
  const records = {};
  Object.keys(HYBRID_SCHEMA_).forEach(kind => { records[kind] = tables[kind].entries.map(entry => entry.record); });
  return records;
}

function hybridFreeRow_(table) { return table.blankRows.length ? table.blankRows[0] : Math.max(2, table.lastRow + 1); }

function hybridLiteral_(value) {
  // Apps Script treats strings starting '=' as formulas. A leading apostrophe stores literal text.
  // Guard other spreadsheet formula prefixes as well, including prefixes after whitespace.
  return /^\s*[=+\-@]/.test(value) || /^'/.test(value) ? "'" + value : value;
}
