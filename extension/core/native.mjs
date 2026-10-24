const HOST = 'com.mattia.pillole_valut';

export async function nativeRequest(action, payload = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let port;
    let finished = false;
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (port) port.disconnect(); } catch { /* A disconnected port is already closed. */ }
      if (error) reject(error); else resolve(result);
    };
    try {
      port = chrome.runtime.connectNative(HOST);
      timer = setTimeout(() => finish(new Error('Il ponte locale non ha risposto in tempo. Riprova dalla pagina Pillole.')), action === 'generate' ? 270_000 : 30_000);
      port.onMessage.addListener((message) => {
        if (!message || message.id !== id || typeof message.ok !== 'boolean') {
          finish(new Error('Risposta non valida dal ponte locale.'));
        } else if (!message.ok) {
          const error = new Error(typeof message.error?.message === 'string' ? message.error.message.slice(0, 500) : 'Il ponte locale ha segnalato un errore.');
          error.code = message.error?.code;
          finish(error);
        } else if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
          finish(new Error('Il ponte ha restituito un risultato non valido.'));
        } else finish(null, message.result);
      });
      port.onDisconnect.addListener(() => {
        const detail = chrome.runtime.lastError?.message;
        if (!finished) finish(new Error(detail ? 'Ponte non disponibile. Controlla l’installazione e l’ID dell’estensione nella pagina Pillole.' : 'Il ponte locale si è chiuso prima di rispondere.'));
      });
      port.postMessage({ id, action, payload });
    } catch {
      finish(new Error('Impossibile collegarsi al ponte locale. Completa la configurazione nella pagina Pillole.'));
    }
  });
}
