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
  const organiseRequest = path === '/api/organise' && method === 'POST';
  const saveRequest = match && method === 'POST' && !match[2];
  const deleteRequest = match && match[1] === 'notes' && method === 'DELETE' && match[2];
  if (!stateRequest && !exportRequest && !refreshRequest && !organiseRequest && !saveRequest && !deleteRequest) throw Error('This dashboard action is not supported.');
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
    if (organiseRequest) {
      changed = true;
      hybridOrganise_(book, plan, tables);
      return {ok: true, organised: true};
    }
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
      hybridSortLog_(table, {row: row, date: item.date});
      if (kind === 'checkins') hybridWriteWeightTrend_(book, table.entries.map(entry => entry.record).filter(record => record.id !== item.id).concat([item]), false);
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

/** Orders PLAN and START HERE Monday to Sunday, sorts the log tabs by date and creates the Weight Trend tab and chart. */
function hybridOrganise_(book, plan, tables) {
  hybridOrderPlanTab_(book);
  hybridOrderStartHere_(book, plan);
  Object.keys(tables).forEach(kind => hybridSortLog_(tables[kind], null));
  hybridWriteWeightTrend_(book, hybridRecords_(tables).checkins, true);
}

const HYBRID_WEEKDAYS_ = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HYBRID_TREND_TAB_ = 'Weight Trend';
function hybridDayNumber_(iso) { return Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000); }

/** Sorts rows 2+ by numeric keys through a temporary column, so whole rows move with their formatting and ties keep their order. */
function hybridSortRows_(sheet, keys) {
  const width = sheet.getLastColumn(), added = sheet.getMaxColumns() <= width;
  if (added) sheet.insertColumnAfter(width);
  const keyRange = sheet.getRange(2, width + 1, keys.length, 1);
  keyRange.setValues(keys.map((key, index) => [key * 10000 + index]));
  sheet.getRange(2, 1, keys.length, width + 1).sort({column: width + 1, ascending: true});
  if (added) sheet.deleteColumn(width + 1);
  else keyRange.clearContent();
}

/** Keeps a log tab in date order. Cleared rows sink to the bottom. Sorts only when a row is out of place. */
function hybridSortLog_(table, written) {
  const last = Math.max(table.sheet.getLastRow(), written ? written.row : 0);
  if (last < 3) return false;
  const dates = {};
  table.entries.forEach(entry => { dates[entry.row] = entry.record.date; });
  if (written) dates[written.row] = written.date;
  const keys = [];
  for (let row = 2; row <= last; row++) keys.push(dates[row] ? hybridDayNumber_(dates[row]) : 1e6);
  if (keys.every((key, index) => index === 0 || key >= keys[index - 1])) return false;
  hybridSortRows_(table.sheet, keys);
  return true;
}

/** Reorders PLAN rows Monday to Sunday, keeping each day's exercises in their listed order. */
function hybridOrderPlanTab_(book) {
  const sheet = book.getSheetByName('PLAN');
  if (!sheet || sheet.getLastRow() < 3) return;
  const keys = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(row => HYBRID_WEEKDAYS_.indexOf(String(row[0]).trim()));
  // An unexpected layout is left untouched rather than guessed at.
  if (keys.some(key => key < 0) || keys.every((key, index) => index === 0 || key >= keys[index - 1])) return;
  hybridSortRows_(sheet, keys);
}

/** Puts the START HERE weekday rows in Monday-to-Sunday order and lists the dates of Week 1. */
function hybridOrderStartHere_(book, plan) {
  const sheet = book.getSheetByName('START HERE');
  if (!sheet || sheet.getLastRow() < 1) return;
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  const upper = HYBRID_WEEKDAYS_.map(day => day.toUpperCase());
  const slots = [];
  values.forEach((row, index) => { if (upper.includes(String(row[0]).trim().toUpperCase())) slots.push(index); });
  const ordered = slots.map(index => values[index]).sort((a, b) => upper.indexOf(String(a[0]).trim().toUpperCase()) - upper.indexOf(String(b[0]).trim().toUpperCase()));
  slots.forEach((index, n) => {
    if (values[index] !== ordered[n]) sheet.getRange(index + 1, 1, 1, 2).setValues([[ordered[n][0], ordered[n][1]]]);
  });
  const weekRow = values.findIndex(row => /^WEEK 1 (CYCLE|DATES)$/i.test(String(row[0]).trim()));
  if (weekRow < 0) return;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const start = hybridDayNumber_(plan.start_date), monday = start - ((start + 3) % 7 + 7) % 7;
  const dates = plan.days.map(day => monday + HYBRID_WEEKDAYS_.indexOf(day.day)).sort((a, b) => a - b).map(number => {
    const date = new Date(number * 86400000);
    return HYBRID_WEEKDAYS_[(date.getUTCDay() + 6) % 7].slice(0, 3) + ' ' + date.getUTCDate() + ' ' + months[date.getUTCMonth()] + (number < start ? ' (before start)' : '');
  });
  const text = dates.join(', ') + ' ' + plan.start_date.slice(0, 4);
  if (values[weekRow][0] !== 'WEEK 1 DATES' || values[weekRow][1] !== text) sheet.getRange(weekRow + 1, 1, 1, 2).setValues([['WEEK 1 DATES', text]]);
}

/** Daily weigh-ins with the average of the weigh-ins from the 7 calendar days ending on each date. */
function hybridWeightRows_(checkins) {
  const byDate = {};
  checkins.forEach(record => {
    const kg = Number(record.bodyweight_kg);
    if (!record.bodyweight_kg || !(kg > 0)) return;
    if (!byDate[record.date] || record.updated_at > byDate[record.date].updated_at) byDate[record.date] = {date: record.date, kg: kg, updated_at: record.updated_at};
  });
  const days = Object.keys(byDate).sort().map(date => byDate[date]);
  return days.map(point => {
    const from = hybridDayNumber_(point.date) - 6;
    const window = days.filter(other => other.date <= point.date && hybridDayNumber_(other.date) >= from);
    return [point.date, point.kg, Math.round(window.reduce((sum, other) => sum + other.kg, 0) / window.length * 100) / 100];
  });
}

/** Rewrites the Weight Trend tab. Saves only refresh an existing tab; setup creates it and its chart. */
function hybridWriteWeightTrend_(book, checkins, create) {
  let sheet = book.getSheetByName(HYBRID_TREND_TAB_);
  if (!sheet) {
    if (!create) return;
    sheet = book.insertSheet(HYBRID_TREND_TAB_);
  }
  const rows = hybridWeightRows_(checkins), previous = sheet.getLastRow();
  sheet.getRange(1, 1, 1, 3).setValues([['Date', 'Daily weigh-in (kg)', '7-day average (kg)']]);
  if (previous > 1) sheet.getRange(2, 1, previous - 1, 3).clearContent();
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('d mmm yyyy');
    sheet.getRange(2, 2, rows.length, 2).setNumberFormat('0.0');
  }
  if (create && !sheet.getCharts().length) {
    sheet.insertChart(sheet.newChart().asLineChart()
      .addRange(sheet.getRange(1, 1, HYBRID_MAX_ROWS_ + 1, 3))
      .setNumHeaders(1)
      .setPosition(2, 5, 0, 0)
      .setOption('title', 'Body weight trend')
      .setOption('legend', {position: 'bottom'})
      .setOption('hAxis', {format: 'd MMM'})
      .setOption('vAxis', {title: 'kg'})
      .setOption('series', {0: {lineWidth: 0, pointSize: 5, color: '#93a39a'}, 1: {lineWidth: 3, color: '#7cb342'}})
      .build());
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
