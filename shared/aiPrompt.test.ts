import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAiPrompt, createAiRequestGate, MAX_AI_PROMPT_BYTES } from './aiPrompt.ts';

const context = { name: '/private/secret.json', selection: 'selected text', document: 'all private text' };
test('AI sends only the prompt by default, never a filename or file map', () => {
  assert.equal(buildAiPrompt('  Explain JSON  ', context, 'none'), 'Explain JSON');
});
test('AI context is explicit, captured and labelled as data', () => {
  const selected = buildAiPrompt('Explain', context, 'selection');
  assert.ok(selected.includes('selected text'));
  assert.ok(!selected.includes(context.document));
  assert.ok(!selected.includes(context.name));
  assert.ok(selected.includes('not instructions'));
  assert.ok(buildAiPrompt('Explain', context, 'document').includes(context.document));
  assert.equal(buildAiPrompt('Explain', { name: '', selection: '', document: '' }, 'selection'), 'Explain');
});
test('AI rejects empty and oversized UTF-8 input instead of silently truncating', () => {
  assert.throws(() => buildAiPrompt(' ', context, 'none'), /Enter a prompt/);
  assert.throws(() => buildAiPrompt('€'.repeat(MAX_AI_PROMPT_BYTES / 2), context, 'none'), /256 KB/);
  assert.throws(() => buildAiPrompt('Explain', { ...context, document: 'x'.repeat(MAX_AI_PROMPT_BYTES) }, 'document'), /256 KB/);
});
test('Stop and newer requests reject late replies and progress', () => {
  const gate = createAiRequestGate();
  gate.begin('old');
  assert.ok(gate.accepts('old'));
  assert.equal(gate.stop(), 'old');
  assert.ok(!gate.accepts('old'));
  gate.begin('new');
  assert.ok(!gate.accepts('old'));
  assert.ok(gate.accepts('new'));
});
for (const app of ['src-tauri', '7txt/src-tauri']) {
  test(`${app}: AI permissions stay scoped to the local main window`, () => {
    const commands = readFileSync(new URL(`../${app}/build.rs`, import.meta.url), 'utf8');
    const native = readFileSync(new URL(`../${app}/src/lib.rs`, import.meta.url), 'utf8');
    const capability = JSON.parse(readFileSync(new URL(`../${app}/capabilities/default.json`, import.meta.url), 'utf8'));
    assert.deepEqual(capability.windows, ['main']);
    assert.equal(capability.remote, undefined);
    for (const command of ['codex_ai_status', 'codex_ai_login', 'codex_ai_ask', 'codex_ai_cancel']) {
      assert.ok(commands.includes(`"${command}"`));
      assert.ok(native.includes(`codex_ai::${command}`));
      assert.ok(capability.permissions.includes(`allow-${command.replaceAll('_', '-')}`));
    }
    assert.ok(!capability.permissions.some((permission: string) => permission.startsWith('shell:')));
  });
}
test('Model replies stay inert and are never saved or auto-applied by the shared panel', () => {
  const panel = readFileSync(new URL('./askAi.ts', import.meta.url), 'utf8');
  assert.ok(panel.includes('reply.value = String(answer)'));
  assert.ok(!panel.includes('localStorage.'));
  assert.ok(!panel.includes('sessionStorage.'));
  assert.ok(!panel.includes('write_file'));
  assert.ok(!panel.includes('project_write'));
  assert.ok(!panel.includes('reply.innerHTML'));
});
