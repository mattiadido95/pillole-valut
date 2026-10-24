import { send, dateLabel, nextSlot, notice } from './ui.mjs';

let previewId = null;
async function refresh() {
  try {
    const state = await send('getState');
    document.getElementById('status-dot').classList.toggle('active', state.settings.enabled);
    document.getElementById('schedule-state').textContent = state.settings.enabled ? 'Invii attivi · lun–ven' : 'Notifiche in pausa';
    document.getElementById('stock-count').textContent = `${state.queue.length} pronte`;
    const next = nextSlot(state);
    document.getElementById('next-time').textContent = next ? `Prossima: ${dateLabel(next.when, state.settings.timeZone)} · ${state.settings.timeZone}` : state.settings.enabled ? 'Gli slot passati vengono saltati. Il prossimo giorno feriale avrà nuovi orari.' : 'Le pillole restano consultabili anche in pausa.';
    const pill = state.history[0] || state.queue[0];
    document.getElementById('preview').hidden = !pill;
    document.getElementById('empty').hidden = Boolean(pill);
    if (pill) {
      previewId = pill.id;
      document.getElementById('preview-label').textContent = state.history.length ? 'L’ULTIMA INCONTRATA' : 'DALLA TUA SCORTA';
      document.getElementById('preview-title').textContent = pill.title;
      document.getElementById('preview-summary').textContent = pill.summary;
    }
    document.getElementById('test').disabled = !state.queue.length;
  } catch (error) { notice(error.message, true); }
}
document.getElementById('open-app').addEventListener('click', () => { void send('openApp').then(() => window.close()).catch((error) => notice(error.message, true)); });
document.getElementById('read-preview').addEventListener('click', () => { if (previewId) void send('openPill', { id: previewId }).then(() => window.close()).catch((error) => notice(error.message, true)); });
document.getElementById('test').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { await send('testNotification'); notice('Prova inviata. Se non compare, controlla le notifiche di Edge in macOS.'); }
  catch (error) { notice(error.message, true); }
  finally { await refresh(); }
});
void refresh();
