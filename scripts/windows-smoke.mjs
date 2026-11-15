// Runs only on the disposable Windows CI runner, against real Tauri/WebView2
// binaries. CDP is enabled by CI runtime settings, never by
// production configuration. No renderer test API is compiled into either app.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32');
const [modulePath, binaryDir, reportDir] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const directory = await mkdtemp(join(tmpdir(), 'editor-native-smoke-'));
await mkdir(reportDir, { recursive: true });
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const installed = await readFile(join(reportDir, 'Windows-installation.json'), 'utf8').then(JSON.parse).catch(() => []);
const normalize = value => value.replaceAll('\u00a0', ' ');

async function eventually(action, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value; }
    catch (e) { error = e; }
    await delay(250);
  }
  throw new Error(`${message}: ${error?.message || 'timed out'}`);
}

async function start(app, args, port) {
  const executable = installed.find(entry => entry.app === app)?.executable || join(binaryDir, `${app}.exe`);
  const environment = { ...process.env };
  // SDK environment overrides can shadow the machine policies configured by
  // install-windows-packages.ps1. Use one configuration source on the CI host.
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('WEBVIEW2_')) delete environment[key];
  }
  const child = spawn(executable, args, {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { output += error.message; });
  let browser;
  try {
    await eventually(async () => {
      assert.equal(child.exitCode, null, `${app} exited: ${output}`);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    }, `${app} WebView2 startup`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await eventually(() => browser.contexts().flatMap(context => context.pages())
      .find(page => /tauri\.localhost|tauri:/.test(page.url())), `${app} local page`);
    await page.waitForLoadState('domcontentloaded');
    assert.ok(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), 'Use the native IPC bridge');
    return { child, browser, page };
  } catch (error) {
    const diagnostics = await promisify(execFile)('pwsh', ['-NoProfile', '-File', resolve('scripts/windows-diagnostics.ps1'), app, resolve(reportDir)]).catch(e => ({ stdout: e.stdout || '', stderr: e.stderr || e.message }));
    await stop({ child, browser });
    throw new Error(`${error.message}\n${output}\n${diagnostics.stdout}\n${diagnostics.stderr}`);
  }
}

async function stop({ child, browser }) {
  await browser?.close().catch(() => {});
  if (child.pid && child.exitCode === null) {
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
  }
  await delay(700);
}

for (const [index, app] of ['7TXT', 'Yedit'].entries()) {
  const initial = 'Native Windows fixture — Türkçe ıİşğü\nSecond line\n';
  const saved = `Saved by ${app} on Windows — ıİşğü\nA new line\n`;
  const recovered = `Unsaved recovery in ${app} — ıİ\nKeep this draft\n`;
  const source = join(directory, `${app}.txt`);
  await writeFile(source, initial, 'utf8');
  const checkpoint = join(process.env.APPDATA, app === '7TXT' ? 'com.gokcol.7txt' : 'com.yedit.desktop', 'recovery', '6d61696e.json');
  let session;
  try {
    session = await start(app, [source], 9222 + index);
    const { page } = session;
    async function text() {
      return app === '7TXT' ? page.locator('textarea.editor').inputValue()
        : page.locator('.monaco-editor .view-lines').first().innerText().then(normalize);
    }
    await eventually(async () => (await text()).includes('Native Windows fixture'), `${app} external file open`);
    const editor = app === '7TXT' ? page.locator('textarea.editor') : page.locator('.monaco-editor textarea').first();
    await editor.focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(saved);
    await page.keyboard.press('Control+s');
    await eventually(async () => (await readFile(source, 'utf8')).replaceAll('\r\n', '\n') === saved, `${app} Ctrl+S native file save`);
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(recovered);
    await eventually(async () => (await readFile(checkpoint, 'utf8')).includes('Keep this draft'), `${app} durable recovery checkpoint`);
    assert.ok(!(await readFile(checkpoint, 'utf8')).includes('Recovery could not be saved'));
    await page.screenshot({ path: join(reportDir, `${app}-Windows-editing.png`) });
    await stop(session); session = undefined;
    session = await start(app, [], 9222 + index);
    await eventually(async () => app === '7TXT'
      ? (await session.page.locator('textarea.editor').inputValue()).includes('Keep this draft')
      : normalize(await session.page.locator('.monaco-editor .view-lines').first().innerText()).includes('Keep this draft'), `${app} recovery after crash`);
    await session.page.screenshot({ path: join(reportDir, `${app}-Windows-recovery.png`) });
    results.push({ app, nativeFileOpen: true, unicodeSave: true, recoveryCheckpoint: true, crashRecovery: true });
  } catch (error) {
    await session?.page.screenshot({ path: join(reportDir, `${app}-Windows-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    if (session) await stop(session);
    await writeFile(join(reportDir, 'Windows-smoke.json'), JSON.stringify(results, null, 2) + '\n');
  }
}
console.log(JSON.stringify(results, null, 2));
