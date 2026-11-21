import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import type * as MonacoEditor from 'monaco-editor';
import mermaid from 'mermaid';
import packageMetadata from '../package.json';
import { samples } from './engine/samples';
import { CODE_SOURCE_TYPES, SOURCE_TYPES, SOURCE_TYPES_VERSION, SOURCE_FILENAME_PATTERN, normalizedEnabledSourceTypes, sourceTypeForName } from './engine/sourceTypes';
import { EXTRA_SOURCE_META, EXTRA_SOURCE_TYPES, isExtraSourceType } from './engine/extraSources';
import { formatSource } from './engine/formatters';
import { markdownPreviewDocument, renderMarkdownSource, type PreviewAppearance } from './engine/markdown';
import { registerFoundryLanguages } from './engine/monacoLanguages';
import { references } from './engine/references';
import { readSnapshots, rememberSnapshot, type LocalSnapshot } from './engine/localHistory';
import { formatJson, inferJsonSchema, inspectJson, minifyJson } from './engine/jsonTools';
import { compactPath, documentOutline, findInSource, fuzzyScore, sourceFromAssistantReply, sourceReviewDiff, textStatistics, upsertMarkdownTableOfContents } from './engine/workbench';
import PreviewViewport, { type PreviewBackground } from './components/PreviewViewport';
import type { DesktopApi } from './desktop/contract';
import { createRecoveryQueue, flushStableRecovery } from '../shared/recoveryQueue';
import { confirmTabClose, isCloseProtected } from '../shared/tabClose';
import { isCloseConfirmationOpen, showCloseConfirmation } from '../shared/closeConfirmation';
import { splitFileName } from '../shared/fileName';
import { createRecentMenuSync, recentMenuEntryId, recentMenuItems } from '../shared/recentMenu';
import { isAskAiOpen, showAskAi } from '../shared/askAi';
import { createUpdateController, isUpdatesOpen } from '../shared/updates';
import type { AppSettings, CharacterEncoding, DecodedSourceFile, DocumentModel, ExportFormat, FileNode, OpenedSourceFile, PreviewState, Project, ProjectTask, ProjectTaskResult, PythonRunResult, RecentEntry, ReferenceEntry, SourceType, TexPdfEngine } from './types';

// Resolve Monaco against the real renderer document. A relative `./vs` turns
// into `file:///vs` inside a packaged desktop worker, which makes Monaco fall
// back to the UI thread and can freeze a busy editor.
const monacoVsUrl = new URL('./vs/', window.location.href).toString().replace(/\/$/, '');
loader.config({ paths: { vs: monacoVsUrl } });

const SOURCE_META: Record<SourceType, { label: string; short: string; color: string; language: string; extension: string }> = {
  ...EXTRA_SOURCE_META,
  tikz: { label: 'TikZ', short: 'TZ', color: 'amber', language: 'foundry-tikz', extension: 'tikz' },
  latex: { label: 'LaTeX', short: 'TEX', color: 'indigo', language: 'foundry-latex', extension: 'tex' },
  metafont: { label: 'MetaFont', short: 'MF', color: 'mint', language: 'foundry-metafont', extension: 'mf' },
  svg: { label: 'SVG', short: 'SV', color: 'violet', language: 'foundry-svg', extension: 'svg' },
  mermaid: { label: 'Mermaid', short: 'MM', color: 'cyan', language: 'foundry-mermaid', extension: 'mmd' },
  markdown: { label: 'Markdown', short: 'MD', color: 'rose', language: 'foundry-markdown', extension: 'md' },
  text: { label: 'Plain Text', short: 'TXT', color: 'slate', language: 'foundry-text', extension: 'txt' },
  yaml: { label: 'YAML', short: 'YML', color: 'mint', language: 'foundry-yaml', extension: 'yaml' },
  json: { label: 'JSON', short: 'JSN', color: 'indigo', language: 'foundry-json', extension: 'json' },
  javascript: { label: 'JavaScript', short: 'JS', color: 'amber', language: 'foundry-javascript', extension: 'js' },
  typescript: { label: 'TypeScript', short: 'TS', color: 'indigo', language: 'foundry-typescript', extension: 'ts' },
  python: { label: 'Python', short: 'PY', color: 'cyan', language: 'foundry-python', extension: 'py' },
  php: { label: 'PHP', short: 'PHP', color: 'violet', language: 'foundry-php', extension: 'php' },
  fortran: { label: 'Fortran', short: 'F90', color: 'violet', language: 'foundry-fortran', extension: 'f90' },
  sql: { label: 'SQL', short: 'SQL', color: 'mint', language: 'foundry-sql', extension: 'sql' },
  html: { label: 'HTML', short: 'HTML', color: 'rose', language: 'foundry-html', extension: 'html' },
  css: { label: 'CSS', short: 'CSS', color: 'violet', language: 'foundry-css', extension: 'css' },
};
const SOURCE_DESCRIPTIONS: Record<SourceType, string> = {
  ...Object.fromEntries(EXTRA_SOURCE_TYPES.map((type) => [type, `${EXTRA_SOURCE_META[type].label} source (editing only)`])) as Record<typeof EXTRA_SOURCE_TYPES[number], string>,
  tikz: 'LaTeX-quality diagrams',
  latex: 'Standalone TeX documents',
  metafont: 'Programmatic font source',
  svg: 'Editable vector markup',
  mermaid: 'Text-first flow diagrams',
  markdown: 'Notes with rich preview',
  text: 'Portable notes and raw text',
  yaml: 'Readable configuration data',
  json: 'Strict structured data',
  javascript: 'Modern JavaScript source',
  typescript: 'Typed JavaScript source',
  python: 'Python source and scripts',
  php: 'PHP source and templates (no execution)',
  fortran: 'Scientific source (.f, .for, .f90, .f95+)',
  sql: 'Queries and migrations',
  html: 'Semantic web documents',
  css: 'Stylesheets and design tokens',
};
const DEFAULT_ENABLED_SOURCE_TYPES = [...SOURCE_TYPES];
// Templates are complete starting points. Keep this gallery focused on the
// source formats where a starter carries meaningful structure; all formats
// remain available as empty files from New Source.
const TEMPLATE_SOURCE_TYPES: SourceType[] = ['tikz', 'latex', 'metafont', 'svg', 'mermaid', 'markdown', 'yaml', 'json', 'html'];
const SOURCE_PREVIEW_TYPES = new Set<SourceType>(['text', 'yaml', 'json', ...CODE_SOURCE_TYPES.filter((type) => type !== 'html')]);
const PROJECT_TASKS_FILENAME = 'yedit.tasks.json';
const PROJECT_TASKS_TEMPLATE = `{
  "version": 1,
  "tasks": [
    {
      "id": "test",
      "label": "Run tests",
      "kind": "test",
      "command": "python3",
      "args": ["-m", "pytest"]
    }
  ]
}
`;

// The package manifest is bundled with the renderer at build time. Keep a
// guarded display value so a malformed development manifest cannot make the
// About panel misleading or render an arbitrary value.
const APP_VERSION = typeof packageMetadata.version === 'string'
  && /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(packageMetadata.version)
  ? packageMetadata.version
  : 'development';
const COPYRIGHT_YEAR = new Date().getFullYear();
const ABOUT_DEPENDENCIES = [
  { name: 'React and React DOM', license: 'MIT', purpose: 'interface runtime' },
  { name: 'Monaco Editor', license: 'MIT', purpose: 'code editing' },
  { name: 'Mermaid', license: 'MIT', purpose: 'diagram rendering' },
  { name: 'Marked', license: 'MIT', purpose: 'Markdown parsing' },
  { name: 'DOMPurify', license: 'MPL-2.0 or Apache-2.0', purpose: 'HTML sanitization' },
  { name: 'TypeScript and Vite', license: 'Apache-2.0 / MIT', purpose: 'build tooling' },
] as const;
type HelpTopic = 'getting-started' | 'shortcuts';
const RELEASE_HISTORY = [
  {
    version: '1.0.0',
    label: 'Current release',
    title: 'A complete local workbench',
    description: 'Yedit 1.0 turns the early source editor into a dependable daily workspace for technical writing, diagrams, data, and code.',
    highlights: [
      'Open folders or individual files, restore your workspace, and keep source in ordinary portable files.',
      'Edit LaTeX, TikZ, MetaFont, Markdown, JSON, YAML, Python, Fortran, web files, and plain text with language-aware editing.',
      'Build and inspect local output: XeLaTeX and LuaLaTeX PDFs, MetaFont proofs and TTF conversion, Python run/test output, and exportable previews.',
      'Fine-tune the workspace with source-type controls, autosave, encoding choices, adjustable panels, editor canvas styling, and configurable shortcuts.',
    ],
  },
  {
    version: '0.3.3',
    label: 'Previous release',
    title: 'The preview foundation',
    description: 'The last pre-1.0 build established Yedit as a local-first source editor with project folders, previews, settings, and a native menu surface.',
    highlights: [
      'A focused source editor and companion preview for visual checking.',
      'Local preferences, project navigation, and a compact workflow for everyday files.',
    ],
  },
] as const;

const EMPTY_PREVIEW: PreviewState = { status: 'idle', revision: -1 };
const DEFAULT_SETTINGS: AppSettings = {
  appearance: 'system',
  uiScale: 110,
  editorFontFamily: 'SF Mono',
  editorFontSize: 14,
  editorBackgroundColor: 'theme',
  editorBackgroundPattern: 'none',
  referenceFontSize: 10,
  autoSave: true,
  safeMode: false,
  formatOnSave: false,
  previewAutoRender: true,
  editorWordWrap: true,
  editorMinimap: false,
  editorTabSize: 2,
  navigationPlacement: 'bottom',
  explorerOpen: true,
  previewOpen: true,
  referenceOpen: true,
  explorerWidth: 245,
  inspectorWidth: 390,
  previewSplit: 54,
  enabledSourceTypes: DEFAULT_ENABLED_SOURCE_TYPES,
  sourceTypesVersion: SOURCE_TYPES_VERSION,
};
const EDITOR_FONTS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono'];
const EDITOR_BACKGROUND_PATTERNS: Array<{ value: AppSettings['editorBackgroundPattern']; label: string; description: string }> = [
  { value: 'none', label: 'Plain', description: 'Solid canvas' },
  { value: 'grid', label: 'Grid', description: 'Fine square grid' },
  { value: 'dots', label: 'Dots', description: 'Subtle dot field' },
  { value: 'lines', label: 'Lines', description: 'Writing lines' },
];
const CHARACTER_ENCODINGS: Array<{ value: CharacterEncoding; label: string }> = [
  { value: 'auto', label: 'Auto detect (UTF-8 / BOM / Windows-1252)' },
  { value: 'utf-8', label: 'UTF-8' }, { value: 'utf-8-bom', label: 'UTF-8 with BOM' },
  { value: 'utf-16le', label: 'UTF-16 Little Endian' }, { value: 'utf-16le-bom', label: 'UTF-16 Little Endian with BOM' }, { value: 'utf-16be', label: 'UTF-16 Big Endian' }, { value: 'utf-16be-bom', label: 'UTF-16 Big Endian with BOM' },
  { value: 'windows-1252', label: 'Western: Windows-1252 / ISO-8859-1' }, { value: 'windows-1250', label: 'Central European: Windows-1250' }, { value: 'windows-1251', label: 'Cyrillic: Windows-1251' }, { value: 'windows-1253', label: 'Greek: Windows-1253' }, { value: 'windows-1254', label: 'Turkish: Windows-1254 / ISO-8859-9' }, { value: 'windows-1255', label: 'Hebrew: Windows-1255' }, { value: 'windows-1256', label: 'Arabic: Windows-1256' }, { value: 'windows-1257', label: 'Baltic: Windows-1257' }, { value: 'windows-1258', label: 'Vietnamese: Windows-1258' }, { value: 'windows-874', label: 'Thai: Windows-874 / ISO-8859-11' },
  ...[2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 15, 16].map((number) => ({ value: `iso-8859-${number}`, label: `ISO-8859-${number}` })),
  { value: 'iso-8859-8-i', label: 'ISO-8859-8-I (Hebrew visual)' },
  { value: 'macintosh', label: 'Mac Roman' }, { value: 'x-mac-cyrillic', label: 'Mac Cyrillic' }, { value: 'koi8-r', label: 'KOI8-R' }, { value: 'koi8-u', label: 'KOI8-U' }, { value: 'ibm866', label: 'IBM866 / DOS Cyrillic' },
  { value: 'shift_jis', label: 'Shift_JIS (Japanese)' }, { value: 'euc-jp', label: 'EUC-JP (Japanese)' }, { value: 'iso-2022-jp', label: 'ISO-2022-JP (Japanese)' }, { value: 'euc-kr', label: 'EUC-KR (Korean)' }, { value: 'big5', label: 'Big5 (Traditional Chinese)' }, { value: 'gbk', label: 'GBK (Simplified Chinese)' }, { value: 'gb18030', label: 'GB18030 (Chinese)' },
];

function encodingLabel(value?: CharacterEncoding) {
  return CHARACTER_ENCODINGS.find((entry) => entry.value === value)?.label ?? value ?? 'UTF-8';
}
type PanelLayout = Pick<AppSettings, 'explorerOpen' | 'previewOpen' | 'referenceOpen' | 'explorerWidth' | 'inspectorWidth' | 'previewSplit'>;
type PanelLayoutKey = keyof PanelLayout;
type PanelResizeTarget = 'explorer' | 'inspector' | 'preview';
const WORKBENCH_RAIL_WIDTH = 43;
const WORKBENCH_MIN_EDITOR_WIDTH = 360;
const WORKBENCH_MIN_EXPLORER_WIDTH = 180;
const WORKBENCH_MAX_EXPLORER_WIDTH = 480;
const WORKBENCH_MIN_INSPECTOR_WIDTH = 280;
const WORKBENCH_MAX_INSPECTOR_WIDTH = 760;
// The native traffic-light controls float above the transparent title bar.
// Keep their hit targets unobstructed, but anchor the brand to the real left
// edge rather than reserving a broad faux title column.
const MACOS_TITLEBAR_LEADING_INSET = 18;
const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  explorerOpen: DEFAULT_SETTINGS.explorerOpen,
  previewOpen: DEFAULT_SETTINGS.previewOpen,
  referenceOpen: DEFAULT_SETTINGS.referenceOpen,
  explorerWidth: DEFAULT_SETTINGS.explorerWidth,
  inspectorWidth: DEFAULT_SETTINGS.inspectorWidth,
  previewSplit: DEFAULT_SETTINGS.previewSplit,
};

function panelLayoutFromSettings(settings: AppSettings): PanelLayout {
  return {
    explorerOpen: settings.explorerOpen,
    previewOpen: settings.previewOpen,
    referenceOpen: settings.referenceOpen,
    explorerWidth: settings.explorerWidth,
    inspectorWidth: settings.inspectorWidth,
    previewSplit: settings.previewSplit,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isKnownSourceType(value: string): value is SourceType {
  return SOURCE_TYPES.includes(value as SourceType);
}

function editorCanvasColor(color: string, appearance: PreviewAppearance) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return appearance === 'light' ? '#fbfcff' : '#111622';
}

/**
 * The application shell is intentionally scaled as one unit for the Interface
 * scale preference. That means a 1,024px window at 110% has roughly 931px of
 * logical workspace. Keep persisted panel preferences intact, but temporarily
 * fit their rendered widths into that logical workspace so the whole editor
 * never needs a horizontal scrollbar.
 */
function workbenchColumns(
  viewportWidth: number,
  interfaceScale: number,
  navigationRailWidth: number,
  explorerVisible: boolean,
  inspectorVisible: boolean,
  explorerPreference: number,
  inspectorPreference: number,
) {
  const logicalWidth = Math.max(0, Math.floor(viewportWidth / Math.max(interfaceScale, 0.01)));
  const sideBudget = Math.max(0, logicalWidth - navigationRailWidth - WORKBENCH_MIN_EDITOR_WIDTH);
  let explorerWidth = explorerVisible
    ? clamp(explorerPreference, WORKBENCH_MIN_EXPLORER_WIDTH, WORKBENCH_MAX_EXPLORER_WIDTH)
    : 0;
  let inspectorWidth = inspectorVisible
    ? clamp(inspectorPreference, WORKBENCH_MIN_INSPECTOR_WIDTH, WORKBENCH_MAX_INSPECTOR_WIDTH)
    : 0;
  const preferredSideWidth = explorerWidth + inspectorWidth;

  if (preferredSideWidth > sideBudget) {
    const minimumExplorer = explorerVisible ? WORKBENCH_MIN_EXPLORER_WIDTH : 0;
    const minimumInspector = inspectorVisible ? WORKBENCH_MIN_INSPECTOR_WIDTH : 0;
    const minimumSideWidth = minimumExplorer + minimumInspector;

    if (sideBudget >= minimumSideWidth) {
      // The preview/reference deck is the least disruptive panel to compact
      // first: navigation remains stable while the code editor retains room.
      let reduction = preferredSideWidth - sideBudget;
      const inspectorReduction = Math.min(reduction, inspectorWidth - minimumInspector);
      inspectorWidth -= inspectorReduction;
      reduction -= inspectorReduction;
      explorerWidth -= Math.min(reduction, explorerWidth - minimumExplorer);
    } else if (minimumSideWidth > 0) {
      // On an unusually small logical window, share the remaining space
      // between visible side panels instead of letting either force overflow.
      explorerWidth = explorerVisible
        ? Math.min(explorerWidth, Math.round(sideBudget * (minimumExplorer / minimumSideWidth)))
        : 0;
      inspectorWidth = inspectorVisible
        ? Math.min(inspectorWidth, Math.max(0, sideBudget - explorerWidth))
        : 0;
    }
  }

  return {
    explorerWidth,
    inspectorWidth,
    compressed: preferredSideWidth > sideBudget,
  };
}

/**
 * Ordinary new files deliberately start with no boilerplate.  Starter source
 * belongs to the template gallery, where choosing a complete example is
 * explicit rather than a surprise in a newly-created tab.
 */
function makeBlankDocument(type: SourceType = 'text'): DocumentModel {
  return {
    id: `${type}-${crypto.randomUUID()}`,
    name: `untitled.${SOURCE_META[type].extension}`,
    sourceType: type,
    value: '',
    encoding: 'utf-8',
    dirty: false,
    revision: 0,
    defaultUntitled: true,
  };
}

function makeStarterDocument(type: SourceType): DocumentModel {
  const sample = samples[type];
  return {
    id: `${type}-${crypto.randomUUID()}`,
    name: sample.name,
    sourceType: type,
    value: sample.source,
    encoding: 'utf-8',
    dirty: false,
    revision: 0,
  };
}

function filenameWithoutExtension(name: string) {
  return name.replace(/\.[^/.]+$/, '') || 'diagram';
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => node.kind === 'directory' ? flattenFiles(node.children ?? []) : [node]);
}

function folderPaths(nodes: FileNode[]): Set<string> {
  const paths = new Set<string>();
  const visit = (items: FileNode[]) => {
    for (const item of items) {
      if (item.kind !== 'directory') continue;
      paths.add(item.relativePath);
      visit(item.children ?? []);
    }
  };
  visit(nodes);
  return paths;
}

function parentFolderPath(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function ancestorFolderPaths(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

// File watchers commonly report the directory that changed rather than every
// file below it. An empty/`.` path denotes the project root itself.
function projectPathWasChanged(relativePath: string, changedPaths: Set<string>) {
  const normalizedPath = relativePath.split('/').filter((part) => part && part !== '.').join('/');
  return [...changedPaths].some((changedPath) => {
    const normalizedChange = changedPath.split('/').filter((part) => part && part !== '.').join('/');
    return !normalizedChange
      || normalizedPath === normalizedChange
      || normalizedPath.startsWith(`${normalizedChange}/`);
  });
}

function sanitizeSvg(svg: string) {
  return svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function previewDocument(svg: string, appearance: PreviewAppearance) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: ${appearance}; }
    html, body { min-height: 100%; margin: 0; background: transparent; }
    body { display: grid; place-items: center; padding: 28px; box-sizing: border-box; }
    svg { width: min(100%, 980px); height: auto; max-height: 100%; overflow: visible; }
  </style></head><body>${sanitizeSvg(svg)}</body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character] ?? character));
}

/** A safe, readable document view; it never interprets source as markup. */
function sourcePreviewDocument(source: string, label: string, appearance: PreviewAppearance, detail?: string) {
  const isLight = appearance === 'light';
  const page = isLight ? '#f8fbff' : '#111722';
  const card = isLight ? '#ffffff' : '#171f2d';
  const edge = isLight ? '#d9e3ee' : '#2a3850';
  const ink = isLight ? '#25364b' : '#dce7f7';
  const muted = isLight ? '#68798f' : '#92a1b8';
  const lineNumber = source ? source.split('\n').length : 0;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: ${appearance}; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; background: ${page}; }
    body { padding: clamp(20px, 5vw, 52px); color: ${ink}; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(920px, 100%); min-height: calc(100vh - 40px); margin: 0 auto; padding: clamp(18px, 3vw, 34px); border: 1px solid ${edge}; border-radius: 14px; background: ${card}; box-shadow: 0 14px 38px rgba(20, 35, 58, ${isLight ? '.08' : '.28'}); }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid ${edge}; color: ${muted}; font-size: 12px; }
    header strong { color: ${ink}; font-size: 13px; }
    pre { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; tab-size: 2; color: ${ink}; font: 14px/1.7 "SF Mono", Menlo, Monaco, Consolas, monospace; }
  </style></head><body><main><header><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail ?? `${lineNumber} ${lineNumber === 1 ? 'line' : 'lines'}`)}</span></header><pre>${escapeHtml(source)}</pre></main></body></html>`;
}

/** A safe, readable document view for raw .txt content; it never interprets source as markup. */
function textPreviewDocument(source: string, appearance: PreviewAppearance) {
  return sourcePreviewDocument(source, 'Plain text', appearance);
}

function jsonPreviewDocument(source: string, appearance: PreviewAppearance) {
  const result = inspectJson(source);
  return sourcePreviewDocument(result.valid ? formatJson(source) ?? source : source, 'JSON', appearance, result.message);
}

let configuredMermaidAppearance: PreviewAppearance | undefined;
async function renderMermaidSource(source: string, appearance: PreviewAppearance) {
  if (configuredMermaidAppearance !== appearance) {
    const isLight = appearance === 'light';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      flowchart: { htmlLabels: false, curve: 'basis' },
      themeVariables: {
        background: isLight ? '#fbfcff' : '#10131b',
        primaryColor: isLight ? '#b8f0ec' : '#9ff4ed',
        primaryTextColor: isLight ? '#073d43' : '#071c21',
        primaryBorderColor: isLight ? '#078d8b' : '#139e9a',
        lineColor: isLight ? '#5b6980' : '#9caed2',
        secondaryColor: isLight ? '#dfd4ff' : '#c8bbff',
        tertiaryColor: isLight ? '#edf2fa' : '#1a2132',
        fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      },
    });
    configuredMermaidAppearance = appearance;
  }
  const id = `foundry-mermaid-${crypto.randomUUID().replaceAll('-', '')}`;
  const result = await mermaid.render(id, source);
  return result.svg;
}

type ToastTone = 'info' | 'success' | 'error';
type Toast = { tone: ToastTone; text: string } | null;
type LatexRenderMode = 'pdf' | 'dvi';
type JsonPromptIntent = 'create' | 'analyze' | 'schema';
type PythonTaskMode = 'run' | 'test';
type PythonTaskStatus = 'idle' | 'running' | 'success' | 'error' | 'unavailable';
type PythonTaskState = {
  documentId?: string;
  revision?: number;
  name?: string;
  mode?: PythonTaskMode;
  status: PythonTaskStatus;
  stdout: string;
  stderr: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
};
type CursorLocation = {
  line: number;
  column: number;
};
type EditorRangeSnapshot = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};
const EMPTY_PYTHON_TASK: PythonTaskState = {
  status: 'idle',
  stdout: '',
  stderr: '',
};
const TEX_PDF_ENGINES = [
  { id: 'pdflatex', label: 'pdfLaTeX', description: 'Fast, broadly compatible PDF output' },
  { id: 'xelatex', label: 'XeLaTeX', description: 'Unicode and system-font PDF output' },
  { id: 'lualatex', label: 'LuaLaTeX', description: 'Unicode and Lua-enabled PDF output' },
] as const satisfies ReadonlyArray<{ id: TexPdfEngine; label: string; description: string }>;

const TEX_PDF_ENGINE_LABEL: Record<TexPdfEngine, string> = Object.fromEntries(
  TEX_PDF_ENGINES.map(({ id, label }) => [id, label]),
) as Record<TexPdfEngine, string>;

function texPdfEngineLabel(engine: TexPdfEngine) {
  return TEX_PDF_ENGINE_LABEL[engine];
}

function projectTaskForIntent(tasks: ProjectTask[], intent: 'build' | 'preview') {
  const expression = intent === 'build'
    ? /\b(?:build|compile|make)\b/i
    : /\b(?:preview|view|watch|open)\b/i;
  return tasks.find((task) => expression.test(`${task.id} ${task.label} ${task.kind || ''} ${task.description}`));
}

function projectTaskTooltip(task: ProjectTask) {
  const source = task.command || task.script;
  return `${task.description}${source ? ` · ${source}` : ''}`;
}

function projectTaskConsoleText(result: ProjectTaskResult) {
  const location = result.outputRelativePath || result.outputPath;
  const parts = [
    `${result.ok ? '✓' : '✕'} ${result.label}`,
    result.output?.trim(),
    location ? `Output: ${location}` : '',
    result.error?.trim(),
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n\n') || (result.ok ? `${result.label} completed.` : `${result.label} did not finish.`);
}

function pythonTaskStatusLabel(task: PythonTaskState) {
  if (task.status === 'running') return task.mode === 'test' ? 'Testing…' : 'Running…';
  if (task.status === 'success') return task.mode === 'test' ? 'Tests passed' : 'Finished';
  if (task.status === 'unavailable') return 'Runner unavailable';
  if (task.timedOut) return 'Timed out';
  if (task.status === 'error') return task.mode === 'test' ? 'Tests failed' : 'Failed';
  return 'Ready';
}

function pythonTaskConsoleText(task: PythonTaskState) {
  if (task.status === 'idle') return 'No Python task has run for this source yet.';
  const parts = [
    `${task.mode === 'test' ? 'Python test' : 'Python run'} · ${pythonTaskStatusLabel(task)}`,
    task.command ? `$ ${task.command}` : '',
    task.stdout ? `stdout\n${task.stdout}` : '',
    task.stderr ? `stderr\n${task.stderr}` : '',
    typeof task.exitCode === 'number' ? `Exit code: ${task.exitCode}` : '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

type ProjectSearchHit = { node: FileNode; line: number; column: number; excerpt: string };
type GitFileStatus = { path: string; index?: string; workingTree?: string; status?: string };
type GitInfo = { branch?: string; branches?: string[]; files?: GitFileStatus[]; commits?: { hash: string; subject: string; author?: string; date?: string }[]; available?: boolean; message?: string };
type QuickOpenResult = { id: string; label: string; detail: string; kind: 'tab' | 'file' | 'symbol' | 'line'; run: () => void };
type ProjectTabSession = {
  relativePath: string;
  encoding?: CharacterEncoding;
  pinned?: boolean;
};
type WorkbenchSession = {
  projectRoot?: string;
  projectTabs?: ProjectTabSession[];
  activeProjectPath?: string;
  collapsedPaths?: string[];
  selectedFolderPath?: string;
  zenMode?: boolean;
  latexPreviewMode?: LatexRenderMode;
  texPdfEngine?: TexPdfEngine;
  previewBackground?: PreviewBackground;
  pythonInspectorView?: 'output' | 'source';
};
type SaveTarget = {
  id: string;
  relativePath?: string;
  fileHandle?: string;
  projectRoot?: string;
  generation: number;
};

const LEGACY_RECENT_PROJECTS_KEY = 'diagram-foundry:recent-projects';
const LEGACY_RECENT_PROJECTS_MIGRATION_KEY = 'yedit:recents-native-migration-v1';
const PALETTE_HISTORY_KEY = 'diagram-foundry:palette-history';
const SHORTCUTS_KEY = 'diagram-foundry:shortcuts';
const SCRATCH_SESSION_KEY = 'yedit:scratch-session-v1';
const WORKBENCH_SESSION_KEY = 'yedit:workspace-session-v1';
// A stable marker returned by the native shell for a standalone file whose
// original location was removed. Keep the broader checks too: project files
// and older packaged shells report the platform's ENOENT wording instead.
const SAVE_TARGET_MISSING_PREFIX = 'SAVE_TARGET_MISSING:';
const MAX_RESTORED_PROJECT_TABS = 30;
// Fixed-size tabs stay easy to scan. When the strip fills, each step is a
// modest reduction; after the last step, the strip scrolls instead of shrinking
// source names into illegibility.
const TAB_WIDTHS = [220, 190, 168] as const;
const TAB_GAP = 5;
const SHORTCUT_ACTIONS = [
  ['quickOpen', 'Quick Open'],
  ['palette', 'Command palette'],
  ['prompt', 'Prompt Studio'],
  ['search', 'Find in project'],
  ['outline', 'Document outline'],
  ['zen', 'Zen mode'],
  ['build', 'Run active source build'],
] as const;
type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number][0];
type ShortcutBindings = Record<ShortcutActionId, string>;
const PRIMARY_MODIFIER = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Ctrl';
const DEFAULT_SHORTCUTS: ShortcutBindings = {
  quickOpen: `${PRIMARY_MODIFIER}+P`,
  palette: `${PRIMARY_MODIFIER}+Shift+P`,
  prompt: `${PRIMARY_MODIFIER}+Shift+L`,
  search: `${PRIMARY_MODIFIER}+Shift+F`,
  outline: `${PRIMARY_MODIFIER}+Shift+O`,
  zen: `${PRIMARY_MODIFIER}+Shift+Z`,
  build: `${PRIMARY_MODIFIER}+Shift+B`,
};

function historyScope(document: DocumentModel) {
  const root = document.projectRoot;
  return root && document.relativePath ? `${root}:${document.relativePath}` : `scratch:${document.id}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSaveTargetError(error: unknown) {
  const message = errorMessage(error);
  return message.startsWith(SAVE_TARGET_MISSING_PREFIX)
    || /(?:no such file(?: or directory)?|os error 2|enoent|source file is no longer available|saved file was moved or deleted)/i.test(message);
}

function isSaveConflict(error: unknown) { return errorMessage(error).startsWith('SAVE_CONFLICT:'); }

function isEmptyDefaultUntitledDocument(document: Pick<DocumentModel, 'name' | 'sourceType' | 'value' | 'relativePath' | 'fileHandle' | 'pinned' | 'recoveryDraft' | 'defaultUntitled'>) {
  return document.defaultUntitled === true
    && document.name.toLocaleLowerCase() === `untitled.${SOURCE_META[document.sourceType].extension}`
    && !document.pinned
    && !document.recoveryDraft
    && !document.value
    && !document.relativePath
    && !document.fileHandle;
}

function sameSaveTarget(
  document: Pick<DocumentModel, 'id' | 'relativePath' | 'projectRoot' | 'fileHandle'>,
  target: Pick<SaveTarget, 'id' | 'relativePath' | 'projectRoot' | 'fileHandle'>,
) {
  return document.id === target.id
    && document.relativePath === target.relativePath
    && document.projectRoot === target.projectRoot
    && document.fileHandle === target.fileHandle;
}

function displayTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(timestamp);
}

function legacyRecentProjects() {
  try {
    const loaded: unknown = JSON.parse(window.localStorage.getItem(LEGACY_RECENT_PROJECTS_KEY) || '[]');
    if (!Array.isArray(loaded)) return [];
    return loaded.filter((item): item is Pick<Project, 'root' | 'name'> => (
      Boolean(item) && typeof item === 'object' && typeof (item as Project).root === 'string' && typeof (item as Project).name === 'string'
    )).slice(0, 12);
  } catch {
    return [];
  }
}

function restoredScratchSession(fallback: DocumentModel, durable?: unknown): { documents: DocumentModel[]; activeId: string; restored: boolean } {
  try {
    const parsed: unknown = durable ?? JSON.parse(window.localStorage.getItem(SCRATCH_SESSION_KEY) || '{}');
    const candidate = parsed && typeof parsed === 'object' ? parsed as { documents?: unknown; activeId?: unknown } : {};
    if (!Array.isArray(candidate.documents)) return { documents: [fallback], activeId: fallback.id, restored: false };
    const documents = candidate.documents
      .filter((value): value is {
        id: string;
        name: string;
        sourceType: SourceType;
        value: string;
        revision?: unknown;
        pinned?: unknown;
        recoveryDraft?: unknown;
        defaultUntitled?: unknown;
        encoding?: CharacterEncoding;
        recoveryOrigin?: string;
        relativePath?: string;
        projectRoot?: string;
      } => (
        Boolean(value)
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).id === 'string'
        && typeof (value as Record<string, unknown>).name === 'string'
        && typeof (value as Record<string, unknown>).value === 'string'
        && typeof (value as Record<string, unknown>).sourceType === 'string'
        && SOURCE_TYPES.includes((value as Record<string, unknown>).sourceType as SourceType)
      ))
      .map((value) => ({
        id: value.id,
        name: value.name,
        sourceType: value.sourceType as SourceType,
        value: value.value,
        encoding: value.encoding,
        recoveryOrigin: value.recoveryOrigin ?? (value.relativePath ? `${value.projectRoot || ''}/${value.relativePath}` : undefined),
        dirty: true,
        revision: typeof value.revision === 'number' && Number.isFinite(value.revision) ? Math.max(0, Math.round(value.revision)) : 0,
        pinned: !(value.relativePath || value.recoveryOrigin) && value.pinned === true,
        recoveryDraft: durable !== undefined || value.recoveryDraft === true,
        defaultUntitled: value.defaultUntitled === true,
      }))
      // A previous version could preserve its untouched launch tab as a
      // recovery draft. It has no work to recover, so restore a fresh,
      // clean fallback instead of making the user dismiss it on every launch.
      .filter((document) => !isEmptyDefaultUntitledDocument(document));
    if (!documents.length) return { documents: [fallback], activeId: fallback.id, restored: false };
    const requestedActive = typeof candidate.activeId === 'string' ? candidate.activeId : '';
    return { documents, activeId: documents.some((document) => document.id === requestedActive) ? requestedActive : documents[0].id, restored: true };
  } catch {
    return { documents: [fallback], activeId: fallback.id, restored: false };
  }
}

function isProjectSessionPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4_096
    && !value.includes('\0')
    && !value.startsWith('/')
    && !value.split(/[\\/]+/).includes('..');
}

function readWorkbenchSession(): WorkbenchSession {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(WORKBENCH_SESSION_KEY) || '{}');
    const candidate = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const rawTabs = Array.isArray(candidate.projectTabs) ? candidate.projectTabs : [];
    const projectTabs = rawTabs
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
      .filter((value) => isProjectSessionPath(value.relativePath))
      .slice(0, MAX_RESTORED_PROJECT_TABS)
      .map((value) => ({
        relativePath: value.relativePath as string,
        ...(typeof value.encoding === 'string' && value.encoding ? { encoding: value.encoding } : {}),
        ...(value.pinned === true ? { pinned: true } : {}),
      }));
    const rawCollapsed = Array.isArray(candidate.collapsedPaths) ? candidate.collapsedPaths : [];
    const collapsedPaths = rawCollapsed.filter(isProjectSessionPath).slice(0, 1_000);
    const projectRoot = typeof candidate.projectRoot === 'string' && candidate.projectRoot.length > 0 && candidate.projectRoot.length <= 4_096
      ? candidate.projectRoot
      : undefined;
    const latexPreviewMode = candidate.latexPreviewMode === 'dvi' || candidate.latexPreviewMode === 'pdf'
      ? candidate.latexPreviewMode
      : undefined;
    const texPdfEngine = candidate.texPdfEngine === 'pdflatex' || candidate.texPdfEngine === 'xelatex' || candidate.texPdfEngine === 'lualatex'
      ? candidate.texPdfEngine
      : undefined;
    const previewBackground = candidate.previewBackground === 'grid' || candidate.previewBackground === 'checkerboard' || candidate.previewBackground === 'solid'
      ? candidate.previewBackground
      : undefined;
    const pythonInspectorView = candidate.pythonInspectorView === 'output' || candidate.pythonInspectorView === 'source'
      ? candidate.pythonInspectorView
      : undefined;
    return {
      ...(projectRoot ? { projectRoot } : {}),
      ...(projectTabs.length ? { projectTabs } : {}),
      ...(isProjectSessionPath(candidate.activeProjectPath) ? { activeProjectPath: candidate.activeProjectPath } : {}),
      ...(collapsedPaths.length ? { collapsedPaths } : {}),
      ...(isProjectSessionPath(candidate.selectedFolderPath) ? { selectedFolderPath: candidate.selectedFolderPath } : {}),
      ...(typeof candidate.zenMode === 'boolean' ? { zenMode: candidate.zenMode } : {}),
      ...(latexPreviewMode ? { latexPreviewMode } : {}),
      ...(texPdfEngine ? { texPdfEngine } : {}),
      ...(previewBackground ? { previewBackground } : {}),
      ...(pythonInspectorView ? { pythonInspectorView } : {}),
    };
  } catch {
    return {};
  }
}

function rememberWorkbenchSession(session: WorkbenchSession) {
  try {
    window.localStorage.setItem(WORKBENCH_SESSION_KEY, JSON.stringify(session));
  } catch {
    // The project itself and native preferences remain fully usable if local
    // browser storage is unavailable or has reached its quota.
  }
}

function sourceFilenameForDrop(name: string, type: SourceType) {
  // Preserve custom extensions such as `.dat` when a text file is dropped.
  // Its detected source mode may be plain text, but the filename is still
  // meaningful to the project that owns it.
  return name.trim() || `untitled.${SOURCE_META[type].extension}`;
}

type UniversalIconName = 'outline' | 'table-of-contents' | 'history' | 'encoding' | 'pin' | 'undo' | 'redo' | 'save' | 'save-as' | 'format' | 'render';

