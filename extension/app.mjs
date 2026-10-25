import { send, dateLabel, nextSlot, notice } from './ui.mjs';
import { normalizeSettings } from './core/schedule.mjs';
import { validPill } from './core/state.mjs';
import { saveVaultHandle } from './core/vault.mjs';

const $ = (id) => document.getElementById(id);
let latest = null;
let formDirty = false;
let firstRender = true;
let busy = false;
let currentView = new URL(location.href).searchParams.get('view') === 'settings' ? 'settings' : 'stock';
let selectedId = new URL(location.href).searchParams.get('pill');
let lastListKey = '';
const titles = {
  stock: ['LA TUA BIBLIOTECA TASCABILE', 'Un’idea, ogni tanto.', 'Piccoli concetti dalle tue note. Uno spunto, un esempio, la libertà di approfondire.'],
  history: ['UNA TRACCIA LEGGERA', 'Ci siamo già incontrati.', 'Ritrova un concetto che ti aveva incuriosito. Nessun arretrato, nessuna scadenza.'],
  settings: ['IL TUO VAULT, IL TUO RITMO', 'Fai spazio alle idee.', 'Un collegamento locale alle tue note e quattro piccole occasioni durante la giornata.'],
};
function switchView(view) {
  currentView = view;
  for (const id of ['stock', 'history', 'settings']) $(`${id}-view`).hidden = id !== view;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const [eyebrow, title, description] = titles[view];
  $('section-eyebrow').textContent = eyebrow;
  $('page-title').textContent = title;
  $('page-description').textContent = description;
}

function showPill(pill) {
  if (!validPill(pill)) { notice('Questa pillola non è disponibile o ha un formato non valido.', true); return; }
  $('pill-title').textContent = pill.title;
  $('pill-summary').textContent = pill.summary;
  $('pill-example').textContent = pill.example;
  $('example-section').hidden = !pill.example.trim();
  $('pill-source').textContent = pill.sourceTitle;
  $('pill-date').textContent = `${pill.sourcePath} · Preparata il ${dateLabel(pill.createdAt, latest?.settings.timeZone)}`;
  $('open-source').href = pill.sourceUrl;
  if (!$('pill-dialog').open) $('pill-dialog').showModal();
}

function buildCard(pill, index, history) {
  const button = document.createElement('button');
  button.className = 'pill-card';
  const top = document.createElement('div');
  top.className = 'card-top';
  const number = document.createElement('span');
  number.className = 'card-number';
  number.textContent = String(index + 1).padStart(2, '0');
  const tag = document.createElement('span');
  tag.className = 'card-source';
  tag.textContent = pill.sourcePath.split('/')[0];
  top.append(number, tag);
  const title = document.createElement('h3'); title.textContent = pill.title;
  const summary = document.createElement('p'); summary.textContent = pill.summary;
  const bottom = document.createElement('div'); bottom.className = 'card-bottom';
  const hint = document.createElement('span'); hint.textContent = history ? dateLabel(pill.deliveredAt || pill.createdAt, latest.settings.timeZone) : 'Un minuto di curiosità';
  const arrow = document.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
  bottom.append(hint, arrow); button.append(top, title, summary, bottom);
  button.addEventListener('click', () => showPill(pill));
  return button;
}

function fillSettings(settings) {
  $('enabled').checked = settings.enabled;
  $('timezone').value = settings.timeZone;
  settings.windows.forEach((window, index) => {
    $(`start-${index}`).value = window.start;
    $(`end-${index}`).value = window.end;
    $(`count-${index}`).value = window.count;
  });
  $('exclusions').value = settings.excludeFolders.join('\n');
}

