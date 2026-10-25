import { normalizeSettings, buildDailyPlan, canDeliver, dayKey, nextDayTimestamp } from './core/schedule.mjs';
import { readState, mutateState, recordError, validPill } from './core/state.mjs';
import { nativeRequest } from './core/native.mjs';
import { getVaultHandle, scanVault, chooseNotes } from './core/vault.mjs';

const TARGET = 12;
const LOW = 4;
const PREFIX = 'pillole:';
const REFRESH = `${PREFIX}refresh`;
const DAY = `${PREFIX}day`;
let refillPromise = null;
let schedulePromise = Promise.resolve();

function excludePath(path, folders) {
  return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

function keepNotification(state, id, pill, test) {
  state.notificationMap[id] = { pill, test, createdAt: Date.now() };
  const recent = Object.entries(state.notificationMap).sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0)).slice(0, 40);
  state.notificationMap = Object.fromEntries(recent);
}

function configKey(settings) {
  return JSON.stringify({ timeZone: settings.timeZone, windows: settings.windows });
}

async function doRefreshSchedule(force = false, skipPast = false) {
  const now = Date.now();
  const planInfo = await mutateState((state) => {
    const date = dayKey(now, state.settings.timeZone);
    if (!state.dailyPlan || state.dailyPlan.date !== date || force || state.dailyPlan.configKey !== configKey(state.settings)) {
      state.dailyPlan = { ...buildDailyPlan(now, state.settings), configKey: configKey(state.settings) };
    }
    // Reopening Edge or changing settings never recovers notifications from the past.
    for (const slot of state.dailyPlan.slots) {
      if (((skipPast && slot.when <= now) || slot.when + 10 * 60_000 < now) && !state.completed.includes(slot.id)) state.completed.push(slot.id);
    }
    state.completed = [...new Set(state.completed)].filter((id) => id.startsWith(`${date}:`));
    return { settings: state.settings, plan: state.dailyPlan, completed: state.completed };
  });
  const existing = await chrome.alarms.getAll();
  const wanted = new Map(planInfo.settings.enabled ? planInfo.plan.slots.filter((slot) => !planInfo.completed.includes(slot.id) && slot.when + 10 * 60_000 >= now).map((slot) => [`${PREFIX}slot:${slot.id}`, slot]) : []);
  for (const alarm of existing.filter((item) => item.name.startsWith(`${PREFIX}slot:`))) {
    if (!wanted.has(alarm.name)) await chrome.alarms.clear(alarm.name);
  }
  for (const [name, slot] of wanted) {
    const alarm = existing.find((item) => item.name === name);
    if (slot.when > now && (!alarm || alarm.scheduledTime !== slot.when)) await chrome.alarms.create(name, { when: slot.when });
  }
  await chrome.alarms.create(DAY, { when: nextDayTimestamp(now, planInfo.settings.timeZone) });
  await chrome.alarms.create(REFRESH, { periodInMinutes: 30 });
}

function refreshSchedule(force = false, skipPast = false) {
  const result = schedulePromise.then(() => doRefreshSchedule(force, skipPast));
  schedulePromise = result.catch(() => {});
  return result;
}

async function checkHost() {
  const host = await nativeRequest('status');
  if (host.version !== 1 || typeof host.vaultPath !== 'string' || typeof host.codexPath !== 'string' || typeof host.vaultAvailable !== 'boolean' || typeof host.codexAvailable !== 'boolean') throw new Error('Il ponte locale usa un formato non riconosciuto.');
  await mutateState((state) => { state.host = { ...host, checkedAt: new Date().toISOString() }; state.lastError = null; });
  return host;
}

async function browserCatalog() {
  const current = await readState();
  const host = current.host || await checkHost();
  if (host.browserNotes !== true) throw new Error('Aggiorna il ponte con l’installer e --force, poi premi Controlla il ponte.');
  const handle = await getVaultHandle();
  if (!handle) throw new Error('Apri Impostazioni e scegli “Collega il vault” prima di preparare la scorta.');
  const expectedName = host.vaultPath.split('/').filter(Boolean).at(-1);
  if (handle.name !== expectedName) throw new Error(`Seleziona lo stesso vault configurato nel ponte: ${host.vaultPath}`);
  const notes = await scanVault(handle, current.settings.excludeFolders);
  await mutateState((state) => {
    state.vault = { name: handle.name, count: notes.length, scannedAt: new Date().toISOString() };
    state.lastError = null;
  });
  return notes;
}

