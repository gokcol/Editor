import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer, normalizePath } from 'vite';

const { values } = parseArgs({ options: {
  'playwright-module': { type: 'string' }, engine: { type: 'string', default: 'chromium' },
  executable: { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' },
  trials: { type: 'string', default: '3' }, 'tests-only': { type: 'boolean', default: false },
  case: { type: 'string' }, input: { type: 'string', default: 'native' },
} });
const playwright = values['playwright-module'] ? await import(pathToFileURL(resolve(values['playwright-module'])).href) : await import('playwright');
assert.ok(['chromium', 'webkit'].includes(values.engine));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = resolve(root, '7txt');
const mainPath = normalizePath(resolve(appRoot, 'src/main.ts'));
const desktopMock = resolve(appRoot, 'tests/desktopMock.ts');
const baseline = values.baseline ? await readFile(resolve(values.baseline), 'utf8') : undefined;

// Appended by a test-only Vite transform, rather than shipping a debug API or
// benchmark entry point inside the production app.
const bridge = `
let testId = 0;
window.__7txtTest = {
  ready: () => recoveryReady && !shell.inert,
  load(content, markdown = false, bound = false) {
    const next = { ...blankDocument(markdown), id: 'test-' + (++testId), name: markdown ? 'fixture.md' : 'fixture.txt',
      content, savedContent: content, defaultUntitled: false, path: bound ? '/test/fixture.txt' : undefined,
      diskVersion: bound ? 'test-1' : undefined };
    documents = [next]; documentState = next; activeDocumentId = next.id; histories.clear();
    editorSplit = false; sidebarVisible = true; sidebarAutoHidden = false; zenMode = false; readingMode = false;
    previewEnabled = markdown; viewMode = markdown ? 'split' : 'edit';
    commitDocument(next); applySidebarLayout();
    editor.focus(); editor.setSelectionRange(content.length, content.length);
  },
  insert(text, start = editor.selectionStart, end = start, secondary = false, composing = false) {
    const surface = secondary ? secondaryEditor : editor;
    surface.focus(); surface.setSelectionRange(start, end);
    surface.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text, isComposing: composing }));
    surface.setRangeText(text, start, end, 'end');
    surface.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text, isComposing: composing }));
    surface.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  },
  preview(shown) { if (previewEnabled !== shown) togglePreview(); },
  split(shown) { if (editorSplit !== shown) toggleEditorSplit(); },
  sidebar(shown) { if (sidebarIsShown() !== shown) toggleSidebar(); },
  switchDocument(content) { addDocument({ ...blankDocument(true), content, savedContent: content, defaultUntitled: false }); },
  replace(search, replacement) { findInput.value = search; replaceInput.value = replacement; findCase.checked = true; findRegex.checked = false; replaceAll(); },
  undo, redo, print: printDocument, mode: setViewMode,
  closeAll: closeAllDocuments, insertCommand: insertAtSelection,
  observeInput() {
    const timings = window.__inputTimings = { input: [], beforeinput: [], keyup: [], frames: [] };
    for (const surface of [editor, secondaryEditor]) {
      for (const type of ['beforeinput', 'input', 'keyup']) {
        const starts = new WeakMap();
        surface.addEventListener(type, event => starts.set(event, performance.now()), true);
        surface.addEventListener(type, event => {
          const start = starts.get(event);
          timings[type].push(performance.now() - start);
          if (type === 'input') requestAnimationFrame(() => timings.frames.push(performance.now() - start));
        });
      }
    }
  },
  state: () => ({ content: documentState.content, saved: documentState.savedContent,
    primary: editor.value, secondary: secondaryEditor.value, cursor: cursorStatusForTest(),
    statistics: document.querySelector('.status-stats').textContent, preview: preview.textContent,
    previewHtml: preview.innerHTML, outline: outlineList.textContent, gutter: lineNumbers.textContent,
    secondaryGutter: secondaryLineNumbers.textContent, dirty: isDirty(), versions: historyFor(documentState).entries.length }),
};
function cursorStatusForTest() { return document.querySelector('.status-cursor').textContent; }
`;

async function serverFor(source) {
  const server = await createServer({
    configFile: false, root: appRoot, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    resolve: { alias: [{ find: /^@tauri-apps\/api\/(core|event|webview)$/, replacement: desktopMock }] },
    plugins: [{ name: '7txt-browser-test', enforce: 'pre', transform(code, id) {
      if (id.split('?')[0] === mainPath) return { code: (source || code) + bridge, map: null };
    } }],
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/` };
}

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = values.executable || (values.engine === 'chromium' && existsSync(chrome) ? chrome : undefined);
const browser = await playwright[values.engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const current = await serverFor();
const original = baseline ? await serverFor(baseline) : undefined;
const errors = [];

async function pageFor(url) {
  const context = await browser.newContext({ viewport: { width: 1160, height: 780 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__layoutWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === '7txt:workbench-state:v1') window.__layoutWrites++;
      return set.call(this, key, value);
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__7txtTest?.ready());
  return { context, page };
}

async function state(page) { return page.evaluate(() => window.__7txtTest.state()); }

async function functionalTests() {
  const { page, context } = await pageFor(current.url);
  await page.evaluate(() => {
    window.__7txtTest.load('é😀\nTürkçe\nlast');
    window.__stableTab = document.querySelector('.tab-activate');
    window.__stableGutter = document.querySelector('.line-numbers').firstChild;
    window.__stableRecents = document.querySelector('.recents-list').firstChild;
    window.__writesBefore = window.__layoutWrites;
    window.__7txtTest.insert('x');
  });
  let result = await state(page);
  assert.equal(result.primary, 'é😀\nTürkçe\nlastx');
  assert.equal(result.secondary, '');
  assert.equal(result.cursor, 'Ln 3, Col 6');
  assert.equal(result.dirty, true);
  assert.ok(await page.evaluate(() => document.querySelector('.tab-activate') === window.__stableTab
    && document.querySelector('.line-numbers').firstChild === window.__stableGutter
    && document.querySelector('.recents-list').firstChild === window.__stableRecents
    && window.__layoutWrites === window.__writesBefore));
  await page.waitForTimeout(260);
  assert.match((await state(page)).statistics, /3 line/);
  await page.evaluate(() => window.__7txtTest.undo());
  assert.equal((await state(page)).dirty, false);
  await page.evaluate(() => window.__7txtTest.redo());
  assert.equal((await state(page)).primary, result.primary);
  console.log('PASS stable controls, cached gutter, Unicode cursor, dirty state, undo/redo');

  await page.evaluate(() => window.__7txtTest.split(true));
  assert.equal((await state(page)).secondary, result.primary);
  await page.locator('.editor-secondary').focus();
  await page.keyboard.press('End');
  await page.keyboard.insertText('😀\nsecond');
  result = await state(page);
  assert.equal(result.primary, result.secondary);
  assert.match(result.primary, /second/);
  assert.equal(result.gutter, '1\n2\n3\n4');
  await page.evaluate(() => window.__7txtTest.split(false));
  assert.equal((await state(page)).secondary, '');
  await page.evaluate(() => window.__7txtTest.split(true));
  assert.equal((await state(page)).primary, (await state(page)).secondary);
  console.log('PASS split-pane edits, paste/newlines, close and reopen');

  await page.evaluate(() => {
    window.__7txtTest.load(Array.from({ length: 20_000 }, (_, i) => 'line ' + i).join('\n'));
    const surface = document.querySelector('.editor:not(.editor-secondary)');
    surface.setSelectionRange(surface.value.length, surface.value.length);
    surface.scrollTop = surface.scrollHeight;
    window.__gutterNode = document.querySelector('.line-numbers').firstChild;
  });
  const gutterAligned = () => {
    const source = document.querySelector('.editor:not(.editor-secondary)');
    const gutter = document.querySelector('.line-numbers');
    return Math.abs(gutter.scrollTop - Math.min(source.scrollTop, gutter.scrollHeight - gutter.clientHeight)) <= 1;
  };
  await page.waitForFunction(gutterAligned);
  await page.keyboard.press('Enter');
  await page.waitForFunction(gutterAligned);
  assert.ok(await page.evaluate(() => document.querySelector('.line-numbers').textContent.endsWith('\n20001')
    && document.querySelector('.line-numbers').firstChild === window.__gutterNode));
  await page.keyboard.press('Backspace');
  await page.waitForFunction(gutterAligned);
  assert.ok(await page.evaluate(() => document.querySelector('.line-numbers').textContent.endsWith('\n20000')));
  console.log('PASS 20,000-line gutter scrolling and incremental Enter/Backspace updates');

  await page.evaluate(() => {
    window.__7txtTest.load('# Before\n\nparagraph', true);
    window.__7txtTest.preview(false);
    window.__7txtTest.sidebar(false);
    window.__outlineBefore = document.querySelector('.outline-list').textContent;
    window.__7txtTest.insert('\n# Latest');
  });
  await page.waitForTimeout(260);
  assert.equal((await state(page)).previewHtml, '');
  assert.ok(await page.evaluate(() => document.querySelector('.outline-list').textContent === window.__outlineBefore));
  await page.evaluate(() => { window.__7txtTest.preview(true); window.__7txtTest.sidebar(true); });
  result = await state(page);
  assert.match(result.preview, /Latest/);
  assert.match(result.outline, /Latest/);
  await page.evaluate(() => {
    window.__7txtTest.insert('\n# Stale');
    window.__7txtTest.switchDocument('# Other document\n\nnew');
  });
  await page.waitForTimeout(260);
  result = await state(page);
  assert.match(result.preview, /Other document/);
  assert.doesNotMatch(result.preview, /Stale/);
  await page.evaluate(() => { window.__7txtTest.insert(' print-latest'); return window.__7txtTest.print(); });
  assert.match((await state(page)).preview, /print-latest/);
  console.log('PASS hidden previews/outlines, tab switching, and fresh print output');

  await page.evaluate(() => window.__7txtTest.mode('split'));
  await page.setViewportSize({ width: 780, height: 780 });
  await page.waitForFunction(() => window.__7txtTest.state().previewHtml === '');
  await page.setViewportSize({ width: 1160, height: 780 });
  await page.waitForFunction(() => window.__7txtTest.state().preview.includes('print-latest'));
  console.log('PASS responsive preview hide and reopen');

  await page.evaluate(() => {
    window.__7txtTest.load('first\nTürkçe first\nlast');
    window.__7txtTest.replace('first', '😀 heading');
  });
  result = await state(page);
  assert.equal(result.primary, '😀 heading\nTürkçe 😀 heading\nlast');
  assert.equal(result.gutter, '1\n2\n3');
  await page.evaluate(() => window.__7txtTest.undo());
  assert.equal((await state(page)).primary, 'first\nTürkçe first\nlast');
  await page.evaluate(() => window.__7txtTest.redo());
  assert.equal((await state(page)).primary, result.primary);
  await page.evaluate(() => window.__7txtTest.insertCommand('\nextra\nend'));
  assert.equal((await state(page)).gutter, '1\n2\n3\n4\n5');
  await page.evaluate(() => window.__7txtTest.undo());
  assert.equal((await state(page)).gutter, '1\n2\n3');
  await page.evaluate(() => window.__7txtTest.redo());
  assert.equal((await state(page)).gutter, '1\n2\n3\n4\n5');
  console.log('PASS programmatic replacement, multiline insertion, and history');

  await page.evaluate(() => { window.__7txtTest.load('clean'); window.__7txtTest.closeAll(); });
  await page.waitForFunction(() => document.querySelector('.app-shell').classList.contains('empty-workspace'));
  await page.evaluate(() => window.__7txtTest.insertCommand('new work'));
  assert.equal((await state(page)).primary, 'new work');
  assert.equal(await page.locator('.editor:not(.editor-secondary)').isDisabled(), false);
  console.log('PASS inserting from an empty workspace re-enables the editor');

  await page.evaluate(() => {
    window.__7txtTest.load('before', false, true);
    window.__7txtTest.insert(' after');
  });
  await page.waitForFunction(() => (window.__desktopTest.counts.write_file || 0) > 0);
  assert.equal((await state(page)).saved, 'before after');
  await page.evaluate(() => window.__7txtTest.insert(' final'));
  await page.evaluate(() => window.__desktopTest.emit('recovery-close-requested'));
  assert.ok(await page.evaluate(() => window.__desktopTest.last.recovery_save.payload.documents.some(doc => doc.content === 'before after final')));
  assert.ok(await page.evaluate(() => window.__desktopTest.counts.recovery_finish_close > 0));
  console.log('PASS autosave scheduling and close-time recovery captures pending edits');
  await context.close();
}

function median(samples) { const sorted = samples.toSorted((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function p95(samples) { const sorted = samples.toSorted((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * .95)]; }

async function measurements() {
  const trials = Number(values.trials);
  const cases = [
    { name: '200 lines', lines: 200 },
    { name: '20000 lines', lines: 20_000 },
    { name: '20000 lines, split', lines: 20_000, split: true },
    { name: '20000 lines, newline edits', lines: 20_000, newline: true },
    { name: 'Markdown, preview hidden', lines: 2000, markdown: true, preview: false },
    { name: 'Markdown, preview visible', lines: 2000, markdown: true, preview: true },
    { name: '1 MiB wrapped line', text: 'long-line '.repeat(104_858) },
  ];
  const samples = [];
  for (const scenario of cases) {
    if (values.case && scenario.name !== values.case) continue;
    const text = scenario.text || Array.from({ length: scenario.lines }, (_, i) => scenario.markdown
      ? (i % 50 === 0 ? `# Section ${i}` : i % 5 === 0 ? '' : 'A paragraph with **bold** words and `code`.')
      : `Line ${i}: ordinary text with predictable content and wrapping.`).join('\n');
    for (let trial = 0; trial < trials; trial++) {
      const order = trial % 2 ? ['after', 'before'] : ['before', 'after'];
      for (const variant of order) {
        if (variant === 'before' && !original) continue;
        console.log(`Measuring ${scenario.name}: ${variant}, trial ${trial + 1}/${trials}`);
        const { page, context } = await pageFor(variant === 'before' ? original.url : current.url);
        await page.evaluate(({ text, scenario }) => {
          window.__7txtTest.load(text, !!scenario.markdown);
          if (scenario.markdown) window.__7txtTest.preview(!!scenario.preview);
          if (scenario.split) window.__7txtTest.split(true);
        }, { text, scenario });
        await page.waitForTimeout(850);
        let result;
        if (values.input === 'native') {
          await page.evaluate(() => window.__7txtTest.observeInput());
          if (scenario.newline) {
            for (let i = 0; i < 16; i++) await page.keyboard.press('Enter', { delay: 33 });
          } else { await page.keyboard.type('x'.repeat(40), { delay: 33 }); }
          result = await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            const timings = window.__inputTimings;
            return { updates: timings.input.map((value, i) => value + (timings.beforeinput[i] || 0) + (timings.keyup[i] || 0)),
              frames: timings.frames, content: window.__7txtTest.state().content, events: timings };
          });
          assert.equal(result.updates.length, scenario.newline ? 16 : 40);
        } else { result = await page.evaluate(async ({ newline }) => {
          const updates = [], frames = [];
          for (let i = 0; i < (newline ? 16 : 40); i++) {
            await new Promise(requestAnimationFrame);
            const start = performance.now();
            window.__7txtTest.insert(newline ? '\n' : 'x');
            updates.push(performance.now() - start);
            await new Promise(requestAnimationFrame);
            frames.push(performance.now() - start);
          }
          return { updates, frames, content: window.__7txtTest.state().content };
        }, { newline: !!scenario.newline }); }
        assert.equal(result.content, text + (scenario.newline ? '\n'.repeat(16) : 'x'.repeat(40)));
        samples.push({ case: scenario.name, variant, trial: trial + 1, bytes: Buffer.byteLength(text), updates: result.updates, frames: result.frames,
          ...(result.events ? { events: result.events } : {}) });
        await context.close();
      }
    }
  }
  const summary = [];
  for (const scenario of cases) for (const variant of ['before', 'after']) {
    const group = samples.filter(row => row.case === scenario.name && row.variant === variant);
    if (!group.length) continue;
    const updates = group.flatMap(row => row.updates);
    const frames = group.flatMap(row => row.frames);
    summary.push({ case: scenario.name, variant, update_median_ms: median(updates), update_p95_ms: p95(updates), frame_median_ms: median(frames), frame_p95_ms: p95(frames) });
  }
  return { engine: values.engine, browserVersion: browser.version(), input: values.input, trials, desktopBridge: 'mocked; native disk I/O and IPC not measured', samples, summary };
}

try {
  await functionalTests();
  const report = values['tests-only'] ? { engine: values.engine, functionalTests: 'passed' } : await measurements();
  assert.deepEqual(errors, [], 'Browser page errors');
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(resolve(values.out), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report.summary || report, null, 2));
} finally {
  await browser.close();
  await current.server.close();
  if (original) await original.server.close();
}
