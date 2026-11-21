# Editor — 7TXT and Yedit

Two desktop editors built with Tauri and Rust for macOS and Windows:

- **7TXT** is a lightweight text and Markdown editor for everyday files.
- **Yedit** is a source editor for code, diagrams, documents, and structured data.

[Download releases](https://github.com/gokcol/Editor/releases) ·
[7TXT guide](7txt/README.md) · [Platform support and packaging](RELEASING.md)

## Yedit

For quick `.txt` and Markdown editing, the same workspace also contains the
separate lightweight native app in [`7txt`](7txt/README.md). It is intentionally
independent from Yedit, so neither app changes the other.

Yedit is a local, source-first workbench for diagrams, documents, structured data, and everyday programming. It is deliberately a code editor, not a WYSIWYG drawing app: edit sources, render a read-only preview, and export clean assets. The desktop edition uses Tauri with WKWebView on macOS and WebView2 on Windows. See the platform support notes for optional native features.

## What is included

- 30 source modes: TikZ, LaTeX, MetaFont, SVG, Mermaid, Markdown, plain text, YAML, JSON, JavaScript, TypeScript, Python, PHP, Fortran, SQL, HTML, CSS, C, C++, Pascal, Go, Ruby, Bash/shell, C shell, PowerShell, Windows batch, VBScript, Swift, Objective-C/Objective-C++, and Kotlin. Each has offline syntax coloring, source assistance, and safe preview.
- Monaco editor capabilities: multi-cursor editing, find/replace, copy/paste, undo/redo, minimap, bracket guides, source tabs, and offline editor assets—no CDN dependency.
- Project folders and a file tree; source stays in ordinary, portable files. File → New Source, the source submenu, and the `+` tab button open a compact source-format chooser before creating a file or scratch tab.
- Local live previews:
  - TikZ → selectable `pdfLaTeX`, `XeLaTeX`, or `LuaLaTeX` PDF preview
  - LaTeX → selectable `pdfLaTeX`, `XeLaTeX`, or `LuaLaTeX` PDF preview; classic `latex` remains available for DVI builds, whose previews use `dvisvgm` when installed
  - MetaFont → `mf-nowin` GF glyph proof rendered as SVG through `gftodvi` and `dvisvgm`
  - SVG → isolated SVG preview
  - Mermaid → bundled local Mermaid renderer
- Markdown → rendered GitHub-flavored Markdown preview, including locally rendered Mermaid fenced blocks.
- Plain text → escaped, preformatted reading preview; its source is never interpreted as HTML.
- JSON → strict local validation, lossless pretty/minify operations, schema inference, and reviewable AI prompt modes for creating or analyzing JSON, with manual copy/paste or optional Codex handoff.
- Python → Run and standard-library `unittest` Test run the current editor buffer locally without saving; stdout, stderr, status, and the executed command appear in the right-hand Output panel.
- PHP → offline PHP/HTML syntax coloring, snippets, references, and function/class outline for `.php`, `.phtml`, and `.php3`–`.php8` files. Preview/export shows escaped source; it never executes PHP or starts a server. Formatting preserves the source unchanged, including string/heredoc whitespace. PHP is enabled by default; existing custom format selections remain configurable in Settings.
- C/C++, Pascal, Go, Ruby, shell/Windows scripts, Swift, Objective-C, and Kotlin → bundled offline grammars, snippets/references, lightweight declaration outlines, and escaped source preview/export. These are editing modes, not new compilers, interpreters, language servers, or execution permissions. Formatting preserves source exactly, including multiline literals and shell continuations. Shared `.h` headers default to C; `.hpp` and uppercase `.H`/`.C` use C++; `.m`/`.mm` use Objective-C. Shell startup files and Ruby `Gemfile`/`Rakefile` are recognized. SQL also recognizes `.ddl`, `.dml`, and `.dql`; no database connection is opened. Earlier all-enabled defaults gain the new formats once; custom subsets and later opt-outs stay unchanged.
- Project pipelines → when an opened folder has a root-level `build.sh` and/or `build-preview.sh`, Yedit exposes them as explicit local Build project / Build preview tasks. A project can additionally define checked no-shell tasks in `yedit.tasks.json` for build, test, run, lint, or format commands. This is for assembled, multi-file documents such as books: Yedit saves the active source, runs the selected project task, shows its log, and opens a produced PDF in Live Output without trying to compile a chapter fragment by itself.
- Export to PNG, SVG, and PDF, plus DVI for LaTeX and TTF for MetaFont. TikZ and LaTeX use the selected local TeX PDF engine plus Poppler; MetaFont uses `mf2pt1` + FontForge for TTF; SVG/Mermaid use librsvg; Markdown, HTML, plain text, and code/data views export HTML, PNG, or PDF through Yedit's bundled native WebKit exporter.
- Quick Open (`⌘P`) for tabs, project files, symbols (`@query`), and a line (`:42`); project search; searchable, insertable command references; language-aware snippets; outline; formatting; and diagnostics for data and code.
- Session-oriented editing: pin a tab to protect it from accidental closure, restore scratch tabs after restart, and recover one of 32 local source snapshots per file. Markdown also includes a word/character count and an updateable table of contents.
- Local Git workflow: inspect status, diffs, history, and branches; stage or unstage individual files; create a local commit; and switch a listed local branch. Destructive Git operations such as reset, discard, merge, and push are intentionally absent.
- A native-menu-backed command palette, formatting commands, keyboard shortcuts, and local source beautifiers.
- File → Open Recent lists the latest files and folders directly in the native menu. Open Recent in the workbench opens the full local history; clearing history never deletes files.
- Local character-encoding controls for opening and saving: Unicode, ISO-8859, Windows, Mac, Cyrillic, and East Asian codecs are handled without silent character substitution.
- Compact local settings for macOS System/Dark/Light appearance, editor font/size, independent Command deck helper-text size, editor background color and pattern, enabled source types, persistent panel visibility and panel sizes, navigation controls in either the bottom status bar or left activity rail, and an optional editor minimap (off by default).
- Fully toggleable Explorer, Live Preview, and Command deck panels, with draggable dividers and a layout reset control available from Settings, the command palette, and the View menu.
- Prompt Studio: create a precise LLM prompt, copy it to any model, and paste its source-only response back into the editor. The returned source is shown as a local review diff before it can replace or insert anything. No API key or remote service is required.
- Optional Ask AI in both Yedit and 7TXT: send a prompt to the installed Codex companion using ChatGPT sign-in, without an API key. Subscription eligibility and limits apply. Context defaults to none; a captured selection or document is included only when explicitly chosen. Responses are plain, inert text and can be copied or opened as unsaved Markdown drafts. Yedit can also review a response through Prompt Studio. Stop/close cancels the request; there is no automatic document modification or retry. Sessions are ephemeral, run outside projects, and disable command/edit tools, plugins, connectors, hooks, browsing, and host skill discovery. Prompts and chosen context go to OpenAI only on Send. Regular editing, preview, recovery, and manual Prompt Studio remain local and work without AI.
- Safe Mode blocks native compilers, Python, project tasks, and Git changes until the project is explicitly trusted in Settings.

## App updates (next release)

The development versions of both editors include **Check for Updates…** in their app and Help menus, About
panel, and command palette. Direct macOS and Windows installations check GitHub
for their own compatible stable release. Microsoft Store installations check the
Store. **Check automatically once a day** is opt-in and off by default; an available
update produces a small notice instead of interrupting editing. Downloading and
installing remain explicit actions. Failed/offline checks never report that the
app is current.

## Run locally

```bash
npm install
npm run tauri:dev
```

`npm run tauri:dev` starts the native Yedit app. For a production renderer build without opening the app:

```bash
npm run build
```

To generate an unpacked macOS app bundle or distributable artifacts:

```bash
npm run tauri:dir
npm run tauri:mac
```

The first Tauri build compiles the native macOS host; subsequent builds reuse
the Rust build cache. The app bundle is configured for Developer ID signing and
does not submit for notarization.

## Local renderer prerequisites

The app discovers common macOS installation locations automatically. For full export support, install or keep these tools available:

| Source type | Required local tools |
| --- | --- |
| TikZ PDF | one of `pdflatex`, `xelatex`, or `lualatex`; `pdftocairo` for PNG/SVG export |
| LaTeX PDF | one of `pdflatex`, `xelatex`, or `lualatex`; `pdftocairo` for PNG/SVG export |
| LaTeX DVI | `latex`; `dvisvgm` is optional but required for an in-app DVI preview |
| MetaFont proof | `mf-nowin`, `gftodvi`, and `dvisvgm` from TeX Live or MacTeX |
| MetaFont TTF | `mf2pt1` from TeX Live or MacTeX, plus the FontForge CLI (`brew install fontforge`) |
| SVG | `rsvg-convert` for PNG/PDF export |
| Mermaid | No separate CLI — Mermaid is bundled; `rsvg-convert` handles PNG/PDF export |
| Markdown / HTML / code / data / text | No separate CLI — the bundled macOS WebKit exporter creates HTML, PNG, and PDF exports |

PDF TeX compilation is run with `-no-shell-escape` in a temporary directory. Choose `XeLaTeX` or `LuaLaTeX` when a document needs Unicode-first typesetting, `fontspec`, or installed system/OpenType fonts; choose `pdfLaTeX` for conventional PDF workflows. DVI output deliberately uses the classic `latex` engine. MetaFont TTF conversion is best for `mf2pt1`-compatible fonts made from closed `fill`/`unfill` outlines; arbitrary legacy MF programs may need a raster-tracing toolchain instead. The standalone renderers never change a source file.

Project tasks are intentionally not a generic shell runner: Yedit discovers regular, non-symlinked `build.sh` and `build-preview.sh` files at the opened folder's root, and invokes the selected one with `/bin/bash` in that folder. A task is limited to 30 minutes and 24 MB of captured output. Its PDF result is picked from `build/preview`, `build`, or `dist`. `yedit.tasks.json` is a safer alternative for common development commands: each task uses an allow-listed executable plus an argv array—never a shell string, arbitrary executable path, environment override, or project hook. The allowed commands include Node/package-manager, Python/test, Rust, Go, Java, make/just, formatter/linter, TeX, and Fortran tools. Safe Mode disables both forms. Use a project's own documented compiler stack—such as Tectonic for an assembled XeLaTeX book—when it has one.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘⇧P` | Command palette |
| `⌘P` | Quick Open tabs, files, symbols, or line |
| `⌘S` / `⌘⇧S` | Save / Save as |
| `⌘↵` | Render active source |
| `⌘⇧B` | Run the active Python buffer (or the active source build profile) |
| `⌥⇧F` | Format source |
| `⌘E` | Export |
| `⌘⇧R` | Toggle language reference deck |
| `⌘⇧L` | Open Prompt Studio |
| `⌘,` | Open settings |
| `⌘1` / `⌘2` / `⌘3` / `⌘4` / `⌘5` / `⌘6` / `⌘7` | Create a blank TikZ / LaTeX / MetaFont / SVG / Mermaid / Markdown / plain-text source |

## Project format

Projects are plain folders. Creating a project adds only empty `diagrams/`, `documents/`, and `notes/` folders plus a tiny optional `.yedit.json` manifest. Use the explicit Template Gallery when you want starter content; nothing proprietary is required to reopen or edit a project elsewhere.

Create or open **File → Project Tasks…** to add a `yedit.tasks.json` file. The command palette and Task Console refresh it after saving. Example:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "test",
      "label": "Run tests",
      "kind": "test",
      "command": "python3",
      "args": ["-m", "pytest"]
    },
    {
      "id": "lint",
      "label": "Lint source",
      "kind": "lint",
      "command": "ruff",
      "args": ["check", "."]
    }
  ]
}
```

Task IDs begin with a lowercase letter and may contain lowercase letters, digits, `-`, and `_`. Optional `cwd` is a project-relative regular directory. Invalid tasks are not exposed for execution.
