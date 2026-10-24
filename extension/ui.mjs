export async function send(action, values = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...values });
  if (!response?.ok) throw new Error(response?.error || 'L’estensione non ha risposto. Riprova aprendo la pagina Pillole.');
  return response.result;
}

export function dateLabel(value, timeZone = 'Europe/Rome') {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Data non disponibile';
  return new Intl.DateTimeFormat('it-IT', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

export function nextSlot(state) {
  if (!state.settings.enabled) return null;
  return state.dailyPlan?.slots?.filter((slot) => slot.when > Date.now() && !state.completed.includes(slot.id)).sort((a, b) => a.when - b.when)[0] || null;
}

export function notice(message, error = false) {
  const element = document.getElementById('notice');
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('notice-error', error);
}
