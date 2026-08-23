# Diagram Foundry

Diagram Foundry is a local, source-first macOS workbench for **TikZ**, **LaTeX**, **MetaFont**, **SVG**, **Mermaid**, **Markdown**, and **plain text**. It is deliberately a code editor, not a WYSIWYG drawing app: edit sources, render a read-only preview, and export clean assets.

## What is included

- Independent TikZ, LaTeX, MetaFont, SVG, Mermaid, Markdown, and plain-text source modes, each with samples, syntax coloring, references, and a local formatter.
- Monaco editor capabilities: multi-cursor editing, find/replace, copy/paste, undo/redo, minimap, bracket guides, source tabs, and offline editor assets—no CDN dependency.
- Project folders and a file tree; source stays in normal `.tikz`, `.tex`, `.latex`, `.ltx`, `.mf`, `.svg`, `.mmd`, `.mermaid`, `.md`, `.markdown`, or `.txt` files. File → New Source, the source submenu, and the `+` tab button open a compact source-format chooser before creating a file or scratch tab.
- Local live previews:
  - TikZ → selectable `pdfLaTeX`, `XeLaTeX`, or `LuaLaTeX` PDF preview
  - LaTeX → selectable `pdfLaTeX`, `XeLaTeX`, or `LuaLaTeX` PDF preview; classic `latex` remains available for DVI builds, whose previews use `dvisvgm` when installed
  - MetaFont → `mf-nowin` GF glyph proof rendered as SVG through `gftodvi` and `dvisvgm`
  - SVG → isolated SVG preview
  - Mermaid → bundled local Mermaid renderer
- Markdown → rendered GitHub-flavored Markdown preview, including locally rendered Mermaid fenced blocks.
- Plain text → escaped, preformatted reading preview; its source is never interpreted as HTML.
- Export to PNG, SVG, and PDF, plus DVI for LaTeX and TTF for MetaFont. TikZ and LaTeX use the selected local TeX PDF engine plus Poppler; MetaFont uses `mf2pt1` + FontForge for TTF; SVG/Mermaid use librsvg; Markdown and plain text export HTML, PNG, or PDF through the local Electron renderer.
- Searchable, insertable command references for all seven formats.
- A native-menu-backed command palette, formatting commands, keyboard shortcuts, and local source beautifiers.
- Compact local settings for macOS System/Dark/Light appearance, editor font/size, independent Command deck helper-text size, persistent panel visibility, and panel sizes.
- Fully toggleable Explorer, Live Preview, and Command deck panels, with draggable dividers and a layout reset control available from Settings, the command palette, and the View menu.
- Prompt Studio: create a precise LLM prompt, copy it to any model, and paste its source-only response back into the editor. No API key or remote service is required.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` builds the renderer and opens the Electron app. For a production renderer build without opening the app:

```bash
npm run build
```

To generate an unpacked macOS app bundle or distributable artifacts:

```bash
npm run package:dir
npm run package:mac
```

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
| Markdown | No separate CLI — the bundled renderer creates PNG/PDF exports |
| Plain text | No separate CLI — the bundled renderer creates HTML, PNG, and PDF exports |

PDF TeX compilation is run with `-no-shell-escape` in a temporary directory. Choose `XeLaTeX` or `LuaLaTeX` when a document needs Unicode-first typesetting, `fontspec`, or installed system/OpenType fonts; choose `pdfLaTeX` for conventional PDF workflows. DVI output deliberately uses the classic `latex` engine. MetaFont TTF conversion is best for `mf2pt1`-compatible fonts made from closed `fill`/`unfill` outlines; arbitrary legacy MF programs may need a raster-tracing toolchain instead. The app never changes a source file while rendering.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘⇧P` | Command palette |
| `⌘S` / `⌘⇧S` | Save / Save as |
| `⌘↵` | Render active source |
| `⌥⇧F` | Format source |
| `⌘E` | Export |
| `⌘⇧R` | Toggle language reference deck |
| `⌘⇧L` | Open Prompt Studio |
| `⌘,` | Open settings |
| `⌘1` / `⌘2` / `⌘3` / `⌘4` / `⌘5` / `⌘6` / `⌘7` | Create a blank TikZ / LaTeX / MetaFont / SVG / Mermaid / Markdown / plain-text source |

## Project format

Projects are plain folders. Creating a project adds only empty `diagrams/`, `documents/`, and `notes/` folders plus a tiny optional `.diagram-foundry.json` manifest. Use the explicit Template Gallery when you want starter content; nothing proprietary is required to reopen or edit a project elsewhere.
