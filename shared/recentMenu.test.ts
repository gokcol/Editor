import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecentMenuSync, recentMenuEntryId, recentMenuItems } from './recentMenu.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('recent menus distinguish duplicate filenames and round-trip stable Unicode identities', () => {
  const entries = [
    { id: 'file:/İş/ödev%1.txt', name: 'ödev.txt', path: '/İş/ödev.txt' },
    { id: 'file:/Arşiv/ödev.txt', name: 'ödev.txt', path: '/Arşiv/ödev.txt' },
  ];
  const items = recentMenuItems(entries);
  assert.deepEqual(items.map(({ label }) => label), ['ödev.txt — /İş/ödev.txt', 'ödev.txt — /Arşiv/ödev.txt']);
  assert.deepEqual(items.map(({ id }) => recentMenuEntryId(`open-recent:${id}`)), entries.map(({ id }) => id));
  assert.deepEqual(recentMenuItems([...entries].reverse()).map(({ id }) => id), items.map(({ id }) => id).reverse());
});

test('recent menus preserve order, omit duplicate or invalid identities, and bound display text', () => {
  const source = [
    { id: '', name: 'invalid', path: '' },
    { id: '\ud800', name: 'invalid surrogate', path: '' },
    { id: 'x'.repeat(4097), name: 'too long', path: '' },
    { id: 'first', name: 'Line\n\u202eName\u0000', path: '/first' },
    { id: 'first', name: 'duplicate', path: '/duplicate' },
    ...Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, name: '📄'.repeat(300), path: `/folder-${i}/file` })),
  ];
  const items = recentMenuItems(source);
  assert.equal(items.length, 20);
  assert.equal(items[0].label, 'Line Name');
  assert.deepEqual(items.map(({ id }) => id), ['first', ...Array.from({ length: 19 }, (_, i) => `${i}`)]);
  assert.ok(items.every(({ label }) => Array.from(label).length <= 240));
  assert.equal(new Set(items.map(({ label }) => label)).size, 20);
});

test('recent menu actions reject unrelated, malformed, and oversized tokens', () => {
  for (const action of ['open-file', 'open-recents', 'open-recent:', 'open-recent:%ZZ', 'open-recent:%ED%A0%80', 'open-recent:has space', `open-recent:${'a'.repeat(4097)}`]) {
    assert.equal(recentMenuEntryId(action), null, action);
  }
  assert.equal(recentMenuEntryId('open-recent:a%3Ab%2Fc%25'), 'a:b/c%');
});

test('menu synchronization serializes writes and coalesces pending updates including Clear', async () => {
  const first = deferred();
  const writes: string[][] = [];
  const sync = createRecentMenuSync(async (items) => {
    writes.push(items.map(({ id }) => id));
    if (writes.length === 1) await first.promise;
  });
  const old = sync([{ id: 'old', label: 'Old' }]);
  const superseded = sync([{ id: 'intermediate', label: 'Intermediate' }]);
  const cleared = sync([]);
  assert.deepEqual(writes, [['old']]);
  first.resolve();
  await Promise.all([old, superseded, cleared]);
  assert.deepEqual(writes, [['old'], []]);
});

test('menu synchronization deduplicates successful snapshots and captures caller-owned arrays', async () => {
  const gate = deferred();
  const writes: string[] = [];
  const sync = createRecentMenuSync(async (items) => {
    await gate.promise;
    writes.push(items[0].label);
  });
  const input = [{ id: 'one', label: 'Original' }];
  const first = sync(input);
  const duplicate = sync(input);
  input[0].label = 'Mutated by caller';
  gate.resolve();
  await Promise.all([first, duplicate]);
  await sync([{ id: 'one', label: 'Original' }]);
  assert.deepEqual(writes, ['Original']);
  await sync([{ id: 'one', label: 'Renamed' }]);
  assert.deepEqual(writes, ['Original', 'Renamed']);
});

test('a failed native write rejects its caller while the pending latest snapshot still runs', async () => {
  const gate = deferred();
  const writes: string[] = [];
  const sync = createRecentMenuSync(async (items) => {
    writes.push(items[0].id);
    if (writes.length === 1) await gate.promise;
  });
  const failed = assert.rejects(sync([{ id: 'old', label: 'Old' }]), /native failure/);
  const latest = sync([{ id: 'new', label: 'New' }]);
  gate.reject(new Error('native failure'));
  await Promise.all([failed, latest]);
  assert.deepEqual(writes, ['old', 'new']);
});

test('failed snapshots can be retried even after an earlier successful identical state', async () => {
  let attempt = 0;
  const sync = createRecentMenuSync(async () => {
    if (++attempt === 2) throw new Error('native failure');
  });
  const initial = [{ id: 'one', label: 'One' }];
  await sync(initial);
  await assert.rejects(sync([{ id: 'two', label: 'Two' }]), /native failure/);
  await sync(initial);
  assert.equal(attempt, 3);
});
