# 7TXT

7TXT is Yedit's deliberately small, independent companion: a desktop editor for macOS and Windows
for `.txt`, `.md`, and `.markdown` files.

[Download releases](https://github.com/gokcol/Editor/releases).
See [platform support](../RELEASING.md) for installers, signing, and optional features.

It provides local open/save, recent files, undo/redo, find, cursor and document
statistics, Markdown outline navigation, safe local Markdown preview, and an
explicit encoding selector for UTF, ISO-8859, Windows, Mac, Cyrillic, and East
Asian text files. It
does not load remote content or include project pipelines, diagram renderers,
or a heavyweight code editor runtime.

Undo retains the most recent 100 document versions per tab, including the current
version (up to 99 undo steps). Editing after undo discards the abandoned redo
branch.

Typing updates the document and dirty indicator immediately. Word counts,
Markdown outline, and the visible Markdown preview refresh after a 200 ms typing
pause. Opening a panel, switching documents, or printing refreshes the relevant
view immediately. Closed split panes do not keep a second copy of the text.

Use **File → Open Recent**, the **Open Recent** button beside Open, or the command
palette to reopen files from the same local history shown in the sidebar. The
menu also works with the sidebar hidden or in Zen mode. **Clear Recent Items**
clears only this history; saved files, open tabs, and recovery data remain intact.

An optional **Ask AI** toolbar button sends a prompt through the installed Codex
companion with ChatGPT sign-in (no API key; subscription limits apply). Only the
prompt and explicitly chosen captured text are sent to OpenAI. Replies can be
copied or opened as new unsaved Markdown drafts; existing files are never edited
automatically. Stop or close cancels a request. All ordinary editor features
remain local and work without AI. Install a current Codex CLI or the ChatGPT
desktop companion, then use Sign in with ChatGPT in Ask AI if needed.

## Run or build

From this folder:

```sh
npm run dev
npm run build
```

The scripts use the workspace's already-installed Tauri, TypeScript, and Vite
packages. Run `npm install` in the parent workspace first if those are absent.

`npm run build` produces `src-tauri/target/release/bundle/macos/7TXT.app`.
