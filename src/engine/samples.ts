import type { SourceType } from '../types';
import { extraSamples } from './extraSources.ts';

export const samples: Record<SourceType, { name: string; source: string }> = {
  ...extraSamples,
  tikz: {
    name: 'Untitled Diagram.tikz',
    source: String.raw`\documentclass[tikz,border=10pt]{standalone}
\usetikzlibrary{arrows.meta,positioning,shapes.geometric}

\begin{document}
\begin{tikzpicture}[
  node distance=24mm,
  every node/.style={font=\sffamily},
  block/.style={draw, rounded corners=6pt, minimum width=30mm, minimum height=12mm, align=center}
]
  \node[block, fill=cyan!14] (source) {Source};
  \node[block, fill=violet!15, right=of source] (output) {Output};
  \draw[-{Stealth[length=3mm]}, very thick, teal!70!black] (source) -- (output);
\end{tikzpicture}
\end{document}
`,
  },
  latex: {
    name: 'Untitled Document.tex',
    source: String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[margin=28mm]{geometry}
\usepackage{amsmath}
\usepackage{hyperref}

\title{A source-first LaTeX document}
\author{Yedit}
\date{\today}

\begin{document}
\maketitle

\section{Purpose}

This is an ordinary \LaTeX{} document. Keep it in version control, compile it
locally, and use the preview only as a read-only check of the generated output.

\section{A small equation}

For a concise display equation, use the math environment:
\[
  E = mc^2.
\]

\subsection{Next steps}

\begin{itemize}
  \item Replace this starter text with your own document.
  \item Add packages deliberately and keep the source portable.
  \item Compile to PDF, or build a DVI preview when your workflow needs it.
\end{itemize}

\end{document}
`,
  },
  metafont: {
    name: 'Foundry Mini.mf',
    source: String.raw`% A tiny MetaFont starter. Render it in proof mode to inspect each glyph.
mode_setup;
font_identifier := "FoundryMini";
font_size 10pt#;

u# := 1/8pt#;
define_pixels(u);

beginchar("A", 8u#, 10u#, 0);
  fill (1u, 0) -- (3u, 0) -- (4u, 3u) -- (5u, 0) -- (7u, 0) -- (4u, 9u) -- cycle;
  unfill (3u, 4u) -- (4u, 6u) -- (5u, 4u) -- cycle;
endchar;

beginchar("O", 8u#, 10u#, 0);
  fill fullcircle xscaled 8u yscaled 10u shifted (4u, 5u);
  unfill fullcircle xscaled 4u yscaled 6u shifted (4u, 5u);
endchar;

bye
`,
  },
  svg: {
    name: 'Untitled Graphic.svg',
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 340" role="img" aria-labelledby="title desc">
  <title id="title">Yedit SVG sample</title>
  <desc id="desc">A source-first SVG sample with a gradient node and arrow.</desc>
  <defs>
    <linearGradient id="gradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#36d8d1" />
      <stop offset="100%" stop-color="#aa8cff" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#07101d" flood-opacity="0.3" />
    </filter>
  </defs>
  <rect width="720" height="340" rx="28" fill="#121827" />
  <rect x="72" y="112" width="190" height="112" rx="18" fill="url(#gradient)" filter="url(#shadow)" />
  <text x="167" y="178" text-anchor="middle" fill="#071821" font-family="system-ui, sans-serif" font-size="26" font-weight="800">SOURCE</text>
  <path d="M310 168h126" stroke="#e6edff" stroke-width="9" stroke-linecap="round" />
  <path d="m412 140 36 28-36 28" fill="none" stroke="#e6edff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" />
  <text x="500" y="181" fill="#f7f8ff" font-family="system-ui, sans-serif" font-size="34" font-weight="800">SVG</text>
</svg>
`,
  },
  mermaid: {
    name: 'Untitled Flow.mmd',
    source: `flowchart LR
  source[Source code] --> render{Render}
  render --> tikz[TikZ]
  render --> svg[SVG]
  render --> mermaid[Mermaid]

  classDef accent fill:#9ff4ed,stroke:#119e9b,color:#08201f,stroke-width:2px
  class render accent
`,
  },
  markdown: {
    name: 'Untitled Notes.md',
    source: `# Diagram notes

> Keep the explanation beside the source, not trapped in a drawing tool.

## Working agreement

- Keep diagrams in **plain text** and version them with the code.
- Use [TikZ](https://tikz.dev), SVG, or Mermaid for the visual artifact.
- Render locally before a review.

## Flow at a glance

\`\`\`mermaid
flowchart LR
  idea[Idea] --> source[Source]
  source --> preview[Preview]
  preview --> export[Export]
\`\`\`

## Useful source links

| Format | Best for |
| --- | --- |
| TikZ | Publication-quality technical figures |
| SVG | Portable vector graphics |
| Mermaid | Fast diagrams alongside documentation |

\`inline code\` and fenced code blocks retain their source-first character.
`,
  },
  text: {
    name: 'Untitled Notes.txt',
    source: `Yedit plain-text note
================================

Use a .txt file when you want portable, unformatted notes alongside your diagrams.

Ideas
-----
- Keep a short rendering checklist.
- Capture labels and terminology before drawing.
- Store command output or review notes without markup.

TODO: Replace this starter text with your own notes.
`,
  },
  yaml: {
    name: 'Untitled Config.yaml',
    source: `# Keep configuration readable, reviewable, and portable.
project:
  name: yedit-example
  version: 1

render:
  theme: system
  formats:
    - svg
    - pdf

workflow:
  preview: true
  autosave: true
`,
  },
  json: {
    name: 'Untitled Data.json',
    source: `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Yedit data sample",
  "version": 1,
  "render": {
    "theme": "system",
    "formats": ["svg", "pdf"]
  },
  "preview": true
}
`,
  },
  javascript: {
    name: 'Untitled Script.js',
    source: `/**
 * A small, dependency-free JavaScript starter.
 */
export function labelFor(format) {
  return format.toUpperCase() + ' source';
}

const formats = ['tikz', 'svg', 'mermaid'];
console.log(formats.map(labelFor));
`,
  },
  typescript: {
    name: 'Untitled Module.ts',
    source: `type RenderTarget = 'svg' | 'pdf' | 'png';

export interface RenderRequest {
  source: string;
  target: RenderTarget;
}

export function describeRequest({ source, target }: RenderRequest): string {
  return 'Render ' + source.length + ' characters as ' + target + '.';
}
`,
  },
  python: {
    name: 'Untitled Script.py',
    source: `from dataclasses import dataclass


@dataclass(frozen=True)
class RenderRequest:
    source: str
    target: str = "svg"


def describe_request(request: RenderRequest) -> str:
    return f"Render {len(request.source)} characters as {request.target}."


if __name__ == "__main__":
    print(describe_request(RenderRequest("diagram source")))
`,
  },
  php: {
    name: 'Untitled Script.php',
    source: `<?php

declare(strict_types=1);

function greet(string $name): string
{
    return "Hello, " . $name . "!";
}

echo greet("Yedit") . PHP_EOL;
`,
  },
  fortran: {
    name: 'Untitled Program.f90',
    source: `program foundry_sample
  implicit none

  character(len=*), parameter :: format = "SVG"
  integer :: width, height

  width = 720
  height = 340
  print '(A,1X,I0,A,I0)', "Rendering", width, " x", height
  print '(A,1X,A)', "Target:", format
end program foundry_sample
`,
  },
  sql: {
    name: 'Untitled Query.sql',
    source: `-- A portable query starter. Adapt identifier quoting for your SQL dialect.
WITH recent_exports AS (
  SELECT
    project_id,
    format,
    created_at
  FROM exports
  WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
)
SELECT
  format,
  COUNT(*) AS export_count
FROM recent_exports
GROUP BY format
ORDER BY export_count DESC;
`,
  },
  html: {
    name: 'Untitled Page.html',
    source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Yedit page</title>
  </head>
  <body>
    <main>
      <h1>Source-first HTML</h1>
      <p>Edit this ordinary document with syntax coloring, references, and a local source formatter.</p>
    </main>
  </body>
</html>
`,
  },
  css: {
    name: 'Untitled Styles.css',
    source: `:root {
  color-scheme: light dark;
  --accent: #119e9b;
  --surface: #101827;
}

.card {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 0.75rem;
  background: var(--surface);
}

@media (width < 42rem) {
  .card {
    padding: 0.75rem;
  }
}
`,
  },
};

export const defaultSource = (type: SourceType) => samples[type].source;
