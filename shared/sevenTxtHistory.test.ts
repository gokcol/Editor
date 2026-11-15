import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_HISTORY_VERSIONS, recordHistory, type DocumentHistory } from '../7txt/src/history.ts';

test('7txt retains the latest 100 versions and supports undo/redo at the cap', () => {
  const history: DocumentHistory = { entries: ['0'], index: 0 };
  for (let version = 1; version <= 2500; version++) recordHistory(history, String(version));
  assert.equal(MAX_HISTORY_VERSIONS, 100);
  assert.equal(history.entries.length, 100);
  assert.equal(history.index, 99);
  assert.equal(history.entries[0], '2401');
  assert.equal(history.entries[--history.index], '2499');
  assert.equal(history.entries[++history.index], '2500');
});

test('editing after undo discards only the abandoned redo branch', () => {
  const history: DocumentHistory = { entries: ['a', 'b', 'c'], index: 1 };
  recordHistory(history, 'new branch');
  assert.deepEqual(history, { entries: ['a', 'b', 'new branch'], index: 2 });
  assert.equal(history.entries[--history.index], 'b');
});

test('duplicate input preserves redo and histories remain independent per document', () => {
  const first: DocumentHistory = { entries: ['a', 'b'], index: 0 };
  const second: DocumentHistory = { entries: ['other'], index: 0 };
  recordHistory(first, 'a');
  recordHistory(second, 'edited');
  assert.deepEqual(first, { entries: ['a', 'b'], index: 0 });
  assert.deepEqual(second, { entries: ['other', 'edited'], index: 1 });
});
