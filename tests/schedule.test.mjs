import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scheduleSource = await readFile(new URL('../htdocs/schedule.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../htdocs/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../htdocs/index.html', import.meta.url), 'utf8');
const plan = JSON.parse(await readFile(new URL('../htdocs/plan.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const window = {};
vm.runInNewContext(scheduleSource, { window }, { filename: 'htdocs/schedule.js' });
const schedule = window.HybridSchedule;
const cycleOne = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const cycleTwo = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const requestedSessions = [
  ['2026-10-19', 'Monday', 'Legs B + Core', 10],
  ['2026-10-20', 'Tuesday', 'Chest + Back A', 15],
  ['2026-10-21', 'Wednesday', 'Legs A + Core', 10],
  ['2026-10-22', 'Thursday', 'Shoulders + Arms', 25],
  ['2026-10-23', 'Friday', 'Chest + Back B', 20]
];

test('the programme starts Tuesday 20 October and lists its sessions Monday to Friday', () => {
  assert.equal(plan.start_date, '2026-10-20');
  assert.deepEqual(plan.days.map(day => day.day), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  for (const [date, weekday, focus, minutes] of requestedSessions) {
    const day = schedule.sessionFor(plan, date);
    assert.equal(day.day, weekday, date);
    assert.equal(day.focus, focus, date);
    assert.equal(day.cardio_target, minutes, date);
    if (focus.startsWith('Legs')) assert.equal(day.cardio_intensity, 'Easy');
  }
});

test('each training week runs Monday to Sunday', () => {
  for (const date of ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']) {
    assert.equal(schedule.cycleStart(plan, date), '2026-10-19', date);
    assert.deepEqual(copy(schedule.weekDates(plan, date)), cycleOne, date);
  }
  assert.equal(schedule.cycleStart(plan, '2026-10-26'), '2026-10-26');
  assert.deepEqual(copy(schedule.weekDates(plan, '2026-10-27')), cycleTwo);
  assert.deepEqual(copy(schedule.cycleDates(plan, '2026-10-25')), [
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'
  ]);
});

test('week numbering rolls over on Monday, including the October daylight saving change', () => {
  for (const date of ['2026-10-19', '2026-10-20', '2026-10-24', '2026-10-25']) {
    assert.equal(schedule.weekOf(plan, date), 1, date);
  }
  assert.equal(schedule.weekOf(plan, '2026-10-26'), 2);
  assert.equal(schedule.weekOf(plan, '2026-11-01'), 2);
  assert.equal(schedule.weekOf(plan, '2026-11-02'), 3);
  assert.equal(schedule.weekOf(plan, '2026-11-09'), 4);
  assert.equal(schedule.weekOf(plan, '2026-10-12'), 1);
  assert.equal(schedule.weekOf(plan, '2026-12-01'), 4);
});

test('weekend rest days recommend the following Monday Legs B session', () => {
  for (const date of ['2026-10-24', '2026-10-25']) {
    assert.equal(schedule.sessionFor(plan, date), null);
    const next = schedule.nextSession(plan, date);
    assert.equal(next.date, '2026-10-26');
    assert.equal(next.day.day, 'Monday');
    assert.equal(next.day.focus, 'Legs B + Core');
    assert.equal(next.day.cardio_target, 10);
  }
  for (const [date, weekday] of requestedSessions) {
    assert.equal(schedule.nextSession(plan, date).date, date);
    assert.equal(schedule.nextSession(plan, date).day.day, weekday);
  }
});

test('day jumps keep dates aligned to the Monday–Sunday week across DST and month boundaries', () => {
  assert.equal(schedule.dateForDay(plan, '2026-10-20', 'Monday'), '2026-10-19');
  assert.equal(schedule.dateForDay(plan, '2026-10-25', 'Monday'), '2026-10-19');
  assert.equal(schedule.dateForDay(plan, '2026-10-26', 'Tuesday'), '2026-10-27');
  assert.equal(schedule.dateForDay(plan, '2026-10-27', 'Monday'), '2026-10-26');
  assert.equal(schedule.dateForDay(plan, '2026-11-01', 'Friday'), '2026-10-30');
  assert.equal(schedule.dateForDay(plan, '2026-11-02', 'Friday'), '2026-11-06');
  assert.equal(schedule.addDays('2026-10-24', 2), '2026-10-26');
  assert.equal(schedule.addDays('2026-10-26', -2), '2026-10-24');
  assert.equal(schedule.addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(schedule.dayFor('2026-10-25'), 'Sunday');
  assert.equal(schedule.dayFor('2026-10-26'), 'Monday');
});

test('the dashboard loads schedule helpers before the application', () => {
  const scripts = [...indexSource.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.indexOf('./schedule.js') >= 0);
  assert.ok(scripts.indexOf('./schedule.js') < scripts.indexOf('./app.js'));
});

async function createApp(today, hash = '#train', records = { sets: [], cardio: [], notes: [], checkins: [] }) {
  const nodes = new Map();
  const listeners = new Map();
  const saved = new Map();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [today + 'T12:00:00'])); }
    static now() { return Date.parse(today + 'T12:00:00'); }
  }
  const document = {
    querySelector(selector) {
      if (selector === '.top-actions [data-action]') return null;
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', className: '' });
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    }
  };
  const localStorage = { getItem: name => saved.get(name) ?? null, setItem: (name, value) => saved.set(name, String(value)) };
  const browserWindow = {
    HYBRID_STORAGE_MODE: 'browser',
    HybridBrowserStorage: { request: async () => ({ plan: copy(plan), records: copy(records), connected: false }) },
    addEventListener() {}, scrollTo() {}
  };
  const context = vm.createContext({ window: browserWindow, document, localStorage, location: { hash }, Date: FixedDate, setTimeout, clearTimeout, console });
  vm.runInContext(scheduleSource, context, { filename: 'htdocs/schedule.js' });
  vm.runInContext(appSource, context, { filename: 'htdocs/app.js' });
  await new Promise(resolve => setImmediate(resolve));
  const html = () => nodes.get('#view')?.innerHTML ?? '';
  assert.doesNotMatch(html(), /could not load|cannot reach|could not start/i);
  return {
    html,
    evaluate: expression => vm.runInContext(expression, context),
    click: async (selector, dataset) => {
      const element = { dataset };
      const event = { target: { closest: candidate => candidate === selector ? element : null }, preventDefault() {} };
      for (const listener of listeners.get('click') ?? []) await listener(event);
    },
    change: async (id, value) => {
      for (const listener of listeners.get('change') ?? []) await listener({ target: { id, value } });
    }
  };
}

test('the Training log displays each rescheduled workout on its actual date', async () => {
  for (const [date, , focus, minutes] of requestedSessions) {
    const app = await createApp(date);
    assert.match(app.html(), new RegExp(`<h2>${focus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h2>`), date);
    assert.match(app.html(), new RegExp(`TARGET ${minutes} MIN`), date);
    assert.match(app.html(), new RegExp(`id="training-date"[^>]*value="${date}"`), date);
    assert.equal(app.evaluate('weekOf(selectedDate)'), 1, date);
  }
});

test('weekend Training log shows recovery and Monday’s next session without workout entry forms', async () => {
  for (const date of ['2026-10-24', '2026-10-25']) {
    const app = await createApp(date);
    assert.match(app.html(), /rest|recovery/i, date);
    assert.match(app.html(), /Legs B \+ Core/, date);
    assert.doesNotMatch(app.html(), /class="exercise-card"|id="cardio-form"|data-action="save-set"/, date);
  }
});

test('day tabs and overview shortcuts select the correct date and exercise split', async () => {
  const app = await createApp('2026-10-20');
  assert.ok(app.html().indexOf('data-day="Monday"') < app.html().indexOf('data-day="Tuesday"'));
  await app.click('[data-day]', { day: 'Monday' });
  assert.equal(app.evaluate('selectedDate'), '2026-10-19');
  assert.equal(app.evaluate('selectedDay'), 'Monday');
  assert.match(app.html(), /<h2>Legs B \+ Core<\/h2>/);
  await app.click('[data-day]', { day: 'Tuesday' });
  assert.equal(app.evaluate('selectedDate'), '2026-10-20');
  await app.click('[data-jump-day]', { jumpDay: 'Friday' });
  assert.equal(app.evaluate('selectedDate'), '2026-10-23');
  assert.match(app.html(), /<h2>Chest \+ Back B<\/h2>/);

  await app.change('training-date', '2026-10-27');
  assert.equal(app.evaluate('selectedDay'), 'Tuesday');
  assert.equal(app.evaluate('weekOf(selectedDate)'), 2);
  await app.click('[data-day]', { day: 'Monday' });
  assert.equal(app.evaluate('selectedDate'), '2026-10-26');
  assert.equal(app.evaluate('weekOf(selectedDate)'), 2);
});

test('changing the Training date to a weekend renders rest while the journal retains its selected date', async () => {
  const app = await createApp('2026-10-20');
  await app.change('training-date', '2026-10-25');
  assert.match(app.html(), /rest|recovery/i);
  assert.doesNotMatch(app.html(), /class="exercise-card"|id="cardio-form"/);
  await app.click('[data-nav]', { nav: 'journal' });
  assert.match(app.html(), /id="journal-date"[^>]*value="2026-10-25"/);
  assert.match(app.html(), /id="checkin-form"/);
});

test('the overview lists Monday to Sunday and marks a Monday before the programme start', async () => {
  const app = await createApp('2026-10-21', '#dashboard');
  const html = app.html();
  const order = ['MON</strong><small>19 Oct', 'TUE</strong><small>20 Oct', 'WED</strong><small>21 Oct', 'THU</strong><small>22 Oct',
    'FRI</strong><small>23 Oct', 'SAT</strong><small>24 Oct', 'SUN</strong><small>25 Oct'].map(label => html.indexOf(label));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), String(order));
  assert.match(html, /Before your programme starts on 20 Oct/);
  assert.doesNotMatch(html, /aria-label="Open Monday 19 Oct/);
  assert.match(html, /MON – SUN/);

  const next = await createApp('2026-10-27', '#dashboard');
  assert.match(next.html(), /aria-label="Open Monday 26 Oct: Legs B \+ Core"/);
  assert.ok(next.html().indexOf('Open Monday 26 Oct') < next.html().indexOf('Open Tuesday 27 Oct'));
});

