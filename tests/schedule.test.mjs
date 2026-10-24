import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  dayKey,
  buildDailyPlan,
  canDeliver,
  nextDayTimestamp,
} from '../extension/core/schedule.mjs';

const MINUTE = 60_000;
const monday = Date.parse('2026-10-26T07:00:00Z');
const enabled = (overrides = {}) => normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, ...overrides });
const romeMinute = (timestamp) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const part = (type) => Number(parts.find((value) => value.type === type).value);
  return part('hour') * 60 + part('minute');
};

test('default: quattro pillole feriali, fasce concordate e automazione spenta', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_SETTINGS.timeZone, 'Europe/Rome');
  assert.deepEqual(DEFAULT_SETTINGS.windows, [
    { start: '09:30', end: '12:30', count: 2 },
    { start: '14:30', end: '17:30', count: 2 },
  ]);
});

test('normalizzazione non modifica input e mantiene copie indipendenti', () => {
  const input = {
    enabled: true,
    timeZone: 'Europe/Rome',
    windows: DEFAULT_SETTINGS.windows.map((window) => ({ ...window })),
    excludeFolders: ['Tech News', 'Tech News', 'Ollama/Guide'],
  };
  const before = JSON.stringify(input);
  const normalized = normalizeSettings(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(normalized.excludeFolders, ['Tech News', 'Ollama/Guide']);
  normalized.windows[0].count = 1;
  assert.equal(input.windows[0].count, 2);
});

test('impostazioni invalide: timezone, booleani, count, ore, overlap e traversal', () => {
  const badInputs = [
    { enabled: 'false' },
    { timeZone: 'Not/A-Time-Zone' },
    { windows: [{ start: '09:30', end: '12:30', count: 0 }, DEFAULT_SETTINGS.windows[1]] },
    { windows: [{ start: '09:30', end: '12:30', count: 1.5 }, DEFAULT_SETTINGS.windows[1]] },
    { windows: [{ start: '9:30', end: '12:30', count: 2 }, DEFAULT_SETTINGS.windows[1]] },
    { windows: [{ start: '09:30', end: '10:00', count: 2 }, DEFAULT_SETTINGS.windows[1]] },
    { windows: [{ start: '09:30', end: '15:00', count: 2 }, DEFAULT_SETTINGS.windows[1]] },
    { windows: [DEFAULT_SETTINGS.windows[0]] },
    { excludeFolders: ['../Private'] },
    { excludeFolders: ['/tmp/notes'] },
    { excludeFolders: ['Ollama/../../Private'] },
    { excludeFolders: ['C:\\Private'] },
  ];
  for (const input of badInputs) assert.throws(() => normalizeSettings(input), JSON.stringify(input));
});

test('data nel fuso del prodotto, indipendente dal giorno UTC', () => {
  assert.equal(dayKey(Date.parse('2026-10-25T23:30:00Z'), 'Europe/Rome'), '2026-10-26');
  assert.equal(dayKey(Date.parse('2026-10-25T23:30:00Z'), 'America/New_York'), '2026-10-25');
});

test('piano feriale: due slot per fascia, id stabili, orari separati e interni', () => {
  const plan = buildDailyPlan(monday, enabled(), () => 0.5);
  assert.equal(plan.date, '2026-10-26');
  assert.equal(plan.slots.length, 4);
  assert.deepEqual(plan.slots.map((slot) => slot.id), [
    '2026-10-26:0:0', '2026-10-26:0:1', '2026-10-26:1:0', '2026-10-26:1:1',
  ]);
  assert.deepEqual(plan.slots.map((slot) => slot.windowIndex), [0, 0, 1, 1]);
  assert.equal(new Set(plan.slots.map((slot) => slot.when)).size, 4);
  for (const slot of plan.slots) {
    assert.ok(slot.when > slot.start && slot.when < slot.end);
    const minute = romeMinute(slot.when);
    assert.ok(slot.windowIndex === 0 ? minute >= 570 && minute < 750 : minute >= 870 && minute < 1050);
  }
  assert.deepEqual(plan, buildDailyPlan(monday, enabled(), () => 0.5));
});

test('i sorteggi estremi restano nel proprio sottointervallo', () => {
  for (const draw of [0, 0.999999]) {
    const plan = buildDailyPlan(monday, enabled(), () => draw);
    for (const [index, slot] of plan.slots.entries()) {
      const partIndex = index % 2;
      const midpoint = slot.start + (slot.end - slot.start) / 2;
      assert.ok(partIndex === 0 ? slot.when < midpoint : slot.when >= midpoint);
      assert.ok(slot.when > slot.start && slot.when < slot.end);
    }
  }
});

test('sabato e domenica non hanno slot automatici', () => {
  for (const date of ['2026-10-24T10:00:00Z', '2026-10-25T10:00:00Z']) {
    assert.deepEqual(buildDailyPlan(Date.parse(date), enabled(), () => 0.5).slots, []);
  }
});

test('consegna ammessa solo nello slot, enabled e prima di dieci minuti di ritardo', () => {
  const settings = enabled();
  const slot = buildDailyPlan(monday, settings, () => 0.5).slots[0];
  assert.equal(canDeliver(slot, slot.when - 1, settings), false);
  assert.equal(canDeliver(slot, slot.when, settings), true);
  assert.equal(canDeliver(slot, slot.when + 10 * MINUTE, settings), true);
  assert.equal(canDeliver(slot, slot.when + 10 * MINUTE + 1, settings), false);
  assert.equal(canDeliver(slot, slot.when, { ...settings, enabled: false }), false);
  assert.equal(canDeliver(slot, slot.when, settings, [slot.id]), false);
});

test('uno slot scaduto, fuori fascia o di un altro giorno non viene recuperato', () => {
  const settings = enabled();
  const slot = buildDailyPlan(monday, settings, () => 0.999999).slots[1];
  assert.equal(canDeliver(slot, slot.end, settings), false);
  assert.equal(canDeliver(slot, slot.when + 24 * 60 * MINUTE, settings), false);
  assert.equal(canDeliver({ ...slot, id: '2026-10-24:0:0' }, slot.when, settings), false);
});

test('ridurre la quota o spostare la fascia non autorizza slot precedenti', () => {
  const settings = enabled();
  const second = buildDailyPlan(monday, settings, () => 0.5).slots[1];
  const lowerQuota = enabled({ windows: [{ ...settings.windows[0], count: 1 }, settings.windows[1]] });
  assert.equal(canDeliver(second, second.when, lowerQuota), false);
  const movedWindow = enabled({ windows: [{ start: '10:00', end: '11:00', count: 2 }, settings.windows[1]] });
  assert.equal(canDeliver(second, second.when, movedWindow), false);
});

test('slot corrotti e indici inesistenti vengono rifiutati', () => {
  const settings = enabled();
  const slot = buildDailyPlan(monday, settings, () => 0.5).slots[0];
  for (const altered of [
    null,
    { ...slot, when: Number.NaN },
    { ...slot, id: 'bad-id' },
    { ...slot, id: '2026-10-26:99:0', windowIndex: 99 },
    { ...slot, when: slot.end },
    { ...slot, windowIndex: 1 },
  ]) assert.equal(canDeliver(altered, slot.when, settings), false);
});

test('gli orari lavorativi restano locali prima e dopo il cambio DST', () => {
  const settings = enabled();
  const before = buildDailyPlan(Date.parse('2026-03-27T06:00:00Z'), settings, () => 0.5);
  const after = buildDailyPlan(Date.parse('2026-03-30T06:00:00Z'), settings, () => 0.5);
  assert.deepEqual(before.slots.map((slot) => romeMinute(slot.when)), after.slots.map((slot) => romeMinute(slot.when)));
  assert.equal(new Date(before.slots[0].start).toISOString(), '2026-03-27T08:30:00.000Z');
  assert.equal(new Date(after.slots[0].start).toISOString(), '2026-03-30T07:30:00.000Z');
});

test('rinnovo giornaliero attraversa correttamente i giorni da 23 e 25 ore', () => {
  assert.equal(
    new Date(nextDayTimestamp(Date.parse('2026-03-28T23:30:00Z'), 'Europe/Rome')).toISOString(),
    '2026-03-29T22:01:00.000Z',
  );
  assert.equal(
    new Date(nextDayTimestamp(Date.parse('2026-10-24T22:30:00Z'), 'Europe/Rome')).toISOString(),
    '2026-10-25T23:01:00.000Z',
  );
});

test('il fuso locale del processo non altera il piano Europe/Rome', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const first = buildDailyPlan(monday, enabled(), () => 0.5);
    process.env.TZ = 'Asia/Tokyo';
    const second = buildDailyPlan(monday, enabled(), () => 0.5);
    assert.deepEqual(first, second);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