function UniversalIcon({ name }: { name: UniversalIconName }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.8 };
  const paths = (() => {
    switch (name) {
      case 'outline': return <><path {...common} d="M6 6h2M11 6h7M6 12h2M11 12h7M6 18h2M11 18h7" /></>;
      case 'table-of-contents': return <><path {...common} d="M5 5h14v14H5zM5 10h14M5 15h14M10 5v14M15 5v14" /></>;
      case 'history': return <><circle {...common} cx="12" cy="12" r="7" /><path {...common} d="M12 8v4l3 2M5 8V4m0 0h4M5 4a9 9 0 1 1-1 10" /></>;
      case 'encoding': return <><path {...common} d="m8 9-3 3 3 3M16 9l3 3-3 3M14 6l-4 12" /></>;
      case 'pin': return <><path {...common} d="M8 4h8l-1.5 5 3.5 3H6l3-3zM12 12v8" /></>;
      case 'undo': return <><path {...common} d="m9 7-4 4 4 4M5 11h7a6 6 0 0 1 6 6" /></>;
      case 'redo': return <><path {...common} d="m15 7 4 4-4 4M19 11h-7a6 6 0 0 0-6 6" /></>;
      case 'save': return <><path className="universal-icon-fill" d="M5 3h12l3 3v15H5z" /><path {...common} d="M5 3h12l3 3v15H5zM8 3v6h8V3M8 20v-6h8v6" /></>;
      case 'save-as': return <><path {...common} d="M6 3h8l4 4v14H6zM14 3v5h5M10 18l6.4-6.4 2 2L12 20l-3 1z" /></>;
      case 'format': return <><path {...common} d="M5 6h14M5 10h9M5 14h14M5 18h9M16 9l1 1 2-2" /></>;
      case 'render': return <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none" />;
    }
  })();
  return <svg className="universal-icon" viewBox="0 0 24 24" aria-hidden="true">{paths}</svg>;
}

