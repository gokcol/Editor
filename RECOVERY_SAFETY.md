# Save conflicts and local recovery

Yedit and 7TXT remain native Tauri apps. Recovery checkpoints stay in each
app's private application-data directory under `recovery/`; no network service
or account is involved. Browser-only Yedit previews use localStorage instead.

## Behavior

- Normal Save/autosave requires the byte version returned by the last native
  read or acknowledged write. Missing targets are never recreated. Changed
  bytes return `SAVE_CONFLICT`, including edits with unchanged size and mtime.
- A conflict pauses autosave. Comparing alone does not resume it. Use disk,
  Keep mine, and Save As are explicit decisions. Keep mine checks the reviewed
  version again at write time; a newer external edit blocks it.
- Dirty text is checkpointed before normal source writes. Recovered dirty
  buffers reopen without a writable source binding and offer Save As.
- Native checkpoints use a private temporary file, sync, rename, and directory
  sync. The UI reports success only after acknowledgement. Writes are ordered;
  closing/quitting waits for a stable, current snapshot.
- Recovery errors are visible. Existing unreadable checkpoints are preserved.
  Save As remains available even when recovery storage fails. Closing after a
  failed checkpoint requires an explicit warning confirmation.
- There is no silent tab-count/content truncation. A checkpoint above 256 MB
  fails visibly; save documents elsewhere to reduce the recovery set.

This is not a filesystem lock against an unrelated process writing at the
same instant. Source writes are synced but are not atomic file replacements.
A crash before the debounce/checkpoint acknowledgement can lose the newest
keystrokes; an acknowledged checkpoint protects the captured text.

## Automated checks

From the repository root (frontend tests use Node 22.18+):

```sh
npm test
npm run build
npm --prefix 7txt run build:web
CARGO_TARGET_DIR=/tmp/diagram-foundry-validation-target cargo test --manifest-path src-tauri/Cargo.toml -q
CARGO_TARGET_DIR=/tmp/diagram-foundry-validation-target cargo test --manifest-path 7txt/src-tauri/Cargo.toml -q
```

Use a temporary npm cache for dependency installation and remove generated
build/dependency directories after validation when disk space is constrained.

## Native acceptance checklist before release

1. Edit a saved file in each app, then modify it externally. Verify Save and
   autosave do not overwrite the external text. Compare, cancel, switch tabs,
   and wait: the original must remain paused.
2. Choose Keep mine, and verify it saves the intended buffer. Modify the file
   again while reviewing; the older reviewed version must not authorize it.
3. Delete/move a dirty saved file. Confirm a dirty, unpinned recovered draft
   remains and the old pathname is not recreated. Repeat with a genuine saved
   empty file named `untitled.txt` and with a Yedit project file.
4. Quit immediately after editing, reopen, and verify the recovery text and
   Save As action. Repeat with multiple large drafts and Unicode encodings.
5. Make recovery storage unwritable in an isolated test profile. Verify the
   error is visible, ordinary autosave stops, Save As still works, and Cancel
   on the close warning leaves the window open.
6. Close/discard all test drafts and restart. An empty checkpoint must not
   resurrect previously closed text. Verify untouched default tabs do not
   accumulate.

Run native checks against a separate test build/profile, not the installed
production apps or real documents. Web previews cannot validate native file
dialogs, Quit/close IPC, or app-private recovery persistence.