async function refillStock(manual) {
  const before = await readState();
  if (!manual && (!before.settings.enabled || before.queue.length > LOW || before.retryAfter > Date.now())) return;
  await mutateState((state) => { state.refillStartedAt = new Date().toISOString(); });
  try {
    await checkHost();
    const notes = await browserCatalog();
    const hashes = new Map(notes.map((note) => [note.id, note.hash]));
    await mutateState((state) => {
      state.queue = state.queue.filter((pill) => hashes.get(pill.sourceId) === pill.sourceHash && !excludePath(pill.sourcePath, state.settings.excludeFolders));
    });
    for (let batch = 0; batch < 3; batch += 1) {
      const state = await readState();
      if (state.queue.length >= TARGET || (!manual && !state.settings.enabled)) break;
      const excludeNoteIds = [...new Set([...state.queue.map((pill) => pill.sourceId), ...state.history.slice(0, 20).map((pill) => pill.sourceId)])];
      const candidates = notes.filter((note) => !excludePath(note.path, state.settings.excludeFolders));
      const selected = chooseNotes(candidates, excludeNoteIds, Math.min(4, TARGET - state.queue.length));
      if (!selected.length) throw new Error('Nessuna nuova nota adatta: controlla le esclusioni e le note già in scorta o mostrate di recente.');
      const result = await nativeRequest('generate', {
        count: selected.length,
        excludeFolders: state.settings.excludeFolders,
        excludeNoteIds,
        notes: selected.map(({ path, hash, text }) => ({ path, hash, text })),
      });
      if (!Array.isArray(result.pills) || !result.pills.length || result.pills.length > 4 || !result.pills.every(validPill)) throw new Error('Codex ha prodotto pillole con un formato non valido.');
      const sourceIds = result.pills.map((pill) => pill.sourceId);
      if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some((id) => excludeNoteIds.includes(id))) throw new Error('Il ponte ha restituito fonti duplicate o già escluse.');
      const appended = await mutateState((live) => {
        const unavailable = new Set([...live.queue.map((pill) => pill.sourceId), ...live.history.slice(0, 20).map((pill) => pill.sourceId)]);
        const fresh = result.pills.filter((pill) => !unavailable.has(pill.sourceId) && !excludePath(pill.sourcePath, live.settings.excludeFolders)).slice(0, TARGET - live.queue.length);
        live.queue.push(...fresh);
        live.lastRefillAt = new Date().toISOString();
        live.lastError = null;
        live.retryAfter = 0;
        return fresh.length;
      });
      if (!appended) break;
    }
  } catch (error) {
    await recordError(error, true);
    throw error;
  } finally {
    await mutateState((state) => { state.refillStartedAt = null; });
  }
}

function requestRefill(manual = false) {
  if (refillPromise) return refillPromise;
  refillPromise = refillStock(manual).finally(() => { refillPromise = null; });
  return refillPromise;
}

function autoRefill() {
  void requestRefill(false).catch(() => {});
}

async function notificationPermission() {
  if (await chrome.notifications.getPermissionLevel() !== 'granted') {
    throw new Error('Le notifiche di Edge non sono consentite. Controlla Edge e Impostazioni di Sistema → Notifiche → Microsoft Edge.');
  }
}

