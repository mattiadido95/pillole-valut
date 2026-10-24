import { normalizeSettings } from './schedule.mjs';

const KEY = 'pilloleVaultStateV1';
let pending = Promise.resolve();

export function emptyState() {
  return {
    version: 1, settings: normalizeSettings(), queue: [], history: [], dailyPlan: null,
    completed: [], notificationMap: {}, host: null, lastError: null, retryAfter: 0,
    lastRefillAt: null, refillStartedAt: null,
  };
}

export function validPill(pill) {
  if (!pill || typeof pill !== 'object') return false;
  const bounds = { id: 120, sourceId: 120, sourcePath: 2000, sourceTitle: 500, sourceHash: 128, sourceUrl: 5000, title: 120, summary: 1600, example: 1000, createdAt: 100 };
  if (!Object.entries(bounds).every(([key, limit]) => typeof pill[key] === 'string' && pill[key].length <= limit && (key === 'example' || pill[key].trim()))) return false;
  try {
    const url = new URL(pill.sourceUrl);
    return url.protocol === 'obsidian:' && url.hostname === 'open' && url.searchParams.get('path')?.startsWith('/') && !url.username && !url.password && !url.hash && Number.isFinite(Date.parse(pill.createdAt));
  } catch { return false; }
}

export async function readState() {
  const saved = (await chrome.storage.local.get(KEY))[KEY];
  const state = { ...emptyState(), ...(saved?.version === 1 ? saved : {}) };
  try { state.settings = normalizeSettings(state.settings); }
  catch { state.settings = normalizeSettings(); state.lastError = { message: 'Le impostazioni salvate non erano valide: gli invii sono stati messi in pausa.', at: new Date().toISOString() }; }
  state.queue = Array.isArray(state.queue) ? state.queue.filter(validPill).slice(0, 12) : [];
  state.history = Array.isArray(state.history) ? state.history.filter(validPill).slice(0, 100) : [];
  state.completed = Array.isArray(state.completed) ? [...new Set(state.completed.filter((id) => typeof id === 'string'))].slice(-40) : [];
  if (!state.notificationMap || typeof state.notificationMap !== 'object' || Array.isArray(state.notificationMap)) state.notificationMap = {};
  return state;
}

export function mutateState(change) {
  const operation = pending.then(async () => {
    const state = await readState();
    const result = await change(state);
    await chrome.storage.local.set({ [KEY]: state });
    return result ?? state;
  });
  pending = operation.catch(() => {});
  return operation;
}

export async function recordError(error, retry = false) {
  return mutateState((state) => {
    state.lastError = { message: error?.message || 'Si è verificato un errore inatteso.', at: new Date().toISOString() };
    if (retry) state.retryAfter = Date.now() + 60 * 60_000;
  });
}
