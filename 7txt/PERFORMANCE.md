# 7TXT editing performance

Measured on 15 November 2026 on an Apple M2 Mac with 16 GiB RAM.
Engine: headless WebKit 27.2; 3 trials per case, alternating before/after order.

The baseline was captured immediately before this change and already had the 100-version undo limit.
Playwright sends real keyboard events. Update time sums the JavaScript beforeinput, input, and keyup handlers.
Each trial types 40 characters, or inserts 16 newlines. Animation-frame callbacks are measured separately.

| Case | Update median before / after (ms) | Update p95 before / after (ms) | Frame callback median before / after (ms) |
| --- | ---: | ---: | ---: |
| 200 lines | 4.0 / <1 | 5.0 / 1.0 | 7.0 / 5.0 |
| 20000 lines | 70.0 / <1 | 72.0 / 1.0 | 153.0 / 83.0 |
| 20000 lines, split | 226.0 / 93.0 | 234.0 / 95.0 | 348.0 / 215.0 |
| 20000 lines, newline edits | 70.0 / <1 | 74.0 / 1.0 | 71.0 / 24.0 |
| Markdown, preview hidden | 14.0 / <1 | 16.0 / 1.0 | 22.0 / 10.0 |
| Markdown, preview visible | 37.0 / <1 | 38.0 / 1.0 | 46.0 / 10.0 |
| 1 MiB wrapped line | 6.0 / <1 | 6.0 / 1.0 | 37.0 / 31.0 |

WebKit timestamps were quantized to 1 ms, so values below that resolution are reported as <1 ms, not zero cost.
Handler time excludes the browser’s internal text insertion. Frame timing includes browser scheduling/rendering until a callback; it is not hardware-measured input-to-photon latency.
The desktop bridge is mocked. Recovery and autosave timers stay enabled, but native IPC, encoding, filesystem writes, dialogs, total application memory, and Windows runtime performance are not measured here.

## Changes

- Typing updates the document, history, dirty indicator, cursor, and affected line metadata without rebuilding the workbench.
- Tabs and recent-file lists retain their DOM nodes until their structure changes; layout preferences are only persisted when changed.
- A UTF-16 line index supports cursor lookup and line navigation. Gutters only change with the line count; small changes append/remove trailing numbers in place, and native scroll events synchronize them without forcing layout in the input handler.
- Closed split panes release their text and gutter. Opening a split synchronizes the latest document.
- Word counts, outline, and visible Markdown preview coalesce after a 200 ms typing pause. Hidden views refresh when opened; switching tabs invalidates pending work; printing flushes the latest preview.
- Undo remains capped at 100 snapshots. Recovery, conflict checking, and close-time checkpoint behavior remain in place.

## Validation and limits

54 shared unit tests passed, including mixed Unicode/newline edits, 20,000-line index updates, large pastes, stale deferred callbacks, undo, and recovery.
Chromium and WebKit interaction checks cover stable controls, 20,000-line gutter scrolling, split-pane editing, programmatic replacement and multiline insertion, empty-workspace insertion, hidden views, tab switching, responsive layouts, fresh printing, autosave scheduling, and close-time recovery.
Frame timings can remain substantially higher than JavaScript handler times, especially for two visible textareas and long wrapped lines. This change reduces application work; it does not replace the browser’s text layout engine.

See [tests/README.md](tests/README.md) for reproduction and [raw measurements](tests/webkit-performance.json) for all samples.
