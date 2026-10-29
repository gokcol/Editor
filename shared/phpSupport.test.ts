import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGINAL_SOURCE_TYPES, SOURCE_TYPES, SOURCE_FILENAME_PATTERN, normalizedEnabledSourceTypes, sourceTypeForName } from '../src/engine/sourceTypes.ts';
import { documentOutline, sourceFromAssistantReply } from '../src/engine/workbench.ts';
import { samples } from '../src/engine/samples.ts';
import { references } from '../src/engine/references.ts';

test('PHP extensions are detected, renamed cleanly, and do not capture unrelated files', () => {
  for (const extension of ['php', 'phtml', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'PHP', 'PHTML']) {
    assert.equal(sourceTypeForName(`folder/index.${extension}`), 'php');
    assert.equal(`index.${extension}`.replace(SOURCE_FILENAME_PATTERN, ''), 'index');
  }
  for (const name of ['README', 'config.inc', 'index.php.txt', 'php', 'index.php.bak']) {
    assert.equal(sourceTypeForName(name), 'text');
  }
});

test('all source modes retain their filename detection and starter content', () => {
  assert.equal(ORIGINAL_SOURCE_TYPES.length, 17);
  for (const type of SOURCE_TYPES) {
    assert.equal(sourceTypeForName(samples[type].name), type);
    assert.ok(Array.isArray(references[type]));
  }
  assert.ok(samples.php.source.startsWith('<?php'));
});

test('PHP is added to the old default once, without overriding opt-outs or custom subsets', () => {
  const oldDefault = ORIGINAL_SOURCE_TYPES.filter((type) => type !== 'php');
  assert.deepEqual(normalizedEnabledSourceTypes(oldDefault, 0), SOURCE_TYPES);
  assert.deepEqual(normalizedEnabledSourceTypes(oldDefault, 1), oldDefault);
  assert.deepEqual(normalizedEnabledSourceTypes(['text', 'json'], 0), ['text', 'json']);
  assert.deepEqual(normalizedEnabledSourceTypes(undefined, 0), SOURCE_TYPES);
  assert.deepEqual(normalizedEnabledSourceTypes(['unknown'], 0), ['text']);
});

test('PHP outline recognizes classes, interfaces, traits, enums, functions and methods', () => {
  const source = '<?php\nfinal class Greeting {\n    public static function greet(string $name): string {}\n}\ninterface Named {}\ntrait Labelled {}\nenum Status {}\nfunction &lookup() {}';
  const outline = documentOutline('php', source);
  assert.deepEqual(outline.map((item) => item.label), ['Greeting', 'greet', 'Named', 'Labelled', 'Status', 'lookup']);
  assert.deepEqual(outline.map((item) => item.line), [2, 3, 5, 6, 7, 8]);
});

test('Prompt Studio accepts PHP fences and preserves dollar variables', () => {
  assert.equal(sourceFromAssistantReply('```php\n<?php echo $name;\n```', 'php'), '<?php echo $name;\n');
  assert.ok(references.php.some((entry) => entry.insertText.includes('$name')));
});