function render(state) {
  latest = state;
  $('stock-number').replaceChildren(document.createTextNode(String(state.queue.length)), Object.assign(document.createElement('span'), { textContent: '/12' }));
  $('nav-stock').textContent = state.queue.length;
  $('stock-hint').textContent = state.refilling ? 'La scorta si sta riempiendo…' : state.queue.length ? 'Pronte anche quando Codex non è disponibile' : 'Prepara la prima scorta con Codex CLI';
  const next = nextSlot(state);
  $('next-time').textContent = !state.settings.enabled ? 'In pausa' : next ? new Intl.DateTimeFormat('it-IT', { timeZone: state.settings.timeZone, hour: '2-digit', minute: '2-digit' }).format(next.when) : 'Il prossimo feriale';
  $('next-hint').textContent = !state.settings.enabled ? 'Attiva gli invii dalle impostazioni' : next ? `${dateLabel(next.when, state.settings.timeZone)} · ${state.settings.timeZone}` : `Gli slot passati non vengono recuperati · ${state.settings.timeZone}`;
  const total = state.settings.windows.reduce((count, window) => count + window.count, 0);
  $('daily-number').replaceChildren(document.createTextNode(String(total)), Object.assign(document.createElement('span'), { textContent: 'al giorno' }));
  $('windows-label').textContent = state.settings.windows.map((window) => `${window.count} tra ${window.start} e ${window.end}`).join(' · ');
  $('generation').hidden = !state.refilling;
  $('refill').disabled = busy || state.refilling;
  $('refill').textContent = state.refilling ? 'Preparazione in corso…' : state.queue.length >= 12 ? 'Aggiorna scorta' : 'Prepara scorta ✦';
  $('test').disabled = !state.queue.length || busy;
  $('check-host').disabled = busy || state.refilling;
  $('connect-vault').disabled = busy || state.refilling || !state.host;
  $('connect-vault').textContent = state.vault ? 'Ricollega il vault' : 'Collega il vault';
  $('vault-connection').textContent = state.vault ? `${state.vault.name}: ${state.vault.count} note leggibili · aggiornato ${dateLabel(state.vault.scannedAt, state.settings.timeZone)}` : 'Seleziona nel browser la cartella del vault indicata qui sotto.';
  $('error-banner').hidden = !state.lastError;
  $('error-text').textContent = state.lastError?.message || '';
  $('extension-id').textContent = state.extensionId;
  const command = `python3 "$HOME/Documents/Progetti/pillole-valut/native_host/install.py" --extension-id "${state.extensionId}" --vault "$HOME/Documents/Obsidian Vault" --codex "$HOME/.local/bin/codex"`;
  $('install-command').textContent = command;
  $('host-status').textContent = state.host ? state.host.codexAvailable ? 'Ponte collegato · Codex CLI disponibile' : 'Ponte collegato · controlla il percorso Codex CLI' : 'Non ancora controllato';
  $('host-vault').textContent = state.host ? `${state.host.vaultPath} · ${state.vault ? 'collegato tramite Edge' : 'da collegare in Edge'}` : '—';
  $('host-codex').textContent = state.host ? `${state.host.codexAvailable ? '✓' : '✕'} ${state.host.codexPath}` : '—';
  if (!formDirty) fillSettings(state.settings);
  const listKey = JSON.stringify([state.queue.map((pill) => pill.id), state.history.map((pill) => pill.id), state.settings.timeZone]);
  if (lastListKey !== listKey) {
    $('stock-grid').replaceChildren(...state.queue.map((pill, index) => buildCard(pill, index, false)));
    $('history-grid').replaceChildren(...state.history.map((pill, index) => buildCard(pill, index, true)));
    lastListKey = listKey;
  }
  $('empty-stock').hidden = state.queue.length > 0;
  $('empty-history').hidden = state.history.length > 0;
  if (firstRender && selectedId) {
    const pills = [...state.queue, ...state.history, ...Object.values(state.notificationMap).map((item) => item.pill)];
    const selected = pills.find((pill) => pill?.id === selectedId);
    if (selected) showPill(selected); else notice('La pillola richiesta non è più disponibile. Puoi esplorare la scorta e lo storico.', true);
    selectedId = null;
  }
  firstRender = false;
}

async function refresh() {
  try { render(await send('getState')); }
  catch (error) { notice(error.message, true); }
}
async function operation(task, success) {
  if (busy) return;
  busy = true;
  if (latest) render(latest);
  notice('');
  try { await task(); if (success) notice(success); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; await refresh(); }
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$('go-setup').addEventListener('click', () => switchView('settings'));
$('refill').addEventListener('click', () => { void operation(() => send('refill'), 'Scorta aggiornata. Puoi leggere una pillola o inviare una prova.'); });
$('test').addEventListener('click', () => { void operation(() => send('testNotification'), 'Prova inviata. La scorta e la quota giornaliera sono rimaste intatte. Se non compare, controlla le notifiche di Edge in macOS.'); });
$('check-host').addEventListener('click', () => { void operation(() => send('checkHost'), 'Controllo del ponte completato. Il login di Codex sarà verificato dalla prima generazione.'); });
$('connect-vault').addEventListener('click', () => {
  if (busy || latest?.refilling) return;
  if (typeof window.showDirectoryPicker !== 'function') {
    notice('Questa versione di Edge non supporta la selezione della cartella. Apri la pagina dell’estensione in una scheda Edge aggiornata.', true);
    return;
  }
  // The picker must run directly in the user gesture, before any await.
  let selection;
  try { selection = window.showDirectoryPicker({ id: 'pillole-vault', mode: 'read' }); }
  catch (error) { notice(error.message, true); return; }
  void operation(async () => {
    let handle;
    try { handle = await selection; }
    catch (error) { if (error.name === 'AbortError') return; throw error; }
    const expectedName = latest?.host?.vaultPath.split('/').filter(Boolean).at(-1);
    if (expectedName && handle.name !== expectedName) throw new Error(`Seleziona il vault configurato: ${latest.host.vaultPath}`);
    await saveVaultHandle(handle);
    const result = await send('indexVault');
    notice(`Vault collegato: ${result.vault.count} note leggibili. Ora puoi preparare la scorta.`);
  });
});
$('dismiss-error').addEventListener('click', () => { void send('dismissError').then(render).catch((error) => notice(error.message, true)); });
$('settings-form').addEventListener('input', () => { formDirty = true; });
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  let settings;
  try {
    settings = normalizeSettings({
      enabled: $('enabled').checked,
      timeZone: $('timezone').value.trim(),
      windows: [0, 1].map((index) => ({ start: $(`start-${index}`).value, end: $(`end-${index}`).value, count: Number($(`count-${index}`).value) })),
      excludeFolders: $('exclusions').value.split('\n').map((folder) => folder.trim()).filter(Boolean),
    });
  } catch (error) { notice(error.message, true); return; }
  void operation(async () => { await send('saveSettings', { settings }); formDirty = false; }, settings.enabled ? 'Impostazioni salvate: invii attivi nei feriali. Gli slot passati vengono saltati.' : 'Impostazioni salvate: invii automatici in pausa.');
});
$('copy-command').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('install-command').textContent); notice('Comando copiato. Eseguilo manualmente nel terminale.'); }
  catch { notice('Seleziona e copia il comando dal riquadro.', true); }
});
$('close-dialog').addEventListener('click', () => $('pill-dialog').close());
$('pill-dialog').addEventListener('click', (event) => { if (event.target === $('pill-dialog')) { const rect = $('pill-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('pill-dialog').close(); } });
switchView(currentView);
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
