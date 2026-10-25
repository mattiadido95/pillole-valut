// Read only a directory explicitly selected by the user in Edge.
const DB_NAME = 'pilloleVaultDirectoryV1';
const STORE = 'handles';
const MAX_BYTES = 200 * 1024;
const MAX_NOTES = 5000;
const encoder = new TextEncoder();

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Impossibile salvare il collegamento al vault nel browser.'));
    request.onblocked = () => reject(new Error('Chiudi le altre pagine delle pillole e riprova il collegamento.'));
  });
}

async function handleOperation(mode, change) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let value;
      try {
        const request = change(transaction.objectStore(STORE));
        request.onsuccess = () => { value = request.result; };
      } catch (error) { transaction.abort(); reject(error); return; }
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(new Error('Impossibile leggere o salvare il collegamento al vault.'));
      transaction.onabort = () => reject(new Error('Il collegamento al vault non è stato salvato.'));
    });
  } finally { db.close(); }
}

export async function saveVaultHandle(handle) {
  if (!handle || handle.kind !== 'directory') throw new Error('Seleziona una cartella del vault.');
  await handleOperation('readwrite', (store) => store.put(handle, 'vault'));
}

export async function getVaultHandle() {
  return handleOperation('readonly', (store) => store.get('vault'));
}

export function eligiblePath(path, excludeFolders = []) {
  if (typeof path !== 'string' || !path || path.length > 2000 || path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\x00-\x1f]/.test(part))) return false;
  if (excludeFolders.some((folder) => path === folder || path.startsWith(`${folder}/`))) return false;
  if (parts.some((name) => {
    const lower = name.toLowerCase();
    return lower.startsWith('_template') || ['template', 'templates', 'template.md', 'templates.md'].includes(lower) || /(?:daily|weekly|monthly)[ -]+(?:digest|politica|attualit)/.test(lower) || lower.split(/[^a-z0-9]+/).includes('moc');
  })) return false;
  return /\.md$/i.test(path);
}

async function digest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function noteFromBytes(path, bytes, modifiedAt = new Date().toISOString()) {
  if (!eligiblePath(path) || bytes.byteLength > MAX_BYTES) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
  let body = text.trim();
  if (/^---\r?\n/.test(text)) {
    const lines = text.split(/\r?\n/);
    const end = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
    if (end < 0) return null;
    body = lines.slice(end + 1).join('\n').trim();
  }
  if ([...body].length < 80) return null;
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  const title = (heading?.[1] || path.split('/').at(-1).replace(/\.md$/i, '')).replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    id: (await digest(encoder.encode(path))).slice(0, 24), title, path,
    hash: await digest(bytes), modifiedAt,
    text: [...body].slice(0, 12000).join(''),
  };
}

export async function scanVault(handle, excludeFolders = []) {
  if (!handle || handle.kind !== 'directory') throw new Error('Apri Impostazioni e scegli “Collega il vault” prima di preparare la scorta.');
  if (await handle.queryPermission({ mode: 'read' }) !== 'granted') {
    throw new Error('L’accesso alla cartella va rinnovato: apri Impostazioni e scegli “Collega il vault”.');
  }
  const notes = [];
  let visited = 0;
  async function walk(directory, prefix = '') {
    for await (const entry of directory.values()) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const parts = relative.split('/');
      if (parts.some((part) => part.startsWith('.') || part === '..') || excludeFolders.some((folder) => relative === folder || relative.startsWith(`${folder}/`))) continue;
      if (entry.kind === 'directory') {
        // Apply the same name filters as notes before descending.
        if (eligiblePath(`${relative}/__probe.md`, excludeFolders)) await walk(entry, relative);
      } else if (entry.kind === 'file' && eligiblePath(relative, excludeFolders)) {
        visited += 1;
        if (visited > MAX_NOTES) throw new Error('Il vault contiene oltre 5000 note da esaminare. Escludi alcune cartelle nelle impostazioni.');
        let file;
        try { file = await entry.getFile(); }
        catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
        if (file.size > MAX_BYTES) continue;
        const note = await noteFromBytes(relative, await file.arrayBuffer(), new Date(file.lastModified).toISOString());
        if (note) notes.push(note);
      }
    }
  }
  try { await walk(handle); }
  catch (error) {
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) throw new Error('Edge non può leggere la cartella scelta. Ricollega il vault e conferma l’accesso nella finestra di selezione.');
    throw error;
  }
  return notes;
}

export function chooseNotes(notes, excludedIds, count, random = Math.random) {
  const excluded = new Set(excludedIds);
  const eligible = notes.filter((note) => !excluded.has(note.id));
  for (let index = eligible.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [eligible[index], eligible[other]] = [eligible[other], eligible[index]];
  }
  return eligible.slice(0, count);
}