test('the overview shows actual cycle dates and still counts saved sets with historical weekday labels', async () => {
  const exercise = plan.days.find(day => day.day === 'Tuesday').exercises[0];
  const record = {
    id: `2026-10-20__${exercise.id}__1`, date: '2026-10-20', day: 'Monday',
    exercise_id: exercise.id, exercise: exercise.name, set_number: '1',
    weight_kg: '80.5', reps: '10', rir: '2', completed: 'TRUE', note: 'Saved before schedule changed',
    updated_at: '2026-10-20T10:00:00Z'
  };
  const app = await createApp('2026-10-20', '#dashboard', { sets: [record], cardio: [], notes: [], checkins: [] });
  assert.match(app.html(), /aria-label="Open Tuesday 20 Oct: Chest \+ Back A"/);
  assert.match(app.html(), /aria-label="Open Friday 23 Oct: Chest \+ Back B"/);
  assert.match(app.html(), /SAT<\/strong><small>24 Oct<\/small>/);
  assert.match(app.html(), /SUN<\/strong><small>25 Oct<\/small>/);
  assert.equal(app.evaluate("wkDone('Tuesday',weekDates())"), 1);
  await app.click('[data-jump-day]', { jumpDay: 'Tuesday' });
  assert.equal(app.evaluate('todaySets().length'), 1);
  assert.match(app.html(), /data-field="weight_kg" value="80\.5"/);
});

