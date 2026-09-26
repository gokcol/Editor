import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecoveryQueue, flushStableRecovery } from './recoveryQueue.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('serializes snapshots and only acknowledges the latest as current', async () => {
  const gate = deferred<number>();
  const writes: string[] = [];
  const queue = createRecoveryQueue<string>((payload) => {
    writes.push(payload);
    return writes.length === 1 ? gate.promise : Promise.resolve(2);
  });
  const first = queue.save('older text');
  const second = queue.save('newer text');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['older text']);
  gate.resolve(1);
  assert.deepEqual(await first, { savedAt: 1, current: false });
  assert.deepEqual(await second, { savedAt: 2, current: true });
  assert.deepEqual(writes, ['older text', 'newer text']);
});

test('a debounced edit invalidates an older receipt before its next write', async () => {
  const gate = deferred<number>();
  const queue = createRecoveryQueue<string>(() => gate.promise);
  const first = queue.save('before edit');
  queue.invalidate();
  gate.resolve(1);
  assert.equal((await first).current, false);
});

test('a failed write is reported and does not poison subsequent recovery', async () => {
  let attempt = 0;
  const queue = createRecoveryQueue<string>(async () => {
    if (++attempt === 1) throw new Error('Disk full');
    return 2;
  });
  await assert.rejects(queue.save('draft'), /Disk full/);
  assert.deepEqual(await queue.save('draft retained for retry'), { savedAt: 2, current: true });
});

test('closing the final tab writes an empty checkpoint after pending drafts', async () => {
  const gate = deferred<number>();
  let checkpoint: string[] = [];
  const queue = createRecoveryQueue<string[]>(async (payload) => {
    if (payload.length) await gate.promise;
    checkpoint = payload;
    return 1;
  });
  const old = queue.save(['closed draft']);
  const empty = queue.save([]);
  gate.resolve(1);
  await Promise.all([old, empty]);
  assert.deepEqual(checkpoint, []);
});

test('close flush waits for state changes that arrive during a pending write', async () => {
  const first = deferred<number>();
  let documents = ['first edit'];
  const writes: string[][] = [];
  const closing = flushStableRecovery(() => documents, async (snapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) await first.promise;
  });
  documents = ['latest edit'];
  first.resolve(1);
  await closing;
  assert.deepEqual(writes, [['first edit'], ['latest edit']]);
});
