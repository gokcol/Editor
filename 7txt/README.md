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

Markdown tabs offer **Source**, **Split**, and **Preview**. Preview opens read-only.
Select **Edit** in the preview header to edit the formatted document with an icon
toolbar for headings, emphasis, links, lists, tasks, quotes, code, and tables.
Select **Done** to return to reading. Switching modes leaves the Markdown source
intact. Visual edits save as ordinary Markdown and share the tab's undo history.
Visual editing uses Source as a fallback for unsupported syntax or files above
3,000 lines or 200,000 characters.

In visual editing, right-click a table or list item for its context commands,
or press Shift+F10 at the caret. Click a link to edit its text or address, remove
the link, or open a web or email address. Use the magnifying glass or Cmd/Ctrl+F
to find and replace visible text while staying in the formatted editor.

Use **Open → Open Recent**, **File → Open Recent**, or the command palette to
reopen files from the same local history shown in the sidebar. Hover or click
**Open** for Open File / Open Recent, and **New tab** for Text / Markdown.
The toolbar has one Save button beside these menus; Save As remains in File
and the command palette, with its existing keyboard shortcut. File → Open Recent
and the command palette also work with the sidebar hidden or in Zen mode. **Clear Recent Items**
clears only this history; saved files, open tabs, and recovery data remain intact.

An optional **Ask AI** toolbar button sends a prompt through the installed Codex
companion with ChatGPT sign-in (no API key; subscription limits apply). Only the
prompt and explicitly chosen captured text are sent to OpenAI. Replies can be
copied or opened as new unsaved Markdown drafts; existing files are never edited
automatically. Stop or close cancels a request. All ordinary editor features
remain local and work without AI. Install a current Codex CLI or the ChatGPT
desktop companion, then use Sign in with ChatGPT in Ask AI if needed.

## App updates

Starting with version 1.0.2, use **7TXT → Check for Updates…**, **Help → Check for Updates…**, About, or the
command palette to check for a newer compatible release. Direct Mac and Windows
downloads use GitHub; Microsoft Store installations use the Store. Optional daily
checks are off by default. Downloads open in your browser when requested and are
never installed automatically.

## Run or build

From this folder:

```sh
npm run dev
npm run build
```

The scripts use the workspace's already-installed Tauri, TypeScript, and Vite
packages. Run `npm install` in the parent workspace first if those are absent.

`npm run build` produces `src-tauri/target/release/bundle/macos/7TXT.app`.
