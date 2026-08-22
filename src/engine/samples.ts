import type { SourceType } from '../types';

export const samples: Record<SourceType, { name: string; source: string }> = {
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
\author{Diagram Foundry}
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
  svg: {
    name: 'Untitled Graphic.svg',
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 340" role="img" aria-labelledby="title desc">
  <title id="title">Diagram Foundry SVG sample</title>
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
    source: `Diagram Foundry plain-text note
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
};

export const defaultSource = (type: SourceType) => samples[type].source;
