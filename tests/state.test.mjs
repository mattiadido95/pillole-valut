import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const KEY = 'pilloleVaultStateV1';
let saved = {};
const copy = (value) => structuredClone(value);
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        await Promise.resolve();
        return { [key]: copy(saved[key]) };
      },
      async set(values) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        Object.assign(saved, copy(values));
      },
    },
  },
};
const { emptyState, readState, mutateState, validPill } = await import('../extension/core/state.mjs');
const pill = (id = 'pill-1') => ({
  id, sourceId: `source-${id}`, sourcePath: 'Concetti/Nota.md', sourceTitle: 'Una nota',
  sourceHash: 'a'.repeat(64), sourceUrl: 'obsidian://open?path=%2Ftmp%2FVault%2FConcetti%2FNota.md',
  title: 'Un concetto', summary: 'Spiegazione leggibile del concetto.', example: '',
  createdAt: '2026-10-24T14:00:00.000Z',
});

beforeEach(() => { saved = {}; });

test('avvio senza dati: cache vuota e invii disabilitati', async () => {
  const state = await readState();
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.history, []);
  assert.equal(state.settings.enabled, false);
});

test('mutazioni concorrenti non perdono aggiornamenti persistenti', async () => {
  await Promise.all(Array.from({ length: 20 }, () => mutateState(async (state) => {
    const previous = state.retryAfter;
    await Promise.resolve();
    state.retryAfter = previous + 1;
  })));
  assert.equal((await readState()).retryAfter, 20);
});

test('una mutazione fallita non viene salvata e non blocca le successive', async () => {
  await assert.rejects(mutateState((state) => {
    state.retryAfter = 99;
    throw new Error('annullata');
  }), /annullata/);
  await mutateState((state) => { state.retryAfter += 1; });
  assert.equal((await readState()).retryAfter, 1);
});

test('impostazioni corrotte mettono in pausa gli invii invece di attivarli', async () => {
  saved[KEY] = { ...emptyState(), settings: { enabled: true, timeZone: 'Invalid/Zone' } };
  const state = await readState();
  assert.equal(state.settings.enabled, false);
  assert.ok(state.lastError?.message);
});

test('persistenza limita scorta e storico e rimuove pillole malformate', async () => {
  const state = emptyState();
  state.queue = [null, ...Array.from({ length: 15 }, (_, index) => pill(`queue-${index}`))];
  state.history = [null, ...Array.from({ length: 105 }, (_, index) => pill(`history-${index}`))];
  saved[KEY] = state;
  const loaded = await readState();
  assert.equal(loaded.queue.length, 12);
  assert.equal(loaded.history.length, 100);
  assert.ok(loaded.queue.every(validPill));
  assert.ok(loaded.history.every(validPill));
});

test('fonti eseguibili o URL estranee a Obsidian sono rifiutate', () => {
  for (const sourceUrl of [
    'javascript:alert(1)',
    'https://example.com/note',
    'obsidian://open?path=relative.md',
    'obsidian://user:pass@open?path=%2Ftmp%2FNote.md',
  ]) assert.equal(validPill({ ...pill(), sourceUrl }), false);
  assert.equal(validPill(pill()), true);
});
