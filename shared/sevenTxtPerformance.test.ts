import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextIndex, changedRange } from '../7txt/src/textIndex.ts';
import { createDeferredTask } from '../7txt/src/deferredTask.ts';

function checkIndex(index: TextIndex, text: string) {
  const lines = text.split('\n');
  assert.equal(index.text, text);
  assert.equal(index.lineCount, lines.length);
  for (let offset = 0; offset <= text.length; offset++) {
    const prefix = text.slice(0, offset);
    assert.deepEqual(index.positionAt(offset), { line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') });
  }
  let start = 0;
  for (let line = 1; line <= lines.length; line++) {
    assert.deepEqual(index.rangeForLine(line), { start, end: start + lines[line - 1].length });
    start += lines[line - 1].length + 1;
  }
}

test('7txt line tracking handles newline boundaries, Unicode, deletes, and undo-sized replacements', () => {
  const index = new TextIndex();
  for (const text of ['', '\n', '\n\n', 'a\nb\n', 'a\nXb\n', 'aXb\n', 'a\nX\nb\n', 'é😀\nTürkçe\n', 'ê🦀\nTürkçe', '', 'restored\nfile']) {
    index.update(text, Math.max(0, index.text.length - 1));
    checkIndex(index, text);
  }
});

test('line tracking agrees with full recomputation through mixed edits and inaccurate input hints', () => {
  let text = 'first\n😀 second\nlast\n';
  const index = new TextIndex(text);
  let seed = 13;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const inserts = ['', 'x', '\n', 'Türkçe', '😀\n', '\n\n'];
  for (let edit = 0; edit < 180; edit++) {
    const start = random(text.length + 1);
    const end = start + random(text.length - start + 1);
    text = text.slice(0, start) + inserts[random(inserts.length)] + text.slice(end);
    index.update(text, random(Math.max(index.text.length, 1)));
    checkIndex(index, text);
  }
});

test('20,000 lines retain correct positions after beginning, middle, and end edits', () => {
  let text = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
  const index = new TextIndex(text);
  for (const offset of [0, Math.floor(text.length / 2), text.length]) {
    text = text.slice(0, offset) + '😀\ninserted\n' + text.slice(offset);
    index.update(text, offset);
    assert.equal(index.lineCount, text.split('\n').length);
    const position = text.slice(0, offset + 4);
    assert.deepEqual(index.positionAt(offset + 4), { line: position.split('\n').length, column: position.length - position.lastIndexOf('\n') });
  }
});

test('change detection reconstructs long pastes and replacements without assuming the hint is accurate', () => {
  const before = 'prefix\n'.repeat(2000) + 'é😀 old' + '\nsuffix'.repeat(2000);
  const after = before.replace('é😀 old', 'ê🦀 new\nline');
  for (const hint of [0, 200, before.length]) {
    const change = changedRange(before, after, hint);
    assert.equal(before.slice(0, change.start) + change.inserted + before.slice(change.end), after);
  }
  const index = new TextIndex();
  index.update('\n'.repeat(150_000));
  assert.equal(index.lineCount, 150_001);
});

test('deferred work coalesces edits and cannot replay a stale callback after switching documents', () => {
  const callbacks: (() => void)[] = [];
  let document = 'first';
  const rendered: string[] = [];
  const task = createDeferredTask(() => rendered.push(document), 200, {
    set: (run) => { callbacks.push(run); return callbacks.length; }, clear: () => {},
  });
  task.schedule();
  task.schedule();
  callbacks[0]();
  assert.deepEqual(rendered, []);
  document = 'second';
  task.flush();
  callbacks[1]();
  assert.deepEqual(rendered, ['second']);
  task.schedule();
  task.cancel();
  callbacks[2]();
  assert.deepEqual(rendered, ['second']);
});