function showNotification(id, pill, test) {
  return chrome.notifications.create(id, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${test ? 'Prova · ' : ''}${pill.title}`,
    message: pill.summary.length > 230 ? `${pill.summary.slice(0, 227)}…` : pill.summary,
    contextMessage: 'Pillole dal vault · apri per approfondire', priority: 0,
  });
}

async function testNotification() {
  await notificationPermission();
  const state = await readState();
  const pill = state.queue[0];
  if (!pill) throw new Error('La scorta è vuota. Apri Pillole e scegli “Prepara scorta” prima di inviare una prova.');
  const id = `pv-test-${crypto.randomUUID()}`;
  await mutateState((live) => { keepNotification(live, id, pill, true); });
  try { await showNotification(id, pill, true); }
  catch (error) {
    await mutateState((live) => { delete live.notificationMap[id]; });
    throw new Error('La notifica non è stata creata. Controlla i permessi di Edge nelle impostazioni di macOS.');
  }
  return { notificationId: id };
}

async function deliverSlot(slotId) {
  const state = await readState();
  const slot = state.dailyPlan?.slots.find((item) => item.id === slotId);
  if (!canDeliver(slot, Date.now(), state.settings, state.completed)) {
    await mutateState((live) => { if (!live.completed.includes(slotId)) live.completed.push(slotId); });
    return;
  }
  try { await notificationPermission(); }
  catch (error) {
    await mutateState((live) => { if (!live.completed.includes(slotId)) live.completed.push(slotId); });
    await recordError(error);
    return;
  }
  const reservation = await mutateState((live) => {
    const activeSlot = live.dailyPlan?.slots.find((item) => item.id === slotId);
    if (!canDeliver(activeSlot, Date.now(), live.settings, live.completed)) return { skipped: true };
    live.completed.push(slotId);
    const pill = live.queue.shift();
    if (!pill) {
      live.lastError = { message: 'Uno slot è stato saltato perché la scorta era vuota. Il prossimo invio userà la scorta rifornita.', at: new Date().toISOString() };
      return { empty: true };
    }
    const notificationId = `pv-${slotId}`;
    keepNotification(live, notificationId, pill, false);
    return { pill, notificationId };
  });
  if (!reservation.pill) { if (reservation.empty) autoRefill(); return; }
  try {
    await showNotification(reservation.notificationId, reservation.pill, false);
    await mutateState((live) => {
      live.history.unshift({ ...reservation.pill, deliveredAt: new Date().toISOString() });
      live.history = live.history.slice(0, 100);
    });
  } catch {
    await mutateState((live) => {
      if (!live.queue.some((pill) => pill.id === reservation.pill.id)) live.queue = [reservation.pill, ...live.queue].slice(0, TARGET);
      delete live.notificationMap[reservation.notificationId];
      live.lastError = { message: 'Notifica non creata. La pillola è tornata nella scorta e lo slot è stato saltato.', at: new Date().toISOString() };
    });
  }
  autoRefill();
}

async function openApp(pillId = null) {
  const query = pillId ? `?pill=${encodeURIComponent(pillId)}` : '';
  await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html${query}`) });
}

async function snapshot() {
  const state = await readState();
  return { ...state, refilling: Boolean(refillPromise), extensionId: chrome.runtime.id };
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.action !== 'string') throw new Error('Richiesta non valida.');
  switch (message.action) {
    case 'getState': return snapshot();
    case 'checkHost': return checkHost();
    case 'indexVault': await checkHost(); await browserCatalog(); return snapshot();
    case 'refill': await requestRefill(true); return snapshot();
    case 'testNotification': return testNotification();
    case 'saveSettings': {
      const settings = normalizeSettings(message.settings);
      await mutateState((state) => {
        state.settings = settings;
        state.queue = state.queue.filter((pill) => !excludePath(pill.sourcePath, settings.excludeFolders));
      });
      await refreshSchedule(true, true);
      autoRefill();
      return snapshot();
    }
    case 'dismissError': await mutateState((state) => { state.lastError = null; }); return snapshot();
    case 'openApp': await openApp(); return {};
    case 'openPill': {
      const state = await readState();
      const id = message.id;
      if (typeof id !== 'string' || ![...state.queue, ...state.history, ...Object.values(state.notificationMap).map((item) => item.pill)].some((pill) => pill?.id === id)) throw new Error('La pillola non è più disponibile.');
      await openApp(id);
      return {};
    }
    default: throw new Error('Operazione non riconosciuta.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const allowed = sender.id === chrome.runtime.id && typeof sender.url === 'string' && [chrome.runtime.getURL('app.html'), chrome.runtime.getURL('popup.html')].some((url) => sender.url === url || sender.url.startsWith(`${url}?`));
  if (!allowed) { sendResponse({ ok: false, error: 'Richiesta non autorizzata.' }); return false; }
  handleMessage(message).then((result) => sendResponse({ ok: true, result })).catch(async (error) => {
    await recordError(error).catch(() => {});
    sendResponse({ ok: false, error: error?.message || 'Operazione non riuscita.' });
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name.startsWith(`${PREFIX}slot:`)) {
      await deliverSlot(alarm.name.slice(`${PREFIX}slot:`.length));
      await refreshSchedule();
    } else if (alarm.name === DAY || alarm.name === REFRESH) {
      await refreshSchedule();
      autoRefill();
    }
  })().catch((error) => { void recordError(error); });
});

chrome.notifications.onClicked.addListener((id) => {
  void (async () => {
    const state = await readState();
    const record = state.notificationMap[id];
    if (record?.pill && validPill(record.pill)) await openApp(record.pill.id);
    await chrome.notifications.clear(id);
  })().catch((error) => { void recordError(error); });
});

async function initialize() {
  await mutateState((state) => { state.refillStartedAt = null; });
  await refreshSchedule(false, true);
  autoRefill();
}
chrome.runtime.onInstalled.addListener(() => { void initialize().catch((error) => { void recordError(error); }); });
chrome.runtime.onStartup.addListener(() => { void initialize().catch((error) => { void recordError(error); }); });
