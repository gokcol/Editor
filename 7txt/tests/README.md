# 7TXT editing regression checks

`npm test` at the workspace root includes line-index, deferred-work, undo, and
recovery tests. `npm --prefix 7txt run build:web` checks the production renderer.

The browser runner exercises the actual editor with a test-only desktop bridge.
It checks stable tabs/gutters, Unicode and split-pane edits, undo/redo, deferred
preview/outline updates, switching tabs, responsive layouts, printing freshness,
autosave scheduling, and close-time recovery. It does not send AI requests or
read/write user documents. Native IPC, filesystem timings, and OS dialogs are not
covered by this runner.

Install Playwright outside the workspace; no new production dependency is needed:

```sh
npm install --prefix /tmp/7txt-browser-tests playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/7txt-browser-tests/browsers node /tmp/7txt-browser-tests/node_modules/playwright/cli.js install webkit
```

On macOS, Chromium tests use the installed Google Chrome by default. Otherwise
pass `--executable /path/to/chrome` or install Playwright's Chromium browser.

```sh
node 7txt/tests/editor.browser.mjs --playwright-module /tmp/7txt-browser-tests/node_modules/playwright/index.mjs --tests-only
PLAYWRIGHT_BROWSERS_PATH=/tmp/7txt-browser-tests/browsers node 7txt/tests/editor.browser.mjs --playwright-module /tmp/7txt-browser-tests/node_modules/playwright/index.mjs --engine webkit --tests-only
```

For before/after measurements, supply a saved copy of the earlier `src/main.ts`.
The runner loads that source through Vite with the same assets and test bridge;
it does not modify production files. Without `--baseline`, only the current
implementation is measured. Each case runs three trials by default, alternating
the order of the two implementations.

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/7txt-browser-tests/browsers node 7txt/tests/editor.browser.mjs --playwright-module /tmp/7txt-browser-tests/node_modules/playwright/index.mjs --engine webkit --baseline /path/to/baseline-main.ts --out /tmp/7txt-webkit-results.json
```

Cases cover 200 and 20,000 lines, visible split panes, newline insertion,
Markdown with its preview hidden/visible, and a 1 MiB wrapped line. By default,
Playwright sends actual keyboard events. Capture/bubble listeners time the app's
beforeinput/input/keyup handlers and the next animation-frame callback. The
browser's internal text insertion is outside the handler measurement. Use
`--input synthetic` to include programmatic `setRangeText` replacement cost, or
`--case '20000 lines' --trials 1` for a focused check. These are browser measurements, not hardware input
latency or complete Tauri application benchmarks. Recovery/autosave timers stay
enabled; their desktop bridge calls are mocked. A full native benchmark must
measure real IPC and filesystem work separately.

The debug bridge is appended by the test runner's Vite transform. Production
builds do not contain the mock or the test API.

After recording to `7txt/tests/webkit-performance.json`, run
`node 7txt/tests/report-performance.mjs` to regenerate `7txt/PERFORMANCE.md`.
