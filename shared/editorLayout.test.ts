import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function declarations(file: string, selector: string, property: string) {
  const css = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').some((part) => part.trim() === selector))
    .flatMap((rule) => rule[2].split(';').map((declaration) => declaration.trim()))
    .filter((declaration) => declaration.startsWith(`${property}:`))
    .map((declaration) => declaration.slice(property.length + 1).trim());
}

test('Yedit keeps one four-row editor layout, with a content-sized safety row', () => {
  const rows = declarations('../src/styles.css', '.editor-shell', 'grid-template-rows');
  // A later three-row override gave all remaining space to the recovery bar
  // and left the actual editor in an implicit, clipped fourth row.
  assert.equal(rows.length, 1, 'Keep the editor row definition in a single rule');
  assert.deepEqual(rows[0].match(/minmax\([^)]*\)|\S+/g), [
    'minmax(41px, auto)', 'minmax(36px, auto)', 'auto', 'minmax(0, 1fr)',
  ]);
});

test('7TXT notices do not grow into or shrink over the editing area', () => {
  for (const header of ['.external-change', '.recovery-status', '.recovered-notice', '.editor-heading']) {
    assert.equal(declarations('../7txt/src/styles.css', `.editor-pane > ${header}`, 'flex').at(-1), '0 0 auto');
  }
  assert.equal(declarations('../7txt/src/styles.css', '.editor-surface', 'flex').at(-1), '1 1 0');
  assert.equal(declarations('../7txt/src/styles.css', '.editor-surface', 'min-height').at(-1), '0');
  assert.equal(declarations('../7txt/src/styles.css', '.editor-surface', 'overflow').at(-1), 'hidden');
});
