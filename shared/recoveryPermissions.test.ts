import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

for (const app of ['src-tauri', '7txt/src-tauri']) {
  test(`${app}: recovery commands are declared and allowed for the local main window`, () => {
    const manifest = readFileSync(new URL(`../${app}/build.rs`, import.meta.url), 'utf8');
    const commands = manifest.match(/const COMMANDS[^=]*=\s*&\[([\s\S]*?)\];/)?.[1];
    assert.ok(commands, 'AppManifest command list must exist');
    const capability = JSON.parse(readFileSync(new URL(`../${app}/capabilities/default.json`, import.meta.url), 'utf8'));
    assert.deepEqual(capability.windows, ['main']);
    assert.equal(capability.remote, undefined, 'Do not expose recovery to remote pages');
    for (const command of ['recovery_load', 'recovery_save', 'recovery_finish_close']) {
      assert.ok(commands.includes(`"${command}"`), `${command} missing from AppManifest`);
      assert.ok(capability.permissions.includes(`allow-${command.replaceAll('_', '-')}`), `${command} missing from main-window permissions`);
    }
  });
}
