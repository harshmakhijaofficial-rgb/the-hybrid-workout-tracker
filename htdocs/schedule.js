/* Calendar-day arithmetic keeps the training cycle stable across clock changes. */
(function (global) {
  'use strict';
  const DAY_MS = 86400000;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mod = (value, base) => ((value % base) + base) % base;
  function ordinal(iso) {
    if (typeof iso !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(iso)) throw Error('Enter a valid calendar date.');
    const millis = Date.parse(iso + 'T00:00:00Z');
    if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== iso) throw Error('Enter a valid calendar date.');
    return Math.floor(millis / DAY_MS);
  }
  const isoFrom = day => new Date(day * DAY_MS).toISOString().slice(0, 10);
  const addDays = (iso, days) => isoFrom(ordinal(iso) + days);
  const dayFor = iso => DAYS[mod(ordinal(iso) + 4, 7)];
  function cycleStart(plan, iso) { return isoFrom(ordinal(iso) - mod(ordinal(iso) - ordinal(plan.start_date), 7)); }
  function cycleDates(plan, iso) { const start = cycleStart(plan, iso); return Array.from({length: 7}, (_, offset) => addDays(start, offset)); }
  function dateForDay(plan, iso, day) {
    if (!DAYS.includes(day)) throw Error('Unknown weekday.');
    const start = cycleStart(plan, iso);
    return addDays(start, mod(DAYS.indexOf(day) - DAYS.indexOf(dayFor(start)), 7));
  }
  const weekDates = (plan, iso) => plan.days.map(day => dateForDay(plan, iso, day.day));
  const weekOf = (plan, iso) => Math.min(4, Math.max(1, Math.floor((ordinal(iso) - ordinal(plan.start_date)) / 7) + 1));
  const sessionFor = (plan, iso) => plan.days.find(day => day.day === dayFor(iso)) || null;
  function nextSession(plan, iso) {
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(iso, offset), day = sessionFor(plan, date);
      if (day) return {date, day};
    }
    throw Error('The plan has no scheduled training days.');
  }
  global.HybridSchedule = Object.freeze({dayFor, addDays, cycleStart, cycleDates, dateForDay, weekDates, weekOf, sessionFor, nextSession});
})(window);