function lineFromRenderMessage(message?: string) {
  if (!message) return undefined;
  const match = /(?:line\s*|l\.\s*)(\d+)/i.exec(message) || /:(\d+):(?:\d+:)?/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function shortcutFromEvent(event: KeyboardEvent) {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key === ' ' ? 'Space' : event.key;
  return [event.metaKey && 'Meta', event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

function shortcutLabel(shortcut: string) {
  return shortcut.replaceAll('Meta', '⌘').replaceAll('Ctrl', '⌃').replaceAll('Alt', '⌥').replaceAll('Shift', '⇧').replaceAll('+', '');
}

function recoveryPayload(documents: DocumentModel[], activeId: string) {
  return { activeId, documents: documents.filter((document) => (
    !isEmptyDefaultUntitledDocument(document)
    && (document.dirty || (!document.relativePath && !document.fileHandle))
  )).map(({ fileHandle: _permission, ...document }) => ({
    ...document,
    recoveryOrigin: document.recoveryOrigin ?? (document.relativePath ? `${document.projectRoot || ''}/${document.relativePath}` : _permission ? document.name : undefined),
  })) };
}

function App({ desktop, initialRecovery, recoveryLoadError }: { desktop: DesktopApi; initialRecovery?: unknown; recoveryLoadError?: string }) {
  const initialDocument = useMemo(() => makeBlankDocument(), []);
  const initialScratchSession = useMemo(() => restoredScratchSession(initialDocument, initialRecovery), [initialDocument, initialRecovery]);
  const recoveryQueue = useMemo(() => createRecoveryQueue(desktop.recovery.save), [desktop]);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveryWarning, setRecoveryWarning] = useState(recoveryLoadError ? `Recovery unavailable: ${recoveryLoadError}` : '');
  const [conflictReview, setConflictReview] = useState<{ target: SaveTarget; disk: DecodedSourceFile; value: string; revision: number } | null>(null);
  const initialWorkbenchSession = useMemo(() => readWorkbenchSession(), []);
  const [project, setProject] = useState<Project | null>(null);
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([]);
  const [isProjectTasksLoading, setIsProjectTasksLoading] = useState(false);
  const [projectTaskRefreshVersion, setProjectTaskRefreshVersion] = useState(0);
  const [documents, setDocuments] = useState<DocumentModel[]>(initialScratchSession.documents);
  const [activeId, setActiveId] = useState(initialScratchSession.activeId);
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  const [latexPreviewMode, setLatexPreviewMode] = useState<LatexRenderMode>(initialWorkbenchSession.latexPreviewMode ?? 'pdf');
  const [texPdfEngine, setTexPdfEngine] = useState<TexPdfEngine>(initialWorkbenchSession.texPdfEngine ?? 'pdflatex');
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(DEFAULT_PANEL_LAYOUT);
  const [promptOpen, setPromptOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [encodingOpen, setEncodingOpen] = useState(false);
  const [openingEncoding, setOpeningEncoding] = useState<CharacterEncoding>('auto');
  const [encodingChoice, setEncodingChoice] = useState<CharacterEncoding>('utf-8');
  const [newSourceOpen, setNewSourceOpen] = useState(false);
  const [newSourceName, setNewSourceName] = useState('untitled.txt');
  const [newSourceType, setNewSourceType] = useState<SourceType>('text');
  const [isCreatingSource, setIsCreatingSource] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [referenceQuery, setReferenceQuery] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [workspaceSessionReady, setWorkspaceSessionReady] = useState(false);
  const [systemAppearance, setSystemAppearance] = useState<PreviewAppearance>(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set(initialWorkbenchSession.collapsedPaths ?? []));
  // The selected folder is both a visible navigation location and the default
  // destination for the next project file created from the explorer.
  const [selectedFolderPath, setSelectedFolderPath] = useState(initialWorkbenchSession.selectedFolderPath ?? '');
  const [promptSpec, setPromptSpec] = useState({
    goal: '',
    audience: '',
    style: 'Clean technical diagram, restrained modern palette, clear hierarchy',
    constraints: '',
    jsonIntent: 'create' as JsonPromptIntent,
    outputOnly: true,
    includeActiveFile: false,
    includeProjectContext: true,
    includeRenderError: true,
  });
  const [isExporting, setIsExporting] = useState(false);
  const [exportScale, setExportScale] = useState<1 | 2 | 4>(2);
  const [promptReply, setPromptReply] = useState('');
  const [promptApplyMode, setPromptApplyMode] = useState<'replace' | 'insert' | 'new'>('replace');
  const [pendingAiReview, setPendingAiReview] = useState<{
    documentId: string;
    documentValue: string;
    documentName: string;
    sourceType: SourceType;
    mode: 'replace' | 'insert' | 'new';
    before: string;
    source: string;
    range?: EditorRangeSnapshot;
  } | null>(null);
  const [selectionSource, setSelectionSource] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<LocalSnapshot[]>([]);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectSearchHits, setProjectSearchHits] = useState<ProjectSearchHit[]>([]);
  const [isProjectSearching, setIsProjectSearching] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState('');
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const updateChecker = useRef<ReturnType<typeof createUpdateController> | null>(null);
  useEffect(() => {
    const checker = createUpdateController(desktop.updates, {
      appName: 'Yedit', installedVersion: APP_VERSION,
      releaseNotes: 'Local source editing with 30 language modes and offline assets. Windows native file identity checks, Unicode saving, and durable draft recovery. Updated preview dependencies.',
      canNotify: () => !document.querySelector<HTMLElement>('.app-shell')?.inert && !isCloseConfirmationOpen() && !isAskAiOpen(),
    });
    updateChecker.current = checker; checker.start();
    return () => { checker.dispose(); updateChecker.current = null; };
  }, [desktop]);
  const openUpdates = useCallback(() => {
    setAboutOpen(false); setHelpTopic(null); setWhatsNewOpen(false); setPaletteOpen(false);
    updateChecker.current?.show();
  }, []);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [isGitLoading, setIsGitLoading] = useState(false);
  const [isGitMutating, setIsGitMutating] = useState(false);
  const [gitCommitMessage, setGitCommitMessage] = useState('');
  const [taskConsoleOpen, setTaskConsoleOpen] = useState(false);
  const [taskOutput, setTaskOutput] = useState('No local task has run in this session.');
  const [isTaskRunning, setIsTaskRunning] = useState(false);
  const [pythonTask, setPythonTask] = useState<PythonTaskState>(EMPTY_PYTHON_TASK);
  const [pythonInspectorView, setPythonInspectorView] = useState<'output' | 'source'>(initialWorkbenchSession.pythonInspectorView ?? 'output');
  const [outputViewerOpen, setOutputViewerOpen] = useState(false);
  const [outputViewerFullscreen, setOutputViewerFullscreen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentEntry[]>([]);
  const [recentProjectsOpen, setRecentProjectsOpen] = useState(false);
  const recentDialogRef = useRef<HTMLElement | null>(null);
  const syncRecentMenu = useMemo(() => createRecentMenuSync(desktop.recents.syncMenu), [desktop]);

  useEffect(() => {
    void syncRecentMenu(recentMenuItems(recentProjects)).catch((error) => {
      console.warn('Could not update Open Recent:', error);
    });
  }, [recentProjects, syncRecentMenu]);

  useEffect(() => {
    if (!recentProjectsOpen) return;
    const dialog = recentDialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (dialog.querySelector<HTMLElement>('.recent-open-button') || dialog.querySelector<HTMLElement>('.recent-close-button'))?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setRecentProjectsOpen(false);
      } else if (event.key === 'Tab') {
        const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
      else editorRef.current?.focus();
    };
  }, [recentProjectsOpen]);

  useEffect(() => {
    const dialog = recentDialogRef.current;
    // Clearing history or removing its focused row can remove the focused button.
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>('.recent-close-button')?.focus();
    }
  }, [recentProjects, recentProjectsOpen]);

  const [paletteHistory, setPaletteHistory] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(PALETTE_HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(() => {
    try { return { ...DEFAULT_SHORTCUTS, ...JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY) || '{}') }; } catch { return DEFAULT_SHORTCUTS; }
  });
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutActionId | null>(null);
  const [zenMode, setZenMode] = useState(initialWorkbenchSession.zenMode ?? false);
  const [dragActive, setDragActive] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>(initialWorkbenchSession.previewBackground ?? 'grid');
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [cursorLocation, setCursorLocation] = useState<CursorLocation>({ line: 1, column: 1 });
  const [openTabsMenuOpen, setOpenTabsMenuOpen] = useState(false);
  const [tabWidth, setTabWidth] = useState<number>(TAB_WIDTHS[0]);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ id: string; placement: 'before' | 'after' } | null>(null);

  const changeEditorFontSize = useCallback((delta: number) => {
    setSettings((current) => ({
      ...current,
      editorFontSize: clamp(current.editorFontSize + delta, 11, 24),
    }));
  }, []);

  const openAbout = useCallback(() => {
    setHelpTopic(null);
    setWhatsNewOpen(false);
    setAboutOpen(true);
  }, []);

  const openHelp = useCallback((topic: HelpTopic) => {
    setAboutOpen(false);
    setWhatsNewOpen(false);
    setHelpTopic(topic);
  }, []);

  const openWhatsNew = useCallback(() => {
    setAboutOpen(false);
    setHelpTopic(null);
    setWhatsNewOpen(true);
  }, []);

  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const appBodyRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const renderTokenRef = useRef(0);
  const metafontRenderInFlightRef = useRef(false);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const panelLayoutRef = useRef(panelLayout);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  const documentsRef = useRef(documents);
  const projectRootRef = useRef(project?.root);
  // A project task/build may outlive a folder switch. Its results must never
  // update the newly opened project's console or preview.
  const projectOperationGenerationRef = useRef(0);
  // Startup restoration and project hydration may read from disk for long
  // enough that the user opens or edits a document first. A synchronous epoch
  // lets those background operations yield to that newer interaction.
  const documentInteractionEpochRef = useRef(0);
  // Keep the launch baseline rather than sampling after a user interaction:
  // an early Finder/open event must also supersede deferred restoration.
  const initialWorkspaceRestoreEpochRef = useRef(documentInteractionEpochRef.current);
  // Only one fresh-tab read may adopt a given project binding at a time.
  const projectFileReadReservationsRef = useRef(new Set<string>());
  const saveTargetGenerationsRef = useRef(new Map<string, number>());
  const documentWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  // Autosave must not advance a target generation while an explicit Save or
  // Save As sheet is still pending for the same document.
  const manualSaveInFlightRef = useRef(new Set<string>());
  const localWritePathsRef = useRef(new Map<string, number>());
  const pendingRevealLineRef = useRef<number | null>(null);
  const externalOpenQueueRef = useRef(Promise.resolve());
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const openTabsPopoverRef = useRef<HTMLDivElement | null>(null);
  const workspaceRestoreStartedRef = useRef(false);
  const tabDragRef = useRef<{ id: string; pointerId: number; startX: number; dragging: boolean } | null>(null);
  const suppressTabActivateRef = useRef<string | null>(null);

  const reorderDocuments = useCallback((movedId: string, targetId: string, before: boolean) => {
    if (movedId === targetId) return;
    setDocuments((current) => {
      const moving = current.find((document) => document.id === movedId);
      if (!moving || !current.some((document) => document.id === targetId)) return current;
      const next = current.filter((document) => document.id !== movedId);
      let targetIndex = next.findIndex((document) => document.id === targetId);
      if (targetIndex < 0) return current;
      if (!before) targetIndex += 1;
      next.splice(targetIndex, 0, moving);
      return next;
    });
  }, []);

  const beginTabDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.tab-close'))) return;
    tabDragRef.current = { id, pointerId: event.pointerId, startX: event.clientX, dragging: false };
  }, []);

  const activateTab = useCallback((id: string) => {
    if (suppressTabActivateRef.current === id) {
      suppressTabActivateRef.current = null;
      return;
    }
    setActiveId(id);
  }, []);

  useEffect(() => {
    const clearDropTarget = () => {
      setDraggingTabId(null);
      setTabDropTarget(null);
    };
    const tabAtPointer = (event: PointerEvent) => document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-editor-tab-id]');
    const trackDrag = (event: PointerEvent) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.dragging && Math.abs(event.clientX - drag.startX) < 7) return;
      drag.dragging = true;
      event.preventDefault();
      setDraggingTabId(drag.id);
      const target = tabAtPointer(event);
      const targetId = target?.dataset.editorTabId;
      if (!target || !targetId || targetId === drag.id) {
        setTabDropTarget(null);
        return;
      }
      const bounds = target.getBoundingClientRect();
      setTabDropTarget({ id: targetId, placement: event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after' });
    };
    const finishDrag = (event: PointerEvent) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      tabDragRef.current = null;
      if (!drag.dragging) {
        clearDropTarget();
        return;
      }
      event.preventDefault();
      suppressTabActivateRef.current = drag.id;
      if (event.type !== 'pointercancel') {
        const target = tabAtPointer(event);
        const targetId = target?.dataset.editorTabId;
        if (target && targetId && targetId !== drag.id) {
          const bounds = target.getBoundingClientRect();
          reorderDocuments(drag.id, targetId, event.clientX < bounds.left + bounds.width / 2);
        }
      }
      clearDropTarget();
    };
    window.addEventListener('pointermove', trackDrag, true);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', finishDrag, true);
    return () => {
      window.removeEventListener('pointermove', trackDrag, true);
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', finishDrag, true);
    };
  }, [reorderDocuments]);

  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const updateWidth = () => {
      const tabCount = Math.max(documents.length, 1);
      const availableWidth = tabs.clientWidth;
      const requiredWidth = (candidate: number) => tabCount * candidate + Math.max(0, tabCount - 1) * TAB_GAP;
      const nextWidth = TAB_WIDTHS.find((candidate) => requiredWidth(candidate) <= availableWidth)
        ?? TAB_WIDTHS[TAB_WIDTHS.length - 1];
      setTabWidth((current) => current === nextWidth ? current : nextWidth);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(tabs);
    window.addEventListener('resize', updateWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [documents.length]);

  useEffect(() => {
    if (!openTabsMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !openTabsPopoverRef.current?.contains(event.target)) setOpenTabsMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenTabsMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [openTabsMenuOpen]);

  useEffect(() => {
    if (!documents.length) setOpenTabsMenuOpen(false);
  }, [documents.length]);

  useEffect(() => {
    // Monaco rejects an internal cancellation promise while disposing a model
    // during tab/source switches. It is expected, but the packaged app can
    // otherwise surface it as an uncaught renderer error.
    const ignoreMonacoCancellation = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      if (reason?.name === 'Canceled' || message === 'Canceled: Canceled') event.preventDefault();
    };
    window.addEventListener('unhandledrejection', ignoreMonacoCancellation);
    return () => window.removeEventListener('unhandledrejection', ignoreMonacoCancellation);
  }, []);
  useEffect(() => () => panelResizeCleanupRef.current?.(), []);
  const activeDocument = documents.find((document) => document.id === activeId) ?? documents[0];
  const effectiveAppearance: PreviewAppearance = settings.appearance === 'system' ? systemAppearance : settings.appearance;
  const interfaceScale = settings.uiScale / 100;
  // The native store validates this setting; keep the browser preview equally
  // resilient to an old or hand-edited localStorage value.
  const navigationPlacement: AppSettings['navigationPlacement'] = settings.navigationPlacement === 'left' ? 'left' : 'bottom';
  const navigationRailVisible = !zenMode && navigationPlacement === 'left';
  const navigationRailWidth = navigationRailVisible ? WORKBENCH_RAIL_WIDTH : 0;
  const explorerVisible = !zenMode && panelLayout.explorerOpen;
  const inspectorOpen = !zenMode && (panelLayout.previewOpen || panelLayout.referenceOpen);
  const renderedWorkbenchColumns = useMemo(() => workbenchColumns(
    viewportWidth,
    interfaceScale,
    navigationRailWidth,
    explorerVisible,
    inspectorOpen,
    panelLayout.explorerWidth,
    panelLayout.inspectorWidth,
  ), [explorerVisible, inspectorOpen, interfaceScale, navigationRailWidth, panelLayout.explorerWidth, panelLayout.inspectorWidth, viewportWidth]);

  // Project tasks are discovered by the trusted native backend. While that
  // lookup is pending, hold LaTeX auto-preview for project files so a chapter
  // is not mistakenly compiled as a standalone fragment before its book
  // pipeline becomes available.
  useEffect(() => {
    let disposed = false;
    if (!project) {
      setProjectTasks([]);
      setIsProjectTasksLoading(false);
      return () => { disposed = true; };
    }

    setProjectTasks([]);
    setIsProjectTasksLoading(true);
    void desktop.project.listTasks(project.root)
      .then((tasks) => {
        if (!disposed) setProjectTasks(tasks);
      })
      .catch(() => {
        // A normal source folder need not have any project automation. Keep
        // the existing one-file build workflow available in that case.
        if (!disposed) setProjectTasks([]);
      })
      .finally(() => {
        if (!disposed) setIsProjectTasksLoading(false);
      });

    return () => { disposed = true; };
  }, [desktop, project?.root, projectTaskRefreshVersion]);

  const activeProjectTasks = useMemo(
    () => project && activeDocument?.relativePath && activeDocument.projectRoot === project.root ? projectTasks : [],
    [activeDocument?.projectRoot, activeDocument?.relativePath, project, projectTasks],
  );
  const availableProjectTasks = project ? projectTasks : [];
  const projectBuildTask = useMemo(
    () => projectTaskForIntent(availableProjectTasks, 'build') ?? availableProjectTasks[0],
    [availableProjectTasks],
  );
  const projectPreviewTask = useMemo(
    () => projectTaskForIntent(availableProjectTasks, 'preview'),
    [availableProjectTasks],
  );
  const projectToolbarTasks = useMemo(() => {
    const preferred = [projectBuildTask, projectPreviewTask].filter((task): task is ProjectTask => Boolean(task));
    return Array.from(new Map([...preferred, ...activeProjectTasks].map((task) => [task.id, task])).values()).slice(0, 2);
  }, [activeProjectTasks, projectBuildTask, projectPreviewTask]);
  const taskManagedLatex = Boolean(
    project
    && activeDocument?.relativePath
    && activeDocument.projectRoot === project.root
    && activeDocument?.sourceType === 'latex'
    && (isProjectTasksLoading || activeProjectTasks.length),
  );

  const showToast = useCallback((text: string, tone: ToastTone = 'info') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ text, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  const refreshRecentProjects = useCallback(async () => {
    const entries = await desktop.recents.list();
    setRecentProjects(entries);
    return entries;
  }, []);

  const showRecentEntries = useCallback(() => {
    if ([...document.querySelectorAll('.modal-backdrop')].some((modal) => !modal.contains(recentDialogRef.current) && !modal.querySelector('.palette-modal'))) {
      showToast('Close the current dialog to open recent items.', 'info');
      return;
    }
    setPaletteOpen(false);
    setRecentProjectsOpen(true);
    void refreshRecentProjects().catch((error) => {
      showToast(error instanceof Error ? error.message : 'Could not load recent items.', 'error');
    });
  }, [refreshRecentProjects, showToast]);

  const clearPanelResizeArtifacts = useCallback(() => {
    panelResizeCleanupRef.current?.();
    // A pointer release that occurs outside the desktop webview can leave an orphaned
    // shield behind. It is intentionally invisible, so remove it explicitly
    // before opening any modal surface as a final safety net.
    document.querySelectorAll('.panel-resize-shield').forEach((element) => element.remove());
    document.body.classList.remove(
      'panel-resizing',
      'panel-resizing-explorer',
      'panel-resizing-inspector',
      'panel-resizing-preview',
    );
  }, []);

  const openOutputViewer = useCallback(() => {
    clearPanelResizeArtifacts();
    setOutputViewerFullscreen(false);
    setOutputViewerOpen(true);
  }, [clearPanelResizeArtifacts]);

  const closeOutputViewer = useCallback(() => {
    setOutputViewerFullscreen(false);
    setOutputViewerOpen(false);
  }, []);

  const enabledSourceTypes = useMemo(
    () => normalizedEnabledSourceTypes(settings.enabledSourceTypes),
    [settings.enabledSourceTypes],
  );
  const availableTemplateSourceTypes = useMemo(
    () => TEMPLATE_SOURCE_TYPES.filter((type) => enabledSourceTypes.includes(type)),
    [enabledSourceTypes],
  );
  const isSourceTypeEnabled = useCallback(
    (type: SourceType) => enabledSourceTypes.includes(type),
    [enabledSourceTypes],
  );
  const defaultCreationSourceType = isSourceTypeEnabled('text') ? 'text' : enabledSourceTypes[0];

  // A preference file from an older build (or one edited by hand) should not
  // leave the workbench with zero creation formats. Persist the repaired value
  // once the normal settings lifecycle has taken over.
  useEffect(() => {
    const normalized = normalizedEnabledSourceTypes(settings.enabledSourceTypes);
    const current = Array.isArray(settings.enabledSourceTypes) ? settings.enabledSourceTypes : [];
    if (current.length === normalized.length && current.every((type, index) => type === normalized[index])) return;
    setSettings((existing) => ({ ...existing, enabledSourceTypes: normalized }));
  }, [settings.enabledSourceTypes]);

  const toggleSourceType = useCallback((type: SourceType) => {
    if (isSourceTypeEnabled(type) && enabledSourceTypes.length === 1) {
      showToast('Keep at least one source type enabled.', 'info');
      return;
    }
    setSettings((current) => {
      const currentEnabled = normalizedEnabledSourceTypes(current.enabledSourceTypes);
      const nextEnabled = currentEnabled.includes(type)
        ? currentEnabled.filter((candidate) => candidate !== type)
        : SOURCE_TYPES.filter((candidate) => currentEnabled.includes(candidate) || candidate === type);
      return { ...current, enabledSourceTypes: nextEnabled };
    });
  }, [enabledSourceTypes.length, isSourceTypeEnabled, showToast]);

  const commitPanelLayout = useCallback((next: PanelLayout) => {
    panelLayoutRef.current = next;
    setPanelLayout(next);
    setSettings((current) => ({ ...current, ...next }));
  }, []);

  const updatePanel = useCallback((key: PanelLayoutKey, value: PanelLayout[PanelLayoutKey]) => {
    commitPanelLayout({ ...panelLayoutRef.current, [key]: value });
  }, [commitPanelLayout]);

  const togglePanel = useCallback((key: 'explorerOpen' | 'previewOpen' | 'referenceOpen') => {
    updatePanel(key, !panelLayoutRef.current[key]);
  }, [updatePanel]);

  const resetPanelLayout = useCallback(() => {
    commitPanelLayout({ ...DEFAULT_PANEL_LAYOUT });
    showToast('Panel layout reset.', 'success');
  }, [commitPanelLayout, showToast]);

  const startPanelResize = useCallback((target: PanelResizeTarget, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    clearPanelResizeArtifacts();
    const appRect = appBodyRef.current?.getBoundingClientRect();
    const inspectorRect = inspectorRef.current?.getBoundingClientRect();
    if (!appRect || (target === 'preview' && !inspectorRect)) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const initial = { ...panelLayoutRef.current };
    // The Inspector can contain an embedded PDF/object or iframe. Once a drag
    // crosses one of those surfaces, the embedded view can otherwise deliver the
    // release to that nested surface instead of this renderer. A top-level
    // shield keeps the remainder of the drag in the same document.
    const dragShield = document.createElement('div');
    dragShield.className = `panel-resize-shield panel-resize-shield-${target}`;
    dragShield.setAttribute('aria-hidden', 'true');
    document.body.append(dragShield);
    let finished = false;
    document.body.classList.add('panel-resizing', `panel-resizing-${target}`);

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      // A missed pointer-up can otherwise leave a global pointer listener
      // alive. This is the safety net for releases outside the app window.
      if (moveEvent.pointerType !== 'touch' && (moveEvent.buttons & 1) === 0) {
        finish();
        return;
      }

      const next = { ...initial };
      const logicalWidth = appRect.width / interfaceScale;
      const currentColumns = workbenchColumns(
        appRect.width,
        interfaceScale,
        navigationRailWidth,
        initial.explorerOpen,
        initial.previewOpen || initial.referenceOpen,
        initial.explorerWidth,
        initial.inspectorWidth,
      );
      if (target === 'explorer') {
        const maxWidth = Math.max(WORKBENCH_MIN_EXPLORER_WIDTH, Math.min(
          WORKBENCH_MAX_EXPLORER_WIDTH,
          logicalWidth - navigationRailWidth - currentColumns.inspectorWidth - WORKBENCH_MIN_EDITOR_WIDTH,
        ));
        next.explorerWidth = clamp(
          ((moveEvent.clientX - appRect.left) / interfaceScale) - navigationRailWidth,
          WORKBENCH_MIN_EXPLORER_WIDTH,
          maxWidth,
        );
      } else if (target === 'inspector') {
        const maxWidth = Math.max(WORKBENCH_MIN_INSPECTOR_WIDTH, Math.min(
          WORKBENCH_MAX_INSPECTOR_WIDTH,
          logicalWidth - navigationRailWidth - currentColumns.explorerWidth - WORKBENCH_MIN_EDITOR_WIDTH,
        ));
        next.inspectorWidth = clamp(
          (appRect.right - moveEvent.clientX) / interfaceScale,
          WORKBENCH_MIN_INSPECTOR_WIDTH,
          maxWidth,
        );
      } else if (inspectorRect) {
        next.previewSplit = clamp(((moveEvent.clientY - inspectorRect.top) / inspectorRect.height) * 100, 30, 75);
      }
      panelLayoutRef.current = next;
      setPanelLayout(next);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('blur', finish);
      window.removeEventListener('pagehide', finish);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      handle.removeEventListener('lostpointercapture', finish);
      dragShield.remove();
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // The OS can invalidate a captured pointer as a window is torn down.
      }
      document.body.classList.remove('panel-resizing', `panel-resizing-${target}`);
      if (panelResizeCleanupRef.current === finish) panelResizeCleanupRef.current = null;
      commitPanelLayout(panelLayoutRef.current);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish();
    };
    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) finish();
    };
    const onMouseUp = (mouseEvent: MouseEvent) => {
      if (mouseEvent.button === 0) finish();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') finish();
    };
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') finish();
    };

    try { handle.setPointerCapture(pointerId); } catch { /* Global listeners remain as a fallback. */ }
    panelResizeCleanupRef.current = finish;
    // Capture phase means even a top-level child that stops propagation cannot
    // strand the session. The drag shield additionally prevents PDF/iframe
    // content from becoming that child in the first place.
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('blur', finish);
    window.addEventListener('pagehide', finish);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibilityChange);
    handle.addEventListener('lostpointercapture', finish);
  }, [clearPanelResizeArtifacts, commitPanelLayout, interfaceScale, navigationRailWidth]);

  useEffect(() => {
    let mounted = true;
    desktop.settings.load()
      .then((loaded) => { if (mounted) setSettings({ ...DEFAULT_SETTINGS, ...loaded }); })
      .catch(() => { if (mounted) showToast('Could not load settings; using defaults.', 'error'); })
      .finally(() => { if (mounted) setSettingsReady(true); });
    return () => { mounted = false; };
  }, [showToast]);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener('resize', updateViewportWidth);
    return () => window.removeEventListener('resize', updateViewportWidth);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    void desktop.settings.save(settings).catch(() => showToast('Could not save settings.', 'error'));
  }, [settings, settingsReady, showToast]);

  useEffect(() => {
    panelLayoutRef.current = panelLayout;
  }, [panelLayout]);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    projectRootRef.current = project?.root;
  }, [project?.root]);

  // Native callbacks and timers can run between a setState call and React's
  // next commit. Keep the guard source in sync immediately for operations
  // that can write or detach a file, then let the functional state update
  // merge against React's newest rendered array as usual.
  const commitDocuments = useCallback((update: (current: DocumentModel[]) => DocumentModel[]) => {
    documentsRef.current = update(documentsRef.current);
    setDocuments(update);
  }, []);

  const beginDocumentInteraction = useCallback(() => {
    documentInteractionEpochRef.current += 1;
    return documentInteractionEpochRef.current;
  }, []);

  const targetFor = useCallback((document: Pick<DocumentModel, 'id' | 'relativePath' | 'projectRoot' | 'fileHandle'>, projectRoot = projectRootRef.current): SaveTarget => ({
    id: document.id,
    relativePath: document.relativePath,
    fileHandle: document.fileHandle,
    // A relative path is meaningful only inside the folder that originally
    // produced this tab. Never borrow the currently visible folder merely
    // because a project switch happened before a deferred operation ran.
    ...(document.relativePath && document.projectRoot && document.projectRoot === projectRoot
      ? { projectRoot: document.projectRoot }
      : {}),
    generation: saveTargetGenerationsRef.current.get(document.id) || 0,
  }), []);

  const matchesSaveTarget = useCallback((document: Pick<DocumentModel, 'id' | 'relativePath' | 'projectRoot' | 'fileHandle'>, target: SaveTarget) => (
    sameSaveTarget(document, target)
      && (!target.relativePath || (Boolean(target.projectRoot) && target.projectRoot === projectRootRef.current))
      && (saveTargetGenerationsRef.current.get(document.id) || 0) === target.generation
  ), []);

  const beginSaveTargetOperation = useCallback((document: Pick<DocumentModel, 'id' | 'relativePath' | 'projectRoot' | 'fileHandle'>, projectRoot = projectRootRef.current): SaveTarget | null => {
    const target = targetFor(document, projectRoot);
    const latest = documentsRef.current.find((candidate) => candidate.id === target.id);
    if (!latest || !matchesSaveTarget(latest, target)) return null;
    const operation = { ...target, generation: target.generation + 1 };
    saveTargetGenerationsRef.current.set(operation.id, operation.generation);
    return operation;
  }, [matchesSaveTarget, targetFor]);

  const invalidateSaveTarget = useCallback((id: string) => {
    saveTargetGenerationsRef.current.set(id, (saveTargetGenerationsRef.current.get(id) || 0) + 1);
  }, []);

  // A workspace replacement must make the old array unreachable to queued
  // saves before React schedules its next paint. In-flight native writes still
  // resolve harmlessly because their source generation is now stale.
  const replaceDocuments = useCallback((next: DocumentModel[]) => {
    for (const document of documentsRef.current) invalidateSaveTarget(document.id);
    documentsRef.current = next;
    setDocuments(next);
  }, [invalidateSaveTarget]);

  const enqueueDocumentWrite = useCallback(function enqueueDocumentWrite<Result>(target: SaveTarget, write: (version?: string) => Promise<Result>, requireRecovery = true): Promise<Result | null> {
    const previous = documentWriteQueuesRef.current.get(target.id) || Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      try {
        if (recoveryLoadError) throw new Error('Recovery could not be loaded. Existing recovery was preserved; use Save As to rescue your work.');
        await recoveryQueue.save(recoveryPayload(documentsRef.current, target.id));
      } catch (error) {
        // An explicit Save As must remain available when the recovery disk is
        // full/unreadable, so the user can rescue text to another destination.
        if (requireRecovery) throw error;
        setRecoveryWarning(`Recovery unavailable: ${errorMessage(error)}. Saving your chosen copy instead.`);
      }
      const latest = documentsRef.current.find((document) => document.id === target.id);
      if (!latest || !matchesSaveTarget(latest, target)) return null;
      const written = await write(latest.diskVersion);
      // A newer Save may supersede this operation while native I/O finishes.
      // Carry its byte receipt forward only for the unchanged binding/baseline;
      // never replace a newer read, clear a conflict, or mark newer text clean.
      if (requireRecovery && written && typeof written === 'object' && 'diskVersion' in written && typeof written.diskVersion === 'string') {
        const diskVersion = written.diskVersion;
        commitDocuments((documents) => documents.map((document) => sameSaveTarget(document, target) && document.diskVersion === latest.diskVersion
          ? { ...document, diskVersion }
          : document));
      }
      return written;
    });
    const settled = result.then(() => undefined, () => undefined);
    documentWriteQueuesRef.current.set(target.id, settled);
    void settled.finally(() => {
      if (documentWriteQueuesRef.current.get(target.id) === settled) documentWriteQueuesRef.current.delete(target.id);
    });
    return result;
  }, [commitDocuments, matchesSaveTarget, recoveryLoadError, recoveryQueue]);

  useEffect(() => {
    if (!settingsReady) return;
    const loadedLayout = panelLayoutFromSettings(settings);
    panelLayoutRef.current = loadedLayout;
    setPanelLayout(loadedLayout);
  }, [settingsReady]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemAppearance(media.matches ? 'dark' : 'light');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let mounted = true;
    // Older renderer builds in this profile kept folder history in local
    // storage. Import it once into the native, durable list; modern entries
    // are written by the native app so standalone files can be reopened safely after
    // a relaunch too. The marker prevents a cleared native list from being
    // repopulated from this legacy cache on the next launch.
    let shouldMigrateLegacy = true;
    try { shouldMigrateLegacy = window.localStorage.getItem(LEGACY_RECENT_PROJECTS_MIGRATION_KEY) !== 'done'; } catch { /* no readable legacy storage */ }
    const loadRecents = shouldMigrateLegacy
      ? desktop.recents.migrateLegacyProjects(legacyRecentProjects())
      : desktop.recents.list();
    void loadRecents
      .then((entries) => {
        if (shouldMigrateLegacy) {
          try {
            window.localStorage.setItem(LEGACY_RECENT_PROJECTS_MIGRATION_KEY, 'done');
            window.localStorage.removeItem(LEGACY_RECENT_PROJECTS_KEY);
          } catch { /* A blocked browser storage area cannot contain a usable legacy list. */ }
        }
        if (mounted) setRecentProjects(entries);
      })
      .catch(() => {
        void desktop.recents.list()
          .then((entries) => { if (mounted) setRecentProjects(entries); })
          .catch(() => { if (mounted) setRecentProjects([]); });
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(PALETTE_HISTORY_KEY, JSON.stringify(paletteHistory.slice(0, 8))); } catch { /* ignored */ }
  }, [paletteHistory]);

  useEffect(() => {
    try { window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcutBindings)); } catch { /* ignored */ }
  }, [shortcutBindings]);

  const checkpointRecovery = useCallback((snapshot: DocumentModel[], selectedId: string) => {
    if (recoveryLoadError) return;
    setRecoveryStatus('Saving recovery…');
    return recoveryQueue.save(recoveryPayload(snapshot, selectedId)).then(({ savedAt, current }) => {
      if (!current) return;
      setRecoveryStatus(`Recovery copy saved ${new Date(savedAt).toLocaleTimeString()}`);
      setRecoveryWarning('');
      // Migrate only after the native checkpoint has acknowledged the bytes.
      try { localStorage.removeItem(SCRATCH_SESSION_KEY); } catch { /* native copy is durable */ }
    }).catch((error) => setRecoveryWarning(`Recovery not saved: ${errorMessage(error)}. Save your work before closing.`));
  }, [recoveryLoadError, recoveryQueue]);

  useEffect(() => {
    if (recoveryLoadError) return;
    recoveryQueue.invalidate();
    setRecoveryStatus('Saving recovery…');
    const timer = window.setTimeout(() => void checkpointRecovery(documentsRef.current, activeId), 300);
    return () => window.clearTimeout(timer);
  }, [activeId, checkpointRecovery, documents, recoveryLoadError, recoveryQueue]);

  useEffect(() => {
    if (!desktop.recovery.onCloseRequested) return;
    let disposed = false;
    let closing = false;
    const subscription = desktop.recovery.onCloseRequested(async () => {
      if (disposed || closing || isCloseConfirmationOpen()) return;
      closing = true;
      const shell = document.querySelector<HTMLElement>('.app-shell');
      if (shell) shell.inert = true;
      try {
        if (recoveryLoadError) throw new Error(recoveryLoadError);
        await flushStableRecovery(() => documentsRef.current, (snapshot) => recoveryQueue.save(recoveryPayload(snapshot, activeId)));
        await desktop.recovery.finishClose?.();
      } catch (error) {
        setRecoveryWarning(`Cannot close safely: ${errorMessage(error)}. Save your work with Save As and retry.`);
        showToast('Recovery could not be saved. Your window has been kept open.', 'error');
        if (window.confirm('Recovery could not be saved. Close anyway? Unsaved work from this session may be lost. Choose Cancel to keep editing or use Save As.')) {
          await desktop.recovery.finishClose?.();
        }
      } finally {
        closing = false;
        if (shell) shell.inert = false;
      }
    });
    return () => { disposed = true; void subscription.then((unlisten) => unlisten()); };
  }, [activeId, desktop, recoveryLoadError, recoveryQueue, showToast]);

  useEffect(() => {
    if (!activeDocument) return;
    setSnapshots(readSnapshots(historyScope(activeDocument)));
  }, [activeDocument?.id, activeDocument?.relativePath, activeDocument?.projectRoot]);

  useEffect(() => {
    if (!activeDocument?.dirty) return undefined;
    const documentId = activeDocument.id;
    const timer = window.setTimeout(() => {
      setSnapshots(rememberSnapshot(historyScope(activeDocument), activeDocument.value));
    }, 1150);
    return () => {
      window.clearTimeout(timer);
      if (documentId !== activeDocument.id) return;
    };
  }, [activeDocument?.id, activeDocument?.value, activeDocument?.dirty, activeDocument?.projectRoot]);

  const updateDocument = useCallback((id: string, value: string) => {
    const current = documentsRef.current.find((document) => document.id === id);
    if (!current || current.value === value) return;
    beginDocumentInteraction();
    commitDocuments((current) => current.map((document) => {
      if (document.id !== id || document.value === value) return document;
      return {
        ...document,
        value,
        dirty: true,
        revision: document.revision + 1,
        defaultUntitled: false,
      };
    }));
  }, [beginDocumentInteraction, commitDocuments]);

  /**
   * A file can disappear while its tab is open: Finder may move it, another
   * tool may remove it, or an older standalone-file permission may no longer
   * resolve after a relaunch. Preserve the editor buffer but drop the dead
   * binding, so it becomes a normal Save As-able scratch document instead of
   * causing each idle autosave to fail again.
   */
  const recoverMissingSaveTarget = useCallback((target: SaveTarget) => {
    if (!target.relativePath && !target.fileHandle) return null;
    const latest = documentsRef.current.find((document) => document.id === target.id);
    if (!latest || !matchesSaveTarget(latest, target)) return null;

    // Invalidate first so every late success/error for this former binding is
    // ignored before React has a chance to paint the detached scratch state.
    invalidateSaveTarget(target.id);
    const recoveryGeneration = target.generation + 1;

    // Once a document has had a real path or opaque handle, retain it even if
    // it is empty and named `untitled.*`: the explicit recovery marker keeps
    // it out of stale-default cleanup after a relaunch.
    commitDocuments((currentDocuments) => {
      const currentDocument = currentDocuments.find((document) => document.id === target.id);
      if (!currentDocument
        || !sameSaveTarget(currentDocument, target)
        || (saveTargetGenerationsRef.current.get(target.id) || 0) !== recoveryGeneration) return currentDocuments;
      return currentDocuments.map((document) => document.id === target.id
        ? {
          ...document,
          relativePath: undefined,
          projectRoot: undefined,
          fileHandle: undefined,
          diskVersion: undefined,
          conflict: false,
          recoveryOrigin: document.recoveryOrigin ?? (document.relativePath ? `${document.projectRoot || ''}/${document.relativePath}` : document.name),
          dirty: true,
          pinned: false,
          recoveryDraft: true,
          defaultUntitled: false,
        }
        : document);
    });
    return 'detached' as const;
  }, [commitDocuments, invalidateSaveTarget, matchesSaveTarget]);

  const flagConflict = useCallback((target: SaveTarget) => {
    const latest = documentsRef.current.find((document) => document.id === target.id);
    if (!latest || !matchesSaveTarget(latest, target)) return;
    invalidateSaveTarget(target.id);
    commitDocuments((current) => current.map((document) => document.id === target.id ? { ...document, conflict: true } : document));
    showToast('This file changed on disk. Autosave is paused until you resolve the conflict.', 'info');
  }, [commitDocuments, invalidateSaveTarget, matchesSaveTarget, showToast]);

  const reviewConflict = useCallback(async (document: DocumentModel) => {
    const target = targetFor(document);
    try {
      const disk = target.relativePath && target.projectRoot
        ? await desktop.project.readFile(target.projectRoot, target.relativePath, document.encoding, 'none')
        : target.fileHandle ? await desktop.project.readOpenedFile(target.fileHandle, document.encoding) : null;
      const latest = documentsRef.current.find((candidate) => candidate.id === target.id);
      if (disk && latest && matchesSaveTarget(latest, target)) {
        setConflictReview({ target, disk, value: latest.value, revision: latest.revision });
      }
    } catch (error) {
      if (isMissingSaveTargetError(error)) recoverMissingSaveTarget(target);
      else showToast(errorMessage(error), 'error');
    }
  }, [desktop, matchesSaveTarget, recoverMissingSaveTarget, showToast, targetFor]);

  const resolveConflict = useCallback(async (choice: 'disk' | 'mine') => {
    if (!conflictReview) return;
    const { target, disk, value, revision } = conflictReview;
    const latest = documentsRef.current.find((document) => document.id === target.id);
    if (!latest || !matchesSaveTarget(latest, target) || latest.value !== value || latest.revision !== revision) {
      setConflictReview(null);
      showToast('The document changed while comparing. Compare again to use the current text.', 'info');
      return;
    }
    if (manualSaveInFlightRef.current.has(target.id)) return;
    manualSaveInFlightRef.current.add(target.id);
    try {
      if (choice === 'disk') {
        // Preserve the editor version before the deliberate discard.
        await recoveryQueue.save(recoveryPayload(documentsRef.current, target.id));
        const current = documentsRef.current.find((document) => document.id === target.id);
        if (!current || !matchesSaveTarget(current, target) || current.value !== value || current.revision !== revision) return;
        invalidateSaveTarget(target.id);
        commitDocuments((documents) => documents.map((document) => document.id === target.id ? {
          ...document, value: disk.content, encoding: disk.encoding, diskVersion: disk.diskVersion,
          dirty: false, conflict: false, revision: document.revision + 1,
        } : document));
      } else {
        const result = await enqueueDocumentWrite<{ diskVersion?: string }>(target, () => target.relativePath && target.projectRoot
          ? desktop.project.writeFile(target.projectRoot, target.relativePath, value, latest.encoding, disk.diskVersion)
          : desktop.project.writeOpenedFile(target.fileHandle!, value, latest.encoding, disk.diskVersion));
        if (!result) return;
        commitDocuments((documents) => documents.map((document) => matchesSaveTarget(document, target) ? {
          ...document, diskVersion: result.diskVersion, dirty: document.value !== value, conflict: false,
        } : document));
      }
      setConflictReview(null);
    } catch (error) {
      if (isMissingSaveTargetError(error)) recoverMissingSaveTarget(target);
      showToast(isSaveConflict(error) ? 'The disk file changed again. Compare again before resolving.' : errorMessage(error), 'error');
      setConflictReview(null);
    } finally { manualSaveInFlightRef.current.delete(target.id); }
  }, [commitDocuments, conflictReview, desktop, enqueueDocumentWrite, flagConflict, invalidateSaveTarget, matchesSaveTarget, recoverMissingSaveTarget, recoveryQueue, showToast]);

  const revealEditorLine = useCallback((line: number, column = 1) => {
    const editor = editorRef.current;
    if (!editor) {
      pendingRevealLineRef.current = line;
      return;
    }
    const safeLine = Math.max(1, Math.min(line, editor.getModel()?.getLineCount() ?? line));
    editor.revealLineInCenter(safeLine);
    editor.setPosition({ lineNumber: safeLine, column: Math.max(1, column) });
    editor.focus();
    pendingRevealLineRef.current = null;
  }, []);

  const renderDocument = useCallback(async (
    document: DocumentModel,
    latexMode: LatexRenderMode = 'pdf',
    engine: TexPdfEngine = texPdfEngine,
  ) => {
    const isMetafont = document.sourceType === 'metafont';
    if (settings.safeMode && (document.sourceType === 'tikz' || document.sourceType === 'latex' || isMetafont)) {
      setPreview({ status: 'idle', revision: document.revision, message: 'Safe Mode blocks local compiler execution for this project.' });
      return;
    }
    // MetaFont invokes several native tools. A second click while a proof is
    // running must not launch another pipeline or invalidate the current one.
    if (isMetafont && metafontRenderInFlightRef.current) return;
    const token = ++renderTokenRef.current;
    setPreview({ status: 'rendering', revision: document.revision, message: 'Building preview…' });
    try {
      if (document.sourceType === 'tikz') {
        const result = await desktop.render.tikz(document.value, document.name, engine);
        if (token !== renderTokenRef.current) return;
        if (!result.ok) {
          setPreview({ status: 'error', revision: document.revision, message: result.error });
          return;
        }
        setPreview({ status: 'ready', revision: document.revision, kind: 'pdf', content: result.dataUri });
        return;
      }

      if (document.sourceType === 'latex') {
        // DVI is intentionally kept on classic `latex`; a selected PDF engine
        // applies only to PDF preview/build paths.
        const result = await desktop.render.latex(
          document.value,
          document.name,
          latexMode,
          latexMode === 'pdf' ? engine : undefined,
        );
        if (token !== renderTokenRef.current) return;
        if (!result.ok) {
          setPreview({ status: 'error', revision: document.revision, message: result.error });
          return;
        }
        if (result.format === 'pdf') {
          setPreview({ status: 'ready', revision: document.revision, kind: 'pdf', content: result.dataUri });
          return;
        }
        if (result.previewKind === 'svg') {
          setPreview({ status: 'ready', revision: document.revision, kind: 'svg', content: result.svg, message: 'DVI compiled and converted to an SVG preview.' });
          return;
        }
        setPreview({ status: 'ready', revision: document.revision, message: result.warning });
        return;
      }

      if (isMetafont) {
        metafontRenderInFlightRef.current = true;
        try {
          const result = await desktop.render.metafont(document.value, document.name);
          if (token !== renderTokenRef.current) return;
          if (!result.ok) {
            setPreview({ status: 'error', revision: document.revision, message: result.error });
            return;
          }
          setPreview({ status: 'ready', revision: document.revision, kind: 'svg', content: result.svg, message: 'MetaFont GF glyph proof · first generated glyph.' });
        } finally {
          metafontRenderInFlightRef.current = false;
        }
        return;
      }

      if (document.sourceType === 'markdown') {
        const html = await renderMarkdownSource(document.value, (source) => renderMermaidSource(source, effectiveAppearance));
        if (token !== renderTokenRef.current) return;
        setPreview({ status: 'ready', revision: document.revision, kind: 'html', content: html });
        return;
      }

      if (document.sourceType === 'text') {
        if (token !== renderTokenRef.current) return;
        setPreview({ status: 'ready', revision: document.revision, kind: 'html', content: textPreviewDocument(document.value, effectiveAppearance) });
        return;
      }

      if (document.sourceType === 'json') {
        if (token !== renderTokenRef.current) return;
        const result = inspectJson(document.value);
        if (!result.valid) {
          const location = result.line ? ` (line ${result.line}, column ${result.column ?? 1})` : '';
          setPreview({ status: 'error', revision: document.revision, message: `${result.message}${location}` });
          return;
        }
        setPreview({ status: 'ready', revision: document.revision, kind: 'html', content: jsonPreviewDocument(document.value, effectiveAppearance), message: result.message });
        return;
      }

      if (document.sourceType === 'html') {
        if (token !== renderTokenRef.current) return;
        // The preview viewport uses a fully sandboxed iframe. HTML stays
        // useful as a visual check without granting its scripts any access to
        // native project, or the network-capable page context.
        setPreview({ status: 'ready', revision: document.revision, kind: 'html', content: document.value || sourcePreviewDocument('', 'HTML', effectiveAppearance) });
        return;
      }

      if (SOURCE_PREVIEW_TYPES.has(document.sourceType)) {
        if (token !== renderTokenRef.current) return;
        setPreview({ status: 'ready', revision: document.revision, kind: 'html', content: sourcePreviewDocument(document.value, SOURCE_META[document.sourceType].label, effectiveAppearance) });
        return;
      }

      let svg = document.value;
      if (document.sourceType === 'svg') {
        const parsed = new DOMParser().parseFromString(document.value, 'image/svg+xml');
        const parserError = parsed.querySelector('parsererror');
        if (parserError) throw new Error(parserError.textContent || 'SVG is not well-formed XML.');
      } else {
        svg = await renderMermaidSource(document.value, effectiveAppearance);
      }
      if (token !== renderTokenRef.current) return;
      setPreview({ status: 'ready', revision: document.revision, kind: 'svg', content: svg });
    } catch (error) {
      if (token !== renderTokenRef.current) return;
      setPreview({ status: 'error', revision: document.revision, message: error instanceof Error ? error.message : String(error) });
    }
  }, [effectiveAppearance, settings.safeMode, texPdfEngine]);

  useEffect(() => {
    if (!activeDocument || !settings.previewAutoRender || settings.safeMode) return undefined;
    // A project with an explicit pipeline (for example a multi-file book)
    // must not automatically compile the current chapter as an isolated TeX
    // fragment. Its task buttons remain available for the full document.
    if (taskManagedLatex) return undefined;
    // MetaFont proofing launches mf-nowin → gftodvi → dvisvgm. It stays manual
    // so normal typing cannot accumulate native compiler jobs in the background.
    if (activeDocument.sourceType === 'metafont') return undefined;
    const delay = activeDocument.sourceType === 'tikz' || activeDocument.sourceType === 'latex' ? 850 : 380;
    const mode: LatexRenderMode = activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf';
    const timer = window.setTimeout(() => renderDocument(activeDocument, mode), delay);
    return () => window.clearTimeout(timer);
  }, [activeDocument, latexPreviewMode, renderDocument, settings.previewAutoRender, settings.safeMode, taskManagedLatex]);

  const addScratchpadDocument = useCallback((seed: DocumentModel) => {
    const baseName = filenameWithoutExtension(seed.name);
    let name = seed.name;
    let index = 2;
    while (documentsRef.current.some((document) => document.name === name)) {
      name = `${baseName} ${index}.${SOURCE_META[seed.sourceType].extension}`;
      index += 1;
    }
    const next = {
      ...seed,
      name,
      dirty: true,
      // A duplicate/default-looking name selected deliberately by the user is
      // not the untouched launch tab and must remain recoverable if empty.
      ...(name === seed.name ? {} : { defaultUntitled: false }),
    };
    beginDocumentInteraction();
    commitDocuments((current) => [...current, next]);
    setActiveId(next.id);
    setPreview(EMPTY_PREVIEW);
    editorRef.current?.focus();
  }, [beginDocumentInteraction, commitDocuments]);

  const createUnsavedStarterDocument = useCallback((type: SourceType) => {
    if (!isSourceTypeEnabled(type)) {
      showToast(`${SOURCE_META[type].label} templates are disabled in Settings.`, 'info');
      return;
    }
    addScratchpadDocument(makeStarterDocument(type));
  }, [addScratchpadDocument, isSourceTypeEnabled, showToast]);

  const createBlankScratchpad = useCallback((requestedType?: SourceType) => {
    const type = requestedType ?? defaultCreationSourceType;
    if (!isSourceTypeEnabled(type)) {
      showToast(`${SOURCE_META[type].label} is disabled in Settings. Enable it to create a new source.`, 'info');
      return;
    }
    addScratchpadDocument(makeBlankDocument(type));
  }, [addScratchpadDocument, defaultCreationSourceType, isSourceTypeEnabled, showToast]);

  const syncProjectTree = useCallback((nextProject: Project, resetLocation = false, expectedCurrentRoot?: string) => {
    // Async refreshes are scoped to the root that started them. Without this
    // guard, a late refresh from project A can rebind project B's tabs to A.
    if (expectedCurrentRoot !== undefined && projectRootRef.current !== expectedCurrentRoot) return false;
    if (projectRootRef.current !== nextProject.root) {
      projectOperationGenerationRef.current += 1;
      setIsTaskRunning(false);
      setTaskOutput('No local task has run in this project.');
    }
    projectRootRef.current = nextProject.root;
    const directories = folderPaths(nextProject.tree);
    setProject(nextProject);
    setCollapsedPaths((current) => resetLocation
      ? new Set()
      : new Set([...current].filter((relativePath) => directories.has(relativePath))));
    setSelectedFolderPath((current) => resetLocation || !directories.has(current) ? '' : current);
    return true;
  }, []);

  // Projects, tabs, tree location, and a few transient viewing choices are
  // deliberately restored from a small renderer-side session. Panel geometry
  // and visibility already live in the native settings store, so both sources
  // cooperate without duplicating a preference schema. A missing folder or a
  // file removed outside Yedit is simply skipped instead of blocking launch.
  useEffect(() => {
    if (!settingsReady || workspaceRestoreStartedRef.current) return;
    workspaceRestoreStartedRef.current = true;
    let cancelled = false;

    const finish = () => {
      if (!cancelled) setWorkspaceSessionReady(true);
    };

    const restore = async () => {
      const root = initialWorkbenchSession.projectRoot;
      if (!root) {
        finish();
        return;
      }

      const restoreEpoch = initialWorkspaceRestoreEpochRef.current;
      const restoreWasSuperseded = () => (
        cancelled
        || documentInteractionEpochRef.current !== restoreEpoch
        || projectRootRef.current !== undefined
      );

      try {
        const restoredProject = await desktop.project.refresh(root);
        // Do not let a slow startup restore replace a folder the user opened
        // or a document the user opened/edited while it was reading the
        // previous session.
        if (restoreWasSuperseded()) return;
        const sourceByPath = new Map(
          flattenFiles(restoredProject.tree)
            .filter((node) => node.kind === 'file' && node.supported)
            .map((node) => [node.relativePath, node]),
        );
        const seenPaths = new Set<string>();
        const requestedTabs = (initialWorkbenchSession.projectTabs ?? [])
          .filter((tab) => sourceByPath.has(tab.relativePath))
          .filter((tab) => {
            if (seenPaths.has(tab.relativePath)) return false;
            seenPaths.add(tab.relativePath);
            return true;
          })
          .slice(0, MAX_RESTORED_PROJECT_TABS);
        const reopenedTabs: DocumentModel[] = [];
        for (const tab of requestedTabs) {
          const node = sourceByPath.get(tab.relativePath);
          if (!node) continue;
          try {
            const source = await desktop.project.readFile(restoredProject.root, tab.relativePath, tab.encoding ?? 'auto', 'adopt');
            if (restoreWasSuperseded()) return;
            reopenedTabs.push({
              id: `file-${crypto.randomUUID()}`,
              name: node.name,
              sourceType: node.sourceType ?? sourceTypeForName(node.name),
              value: source.content,
              encoding: source.encoding,
              diskVersion: source.diskVersion,
              relativePath: tab.relativePath,
              projectRoot: restoredProject.root,
              dirty: false,
              revision: 0,
              pinned: tab.pinned === true,
            });
          } catch {
            // The project tree may change between refresh and read. Continue
            // restoring the remaining tabs, just as a normal editor would.
          }
        }
        if (restoreWasSuperseded()) return;

        const directories = folderPaths(restoredProject.tree);
        projectRootRef.current = restoredProject.root;
        setProject(restoredProject);
        setCollapsedPaths(new Set((initialWorkbenchSession.collapsedPaths ?? []).filter((path) => directories.has(path))));
        setSelectedFolderPath(directories.has(initialWorkbenchSession.selectedFolderPath ?? '') ? initialWorkbenchSession.selectedFolderPath ?? '' : '');

        if (reopenedTabs.length) {
          const scratchTabs = initialScratchSession.restored ? initialScratchSession.documents : [];
          const restoredDocuments = [...reopenedTabs, ...scratchTabs];
          const projectActive = reopenedTabs.find((document) => document.relativePath === initialWorkbenchSession.activeProjectPath);
          const scratchActive = scratchTabs.find((document) => document.id === initialScratchSession.activeId);
          replaceDocuments(restoredDocuments);
          setActiveId(projectActive?.id ?? scratchActive?.id ?? reopenedTabs[0].id);
          setPreview(EMPTY_PREVIEW);
        }
        void refreshRecentProjects();
      } catch {
        // A deleted or disconnected previous folder should never make launch
        // feel like a failure. The scratch workspace remains available.
      } finally {
        finish();
      }
    };

    void restore();
    return () => { cancelled = true; };
  }, [desktop.project, initialScratchSession, initialWorkbenchSession, refreshRecentProjects, replaceDocuments, settingsReady]);

  useEffect(() => {
    if (!workspaceSessionReady) return;
    const projectTabs = project
      ? documents
        .filter((document) => Boolean(document.relativePath) && document.projectRoot === project.root)
        .slice(0, MAX_RESTORED_PROJECT_TABS)
        .map((document) => ({
          relativePath: document.relativePath!,
          ...(document.encoding ? { encoding: document.encoding } : {}),
          ...(document.pinned ? { pinned: true } : {}),
        }))
      : [];
    rememberWorkbenchSession({
      ...(project ? { projectRoot: project.root } : {}),
      ...(projectTabs.length ? { projectTabs } : {}),
      ...(project && activeDocument?.relativePath && activeDocument.projectRoot === project.root
        ? { activeProjectPath: activeDocument.relativePath }
        : {}),
      ...(collapsedPaths.size ? { collapsedPaths: [...collapsedPaths] } : {}),
      ...(selectedFolderPath ? { selectedFolderPath } : {}),
      zenMode,
      latexPreviewMode,
      texPdfEngine,
      previewBackground,
      pythonInspectorView,
    });
  }, [activeDocument?.relativePath, collapsedPaths, documents, latexPreviewMode, previewBackground, project, pythonInspectorView, selectedFolderPath, texPdfEngine, workspaceSessionReady, zenMode]);

  const hydrateProject = useCallback(async (openedProject: Project) => {
    const hydrationEpoch = beginDocumentInteraction();
    const projectRoot = openedProject.root;
    const sourceFiles = flattenFiles(openedProject.tree).filter((item) => item.supported);
    // The user has confirmed this workspace replacement. Retire every old
    // target before awaiting the initial project read, otherwise a queued
    // standalone autosave can still write the document they just discarded.
    const blank = makeBlankDocument(defaultCreationSourceType);
    replaceDocuments([blank]);
    setActiveId(blank.id);
    setPreview(EMPTY_PREVIEW);
    // Folder names are often reused across projects (for example, `notes`).
    // Always start an opened folder at its real root instead of carrying old
    // collapsed/selected paths into the new workspace.
    syncProjectTree(openedProject, true);
    void refreshRecentProjects();
    if (!sourceFiles.length) {
      if (documentInteractionEpochRef.current !== hydrationEpoch || projectRootRef.current !== projectRoot) return;
      showToast('Project opened. Add a source file when you are ready.');
      return;
    }
    const first = sourceFiles[0];
    const source = await desktop.project.readFile(projectRoot, first.relativePath, openingEncoding, 'adopt');
    if (documentInteractionEpochRef.current !== hydrationEpoch || projectRootRef.current !== projectRoot) return;
    const document: DocumentModel = {
      id: `file-${crypto.randomUUID()}`,
      name: first.name,
      sourceType: first.sourceType ?? sourceTypeForName(first.name),
      value: source.content,
      encoding: source.encoding,
      diskVersion: source.diskVersion,
      relativePath: first.relativePath,
      projectRoot,
      dirty: false,
      revision: 0,
    };
    replaceDocuments([document]);
    setActiveId(document.id);
    showToast(`Opened ${openedProject.name}.`, 'success');
  }, [beginDocumentInteraction, defaultCreationSourceType, openingEncoding, refreshRecentProjects, replaceDocuments, showToast, syncProjectTree]);

  const openProject = useCallback(async () => {
    if (documents.some((document) => document.dirty) && !window.confirm('Opening a project will close the current scratchpad tabs. Continue without saving those edits?')) return;
    beginDocumentInteraction();
    try {
      const opened = await desktop.project.open();
      if ('canceled' in opened) return;
      await hydrateProject(opened);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open the project.', 'error');
    }
  }, [beginDocumentInteraction, documents, hydrateProject, showToast]);

  const activateOpenedSource = useCallback((opened: OpenedSourceFile, openedProjectRoot?: string) => {
    const isProjectFile = 'relativePath' in opened;
    // `relativePath` is only valid for the root passed to the native open
    // request. A folder switch while its sheet is open must not make that
    // relative path belong to the newly visible project.
    if (isProjectFile && (!openedProjectRoot || projectRootRef.current !== openedProjectRoot)) return;
    const existing = isProjectFile
      ? documentsRef.current.find((document) => document.relativePath === opened.relativePath && document.projectRoot === openedProjectRoot)
      : documentsRef.current.find((document) => document.fileHandle === opened.fileHandle);
    beginDocumentInteraction();
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const document: DocumentModel = {
      id: `file-${crypto.randomUUID()}`,
      name: opened.name,
      sourceType: opened.sourceType,
      value: opened.content,
encoding: opened.encoding,
      diskVersion: opened.diskVersion,
      ...(isProjectFile
        ? { relativePath: opened.relativePath, projectRoot: openedProjectRoot }
        : { fileHandle: opened.fileHandle }),
      dirty: false,
      revision: 0,
    };
    if (isProjectFile) {
      setSelectedFolderPath(parentFolderPath(opened.relativePath));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(opened.relativePath)) next.delete(ancestor);
        return next;
      });
    }
    let activated = document;
    let added = false;
    commitDocuments((current) => {
      const duplicate = isProjectFile
        ? current.find((candidate) => candidate.relativePath === opened.relativePath && candidate.projectRoot === openedProjectRoot)
        : current.find((candidate) => candidate.fileHandle === opened.fileHandle);
      if (duplicate) {
        activated = duplicate;
        return current;
      }
      added = true;
      return [...current, document];
    });
    setActiveId(activated.id);
    if (added) setPreview(EMPTY_PREVIEW);
  }, [beginDocumentInteraction, commitDocuments]);

  const revealOpenedFileFolder = useCallback(async (fileHandle: string, name: string) => {
    const rootAtRequest = projectRootRef.current;
    const interactionEpochAtRequest = documentInteractionEpochRef.current;
    try {
      const folder = await desktop.project.revealOpenedFileFolder(fileHandle);
      // The folder can take time to resolve. Do not let a closed tab or an
      // A → B → A workspace round trip turn this late standalone callback
      // into a new project switch.
      const standaloneDocumentStillOpen = documentsRef.current.some((document) => (
        document.fileHandle === fileHandle && !document.relativePath
      ));
      if (projectRootRef.current !== rootAtRequest
        || documentInteractionEpochRef.current !== interactionEpochAtRequest
        || !standaloneDocumentStillOpen) return;
      beginDocumentInteraction();
      // The native command resolves the opaque handle first, so this folder
      // is necessarily the parent of the exact file the user opened.
      syncProjectTree(folder, true);
      const currentDocuments = documentsRef.current;
      const existingProjectDocument = currentDocuments.find((document) => (
        document.fileHandle !== fileHandle
        && document.relativePath === name
        && document.projectRoot === folder.root
      ));
      let mayTransferBinding = !existingProjectDocument;
      let preservedRecovery = false;
      let changed = false;
      const nextDocuments = currentDocuments.map((document) => {
        if (document.fileHandle !== fileHandle) return document;
        changed = true;
        // The standalone handle and project path are different native write
        // targets. Retire the former before either transferring or detaching
        // its tab so a queued standalone write cannot win later.
        invalidateSaveTarget(document.id);
        if (!mayTransferBinding) {
          preservedRecovery = true;
          return {
            ...document,
            relativePath: undefined,
            projectRoot: undefined,
            fileHandle: undefined,
            dirty: true,
            pinned: false,
            recoveryDraft: true,
            defaultUntitled: false,
          };
        }
        mayTransferBinding = false;
        const { fileHandle: _fileHandle, ...projectDocument } = document;
        return { ...projectDocument, relativePath: name, projectRoot: folder.root };
      });
      if (changed) {
        documentsRef.current = nextDocuments;
        setDocuments(nextDocuments);
      }
      updatePanel('explorerOpen', true);
      setZenMode(false);
      void refreshRecentProjects();
      showToast(preservedRecovery
        ? `Showing ${folder.name} in Files. An existing project tab owns “${name}”; this tab is kept as an unsaved recovery draft.`
        : `Showing ${folder.name} in Files.`, preservedRecovery ? 'info' : 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not show this file’s folder.', 'error');
    }
  }, [beginDocumentInteraction, desktop.project, invalidateSaveTarget, refreshRecentProjects, showToast, syncProjectTree, updatePanel]);

  const openStandaloneFile = useCallback(async () => {
    const openedProjectRoot = project?.root;
    try {
      const opened = await desktop.project.openFile(openedProjectRoot, openingEncoding);
      if ('canceled' in opened) return;
      if ('relativePath' in opened && projectRootRef.current !== openedProjectRoot) return;
      activateOpenedSource(opened, openedProjectRoot);
      if ('fileHandle' in opened) void revealOpenedFileFolder(opened.fileHandle, opened.name);
      void refreshRecentProjects();
      showToast(`Opened ${opened.name}.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open that source file.', 'error');
    }
  }, [activateOpenedSource, openingEncoding, project?.root, refreshRecentProjects, revealOpenedFileFolder, showToast]);

  const drainFinderOpenedFiles = useCallback(() => {
    // Finder can send paths while the React app is mounting or while another
    // file is still decoding. Serialize the drains to keep tab activation and
    // recent-file updates deterministic.
    const openedProjectRoot = project?.root;
    externalOpenQueueRef.current = externalOpenQueueRef.current.then(async () => {
      try {
        const opened = await desktop.externalFiles.takePending(openedProjectRoot);
        for (const file of opened.files) {
          if ('relativePath' in file && projectRootRef.current !== openedProjectRoot) continue;
          activateOpenedSource(file, openedProjectRoot);
          if ('fileHandle' in file) void revealOpenedFileFolder(file.fileHandle, file.name);
        }
        if (opened.files.length) {
          void refreshRecentProjects();
          showToast(`Opened ${opened.files.length === 1 ? opened.files[0].name : `${opened.files.length} files`} from Finder.`, 'success');
        }
        if (opened.errors.length) showToast(opened.errors[0], 'error');
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Could not open the file Finder sent to Yedit.', 'error');
      }
    });
  }, [activateOpenedSource, desktop.externalFiles, project?.root, refreshRecentProjects, revealOpenedFileFolder, showToast]);

  useEffect(() => {
    const unsubscribe = desktop.externalFiles.onOpen(drainFinderOpenedFiles);
    drainFinderOpenedFiles();
    return unsubscribe;
  }, [desktop.externalFiles, drainFinderOpenedFiles]);

  const openEncodingDialog = useCallback(() => {
    setEncodingChoice(activeDocument?.encoding ?? 'utf-8');
    setEncodingOpen(true);
  }, [activeDocument?.encoding]);

  const setActiveDocumentEncoding = useCallback(() => {
    if (!activeDocument) return;
    const nextEncoding = encodingChoice === 'auto' ? 'utf-8' : encodingChoice;
    beginDocumentInteraction();
    commitDocuments((current) => current.map((document) => document.id === activeDocument.id
      ? { ...document, encoding: nextEncoding }
      : document));
    setEncodingOpen(false);
    showToast(`${activeDocument.name} will save as ${encodingLabel(nextEncoding)}.`, 'success');
  }, [activeDocument, beginDocumentInteraction, commitDocuments, encodingChoice, showToast]);

  const reopenActiveWithEncoding = useCallback(async () => {
    if (!activeDocument) return;
    if (!activeDocument.relativePath && !activeDocument.fileHandle) {
      setActiveDocumentEncoding();
      return;
    }
    if (activeDocument.dirty && !window.confirm(`Reopen “${activeDocument.name}” using ${encodingLabel(encodingChoice)}? Unsaved changes will be lost.`)) return;
    const sourceDocument = activeDocument;
    const projectRoot = project?.root;
    if (sourceDocument.relativePath && sourceDocument.projectRoot !== projectRoot) return;
    beginDocumentInteraction();
    const target = targetFor(sourceDocument, projectRoot);
    const valueAtRequest = sourceDocument.value;
    const revisionAtRequest = sourceDocument.revision;
    try {
      const source = projectRoot && target.relativePath
        ? await desktop.project.readFile(projectRoot, target.relativePath, encodingChoice, 'none')
        : target.fileHandle
          ? await desktop.project.readOpenedFile(target.fileHandle, encodingChoice)
          : undefined;
      if (!source) return;
      const latest = documentsRef.current.find((document) => document.id === target.id);
      if (!latest
        || !matchesSaveTarget(latest, target)
        || latest.value !== valueAtRequest
        || latest.revision !== revisionAtRequest) return;
      commitDocuments((current) => current.map((document) => matchesSaveTarget(document, target)
        ? {
          ...document,
          value: source.content,
          encoding: source.encoding,
          diskVersion: source.diskVersion,
          dirty: false,
          revision: document.revision + 1,
          conflict: false,
          recoveryDraft: false,
          defaultUntitled: false,
        }
        : document));
      setEncodingOpen(false);
      setPreview(EMPTY_PREVIEW);
      showToast(`Reopened ${sourceDocument.name} as ${encodingLabel(source.encoding)}.`, 'success');
    } catch (error) {
      if (isMissingSaveTargetError(error)) {
        const recovery = recoverMissingSaveTarget(target);
        if (recovery === 'detached') {
          showToast(`“${sourceDocument.name}” is no longer on disk. Its text is kept as an unsaved tab. Use Save As to choose a new location.`, 'info');
        }
        return;
      }
      const latest = documentsRef.current.find((document) => document.id === target.id);
      if (latest && matchesSaveTarget(latest, target)) {
        showToast(errorMessage(error) || 'Could not reopen this file with that encoding.', 'error');
      }
    }
  }, [activeDocument, beginDocumentInteraction, commitDocuments, encodingChoice, matchesSaveTarget, project?.root, recoverMissingSaveTarget, setActiveDocumentEncoding, showToast, targetFor]);

  const newProject = useCallback(async () => {
    if (documents.some((document) => document.dirty) && !window.confirm('Creating a new project will close the current scratchpad tabs. Continue without saving those edits?')) return;
    const name = window.prompt('Name your new diagram project:', 'Diagram Project');
    if (!name?.trim()) return;
    beginDocumentInteraction();
    try {
      const created = await desktop.project.create(name.trim());
      if ('canceled' in created) return;
      await hydrateProject(created);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create the project.', 'error');
    }
  }, [beginDocumentInteraction, documents, hydrateProject, showToast]);

  const refreshProject = useCallback(async () => {
    if (!project) {
      showToast('Open a folder before refreshing its project files.', 'info');
      return;
    }
    const projectRoot = project.root;
    try {
      const refreshed = await desktop.project.refresh(projectRoot);
      if (!syncProjectTree(refreshed, false, projectRoot)) return;
    } catch (error) {
      if (projectRootRef.current === projectRoot) {
        showToast(error instanceof Error ? error.message : 'Could not refresh files.', 'error');
      }
    }
  }, [project, showToast, syncProjectTree]);

  const openRecentEntry = useCallback(async (recent: RecentEntry) => {
    if (recent.kind === 'project' && documents.some((document) => document.dirty) && !window.confirm('Opening a recent folder will close the current scratchpad tabs. Continue without saving those edits?')) return false;
    if (recent.kind === 'project') beginDocumentInteraction();
    const openedProjectRoot = project?.root;
    try {
      const opened = await desktop.recents.open(recent.id, openedProjectRoot, openingEncoding);
      if (opened.kind === 'project') await hydrateProject(opened.project);
      else {
        if ('relativePath' in opened.file && projectRootRef.current !== openedProjectRoot) return false;
        activateOpenedSource(opened.file, openedProjectRoot);
        if ('fileHandle' in opened.file) void revealOpenedFileFolder(opened.file.fileHandle, opened.file.name);
        showToast(`Opened ${recent.name}.`, 'success');
      }
      await refreshRecentProjects();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not reopen ${recent.name}.`;
      if (/(?:ENOENT|no such file|no longer available|unavailable)/i.test(message)) {
        try {
          const entries = await desktop.recents.remove(recent.id);
          setRecentProjects(entries);
        } catch { /* The original unavailable-item error is still useful. */ }
        showToast(`${recent.name} is no longer available and was removed from Recents.`, 'error');
        return false;
      }
      showToast(message, 'error');
      return false;
    }
  }, [activateOpenedSource, beginDocumentInteraction, documents, hydrateProject, openingEncoding, project?.root, refreshRecentProjects, revealOpenedFileFolder, showToast]);

  const recentMenuActionRef = useRef({ entries: recentProjects, open: openRecentEntry });
  recentMenuActionRef.current = { entries: recentProjects, open: openRecentEntry };

  const openLatestRecentEntry = useCallback(() => {
    const latest = recentProjects[0];
    if (latest) void openRecentEntry(latest);
  }, [openRecentEntry, recentProjects]);

  const removeRecentEntry = useCallback(async (recent: RecentEntry) => {
    try {
      const entries = await desktop.recents.remove(recent.id);
      setRecentProjects(entries);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not remove that recent item.', 'error');
    }
  }, [showToast]);

  const clearRecentEntries = useCallback(async () => {
    if (!recentProjects.length || !window.confirm('Clear all remembered folders and files from Recents?')) return;
    try {
      const entries = await desktop.recents.clear();
      setRecentProjects(entries);
      showToast('Recent items cleared.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not clear recent items.', 'error');
    }
  }, [recentProjects.length, showToast]);

  const renameActiveProjectFile = useCallback(async () => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Open a project file before renaming it.', 'info');
      return;
    }
    const document = activeDocument;
    const projectRoot = project.root;
    const relativePath = document.relativePath;
    if (!relativePath || document.projectRoot !== projectRoot) return;
    const destination = window.prompt('Rename file (relative to this project):', relativePath)?.trim().replace(/^\/+/, '');
    if (!destination || destination === relativePath) return;
    if (projectRootRef.current !== projectRoot) return;
    if (manualSaveInFlightRef.current.has(document.id)) {
      showToast('Finish the current save before renaming this file.', 'info');
      return;
    }
    manualSaveInFlightRef.current.add(document.id);
    // A rename changes the binding, not just its label. Cancel queued writes
    // before Finder/native I/O can move the old pathname.
    invalidateSaveTarget(document.id);
    const target = targetFor(document, projectRoot);
    try {
      localWritePathsRef.current.set(relativePath, Date.now());
      localWritePathsRef.current.set(destination, Date.now());
      const result = await desktop.project.renameFile(projectRoot, relativePath, destination);
      const latest = documentsRef.current.find((candidate) => candidate.id === target.id);
      if (projectRootRef.current !== projectRoot || !latest || !matchesSaveTarget(latest, target)) return;
      commitDocuments((current) => current.map((candidate) => candidate.id === document.id ? {
        ...candidate,
        relativePath: result.relativePath,
        name: result.relativePath.split('/').at(-1) || candidate.name,
        sourceType: sourceTypeForName(result.relativePath),
      } : candidate));
      setSelectedFolderPath(parentFolderPath(result.relativePath));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(result.relativePath)) next.delete(ancestor);
        return next;
      });
      const refreshed = await desktop.project.refresh(projectRoot);
      if (!syncProjectTree(refreshed, false, projectRoot)) return;
      showToast('File renamed.', 'success');
    } catch (error) {
      if (projectRootRef.current === projectRoot) {
        showToast(error instanceof Error ? error.message : 'Could not rename this file.', 'error');
      }
    } finally {
      manualSaveInFlightRef.current.delete(document.id);
    }
  }, [activeDocument, commitDocuments, invalidateSaveTarget, matchesSaveTarget, project, showToast, syncProjectTree, targetFor]);

  const duplicateActiveProjectFile = useCallback(async () => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Open a project file before duplicating it.', 'info');
      return;
    }
    const document = activeDocument;
    const projectRoot = project.root;
    const relativePath = document.relativePath;
    if (!relativePath || document.projectRoot !== projectRoot) return;
    const currentExtension = document.name.match(/\.[^/.]+$/)?.[0] ?? '';
    const extension = document.sourceType === 'latex' && /\.(?:tex|latex|ltx)$/i.test(currentExtension)
      ? currentExtension
      : `.${SOURCE_META[document.sourceType].extension}`;
    const base = relativePath.replace(new RegExp(`${extension.replace('.', '\\.')}$`, 'i'), '');
    const destination = window.prompt('Duplicate file as (relative to this project):', `${base} copy${extension}`)?.trim().replace(/^\/+/, '');
    if (!destination) return;
    if (projectRootRef.current !== projectRoot) return;
    beginDocumentInteraction();
    try {
      localWritePathsRef.current.set(destination, Date.now());
      const result = await desktop.project.duplicateFile(projectRoot, relativePath, destination);
      if (projectRootRef.current !== projectRoot) return;
      const source = await desktop.project.readFile(projectRoot, result.relativePath, document.encoding, 'adopt');
      if (projectRootRef.current !== projectRoot) return;
      const copy: DocumentModel = {
        id: `file-${crypto.randomUUID()}`,
        name: result.relativePath.split('/').at(-1) || document.name,
        sourceType: sourceTypeForName(result.relativePath),
        value: source.content,
        encoding: source.encoding,
        diskVersion: source.diskVersion,
        relativePath: result.relativePath,
        projectRoot,
        dirty: false,
        revision: 0,
      };
      commitDocuments((current) => [...current, copy]);
      setActiveId(copy.id);
      setSelectedFolderPath(parentFolderPath(result.relativePath));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(result.relativePath)) next.delete(ancestor);
        return next;
      });
      const refreshed = await desktop.project.refresh(projectRoot);
      if (!syncProjectTree(refreshed, false, projectRoot)) return;
      showToast('Duplicate opened in a new tab.', 'success');
    } catch (error) {
      if (projectRootRef.current === projectRoot) {
        showToast(error instanceof Error ? error.message : 'Could not duplicate this file.', 'error');
      }
    }
  }, [activeDocument, beginDocumentInteraction, commitDocuments, project, showToast, syncProjectTree]);

  const deleteActiveProjectFile = useCallback(async () => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Open a project file before deleting it.', 'info');
      return;
    }
    const document = activeDocument;
    const projectRoot = project.root;
    const relativePath = document.relativePath;
    if (!relativePath || document.projectRoot !== projectRoot) return;
    if (!window.confirm(`Move “${relativePath}” out of this project permanently? This cannot be undone by Yedit.`)) return;
    if (projectRootRef.current !== projectRoot) return;
    if (manualSaveInFlightRef.current.has(document.id)) {
      showToast('Finish the current save before deleting this file.', 'info');
      return;
    }
    beginDocumentInteraction();
    manualSaveInFlightRef.current.add(document.id);
    invalidateSaveTarget(document.id);
    const target = targetFor(document, projectRoot);
    try {
      localWritePathsRef.current.set(relativePath, Date.now());
      await desktop.project.deleteFile(projectRoot, relativePath);
      const latest = documentsRef.current.find((candidate) => candidate.id === target.id);
      if (projectRootRef.current !== projectRoot || !latest || !matchesSaveTarget(latest, target)) return;
      const currentDocuments = documentsRef.current;
      const index = currentDocuments.findIndex((candidate) => candidate.id === document.id);
      const next = currentDocuments.filter((candidate) => candidate.id !== document.id);
      if (index < 0) return;
      if (!next.length) {
        const fresh = makeBlankDocument(defaultCreationSourceType);
        documentsRef.current = [fresh];
        setDocuments([fresh]);
        setActiveId(fresh.id);
      } else {
        documentsRef.current = next;
        setDocuments(next);
        setActiveId(next[Math.max(0, index - 1)].id);
      }
      const refreshed = await desktop.project.refresh(projectRoot);
      if (!syncProjectTree(refreshed, false, projectRoot)) return;
      showToast('File deleted from the project.', 'success');
    } catch (error) {
      if (projectRootRef.current === projectRoot) {
        showToast(error instanceof Error ? error.message : 'Could not delete this file.', 'error');
      }
    } finally {
      manualSaveInFlightRef.current.delete(document.id);
    }
  }, [activeDocument, beginDocumentInteraction, defaultCreationSourceType, invalidateSaveTarget, matchesSaveTarget, project, showToast, syncProjectTree, targetFor]);

  useEffect(() => {
    if (!project) return undefined;
    const watchRoot = project.root;
    let watchId: string | undefined;
    let disposed = false;
    let refreshInFlight = false;
    const pendingChangedPaths = new Set<string>();

    const processExternalChanges = async () => {
      if (refreshInFlight || disposed) return;
      refreshInFlight = true;
      try {
        while (!disposed && pendingChangedPaths.size) {
          const changedPaths = new Set(pendingChangedPaths);
          pendingChangedPaths.clear();
          const refreshed = await desktop.project.refresh(watchRoot);
          if (disposed || projectRootRef.current !== watchRoot) return;
          if (!syncProjectTree(refreshed, false, watchRoot)) return;
          if (projectPathWasChanged(PROJECT_TASKS_FILENAME, changedPaths)) {
            setProjectTaskRefreshVersion((current) => current + 1);
          }

          // A rename/remove event is the earliest reliable point to notice a
          // clean project tab whose old path vanished. Watchers may name a
          // containing directory (or the root), so include its descendants
          // without guessing unrelated/unlisted paths.
          const availablePaths = new Set(
            flattenFiles(refreshed.tree)
              .filter((node) => node.kind === 'file')
              .map((node) => node.relativePath),
          );
          let detached = 0;
          const reloadRequests: Array<{
            target: SaveTarget;
            value: string;
            revision: number;
            encoding?: CharacterEncoding;
          }> = [];

          for (const document of documentsRef.current) {
            if (!document.relativePath
              || !projectPathWasChanged(document.relativePath, changedPaths)
              || manualSaveInFlightRef.current.has(document.id)) continue;
            const target = targetFor(document, watchRoot);
            if (!availablePaths.has(document.relativePath)) {
              if (recoverMissingSaveTarget(target) === 'detached') detached += 1;
              continue;
            }
            if (document.dirty) {
              // Directory notifications and our own writes are not conflicts.
              try {
                const disk = await desktop.project.readFile(watchRoot, document.relativePath, document.encoding, 'none');
                const latest = documentsRef.current.find((candidate) => candidate.id === target.id);
                if (latest && matchesSaveTarget(latest, target) && disk.diskVersion !== latest.diskVersion) flagConflict(target);
              } catch (error) {
                if (isMissingSaveTargetError(error)) recoverMissingSaveTarget(target);
              }
              continue;
            }
            // Stop an older autosave/read result before fetching the outside
            // version. The replacement read carries the newer target epoch.
            invalidateSaveTarget(document.id);
            reloadRequests.push({
              target: targetFor(document, watchRoot),
              value: document.value,
              revision: document.revision,
              encoding: document.encoding,
            });
          }

          const reloads = await Promise.all(reloadRequests.map(async (request) => {
            try {
              const source = await desktop.project.readFile(
                watchRoot,
                request.target.relativePath!,
                request.encoding,
                'none',
              );
              return { request, source } as const;
            } catch (error) {
              return isMissingSaveTargetError(error)
                ? { request, missing: true } as const
                : null;
            }
          }));
          if (disposed || projectRootRef.current !== watchRoot) return;

          for (const reload of reloads) {
            if (reload && 'missing' in reload && recoverMissingSaveTarget(reload.request.target) === 'detached') {
              detached += 1;
            }
          }
          const availableReloads = reloads.filter((reload): reload is {
            request: (typeof reloadRequests)[number];
            source: DecodedSourceFile;
          } => Boolean(reload && 'source' in reload));
          if (availableReloads.length) {
            commitDocuments((current) => current.map((document) => {
              const reload = availableReloads.find((candidate) => candidate.request.target.id === document.id);
              if (!reload
                || !matchesSaveTarget(document, reload.request.target)
                || document.dirty
                || document.value !== reload.request.value
                || document.revision !== reload.request.revision) return document;
              return {
                ...document,
                value: reload.source.content,
encoding: reload.source.encoding,
                diskVersion: reload.source.diskVersion,
                revision: document.revision + 1,
                dirty: false,
                recoveryDraft: false,
                defaultUntitled: false,
              };
            }));
          }

          const plural = changedPaths.size === 1 ? '' : 's';
          const recoveryNote = detached
            ? ` ${detached === 1 ? 'A file is' : `${detached} files are`} no longer on disk; their text is kept as unsaved tab${detached === 1 ? '' : 's'}. Use Save As to choose a new location.`
            : '';
          showToast(`Project changed outside Yedit (${changedPaths.size} update${plural}).${recoveryNote}`);
        }
      } catch (error) {
        if (isMissingSaveTargetError(error) && !disposed && projectRootRef.current === watchRoot) {
          let detached = 0;
          for (const document of documentsRef.current) {
            if (!document.relativePath) continue;
            if (recoverMissingSaveTarget(targetFor(document, watchRoot)) === 'detached') detached += 1;
          }
          if (detached) {
            showToast(`${detached === 1 ? 'The project file is' : `${detached} project files are`} no longer on disk. Their text is kept as unsaved tab${detached === 1 ? '' : 's'}. Use Save As to choose a new location.`, 'info');
          }
        }
        // A later watcher event or a direct Save will surface a missing root
        // through the stable recovery error. Do not let an old watcher toast
        // replace a newer project's UI.
      } finally {
        refreshInFlight = false;
        if (!disposed && pendingChangedPaths.size) void processExternalChanges();
      }
    };

    const unsubscribe = desktop.project.onChanged((update) => {
      if (disposed || update.root !== watchRoot || !update.changes?.length) return;
      const now = Date.now();
      const externalChanges = update.changes.filter((change) => {
        const localWriteAt = localWritePathsRef.current.get(change.relativePath);
        return !localWriteAt || now - localWriteAt > 1800;
      });
      if (!externalChanges.length) return;
      for (const change of externalChanges) pendingChangedPaths.add(change.relativePath);
      void processExternalChanges();
    });
    void desktop.project.watch(watchRoot).then((watch) => {
      if (disposed) void desktop.project.unwatch(watch.watchId);
      else watchId = watch.watchId;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
      if (watchId) void desktop.project.unwatch(watchId);
    };
  }, [commitDocuments, flagConflict, invalidateSaveTarget, matchesSaveTarget, project?.root, recoverMissingSaveTarget, showToast, syncProjectTree, targetFor]);

  const openFile = useCallback(async (node: FileNode, revealLine?: number) => {
    if (!project || node.kind !== 'file' || !node.supported) return;
    const projectRoot = project.root;
    if (projectRootRef.current !== projectRoot) return;
    const reservationKey = `${projectRoot}\0${node.relativePath}`;
    setSelectedFolderPath(parentFolderPath(node.relativePath));
    setCollapsedPaths((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorFolderPaths(node.relativePath)) next.delete(ancestor);
      return next;
    });
    beginDocumentInteraction();
    const existing = documentsRef.current.find((document) => document.relativePath === node.relativePath && document.projectRoot === projectRoot);
    if (existing) {
      if (revealLine) pendingRevealLineRef.current = revealLine;
      setActiveId(existing.id);
      return;
    }
    if (projectFileReadReservationsRef.current.has(reservationKey)) return;
    projectFileReadReservationsRef.current.add(reservationKey);
    try {
      const source = await desktop.project.readFile(projectRoot, node.relativePath, openingEncoding, 'adopt');
      if (projectRootRef.current !== projectRoot) return;
      const existingAfterRead = documentsRef.current.find((document) => document.relativePath === node.relativePath && document.projectRoot === projectRoot);
      if (existingAfterRead) {
        if (revealLine) pendingRevealLineRef.current = revealLine;
        setActiveId(existingAfterRead.id);
        return;
      }
      const document: DocumentModel = {
        id: `file-${crypto.randomUUID()}`,
        name: node.name,
        sourceType: node.sourceType ?? sourceTypeForName(node.name),
        value: source.content,
        encoding: source.encoding,
        diskVersion: source.diskVersion,
        relativePath: node.relativePath,
        projectRoot,
        dirty: false,
        revision: 0,
      };
      let activated = document;
      let added = false;
      commitDocuments((current) => {
        const duplicate = current.find((candidate) => candidate.relativePath === node.relativePath && candidate.projectRoot === projectRoot);
        if (duplicate) {
          activated = duplicate;
          return current;
        }
        added = true;
        return [...current, document];
      });
      if (revealLine) pendingRevealLineRef.current = revealLine;
      setActiveId(activated.id);
      if (added) setPreview(EMPTY_PREVIEW);
    } catch (error) {
      if (projectRootRef.current === projectRoot) {
        showToast(error instanceof Error ? error.message : 'Could not read that file.', 'error');
      }
    } finally {
      projectFileReadReservationsRef.current.delete(reservationKey);
    }
  }, [beginDocumentInteraction, commitDocuments, openingEncoding, project, showToast]);

  const createProjectTaskConfig = useCallback(async () => {
    if (!project) {
      showToast('Open a project before creating its task configuration.', 'info');
      return;
    }
    const projectRoot = project.root;
    const existing = flattenFiles(project.tree).find((node) => node.kind === 'file' && node.relativePath === PROJECT_TASKS_FILENAME);
    if (existing) {
      await openFile(existing);
      if (projectRootRef.current !== projectRoot) return;
      showToast('Opened the existing yedit.tasks.json file.', 'info');
      return;
    }
    try {
      if (projectRootRef.current !== projectRoot) return;
      localWritePathsRef.current.set(PROJECT_TASKS_FILENAME, Date.now());
      await desktop.project.createFile(projectRoot, PROJECT_TASKS_FILENAME, PROJECT_TASKS_TEMPLATE);
      if (projectRootRef.current !== projectRoot) return;
      await openFile({ name: PROJECT_TASKS_FILENAME, relativePath: PROJECT_TASKS_FILENAME, kind: 'file', sourceType: 'json', supported: true });
      if (projectRootRef.current !== projectRoot) return;
      const refreshed = await desktop.project.refresh(projectRoot);
      if (!syncProjectTree(refreshed, false, projectRoot)) return;
      setProjectTaskRefreshVersion((current) => current + 1);
      showToast('Created yedit.tasks.json. Adjust the example task, then run it from Task Console.', 'success');
    } catch (error) {
      if (projectRootRef.current === projectRoot) {
        showToast(error instanceof Error ? error.message : 'Could not create yedit.tasks.json.', 'error');
      }
    }
  }, [openFile, project, showToast, syncProjectTree]);

  const searchProject = useCallback(async () => {
    const query = projectSearchQuery.trim();
    if (!project) {
      showToast('Open a project to search across its files.', 'info');
      return;
    }
    if (!query) {
      setProjectSearchHits([]);
      return;
    }
    setIsProjectSearching(true);
    try {
      const files = flattenFiles(project.tree).filter((node) => node.kind === 'file' && node.supported).slice(0, 160);
      const groups = await Promise.all(files.map(async (node) => {
        const source = await desktop.project.readFile(project.root, node.relativePath);
        return findInSource(source.content, query, 24).map((match) => ({ node, ...match }));
      }));
      setProjectSearchHits(groups.flat().slice(0, 180));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not search the project.', 'error');
    } finally {
      setIsProjectSearching(false);
    }
  }, [project, projectSearchQuery, showToast]);

  const openNewSource = useCallback((requestedType?: SourceType) => {
    const type = requestedType ?? defaultCreationSourceType;
    if (!isSourceTypeEnabled(type)) {
      showToast(`${SOURCE_META[type].label} is disabled in Settings. Enable it to create a new source.`, 'info');
      return;
    }
    const fallbackFolder = type === 'markdown' || type === 'text'
      ? 'notes'
      : type === 'latex'
        ? 'documents'
        : 'diagrams';
    const folder = project ? `${selectedFolderPath || fallbackFolder}/` : '';
    setNewSourceType(type);
    setNewSourceName(`${folder}untitled.${SOURCE_META[type].extension}`);
    setNewSourceOpen(true);
  }, [defaultCreationSourceType, isSourceTypeEnabled, project, selectedFolderPath, showToast]);

  const changeNewSourceType = useCallback((type: SourceType) => {
    if (!isSourceTypeEnabled(type)) {
      showToast(`${SOURCE_META[type].label} is disabled in Settings.`, 'info');
      return;
    }
    setNewSourceType(type);
    setNewSourceName((current) => {
      const base = current.replace(SOURCE_FILENAME_PATTERN, '') || 'untitled';
      return `${base}.${SOURCE_META[type].extension}`;
    });
  }, [isSourceTypeEnabled, showToast]);

  useEffect(() => {
    if (!newSourceOpen || isSourceTypeEnabled(newSourceType)) return;
    changeNewSourceType(defaultCreationSourceType);
  }, [changeNewSourceType, defaultCreationSourceType, isSourceTypeEnabled, newSourceOpen, newSourceType]);

  const createFile = useCallback(async () => {
    if (!isSourceTypeEnabled(newSourceType)) {
      showToast(`${SOURCE_META[newSourceType].label} is disabled in Settings. Choose an enabled source format.`, 'info');
      return;
    }
    const rawName = newSourceName.trim().replace(/^\/+/, '');
    if (!rawName) {
      showToast('Give the source file a name first.', 'error');
      return;
    }
    const nameWithoutKnownExtension = rawName.replace(SOURCE_FILENAME_PATTERN, '') || 'untitled';
    const name = `${nameWithoutKnownExtension}.${SOURCE_META[newSourceType].extension}`;
    const type = newSourceType;
    setIsCreatingSource(true);
    beginDocumentInteraction();
    try {
      if (!project) {
        const requestedTabName = name.includes('/') ? name.split('/').at(-1)! : name;
        const tabBaseName = filenameWithoutExtension(requestedTabName);
        let tabName = requestedTabName;
        let index = 2;
        while (documentsRef.current.some((document) => document.name === tabName)) {
          tabName = `${tabBaseName} ${index}.${SOURCE_META[type].extension}`;
          index += 1;
        }
        const document: DocumentModel = {
          ...makeBlankDocument(type),
          name: tabName,
          dirty: true,
          defaultUntitled: false,
        };
        commitDocuments((current) => [...current, document]);
        setActiveId(document.id);
        setPreview(EMPTY_PREVIEW);
        setNewSourceOpen(false);
        showToast(`${document.name} opened in a new tab.`, 'success');
        return;
      }
      const source = '';
      const projectRoot = project.root;
      if (projectRootRef.current !== projectRoot) return;
      localWritePathsRef.current.set(name, Date.now());
      const created = await desktop.project.createFile(projectRoot, name, source);
      if (projectRootRef.current !== projectRoot) return;
      const document: DocumentModel = {
        id: `file-${crypto.randomUUID()}`,
        name: name.split('/').at(-1) ?? name,
        sourceType: type,
        value: source,
        diskVersion: created.diskVersion,
        encoding: 'utf-8',
        relativePath: name,
        projectRoot,
        dirty: false,
        revision: 0,
      };
      commitDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setSelectedFolderPath(parentFolderPath(name));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(name)) next.delete(ancestor);
        return next;
      });
      setPreview(EMPTY_PREVIEW);
      try {
        const refreshed = await desktop.project.refresh(projectRoot);
        if (!syncProjectTree(refreshed, false, projectRoot)) return;
      } catch {
        // The source is already open; the user can refresh the tree later if needed.
      }
      setNewSourceOpen(false);
      showToast(`Created ${name}.`, 'success');
    } catch (error) {
      if (!project || projectRootRef.current === project.root) {
        showToast(error instanceof Error ? error.message : 'Could not create the file.', 'error');
      }
    } finally {
      setIsCreatingSource(false);
    }
  }, [beginDocumentInteraction, commitDocuments, isSourceTypeEnabled, newSourceName, newSourceType, project, showToast, syncProjectTree]);

  /**
   * Tasks and build profiles execute against files in the project folder, so
   * their pre-save must follow the same existing-target policy and late-result
   * guards as the normal Save command. Returning a state rather than showing
   * a toast here lets the caller explain why its task did not start.
   */
  const persistProjectSource = useCallback(async (
    document: DocumentModel,
    projectRoot: string,
  ): Promise<'saved' | 'recovered' | 'stale'> => {
    if (!document.relativePath || document.conflict || manualSaveInFlightRef.current.has(document.id)) return 'stale';
    manualSaveInFlightRef.current.add(document.id);
    const source = document;
    const saveTarget = beginSaveTargetOperation(source, projectRoot);
    if (!saveTarget?.relativePath) {
      manualSaveInFlightRef.current.delete(source.id);
      return 'stale';
    }
    try {
      const written = await enqueueDocumentWrite(saveTarget, (diskVersion) => {
        localWritePathsRef.current.set(saveTarget.relativePath!, Date.now());
        return desktop.project.writeFile(projectRoot, saveTarget.relativePath!, source.value, source.encoding, diskVersion);
      });
      if (written === null) return 'stale';
      const latest = documentsRef.current.find((candidate) => candidate.id === saveTarget.id);
      if (!latest || !matchesSaveTarget(latest, saveTarget)) return 'stale';
      commitDocuments((current) => current.map((candidate) => (
        matchesSaveTarget(candidate, saveTarget)
          ? {
            ...candidate,
            dirty: candidate.value !== source.value,
            diskVersion: written.diskVersion,
            conflict: false,
            recoveryDraft: false,
            defaultUntitled: false,
          }
          : candidate
      )));
      if (saveTarget.relativePath === PROJECT_TASKS_FILENAME) setProjectTaskRefreshVersion((current) => current + 1);
      return 'saved';
    } catch (error) {
      if (isMissingSaveTargetError(error)) {
        return recoverMissingSaveTarget(saveTarget) === 'detached' ? 'recovered' : 'stale';
      }
      if (isSaveConflict(error)) { flagConflict(saveTarget); return 'stale'; }
      throw error;
    } finally {
      manualSaveInFlightRef.current.delete(source.id);
    }
  }, [beginSaveTargetOperation, commitDocuments, enqueueDocumentWrite, flagConflict, matchesSaveTarget, recoverMissingSaveTarget]);

  const saveDocument = useCallback(async (saveAs = false) => {
    if (!activeDocument) return;
    if (!saveAs && activeDocument.conflict) { await reviewConflict(activeDocument); return; }
    let source = activeDocument;
    if (manualSaveInFlightRef.current.has(source.id)) return;
    beginDocumentInteraction();
    manualSaveInFlightRef.current.add(source.id);
    const projectRoot = project?.root;

    // A relative path belongs only to the folder that created this tab. If a
    // folder switch left this tab open, a normal save is intentionally unable
    // to borrow the new project's root. An explicit Save As is different: it
    // is the user's request to choose a new destination. Detach first so the
    // chooser cannot race an old project binding or let autosave revive it.
    if (saveAs && source.relativePath && source.projectRoot !== projectRoot) {
      invalidateSaveTarget(source.id);
      commitDocuments((current) => current.map((document) => (
        document.id === source.id
          ? {
            ...document,
            relativePath: undefined,
            projectRoot: undefined,
            fileHandle: undefined,
            dirty: true,
            pinned: false,
            recoveryDraft: true,
            defaultUntitled: false,
          }
          : document
      )));
      source = documentsRef.current.find((document) => document.id === source.id) ?? source;
    }
    const saveTarget = beginSaveTargetOperation(source, projectRoot);
    if (!saveTarget) {
      manualSaveInFlightRef.current.delete(source.id);
      return;
    }
    try {
      const content = settings.formatOnSave ? formatSource(source.sourceType, source.value) : source.value;
      if (content !== source.value) {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (editor && model) {
          editor.executeEdits('format-on-save', [{ range: model.getFullModelRange(), text: content, forceMoveMarkers: true }]);
        } else {
          commitDocuments((current) => current.map((document) => document.id === source.id
            ? { ...document, value: content, revision: document.revision + 1, defaultUntitled: false }
            : document));
        }
      }
      const savedDocument = (document: DocumentModel, binding: Partial<DocumentModel> = {}) => {
        // Do not replace a newer/undone edit with an older save result. When
        // format-on-save has not reached React yet, apply only that exact
        // formatter result to the unchanged original revision.
        const value = document.value === source.value && document.revision === source.revision
          ? content
          : document.value;
        return {
          ...document,
          ...binding,
          value,
          dirty: value !== content,
          recoveryDraft: false,
          defaultUntitled: false,
        };
      };
      if (projectRoot && source.relativePath && !saveAs) {
        const written = await enqueueDocumentWrite(saveTarget, (diskVersion) => {
          localWritePathsRef.current.set(source.relativePath!, Date.now());
          return desktop.project.writeFile(projectRoot, source.relativePath!, content, source.encoding, diskVersion);
        });
        if (written === null) return;
        const latest = documentsRef.current.find((document) => document.id === saveTarget.id);
        if (!latest || !matchesSaveTarget(latest, saveTarget)) return;
        commitDocuments((current) => current.map((document) => (
          matchesSaveTarget(document, saveTarget)
            ? savedDocument(document, { diskVersion: written.diskVersion, conflict: false })
            : document
        )));
        if (source.relativePath === PROJECT_TASKS_FILENAME) setProjectTaskRefreshVersion((current) => current + 1);
        void desktop.project.refresh(projectRoot)
          .then((refreshed) => { syncProjectTree(refreshed, false, projectRoot); })
          .catch(() => undefined);
        showToast(`${source.name} saved.`, 'success');
        return;
      }
      if (source.fileHandle && !saveAs) {
        const written = await enqueueDocumentWrite(saveTarget, (diskVersion) => desktop.project.writeOpenedFile(source.fileHandle!, content, source.encoding, diskVersion));
        if (written === null) return;
        const latest = documentsRef.current.find((document) => document.id === saveTarget.id);
        if (!latest || !matchesSaveTarget(latest, saveTarget)) return;
        commitDocuments((current) => current.map((document) => (
          matchesSaveTarget(document, saveTarget)
            ? savedDocument(document, { diskVersion: written.diskVersion, conflict: false })
            : document
        )));
        showToast(`${source.name} saved.`, 'success');
        return;
      }
      const result = await enqueueDocumentWrite(saveTarget, () => desktop.project.saveAs(source.name, content, source.sourceType, projectRoot, source.encoding), false);
      if (result === null) return;
      if (result.canceled) return;
      const latest = documentsRef.current.find((document) => document.id === saveTarget.id);
      if (!latest || !matchesSaveTarget(latest, saveTarget)) return;
      const name = result.name ?? source.name;
      const savedRelativePath = result.relativePath;
      commitDocuments((current) => current.map((document) => (
        matchesSaveTarget(document, saveTarget)
          ? savedDocument(document, {
            name,
            relativePath: savedRelativePath,
            projectRoot: savedRelativePath && projectRoot ? projectRoot : undefined,
            fileHandle: result.fileHandle,
            diskVersion: result.diskVersion,
            conflict: false,
          })
          : document
      )));
      if (projectRoot && savedRelativePath && projectRootRef.current === projectRoot) {
        setSelectedFolderPath(parentFolderPath(savedRelativePath));
        setCollapsedPaths((current) => {
          const next = new Set(current);
          for (const ancestor of ancestorFolderPaths(savedRelativePath)) next.delete(ancestor);
          return next;
        });
        void desktop.project.refresh(projectRoot)
          .then((refreshed) => { syncProjectTree(refreshed, false, projectRoot); })
          .catch(() => undefined);
      }
      showToast(`${name} saved.`, 'success');
    } catch (error) {
      if (!saveAs && isSaveConflict(error)) { flagConflict(saveTarget); return; }
      if (!saveAs && isMissingSaveTargetError(error)) {
        const recovery = recoverMissingSaveTarget(saveTarget);
        if (recovery === 'detached') {
          showToast(`“${source.name}” is no longer on disk. Its text is kept as an unsaved tab. Use Save As to choose a new location.`, 'info');
        }
        return;
      }
      const latest = documentsRef.current.find((document) => document.id === saveTarget.id);
      if (latest && matchesSaveTarget(latest, saveTarget)) showToast(errorMessage(error) || 'Could not save the file.', 'error');
    } finally {
      manualSaveInFlightRef.current.delete(source.id);
    }
  }, [activeDocument, beginDocumentInteraction, beginSaveTargetOperation, commitDocuments, enqueueDocumentWrite, flagConflict, invalidateSaveTarget, matchesSaveTarget, project?.root, recoverMissingSaveTarget, reviewConflict, settings.formatOnSave, showToast, syncProjectTree]);

  useEffect(() => {
    if (!settings.autoSave || !activeDocument?.dirty || activeDocument.conflict || manualSaveInFlightRef.current.has(activeDocument.id)) return undefined;
    const source = activeDocument;
    const projectRoot = project?.root;
    if (!source.relativePath && !source.fileHandle) return undefined;
    const timer = window.setTimeout(() => {
      if (manualSaveInFlightRef.current.has(source.id)) return;
      const latestBeforeSave = documentsRef.current.find((document) => document.id === source.id);
      if (!latestBeforeSave
        || latestBeforeSave.value !== source.value
        || latestBeforeSave.revision !== source.revision
        || !sameSaveTarget(latestBeforeSave, source)) return;
      const saveTarget = beginSaveTargetOperation(source, projectRoot);
      if (!saveTarget) return;
      const persist = saveTarget.relativePath && projectRoot
        ? () => enqueueDocumentWrite(saveTarget, (diskVersion) => {
          localWritePathsRef.current.set(saveTarget.relativePath!, Date.now());
          return desktop.project.writeFile(projectRoot, saveTarget.relativePath!, source.value, source.encoding, diskVersion);
        })
        : saveTarget.fileHandle
          ? () => enqueueDocumentWrite(saveTarget, (diskVersion) => desktop.project.writeOpenedFile(saveTarget.fileHandle!, source.value, source.encoding, diskVersion))
          : undefined;
      if (!persist) return;
      setAutoSaving(true);
      void persist()
        .then((written) => {
          if (written === null) return;
          const latest = documentsRef.current.find((document) => document.id === saveTarget.id);
          if (!latest || !matchesSaveTarget(latest, saveTarget)) return;
          commitDocuments((current) => current.map((document) => (
            matchesSaveTarget(document, saveTarget)
              ? {
                ...document,
                dirty: document.value !== source.value,
                diskVersion: written.diskVersion,
                conflict: false,
                recoveryDraft: false,
                defaultUntitled: false,
              }
              : document
          )));
          if (saveTarget.relativePath === PROJECT_TASKS_FILENAME) setProjectTaskRefreshVersion((current) => current + 1);
        })
        .catch((error) => {
          if (isSaveConflict(error)) { flagConflict(saveTarget); return; }
          if (isMissingSaveTargetError(error)) {
            const recovery = recoverMissingSaveTarget(saveTarget);
            if (recovery === 'detached') {
              showToast(`“${source.name}” is no longer on disk. Its text is kept as an unsaved tab. Use Save As to choose a new location.`, 'info');
            }
            return;
          }
          const latest = documentsRef.current.find((document) => document.id === saveTarget.id);
          if (latest && matchesSaveTarget(latest, saveTarget)) showToast(errorMessage(error) || 'Auto-save could not write this file.', 'error');
        })
        .finally(() => setAutoSaving(false));
    }, 1050);
    return () => window.clearTimeout(timer);
  }, [activeDocument, beginSaveTargetOperation, commitDocuments, enqueueDocumentWrite, flagConflict, matchesSaveTarget, project?.root, recoverMissingSaveTarget, settings.autoSave, showToast]);

  const closeDocument = useCallback(async (requested: DocumentModel, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (isCloseConfirmationOpen()) return;
    const document = documentsRef.current.find((candidate) => candidate.id === requested.id);
    if (!document) return;
    if (isCloseProtected(document)) {
      showToast(`Unpin “${document.name}” before closing it.`, 'info');
      return;
    }
    const decision = await confirmTabClose([document], (id) => documentsRef.current.find((candidate) => candidate.id === id), (tab) => tab.dirty, showCloseConfirmation);
    if (decision === 'cancelled' || decision === 'protected') return;
    if (decision === 'changed' || documentsRef.current.find((candidate) => candidate.id === document.id) !== document) {
      showToast('The tab changed while confirmation was open. Review it and try closing again.', 'info');
      return;
    }
    beginDocumentInteraction();
    invalidateSaveTarget(document.id);
    const index = documentsRef.current.findIndex((candidate) => candidate.id === document.id);
    const next = documentsRef.current.filter((candidate) => candidate.id !== document.id);
    // Persist the removal immediately, including the empty final checkpoint.
    void checkpointRecovery(next, activeId === document.id ? next[Math.max(0, index - 1)]?.id ?? '' : activeId);
    if (!next.length) {
      // A window with no editor tabs is a valid workspace state. Do not create
      // a replacement scratchpad tab here: closing the final tab should mean
      // exactly that, while the empty workspace keeps New Source and Open
      // Folder immediately available.
      renderTokenRef.current += 1;
      editorRef.current = null;
      pendingRevealLineRef.current = null;
      documentsRef.current = [];
      setDocuments([]);
      setActiveId('');
      setPreview(EMPTY_PREVIEW);
      setSelectionSource('');
      setSnapshots([]);
      return;
    }
    documentsRef.current = next;
    setDocuments(next);
    setActiveId((current) => current === document.id ? next[Math.max(0, index - 1)].id : current);
  }, [activeId, beginDocumentInteraction, checkpointRecovery, invalidateSaveTarget, showToast]);

  const toggleActiveTabPin = useCallback(() => {
    if (!activeDocument) return;
    beginDocumentInteraction();
    commitDocuments((current) => current.map((document) => document.id === activeDocument.id
      ? { ...document, pinned: !document.pinned }
      : document));
    showToast(activeDocument.pinned ? 'Tab unpinned.' : 'Tab pinned for this workspace session.', 'success');
  }, [activeDocument, beginDocumentInteraction, commitDocuments, showToast]);

  const formatActive = useCallback(() => {
    if (!activeDocument) return;
    const jsonResult = activeDocument.sourceType === 'json' ? formatJson(activeDocument.value) : undefined;
    if (activeDocument.sourceType === 'json' && !jsonResult) {
      const inspection = inspectJson(activeDocument.value);
      if (inspection.line) revealEditorLine(inspection.line, inspection.column);
      showToast(`${inspection.message}${inspection.line ? ` (line ${inspection.line}, column ${inspection.column ?? 1})` : ''}`, 'error');
      return;
    }
    const formatted = jsonResult ?? formatSource(activeDocument.sourceType, activeDocument.value);
    if (formatted === activeDocument.value) {
      showToast('Already formatted.');
      return;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      editor.executeEdits('format-document', [{
        range: model.getFullModelRange(),
        text: formatted,
        forceMoveMarkers: true,
      }]);
    } else {
      updateDocument(activeDocument.id, formatted);
    }
    showToast(activeDocument.sourceType === 'json' ? 'JSON pretty-printed locally.' : 'Formatted with the local source formatter.', 'success');
  }, [activeDocument, revealEditorLine, showToast, updateDocument]);

  const validateActiveJson = useCallback(() => {
    if (!activeDocument || activeDocument.sourceType !== 'json') {
      showToast('Open a JSON document to validate it.', 'info');
      return;
    }
    const result = inspectJson(activeDocument.value);
    if (result.valid) {
      showToast(result.message, 'success');
      return;
    }
    if (result.line) revealEditorLine(result.line, result.column);
    showToast(`${result.message}${result.line ? ` (line ${result.line}, column ${result.column ?? 1})` : ''}`, 'error');
  }, [activeDocument, revealEditorLine, showToast]);

  const prettyPrintActiveJson = useCallback(() => {
    if (!activeDocument || activeDocument.sourceType !== 'json') {
      showToast('Open a JSON document to pretty-print it.', 'info');
      return;
    }
    formatActive();
  }, [activeDocument, formatActive, showToast]);

  const minifyActiveJson = useCallback(() => {
    if (!activeDocument || activeDocument.sourceType !== 'json') {
      showToast('Open a JSON document to minify it.', 'info');
      return;
    }
    const minified = minifyJson(activeDocument.value);
    if (!minified) {
      validateActiveJson();
      return;
    }
    if (minified === activeDocument.value) {
      showToast('JSON is already compact.');
      return;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      editor.executeEdits('minify-json', [{ range: model.getFullModelRange(), text: minified, forceMoveMarkers: true }]);
      editor.focus();
    } else {
      updateDocument(activeDocument.id, minified);
    }
    showToast('JSON compacted with the local formatter.', 'success');
  }, [activeDocument, showToast, updateDocument, validateActiveJson]);

  const inferActiveJsonSchema = useCallback(() => {
    if (!activeDocument || activeDocument.sourceType !== 'json') {
      showToast('Open a JSON document to infer a schema.', 'info');
      return;
    }
    const result = inferJsonSchema(activeDocument.value);
    if (!result.schema) {
      if (result.error?.line) revealEditorLine(result.error.line, result.error.column);
      showToast(result.error?.message || 'The JSON must be valid before a schema can be inferred.', 'error');
      return;
    }
    const base = filenameWithoutExtension(activeDocument.name);
    let name = `${base}.schema.json`;
    let index = 2;
    while (documentsRef.current.some((document) => document.name === name)) {
      name = `${base}.schema ${index}.json`;
      index += 1;
    }
    const document: DocumentModel = {
      id: `json-schema-${crypto.randomUUID()}`,
      name,
      sourceType: 'json',
      value: `${JSON.stringify(result.schema, null, 2)}\n`,
      dirty: true,
      revision: 0,
    };
    beginDocumentInteraction();
    commitDocuments((current) => [...current, document]);
    setActiveId(document.id);
    showToast('Permissive JSON Schema draft opened in a new tab.', 'success');
  }, [activeDocument, beginDocumentInteraction, commitDocuments, revealEditorLine, showToast]);

  const openJsonPrompt = useCallback((intent: JsonPromptIntent) => {
    if (!activeDocument || activeDocument.sourceType !== 'json') {
      showToast('Open a JSON document to use JSON Prompt Studio.', 'info');
      return;
    }
    setPromptSpec((current) => ({
      ...current,
      jsonIntent: intent,
      goal: intent === 'create'
        ? current.goal || 'Create a strict JSON document for a clearly defined data model.'
        : intent === 'analyze'
          ? 'Explain the structure, semantics, likely schema, and data-quality risks in this JSON.'
          : 'Create a practical JSON Schema Draft 2020-12 from this example.',
      constraints: intent === 'create'
        ? current.constraints || 'Strict JSON only: double-quoted keys and strings, no comments, no trailing commas.'
        : intent === 'schema'
          ? 'Keep the schema permissive unless the data demonstrates a strict constraint; do not mark inferred keys required without evidence.'
          : 'Separate observed facts from assumptions and identify ambiguous or inconsistent fields.',
      includeActiveFile: intent !== 'create' ? true : current.includeActiveFile,
      outputOnly: intent !== 'analyze',
    }));
    setPromptApplyMode(intent === 'analyze' ? 'new' : 'replace');
    setPromptReply('');
    setPromptOpen(true);
  }, [activeDocument, showToast]);

  const insertSnippet = useCallback((snippet: string) => {
    const editor = editorRef.current;
    if (!editor || !activeDocument) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits('insert-reference', [{ range: selection, text: snippet, forceMoveMarkers: true }]);
    editor.focus();
    showToast('Reference inserted.', 'success');
  }, [activeDocument, showToast]);

  const exportActive = useCallback(async (format: ExportFormat) => {
    if (!activeDocument) return;
    setIsExporting(true);
    try {
      let svg: string | undefined;
      let html: string | undefined;
      if (activeDocument.sourceType === 'svg') svg = activeDocument.value;
      if (activeDocument.sourceType === 'mermaid') svg = await renderMermaidSource(activeDocument.value, effectiveAppearance);
      if (activeDocument.sourceType === 'markdown') {
        const rendered = await renderMarkdownSource(activeDocument.value, (source) => renderMermaidSource(source, effectiveAppearance));
        html = markdownPreviewDocument(rendered, effectiveAppearance);
      }
      if (activeDocument.sourceType === 'text') html = textPreviewDocument(activeDocument.value, effectiveAppearance);
      if (activeDocument.sourceType === 'json') html = jsonPreviewDocument(activeDocument.value, effectiveAppearance);
      if (activeDocument.sourceType === 'html') html = activeDocument.value || sourcePreviewDocument('', 'HTML', effectiveAppearance);
      if (SOURCE_PREVIEW_TYPES.has(activeDocument.sourceType) && activeDocument.sourceType !== 'text' && activeDocument.sourceType !== 'json') {
        html = sourcePreviewDocument(activeDocument.value, SOURCE_META[activeDocument.sourceType].label, effectiveAppearance);
      }
      const result = await desktop.render.export({
        sourceType: activeDocument.sourceType,
        source: activeDocument.value,
        svg,
        html,
        format,
        suggestedName: filenameWithoutExtension(activeDocument.name),
        scale: exportScale,
        engine: (activeDocument.sourceType === 'tikz' || (activeDocument.sourceType === 'latex' && format !== 'dvi'))
          ? texPdfEngine
          : undefined,
      });
      if (!result.ok) throw new Error(result.error || 'Export failed.');
      if (result.canceled) return;
      setExportOpen(false);
      showToast(`${format.toUpperCase()} exported.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not export this source.', 'error');
    } finally {
      setIsExporting(false);
    }
  }, [activeDocument, effectiveAppearance, exportScale, showToast, texPdfEngine]);

  const copyText = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage, 'success');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast(successMessage, 'success');
    }
  }, [showToast]);

  const copyPreviewOutput = useCallback(async (content: string, kind: NonNullable<PreviewState['kind']>) => {
    try {
      if (kind === 'svg') {
        await desktop.clipboard.writeSvg(content);
        showToast('SVG copied to the clipboard.', 'success');
        return;
      }
      await copyText(content, kind === 'html' ? 'Rendered HTML copied to the clipboard.' : 'Output copied to the clipboard.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not copy the preview output.', 'error');
    }
  }, [copyText, showToast]);

  const copyPreviewPng = useCallback(async (content: string, kind: NonNullable<PreviewState['kind']>) => {
    if (kind !== 'svg') return;
    let url: string | undefined;
    try {
      const image = new Image();
      const blobUrl = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }));
      url = blobUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The SVG preview could not be rasterized.'));
        image.src = blobUrl;
      });
      const parsed = new DOMParser().parseFromString(content, 'image/svg+xml').documentElement;
      const viewBox = parsed.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const intrinsicWidth = Number(parsed.getAttribute('width')) || (viewBox?.[2] || image.naturalWidth || 1200);
      const intrinsicHeight = Number(parsed.getAttribute('height')) || (viewBox?.[3] || image.naturalHeight || 800);
      const multiplier = Math.min(2, 2600 / Math.max(intrinsicWidth, intrinsicHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(intrinsicWidth * multiplier));
      canvas.height = Math.max(1, Math.round(intrinsicHeight * multiplier));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot create a PNG preview.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      await desktop.clipboard.writeDataUriImage(canvas.toDataURL('image/png'));
      showToast('PNG copied to the clipboard.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not copy a PNG preview.', 'error');
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }, [showToast]);

  const promptText = useMemo(() => {
    if (!activeDocument) return '';
    const meta = SOURCE_META[activeDocument.sourceType];
    const selection = selectionSource;
    const isJson = activeDocument.sourceType === 'json';
    const isJsonAnalysis = isJson && promptSpec.jsonIntent === 'analyze';
    const isJsonSchema = isJson && promptSpec.jsonIntent === 'schema';
    const sourceRole = activeDocument.sourceType === 'text'
      ? 'editor'
      : activeDocument.sourceType === 'latex'
        ? 'document author'
        : activeDocument.sourceType === 'metafont'
          ? 'font engineer'
          : activeDocument.sourceType === 'yaml' || isJson
            ? 'data engineer'
            : CODE_SOURCE_TYPES.includes(activeDocument.sourceType)
              ? 'software engineer'
              : 'diagram engineer';
    const activeFileContext = promptSpec.includeActiveFile || isJsonAnalysis || isJsonSchema
      ? `Full active file (${activeDocument.name}):\n\n${activeDocument.value.slice(0, 14000)}${activeDocument.value.length > 14000 ? '\n\n[truncated after 14,000 characters]' : ''}`
      : '';
    const projectContext = promptSpec.includeProjectContext && project
      ? `Project context (${project.name}):\n${flattenFiles(project.tree).filter((item) => item.supported).map((item) => `- ${item.relativePath}`).slice(0, 80).join('\n')}`
      : '';
    const renderContext = promptSpec.includeRenderError && preview.status === 'error' && preview.message
      ? `Current renderer error to resolve:\n\n${preview.message.slice(-5000)}`
      : '';
    const localSchemaContext = isJsonSchema
      ? (() => {
        const inferred = inferJsonSchema(activeDocument.value);
        return inferred.schema
          ? `Local inferred starting schema (permissive, edit it rather than treating it as authoritative):\n\n${JSON.stringify(inferred.schema, null, 2)}`
          : `The current JSON must be valid before a schema can be inferred. ${inferred.error?.message ?? ''}`;
      })()
      : '';
    const task = isJsonAnalysis
      ? `Analyze the current JSON for this request: ${promptSpec.goal || 'Explain its structure, semantics, likely schema, and potential data-quality issues.'}.`
      : isJsonSchema
        ? `Generate an editable JSON Schema Draft 2020-12 for the current JSON: ${promptSpec.goal || 'capture the observed structure without over-constraining future data.'}.`
        : `Create ${meta.label} source for this request: ${promptSpec.goal || `[describe the ${meta.label.toLowerCase()} artifact here]`}.`;
    const sourceInstruction = activeDocument.sourceType === 'tikz'
      ? `Return a complete, compilable LaTeX document using TikZ. The selected PDF compiler is ${texPdfEngineLabel(texPdfEngine)} (${texPdfEngine}); use engine-appropriate packages, only local/common TikZ libraries, no shell escape, and keep labels readable.`
      : activeDocument.sourceType === 'latex'
        ? `Return a complete, compilable standalone LaTeX document. The selected PDF compiler is ${texPdfEngineLabel(texPdfEngine)} (${texPdfEngine}); use engine-appropriate packages, do not use shell escape, and keep the document structure clear.`
        : activeDocument.sourceType === 'metafont'
          ? 'Return complete, compilable MetaFont source only. Include mode_setup, define at least one beginchar glyph, use clear design units, and finish with bye. When TTF conversion is requested, favor closed fill/unfill outlines compatible with mf2pt1 rather than raster-only effects.'
          : activeDocument.sourceType === 'svg'
            ? 'Return a complete, valid, self-contained SVG with a responsive viewBox. Do not reference remote assets or scripts.'
            : activeDocument.sourceType === 'mermaid'
              ? 'Return valid Mermaid source only. Use strict-compatible syntax and set no HTML labels.'
              : activeDocument.sourceType === 'markdown'
                ? 'Return well-structured GitHub-flavored Markdown. Use meaningful headings, concise prose, and ordinary fenced code blocks; use a mermaid fence only when a diagram adds value.'
                : activeDocument.sourceType === 'json'
                  ? isJsonAnalysis
                    ? 'Treat the JSON as data, not executable code. Distinguish observations from assumptions and call out invalid or ambiguous structures without inventing missing values.'
                    : isJsonSchema
                      ? 'Return one valid JSON Schema Draft 2020-12 document. Prefer a permissive starting schema, use double-quoted JSON only, and state no prose outside the JSON document.'
                      : 'Return one strict, valid JSON document: double-quote every key and string, use no comments or trailing commas, and keep types consistent.'
                  : activeDocument.sourceType === 'yaml'
                    ? 'Return valid YAML 1.2 with two-space indentation and no tabs. Keep configuration explicit and avoid language-specific tags unless requested.'
                    : activeDocument.sourceType === 'javascript'
                      ? 'Return modern, readable JavaScript. State the module/runtime assumptions in code comments only when needed and avoid undeclared global dependencies.'
                      : activeDocument.sourceType === 'typescript'
                        ? 'Return modern, strict TypeScript with useful named types at public boundaries. Do not use any unless the request expressly requires it.'
                        : activeDocument.sourceType === 'python'
                          ? 'Return readable Python 3 source with conventional imports, four-space indentation, and type hints where they clarify public behavior.'
                          : activeDocument.sourceType === 'php'
                            ? 'Return readable PHP with an opening <?php tag, explicit parameter and return types where useful, and no closing tag for PHP-only files. Escape dynamic HTML output appropriately. Do not assume a framework or external dependency unless requested.'
                          : activeDocument.sourceType === 'fortran'
                            ? 'Return portable free-form Fortran source (Fortran 2008 or later unless a target is specified), with explicit implicit none and clear module/program structure.'
                            : activeDocument.sourceType === 'sql'
                              ? 'Return readable SQL. Use standard SQL unless a target dialect is named, qualify destructive statements carefully, and format clauses on separate lines.'
                              : activeDocument.sourceType === 'html'
                                ? 'Return a complete, semantic, accessible HTML document. Keep it self-contained; do not load remote scripts or assets unless explicitly requested.'
                                : activeDocument.sourceType === 'css'
                                  ? 'Return standards-based CSS with readable custom properties and selectors. Avoid browser-specific hacks unless the target requires them.'
                                  : isExtraSourceType(activeDocument.sourceType)
                                    ? `Return readable, idiomatic ${meta.label} source only. Preserve the file's language/dialect, quote shell variables appropriately when relevant, and do not assume frameworks, external dependencies, or execution in Yedit. State essential platform assumptions in source comments.`
                                    : 'Return clean, readable plain text only. Preserve the requested wording and structure without Markdown syntax unless it is explicitly requested.';
    return [
      `You are an expert ${meta.label} ${sourceRole}.`,
      task,
      promptSpec.audience ? `Audience / purpose: ${promptSpec.audience}.` : '',
      promptSpec.style ? `Visual direction: ${promptSpec.style}.` : '',
      promptSpec.constraints ? `Technical constraints: ${promptSpec.constraints}.` : '',
      sourceInstruction,
      selection ? `Modify or take inspiration from this selected source fragment:\n\n${selection}` : '',
      activeFileContext,
      projectContext,
      renderContext,
      localSchemaContext,
      isJsonAnalysis
        ? 'Return a concise Markdown review with headings for Shape, Semantics, Risks, and Suggested next steps. Do not return a replacement JSON document.'
        : promptSpec.outputOnly
        ? activeDocument.sourceType === 'markdown' || activeDocument.sourceType === 'text'
          ? `Return the ${activeDocument.sourceType === 'text' ? 'plain-text document' : 'Markdown document'} directly. Do not wrap the whole response in an outer Markdown fence or add commentary.`
          : 'Return source code only. Do not use Markdown fences, commentary, or explanations.'
        : 'Explain any important design decisions briefly after the source.',
    ].filter(Boolean).join('\n\n');
  }, [activeDocument, preview.message, preview.status, project, promptSpec, selectionSource, texPdfEngine]);

  const applyPromptReply = useCallback(() => {
    if (!activeDocument || !promptReply.trim()) {
      showToast('Paste an LLM source response first.', 'error');
      return;
    }
    const isJsonAnalysis = activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze';
    if (isJsonAnalysis) {
      const base = filenameWithoutExtension(activeDocument.name);
      const review: DocumentModel = {
        id: `markdown-${crypto.randomUUID()}`,
        name: `${base} JSON review.md`,
        sourceType: 'markdown',
        value: sourceFromAssistantReply(promptReply, 'markdown'),
        dirty: true,
        revision: 0,
      };
      beginDocumentInteraction();
      commitDocuments((current) => [...current, review]);
      setActiveId(review.id);
      setPromptReply('');
      setPromptOpen(false);
      showToast('JSON analysis opened as a Markdown review.', 'success');
      return;
    }
    const source = sourceFromAssistantReply(promptReply, activeDocument.sourceType);
    if (!source.trim()) {
      showToast('The pasted response does not contain source to review.', 'error');
      return;
    }
    if (activeDocument.sourceType === 'json') {
      const inspection = inspectJson(source);
      if (!inspection.valid) {
        const location = inspection.line ? ` (line ${inspection.line}, column ${inspection.column ?? 1})` : '';
        showToast(`The LLM response is not strict JSON${location}. It has not been applied.`, 'error');
        return;
      }
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    const range = promptApplyMode === 'new' || !model
      ? undefined
      : promptApplyMode === 'replace'
        ? activeDocument.sourceType === 'json'
          ? model.getFullModelRange()
          : (editor?.getSelection() ?? model.getFullModelRange())
        : (() => {
          const position = editor?.getPosition();
          return position ? { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column } : model.getFullModelRange();
        })();
    const rangeSnapshot = range ? {
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
    } : undefined;
    const before = promptApplyMode === 'new' || promptApplyMode === 'insert'
      ? ''
      : model && range ? model.getValueInRange(range) : activeDocument.value;
    setPendingAiReview({
      documentId: activeDocument.id,
      documentValue: activeDocument.value,
      documentName: activeDocument.name,
      sourceType: activeDocument.sourceType,
      mode: promptApplyMode,
      before,
      source,
      range: rangeSnapshot,
    });
    setPromptReply('');
    setPromptOpen(false);
    showToast('Review the proposed source change before applying it.', 'info');
  }, [activeDocument, beginDocumentInteraction, commitDocuments, promptApplyMode, promptReply, promptSpec.jsonIntent, showToast]);

  const applyReviewedAiSource = useCallback(() => {
    if (!pendingAiReview) return;
    if (pendingAiReview.mode === 'new') {
      const base = filenameWithoutExtension(pendingAiReview.documentName);
      const document: DocumentModel = {
        id: `${pendingAiReview.sourceType}-${crypto.randomUUID()}`,
        name: `${base} AI draft.${SOURCE_META[pendingAiReview.sourceType].extension}`,
        sourceType: pendingAiReview.sourceType,
        value: pendingAiReview.source,
        dirty: true,
        revision: 0,
      };
      beginDocumentInteraction();
      commitDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setPendingAiReview(null);
      showToast('Reviewed LLM response opened as a new draft.', 'success');
      return;
    }
    const target = documentsRef.current.find((document) => document.id === pendingAiReview.documentId);
    if (!target || target.value !== pendingAiReview.documentValue) {
      showToast('The target source changed or closed after review. Nothing was applied; open the reply as a new draft instead.', 'error');
      return;
    }
    if (activeDocument?.id !== pendingAiReview.documentId) {
      setActiveId(pendingAiReview.documentId);
      showToast('Returned to the target tab. Review the change once more before applying it.', 'info');
      return;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (model && model.getValue() !== target.value) {
      showToast('The editor is still switching tabs. Nothing was applied; review again in a moment.', 'info');
      return;
    }
    if (editor && model) {
      const range = pendingAiReview.range ?? model.getFullModelRange();
      editor.executeEdits('apply-reviewed-llm-reply', [{ range, text: pendingAiReview.source, forceMoveMarkers: true }]);
      editor.focus();
    } else if (pendingAiReview.mode === 'replace') {
      updateDocument(pendingAiReview.documentId, pendingAiReview.source);
    } else {
      updateDocument(pendingAiReview.documentId, `${activeDocument.value}\n${pendingAiReview.source}`);
    }
    setPendingAiReview(null);
    showToast(pendingAiReview.mode === 'replace' ? 'Reviewed LLM source applied.' : 'Reviewed LLM source inserted.', 'success');
  }, [activeDocument, beginDocumentInteraction, commitDocuments, pendingAiReview, showToast, updateDocument]);

  const openAskAi = useCallback((initialPrompt?: string) => {
    if (isCloseConfirmationOpen()) return;
    if (settings.safeMode) {
      showToast('Ask AI is disabled in Safe Mode. Manual Prompt Studio is still available.', 'info');
      return;
    }
    const target = activeDocument;
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const selectedText = selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) ?? '' : '';
    void showAskAi({
      context: { name: target?.name ?? '', selection: selectedText, document: target?.value ?? '' },
      initialPrompt,
      openDraft: (reply) => {
        const draft: DocumentModel = { id: `markdown-${crypto.randomUUID()}`, name: 'AI reply.md', sourceType: 'markdown', value: reply, dirty: true, revision: 0 };
        beginDocumentInteraction();
        commitDocuments((current) => [...current, draft]);
        setActiveId(draft.id);
        showToast('AI answer opened as a new unsaved draft.', 'success');
      },
      reviewReply: target ? (reply) => {
        const latest = documentsRef.current.find((document) => document.id === target.id);
        if (!latest || latest.value !== target.value) return false;
        setActiveId(target.id);
        setPromptReply(reply);
        setPromptApplyMode('new');
        setPromptOpen(true);
        return true;
      } : undefined,
      openPromptStudio: () => setPromptOpen(true),
    });
  }, [activeDocument, beginDocumentInteraction, commitDocuments, settings.safeMode, showToast]);

  const restoreSnapshot = useCallback((snapshot: LocalSnapshot) => {
    if (!activeDocument || !window.confirm(`Restore the local snapshot from ${displayTime(snapshot.createdAt)}? Your current source stays available through Undo.`)) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      editor.executeEdits('restore-local-history', [{ range: model.getFullModelRange(), text: snapshot.value, forceMoveMarkers: true }]);
      editor.focus();
    } else {
      updateDocument(activeDocument.id, snapshot.value);
    }
    setHistoryOpen(false);
    showToast('Local snapshot restored. Use Undo to return to your latest edits.', 'success');
  }, [activeDocument, showToast, updateDocument]);

  const insertMarkdownTableOfContents = useCallback(() => {
    if (!activeDocument || activeDocument.sourceType !== 'markdown') {
      showToast('Open a Markdown document to build its table of contents.', 'info');
      return;
    }
    const result = upsertMarkdownTableOfContents(activeDocument.value);
    if (!result.count) {
      showToast('Add level-two or deeper Markdown headings before creating a table of contents.', 'info');
      return;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      editor.executeEdits('markdown-table-of-contents', [{ range: model.getFullModelRange(), text: result.source, forceMoveMarkers: true }]);
      editor.focus();
    } else {
      updateDocument(activeDocument.id, result.source);
    }
    showToast(`Table of contents updated from ${result.count} heading${result.count === 1 ? '' : 's'}.`, 'success');
  }, [activeDocument, showToast, updateDocument]);

  const openGitPanel = useCallback(async () => {
    if (!project) {
      showToast('Open a project to inspect its Git status.', 'info');
      return;
    }
    setGitOpen(true);
    setIsGitLoading(true);
    try {
      const [status, log, branches] = await Promise.all([
        desktop.git.status(project.root),
        desktop.git.log(project.root, undefined, { limit: 8 }),
        desktop.git.branches(project.root),
      ]);
      setGitInfo({
        available: status.available,
        branch: branches.current || status.branch,
        branches: branches.branches,
        files: (status.changes ?? []).map((change) => ({ path: change.path, status: change.status, index: change.indexStatus, workingTree: change.workTreeStatus })),
        commits: (log.entries ?? []).map((entry) => ({ hash: entry.shortHash, subject: entry.subject, author: entry.author, date: entry.date })),
        message: status.error || log.error || branches.error,
      });
    } catch (error) {
      setGitInfo({ available: false, message: error instanceof Error ? error.message : 'Could not inspect Git for this project.' });
    } finally {
      setIsGitLoading(false);
    }
  }, [project, showToast]);

  const runGitMutation = useCallback(async (label: string, mutation: () => Promise<{ ok: boolean; error?: string }>) => {
    if (!project) {
      showToast('Open a project before changing Git state.', 'info');
      return false;
    }
    if (settings.safeMode) {
      showToast('Safe Mode blocks Git changes. Disable it in Settings only for a project you trust.', 'info');
      return false;
    }
    if (isGitMutating) return false;
    setIsGitMutating(true);
    try {
      const result = await mutation();
      if (!result.ok) throw new Error(result.error || `${label} could not be completed.`);
      await openGitPanel();
      showToast(label, 'success');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : `${label} could not be completed.`, 'error');
      return false;
    } finally {
      setIsGitMutating(false);
    }
  }, [isGitMutating, openGitPanel, project, settings.safeMode, showToast]);

  const commitGitChanges = useCallback(() => {
    if (!project) return;
    const message = gitCommitMessage.trim();
    if (!message) {
      showToast('Enter a commit message before committing.', 'info');
      return;
    }
    void runGitMutation('Created local commit.', () => desktop.git.commit(project.root, message)).then((committed) => {
      if (committed) setGitCommitMessage('');
    });
  }, [gitCommitMessage, project, runGitMutation, showToast]);

  const showGitDiff = useCallback(async (relativePath?: string, staged = false) => {
    if (!project) {
      showToast('Open a project to inspect a diff.', 'info');
      return;
    }
    setIsTaskRunning(true);
    setTaskConsoleOpen(true);
    try {
      const result = await desktop.git.diff(project.root, relativePath, { staged });
      setTaskOutput(result.error || result.diff || `No ${staged ? 'staged' : 'unstaged'} changes for this source.`);
    } catch (error) {
      setTaskOutput(error instanceof Error ? error.message : 'Could not read the Git diff.');
    } finally {
      setIsTaskRunning(false);
    }
  }, [project, showToast]);

  const showActiveDiff = useCallback(() => showGitDiff(activeDocument?.relativePath), [activeDocument?.relativePath, showGitDiff]);

  const runActivePython = useCallback(async (mode: PythonTaskMode) => {
    if (!activeDocument || activeDocument.sourceType !== 'python') {
      showToast('Open a Python source file to run or test it.', 'info');
      return;
    }
    if (settings.safeMode) {
      showToast('Safe Mode blocks local runners. Disable it in Settings only for a project you trust.', 'info');
      return;
    }
    if (isTaskRunning) {
      showToast('A local task is already running.', 'info');
      return;
    }

    // Python deliberately runs the current editor buffer. This means a quick
    // experiment is runnable before it has a name on disk, while a project
    // folder (when open) remains available to the runner for local imports.
    if (!panelLayoutRef.current.previewOpen) updatePanel('previewOpen', true);
    setPythonInspectorView('output');
    const runner = desktop.project.runPython;
    const runningTask: PythonTaskState = {
      documentId: activeDocument.id,
      revision: activeDocument.revision,
      name: activeDocument.name,
      mode,
      status: 'running',
      stdout: '',
      stderr: '',
    };

    if (typeof runner !== 'function') {
      const unavailableTask: PythonTaskState = {
        ...runningTask,
        status: 'unavailable',
        stderr: 'The local Python runner is not available in this Yedit build yet. Update the app and try again; editing and source preview remain available.',
      };
      setPythonTask(unavailableTask);
      setTaskOutput(pythonTaskConsoleText(unavailableTask));
      showToast('Local Python runner is unavailable in this build.', 'info');
      return;
    }

    setPythonTask(runningTask);
    setTaskOutput(`${mode === 'test' ? 'Testing' : 'Running'} Python source from the current editor buffer…`);
    setIsTaskRunning(true);
    try {
      const result: PythonRunResult = await runner(activeDocument.value, activeDocument.name, {
        mode,
        projectRoot: project?.root,
        relativePath: activeDocument.relativePath,
        timeoutMs: 15_000,
      });
      const stderrParts = [result.stderr, result.error]
        .filter((message): message is string => Boolean(message))
        .filter((message, index, values) => values.indexOf(message) === index);
      const completeTask: PythonTaskState = {
        ...runningTask,
        status: result.ok ? 'success' : 'error',
        stdout: result.output ?? '',
        stderr: stderrParts.join('\n'),
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      };
      setPythonTask(completeTask);
      setTaskOutput(pythonTaskConsoleText(completeTask));
      if (result.ok) {
        showToast(mode === 'test' ? 'Python tests passed.' : 'Python run finished.', 'success');
      } else {
        showToast(result.timedOut ? 'Python task timed out — see output.' : `Python ${mode === 'test' ? 'tests failed' : 'run failed'} — see output.`, 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start the local Python runner.';
      const unavailable = /no handler|not available|is not a function|run-python/i.test(message);
      const failedTask: PythonTaskState = {
        ...runningTask,
        status: unavailable ? 'unavailable' : 'error',
        stderr: unavailable
          ? 'The local Python runner is not available in this Yedit build yet. Update the app and try again; editing and source preview remain available.'
          : message,
      };
      setPythonTask(failedTask);
      setTaskOutput(pythonTaskConsoleText(failedTask));
      showToast(unavailable ? 'Local Python runner is unavailable in this build.' : message, unavailable ? 'info' : 'error');
    } finally {
      setIsTaskRunning(false);
    }
  }, [activeDocument, isTaskRunning, project?.root, settings.safeMode, showToast, updatePanel]);

  const runProjectTask = useCallback(async (task: ProjectTask) => {
    if (!project) {
      showToast('Open a project to run its build or preview tasks.', 'info');
      return;
    }
    if (settings.safeMode) {
      showToast('Safe Mode blocks project tasks. Disable it in Settings only for a project you trust.', 'info');
      return;
    }
    if (!projectTasks.some((candidate) => candidate.id === task.id)) {
      showToast('That project task is no longer available. Refresh the project and try again.', 'info');
      return;
    }
    if (isTaskRunning) {
      showToast('A local task is already running.', 'info');
      return;
    }

    const projectRoot = project.root;
    const document = activeDocument?.projectRoot === projectRoot ? activeDocument : undefined;
    if (projectRootRef.current !== projectRoot) return;
    const runGeneration = projectOperationGenerationRef.current + 1;
    projectOperationGenerationRef.current = runGeneration;
    const isCurrentRun = () => (
      projectRootRef.current === projectRoot
      && projectOperationGenerationRef.current === runGeneration
    );
    setTaskConsoleOpen(true);
    if (!panelLayoutRef.current.previewOpen) updatePanel('previewOpen', true);
    setTaskOutput(`Running ${task.label}…`);
    setIsTaskRunning(true);
    try {
      // A task builds the actual project folder, so persist an edited project
      // file first. Standalone tabs deliberately stay out of this workflow.
      if (document?.relativePath && document.dirty) {
        setTaskOutput(`Saving ${document.relativePath} before ${task.label}…`);
        const persisted = await persistProjectSource(document, projectRoot);
        if (!isCurrentRun()) return;
        if (persisted === 'recovered') {
          const message = `“${document.name}” was moved or deleted. Its text is kept as an unsaved tab; use Save As before running ${task.label}.`;
          setTaskOutput(message);
          showToast(message, 'info');
          return;
        }
        if (persisted === 'stale') {
          const message = 'The active file changed while it was being saved. Finish saving it, then run the task again.';
          setTaskOutput(message);
          showToast(message, 'info');
          return;
        }
      }

      if (!isCurrentRun()) return;
      setTaskOutput(`Running ${task.label}…`);
      const result = await desktop.project.runTask(projectRoot, task.id);
      if (!isCurrentRun()) return;
      setTaskOutput(projectTaskConsoleText(result));
      if (!result.ok) {
        showToast(`${task.label} failed — see the Task Console.`, 'error');
        return;
      }

      if (result.dataUri) {
        // Invalidate any in-flight fragment preview before replacing it with
        // the authoritative PDF produced by the project pipeline.
        renderTokenRef.current += 1;
        setPreview({
          status: 'ready',
          revision: document?.revision ?? -1,
          kind: 'pdf',
          content: result.dataUri,
          message: `${result.label} output`,
        });
      }
      showToast(result.dataUri ? `${task.label} completed and opened its PDF.` : `${task.label} completed.`, 'success');
    } catch (error) {
      if (!isCurrentRun()) return;
      const message = error instanceof Error ? error.message : `Could not run ${task.label}.`;
      setTaskOutput(message);
      showToast(message, 'error');
    } finally {
      if (projectOperationGenerationRef.current === runGeneration) setIsTaskRunning(false);
    }
  }, [activeDocument, isTaskRunning, persistProjectSource, project, projectTasks, settings.safeMode, showToast, updatePanel]);

  const renderActivePreview = useCallback(() => {
    if (!activeDocument) return;
    if (taskManagedLatex) {
      const task = projectPreviewTask ?? projectBuildTask;
      if (task) {
        void runProjectTask(task);
      } else {
        showToast('Discovering this project’s LaTeX pipeline…', 'info');
      }
      return;
    }
    void renderDocument(activeDocument, activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf');
  }, [activeDocument, latexPreviewMode, projectBuildTask, projectPreviewTask, renderDocument, runProjectTask, showToast, taskManagedLatex]);

  const runActiveBuild = useCallback(async (
    latexMode: LatexRenderMode = 'pdf',
    engine: TexPdfEngine = texPdfEngine,
  ) => {
    if (settings.safeMode) {
      showToast('Safe Mode blocks local build profiles. Disable it in Settings only for a project you trust.', 'info');
      return;
    }
    if (!project || !activeDocument?.relativePath) {
      showToast('Save the active TikZ, LaTeX, or MetaFont source into a project before running a build profile.', 'info');
      return;
    }
    const document = activeDocument;
    const projectRoot = project.root;
    const relativePath = document.relativePath;
    if (!relativePath || document.projectRoot !== projectRoot) return;
    if (projectRootRef.current !== projectRoot) return;
    const isTikz = document.sourceType === 'tikz';
    const isLatex = document.sourceType === 'latex';
    const isMetafont = document.sourceType === 'metafont';
    if (!isTikz && !isLatex && !isMetafont) {
      showToast('Local build profiles are available for TikZ, LaTeX, and MetaFont source.', 'info');
      return;
    }
    const output = isMetafont ? 'TTF' : isLatex ? latexMode.toUpperCase() : 'PDF';
    const compilerLabel = texPdfEngineLabel(engine);
    const buildLabel = isMetafont
      ? 'Convert MetaFont to TTF with mf2pt1 + FontForge'
      : isLatex
      ? latexMode === 'dvi'
        ? 'Compile LaTeX to DVI with classic LaTeX'
        : `Compile LaTeX to PDF with ${compilerLabel}`
      : `Compile TikZ to PDF with ${compilerLabel}`;
    const profileId = isMetafont
      ? 'metafont-ttf'
      : isLatex
      ? latexMode === 'dvi'
        ? 'latex-dvi'
        : engine === 'pdflatex' ? 'latex-pdf' : `latex-${engine}-pdf`
      : engine === 'pdflatex' ? 'tikz-pdf' : `tikz-${engine}-pdf`;
    const runGeneration = projectOperationGenerationRef.current + 1;
    projectOperationGenerationRef.current = runGeneration;
    const isCurrentRun = () => (
      projectRootRef.current === projectRoot
      && projectOperationGenerationRef.current === runGeneration
    );
    setTaskConsoleOpen(true);
    setIsTaskRunning(true);
    setTaskOutput(`Running ${buildLabel} for ${relativePath}…`);
    try {
      if (document.dirty) {
        const persisted = await persistProjectSource(document, projectRoot);
        if (!isCurrentRun()) return;
        if (persisted === 'recovered') {
          const message = `“${document.name}” was moved or deleted. Its text is kept as an unsaved tab; use Save As before running this build.`;
          setTaskOutput(message);
          showToast(message, 'info');
          return;
        }
        if (persisted === 'stale') {
          const message = 'The active file changed while it was being saved. Finish saving it, then run the build again.';
          setTaskOutput(message);
          showToast(message, 'info');
          return;
        }
      }
      if (!isCurrentRun()) return;
      const result = await desktop.project.runBuild(projectRoot, relativePath, profileId);
      if (!isCurrentRun()) return;
      if (!result.ok) {
        setTaskOutput(result.error || 'The build did not finish.');
        showToast('Build failed — see the Task Console.', 'error');
        return;
      }
      setTaskOutput(`✓ ${buildLabel} succeeded\n\n${result.outputRelativePath || result.outputPath || `${output} created in the project build folder.`}`);
      showToast(isMetafont
        ? 'MetaFont TTF build completed.'
        : `${isLatex ? 'LaTeX' : 'TikZ'} ${output} build completed${isLatex && latexMode === 'dvi' ? ' with classic LaTeX.' : ` with ${compilerLabel}.`}`, 'success');
    } catch (error) {
      if (!isCurrentRun()) return;
      const message = error instanceof Error ? error.message : 'Could not run the local build profile.';
      setTaskOutput(message);
      showToast(message, 'error');
    } finally {
      if (projectOperationGenerationRef.current === runGeneration) setIsTaskRunning(false);
    }
  }, [activeDocument, persistProjectSource, project, settings.safeMode, showToast, texPdfEngine]);

  const runPrimaryTask = useCallback(() => {
    if (activeDocument?.sourceType === 'python') return runActivePython('run');
    if (activeDocument?.sourceType === 'latex' && activeProjectTasks.length && projectBuildTask) return runProjectTask(projectBuildTask);
    return runActiveBuild();
  }, [activeDocument?.sourceType, activeProjectTasks.length, projectBuildTask, runActiveBuild, runActivePython, runProjectTask]);

  const actions = useMemo(() => [
    { id: 'new-project', label: 'New project', hint: '⌘⇧N', group: 'File', run: newProject },
    { id: 'open-file', label: 'Open file…', hint: '⌘O', group: 'File', run: openStandaloneFile },
    { id: 'quick-open', label: 'Quick Open…', hint: '⌘P', group: 'Navigate', run: () => { setQuickOpenQuery(''); setQuickOpenOpen(true); } },
    { id: 'open-project', label: 'Open folder…', hint: '⌘⇧O', group: 'File', run: openProject },
    { id: 'open-recents', label: 'Open Recent…', hint: '', group: 'File', run: showRecentEntries },
    { id: 'clear-recents', label: 'Clear recent items', hint: '', group: 'File', run: () => void clearRecentEntries() },
    { id: 'new-file', label: 'New source file…', hint: '⌘N', group: 'File', run: () => openNewSource() },
    ...enabledSourceTypes.map((type) => ({
      id: `new-${type}`,
      label: `New ${SOURCE_META[type].label} source…`,
      hint: '',
      group: 'File',
      run: () => openNewSource(type),
    })),
    { id: 'save', label: 'Save active file', hint: '⌘S', group: 'File', run: () => saveDocument(false) },
    { id: 'save-as', label: 'Save active file as…', hint: '⌘⇧S', group: 'File', run: () => saveDocument(true) },
    { id: 'encoding', label: `Text encoding: ${encodingLabel(activeDocument?.encoding)}`, hint: '', group: 'File', run: openEncodingDialog },
    {
      id: 'render',
      label: activeDocument?.sourceType === 'python' ? 'Show Python source preview' : taskManagedLatex ? `Run project preview${projectPreviewTask ? `: ${projectPreviewTask.label}` : ''}` : 'Render active preview',
      hint: '⌘↵',
      group: activeDocument?.sourceType === 'python' ? 'Python' : taskManagedLatex ? 'Project' : 'Diagram',
      run: () => {
        if (!activeDocument) return;
        if (activeDocument.sourceType === 'python') {
          if (!panelLayoutRef.current.previewOpen) updatePanel('previewOpen', true);
          setPythonInspectorView('source');
          return;
        }
        renderActivePreview();
      },
    },
    ...(activeDocument?.sourceType === 'latex' && !taskManagedLatex ? [
      ...TEX_PDF_ENGINES.map((engine) => ({
        id: `render-latex-${engine.id}-pdf`,
        label: `Preview LaTeX PDF with ${engine.label}`,
        hint: '',
        group: 'LaTeX',
        run: () => {
          setLatexPreviewMode('pdf');
          setTexPdfEngine(engine.id);
          void renderDocument(activeDocument, 'pdf', engine.id);
        },
      })),
      { id: 'render-latex-dvi', label: 'Preview LaTeX DVI with classic LaTeX', hint: '', group: 'LaTeX', run: () => {
        setLatexPreviewMode('dvi');
        void renderDocument(activeDocument, 'dvi');
      } },
    ] : []),
    ...(activeDocument?.sourceType === 'tikz' ? TEX_PDF_ENGINES.map((engine) => ({
      id: `render-tikz-${engine.id}-pdf`,
      label: `Preview TikZ PDF with ${engine.label}`,
      hint: '',
      group: 'TikZ',
      run: () => {
        setTexPdfEngine(engine.id);
        void renderDocument(activeDocument, 'pdf', engine.id);
      },
    })) : []),
    ...(projectBuildTask ? [{
      id: 'project-task-intent-build',
      label: `Project Build: ${projectBuildTask.label}`,
      hint: '⌘⇧B',
      group: 'Project',
      run: () => void runProjectTask(projectBuildTask),
    }] : []),
    ...(projectPreviewTask && projectPreviewTask.id !== projectBuildTask?.id ? [{
      id: 'project-task-intent-preview',
      label: `Project Preview: ${projectPreviewTask.label}`,
      hint: '',
      group: 'Project',
      run: () => void runProjectTask(projectPreviewTask),
    }] : []),
    ...availableProjectTasks.map((task) => ({
      id: `project-task-${task.id}`,
      label: `Run project task: ${task.label}`,
      hint: '',
      group: 'Project',
      run: () => void runProjectTask(task),
    })),
    ...(project ? [{ id: 'project-task-file', label: 'Create or open yedit.tasks.json', hint: '', group: 'Project', run: () => void createProjectTaskConfig() }] : []),
    { id: 'export', label: 'Export active output…', hint: '⌘E', group: 'Diagram', run: () => setExportOpen(true) },
    { id: 'build', label: activeDocument?.sourceType === 'python' ? 'Run active Python source' : taskManagedLatex ? `Run project build${projectBuildTask ? `: ${projectBuildTask.label}` : ''}` : activeDocument?.sourceType === 'metafont' ? 'Convert MetaFont to TTF build profile' : activeDocument?.sourceType === 'latex' ? `Run LaTeX ${texPdfEngineLabel(texPdfEngine)} PDF build profile` : activeDocument?.sourceType === 'tikz' ? `Run TikZ ${texPdfEngineLabel(texPdfEngine)} PDF build profile` : 'Run active source build profile', hint: '⌘⇧B', group: activeDocument?.sourceType === 'python' ? 'Python' : taskManagedLatex ? 'Project' : 'Diagram', run: () => void runPrimaryTask() },
    ...(activeDocument?.sourceType === 'python' ? [
      { id: 'python-test', label: 'Test active Python source', hint: '', group: 'Python', run: () => void runActivePython('test') },
      { id: 'python-output', label: 'Show Python output', hint: '', group: 'Python', run: () => {
        if (!panelLayoutRef.current.previewOpen) updatePanel('previewOpen', true);
        setPythonInspectorView('output');
      } },
    ] : []),
    ...(activeDocument?.sourceType === 'latex' && !taskManagedLatex ? [
      ...TEX_PDF_ENGINES.map((engine) => ({
        id: `build-latex-${engine.id}-pdf`,
        label: `Compile LaTeX to PDF with ${engine.label}`,
        hint: '',
        group: 'LaTeX',
        run: () => {
          setTexPdfEngine(engine.id);
          void runActiveBuild('pdf', engine.id);
        },
      })),
      { id: 'build-latex-dvi', label: 'Compile LaTeX to DVI with classic LaTeX', hint: '', group: 'LaTeX', run: () => void runActiveBuild('dvi') },
    ] : []),
    ...(activeDocument?.sourceType === 'tikz' ? TEX_PDF_ENGINES.map((engine) => ({
      id: `build-tikz-${engine.id}-pdf`,
      label: `Compile TikZ to PDF with ${engine.label}`,
      hint: '',
      group: 'TikZ',
      run: () => {
        setTexPdfEngine(engine.id);
        void runActiveBuild('pdf', engine.id);
      },
    })) : []),
    ...(availableTemplateSourceTypes.length ? [{ id: 'template-gallery', label: 'Open template gallery', hint: '', group: 'File', run: () => setTemplateGalleryOpen(true) }] : []),
    { id: 'format', label: 'Format active source', hint: '⌥⇧F', group: 'Editor', run: formatActive },
    { id: 'json-validate', label: 'Validate JSON', hint: '', group: 'JSON', run: validateActiveJson },
    { id: 'json-pretty', label: 'Pretty-print JSON', hint: '', group: 'JSON', run: prettyPrintActiveJson },
    { id: 'json-minify', label: 'Minify JSON', hint: '', group: 'JSON', run: minifyActiveJson },
    { id: 'json-schema', label: 'Infer JSON Schema Draft', hint: '', group: 'JSON', run: inferActiveJsonSchema },
    { id: 'json-prompt-create', label: 'Prompt: Create JSON', hint: '', group: 'JSON', run: () => openJsonPrompt('create') },
    { id: 'json-prompt-analyze', label: 'Prompt: Analyze current JSON', hint: '', group: 'JSON', run: () => openJsonPrompt('analyze') },
    { id: 'json-prompt-schema', label: 'Prompt: Generate JSON Schema', hint: '', group: 'JSON', run: () => openJsonPrompt('schema') },
    { id: 'undo', label: 'Undo', hint: '⌘Z', group: 'Editor', run: () => editorRef.current?.trigger('command-palette', 'undo', null) },
    { id: 'redo', label: 'Redo', hint: '⇧⌘Z', group: 'Editor', run: () => editorRef.current?.trigger('command-palette', 'redo', null) },
    { id: 'outline', label: 'Show document outline', hint: '⌘⇧O', group: 'Editor', run: () => setOutlineOpen(true) },
    { id: 'history', label: 'Show local version history', hint: '', group: 'Editor', run: () => setHistoryOpen(true) },
    { id: 'search-project', label: 'Find in project…', hint: '⌘⇧F', group: 'Project', run: () => setProjectSearchOpen(true) },
    { id: 'git', label: 'Open Git status', hint: '', group: 'Project', run: openGitPanel },
    { id: 'diff', label: 'Show active Git diff', hint: '', group: 'Project', run: showActiveDiff },
    { id: 'refresh-project', label: 'Refresh project files', hint: '', group: 'Project', run: () => void refreshProject() },
    { id: 'zen', label: zenMode ? 'Exit Zen mode' : 'Enter Zen mode', hint: '⌘⇧Z', group: 'View', run: () => setZenMode((current) => !current) },
    { id: 'auto-render', label: settings.previewAutoRender ? 'Disable automatic preview' : 'Enable automatic preview', hint: '', group: 'View', run: () => setSettings((current) => ({ ...current, previewAutoRender: !current.previewAutoRender })) },
    { id: 'editor-minimap', label: settings.editorMinimap ? 'Hide editor minimap' : 'Show editor minimap', hint: '', group: 'View', run: () => setSettings((current) => ({ ...current, editorMinimap: !current.editorMinimap })) },
    { id: 'navigation-bottom', label: 'Show navigation controls in bottom bar', hint: '', group: 'View', run: () => setSettings((current) => ({ ...current, navigationPlacement: 'bottom' })) },
    { id: 'navigation-left', label: 'Show navigation controls in left rail', hint: '', group: 'View', run: () => setSettings((current) => ({ ...current, navigationPlacement: 'left' })) },
    { id: 'explorer', label: 'Toggle Explorer', hint: '', group: 'View', run: () => togglePanel('explorerOpen') },
    { id: 'preview', label: activeDocument?.sourceType === 'python' ? 'Toggle Python output' : 'Toggle live preview', hint: '', group: 'View', run: () => togglePanel('previewOpen') },
    { id: 'output-viewer', label: 'Open live output viewer', hint: '', group: 'View', run: openOutputViewer },
    { id: 'references', label: 'Toggle reference deck', hint: '⌘⇧R', group: 'View', run: () => togglePanel('referenceOpen') },
    { id: 'reset-layout', label: 'Reset panel layout', hint: '', group: 'View', run: resetPanelLayout },
    { id: 'prompt-studio', label: 'Open Prompt Studio', hint: '⌘⇧L', group: 'View', run: () => setPromptOpen(true) },
    { id: 'ask-ai', label: 'Ask AI with Codex', hint: '', group: 'View', run: () => openAskAi() },
    { id: 'settings', label: 'Open settings', hint: '⌘,', group: 'View', run: () => setSettingsOpen(true) },
    { id: 'help-getting-started', label: 'Yedit Help: Getting Started', hint: '', group: 'Help', run: () => openHelp('getting-started') },
    { id: 'help-shortcuts', label: 'Yedit Help: Keyboard Shortcuts', hint: '', group: 'Help', run: () => openHelp('shortcuts') },
    { id: 'whats-new', label: `What's New in Yedit ${APP_VERSION}`, hint: '', group: 'Help', run: openWhatsNew },
    { id: 'check-updates', label: 'Check for Updates…', hint: '', group: 'Help', run: openUpdates },
    { id: 'about', label: 'About Yedit', hint: '', group: 'Help', run: openAbout },
    ...enabledSourceTypes.map((type, index) => ({
      id: `select-${type}`,
      label: `New ${SOURCE_META[type].label} source`,
      hint: index < 9 ? `⌘${index + 1}` : '',
      group: 'Source type',
      // These are creation shortcuts, not mode selectors.  A shortcut must
      // never unexpectedly bring a starter or an existing document forward.
      run: () => createBlankScratchpad(type),
    })),
  ], [activeDocument, availableProjectTasks, availableTemplateSourceTypes.length, clearRecentEntries, showRecentEntries, createBlankScratchpad, createProjectTaskConfig, documents, enabledSourceTypes, formatActive, inferActiveJsonSchema, latexPreviewMode, minifyActiveJson, newProject, openAbout, openGitPanel, openHelp, openJsonPrompt, openNewSource, openOutputViewer, openProject, openStandaloneFile, openUpdates, openWhatsNew, prettyPrintActiveJson, project, projectBuildTask, projectPreviewTask, refreshProject, renderActivePreview, resetPanelLayout, runActivePython, runPrimaryTask, runProjectTask, saveDocument, settings.editorMinimap, settings.previewAutoRender, showActiveDiff, taskManagedLatex, texPdfEngine, togglePanel, updatePanel, validateActiveJson, zenMode]);

  const actionRef = useRef(actions);
  actionRef.current = actions;

  const runPaletteAction = useCallback((action: { id: string; run: () => void }) => {
    setPaletteHistory((current) => [action.id, ...current.filter((id) => id !== action.id)].slice(0, 8));
    action.run();
  }, []);

  useEffect(() => {
    const unsubscribe = desktop.onMenuAction((action) => {
      if (document.querySelector<HTMLElement>('.app-shell')?.inert || isCloseConfirmationOpen() || isAskAiOpen() || isUpdatesOpen()) return;
      if (recentDialogRef.current && action !== 'open-recents' && action !== 'clear-recents' && recentMenuEntryId(action) === null) return;
      if (action === 'palette') { setPaletteOpen(true); return; }
      if (action === 'help-about') { openAbout(); return; }
      const recentId = recentMenuEntryId(action);
      if (recentId !== null) {
        const current = recentMenuActionRef.current;
        const recent = current.entries.find((entry) => entry.id === recentId);
        if (recent) void current.open(recent).then((opened) => { if (opened) setRecentProjectsOpen(false); });
        else showToast('That item is no longer in Open Recent.', 'info');
        return;
      }
      const requestedType = /^(?:new|select)-(.+)$/.exec(action)?.[1];
      if (requestedType && isKnownSourceType(requestedType) && !isSourceTypeEnabled(requestedType)) {
        showToast(`${SOURCE_META[requestedType].label} is disabled in Settings.`, 'info');
        return;
      }
      const selected = actionRef.current.find((entry) => entry.id === action);
      selected?.run();
    });
    desktop.rendererReady();
    return unsubscribe;
  }, [isSourceTypeEnabled, openAbout, showToast]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (recentDialogRef.current) return;
      if (recordingShortcut) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setRecordingShortcut(null);
          return;
        }
        if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
        event.preventDefault();
        const nextShortcut = shortcutFromEvent(event);
        setShortcutBindings((current) => ({ ...current, [recordingShortcut]: nextShortcut }));
        setRecordingShortcut(null);
        showToast(`${SHORTCUT_ACTIONS.find(([id]) => id === recordingShortcut)?.[1] ?? 'Shortcut'} is now ${shortcutLabel(nextShortcut)}.`, 'success');
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (shortcut === shortcutBindings.quickOpen) {
        event.preventDefault();
        setQuickOpenQuery('');
        setQuickOpenOpen(true);
        return;
      }
      if (shortcut === shortcutBindings.palette) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (shortcut === shortcutBindings.prompt) {
        event.preventDefault();
        setPromptOpen(true);
        return;
      }
      if (shortcut === shortcutBindings.search) {
        event.preventDefault();
        setProjectSearchOpen(true);
        return;
      }
      if (shortcut === shortcutBindings.outline) {
        event.preventDefault();
        setOutlineOpen(true);
        return;
      }
      if (shortcut === shortcutBindings.zen) {
        event.preventDefault();
        setZenMode((current) => !current);
        return;
      }
      if (shortcut === shortcutBindings.build) {
        event.preventDefault();
        void runPrimaryTask();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key === '-') {
          event.preventDefault();
          changeEditorFontSize(-1);
          return;
        }
        if (event.key === '+' || event.key === '=') {
          event.preventDefault();
          changeEditorFontSize(1);
          return;
        }
        if (event.key === '0') {
          event.preventDefault();
          setSettings((current) => ({ ...current, editorFontSize: 14 }));
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [changeEditorFontSize, recordingShortcut, runPrimaryTask, shortcutBindings, showToast]);

  useEffect(() => {
    if (!aboutOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setAboutOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [aboutOpen]);

  useEffect(() => {
    if (!helpTopic && !whatsNewOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setHelpTopic(null);
      setWhatsNewOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [helpTopic, whatsNewOpen]);

  useEffect(() => {
    if (!outputViewerOpen || outputViewerFullscreen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeOutputViewer();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeOutputViewer, outputViewerFullscreen, outputViewerOpen]);

  const configureMonaco = useCallback((monaco: Monaco) => {
    registerFoundryLanguages(monaco);
  }, []);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    const updateCursorLocation = () => {
      const position = editor.getPosition();
      if (!position) return;
      setCursorLocation((current) => current.line === position.lineNumber && current.column === position.column
        ? current
        : { line: position.lineNumber, column: position.column });
    };
    const updateSelection = () => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      setSelectionSource(model && selection ? model.getValueInRange(selection) : '');
    };
    updateCursorLocation();
    updateSelection();
    editor.onDidChangeCursorPosition(updateCursorLocation);
    editor.onDidChangeCursorSelection(updateSelection);
    window.setTimeout(() => {
      if (pendingRevealLineRef.current) revealEditorLine(pendingRevealLineRef.current);
    }, 0);
  }, [revealEditorLine]);

  const visibleReferences = useMemo(() => {
    const query = referenceQuery.trim().toLowerCase();
    const entries = references[activeDocument?.sourceType ?? 'tikz'];
    if (!query) return entries;
    return entries.filter((entry) => [entry.title, entry.category, entry.description, entry.tags.join(' ')].join(' ').toLowerCase().includes(query));
  }, [activeDocument?.sourceType, referenceQuery]);

  const activeOutline = useMemo(() => activeDocument ? documentOutline(activeDocument.sourceType, activeDocument.value) : [], [activeDocument]);
  const activeJsonInspection = useMemo(() => activeDocument?.sourceType === 'json' ? inspectJson(activeDocument.value) : undefined, [activeDocument]);
  const activeTextStatistics = useMemo(() => activeDocument ? textStatistics(activeDocument.value) : { lines: 0, words: 0, characters: 0 }, [activeDocument]);
  const quickOpenResults = useMemo(() => {
    const query = quickOpenQuery.trim();
    if (query.startsWith(':')) {
      const requestedLine = Number.parseInt(query.slice(1), 10);
      return Number.isFinite(requestedLine) && requestedLine > 0 && activeDocument
        ? [{ id: `line-${requestedLine}`, label: `Go to line ${requestedLine}`, detail: activeDocument.name, kind: 'line' as const, run: () => revealEditorLine(requestedLine) }]
        : [];
    }
    if (query.startsWith('@')) {
      const needle = query.slice(1).trim();
      return activeOutline
        .map((entry) => ({ entry, score: fuzzyScore(entry.label, needle) }))
        .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
        .sort((left, right) => right.score - left.score || left.entry.line - right.entry.line)
        .slice(0, 80)
        .map(({ entry }) => ({
          id: `symbol-${entry.id}`,
          label: entry.label,
          detail: `Symbol · line ${entry.line}`,
          kind: 'symbol' as const,
          run: () => revealEditorLine(entry.line),
        }));
    }
    const entries: QuickOpenResult[] = [
      ...documents.map((document) => ({
        id: `tab-${document.id}`,
        label: document.name,
        detail: `${document.pinned ? 'Pinned · ' : ''}Open tab · ${SOURCE_META[document.sourceType].label}`,
        kind: 'tab' as const,
        run: () => setActiveId(document.id),
      })),
      ...(project
        ? flattenFiles(project.tree)
          .filter((node) => node.kind === 'file' && node.supported)
          .map((node) => ({
            id: `file-${node.relativePath}`,
            label: node.name,
            detail: compactPath(node.relativePath, 82),
            kind: 'file' as const,
            run: () => { void openFile(node); },
          }))
        : []),
    ];
    return entries
      .map((entry) => ({ entry, score: fuzzyScore(`${entry.label} ${entry.detail}`, query) }))
      .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
      .sort((left, right) => right.score - left.score || left.entry.label.localeCompare(right.entry.label))
      .slice(0, 100)
      .map(({ entry }) => entry);
  }, [activeDocument, activeOutline, documents, openFile, project, quickOpenQuery, revealEditorLine]);
  const activePythonTask = activeDocument?.sourceType === 'python' && pythonTask.documentId === activeDocument.id
    ? pythonTask
    : EMPTY_PYTHON_TASK;
  const activePythonOutputIsStale = activePythonTask.documentId === activeDocument?.id
    && activePythonTask.revision !== undefined
    && activePythonTask.revision !== activeDocument.revision;

  const filteredActions = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    return query ? actions.filter((action) => `${action.label} ${action.group}`.toLowerCase().includes(query)) : actions;
  }, [actions, paletteQuery]);
  const paletteActions = useMemo(() => {
    if (paletteQuery.trim()) return filteredActions;
    const byId = new Map(actions.map((action) => [action.id, action]));
    const recent = paletteHistory.map((id) => byId.get(id)).filter((action): action is (typeof actions)[number] => Boolean(action));
    return [...recent, ...actions.filter((action) => !paletteHistory.includes(action.id))];
  }, [actions, filteredActions, paletteHistory, paletteQuery]);

  const exportFormats: ExportFormat[] = activeDocument?.sourceType === 'markdown' || activeDocument?.sourceType === 'html' || (activeDocument ? SOURCE_PREVIEW_TYPES.has(activeDocument.sourceType) : false)
    ? ['png', 'pdf', 'html']
    : activeDocument?.sourceType === 'latex'
      ? ['png', 'svg', 'pdf', 'dvi']
      : activeDocument?.sourceType === 'metafont'
        ? ['ttf', 'svg', 'png', 'pdf']
      : ['png', 'svg', 'pdf'];
  // A transformed, compensating shell makes interface scale independent from
  // the source-font preference. The workbench grid above uses the same logical
  // width so larger interface scales never push it past the window edge.
  const appShellStyle: React.CSSProperties = {
    '--ui-scale': String(interfaceScale),
    '--titlebar-leading-inset': `${Math.ceil(MACOS_TITLEBAR_LEADING_INSET / interfaceScale)}px`,
    width: `${100 / interfaceScale}%`,
    height: `${100 / interfaceScale}%`,
  } as React.CSSProperties;
  const monacoWrapStyle: React.CSSProperties = {
    '--editor-background-color': editorCanvasColor(settings.editorBackgroundColor, effectiveAppearance),
  } as React.CSSProperties;
  const appBodyStyle: React.CSSProperties = {
    gridTemplateColumns: `${navigationRailWidth}px ${renderedWorkbenchColumns.explorerWidth}px minmax(0px, 1fr) ${renderedWorkbenchColumns.inspectorWidth}px`,
  };
  const inspectorStyle: React.CSSProperties = {
    gridTemplateRows: panelLayout.previewOpen && panelLayout.referenceOpen
      ? `minmax(220px, ${panelLayout.previewSplit}fr) minmax(180px, ${100 - panelLayout.previewSplit}fr)`
      : 'minmax(0, 1fr)',
  };

  const handleSourceDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = Array.from(event.dataTransfer.files)[0];
    if (!file) {
      showToast('Drop any text file to open it as a tab.', 'info');
      return;
    }
    try {
      const type = sourceTypeForName(file.name);
      const value = await file.text();
      if (value.includes('\0')) {
        showToast('That file appears to be binary data and was not opened.', 'error');
        return;
      }
      const requestedName = sourceFilenameForDrop(file.name, type);
      const base = filenameWithoutExtension(requestedName);
      const dotIndex = requestedName.lastIndexOf('.');
      const extension = dotIndex > 0 ? requestedName.slice(dotIndex) : '';
      let name = requestedName;
      let index = 2;
      while (documentsRef.current.some((document) => document.name === name)) {
        name = `${base} ${index}${extension}`;
        index += 1;
      }
      const document: DocumentModel = {
        id: `drop-${crypto.randomUUID()}`,
        name,
        sourceType: type,
        value,
        dirty: true,
        revision: 0,
      };
      beginDocumentInteraction();
      commitDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setPreview(EMPTY_PREVIEW);
      showToast(`${name} opened as a scratchpad tab. Save it into a project when ready.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not read that dropped file.', 'error');
    }
  }, [beginDocumentInteraction, commitDocuments, showToast]);

  const aboutDialog = aboutOpen && (
    <div className="modal-backdrop about-backdrop" onMouseDown={() => setAboutOpen(false)}>
      <section className="workbench-modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-describedby="about-description" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div><p className="eyebrow">About this editor</p><h2 id="about-title">Yedit</h2></div>
          <button type="button" className="icon-button" autoFocus onClick={() => setAboutOpen(false)} title="Close About Yedit" aria-label="Close About Yedit">×</button>
        </div>
        <div className="about-content">
          <div className="about-identity">
            <div className="about-mark" aria-hidden="true"><span></span><span></span><span></span></div>
            <div><strong>Yedit <code>v{APP_VERSION}</code></strong><small>Developed by Orhan Gökçöl</small></div>
          </div>
          <p id="about-description" className="about-lede">A local-first code editor for diagrams, technical documents, fonts, and everyday source files. Write ordinary text, keep it in your folders, and generate output without turning the editor into a canvas.</p>
          <div className="about-principles" aria-label="Yedit principles">
            <div><strong>Source stays yours</strong><small>Projects, autosaves, previews, and build profiles stay on this Mac.</small></div>
            <div><strong>Preview is a companion</strong><small>Edit code first; render only when a visual check helps.</small></div>
            <div><strong>Optional AI, explicit context</strong><small>Ask AI uses Codex with ChatGPT sign-in only when you press Send. Manual Prompt Studio remains available without connecting.</small></div>
          </div>
          <section className="about-section" aria-labelledby="about-sources-title">
            <div className="about-section-head"><h3 id="about-sources-title">Supported source files</h3><small>Recognized in tabs and opened folders</small></div>
            <div className="about-source-grid">
              {(Object.keys(SOURCE_META) as SourceType[]).map((type) => <span key={type} className="about-source-chip"><i className={SOURCE_META[type].color} aria-hidden="true">{SOURCE_META[type].short}</i><strong>{SOURCE_META[type].label}</strong><code>.{SOURCE_META[type].extension}</code></span>)}
            </div>
          </section>
          <details className="about-attributions">
            <summary><span>Open-source acknowledgements</span><small>{ABOUT_DEPENDENCIES.length} major components</small></summary>
            <p>Major components and their declared licenses for this build. The bundled notices document records the complete attributions.</p>
            <dl>
              {ABOUT_DEPENDENCIES.map((dependency) => <div key={dependency.name}><dt>{dependency.name}<small>{dependency.purpose}</small></dt><dd><code>{dependency.license}</code></dd></div>)}
            </dl>
          </details>
        </div>
        <footer className="about-footer"><span>© {COPYRIGHT_YEAR} Orhan Gökçöl</span><div className="about-footer-actions"><button type="button" className="outline-button" onClick={openWhatsNew}>What’s New</button><button type="button" className="outline-button" onClick={openUpdates}>Check for Updates…</button><button type="button" className="accent-button" onClick={() => setAboutOpen(false)}>Done</button></div></footer>
      </section>
    </div>
  );

  const helpDialog = helpTopic && (
    <div className="modal-backdrop help-backdrop" onMouseDown={() => setHelpTopic(null)}>
      <section className="workbench-modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" aria-describedby="help-description" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div><p className="eyebrow">Yedit help</p><h2 id="help-title">{helpTopic === 'getting-started' ? 'Getting started' : 'Keyboard shortcuts'}</h2></div>
          <button type="button" className="icon-button" autoFocus onClick={() => setHelpTopic(null)} title="Close Yedit help" aria-label="Close Yedit help">×</button>
        </div>
        {helpTopic === 'getting-started' ? (
          <div className="help-content">
            <p id="help-description" className="help-lede">Yedit keeps the source in your own folders. Start with a folder for a project, or open one file when that is all you need.</p>
            <ol className="help-steps">
              <li><span>1</span><div><strong>Open your work</strong><p>Use File → Open Folder for a project tree, or File → Open File for a single document. Yedit remembers recent locations and restores the workspace you were using.</p></div></li>
              <li><span>2</span><div><strong>Choose a source type</strong><p>New Source creates an empty tab. LaTeX, TikZ, MetaFont, Markdown, data, code, and plain-text files get their matching editing support when opened.</p></div></li>
              <li><span>3</span><div><strong>Edit and save locally</strong><p>Save writes only to the file you chose. Autosave, local snapshots, text encodings, font size, themes, and panels can all be adjusted in Settings.</p></div></li>
              <li><span>4</span><div><strong>Preview or run when useful</strong><p>Use Render for visual output, Run Build for local build profiles, and the Python output panel for scripts. Safe Mode keeps local runners and Git changes off until a folder is trusted.</p></div></li>
            </ol>
            <aside className="help-callout"><span>Tip</span><p>Press <kbd>⌘⇧P</kbd> to find any command by name. It is the quickest way to discover a feature without changing your layout.</p></aside>
          </div>
        ) : (
          <div className="help-content">
            <p id="help-description" className="help-lede">These are the standard macOS shortcuts. Quick Open, Command Palette, Prompt Studio, project search, outline, Zen, and builds can be changed in Settings.</p>
            <div className="shortcut-guide" role="list" aria-label="Yedit keyboard shortcuts">
              {[
                ['New source', '⌘N', 'Create an empty source tab'],
                ['Open file', '⌘O', 'Open one file from disk'],
                ['Open folder', '⌘⇧O', 'Open a project workspace'],
                ['Save / Save As', '⌘S / ⌘⇧S', 'Write the active source'],
                ['Quick Open', shortcutLabel(shortcutBindings.quickOpen), 'Switch to an open or project file'],
                ['Command Palette', shortcutLabel(shortcutBindings.palette), 'Search every Yedit command'],
                ['Render preview', '⌘↵', 'Render the active source'],
                ['Run build', shortcutLabel(shortcutBindings.build), 'Run the active local build profile'],
                ['Editor font size', '⌘− / ⌘+ / ⌘0', 'Smaller, larger, or reset'],
                ['Settings', '⌘,', 'Open local preferences'],
              ].map(([label, keys, description]) => <div key={label} role="listitem"><div><strong>{label}</strong><small>{description}</small></div><kbd>{keys}</kbd></div>)}
            </div>
          </div>
        )}
        <footer className="about-footer"><span>Help is available from the macOS Help menu and Command Palette.</span><div className="about-footer-actions"><button type="button" className="outline-button" onClick={openWhatsNew}>What’s New</button><button type="button" className="accent-button" onClick={() => setHelpTopic(null)}>Done</button></div></footer>
      </section>
    </div>
  );

  const whatsNewDialog = whatsNewOpen && (
    <div className="modal-backdrop release-backdrop" onMouseDown={() => setWhatsNewOpen(false)}>
      <section className="workbench-modal release-modal" role="dialog" aria-modal="true" aria-labelledby="release-title" aria-describedby="release-description" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div><p className="eyebrow">Release notes</p><h2 id="release-title">What’s New</h2></div>
          <button type="button" className="icon-button" autoFocus onClick={() => setWhatsNewOpen(false)} title="Close What’s New" aria-label="Close What’s New">×</button>
        </div>
        <div className="release-content">
          <div className="release-hero"><span>Yedit <strong>1.0</strong></span><p id="release-description">Yedit 1.0 is the major release following the v0.3.3 preview. It brings the local-first editor into a complete, daily-use workbench.</p></div>
          <ol className="release-history" aria-label="Yedit version history">
            {RELEASE_HISTORY.map((release, index) => <li key={release.version} className={index === 0 ? 'current' : ''}>
              <div className="release-heading"><div><strong>v{release.version}</strong><span>{release.label}</span></div><h3>{release.title}</h3></div>
              <p>{release.description}</p>
              <ul>{release.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
            </li>)}
          </ol>
        </div>
        <footer className="about-footer"><span>Release notes stay available here for quick comparison.</span><div className="about-footer-actions"><button type="button" className="outline-button" onClick={() => openHelp('getting-started')}>Help</button><button type="button" className="accent-button" onClick={() => setWhatsNewOpen(false)}>Done</button></div></footer>
      </section>
    </div>
  );

  const newSourceDialog = newSourceOpen && (
    <div className="modal-backdrop new-source-backdrop" onMouseDown={() => !isCreatingSource && setNewSourceOpen(false)}>
      <section className="new-source-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="New source file">
        <div className="modal-title"><div><p className="eyebrow">{project ? 'Project file' : 'Scratchpad tab'}</p><h2>New source file</h2></div><button className="icon-button" onClick={() => setNewSourceOpen(false)} disabled={isCreatingSource}>×</button></div>
        <p className="modal-copy">{project ? <>{selectedFolderPath ? <>New files default to <code>{selectedFolderPath}/</code>. </> : ''}Choose a relative path. The new source is empty and stays as an ordinary file in this project.</> : 'Create an empty named scratchpad tab now; save it anywhere later.'}</p>
        <form className="new-source-form" onSubmit={(event) => { event.preventDefault(); void createFile(); }}>
          <fieldset className="new-source-type-picker">
            <legend>Choose an enabled source format</legend>
            <div role="radiogroup" aria-label="Source format">
              {enabledSourceTypes.map((type) => <button key={type} type="button" className={`source-type-option ${newSourceType === type ? 'selected' : ''}`} role="radio" aria-checked={newSourceType === type} onClick={() => changeNewSourceType(type)}>
                <span className={`source-type-icon ${SOURCE_META[type].color}`}>{SOURCE_META[type].short}</span>
                <span><strong>{SOURCE_META[type].label}</strong><small>{SOURCE_DESCRIPTIONS[type]} · .{SOURCE_META[type].extension}</small></span>
              </button>)}
            </div>
          </fieldset>
          <label>{project ? 'Relative path' : 'Tab name'}
            <input autoFocus value={newSourceName} onChange={(event) => setNewSourceName(event.target.value)} placeholder={project
              ? newSourceType === 'text' || newSourceType === 'markdown'
                ? 'notes/review.txt'
                : newSourceType === 'latex'
                  ? 'documents/report.tex'
                  : newSourceType === 'metafont'
                    ? 'fonts/my-font.mf'
                    : newSourceType === 'json' || newSourceType === 'yaml'
                      ? `data/untitled.${SOURCE_META[newSourceType].extension}`
                      : newSourceType === 'tikz' || newSourceType === 'svg' || newSourceType === 'mermaid'
                        ? `diagrams/untitled.${SOURCE_META[newSourceType].extension}`
                        : `source/untitled.${SOURCE_META[newSourceType].extension}`
              : `untitled.${SOURCE_META[newSourceType].extension}`} />
          </label>
          <p className="new-source-hint">The selected format controls the extension. Every new source starts empty; starter content lives in Templates. Manage visible formats in Settings.</p>
          <footer className="new-source-footer"><button type="button" className="outline-button" onClick={() => setNewSourceOpen(false)} disabled={isCreatingSource}>Cancel</button><button type="submit" className="accent-button" disabled={isCreatingSource}>{isCreatingSource ? 'Creating…' : project ? 'Create file' : 'Open tab'}</button></footer>
        </form>
      </section>
    </div>
  );

  const recentProjectsDialog = recentProjectsOpen && (
    <div className="modal-backdrop" onMouseDown={() => setRecentProjectsOpen(false)}>
      <section ref={recentDialogRef} className="workbench-modal recent-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="recent-dialog-title">
        <div className="modal-title">
          <div><p className="eyebrow">Recent files and folders</p><h2 id="recent-dialog-title">Open Recent</h2></div>
          <div className="recent-modal-actions">
            {recentProjects.length > 0 && <button className="compact-button" onClick={() => void clearRecentEntries()}>Clear all</button>}
            <button className="icon-button recent-close-button" onClick={() => setRecentProjectsOpen(false)} title="Close Open Recent" aria-label="Close Open Recent">×</button>
          </div>
        </div>
        <p className="modal-copy">Reopen a file in a tab or a folder as a project. Clearing this list does not delete your files.</p>
        <div className="workbench-list recent-list">
          {(['project', 'file'] as const).map((kind) => {
            const entries = recentProjects.filter((recent) => recent.kind === kind);
            if (!entries.length) return null;
            return <section className="recent-section" key={kind} aria-label={kind === 'project' ? 'Recent folders' : 'Recent files'}>
              <p>{kind === 'project' ? 'Folders' : 'Files'}</p>
              {entries.map((recent) => <article className="recent-entry" key={recent.id}>
                <button className="recent-open-button" onClick={() => {
                  void openRecentEntry(recent).then((didOpen) => { if (didOpen) setRecentProjectsOpen(false); });
                }}>
                  <span>
                    <em>{kind === 'project' ? 'Folder' : 'File'}</em>
                    <strong>{recent.name}</strong>
                    <code>{compactPath(recent.path, 70)}</code>
                  </span>
                  <small>Open</small>
                </button>
                <button className="recent-remove-button" onClick={() => void removeRecentEntry(recent)} title={`Remove ${recent.name} from Recents`} aria-label={`Remove ${recent.name} from Recents`}>×</button>
              </article>)}
            </section>;
          })}
          {!recentProjects.length && <div className="empty-workbench-state">Open a folder or text file and it will appear here for quick reuse.</div>}
        </div>
      </section>
    </div>
  );

  if (!activeDocument) {
    return (
      <main className={`app-shell empty-workspace-shell${dragActive ? ' drag-active' : ''}`} data-theme={effectiveAppearance} style={appShellStyle}>
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
            <div>
              <strong>Yedit</strong>
              <span>source-first visual and code workbench</span>
            </div>
          </div>
          <div className="project-crumb">
            <span className="status-orb"></span>
            <span>{project ? project.name : 'Scratchpad'}</span>
            <small>{project ? project.root : 'No source tabs open'}</small>
          </div>
          <div className="top-actions">
            <button className="ghost-button" onClick={() => void openProject()} title="Open folder (⌘⇧O)">Open folder</button>
            <button className="accent-button empty-new-source-button" onClick={() => openNewSource()}>＋ New source</button>
          </div>
        </header>

        <section
          className={`empty-workspace-stage${project ? ' has-project' : ''}`}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }}
          onDrop={handleSourceDrop}
        >
          {dragActive && <div className="source-drop-overlay" role="status"><span>↓</span><strong>Open source as a new tab</strong><small>Diagrams · documents · data · code</small></div>}
          <section className="empty-workspace-card" aria-label="No editor tabs open">
            <div className="empty-workspace-mark" aria-hidden="true"><span></span><span></span><span></span></div>
            <p className="eyebrow">Workspace ready</p>
            <h1>No source tabs open</h1>
            <p className="recovery-status" role="alert">{recoveryWarning}</p>
            <p>Start with an empty source file, open one file, open a folder, or drop an existing source here. Closing the last tab leaves this workspace ready for the next task.</p>
            <div className="empty-workspace-actions">
              <button className="accent-button" onClick={() => openNewSource()}>＋ New source</button>
              <button className="outline-button" onClick={() => void openStandaloneFile()}>Open file</button>
              <button className="outline-button" onClick={() => void openProject()}>Open folder</button>
              <button className="outline-button" onClick={() => void newProject()}>New project</button>
              <button className="outline-button" onClick={showRecentEntries}>↺ Open Recent{recentProjects.length ? ` (${recentProjects.length})` : ''}</button>
            </div>
            <small>{enabledSourceTypes.length} source type{enabledSourceTypes.length === 1 ? '' : 's'} enabled · Manage availability in Settings</small>
          </section>

          {project && <aside className="empty-workspace-project" aria-label={`${project.name} file navigator`}>
            <div className="empty-workspace-project-head">
              <div><p className="eyebrow">Opened folder</p><strong>{project.name}</strong></div>
              <button className="icon-button" onClick={() => void desktop.shell.reveal(project.root).catch(() => showToast('Could not reveal this project folder.', 'error'))} title="Reveal project folder in Finder" aria-label="Reveal project folder in Finder">↗</button>
            </div>
            <button className="empty-workspace-root" onClick={() => { setSelectedFolderPath(''); setCollapsedPaths(new Set()); }} title={`Navigate to ${project.root}`}><span>⌂</span><span>{selectedFolderPath ? `${project.name}/${selectedFolderPath}` : project.root}</span></button>
            <div className="empty-workspace-tree">
              <FileTree
                nodes={project.tree}
                collapsed={collapsedPaths}
                selectedFolderPath={selectedFolderPath}
                onToggle={(path) => setCollapsedPaths((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path); else next.add(path);
                  return next;
                })}
                onSelectFolder={setSelectedFolderPath}
                onOpen={openFile}
              />
            </div>
            <div className="empty-workspace-project-actions">
              <button className="outline-button" onClick={() => void refreshProject()}>↻ Refresh</button>
              <button className="accent-button" onClick={() => openNewSource()}>＋ New file</button>
            </div>
          </aside>}
        </section>

        <footer className="statusbar">
          <span>No editor tabs open</span>
          <span>Use ⌘N to create an empty source</span>
          <span className="status-recovery" role="status" title={recoveryWarning || recoveryStatus}>{recoveryWarning ? 'Recovery needs attention' : recoveryStatus}</span>
          <span className="status-spacer"></span>
          <button onClick={() => void openStandaloneFile()}>Open file</button>
          <button onClick={() => void openProject()}>Open folder</button>
          <button onClick={() => openNewSource()}>New source</button>
        </footer>
        {toast && <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}</span>{toast.text}</div>}
        {newSourceDialog}
        {recentProjectsDialog}
        {aboutDialog}
        {helpDialog}
        {whatsNewDialog}
      </main>
    );
  }

  return (
    <main className={`app-shell${renderedWorkbenchColumns.compressed ? ' compressed-workbench' : ''}${zenMode ? ' zen-mode' : ''}${dragActive ? ' drag-active' : ''}`} data-theme={effectiveAppearance} style={appShellStyle}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
          <div>
            <strong>Yedit</strong>
              <span>source-first visual and code workbench</span>
          </div>
        </div>
        <div className="project-crumb">
          <span className="status-orb"></span>
          <span>{project ? project.name : 'Scratchpad'}</span>
          <small>{project ? project.root : 'Create or open a folder to start a project'}</small>
        </div>
      </header>

      <section
        className="app-body"
        ref={appBodyRef}
        style={appBodyStyle}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }}
        onDrop={handleSourceDrop}
      >
        {dragActive && <div className="source-drop-overlay" role="status"><span>↓</span><strong>Open source as a new tab</strong><small>TikZ · LaTeX · SVG · Mermaid · Markdown · Text</small></div>}
        {navigationRailVisible && <nav className="activity-rail" aria-label="Workbench navigation">
          <button className="activity" onClick={() => setProjectSearchOpen(true)} title="Find in project" aria-label="Find in project"><span>⌕</span></button>
          <button className="activity" onClick={openGitPanel} title="Open Git status" aria-label="Open Git status"><span>⎇</span></button>
          <button className={`activity ${zenMode ? 'active' : ''}`} onClick={() => setZenMode((current) => !current)} title={zenMode ? 'Exit Zen mode' : 'Enter Zen mode'} aria-label={zenMode ? 'Exit Zen mode' : 'Enter Zen mode'} aria-pressed={zenMode}><span>◐</span></button>
          <button className={`activity ${panelLayout.explorerOpen ? 'active' : ''}`} onClick={() => togglePanel('explorerOpen')} title={panelLayout.explorerOpen ? 'Hide Explorer' : 'Show Explorer'} aria-label={panelLayout.explorerOpen ? 'Hide Explorer' : 'Show Explorer'} aria-pressed={panelLayout.explorerOpen}><span>▦</span></button>
          <button className={`activity ${panelLayout.previewOpen ? 'active' : ''}`} onClick={() => togglePanel('previewOpen')} title={activeDocument.sourceType === 'python' ? panelLayout.previewOpen ? 'Hide Python output' : 'Show Python output' : panelLayout.previewOpen ? 'Hide Live Preview' : 'Show Live Preview'} aria-label={activeDocument.sourceType === 'python' ? panelLayout.previewOpen ? 'Hide Python output' : 'Show Python output' : panelLayout.previewOpen ? 'Hide Live Preview' : 'Show Live Preview'} aria-pressed={panelLayout.previewOpen}><span>{activeDocument.sourceType === 'python' ? '›_' : '◉'}</span></button>
          <button className={`activity ${panelLayout.referenceOpen ? 'active' : ''}`} onClick={() => togglePanel('referenceOpen')} title={panelLayout.referenceOpen ? 'Hide Reference Deck' : 'Show Reference Deck'} aria-label={panelLayout.referenceOpen ? 'Hide Reference Deck' : 'Show Reference Deck'} aria-pressed={panelLayout.referenceOpen}><span>⌘</span></button>
          <button className="activity" onClick={() => openAskAi()} title="Ask AI with Codex" aria-label="Ask AI with Codex"><span>✦</span></button>
          <button className="activity activity-palette" onClick={() => setPaletteOpen(true)} title="Command Palette" aria-label="Open Command Palette"><span>⌘P</span></button>
          <div className="activity-spacer" />
          <button className="activity" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Open Settings"><span>⚙</span></button>
          <button className="activity" onClick={() => void refreshProject()} title="Refresh project" aria-label="Refresh project"><span>↻</span></button>
        </nav>}

        {explorerVisible && <aside className="explorer-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h2>{project ? project.name : 'No project open'}</h2>
            </div>
            <div className="panel-heading-actions">
              <button className="icon-button" onClick={refreshProject} title="Refresh files">↻</button>
              <button className="icon-button" onClick={() => togglePanel('explorerOpen')} title="Hide Explorer">×</button>
            </div>
          </div>
          <div className="project-actions">
            <button className={project ? 'outline-button' : 'accent-button'} onClick={newProject} title="Create a new project folder">New project</button>
            <button className="outline-button" onClick={openProject} title="Open an existing project folder">Open folder</button>
          </div>
          <div className="explorer-utilities">
            <button onClick={() => setProjectSearchOpen(true)} title="Find in project">⌕ Find</button>
            <button onClick={openGitPanel} title="Git status and history">⌘ Git</button>
            <button onClick={() => setTaskConsoleOpen(true)} title="Local build output">›_ Tasks</button>
            {projectTasks.length > 0 && <button className="project-pipeline-indicator" onClick={() => setTaskConsoleOpen(true)} title={`Project pipeline: ${projectTasks.map((task) => task.script || task.label).join(', ')}`}>⚙ Pipeline · {projectTasks[0].script || `${projectTasks.length} task${projectTasks.length === 1 ? '' : 's'}`}</button>}
            <button onClick={() => setTemplateGalleryOpen(true)} disabled={!availableTemplateSourceTypes.length} title={availableTemplateSourceTypes.length ? 'Starter templates' : 'Enable a template-capable source type in Settings'}>▦ Templates</button>
            <button onClick={showRecentEntries} title="Open recent files and folders">↺ Open Recent{recentProjects.length ? ` (${recentProjects.length})` : ''}</button>
          </div>
          {project ? (
            <>
              <div className="project-pathbar">
                <button
                  className={`project-pathbar-root ${selectedFolderPath ? '' : 'selected'}`}
                  onClick={() => { setSelectedFolderPath(''); setCollapsedPaths(new Set()); }}
                  title={`Navigate to ${project.root}`}
                  aria-current={selectedFolderPath ? undefined : 'location'}
                ><span>⌂</span><strong>{project.name}</strong></button>
                <button onClick={() => void desktop.shell.reveal(project.root).catch(() => showToast('Could not reveal this project folder.', 'error'))} title="Reveal project folder in Finder" aria-label="Reveal project folder in Finder">↗</button>
                <small className={selectedFolderPath ? 'is-folder' : ''} title={selectedFolderPath ? `${project.root}/${selectedFolderPath}` : project.root}>{selectedFolderPath ? `${project.name}/${selectedFolderPath}` : project.root}</small>
              </div>
              <div className="tree-caption"><span>FILES</span><span className="tree-location" title={selectedFolderPath || 'Project root'}>{selectedFolderPath || 'Project root'}</span><div className="tree-caption-actions">
                <button onClick={() => setCollapsedPaths(folderPaths(project.tree))} title="Collapse all folders">Fold</button>
                <button disabled={!activeDocument.relativePath} onClick={renameActiveProjectFile}>Rename</button>
                <button disabled={!activeDocument.relativePath} onClick={duplicateActiveProjectFile}>Duplicate</button>
                <button disabled={!activeDocument.relativePath} onClick={deleteActiveProjectFile}>Delete</button>
                <button onClick={() => openNewSource()}>＋ New</button>
              </div></div>
              <div className="file-tree">
                <FileTree
                  nodes={project.tree}
                  activePath={activeDocument.relativePath}
                  collapsed={collapsedPaths}
                  selectedFolderPath={selectedFolderPath}
                  onToggle={(path) => setCollapsedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  })}
                  onSelectFolder={setSelectedFolderPath}
                  onOpen={openFile}
                />
              </div>
            </>
          ) : (
            <div className="empty-project">
              <div className="empty-icon">⌘</div>
              <p>Keep diagram source together in ordinary folders.</p>
              <span>Your files remain portable: diagrams, documents, data, and code stay ordinary files in the folder tree.</span>
            </div>
          )}
          <div className="explorer-footer">
            <button onClick={() => openNewSource()}>＋ New source</button>
            <button onClick={() => setPromptOpen(true)}>✦ Draft with LLM</button>
            {recentProjects.length > 0 && <button onClick={openLatestRecentEntry}>↺ Reopen latest</button>}
            {projectToolbarTasks.length > 0 ? <>
              {projectToolbarTasks.map((task) => <button key={task.id} className="project-task-button" onClick={() => void runProjectTask(task)} disabled={isTaskRunning} title={projectTaskTooltip(task)}>▶ {task.label}</button>)}
              {projectTasks.length > projectToolbarTasks.length && <button onClick={() => setTaskConsoleOpen(true)} title="Show all project tasks">›_ More tasks</button>}
            </> : <button onClick={() => void runPrimaryTask()} title={activeDocument.sourceType === 'python' ? 'Run the current Python editor buffer' : activeDocument.sourceType === 'metafont' ? 'Convert MetaFont source to TTF' : activeDocument.sourceType === 'latex' ? `Compile PDF with ${texPdfEngineLabel(texPdfEngine)}` : activeDocument.sourceType === 'tikz' ? `Compile PDF with ${texPdfEngineLabel(texPdfEngine)}` : 'Run the active source build'}>▶ {activeDocument.sourceType === 'python' ? 'Run Python' : activeDocument.sourceType === 'metafont' ? 'Convert TTF' : activeDocument.sourceType === 'latex' ? `Build ${texPdfEngineLabel(texPdfEngine)}` : activeDocument.sourceType === 'tikz' ? `Build ${texPdfEngineLabel(texPdfEngine)}` : 'Run build'}</button>}
          </div>
          <div className="panel-resizer explorer-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Explorer" onPointerDown={(event) => startPanelResize('explorer', event)} />
        </aside>
        }

        <section className="editor-shell">
          <div className="tab-strip">
            <div className="tabs" ref={tabsRef} role="tablist" aria-label="Open source files" style={{ '--editor-tab-width': `${tabWidth}px` } as CSSProperties}>
              {documents.map((document) => {
                const isActive = document.id === activeDocument?.id;
                const dropPlacement = tabDropTarget?.id === document.id ? tabDropTarget.placement : undefined;
                return <div
                  key={document.id}
                  className={`editor-tab${isActive ? ' selected' : ''}${document.pinned ? ' pinned' : ''}${document.recoveryDraft ? ' recovered' : ''}${draggingTabId === document.id ? ' dragging' : ''}${dropPlacement ? ` drop-${dropPlacement}` : ''}`}
                  data-editor-tab-id={document.id}
                  onPointerDown={(event) => beginTabDrag(event, document.id)}
                >
                  <button
                    type="button"
                    className="tab-activate"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={`${document.name}${document.recoveryDraft ? ', recovered draft' : ''}${document.dirty ? ', unsaved changes' : ''}${document.pinned ? ', pinned' : ''}`}
                    onClick={() => activateTab(document.id)}
                    title={`${document.name}${document.recoveryDraft ? ' · recovered draft' : ''}${document.dirty ? ' · unsaved changes' : ''}${document.pinned ? ' · pinned' : ''}${document.relativePath || document.recoveryOrigin ? `\n${document.relativePath || document.recoveryOrigin}` : ''}`}
                  >
                    <span className={`file-badge ${SOURCE_META[document.sourceType].color}`}>{SOURCE_META[document.sourceType].short}</span>
                    <span className="tab-name"><span className="tab-stem">{splitFileName(document.name).stem}</span><span className="tab-extension">{splitFileName(document.name).extension}</span></span>
                    {document.recoveryDraft && <span className="tab-recovery" aria-hidden="true" title="Recovered draft">↺</span>}
                    {document.pinned && <span className="tab-pin" aria-label="Pinned tab" title="Pinned tab">⌖</span>}
                    {document.dirty && <span className="dirty-dot" aria-hidden="true" title="Unsaved changes"></span>}
                  </button>
                  <button type="button" className="tab-close" onClick={() => closeDocument(document)} title={`Close ${document.name}`} aria-label={`Close ${document.name}`}>×</button>
                </div>;
              })}
            </div>
            {documents.length > 0 && <div className="open-tabs-popover" ref={openTabsPopoverRef}>
              <button
                type="button"
                className="open-tabs-toggle"
                onClick={() => setOpenTabsMenuOpen((current) => !current)}
                aria-expanded={openTabsMenuOpen}
                aria-haspopup="menu"
                title="Show all open files"
                aria-label="Show all open files"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h10M5 17h14M17 10l2 2-2 2" /></svg>
              </button>
              {openTabsMenuOpen && <div className="open-tabs-menu" role="menu" aria-label="Open files">
                {documents.map((document) => <div key={document.id} className={`open-tabs-row${document.id === activeDocument?.id ? ' active' : ''}`}>
                  <button
                    type="button"
                    className="open-tabs-activate"
                    role="menuitem"
                    onClick={() => { setActiveId(document.id); setOpenTabsMenuOpen(false); }}
                    title={document.relativePath ?? document.name}
                  >{document.name}</button>
                  <button
                    type="button"
                    className="open-tabs-close"
                    onClick={() => { closeDocument(document); setOpenTabsMenuOpen(false); }}
                    title={`Close ${document.name}`}
                    aria-label={`Close ${document.name}`}
                  >×</button>
                </div>)}
              </div>}
            </div>}
            <button className="new-tab" onClick={() => openNewSource()} title="New source tab — choose a format" aria-label="New source tab">＋</button>
            {(activeDocument.sourceType === 'latex' || activeDocument.sourceType === 'tikz' || activeDocument.sourceType === 'python' || taskManagedLatex) && <div className="tab-tools">
              {activeDocument.sourceType === 'latex' && !taskManagedLatex && <div className="latex-preview-mode" role="group" aria-label="LaTeX preview format">
                <button className={latexPreviewMode === 'pdf' ? 'selected' : ''} type="button" aria-pressed={latexPreviewMode === 'pdf'} onClick={() => { setLatexPreviewMode('pdf'); void renderDocument(activeDocument, 'pdf'); }} title="Compile and preview PDF">PDF</button>
                <button className={latexPreviewMode === 'dvi' ? 'selected' : ''} type="button" aria-pressed={latexPreviewMode === 'dvi'} onClick={() => { setLatexPreviewMode('dvi'); void renderDocument(activeDocument, 'dvi'); }} title="Compile with classic latex and preview the DVI as SVG when dvisvgm is available">DVI</button>
              </div>}
              {(activeDocument.sourceType === 'tikz' || (activeDocument.sourceType === 'latex' && !taskManagedLatex && latexPreviewMode === 'pdf')) && <label className="tex-engine-select" title="PDF compiler. Choose XeLaTeX or LuaLaTeX for Unicode and fontspec workflows.">
                <span>Engine</span>
                <select value={texPdfEngine} aria-label="TeX PDF engine" onChange={(event) => {
                  const engine = event.target.value as TexPdfEngine;
                  setTexPdfEngine(engine);
                  void renderDocument(activeDocument, 'pdf', engine);
                }}>
                  {TEX_PDF_ENGINES.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
                </select>
              </label>}
              {activeDocument.sourceType === 'latex' && !taskManagedLatex && latexPreviewMode === 'dvi' && <span className="tex-classic-engine" title="DVI always uses classic latex; XeLaTeX and LuaLaTeX produce PDF only.">classic latex</span>}
              {activeDocument.sourceType === 'python' ? <div className="python-run-controls" role="group" aria-label="Python execution controls">
                <button className="compact-button python-run-button" onClick={() => void runActivePython('run')} disabled={isTaskRunning} title="Run the active Python editor buffer locally">▶ Run</button>
                <button className="compact-button python-test-button" onClick={() => void runActivePython('test')} disabled={isTaskRunning} title="Test the active Python editor buffer locally">✓ Test</button>
                <button className="compact-button" onClick={() => { if (!panelLayoutRef.current.previewOpen) updatePanel('previewOpen', true); setPythonInspectorView('output'); }} title="Show Python output in the right panel">› Output</button>
              </div> : taskManagedLatex ? <div className="project-task-toolbar" role="group" aria-label="Project build and preview tasks">
                {isProjectTasksLoading ? <span className="project-task-pending">Project pipeline…</span> : projectToolbarTasks.map((task) => <button key={task.id} className="compact-button project-task-button" onClick={() => void runProjectTask(task)} disabled={isTaskRunning} title={projectTaskTooltip(task)}>▶ {task.label}</button>)}
              </div> : null}
            </div>}
          </div>

          <div className="editor-meta">
            <div className="type-chip"><span className={SOURCE_META[activeDocument.sourceType].color}></span>{SOURCE_META[activeDocument.sourceType].label} source</div>
            {activeJsonInspection && <button className={`json-health ${activeJsonInspection.valid ? 'valid' : 'invalid'}`} onClick={validateActiveJson} title={activeJsonInspection.message}>{activeJsonInspection.valid ? '✓ Valid JSON' : '! Invalid JSON'}</button>}
            {settings.safeMode && <span className="safe-mode-chip" title="Project tasks, native compilers, and Python runs are blocked until Safe Mode is disabled in Settings.">Safe Mode</span>}
            <div className="editor-meta-actions">
              <div className="editor-font-controls" role="group" aria-label="Editor font size">
                <button type="button" onClick={() => changeEditorFontSize(-1)} disabled={settings.editorFontSize <= 11} title="Decrease editor font size (⌘−)" aria-label="Decrease editor font size">−</button>
                <output aria-label={`Editor font size ${settings.editorFontSize} pixels`}>{settings.editorFontSize}px</output>
                <button type="button" onClick={() => changeEditorFontSize(1)} disabled={settings.editorFontSize >= 24} title="Increase editor font size (⌘+)" aria-label="Increase editor font size">+</button>
              </div>
              <button className="editor-command-icon" onClick={() => setOutlineOpen(true)} title="Document outline (⌘⇧O)" aria-label="Document outline"><UniversalIcon name="outline" /></button>
              {activeDocument.sourceType === 'markdown' && <button className="editor-command-icon" onClick={insertMarkdownTableOfContents} title="Insert or refresh a generated Markdown table of contents" aria-label="Insert or refresh table of contents"><UniversalIcon name="table-of-contents" /></button>}
              <button className="editor-command-icon" onClick={() => setHistoryOpen(true)} title="Local version history" aria-label="Local version history"><UniversalIcon name="history" /></button>
              <button className="editor-command-icon" onClick={openEncodingDialog} title={`Text encoding: ${encodingLabel(activeDocument.encoding)}`} aria-label={`Text encoding: ${encodingLabel(activeDocument.encoding)}`}><UniversalIcon name="encoding" /></button>
              <button className={`editor-command-icon ${activeDocument.pinned ? 'active' : ''}`} onClick={toggleActiveTabPin} title={activeDocument.pinned ? 'Unpin active tab' : 'Pin active tab'} aria-label={activeDocument.pinned ? 'Unpin active tab' : 'Pin active tab'} aria-pressed={activeDocument.pinned}><UniversalIcon name="pin" /></button>
              <button className="editor-command-icon" onClick={() => editorRef.current?.trigger('toolbar', 'undo', null)} title="Undo (⌘Z)" aria-label="Undo"><UniversalIcon name="undo" /></button>
              <button className="editor-command-icon" onClick={() => editorRef.current?.trigger('toolbar', 'redo', null)} title="Redo (⇧⌘Z)" aria-label="Redo"><UniversalIcon name="redo" /></button>
              <button className="editor-command-icon save-button" onClick={() => saveDocument(false)} title="Save (⌘S)" aria-label="Save"><UniversalIcon name="save" /></button>
              <button className="editor-command-icon" onClick={() => saveDocument(true)} title="Save As (⇧⌘S)" aria-label="Save As"><UniversalIcon name="save-as" /></button>
              <span className="editor-command-separator" aria-hidden="true"></span>
              <button className="editor-command-icon" onClick={formatActive} title="Format source (⌥⇧F)" aria-label="Format source"><UniversalIcon name="format" /></button>
              {activeDocument.sourceType !== 'python' && !taskManagedLatex && <button className="editor-command-icon render-button" onClick={() => void renderDocument(activeDocument, activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf')} title={activeDocument.sourceType === 'metafont' ? 'Render a local MetaFont glyph proof (⌘↵)' : 'Render preview (⌘↵)'} aria-label={activeDocument.sourceType === 'metafont' ? 'Render MetaFont glyph proof' : 'Render preview'}><UniversalIcon name="render" /></button>}
            </div>
          </div>

          <div className="document-safety">
          <div className="recovery-status" role="alert">{recoveryWarning}</div>
          {activeDocument.recoveryDraft && <div className="document-notice" role="status">
            <span>Recovered draft{activeDocument.recoveryOrigin ? ` — ${activeDocument.recoveryOrigin}` : ''}</span>
            <button onClick={() => void saveDocument(true)}>Save As…</button>
            <button onClick={() => void closeDocument(activeDocument)}>Close…</button>
          </div>}
          {activeDocument.conflict && <div className="document-notice" role="status">
            <span>Changed on disk. Autosave is paused.</span>
            <button onClick={() => void reviewConflict(activeDocument)}>Compare and resolve…</button>
            <button onClick={() => void saveDocument(true)}>Save As…</button>
          </div>}
          </div>
          <div className="monaco-wrap" data-background-pattern={settings.editorBackgroundPattern} style={monacoWrapStyle}>
            <Editor
              key={activeDocument.id}
              height="100%"
              language={SOURCE_META[activeDocument.sourceType].language}
              value={activeDocument.value}
              theme={effectiveAppearance === 'dark' ? 'foundry-night' : 'foundry-day'}
              beforeMount={configureMonaco}
              onMount={handleEditorMount}
              onChange={(value) => updateDocument(activeDocument.id, value ?? '')}
              options={{
                fontSize: settings.editorFontSize,
                fontFamily: `"${settings.editorFontFamily}", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`,
                lineHeight: Math.round(settings.editorFontSize * 1.64),
                minimap: { enabled: settings.editorMinimap, scale: 1, renderCharacters: false },
                padding: { top: 18, bottom: 22 },
                smoothScrolling: true,
                cursorSmoothCaretAnimation: 'on',
                bracketPairColorization: { enabled: true },
                guides: { indentation: true, bracketPairs: true },
                wordWrap: settings.editorWordWrap ? 'on' : 'off',
                tabSize: settings.editorTabSize,
                insertSpaces: true,
                formatOnPaste: true,
                formatOnType: true,
                // Plain-text notes should behave like a distraction-free text
                // editor. Disable both Foundry and Monaco word suggestions for
                // this source type while retaining its syntax highlighting.
                quickSuggestions: activeDocument.sourceType === 'text'
                  ? false
                  : { other: true, comments: false, strings: true },
                suggestOnTriggerCharacters: activeDocument.sourceType !== 'text',
                wordBasedSuggestions: activeDocument.sourceType === 'text' ? 'off' : 'matchingDocuments',
                suggest: { showSnippets: true, showIcons: true, preview: true, shareSuggestSelections: true },
                parameterHints: { enabled: activeDocument.sourceType !== 'text' },
                folding: true,
                showFoldingControls: 'always',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                // Make the editor's scroll affordance dependable on macOS:
                // the visible rail stays available and wheel input is kept by
                // Monaco instead of bubbling into the non-scrolling workbench.
                scrollbar: {
                  vertical: 'visible',
                  horizontal: 'auto',
                  verticalScrollbarSize: 12,
                  horizontalScrollbarSize: 10,
                  alwaysConsumeMouseWheel: true,
                },
                // Highlight the source line itself, not the surrounding
                // gutter. This keeps the active-line cue contained inside
                // the editor instead of drawing against the workbench frame.
                renderLineHighlight: 'line',
                stickyScroll: { enabled: false },
              }}
            />
          </div>
        </section>

        {inspectorOpen && <aside className="inspector-panel" ref={inspectorRef} style={inspectorStyle}>
          {panelLayout.previewOpen && (
            <div className="preview-pane">
              {activeDocument.sourceType === 'python' && pythonInspectorView === 'output' ? <section className="python-output-panel" aria-label="Python output">
                <div className="python-output-heading">
                  <div>
                    <p className="eyebrow">Local Python session</p>
                    <h2>Output</h2>
                  </div>
                  <div className="python-output-heading-actions">
                    <span className={`python-output-status ${activePythonTask.status}`}><i></i>{pythonTaskStatusLabel(activePythonTask)}</span>
                    <button className="compact-button python-source-preview-button" onClick={() => setPythonInspectorView('source')} title="Return to the safe Python source preview">⌘ Source</button>
                    <button className="icon-button" onClick={() => togglePanel('previewOpen')} title="Hide Python output">×</button>
                  </div>
                </div>
                <div className="python-output-controls" role="group" aria-label="Python output actions">
                  <button className="accent-button" onClick={() => void runActivePython('run')} disabled={isTaskRunning}>▶ {isTaskRunning && activePythonTask.mode === 'run' ? 'Running…' : 'Run'}</button>
                  <button className="outline-button" onClick={() => void runActivePython('test')} disabled={isTaskRunning}>✓ {isTaskRunning && activePythonTask.mode === 'test' ? 'Testing…' : 'Test'}</button>
                  <button className="python-output-clear" onClick={() => { setPythonTask(EMPTY_PYTHON_TASK); setTaskOutput('No Python task has run for this source yet.'); }} disabled={activePythonTask.status === 'idle' || activePythonTask.status === 'running'}>Clear</button>
                </div>
                {activePythonTask.command && <div className="python-output-command"><span>Command</span><code>{activePythonTask.command}</code></div>}
                <div className="python-output-scroll" aria-live="polite">
                  {activePythonTask.status === 'idle' && <div className="python-output-empty"><div className="python-output-mark">PY</div><strong>Run the current buffer</strong><p>Run and Test use the source in the editor now—saving is optional. Open a project when the code needs local imports.</p></div>}
                  {activePythonTask.status === 'running' && <div className="python-output-running"><span></span>{activePythonTask.mode === 'test' ? 'Testing the current editor buffer…' : 'Running the current editor buffer…'}</div>}
                  {activePythonOutputIsStale && activePythonTask.status !== 'running' && <div className="python-output-stale">The source has changed since this {activePythonTask.mode === 'test' ? 'test' : 'run'}. Run again to refresh the output.</div>}
                  {activePythonTask.stdout && <section className="python-output-stream stdout"><header><span>stdout</span><small>{activePythonTask.name || activeDocument.name}</small></header><pre>{activePythonTask.stdout}</pre></section>}
                  {activePythonTask.stderr && <section className="python-output-stream stderr"><header><span>{activePythonTask.status === 'unavailable' ? 'Runner' : 'stderr'}</span><small>{activePythonTask.timedOut ? 'Timed out' : typeof activePythonTask.exitCode === 'number' ? `Exit ${activePythonTask.exitCode}` : activePythonTask.name || activeDocument.name}</small></header><pre>{activePythonTask.stderr}</pre></section>}
                  {activePythonTask.status === 'success' && !activePythonTask.stdout && !activePythonTask.stderr && <div className="python-output-empty compact"><strong>{activePythonTask.mode === 'test' ? 'Tests completed successfully.' : 'The program finished without output.'}</strong><p>{typeof activePythonTask.exitCode === 'number' ? `Exit code ${activePythonTask.exitCode}.` : 'No stdout or stderr was produced.'}</p></div>}
                  {activePythonTask.status === 'error' && !activePythonTask.stdout && !activePythonTask.stderr && <div className="python-output-empty compact"><strong>The Python task did not produce a diagnostic.</strong><p>{typeof activePythonTask.exitCode === 'number' ? `Exit code ${activePythonTask.exitCode}.` : 'Try running again; the local runner may have stopped before it could start Python.'}</p></div>}
                </div>
              </section> : <PreviewViewport
                preview={preview}
                sourceType={activeDocument.sourceType}
                previewDocument={preview.kind === 'svg' && preview.content ? previewDocument(preview.content, effectiveAppearance) : undefined}
                htmlDocument={preview.kind === 'html' && preview.content
                  ? activeDocument.sourceType === 'markdown'
                    ? markdownPreviewDocument(preview.content, effectiveAppearance)
                    : preview.content
                  : undefined}
                background={previewBackground}
                onBackgroundChange={setPreviewBackground}
                onRender={renderActivePreview}
                onCopyOutput={preview.kind === 'pdf' ? undefined : copyPreviewOutput}
                onCopyImage={preview.kind === 'svg' ? copyPreviewPng : undefined}
                onExport={() => setExportOpen(true)}
                onPrompt={() => setPromptOpen(true)}
                onOpenViewer={openOutputViewer}
                onJumpToError={(message) => {
                  const line = lineFromRenderMessage(message);
                  if (line) revealEditorLine(line);
                  else showToast('The renderer did not report a source line for this issue.', 'info');
                }}
                onClose={() => togglePanel('previewOpen')}
              />}
              {panelLayout.referenceOpen && <div className="panel-resizer preview-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize preview and references" onPointerDown={(event) => startPanelResize('preview', event)} />}
            </div>
          )}

          {panelLayout.referenceOpen && (
            <section className="reference-section" style={{ '--reference-font-size': `${settings.referenceFontSize}px` } as React.CSSProperties}>
              <div className="reference-header">
                <div>
                  <p className="eyebrow">{SOURCE_META[activeDocument.sourceType].label} reference</p>
                  <h2>Command deck</h2>
                </div>
                <button className="icon-button" onClick={() => togglePanel('referenceOpen')} title="Hide references">×</button>
              </div>
              <label className="reference-search"><span>⌕</span><input value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="Search syntax & snippets" /></label>
              <div className="reference-list">
                {visibleReferences.map((entry) => <ReferenceCard key={entry.id} entry={entry} onInsert={insertSnippet} onCopy={(text) => copyText(text, `${entry.title} copied.`)} />)}
                {!visibleReferences.length && <div className="no-results">No matching reference entry.</div>}
              </div>
            </section>
          )}
          <div className="panel-resizer inspector-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Inspector" onPointerDown={(event) => startPanelResize('inspector', event)} />
        </aside>}
      </section>

      <footer className="statusbar">
        <div className="status-readout">
          <span><i className={`language-dot ${SOURCE_META[activeDocument.sourceType].color}`}></i>{SOURCE_META[activeDocument.sourceType].label}</span>
          <span className="status-file-state">{autoSaving ? 'Saving to file…' : activeDocument.dirty ? 'Unsaved edits' : activeDocument.fileHandle || activeDocument.relativePath ? 'Saved to file' : 'Unsaved draft'}</span>
          <span className="status-recovery" role="status" title={recoveryWarning || recoveryStatus}>{recoveryWarning ? 'Recovery needs attention' : recoveryStatus}</span>
          {(activeDocument.sourceType === 'markdown' || activeDocument.sourceType === 'text') && <span className="status-statistics" title={`${activeTextStatistics.characters.toLocaleString()} characters across ${activeTextStatistics.lines.toLocaleString()} lines`}>{activeTextStatistics.words.toLocaleString()} words</span>}
          <span className="status-detail">{activeDocument.sourceType === 'latex' && taskManagedLatex ? 'Project pipeline' : activeDocument.sourceType === 'metafont' ? 'Manual proof preview' : settings.previewAutoRender ? 'Live preview' : 'Manual preview'}</span>
          <span className="status-detail">Local render · {activeDocument.sourceType === 'tikz' ? `${texPdfEngineLabel(texPdfEngine)} + Poppler` : activeDocument.sourceType === 'latex' ? taskManagedLatex ? 'Project pipeline PDF view' : latexPreviewMode === 'dvi' ? 'classic latex + dvisvgm DVI view' : `${texPdfEngineLabel(texPdfEngine)} PDF view` : activeDocument.sourceType === 'metafont' ? 'mf-nowin GF proof · mf2pt1 + FontForge TTF' : activeDocument.sourceType === 'svg' ? 'Browser SVG + librsvg' : activeDocument.sourceType === 'mermaid' ? 'Mermaid + librsvg' : activeDocument.sourceType === 'markdown' ? 'GFM preview + native WebKit PDF/PNG/HTML' : activeDocument.sourceType === 'html' ? 'Sandboxed HTML preview + native WebKit exports' : activeDocument.sourceType === 'json' ? 'Local JSON validation + structured preview' : activeDocument.sourceType === 'python' ? 'Local Python run/test + source preview' : SOURCE_PREVIEW_TYPES.has(activeDocument.sourceType) ? `Read-only ${SOURCE_META[activeDocument.sourceType].label} source preview` : 'Plain-text preview + native WebKit PDF/PNG/HTML'}</span>
        </div>
        <span className="status-spacer"></span>
        <span className="cursor-location" title="Current cursor position">Row {cursorLocation.line} · Col {cursorLocation.column}</span>
        {navigationPlacement === 'bottom' && <nav className="status-navigation" aria-label="Workbench navigation">
          <button onClick={() => setProjectSearchOpen(true)} title="Find in project">Find</button>
          <button onClick={openGitPanel} title="Open Git status">Git</button>
          <button onClick={() => setZenMode((current) => !current)} title={zenMode ? 'Exit Zen mode' : 'Enter Zen mode'} aria-pressed={zenMode}>{zenMode ? 'Exit Zen' : 'Zen'}</button>
          <button className={panelLayout.explorerOpen ? 'active' : ''} onClick={() => togglePanel('explorerOpen')} title={panelLayout.explorerOpen ? 'Hide Explorer' : 'Show Explorer'} aria-pressed={panelLayout.explorerOpen}>Explorer</button>
          <button className={panelLayout.previewOpen ? 'active' : ''} onClick={() => togglePanel('previewOpen')} title={activeDocument.sourceType === 'python' ? panelLayout.previewOpen ? 'Hide Python output' : 'Show Python output' : panelLayout.previewOpen ? 'Hide Live Preview' : 'Show Live Preview'} aria-pressed={panelLayout.previewOpen}>{activeDocument.sourceType === 'python' ? 'Output' : 'Preview'}</button>
          <button className={panelLayout.referenceOpen ? 'active' : ''} onClick={() => togglePanel('referenceOpen')} title={panelLayout.referenceOpen ? 'Hide Reference Deck' : 'Show Reference Deck'} aria-pressed={panelLayout.referenceOpen}>References</button>
          <button onClick={() => openAskAi()} title="Ask AI with Codex">Ask AI</button>
          <button onClick={() => setPaletteOpen(true)} title="Open Command Palette">⌘⇧P</button>
          <button onClick={() => setSettingsOpen(true)} title="Open Settings">Settings</button>
          <button onClick={() => void refreshProject()} title="Refresh project">Refresh</button>
        </nav>}
      </footer>

      {toast && <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}</span>{toast.text}</div>}

      {paletteOpen && (
        <div className="modal-backdrop" onMouseDown={() => setPaletteOpen(false)}>
          <section className="palette-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Command palette">
            <div className="palette-input"><span>⌘</span><input autoFocus value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Escape') setPaletteOpen(false);
              if (event.key === 'Enter' && paletteActions[0]) { runPaletteAction(paletteActions[0]); setPaletteOpen(false); }
            }} placeholder="Type a command…" /></div>
            <div className="palette-list">
              {paletteActions.map((action, index) => <button key={action.id} onClick={() => { runPaletteAction(action); setPaletteOpen(false); }}><span><small>{!paletteQuery && index < paletteHistory.length ? 'Recent' : action.group}</small>{action.label}</span><kbd>{action.hint}</kbd></button>)}
              {!paletteActions.length && <p>No commands match that search.</p>}
            </div>
            <footer><span>↵ run</span><span>esc close</span><span>{paletteQuery ? 'Search commands and tools.' : 'Recent commands are shown first.'}</span></footer>
          </section>
        </div>
      )}

      {exportOpen && (
        <div className="modal-backdrop" onMouseDown={() => setExportOpen(false)}>
          <section className="export-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><p className="eyebrow">Export active {SOURCE_META[activeDocument.sourceType].label} source</p><h2>Choose an output</h2></div><button className="icon-button" onClick={() => setExportOpen(false)}>×</button></div>
            <p className="modal-copy">{activeDocument.sourceType === 'metafont'
              ? 'A fresh local GF proof is produced for image/PDF exports. TTF export converts mf2pt1-compatible outlines through FontForge; this stays entirely on your Mac.'
              : 'A fresh local render is produced before export, so the saved file always matches the active source. Vector exports stay crisp; PNG uses the scale below.'}</p>
            <div className="export-preset-row" role="group" aria-label="PNG export scale">
              <span>PNG scale</span>
              {([1, 2, 4] as const).map((scale) => <button key={scale} className={exportScale === scale ? 'selected' : ''} onClick={() => setExportScale(scale)} aria-pressed={exportScale === scale}>{scale}×</button>)}
              <small>SVG and PDF retain their vector detail. Transparent source areas remain transparent where the renderer supports it.</small>
            </div>
            <div className={`export-grid ${exportFormats.length === 2 ? 'two' : ''}`}>
              {exportFormats.map((format) => <button key={format} className={`export-option ${format}`} onClick={() => exportActive(format)} disabled={isExporting}>
                <span className="export-icon">{format === 'png' ? '▧' : format === 'svg' ? '◇' : format === 'html' ? '‹/›' : format === 'dvi' ? '⇲' : format === 'ttf' ? 'Aa' : '▤'}</span>
                <strong>{format.toUpperCase()}</strong>
                <small>{format === 'png' ? `${exportScale}× raster image` : format === 'svg' ? 'Editable vector image' : format === 'html' ? 'Portable rendered document' : format === 'dvi' ? 'TeX device-independent output' : format === 'ttf' ? 'OpenType font via mf2pt1 + FontForge' : 'Portable document'}</small>
              </button>)}
            </div>
            {isExporting && <div className="export-progress"><span></span>Preparing export…</div>}
          </section>
        </div>
      )}

      {newSourceDialog}

      {aboutDialog}

      {helpDialog}

      {whatsNewDialog}

      {recentProjectsDialog}

      {conflictReview && <div className="modal-backdrop" onMouseDown={() => setConflictReview(null)}>
        <section className="workbench-modal conflict-modal" role="dialog" aria-modal="true" aria-label="Resolve file conflict" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-title"><h2>Resolve file conflict</h2><button onClick={() => setConflictReview(null)} aria-label="Close comparison">×</button></div>
          <p>Autosave stays paused while you compare. Keep mine replaces the disk version shown here; a newer disk change will stop the save.</p>
          <div className="conflict-columns"><div><h3>Your edits</h3><pre>{conflictReview.value}</pre></div><div><h3>On disk</h3><pre>{conflictReview.disk.content}</pre></div></div>
          <footer><button onClick={() => void resolveConflict('disk')}>Use disk</button><button onClick={() => void resolveConflict('mine')}>Keep mine</button><button disabled={activeDocument.id !== conflictReview.target.id} onClick={() => { setConflictReview(null); void saveDocument(true); }}>Save As…</button></footer>
        </section>
      </div>}

      {encodingOpen && (
        <div className="modal-backdrop" onMouseDown={() => setEncodingOpen(false)}>
          <section className="workbench-modal encoding-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Text encoding">
            <div className="modal-title"><div><p className="eyebrow">Local byte representation</p><h2>Text encoding</h2></div><button className="icon-button" onClick={() => setEncodingOpen(false)}>×</button></div>
            <p className="modal-copy">Choose how Yedit reads a file and how it writes its bytes. It never substitutes unsupported characters on save: choose a capable encoding instead.</p>
            <label className="settings-field">Character encoding
              <select value={encodingChoice} onChange={(event) => setEncodingChoice(event.target.value)}>
                {CHARACTER_ENCODINGS.map((encoding) => <option key={encoding.value} value={encoding.value}>{encoding.label}</option>)}
              </select>
            </label>
            <div className="encoding-current"><strong>{activeDocument.name}</strong><span>Current: {encodingLabel(activeDocument.encoding)}{activeDocument.relativePath || activeDocument.fileHandle ? ' · saved local file' : ' · scratchpad'}</span></div>
            <footer className="settings-footer"><span>Auto detects a UTF BOM, then valid UTF-8, otherwise Windows-1252. The selected codec also applies to the next Open File and recent-file opening.</span><div><button className="outline-button" onClick={() => { setOpeningEncoding(encodingChoice); setEncodingOpen(false); showToast(`Next file will open as ${encodingLabel(encodingChoice)}.`, 'success'); }}>Use for next open</button><button className="outline-button" onClick={setActiveDocumentEncoding}>Use for save</button><button className="accent-button" onClick={() => void reopenActiveWithEncoding()}>{activeDocument.relativePath || activeDocument.fileHandle ? 'Reopen with encoding' : 'Set scratchpad encoding'}</button></div></footer>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Settings">
            <div className="modal-title"><div><p className="eyebrow">Local preferences</p><h2>Settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)}>×</button></div>
            <p className="modal-copy">Preferences are stored locally on this Mac and apply immediately.</p>
            <div className="settings-section">
              <div className="settings-section-head"><span>Appearance</span><small>Choose how Yedit follows your workspace.</small></div>
              <div className="appearance-options" role="radiogroup" aria-label="Appearance">
                {(['system', 'dark', 'light'] as const).map((appearance) => <button key={appearance} className={settings.appearance === appearance ? 'selected' : ''} role="radio" aria-checked={settings.appearance === appearance} onClick={() => setSettings((current) => ({ ...current, appearance }))}>
                  <span>{appearance === 'system' ? '◐' : appearance === 'dark' ? '◑' : '◒'}</span>
                  <strong>{appearance[0].toUpperCase() + appearance.slice(1)}</strong>
                  <small>{appearance === 'system' ? 'Follow macOS' : appearance === 'dark' ? 'Deep workspace' : 'Bright workspace'}</small>
                </button>)}
              </div>
              <div className="interface-scale-control">
                <label className="settings-field font-size-field">Interface scale <output>{settings.uiScale}%</output>
                  <input aria-label="Interface scale" type="range" min="85" max="150" step="5" value={settings.uiScale} onChange={(event) => setSettings((current) => ({ ...current, uiScale: Number(event.target.value) }))} />
                </label>
                <div className="interface-scale-presets" aria-label="Interface scale presets">
                  {[90, 100, 110, 125, 140].map((scale) => <button key={scale} type="button" className={settings.uiScale === scale ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, uiScale: scale }))}>{scale}%</button>)}
                  <span>Scales panels, dialogs, controls, and the editor.</span>
                </div>
              </div>
            </div>
            <div className="settings-section editor-settings">
              <div className="settings-section-head"><span>Code editor</span><small>Typography changes all source modes.</small></div>
              <label className="settings-field">Editor font
                <select value={settings.editorFontFamily} onChange={(event) => setSettings((current) => ({ ...current, editorFontFamily: event.target.value }))}>
                  {EDITOR_FONTS.map((font) => <option key={font} value={font}>{font}</option>)}
                </select>
              </label>
              <label className="settings-field font-size-field">Font size <output>{settings.editorFontSize}px</output>
                <input type="range" min="11" max="24" step="1" value={settings.editorFontSize} onChange={(event) => setSettings((current) => ({ ...current, editorFontSize: Number(event.target.value) }))} />
              </label>
              <label className="settings-field">Indent size
                <select value={settings.editorTabSize} onChange={(event) => setSettings((current) => ({ ...current, editorTabSize: Number(event.target.value) }))}>
                  {[2, 3, 4, 6, 8].map((size) => <option key={size} value={size}>{size} spaces</option>)}
                </select>
              </label>
              <div className="editor-background-settings">
                <div className="editor-background-controls">
                  <label className="settings-field editor-background-color-field">Editor canvas
                    <span>
                      <input
                        aria-label="Editor background color"
                        type="color"
                        value={editorCanvasColor(settings.editorBackgroundColor, effectiveAppearance)}
                        onChange={(event) => setSettings((current) => ({ ...current, editorBackgroundColor: event.target.value.toLowerCase() }))}
                      />
                      <output>{settings.editorBackgroundColor === 'theme' ? 'Theme default' : settings.editorBackgroundColor.toUpperCase()}</output>
                    </span>
                  </label>
                  <button type="button" className="outline-button editor-background-reset" disabled={settings.editorBackgroundColor === 'theme'} onClick={() => setSettings((current) => ({ ...current, editorBackgroundColor: 'theme' }))}>Use theme default</button>
                </div>
                <div className="editor-background-patterns" role="radiogroup" aria-label="Editor background pattern">
                  {EDITOR_BACKGROUND_PATTERNS.map((pattern) => <button key={pattern.value} type="button" className={settings.editorBackgroundPattern === pattern.value ? 'selected' : ''} role="radio" aria-checked={settings.editorBackgroundPattern === pattern.value} onClick={() => setSettings((current) => ({ ...current, editorBackgroundPattern: pattern.value }))}>
                    <span className={`editor-background-swatch ${pattern.value}`} aria-hidden="true"></span>
                    <strong>{pattern.label}</strong>
                    <small>{pattern.description}</small>
                  </button>)}
                </div>
                <small className="editor-background-note">Color and pattern apply only behind the source editor, not the preview or workspace panels.</small>
              </div>
              <div className="settings-switch-grid">
                <label><input type="checkbox" checked={settings.editorWordWrap} onChange={(event) => setSettings((current) => ({ ...current, editorWordWrap: event.target.checked }))} /><span><strong>Word wrap</strong><small>Keep long labels and prose visible.</small></span></label>
                <label><input type="checkbox" checked={settings.editorMinimap} onChange={(event) => setSettings((current) => ({ ...current, editorMinimap: event.target.checked }))} /><span><strong>Minimap</strong><small>Show a compact source overview.</small></span></label>
                <label><input type="checkbox" checked={settings.formatOnSave} onChange={(event) => setSettings((current) => ({ ...current, formatOnSave: event.target.checked }))} /><span><strong>Format on save</strong><small>Run the local beautifier before writing.</small></span></label>
              </div>
            </div>
            <div className="settings-section source-type-settings">
              <div className="settings-section-head"><span>Available source types</span><small>{enabledSourceTypes.length} of {SOURCE_TYPES.length} enabled. Disabled formats stay editable when already open, but no longer appear in New Source, templates, or new-file commands.</small></div>
              <div className="source-type-toggle-grid" role="group" aria-label="Available source types">
                {SOURCE_TYPES.map((type) => {
                  const enabled = isSourceTypeEnabled(type);
                  const locked = enabled && enabledSourceTypes.length === 1;
                  return <button key={type} type="button" role="switch" aria-checked={enabled} aria-label={`${SOURCE_META[type].label} ${enabled ? 'enabled' : 'disabled'}`} title={locked ? 'Keep at least one source type enabled.' : `${enabled ? 'Disable' : 'Enable'} ${SOURCE_META[type].label}`} disabled={locked} className={`${enabled ? 'selected' : ''}${locked ? ' locked' : ''}`} onClick={() => toggleSourceType(type)}>
                    <i className={SOURCE_META[type].color} aria-hidden="true">{SOURCE_META[type].short}</i>
                    <span><strong>{SOURCE_META[type].label}</strong><small>.{SOURCE_META[type].extension} · {enabled ? 'Enabled' : 'Disabled'}</small></span>
                    <b aria-hidden="true">{enabled ? '✓' : '—'}</b>
                  </button>;
                })}
              </div>
              <p className="source-type-settings-note">Starter templates follow the same setting. Re-enable a type at any time; your files and folders are never removed.</p>
            </div>
            <div className="settings-section automation-settings">
              <div className="settings-section-head"><span>Workflow</span><small>Keep local source and preview in sync without losing control.</small></div>
              <div className="settings-switch-grid">
                <label><input type="checkbox" checked={settings.autoSave} onChange={(event) => setSettings((current) => ({ ...current, autoSave: event.target.checked }))} /><span><strong>Auto-save saved files</strong><small>Write project and individually opened files after a brief idle pause; scratchpad tabs stay unsaved.</small></span></label>
                <label><input type="checkbox" checked={settings.previewAutoRender} onChange={(event) => setSettings((current) => ({ ...current, previewAutoRender: event.target.checked }))} /><span><strong>Automatic preview</strong><small>Render after source changes; use Render for manual builds anytime.</small></span></label>
                <label><input type="checkbox" checked={settings.safeMode} onChange={(event) => setSettings((current) => ({ ...current, safeMode: event.target.checked }))} /><span><strong>Safe Mode</strong><small>Keep projects passive: block local builds, project tasks, and Python runs until you explicitly trust the folder.</small></span></label>
              </div>
            </div>
            <div className="settings-section shortcut-settings">
              <div className="settings-section-head"><span>Keyboard shortcuts</span><small>Click Record, then press the key combination you want. These bindings are stored locally.</small></div>
              <div className="shortcut-list">
                {SHORTCUT_ACTIONS.map(([id, label]) => <div key={id}><span>{label}</span><kbd>{recordingShortcut === id ? 'Press keys…' : shortcutLabel(shortcutBindings[id])}</kbd><button onClick={() => setRecordingShortcut(recordingShortcut === id ? null : id)}>{recordingShortcut === id ? 'Cancel' : 'Record'}</button></div>)}
              </div>
              <button className="reset-layout-button" onClick={() => { setShortcutBindings(DEFAULT_SHORTCUTS); setRecordingShortcut(null); }}>Reset shortcut defaults</button>
            </div>
            <div className="settings-section panel-settings">
              <div className="settings-section-head"><span>Workspace panels</span><small>Turn each panel fully on or off. Drag the cyan dividers to resize visible panels.</small></div>
              <label className="settings-field">Navigation controls
                <select value={navigationPlacement} aria-label="Navigation controls placement" onChange={(event) => setSettings((current) => ({ ...current, navigationPlacement: event.target.value as AppSettings['navigationPlacement'] }))}>
                  <option value="bottom">Bottom status bar</option>
                  <option value="left">Left activity rail</option>
                </select>
              </label>
              <small className="navigation-placement-note">The selected surface contains Find, Git, Zen, panels, Prompt Studio, Command Palette, Settings, and Refresh. Status and row/column stay below the editor.</small>
              <div className="panel-toggle-grid">
                <button className={panelLayout.explorerOpen ? 'selected' : ''} aria-pressed={panelLayout.explorerOpen} onClick={() => togglePanel('explorerOpen')}><span>▦</span><strong>Explorer</strong><small>{panelLayout.explorerOpen ? 'Visible' : 'Hidden'}</small></button>
                <button className={panelLayout.previewOpen ? 'selected' : ''} aria-pressed={panelLayout.previewOpen} onClick={() => togglePanel('previewOpen')}><span>◉</span><strong>Live preview</strong><small>{panelLayout.previewOpen ? 'Visible' : 'Hidden'}</small></button>
                <button className={panelLayout.referenceOpen ? 'selected' : ''} aria-pressed={panelLayout.referenceOpen} onClick={() => togglePanel('referenceOpen')}><span>⌘</span><strong>Command deck</strong><small>{panelLayout.referenceOpen ? 'Visible' : 'Hidden'}</small></button>
              </div>
              <button className="reset-layout-button" onClick={resetPanelLayout}>Reset panel sizes</button>
            </div>
            <div className="settings-section reference-settings">
              <div className="settings-section-head"><span>Reference helper</span><small>Adjust the Command deck text independently from the code editor.</small></div>
              <label className="settings-field font-size-field">Helper text size <output>{settings.referenceFontSize}px</output>
                <input type="range" min="9" max="18" step="1" value={settings.referenceFontSize} onChange={(event) => setSettings((current) => ({ ...current, referenceFontSize: Number(event.target.value) }))} />
              </label>
            </div>
            <footer className="settings-footer"><span>Syntax coloring, snippets, hover help, folding, and local diagnostics support diagram, document, data, and everyday programming sources.</span><div><button type="button" className="outline-button settings-about-button" onClick={() => { setSettingsOpen(false); openAbout(); }}>About Yedit</button><button className="accent-button" onClick={() => setSettingsOpen(false)}>Done</button></div></footer>
          </section>
        </div>
      )}

      {outlineOpen && (
        <div className="modal-backdrop" onMouseDown={() => setOutlineOpen(false)}>
          <section className="workbench-modal outline-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Document outline">
            <div className="modal-title"><div><p className="eyebrow">Navigate source structure</p><h2>{activeDocument.name} outline</h2></div><button className="icon-button" onClick={() => setOutlineOpen(false)}>×</button></div>
            <p className="modal-copy">Headings, groups, nodes, and key elements are detected locally as you edit.</p>
            <div className="workbench-list outline-list">
              {activeOutline.map((entry) => <button key={entry.id} style={{ paddingLeft: 14 + entry.depth * 15 }} onClick={() => { revealEditorLine(entry.line); setOutlineOpen(false); }}><span className={`outline-kind ${entry.kind}`}>{entry.kind === 'section' ? '§' : entry.kind === 'node' ? '◇' : entry.kind === 'group' ? '▱' : '·'}</span><span>{entry.label}</span><small>Ln {entry.line}</small></button>)}
              {!activeOutline.length && <div className="empty-workbench-state">No navigable structure was detected yet. Add a heading, group, or named source element.</div>}
            </div>
          </section>
        </div>
      )}

      {historyOpen && (
        <div className="modal-backdrop" onMouseDown={() => setHistoryOpen(false)}>
          <section className="workbench-modal history-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Local version history">
            <div className="modal-title"><div><p className="eyebrow">Local version history</p><h2>Recent source snapshots</h2></div><button className="icon-button" onClick={() => setHistoryOpen(false)}>×</button></div>
            <p className="modal-copy">Snapshots stay only on this Mac. Restoring one is reversible through the editor’s Undo command.</p>
            <div className="workbench-list history-list">
              {snapshots.map((snapshot, index) => <article key={snapshot.id}><div><strong>{index === 0 ? 'Latest local snapshot' : `Snapshot ${snapshots.length - index}`}</strong><small>{displayTime(snapshot.createdAt)} · {snapshot.value.split('\n').length} lines</small></div><div><code>{snapshot.value.trim().slice(0, 92) || 'Empty source'}</code><button onClick={() => restoreSnapshot(snapshot)}>Restore</button></div></article>)}
              {!snapshots.length && <div className="empty-workbench-state">Start editing to create a local snapshot. Up to 32 recent versions are kept per source.</div>}
            </div>
          </section>
        </div>
      )}

      {quickOpenOpen && (
        <div className="modal-backdrop" onMouseDown={() => setQuickOpenOpen(false)}>
          <section className="workbench-modal quick-open-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Quick Open">
            <div className="modal-title"><div><p className="eyebrow">Fast local navigation</p><h2>Quick Open</h2></div><button className="icon-button" onClick={() => setQuickOpenOpen(false)} aria-label="Close Quick Open">×</button></div>
            <form className="project-search-form" onSubmit={(event) => {
              event.preventDefault();
              const result = quickOpenResults[0];
              if (!result) return;
              result.run();
              setQuickOpenOpen(false);
            }}>
              <input autoFocus value={quickOpenQuery} onChange={(event) => setQuickOpenQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); setQuickOpenOpen(false); }
              }} placeholder="Files and tabs · @ symbols · : line" />
              <button className="accent-button" type="submit" disabled={!quickOpenResults.length}>Open</button>
            </form>
            <p className="quick-open-help"><kbd>@</kbd> current-document symbols <span>·</span><kbd>:</kbd> line number <span>·</span> fuzzy-match tabs and project files</p>
            <div className="workbench-list search-results quick-open-results">
              {quickOpenResults.map((result) => <button key={result.id} onClick={() => { result.run(); setQuickOpenOpen(false); }}><span><strong>{result.label}</strong><code>{result.detail}</code></span><small>{result.kind === 'tab' ? 'Tab' : result.kind === 'file' ? 'File' : result.kind === 'symbol' ? 'Symbol' : 'Line'}</small></button>)}
              {!quickOpenResults.length && <div className="empty-workbench-state">{quickOpenQuery ? 'No local file, tab, symbol, or line matches that query.' : 'Open a file or folder to start navigating.'}</div>}
            </div>
          </section>
        </div>
      )}

      {projectSearchOpen && (
        <div className="modal-backdrop" onMouseDown={() => setProjectSearchOpen(false)}>
          <section className="workbench-modal project-search-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Find in project">
            <div className="modal-title"><div><p className="eyebrow">Project-wide source search</p><h2>Find in project</h2></div><button className="icon-button" onClick={() => setProjectSearchOpen(false)}>×</button></div>
            <form className="project-search-form" onSubmit={(event) => { event.preventDefault(); void searchProject(); }}>
              <input autoFocus value={projectSearchQuery} onChange={(event) => setProjectSearchQuery(event.target.value)} placeholder={project ? `Search ${project.name}…` : 'Open a project to search…'} disabled={!project} />
              <button className="accent-button" type="submit" disabled={!project || isProjectSearching}>{isProjectSearching ? 'Searching…' : 'Search'}</button>
            </form>
            <div className="workbench-list search-results">
              {projectSearchHits.map((hit, index) => <button key={`${hit.node.relativePath}-${hit.line}-${hit.column}-${index}`} onClick={() => { void openFile(hit.node, hit.line); setProjectSearchOpen(false); }}><span><strong>{compactPath(hit.node.relativePath)}</strong><code>Ln {hit.line}, Col {hit.column} · {hit.excerpt}</code></span><small>Open</small></button>)}
              {project && projectSearchQuery && !isProjectSearching && !projectSearchHits.length && <div className="empty-workbench-state">No text matches yet. Press Search to scan the project’s text files.</div>}
              {!project && <div className="empty-workbench-state">Open a project folder to search across its text files.</div>}
            </div>
          </section>
        </div>
      )}

      {templateGalleryOpen && (
        <div className="modal-backdrop" onMouseDown={() => setTemplateGalleryOpen(false)}>
          <section className="workbench-modal template-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Template gallery">
            <div className="modal-title"><div><p className="eyebrow">Source-first starters</p><h2>Template gallery</h2></div><button className="icon-button" onClick={() => setTemplateGalleryOpen(false)}>×</button></div>
            <p className="modal-copy">{availableTemplateSourceTypes.length ? 'Open a complete local starter in a fresh tab, then adapt it as ordinary source.' : 'All template-capable source types are disabled. Enable one in Settings to use its local starter.'}</p>
            <div className="template-grid">
              {availableTemplateSourceTypes.map((type) => <button key={type} type="button" className={`template-card ${SOURCE_META[type].color}`} aria-label={`Open ${SOURCE_META[type].label} starter template (${samples[type].name})`} onClick={() => { createUnsavedStarterDocument(type); setTemplateGalleryOpen(false); }}><span className="template-badge">{SOURCE_META[type].short}</span><span className="template-card-copy"><strong>{SOURCE_META[type].label} starter</strong><small>{SOURCE_DESCRIPTIONS[type]} <code>{samples[type].name}</code></small></span><span className="template-card-open" aria-hidden="true">→</span></button>)}
              {!availableTemplateSourceTypes.length && <div className="empty-workbench-state template-empty-state">No templates are currently available.</div>}
            </div>
          </section>
        </div>
      )}

      {gitOpen && (
        <div className="modal-backdrop" onMouseDown={() => setGitOpen(false)}>
          <section className="workbench-modal git-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Git status">
            <div className="modal-title"><div><p className="eyebrow">Local repository workspace</p><h2>Git status {gitInfo?.branch ? `· ${gitInfo.branch}` : ''}</h2></div><div><button className="compact-button" onClick={() => void openGitPanel()} disabled={isGitLoading || isGitMutating}>↻ Refresh</button><button className="icon-button" onClick={() => setGitOpen(false)}>×</button></div></div>
            {isGitLoading && <div className="empty-workbench-state">Inspecting this project locally…</div>}
            {!isGitLoading && !gitInfo?.available && <div className="empty-workbench-state">{gitInfo?.message || 'This folder is not a Git repository.'}</div>}
            {!isGitLoading && gitInfo?.available && <>
              <div className="git-toolbar"><span>{gitInfo.files?.length ? `${gitInfo.files.length} changed file${gitInfo.files.length === 1 ? '' : 's'}` : 'Working tree clean'}</span><div className="git-toolbar-actions">{gitInfo.branches?.length ? <label className="git-branch-picker">Branch <select value={gitInfo.branch || ''} onChange={(event) => { const branch = event.target.value; if (project && branch && branch !== gitInfo.branch) void runGitMutation(`Switched to ${branch}.`, () => desktop.git.switchBranch(project.root, branch)); }} disabled={settings.safeMode || isGitMutating}><option value="" disabled>Select branch</option>{gitInfo.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label> : null}<button onClick={showActiveDiff}>View active diff</button></div></div>
              {settings.safeMode && <div className="git-safe-mode-note">Safe Mode is on: staging, unstaging, commits, and branch switches are disabled.</div>}
              <div className="git-grid">
                <div><h3>Changes</h3><div className="workbench-list git-changes">{gitInfo.files?.map((file) => { const staged = Boolean(file.index && file.index !== ' ' && file.index !== '?'); const canStage = !staged || Boolean(file.workingTree && file.workingTree !== ' '); return <article key={file.path}><div className="git-change-main"><b>{file.status || `${file.index || ' '} ${file.workingTree || ' '}`}</b><code>{file.path}</code></div><div className="git-change-actions"><button onClick={() => void showGitDiff(file.path)} disabled={isGitMutating}>Diff</button>{staged && <button onClick={() => void showGitDiff(file.path, true)} disabled={isGitMutating}>Staged</button>}{canStage && <button onClick={() => project && void runGitMutation(`Staged ${file.path}.`, () => desktop.git.stage(project.root, file.path))} disabled={settings.safeMode || isGitMutating}>Stage</button>}{staged && <button onClick={() => project && void runGitMutation(`Unstaged ${file.path}.`, () => desktop.git.unstage(project.root, file.path))} disabled={settings.safeMode || isGitMutating}>Unstage</button>}</div></article>; })}{!gitInfo.files?.length && <div className="empty-workbench-state">No uncommitted project files.</div>}</div></div>
                <div><h3>Recent commits</h3><div className="workbench-list git-commits">{gitInfo.commits?.map((commit) => <span key={commit.hash}><b>{commit.hash}</b><strong>{commit.subject}</strong><small>{commit.author} · {commit.date ? new Date(commit.date).toLocaleDateString() : ''}</small></span>)}{!gitInfo.commits?.length && <div className="empty-workbench-state">No commits are available yet.</div>}</div></div>
              </div>
              <div className="git-commit-box"><label htmlFor="git-commit-message">Commit staged changes</label><div><input id="git-commit-message" value={gitCommitMessage} maxLength={240} onChange={(event) => setGitCommitMessage(event.target.value)} placeholder="Describe this local change" disabled={settings.safeMode || isGitMutating} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitGitChanges(); } }} /><button className="accent-button" onClick={commitGitChanges} disabled={settings.safeMode || isGitMutating || !gitCommitMessage.trim() || !gitInfo.files?.some((file) => Boolean(file.index && file.index !== ' ' && file.index !== '?'))}>Commit</button></div><small>Only staged files are committed. Yedit does not run Git hooks or signing prompts.</small></div>
            </>}
          </section>
        </div>
      )}

      {taskConsoleOpen && (
        <div className="modal-backdrop" onMouseDown={() => setTaskConsoleOpen(false)}>
          <section className="workbench-modal task-console-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Task Console">
            <div className="modal-title"><div><p className="eyebrow">Local build and inspection output</p><h2>Task Console</h2></div><button className="icon-button" onClick={() => setTaskConsoleOpen(false)}>×</button></div>
            {projectTasks.length > 0 && <div className="task-console-pipeline"><span>Project pipeline{projectTasks[0].script ? ` · ${projectTasks[0].script}` : ''}</span><small>{projectTasks.map((task) => task.label).join(' · ')}</small></div>}
            <div className="task-console-actions">{projectTasks.map((task) => <button key={task.id} className="outline-button project-task-button" onClick={() => void runProjectTask(task)} disabled={isTaskRunning} title={projectTaskTooltip(task)}>▶ {task.label}</button>)}{activeDocument.sourceType === 'python' ? <>
              <button className="accent-button" onClick={() => void runActivePython('run')} disabled={isTaskRunning}>{isTaskRunning ? 'Running…' : 'Run Python'}</button>
              <button className="outline-button" onClick={() => void runActivePython('test')} disabled={isTaskRunning}>Test Python</button>
            </> : taskManagedLatex ? null : <><button className="accent-button" onClick={() => void runPrimaryTask()} disabled={isTaskRunning}>{isTaskRunning ? 'Running…' : activeDocument.sourceType === 'metafont' ? 'Convert MetaFont to TTF' : activeDocument.sourceType === 'latex' ? `Compile LaTeX PDF with ${texPdfEngineLabel(texPdfEngine)}` : activeDocument.sourceType === 'tikz' ? `Compile TikZ PDF with ${texPdfEngineLabel(texPdfEngine)}` : 'Run active source build'}</button>{activeDocument.sourceType === 'latex' && <button className="outline-button" onClick={() => void runActiveBuild('dvi')} disabled={isTaskRunning} title="DVI always uses classic latex">Compile DVI · classic latex</button>}</>}<button className="outline-button" onClick={showActiveDiff} disabled={isTaskRunning}>Show Git diff</button></div>
            <pre className="task-console-output">{taskOutput}</pre>
          </section>
        </div>
      )}

      {promptOpen && (
        <div className="modal-backdrop prompt-backdrop" onMouseDown={() => setPromptOpen(false)}>
          <section className="prompt-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><p className="eyebrow">LLM handoff, without an API lock-in</p><h2>Prompt Studio</h2></div><button className="icon-button" onClick={() => setPromptOpen(false)}>×</button></div>
            <p className="modal-copy">{activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? 'Prepare a local JSON review prompt, copy it to any LLM, then paste the response back as a separate Markdown note.' : 'Describe the source artifact, copy the prompt to any LLM, then paste its source response directly into this editor.'}</p>
            <div className="prompt-layout">
              <form className="prompt-form" onSubmit={(event) => event.preventDefault()}>
                <label>Target source<span className={`source-label ${SOURCE_META[activeDocument.sourceType].color}`}>{SOURCE_META[activeDocument.sourceType].label}</span></label>
                {activeDocument.sourceType === 'json' && <fieldset className="json-prompt-intents">
                  <legend>JSON workflow</legend>
                  <div role="group" aria-label="JSON prompt workflow">
                    {([['create', 'Create'], ['analyze', 'Analyze'], ['schema', 'Schema']] as const).map(([intent, label]) => <button key={intent} type="button" className={promptSpec.jsonIntent === intent ? 'selected' : ''} aria-pressed={promptSpec.jsonIntent === intent} onClick={() => openJsonPrompt(intent)}>{label}</button>)}
                  </div>
                  <small>{promptSpec.jsonIntent === 'create' ? 'Ask for strict JSON that can be applied safely.' : promptSpec.jsonIntent === 'analyze' ? 'Review the current JSON and open the reply as Markdown.' : 'Generate an editable JSON Schema Draft from the current file.'}</small>
                </fieldset>}
                <label>{activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? 'What should the review focus on?' : 'What should it produce?'}<textarea autoFocus value={promptSpec.goal} onChange={(event) => setPromptSpec((spec) => ({ ...spec, goal: event.target.value }))} placeholder={activeDocument.sourceType === 'json' ? 'e.g. identify data-quality issues and infer a safe schema' : 'e.g. A resilient service topology with queues, retry paths, and observability'} /></label>
                <label>Audience / purpose<input value={promptSpec.audience} onChange={(event) => setPromptSpec((spec) => ({ ...spec, audience: event.target.value }))} placeholder="e.g. Engineering design review" /></label>
                <label>Visual direction<textarea value={promptSpec.style} onChange={(event) => setPromptSpec((spec) => ({ ...spec, style: event.target.value }))} /></label>
                <label>Technical constraints<textarea value={promptSpec.constraints} onChange={(event) => setPromptSpec((spec) => ({ ...spec, constraints: event.target.value }))} placeholder="e.g. use only arrows.meta and positioning; landscape; 16:9" /></label>
                <label className="check-label"><input type="checkbox" checked={activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? false : promptSpec.outputOnly} disabled={activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze'} onChange={(event) => setPromptSpec((spec) => ({ ...spec, outputOnly: event.target.checked }))} /> {activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? 'Markdown analysis—never overwrite the JSON file' : activeDocument.sourceType === 'markdown' || activeDocument.sourceType === 'text' ? 'Document only—no outer fence or explanation' : 'Source only—no Markdown fences or explanation'}</label>
                <fieldset className="prompt-context-options">
                  <legend>Include context</legend>
                  <label className="check-label"><input type="checkbox" checked={activeDocument.sourceType === 'json' && promptSpec.jsonIntent !== 'create' ? true : promptSpec.includeActiveFile} disabled={activeDocument.sourceType === 'json' && promptSpec.jsonIntent !== 'create'} onChange={(event) => setPromptSpec((spec) => ({ ...spec, includeActiveFile: event.target.checked }))} /> Full active source</label>
                  <label className="check-label"><input type="checkbox" checked={promptSpec.includeProjectContext} onChange={(event) => setPromptSpec((spec) => ({ ...spec, includeProjectContext: event.target.checked }))} disabled={!project} /> Project file map</label>
                  <label className="check-label"><input type="checkbox" checked={promptSpec.includeRenderError} onChange={(event) => setPromptSpec((spec) => ({ ...spec, includeRenderError: event.target.checked }))} disabled={preview.status !== 'error'} /> Current render error</label>
                  <small>{selectionSource ? 'The current editor selection is included automatically.' : 'Select source in the editor to add focused context.'}</small>
                </fieldset>
              </form>
              <div className="prompt-preview">
                <div className="prompt-preview-head"><span>Generated prompt</span><button onClick={() => copyText(promptText, 'Prompt copied — send it to your preferred LLM.')}>Copy prompt</button><button disabled={settings.safeMode} onClick={() => { setPromptOpen(false); openAskAi(promptText); }}>Ask Codex…</button></div>
                <textarea readOnly value={promptText} aria-label="Generated LLM prompt" />
                <div className="prompt-tips"><span>✦ Context stays on this Mac until you copy it.</span><span>✓ No API key or remote service is used here.</span></div>
                <div className="prompt-response">
                  <label>{activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? 'Paste the JSON review' : 'Paste the LLM response'}
                    <textarea value={promptReply} onChange={(event) => setPromptReply(event.target.value)} placeholder={activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? 'Paste the Markdown analysis from your preferred LLM. It will open as a separate note.' : 'Paste source from your preferred LLM. Matching outer code fences are removed automatically.'} />
                  </label>
                  <div className="prompt-apply-controls" role="group" aria-label="Apply LLM response">
                    {activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? <span className="prompt-analysis-note">The review opens as Markdown.</span> : ([['replace', 'Replace'], ['insert', 'Insert'], ['new', 'New draft']] as const).filter(([mode]) => !(activeDocument.sourceType === 'json' && mode === 'insert')).map(([mode, label]) => <button key={mode} type="button" className={promptApplyMode === mode ? 'selected' : ''} onClick={() => setPromptApplyMode(mode)}>{label}</button>)}
                    <button type="button" className="accent-button" onClick={applyPromptReply}>{activeDocument.sourceType === 'json' && promptSpec.jsonIntent === 'analyze' ? 'Open review' : 'Apply source'}</button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {pendingAiReview && (
        <div className="modal-backdrop prompt-backdrop" onMouseDown={() => setPendingAiReview(null)}>
          <section className="workbench-modal ai-review-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Review proposed AI source change">
            <div className="modal-title"><div><p className="eyebrow">Explicit local review</p><h2>Review proposed source change</h2></div><button className="icon-button" onClick={() => setPendingAiReview(null)} aria-label="Cancel AI source review">×</button></div>
            <p className="modal-copy">Nothing is applied automatically. This review compares the selected change for <code>{pendingAiReview.documentName}</code> before it reaches your editor.</p>
            <div className="ai-review-summary"><span className={`source-label ${SOURCE_META[pendingAiReview.sourceType].color}`}>{SOURCE_META[pendingAiReview.sourceType].label}</span><strong>{pendingAiReview.mode === 'new' ? 'New draft' : pendingAiReview.mode === 'insert' ? 'Insert at the captured cursor position' : 'Replace the reviewed source range'}</strong><small>− current source · + proposed source</small></div>
            <pre className="ai-review-diff" aria-label="Proposed source diff">{sourceReviewDiff(pendingAiReview.before, pendingAiReview.source).map((line, index) => <span key={`${line.kind}-${index}`} className={line.kind}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}{line.text || ' '}</span>)}</pre>
            <footer className="ai-review-footer"><span>Review stays local. No source is changed until you apply it.</span><div><button className="outline-button" onClick={() => setPendingAiReview(null)}>Cancel</button>{pendingAiReview.mode !== 'new' && <button className="outline-button" onClick={() => setPendingAiReview((review) => review ? { ...review, mode: 'new' } : null)}>Use a new draft instead</button>}<button className="accent-button" onClick={applyReviewedAiSource}>Apply reviewed source</button></div></footer>
          </section>
        </div>
      )}

      {outputViewerOpen && createPortal(
        <div
          className={`output-viewer-backdrop${outputViewerFullscreen ? ' is-fullscreen' : ''}`}
          data-theme={effectiveAppearance}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeOutputViewer();
          }}
        >
          <section className={`output-viewer-modal${outputViewerFullscreen ? ' is-fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label="Live output viewer" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <button
              className="output-viewer-close-button"
              type="button"
              aria-label="Close output viewer"
              title="Close output viewer"
              onPointerDown={(event) => {
                // Close on press rather than waiting for click. Embedded PDF
                // and SVG surfaces can occasionally consume the matching
                // mouse-up event on macOS, which otherwise leaves a visible
                // close control that appears unresponsive.
                event.preventDefault();
                event.stopPropagation();
                closeOutputViewer();
              }}
              onClick={(event) => {
                // Keyboard activation produces click without pointerdown.
                event.stopPropagation();
                closeOutputViewer();
              }}
            >
              ×
            </button>
            <PreviewViewport
              key={`output-viewer-${activeDocument.id}`}
              className="output-viewer-viewport"
              preview={preview}
              sourceType={activeDocument.sourceType}
              previewDocument={preview.kind === 'svg' && preview.content ? previewDocument(preview.content, effectiveAppearance) : undefined}
              htmlDocument={preview.kind === 'html' && preview.content
                ? activeDocument.sourceType === 'markdown'
                  ? markdownPreviewDocument(preview.content, effectiveAppearance)
                  : preview.content
                : undefined}
              title="Live output"
              eyebrow={`${SOURCE_META[activeDocument.sourceType].label} · separate viewer`}
              background={previewBackground}
              onBackgroundChange={setPreviewBackground}
              presentationMode={outputViewerFullscreen}
              onPresentationModeChange={setOutputViewerFullscreen}
              presentationStyle="inline"
              presentationLabel="Full screen"
              onRender={renderActivePreview}
              onCopyOutput={preview.kind === 'pdf' ? undefined : copyPreviewOutput}
              onCopyImage={preview.kind === 'svg' ? copyPreviewPng : undefined}
              onExport={() => { closeOutputViewer(); setExportOpen(true); }}
              onPrompt={() => { closeOutputViewer(); setPromptOpen(true); }}
              onJumpToError={(message) => {
                const line = lineFromRenderMessage(message);
                if (line) { closeOutputViewer(); revealEditorLine(line); }
                else showToast('The renderer did not report a source line for this issue.', 'info');
              }}
            />
          </section>
        </div>,
        document.body,
      )}
    </main>
  );
}

function FileTree({ nodes, activePath, collapsed, selectedFolderPath, onToggle, onSelectFolder, onOpen, depth = 0 }: {
  nodes: FileNode[];
  activePath?: string;
  collapsed: Set<string>;
  selectedFolderPath: string;
  onToggle: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onOpen: (node: FileNode) => void;
  depth?: number;
}) {
  return <>{nodes.map((node) => {
    const hidden = node.kind === 'directory' && collapsed.has(node.relativePath);
    if (node.kind === 'directory') return <div className="tree-folder" key={node.relativePath}>
      <button className={`tree-row folder-row ${node.relativePath === selectedFolderPath ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => { onSelectFolder(node.relativePath); onToggle(node.relativePath); }} aria-current={node.relativePath === selectedFolderPath ? 'location' : undefined} aria-expanded={!hidden}>
        <span className="folder-arrow">{hidden ? '›' : '⌄'}</span><span className="folder-icon">▱</span><span>{node.name}</span>
      </button>
      {!hidden && <FileTree nodes={node.children ?? []} activePath={activePath} collapsed={collapsed} selectedFolderPath={selectedFolderPath} onToggle={onToggle} onSelectFolder={onSelectFolder} onOpen={onOpen} depth={depth + 1} />}
    </div>;
    const type = node.sourceType ?? sourceTypeForName(node.name);
    return <button key={node.relativePath} className={`tree-row file-row ${node.relativePath === activePath ? 'active' : ''} ${node.supported ? '' : 'unsupported'}`} style={{ paddingLeft: 29 + depth * 14 }} onClick={() => onOpen(node)} title={node.supported ? node.relativePath : 'This item appears to contain binary data'}>
      <span className={`tree-file-icon ${SOURCE_META[type].color}`}>{node.supported ? SOURCE_META[type].short : '·'}</span><span>{node.name}</span>
    </button>;
  })}</>;
}

function ReferenceCard({ entry, onInsert, onCopy }: { entry: ReferenceEntry; onInsert: (text: string) => void; onCopy: (text: string) => void }) {
  return <article className="reference-card">
    <div className="reference-card-head"><span>{entry.category}</span><div><button onClick={() => onInsert(entry.insertText)}>Insert</button><button onClick={() => onCopy(entry.insertText)} title="Copy snippet">⧉</button></div></div>
    <h3>{entry.title}</h3>
    <code>{entry.syntax}</code>
    <p>{entry.description}</p>
    <pre>{entry.example}</pre>
  </article>;
}

function PreviewLoading({ type }: { type: SourceType }) {
  return <div className="preview-placeholder loading"><div className={`loading-mark ${SOURCE_META[type].color}`}><span></span><span></span><span></span></div><strong>Rendering {SOURCE_META[type].label}</strong><p>Watching your source changes and rebuilding locally.</p></div>;
}

function PreviewEmpty({ type }: { type: SourceType }) {
  return <div className="preview-placeholder"><div className={`empty-preview-mark ${SOURCE_META[type].color}`}>{SOURCE_META[type].short}</div><strong>Ready when you are</strong><p>Edit the source, then press <kbd>⌘↵</kbd> to generate output.</p></div>;
}

export default App;
