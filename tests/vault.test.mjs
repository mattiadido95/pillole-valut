import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { eligiblePath, noteFromBytes, scanVault, chooseNotes } from '../extension/core/vault.mjs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const encoder = new TextEncoder();
const body = '# Una nozione\n\n' + 'Un concetto riutilizzabile aiuta a comprendere il comportamento dei programmi. '.repeat(3);
const file = (name, content = body) => ({
  kind: 'file', name,
  async getFile() {
    const bytes = encoder.encode(content);
    return { size: bytes.byteLength, lastModified: 1_700_000_000_000, async arrayBuffer() { return bytes.buffer; } };
  },
});
const directory = (name, entries, permission = 'granted') => ({
  kind: 'directory', name,
  async queryPermission() { return permission; },
  async *values() { yield* entries; },
});

test('filtri browser: directory autorizzata, niente traversal, hidden, template o digest', () => {
  assert.equal(eligiblePath('Concetti/Template Method.md'), true);
  assert.equal(eligiblePath('Concetti/Nota.md'), true);
  for (const path of ['../Privato.md', '/tmp/Note.md', '.obsidian/Nota.md', 'A/../../Segreto.md', 'Concetti/_Template Concetto.md', '00 - MOC Note.md', '2026-10-25 - Daily Digest.md']) {
    assert.equal(eligiblePath(path), false, path);
  }
  assert.equal(eligiblePath('Tech News/Nota.md', ['Tech News']), false);
  assert.equal(eligiblePath('Tech News extra/Nota.md', ['Tech News']), true);
  assert.equal(eligiblePath(String.raw`A\Segreto.md`), false);
});

test('identità e hash corrispondono alla codifica del ponte; frontmatter escluso dal testo', async () => {
  const path = 'Concetti/Nota con à.md';
  const bytes = encoder.encode('---\nprivate: solo metadata\n---\n' + body);
  const note = await noteFromBytes(path, bytes);
  assert.equal(note.id, createHash('sha256').update(path).digest('hex').slice(0, 24));
  assert.equal(note.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(note.path, path);
  assert.equal(note.title, 'Una nozione');
  assert.ok(!note.text.includes('solo metadata'));
});

test('lettura UTF-8 limitata e testo minimo evitano batch inadatti', async () => {
  assert.equal(await noteFromBytes('Vuota.md', encoder.encode('breve')), null);
  assert.equal(await noteFromBytes('Grande.md', new Uint8Array(200 * 1024 + 1)), null);
  assert.equal(await noteFromBytes('Invalida.md', new Uint8Array([255, 255])), null);
  assert.equal(await noteFromBytes('Metadata.md', encoder.encode('---\nmetadata: ' + 'x'.repeat(120))), null);
  const unicode = await noteFromBytes('Unicode.md', encoder.encode('# Emoji\n' + '😀'.repeat(15000)));
  assert.equal([...unicode.text].length, 12000);
});

test('la scansione usa solo handle autorizzati e rispetta esclusioni', async () => {
  const handle = directory('Vault', [
    file('Valida.md'), directory('.private', [file('Segreto.md')]),
    directory('Tech News', [file('Notizia.md')]), file('_Template.md'),
  ]);
  const notes = await scanVault(handle, ['Tech News']);
  assert.deepEqual(notes.map((note) => note.path), ['Valida.md']);
  await assert.rejects(scanVault(directory('Vault', [], 'prompt')), /Collega il vault/);
  await assert.rejects(scanVault(null), /Collega il vault/);
});

test('il rifiuto di lettura non viene interpretato come catalogo vuoto valido', async () => {
  const handle = directory('Vault', []);
  handle.values = async function* () { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; };
  await assert.rejects(scanVault(handle), /non può leggere/);
});

test('selezione batch distinta, limitata e senza riproporre fonti escluse', () => {
  const notes = Array.from({ length: 6 }, (_, index) => ({ id: String(index) }));
  const before = JSON.stringify(notes);
  const selected = chooseNotes(notes, ['0', '2'], 3, () => 0.5);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((note) => note.id)).size, 3);
  assert.ok(selected.every((note) => !['0', '2'].includes(note.id)));
  assert.equal(JSON.stringify(notes), before);
});
