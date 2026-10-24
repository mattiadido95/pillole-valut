const MINUTE = 60_000;
const formatters = new Map();

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  timeZone: 'Europe/Rome',
  windows: Object.freeze([
    Object.freeze({ start: '09:30', end: '12:30', count: 2 }),
    Object.freeze({ start: '14:30', end: '17:30', count: 2 }),
  ]),
  excludeFolders: Object.freeze(['Tech News', 'Attualità e Politica']),
});

function minutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('Usa orari nel formato HH:mm, tra 00:00 e 23:59.');
  }
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Impostazioni non valide.');
  const enabled = input.enabled === undefined ? DEFAULT_SETTINGS.enabled : input.enabled;
  if (typeof enabled !== 'boolean') throw new Error('Lo stato di attivazione deve essere sì o no.');
  const timeZone = input.timeZone === undefined ? DEFAULT_SETTINGS.timeZone : input.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error('Fuso orario non valido.');
  try { new Intl.DateTimeFormat('it', { timeZone }).format(0); }
  catch { throw new Error('Il fuso orario non è riconosciuto. Usa per esempio Europe/Rome.'); }
  const rawWindows = input.windows === undefined ? DEFAULT_SETTINGS.windows : input.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length !== 2) throw new Error('Sono richieste due fasce orarie.');
  const windows = rawWindows.map((window) => {
    if (!window || typeof window !== 'object') throw new Error('Fascia oraria non valida.');
    const start = minutes(window.start);
    const end = minutes(window.end);
    if (!Number.isInteger(window.count) || window.count < 1 || window.count > 4) {
      throw new Error('Scegli da 1 a 4 pillole per fascia.');
    }
    if (end <= start || end - start < window.count * 30) {
      throw new Error('Ogni pillola richiede almeno 30 minuti nella propria fascia.');
    }
    return { start: window.start, end: window.end, count: window.count };
  });
  if (minutes(windows[0].end) > minutes(windows[1].start)) throw new Error('Le fasce devono essere ordinate e non sovrapposte.');
  const rawFolders = input.excludeFolders === undefined ? DEFAULT_SETTINGS.excludeFolders : input.excludeFolders;
  if (!Array.isArray(rawFolders) || rawFolders.length > 100) throw new Error('Sono consentite al massimo 100 esclusioni.');
  const excludeFolders = [...new Set(rawFolders.map((folder) => {
    if (typeof folder !== 'string' || folder.length > 500) throw new Error('Cartella esclusa non valida.');
    const clean = folder.trim().replaceAll('\\', '/').replace(/\/$/, '');
    if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) || /[\x00-\x1f]/.test(clean)) {
      throw new Error('Le esclusioni devono essere cartelle relative al vault, senza “..”.');
    }
    return clean;
  }))];
  return { enabled, timeZone, windows, excludeFolders };
}

function parts(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) throw new Error('Data non valida.');
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  const entries = formatters.get(timeZone).formatToParts(new Date(timestamp));
  return Object.fromEntries(entries.filter((entry) => entry.type !== 'literal').map((entry) => [entry.type, Number(entry.value)]));
}

function localEpoch(year, month, day, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = parts(candidate, timeZone);
    const projected = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = target - projected;
    candidate += correction;
    if (!correction) return candidate;
  }
  throw new Error('L’orario scelto non esiste nel giorno e nel fuso indicati.');
}

export function dayKey(timestampMs, timeZone) {
  const value = parts(timestampMs, timeZone);
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function isWeekday(value) {
  const day = new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
  return day !== 0 && day !== 6;
}

export function buildDailyPlan(nowMs, input, random = Math.random) {
  const settings = normalizeSettings(input);
  const value = parts(nowMs, settings.timeZone);
  const date = dayKey(nowMs, settings.timeZone);
  if (!isWeekday(value)) return { date, slots: [] };
  const slots = [];
  settings.windows.forEach((window, windowIndex) => {
    const start = localEpoch(value.year, value.month, value.day, minutes(window.start), settings.timeZone);
    const end = localEpoch(value.year, value.month, value.day, minutes(window.end), settings.timeZone);
    const segmentLength = (end - start) / window.count;
    const margin = Math.min(5 * MINUTE, segmentLength / 4);
    for (let index = 0; index < window.count; index += 1) {
      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Il generatore casuale deve restituire un valore tra 0 incluso e 1 escluso.');
      const when = Math.floor(start + index * segmentLength + margin + draw * (segmentLength - 2 * margin));
      slots.push({ id: `${date}:${windowIndex}:${index}`, windowIndex, when, start, end });
    }
  });
  return { date, slots };
}

export function canDeliver(slot, nowMs, input, completedIds = []) {
  try {
    const settings = normalizeSettings(input);
    if (!settings.enabled || !slot || !Number.isFinite(nowMs) || !Array.isArray(completedIds) || completedIds.includes(slot.id)) return false;
    const value = parts(nowMs, settings.timeZone);
    if (!isWeekday(value)) return false;
    const match = /^(\d{4}-\d{2}-\d{2}):(\d+):(\d+)$/.exec(slot.id);
    if (!match || match[1] !== dayKey(nowMs, settings.timeZone)) return false;
    const windowIndex = Number(match[2]);
    const index = Number(match[3]);
    if (windowIndex !== slot.windowIndex || !Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex >= settings.windows.length) return false;
    const window = settings.windows[windowIndex];
    if (index >= window.count || index < 0) return false;
    const usedInWindow = new Set(completedIds.filter((id) => typeof id === 'string' && id.startsWith(`${match[1]}:${windowIndex}:`))).size;
    if (usedInWindow >= window.count) return false;
    if (![slot.when, slot.start, slot.end].every(Number.isFinite) || slot.when < slot.start || slot.when >= slot.end) return false;
    const minute = value.hour * 60 + value.minute;
    return nowMs >= slot.when && nowMs <= slot.when + 10 * MINUTE && nowMs >= slot.start && nowMs < slot.end && minute >= minutes(window.start) && minute < minutes(window.end);
  } catch { return false; }
}

export function nextDayTimestamp(nowMs, timeZone) {
  const value = parts(nowMs, timeZone);
  const tomorrow = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return localEpoch(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 1, timeZone);
}