test('the weekend next-session button opens Monday 26 October rather than a past Monday', async () => {
  const app = await createApp('2026-10-25');
  assert.match(app.html(), /data-session-date="2026-10-26"/);
  await app.click('[data-session-date]', { sessionDate: '2026-10-26' });
  assert.equal(app.evaluate('selectedDate'), '2026-10-26');
  assert.equal(app.evaluate('selectedDay'), 'Monday');
  assert.match(app.html(), /<h2>Legs B \+ Core<\/h2>/);
});

const checkin = (date, kg, updated = `${date}T07:00:00Z`) => ({
  id: `checkin__${date}`, date, day: schedule.dayFor(date), bodyweight_kg: kg, sleep_hours: '', energy: '',
  duration_min: '', note: '', updated_at: updated
});

test('the weight trend averages the weigh-ins from the last 7 calendar days', async () => {
  const checkins = [
    checkin('2026-10-23', '79.8'), checkin('2026-10-20', '80.0'), checkin('2026-10-21', '80.4'),
    checkin('2026-10-28', '79.0'), checkin('2026-10-24', ''), { ...checkin('2026-10-21', '99'), id: 'old', updated_at: '2026-10-21T06:00:00Z' }
  ];
  const app = await createApp('2026-10-28', '#progress', { sets: [], cardio: [], notes: [], checkins });
  const series = JSON.parse(app.evaluate('JSON.stringify(weightSeries())'));
  assert.deepEqual(series.map(p => [p.date, p.kg]), [['2026-10-20', 80], ['2026-10-21', 80.4], ['2026-10-23', 79.8], ['2026-10-28', 79]]);
  assert.equal(series[2].trend.toFixed(2), '80.07');
  assert.equal(series[3].trend.toFixed(2), '79.40'); // 22–28 Oct holds 79.8 and 79.0
  const html = app.html();
  assert.match(html, /Body weight trend/);
  assert.match(html, /<small>LATEST<\/small><strong>79\.0 kg<\/strong>/);
  assert.match(html, /<small>7-DAY AVERAGE<\/small><strong>79\.4 kg<\/strong>/);
  assert.match(html, /<small>LAST 7 DAYS<\/small><strong>−0\.8 kg<\/strong>/); // 79.4 vs 80.2 on 21 Oct
  assert.match(html, /<small>SINCE START<\/small><strong>−0\.6 kg<\/strong>/);
  assert.match(html, /class="weight-trend" d="M12\.0 /);
  assert.equal((html.match(/class="weight-dot/g) || []).length, 4);
  assert.match(html, /4 WEIGH-INS/);
});

test('the weight trend explains itself before there is data and appears in the journal', async () => {
  const empty = await createApp('2026-10-21', '#progress');
  assert.match(empty.html(), /Log your body weight in the Daily journal/);
  assert.doesNotMatch(empty.html(), /class="weight-chart"/);
  const journal = await createApp('2026-10-21', '#journal', { sets: [], cardio: [], notes: [], checkins: [checkin('2026-10-21', '70.2')] });
  assert.match(journal.html(), /Body weight trend/);
  assert.match(journal.html(), /<small>LAST 7 DAYS<\/small><strong>–<\/strong><span>Needs 8 days of weigh-ins<\/span>/);
  assert.match(journal.html(), /class="weight-dot latest"/);
});
