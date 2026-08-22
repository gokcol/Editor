import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import type * as MonacoEditor from 'monaco-editor';
import mermaid from 'mermaid';
import { samples } from './engine/samples';
import { formatSource } from './engine/formatters';
import { markdownPreviewDocument, renderMarkdownSource, type PreviewAppearance } from './engine/markdown';
import { registerFoundryLanguages } from './engine/monacoLanguages';
import { references } from './engine/references';
import { readSnapshots, rememberSnapshot, type LocalSnapshot } from './engine/localHistory';
import { compactPath, documentOutline, findInSource, sourceFromAssistantReply } from './engine/workbench';
import PreviewViewport, { type PreviewBackground } from './components/PreviewViewport';
import type { AppSettings, DocumentModel, ExportFormat, FileNode, PreviewState, Project, ReferenceEntry, SourceType, TexPdfEngine } from './types';

// Ship Monaco's worker/editor assets with the desktop app instead of loading a CDN.
loader.config({ paths: { vs: './vs' } });

const SOURCE_META: Record<SourceType, { label: string; short: string; color: string; language: string; extension: string }> = {
  tikz: { label: 'TikZ', short: 'TZ', color: 'amber', language: 'foundry-tikz', extension: 'tikz' },
  latex: { label: 'LaTeX', short: 'TEX', color: 'indigo', language: 'foundry-latex', extension: 'tex' },
  svg: { label: 'SVG', short: 'SV', color: 'violet', language: 'foundry-svg', extension: 'svg' },
  mermaid: { label: 'Mermaid', short: 'MM', color: 'cyan', language: 'foundry-mermaid', extension: 'mmd' },
  markdown: { label: 'Markdown', short: 'MD', color: 'rose', language: 'foundry-markdown', extension: 'md' },
  text: { label: 'Plain Text', short: 'TXT', color: 'slate', language: 'foundry-text', extension: 'txt' },
};
const SOURCE_DESCRIPTIONS: Record<SourceType, string> = {
  tikz: 'LaTeX-quality diagrams',
  latex: 'Standalone TeX documents',
  svg: 'Editable vector markup',
  mermaid: 'Text-first flow diagrams',
  markdown: 'Notes with rich preview',
  text: 'Portable notes and raw text',
};

const EMPTY_PREVIEW: PreviewState = { status: 'idle', revision: -1 };
const DEFAULT_SETTINGS: AppSettings = {
  appearance: 'system',
  uiScale: 110,
  editorFontFamily: 'SF Mono',
  editorFontSize: 14,
  referenceFontSize: 10,
  autoSave: true,
  formatOnSave: false,
  previewAutoRender: true,
  editorWordWrap: true,
  editorMinimap: true,
  editorTabSize: 2,
  explorerOpen: true,
  previewOpen: true,
  referenceOpen: true,
  explorerWidth: 245,
  inspectorWidth: 390,
  previewSplit: 54,
};
const EDITOR_FONTS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono'];
const SOURCE_FILENAME_PATTERN = /\.(?:tikz|tex|latex|ltx|svg|mmd|mermaid|md|markdown|txt)$/i;
type PanelLayout = Pick<AppSettings, 'explorerOpen' | 'previewOpen' | 'referenceOpen' | 'explorerWidth' | 'inspectorWidth' | 'previewSplit'>;
type PanelLayoutKey = keyof PanelLayout;
type PanelResizeTarget = 'explorer' | 'inspector' | 'preview';
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
    dirty: false,
    revision: 0,
  };
}

function makeStarterDocument(type: SourceType): DocumentModel {
  const sample = samples[type];
  return {
    id: `${type}-${crypto.randomUUID()}`,
    name: sample.name,
    sourceType: type,
    value: sample.source,
    dirty: false,
    revision: 0,
  };
}

function sourceTypeForName(name: string): SourceType {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tikz')) return 'tikz';
  if (lower.endsWith('.tex') || lower.endsWith('.latex') || lower.endsWith('.ltx')) return 'latex';
  if (lower.endsWith('.svg')) return 'svg';
  if (lower.endsWith('.mmd') || lower.endsWith('.mermaid')) return 'mermaid';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return 'tikz';
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

function sanitizeSvg(svg: string) {
  return svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function previewDocument(svg: string, appearance: PreviewAppearance) {
  const page = appearance === 'light' ? '#f8fbff' : '#111722';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: ${appearance}; }
    html, body { min-height: 100%; margin: 0; background: ${page}; }
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

/** A safe, readable document view for raw .txt content; it never interprets source as markup. */
function textPreviewDocument(source: string, appearance: PreviewAppearance) {
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
  </style></head><body><main><header><strong>Plain text</strong><span>${lineNumber} ${lineNumber === 1 ? 'line' : 'lines'}</span></header><pre>${escapeHtml(source)}</pre></main></body></html>`;
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

type ProjectSearchHit = { node: FileNode; line: number; column: number; excerpt: string };
type GitFileStatus = { path: string; index?: string; workingTree?: string; status?: string };
type GitInfo = { branch?: string; files?: GitFileStatus[]; commits?: { hash: string; subject: string; author?: string; date?: string }[]; available?: boolean; message?: string };

const RECENT_PROJECTS_KEY = 'diagram-foundry:recent-projects';
const PALETTE_HISTORY_KEY = 'diagram-foundry:palette-history';
const SHORTCUTS_KEY = 'diagram-foundry:shortcuts';
const SHORTCUT_ACTIONS = [
  ['palette', 'Command palette'],
  ['prompt', 'Prompt Studio'],
  ['search', 'Find in project'],
  ['outline', 'Document outline'],
  ['zen', 'Zen mode'],
  ['build', 'Run active TeX build'],
] as const;
type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number][0];
type ShortcutBindings = Record<ShortcutActionId, string>;
const DEFAULT_SHORTCUTS: ShortcutBindings = {
  palette: 'Meta+Shift+P',
  prompt: 'Meta+Shift+L',
  search: 'Meta+Shift+F',
  outline: 'Meta+Shift+O',
  zen: 'Meta+Shift+Z',
  build: 'Meta+Shift+B',
};

function historyScope(project: Project | null, document: DocumentModel) {
  return project && document.relativePath ? `${project.root}:${document.relativePath}` : `scratch:${document.id}`;
}

function displayTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(timestamp);
}

function sourceFilenameForDrop(name: string, type: SourceType) {
  const safe = name.trim() || `untitled.${SOURCE_META[type].extension}`;
  return SOURCE_FILENAME_PATTERN.test(safe) ? safe : `${safe}.${SOURCE_META[type].extension}`;
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

function App() {
  const initialDocument = useMemo(() => makeBlankDocument(), []);
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<DocumentModel[]>([initialDocument]);
  const [activeId, setActiveId] = useState(initialDocument.id);
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  const [latexPreviewMode, setLatexPreviewMode] = useState<LatexRenderMode>('pdf');
  const [texPdfEngine, setTexPdfEngine] = useState<TexPdfEngine>('pdflatex');
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(DEFAULT_PANEL_LAYOUT);
  const [promptOpen, setPromptOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newSourceOpen, setNewSourceOpen] = useState(false);
  const [newSourceName, setNewSourceName] = useState('untitled.txt');
  const [newSourceType, setNewSourceType] = useState<SourceType>('text');
  const [isCreatingSource, setIsCreatingSource] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [referenceQuery, setReferenceQuery] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [systemAppearance, setSystemAppearance] = useState<PreviewAppearance>(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  // The selected folder is both a visible navigation location and the default
  // destination for the next project file created from the explorer.
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [promptSpec, setPromptSpec] = useState({
    goal: '',
    audience: '',
    style: 'Clean technical diagram, restrained modern palette, clear hierarchy',
    constraints: '',
    outputOnly: true,
    includeActiveFile: false,
    includeProjectContext: true,
    includeRenderError: true,
  });
  const [isExporting, setIsExporting] = useState(false);
  const [exportScale, setExportScale] = useState<1 | 2 | 4>(2);
  const [promptReply, setPromptReply] = useState('');
  const [promptApplyMode, setPromptApplyMode] = useState<'replace' | 'insert' | 'new'>('replace');
  const [selectionSource, setSelectionSource] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<LocalSnapshot[]>([]);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectSearchHits, setProjectSearchHits] = useState<ProjectSearchHit[]>([]);
  const [isProjectSearching, setIsProjectSearching] = useState(false);
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [isGitLoading, setIsGitLoading] = useState(false);
  const [taskConsoleOpen, setTaskConsoleOpen] = useState(false);
  const [taskOutput, setTaskOutput] = useState('No local task has run in this session.');
  const [isTaskRunning, setIsTaskRunning] = useState(false);
  const [recentProjects, setRecentProjects] = useState<Array<Pick<Project, 'root' | 'name'>>>([]);
  const [recentProjectsOpen, setRecentProjectsOpen] = useState(false);
  const [paletteHistory, setPaletteHistory] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(PALETTE_HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(() => {
    try { return { ...DEFAULT_SHORTCUTS, ...JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY) || '{}') }; } catch { return DEFAULT_SHORTCUTS; }
  });
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutActionId | null>(null);
  const [zenMode, setZenMode] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>('grid');

  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const appBodyRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const renderTokenRef = useRef(0);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const panelLayoutRef = useRef(panelLayout);
  const documentsRef = useRef(documents);
  const localWritePathsRef = useRef(new Map<string, number>());
  const pendingRevealLineRef = useRef<number | null>(null);
  const activeDocument = documents.find((document) => document.id === activeId) ?? documents[0];
  const effectiveAppearance: PreviewAppearance = settings.appearance === 'system' ? systemAppearance : settings.appearance;
  const interfaceScale = settings.uiScale / 100;
  const explorerVisible = !zenMode && panelLayout.explorerOpen;
  const inspectorOpen = !zenMode && (panelLayout.previewOpen || panelLayout.referenceOpen);

  const showToast = useCallback((text: string, tone: ToastTone = 'info') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ text, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

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
    event.preventDefault();
    const appRect = appBodyRef.current?.getBoundingClientRect();
    const inspectorRect = inspectorRef.current?.getBoundingClientRect();
    if (!appRect || (target === 'preview' && !inspectorRect)) return;
    const initial = { ...panelLayoutRef.current };
    document.body.classList.add('panel-resizing');

    const onPointerMove = (moveEvent: PointerEvent) => {
      const next = { ...initial };
      if (target === 'explorer') {
        const maxWidth = Math.max(180, Math.min(480, (appRect.width / interfaceScale) - 43 - (initial.previewOpen || initial.referenceOpen ? initial.inspectorWidth : 0) - 360));
        next.explorerWidth = clamp(((moveEvent.clientX - appRect.left) / interfaceScale) - 43, 180, maxWidth);
      } else if (target === 'inspector') {
        const maxWidth = Math.max(280, Math.min(760, (appRect.width / interfaceScale) - 43 - (initial.explorerOpen ? initial.explorerWidth : 0) - 360));
        next.inspectorWidth = clamp((appRect.right - moveEvent.clientX) / interfaceScale, 280, maxWidth);
      } else if (inspectorRect) {
        next.previewSplit = clamp(((moveEvent.clientY - inspectorRect.top) / inspectorRect.height) * 100, 30, 75);
      }
      panelLayoutRef.current = next;
      setPanelLayout(next);
    };

    const stop = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('panel-resizing');
      commitPanelLayout(panelLayoutRef.current);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop, { once: true });
  }, [commitPanelLayout, interfaceScale]);

  useEffect(() => {
    let mounted = true;
    window.diagramApi.settings.load()
      .then((loaded) => { if (mounted) setSettings({ ...DEFAULT_SETTINGS, ...loaded }); })
      .catch(() => { if (mounted) showToast('Could not load settings; using defaults.', 'error'); })
      .finally(() => { if (mounted) setSettingsReady(true); });
    return () => { mounted = false; };
  }, [showToast]);

  useEffect(() => {
    if (!settingsReady) return;
    void window.diagramApi.settings.save(settings).catch(() => showToast('Could not save settings.', 'error'));
  }, [settings, settingsReady, showToast]);

  useEffect(() => {
    panelLayoutRef.current = panelLayout;
  }, [panelLayout]);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

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
    try {
      const loaded = JSON.parse(window.localStorage.getItem(RECENT_PROJECTS_KEY) || '[]');
      if (Array.isArray(loaded)) {
        setRecentProjects(loaded.filter((item): item is Pick<Project, 'root' | 'name'> => (
          item && typeof item.root === 'string' && typeof item.name === 'string'
        )).slice(0, 7));
      }
    } catch {
      setRecentProjects([]);
    }
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(PALETTE_HISTORY_KEY, JSON.stringify(paletteHistory.slice(0, 8))); } catch { /* ignored */ }
  }, [paletteHistory]);

  useEffect(() => {
    try { window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcutBindings)); } catch { /* ignored */ }
  }, [shortcutBindings]);

  useEffect(() => {
    if (!activeDocument) return;
    setSnapshots(readSnapshots(historyScope(project, activeDocument)));
  }, [activeDocument?.id, activeDocument?.relativePath, project?.root]);

  useEffect(() => {
    if (!activeDocument?.dirty) return undefined;
    const documentId = activeDocument.id;
    const timer = window.setTimeout(() => {
      setSnapshots(rememberSnapshot(historyScope(project, activeDocument), activeDocument.value));
    }, 1150);
    return () => {
      window.clearTimeout(timer);
      if (documentId !== activeDocument.id) return;
    };
  }, [activeDocument?.id, activeDocument?.value, activeDocument?.dirty, project]);

  const updateDocument = useCallback((id: string, value: string) => {
    setDocuments((current) => current.map((document) => {
      if (document.id !== id || document.value === value) return document;
      return { ...document, value, dirty: true, revision: document.revision + 1 };
    }));
  }, []);

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
    const token = ++renderTokenRef.current;
    setPreview({ status: 'rendering', revision: document.revision, message: 'Building preview…' });
    try {
      if (document.sourceType === 'tikz') {
        const result = await window.diagramApi.render.tikz(document.value, document.name, engine);
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
        const result = await window.diagramApi.render.latex(
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
  }, [effectiveAppearance, texPdfEngine]);

  useEffect(() => {
    if (!activeDocument || !settings.previewAutoRender) return undefined;
    const delay = activeDocument.sourceType === 'tikz' || activeDocument.sourceType === 'latex' ? 850 : 380;
    const mode: LatexRenderMode = activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf';
    const timer = window.setTimeout(() => renderDocument(activeDocument, mode), delay);
    return () => window.clearTimeout(timer);
  }, [activeDocument, latexPreviewMode, renderDocument, settings.previewAutoRender]);

  const addScratchpadDocument = useCallback((seed: DocumentModel) => {
    const baseName = filenameWithoutExtension(seed.name);
    let name = seed.name;
    let index = 2;
    while (documents.some((document) => document.name === name)) {
      name = `${baseName} ${index}.${SOURCE_META[seed.sourceType].extension}`;
      index += 1;
    }
    const next = { ...seed, name, dirty: true };
    setDocuments((current) => [...current, next]);
    setActiveId(next.id);
    setPreview(EMPTY_PREVIEW);
    editorRef.current?.focus();
  }, [documents]);

  const createUnsavedStarterDocument = useCallback((type: SourceType) => {
    addScratchpadDocument(makeStarterDocument(type));
  }, [addScratchpadDocument]);

  const createBlankScratchpad = useCallback((type: SourceType = 'text') => {
    addScratchpadDocument(makeBlankDocument(type));
  }, [addScratchpadDocument]);

  const syncProjectTree = useCallback((nextProject: Project, resetLocation = false) => {
    const directories = folderPaths(nextProject.tree);
    setProject(nextProject);
    setCollapsedPaths((current) => resetLocation
      ? new Set()
      : new Set([...current].filter((relativePath) => directories.has(relativePath))));
    setSelectedFolderPath((current) => resetLocation || !directories.has(current) ? '' : current);
  }, []);

  const rememberRecentProject = useCallback((openedProject: Project) => {
    setRecentProjects((current) => {
      const next = [{ root: openedProject.root, name: openedProject.name }, ...current.filter((item) => item.root !== openedProject.root)].slice(0, 7);
      try { window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)); } catch { /* ignored */ }
      return next;
    });
  }, []);

  const hydrateProject = useCallback(async (openedProject: Project) => {
    const sourceFiles = flattenFiles(openedProject.tree).filter((item) => item.supported);
    // Folder names are often reused across projects (for example, `notes`).
    // Always start an opened folder at its real root instead of carrying old
    // collapsed/selected paths into the new workspace.
    syncProjectTree(openedProject, true);
    rememberRecentProject(openedProject);
    if (!sourceFiles.length) {
      const blank = makeBlankDocument();
      setDocuments([blank]);
      setActiveId(blank.id);
      showToast('Project opened. Add a source file when you are ready.');
      return;
    }
    const first = sourceFiles[0];
    const source = await window.diagramApi.project.readFile(openedProject.root, first.relativePath);
    const document: DocumentModel = {
      id: `file-${crypto.randomUUID()}`,
      name: first.name,
      sourceType: first.sourceType ?? sourceTypeForName(first.name),
      value: source,
      relativePath: first.relativePath,
      dirty: false,
      revision: 0,
    };
    setDocuments([document]);
    setActiveId(document.id);
    setPreview(EMPTY_PREVIEW);
    showToast(`Opened ${openedProject.name}.`, 'success');
  }, [rememberRecentProject, showToast, syncProjectTree]);

  const openProject = useCallback(async () => {
    if (documents.some((document) => document.dirty) && !window.confirm('Opening a project will close the current scratchpad tabs. Continue without saving those edits?')) return;
    try {
      const opened = await window.diagramApi.project.open();
      if ('canceled' in opened) return;
      await hydrateProject(opened);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open the project.', 'error');
    }
  }, [documents, hydrateProject, showToast]);

  const newProject = useCallback(async () => {
    if (documents.some((document) => document.dirty) && !window.confirm('Creating a new project will close the current scratchpad tabs. Continue without saving those edits?')) return;
    const name = window.prompt('Name your new diagram project:', 'Diagram Project');
    if (!name?.trim()) return;
    try {
      const created = await window.diagramApi.project.create(name.trim());
      if ('canceled' in created) return;
      await hydrateProject(created);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create the project.', 'error');
    }
  }, [documents, hydrateProject, showToast]);

  const refreshProject = useCallback(async () => {
    if (!project) return;
    try {
      const refreshed = await window.diagramApi.project.refresh(project.root);
      syncProjectTree(refreshed);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not refresh files.', 'error');
    }
  }, [project, showToast, syncProjectTree]);

  const openRecentProject = useCallback(async (recent: Pick<Project, 'root' | 'name'>) => {
    if (documents.some((document) => document.dirty) && !window.confirm('Opening a recent project will close the current scratchpad tabs. Continue without saving those edits?')) return;
    try {
      const opened = await window.diagramApi.project.openRecent(recent.root);
      await hydrateProject(opened);
    } catch (error) {
      setRecentProjects((current) => current.filter((item) => item.root !== recent.root));
      showToast(error instanceof Error ? error.message : `Could not reopen ${recent.name}.`, 'error');
    }
  }, [documents, hydrateProject, showToast]);

  const openLatestRecentProject = useCallback(() => {
    const latest = recentProjects[0];
    if (latest) void openRecentProject(latest);
  }, [openRecentProject, recentProjects]);

  const renameActiveProjectFile = useCallback(async () => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Open a project file before renaming it.', 'info');
      return;
    }
    const destination = window.prompt('Rename file (relative to this project):', activeDocument.relativePath)?.trim().replace(/^\/+/, '');
    if (!destination || destination === activeDocument.relativePath) return;
    try {
      localWritePathsRef.current.set(activeDocument.relativePath, Date.now());
      localWritePathsRef.current.set(destination, Date.now());
      const result = await window.diagramApi.project.renameFile(project.root, activeDocument.relativePath, destination);
      setDocuments((current) => current.map((document) => document.id === activeDocument.id ? {
        ...document,
        relativePath: result.relativePath,
        name: result.relativePath.split('/').at(-1) || document.name,
        sourceType: sourceTypeForName(result.relativePath),
      } : document));
      setSelectedFolderPath(parentFolderPath(result.relativePath));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(result.relativePath)) next.delete(ancestor);
        return next;
      });
      syncProjectTree(await window.diagramApi.project.refresh(project.root));
      showToast('File renamed.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not rename this file.', 'error');
    }
  }, [activeDocument, project, showToast, syncProjectTree]);

  const duplicateActiveProjectFile = useCallback(async () => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Open a project file before duplicating it.', 'info');
      return;
    }
    const currentExtension = activeDocument.name.match(/\.[^/.]+$/)?.[0] ?? '';
    const extension = activeDocument.sourceType === 'latex' && /\.(?:tex|latex|ltx)$/i.test(currentExtension)
      ? currentExtension
      : `.${SOURCE_META[activeDocument.sourceType].extension}`;
    const base = activeDocument.relativePath.replace(new RegExp(`${extension.replace('.', '\\.')}$`, 'i'), '');
    const destination = window.prompt('Duplicate file as (relative to this project):', `${base} copy${extension}`)?.trim().replace(/^\/+/, '');
    if (!destination) return;
    try {
      localWritePathsRef.current.set(destination, Date.now());
      const result = await window.diagramApi.project.duplicateFile(project.root, activeDocument.relativePath, destination);
      const source = await window.diagramApi.project.readFile(project.root, result.relativePath);
      const copy: DocumentModel = {
        id: `file-${crypto.randomUUID()}`,
        name: result.relativePath.split('/').at(-1) || activeDocument.name,
        sourceType: sourceTypeForName(result.relativePath),
        value: source,
        relativePath: result.relativePath,
        dirty: false,
        revision: 0,
      };
      setDocuments((current) => [...current, copy]);
      setActiveId(copy.id);
      setSelectedFolderPath(parentFolderPath(result.relativePath));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(result.relativePath)) next.delete(ancestor);
        return next;
      });
      syncProjectTree(await window.diagramApi.project.refresh(project.root));
      showToast('Duplicate opened in a new tab.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not duplicate this file.', 'error');
    }
  }, [activeDocument, project, showToast, syncProjectTree]);

  const deleteActiveProjectFile = useCallback(async () => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Open a project file before deleting it.', 'info');
      return;
    }
    if (!window.confirm(`Move “${activeDocument.relativePath}” out of this project permanently? This cannot be undone by Diagram Foundry.`)) return;
    try {
      localWritePathsRef.current.set(activeDocument.relativePath, Date.now());
      await window.diagramApi.project.deleteFile(project.root, activeDocument.relativePath);
      const index = documents.findIndex((document) => document.id === activeDocument.id);
      const next = documents.filter((document) => document.id !== activeDocument.id);
      if (!next.length) {
        const fresh = makeBlankDocument();
        setDocuments([fresh]);
        setActiveId(fresh.id);
      } else {
        setDocuments(next);
        setActiveId(next[Math.max(0, index - 1)].id);
      }
      syncProjectTree(await window.diagramApi.project.refresh(project.root));
      showToast('File deleted from the project.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not delete this file.', 'error');
    }
  }, [activeDocument, documents, project, showToast, syncProjectTree]);

  useEffect(() => {
    if (!project) return undefined;
    let watchId: string | undefined;
    const unsubscribe = window.diagramApi.project.onChanged((update) => {
      if (update.root !== project.root || !update.changes?.length) return;
      const now = Date.now();
      const externalChanges = update.changes.filter((change) => {
        const localWriteAt = localWritePathsRef.current.get(change.relativePath);
        return !localWriteAt || now - localWriteAt > 1800;
      });
      if (!externalChanges.length) return;
      void window.diagramApi.project.refresh(project.root).then(syncProjectTree).catch(() => undefined);
      const changedPaths = new Set(externalChanges.map((change) => change.relativePath));
      const reloadable = documentsRef.current.filter((document) => document.relativePath && changedPaths.has(document.relativePath) && !document.dirty);
      if (reloadable.length) {
        void Promise.all(reloadable.map(async (document) => ({ id: document.id, value: await window.diagramApi.project.readFile(project.root, document.relativePath!) })))
          .then((reloaded) => {
            const values = new Map(reloaded.map((entry) => [entry.id, entry.value]));
            setDocuments((current) => current.map((document) => values.has(document.id) ? { ...document, value: values.get(document.id)!, revision: document.revision + 1, dirty: false } : document));
          })
          .catch(() => undefined);
      }
      showToast(`Project changed outside Diagram Foundry (${externalChanges.length} update${externalChanges.length === 1 ? '' : 's'}).`);
    });
    void window.diagramApi.project.watch(project.root).then((watch) => { watchId = watch.watchId; }).catch(() => undefined);
    return () => {
      unsubscribe();
      if (watchId) void window.diagramApi.project.unwatch(watchId);
    };
  }, [project?.root, showToast, syncProjectTree]);

  const openFile = useCallback(async (node: FileNode, revealLine?: number) => {
    if (!project || node.kind !== 'file' || !node.supported) return;
    setSelectedFolderPath(parentFolderPath(node.relativePath));
    setCollapsedPaths((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorFolderPaths(node.relativePath)) next.delete(ancestor);
      return next;
    });
    const existing = documents.find((document) => document.relativePath === node.relativePath);
    if (existing) {
      if (revealLine) pendingRevealLineRef.current = revealLine;
      setActiveId(existing.id);
      return;
    }
    try {
      const source = await window.diagramApi.project.readFile(project.root, node.relativePath);
      const document: DocumentModel = {
        id: `file-${crypto.randomUUID()}`,
        name: node.name,
        sourceType: node.sourceType ?? sourceTypeForName(node.name),
        value: source,
        relativePath: node.relativePath,
        dirty: false,
        revision: 0,
      };
      if (revealLine) pendingRevealLineRef.current = revealLine;
      setDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setPreview(EMPTY_PREVIEW);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not read that file.', 'error');
    }
  }, [documents, project, showToast]);

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
        const content = await window.diagramApi.project.readFile(project.root, node.relativePath);
        return findInSource(content, query, 24).map((match) => ({ node, ...match }));
      }));
      setProjectSearchHits(groups.flat().slice(0, 180));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not search the project.', 'error');
    } finally {
      setIsProjectSearching(false);
    }
  }, [project, projectSearchQuery, showToast]);

  const openNewSource = useCallback((type: SourceType = 'text') => {
    const fallbackFolder = type === 'markdown' || type === 'text'
      ? 'notes'
      : type === 'latex'
        ? 'documents'
        : 'diagrams';
    const folder = project ? `${selectedFolderPath || fallbackFolder}/` : '';
    setNewSourceType(type);
    setNewSourceName(`${folder}untitled.${SOURCE_META[type].extension}`);
    setNewSourceOpen(true);
  }, [project, selectedFolderPath]);

  const changeNewSourceType = useCallback((type: SourceType) => {
    setNewSourceType(type);
    setNewSourceName((current) => {
      const base = current.replace(SOURCE_FILENAME_PATTERN, '') || 'untitled';
      return `${base}.${SOURCE_META[type].extension}`;
    });
  }, []);

  const createFile = useCallback(async () => {
    const rawName = newSourceName.trim().replace(/^\/+/, '');
    if (!rawName) {
      showToast('Give the source file a name first.', 'error');
      return;
    }
    const nameWithoutKnownExtension = rawName.replace(SOURCE_FILENAME_PATTERN, '') || 'untitled';
    const name = `${nameWithoutKnownExtension}.${SOURCE_META[newSourceType].extension}`;
    const type = newSourceType;
    setIsCreatingSource(true);
    try {
      if (!project) {
        const requestedTabName = name.includes('/') ? name.split('/').at(-1)! : name;
        const tabBaseName = filenameWithoutExtension(requestedTabName);
        let tabName = requestedTabName;
        let index = 2;
        while (documents.some((document) => document.name === tabName)) {
          tabName = `${tabBaseName} ${index}.${SOURCE_META[type].extension}`;
          index += 1;
        }
        const document: DocumentModel = {
          ...makeBlankDocument(type),
          name: tabName,
          dirty: true,
        };
        setDocuments((current) => [...current, document]);
        setActiveId(document.id);
        setPreview(EMPTY_PREVIEW);
        setNewSourceOpen(false);
        showToast(`${document.name} opened in a new tab.`, 'success');
        return;
      }
      const source = '';
      localWritePathsRef.current.set(name, Date.now());
      await window.diagramApi.project.createFile(project.root, name, source);
      const document: DocumentModel = {
        id: `file-${crypto.randomUUID()}`,
        name: name.split('/').at(-1) ?? name,
        sourceType: type,
        value: source,
        relativePath: name,
        dirty: false,
        revision: 0,
      };
      setDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setSelectedFolderPath(parentFolderPath(name));
      setCollapsedPaths((current) => {
        const next = new Set(current);
        for (const ancestor of ancestorFolderPaths(name)) next.delete(ancestor);
        return next;
      });
      setPreview(EMPTY_PREVIEW);
      try {
        syncProjectTree(await window.diagramApi.project.refresh(project.root));
      } catch {
        // The source is already open; the user can refresh the tree later if needed.
      }
      setNewSourceOpen(false);
      showToast(`Created ${name}.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create the file.', 'error');
    } finally {
      setIsCreatingSource(false);
    }
  }, [documents, newSourceName, newSourceType, project, showToast, syncProjectTree]);

  const saveDocument = useCallback(async (saveAs = false) => {
    if (!activeDocument) return;
    try {
      const content = settings.formatOnSave ? formatSource(activeDocument.sourceType, activeDocument.value) : activeDocument.value;
      if (content !== activeDocument.value) {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (editor && model) {
          editor.executeEdits('format-on-save', [{ range: model.getFullModelRange(), text: content, forceMoveMarkers: true }]);
        } else {
          setDocuments((current) => current.map((document) => document.id === activeDocument.id ? { ...document, value: content, revision: document.revision + 1 } : document));
        }
      }
      if (project && activeDocument.relativePath && !saveAs) {
        localWritePathsRef.current.set(activeDocument.relativePath, Date.now());
        await window.diagramApi.project.writeFile(project.root, activeDocument.relativePath, content);
        setDocuments((current) => current.map((document) => document.id === activeDocument.id ? { ...document, value: content, dirty: false } : document));
        refreshProject();
        showToast(`${activeDocument.name} saved.`, 'success');
        return;
      }
      const result = await window.diagramApi.project.saveAs(activeDocument.name, content, activeDocument.sourceType);
      if (result.canceled) return;
      const name = result.path?.split('/').at(-1) ?? activeDocument.name;
      setDocuments((current) => current.map((document) => document.id === activeDocument.id ? { ...document, name, value: content, dirty: false } : document));
      showToast(`${name} saved.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the file.', 'error');
    }
  }, [activeDocument, project, refreshProject, settings.formatOnSave, showToast]);

  useEffect(() => {
    if (!settings.autoSave || !project || !activeDocument?.relativePath || !activeDocument.dirty) return undefined;
    const documentId = activeDocument.id;
    const relativePath = activeDocument.relativePath;
    const source = activeDocument.value;
    const timer = window.setTimeout(() => {
      setAutoSaving(true);
      localWritePathsRef.current.set(relativePath, Date.now());
      void window.diagramApi.project.writeFile(project.root, relativePath, source)
        .then(() => {
          setDocuments((current) => current.map((document) => document.id === documentId && document.value === source ? { ...document, dirty: false } : document));
        })
        .catch((error) => showToast(error instanceof Error ? error.message : 'Auto-save could not write this file.', 'error'))
        .finally(() => setAutoSaving(false));
    }, 1050);
    return () => window.clearTimeout(timer);
  }, [activeDocument?.dirty, activeDocument?.id, activeDocument?.relativePath, activeDocument?.value, project?.root, settings.autoSave, showToast]);

  const closeDocument = useCallback((document: DocumentModel, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (document.dirty && !window.confirm(`Discard unsaved changes to “${document.name}”?`)) return;
    const index = documents.findIndex((candidate) => candidate.id === document.id);
    const next = documents.filter((candidate) => candidate.id !== document.id);
    if (!next.length) {
      // A window with no editor tabs is a valid workspace state. Do not create
      // a replacement scratchpad tab here: closing the final tab should mean
      // exactly that, while the empty workspace keeps New Source and Open
      // Folder immediately available.
      renderTokenRef.current += 1;
      editorRef.current = null;
      pendingRevealLineRef.current = null;
      setDocuments([]);
      setActiveId('');
      setPreview(EMPTY_PREVIEW);
      setSelectionSource('');
      setSnapshots([]);
      return;
    }
    setDocuments(next);
    if (activeId === document.id) setActiveId(next[Math.max(0, index - 1)].id);
  }, [activeId, documents]);

  const formatActive = useCallback(() => {
    if (!activeDocument) return;
    const formatted = formatSource(activeDocument.sourceType, activeDocument.value);
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
    showToast('Formatted with the local source formatter.', 'success');
  }, [activeDocument, showToast, updateDocument]);

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
      const result = await window.diagramApi.render.export({
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
        await window.diagramApi.clipboard.writeSvg(content);
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
      await window.diagramApi.clipboard.writeDataUriImage(canvas.toDataURL('image/png'));
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
    const activeFileContext = promptSpec.includeActiveFile
      ? `Full active file (${activeDocument.name}):\n\n${activeDocument.value.slice(0, 14000)}${activeDocument.value.length > 14000 ? '\n\n[truncated after 14,000 characters]' : ''}`
      : '';
    const projectContext = promptSpec.includeProjectContext && project
      ? `Project context (${project.name}):\n${flattenFiles(project.tree).filter((item) => item.supported).map((item) => `- ${item.relativePath}`).slice(0, 80).join('\n')}`
      : '';
    const renderContext = promptSpec.includeRenderError && preview.status === 'error' && preview.message
      ? `Current renderer error to resolve:\n\n${preview.message.slice(-5000)}`
      : '';
    return [
      `You are an expert ${meta.label} ${activeDocument.sourceType === 'text' ? 'editor' : activeDocument.sourceType === 'latex' ? 'document author' : 'diagram engineer'}.`,
      `Create ${meta.label} source for this request: ${promptSpec.goal || '[describe the diagram here]'}.`,
      promptSpec.audience ? `Audience / purpose: ${promptSpec.audience}.` : '',
      promptSpec.style ? `Visual direction: ${promptSpec.style}.` : '',
      promptSpec.constraints ? `Technical constraints: ${promptSpec.constraints}.` : '',
      activeDocument.sourceType === 'tikz'
        ? `Return a complete, compilable LaTeX document using TikZ. The selected PDF compiler is ${texPdfEngineLabel(texPdfEngine)} (${texPdfEngine}); use engine-appropriate packages, only local/common TikZ libraries, no shell escape, and keep labels readable.`
        : activeDocument.sourceType === 'latex'
          ? `Return a complete, compilable standalone LaTeX document. The selected PDF compiler is ${texPdfEngineLabel(texPdfEngine)} (${texPdfEngine}); use engine-appropriate packages, do not use shell escape, and keep the document structure clear.`
        : activeDocument.sourceType === 'svg'
          ? 'Return a complete, valid, self-contained SVG with a responsive viewBox. Do not reference remote assets or scripts.'
          : activeDocument.sourceType === 'mermaid'
            ? 'Return valid Mermaid source only. Use strict-compatible syntax and set no HTML labels.'
            : activeDocument.sourceType === 'markdown'
              ? 'Return well-structured GitHub-flavored Markdown. Use meaningful headings, concise prose, and ordinary fenced code blocks; use a mermaid fence only when a diagram adds value.'
              : 'Return clean, readable plain text only. Preserve the requested wording and structure without Markdown syntax unless it is explicitly requested.',
      selection ? `Modify or take inspiration from this selected source fragment:\n\n${selection}` : '',
      activeFileContext,
      projectContext,
      renderContext,
      promptSpec.outputOnly
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
    const source = sourceFromAssistantReply(promptReply, activeDocument.sourceType);
    if (promptApplyMode === 'new') {
      const base = filenameWithoutExtension(activeDocument.name);
      const document: DocumentModel = {
        id: `${activeDocument.sourceType}-${crypto.randomUUID()}`,
        name: `${base} AI draft.${SOURCE_META[activeDocument.sourceType].extension}`,
        sourceType: activeDocument.sourceType,
        value: source,
        dirty: true,
        revision: 0,
      };
      setDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setPromptReply('');
      setPromptOpen(false);
      showToast('LLM response opened as a new draft.', 'success');
      return;
    }

    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      const range = promptApplyMode === 'replace'
        ? (editor.getSelection() ?? model.getFullModelRange())
        : (() => {
          const position = editor.getPosition();
          return position ? { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column } : model.getFullModelRange();
        })();
      editor.executeEdits('apply-llm-reply', [{ range, text: source, forceMoveMarkers: true }]);
      editor.focus();
    } else if (promptApplyMode === 'replace') {
      updateDocument(activeDocument.id, source);
    } else {
      updateDocument(activeDocument.id, `${activeDocument.value}\n${source}`);
    }
    setPromptReply('');
    setPromptOpen(false);
    showToast(promptApplyMode === 'replace' ? 'LLM source applied.' : 'LLM source inserted.', 'success');
  }, [activeDocument, promptApplyMode, promptReply, showToast, updateDocument]);

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

  const openGitPanel = useCallback(async () => {
    if (!project) {
      showToast('Open a project to inspect its Git status.', 'info');
      return;
    }
    setGitOpen(true);
    setIsGitLoading(true);
    try {
      const [status, log] = await Promise.all([
        window.diagramApi.git.status(project.root),
        window.diagramApi.git.log(project.root, undefined, { limit: 8 }),
      ]);
      setGitInfo({
        available: status.available,
        branch: status.branch,
        files: (status.changes ?? []).map((change) => ({ path: change.path, status: change.status, index: change.indexStatus, workingTree: change.workTreeStatus })),
        commits: (log.entries ?? []).map((entry) => ({ hash: entry.shortHash, subject: entry.subject, author: entry.author, date: entry.date })),
        message: status.error || log.error,
      });
    } catch (error) {
      setGitInfo({ available: false, message: error instanceof Error ? error.message : 'Could not inspect Git for this project.' });
    } finally {
      setIsGitLoading(false);
    }
  }, [project, showToast]);

  const showActiveDiff = useCallback(async () => {
    if (!project) {
      showToast('Open a project to inspect a diff.', 'info');
      return;
    }
    setIsTaskRunning(true);
    setTaskConsoleOpen(true);
    try {
      const result = await window.diagramApi.git.diff(project.root, activeDocument?.relativePath);
      setTaskOutput(result.error || result.diff || 'No uncommitted changes for the active source.');
    } catch (error) {
      setTaskOutput(error instanceof Error ? error.message : 'Could not read the Git diff.');
    } finally {
      setIsTaskRunning(false);
    }
  }, [activeDocument?.relativePath, project, showToast]);

  const runActiveBuild = useCallback(async (
    latexMode: LatexRenderMode = 'pdf',
    engine: TexPdfEngine = texPdfEngine,
  ) => {
    if (!project || !activeDocument?.relativePath) {
      showToast('Save the active TikZ or LaTeX source into a project before running a build profile.', 'info');
      return;
    }
    const isTikz = activeDocument.sourceType === 'tikz';
    const isLatex = activeDocument.sourceType === 'latex';
    if (!isTikz && !isLatex) {
      showToast('Local build profiles are available for TikZ and LaTeX source.', 'info');
      return;
    }
    const output = isLatex ? latexMode.toUpperCase() : 'PDF';
    const compilerLabel = texPdfEngineLabel(engine);
    const buildLabel = isLatex
      ? latexMode === 'dvi'
        ? 'Compile LaTeX to DVI with classic LaTeX'
        : `Compile LaTeX to PDF with ${compilerLabel}`
      : `Compile TikZ to PDF with ${compilerLabel}`;
    const profileId = isLatex
      ? latexMode === 'dvi'
        ? 'latex-dvi'
        : engine === 'pdflatex' ? 'latex-pdf' : `latex-${engine}-pdf`
      : engine === 'pdflatex' ? 'tikz-pdf' : `tikz-${engine}-pdf`;
    setTaskConsoleOpen(true);
    setIsTaskRunning(true);
    setTaskOutput(`Running ${buildLabel} for ${activeDocument.relativePath}…`);
    try {
      if (activeDocument.dirty) {
        localWritePathsRef.current.set(activeDocument.relativePath, Date.now());
        await window.diagramApi.project.writeFile(project.root, activeDocument.relativePath, activeDocument.value);
      }
      const result = await window.diagramApi.project.runBuild(project.root, activeDocument.relativePath, profileId);
      if (!result.ok) {
        setTaskOutput(result.error || 'The build did not finish.');
        showToast('Build failed — see the Task Console.', 'error');
        return;
      }
      setTaskOutput(`✓ ${buildLabel} succeeded\n\n${result.outputRelativePath || result.outputPath || `${output} created in the project build folder.`}`);
      showToast(`${isLatex ? 'LaTeX' : 'TikZ'} ${output} build completed${isLatex && latexMode === 'dvi' ? ' with classic LaTeX.' : ` with ${compilerLabel}.`}`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not run the local build profile.';
      setTaskOutput(message);
      showToast(message, 'error');
    } finally {
      setIsTaskRunning(false);
    }
  }, [activeDocument, project, showToast, texPdfEngine]);

  const actions = useMemo(() => [
    { id: 'new-project', label: 'New project', hint: '⌘⇧N', group: 'File', run: newProject },
    { id: 'open-project', label: 'Open project…', hint: '⌘O', group: 'File', run: openProject },
    { id: 'new-file', label: 'New source file…', hint: '⌘N', group: 'File', run: () => openNewSource() },
    ...(['tikz', 'latex', 'svg', 'mermaid', 'markdown', 'text'] as SourceType[]).map((type) => ({
      id: `new-${type}`,
      label: `New ${SOURCE_META[type].label} source…`,
      hint: '',
      group: 'File',
      run: () => openNewSource(type),
    })),
    { id: 'save', label: 'Save active file', hint: '⌘S', group: 'File', run: () => saveDocument(false) },
    { id: 'save-as', label: 'Save active file as…', hint: '⌘⇧S', group: 'File', run: () => saveDocument(true) },
    { id: 'render', label: 'Render active preview', hint: '⌘↵', group: 'Diagram', run: () => activeDocument && renderDocument(activeDocument, activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf') },
    ...(activeDocument?.sourceType === 'latex' ? [
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
    { id: 'export', label: 'Export diagram…', hint: '⌘E', group: 'Diagram', run: () => setExportOpen(true) },
    { id: 'build', label: activeDocument?.sourceType === 'latex' ? `Run LaTeX ${texPdfEngineLabel(texPdfEngine)} PDF build profile` : activeDocument?.sourceType === 'tikz' ? `Run TikZ ${texPdfEngineLabel(texPdfEngine)} PDF build profile` : 'Run active TeX build profile', hint: '⌘⇧B', group: 'Diagram', run: () => void runActiveBuild() },
    ...(activeDocument?.sourceType === 'latex' ? [
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
    { id: 'template-gallery', label: 'Open template gallery', hint: '', group: 'File', run: () => setTemplateGalleryOpen(true) },
    { id: 'format', label: 'Format active source', hint: '⌥⇧F', group: 'Editor', run: formatActive },
    { id: 'undo', label: 'Undo', hint: '⌘Z', group: 'Editor', run: () => editorRef.current?.trigger('command-palette', 'undo', null) },
    { id: 'redo', label: 'Redo', hint: '⇧⌘Z', group: 'Editor', run: () => editorRef.current?.trigger('command-palette', 'redo', null) },
    { id: 'outline', label: 'Show document outline', hint: '⌘⇧O', group: 'Editor', run: () => setOutlineOpen(true) },
    { id: 'history', label: 'Show local version history', hint: '', group: 'Editor', run: () => setHistoryOpen(true) },
    { id: 'search-project', label: 'Find in project…', hint: '⌘⇧F', group: 'Project', run: () => setProjectSearchOpen(true) },
    { id: 'git', label: 'Open Git status', hint: '', group: 'Project', run: openGitPanel },
    { id: 'diff', label: 'Show active Git diff', hint: '', group: 'Project', run: showActiveDiff },
    { id: 'zen', label: zenMode ? 'Exit Zen mode' : 'Enter Zen mode', hint: '⌘⇧Z', group: 'View', run: () => setZenMode((current) => !current) },
    { id: 'auto-render', label: settings.previewAutoRender ? 'Disable automatic preview' : 'Enable automatic preview', hint: '', group: 'View', run: () => setSettings((current) => ({ ...current, previewAutoRender: !current.previewAutoRender })) },
    { id: 'explorer', label: 'Toggle Explorer', hint: '', group: 'View', run: () => togglePanel('explorerOpen') },
    { id: 'preview', label: 'Toggle live preview', hint: '', group: 'View', run: () => togglePanel('previewOpen') },
    { id: 'references', label: 'Toggle reference deck', hint: '⌘⇧R', group: 'View', run: () => togglePanel('referenceOpen') },
    { id: 'reset-layout', label: 'Reset panel layout', hint: '', group: 'View', run: resetPanelLayout },
    { id: 'prompt-studio', label: 'Open Prompt Studio', hint: '⌘⇧L', group: 'View', run: () => setPromptOpen(true) },
    { id: 'settings', label: 'Open settings', hint: '⌘,', group: 'View', run: () => setSettingsOpen(true) },
    ...(['tikz', 'latex', 'svg', 'mermaid', 'markdown', 'text'] as SourceType[]).map((type, index) => ({
      id: `select-${type}`,
      label: `New ${SOURCE_META[type].label} source`,
      hint: `⌘${index + 1}`,
      group: 'Source type',
      // These are creation shortcuts, not mode selectors.  A shortcut must
      // never unexpectedly bring a starter or an existing document forward.
      run: () => createBlankScratchpad(type),
    })),
  ], [activeDocument, createBlankScratchpad, documents, formatActive, latexPreviewMode, newProject, openGitPanel, openNewSource, openProject, renderDocument, resetPanelLayout, runActiveBuild, saveDocument, settings.previewAutoRender, showActiveDiff, texPdfEngine, togglePanel, zenMode]);

  const actionRef = useRef(actions);
  actionRef.current = actions;

  const runPaletteAction = useCallback((action: { id: string; run: () => void }) => {
    setPaletteHistory((current) => [action.id, ...current.filter((id) => id !== action.id)].slice(0, 8));
    action.run();
  }, []);

  useEffect(() => {
    const unsubscribe = window.diagramApi.onMenuAction((action) => {
      if (action === 'palette') { setPaletteOpen(true); return; }
      const selected = actionRef.current.find((entry) => entry.id === action);
      selected?.run();
    });
    window.diagramApi.rendererReady();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
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
        void runActiveBuild();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [recordingShortcut, runActiveBuild, shortcutBindings, showToast]);

  const configureMonaco = useCallback((monaco: Monaco) => {
    registerFoundryLanguages(monaco);
  }, []);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    const updateSelection = () => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      setSelectionSource(model && selection ? model.getValueInRange(selection) : '');
    };
    updateSelection();
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

  const exportFormats: ExportFormat[] = activeDocument?.sourceType === 'markdown' || activeDocument?.sourceType === 'text'
    ? ['png', 'pdf', 'html']
    : activeDocument?.sourceType === 'latex'
      ? ['png', 'svg', 'pdf', 'dvi']
      : ['png', 'svg', 'pdf'];
  // A transformed, compensating shell lets the full workbench scale without
  // clipping at the window edge. It is intentionally separate from the source
  // font-size preference, which remains useful for dense code.
  const appShellStyle: React.CSSProperties = {
    '--ui-scale': String(interfaceScale),
    width: `${100 / interfaceScale}%`,
    height: `${100 / interfaceScale}%`,
  } as React.CSSProperties;
  const appBodyStyle: React.CSSProperties = {
    gridTemplateColumns: `${zenMode ? '0px' : '43px'} ${explorerVisible ? `${panelLayout.explorerWidth}px` : '0px'} minmax(380px, 1fr) ${inspectorOpen ? `${panelLayout.inspectorWidth}px` : '0px'}`,
  };
  const inspectorStyle: React.CSSProperties = {
    gridTemplateRows: panelLayout.previewOpen && panelLayout.referenceOpen
      ? `minmax(220px, ${panelLayout.previewSplit}fr) minmax(180px, ${100 - panelLayout.previewSplit}fr)`
      : 'minmax(0, 1fr)',
  };

  const handleSourceDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = Array.from(event.dataTransfer.files).find((candidate) => SOURCE_FILENAME_PATTERN.test(candidate.name));
    if (!file) {
      showToast('Drop a TikZ, LaTeX, SVG, Mermaid, Markdown, or plain-text source file to open it as a tab.', 'info');
      return;
    }
    try {
      const type = sourceTypeForName(file.name);
      const value = await file.text();
      const requestedName = sourceFilenameForDrop(file.name, type);
      const base = filenameWithoutExtension(requestedName);
      let name = requestedName;
      let index = 2;
      while (documents.some((document) => document.name === name)) {
        name = `${base} ${index}.${SOURCE_META[type].extension}`;
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
      setDocuments((current) => [...current, document]);
      setActiveId(document.id);
      setPreview(EMPTY_PREVIEW);
      showToast(`${name} opened as a scratchpad tab. Save it into a project when ready.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not read that dropped file.', 'error');
    }
  }, [documents, showToast]);

  const newSourceDialog = newSourceOpen && (
    <div className="modal-backdrop new-source-backdrop" onMouseDown={() => !isCreatingSource && setNewSourceOpen(false)}>
      <section className="new-source-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="New source file">
        <div className="modal-title"><div><p className="eyebrow">{project ? 'Project file' : 'Scratchpad tab'}</p><h2>New source file</h2></div><button className="icon-button" onClick={() => setNewSourceOpen(false)} disabled={isCreatingSource}>×</button></div>
        <p className="modal-copy">{project ? <>{selectedFolderPath ? <>New files default to <code>{selectedFolderPath}/</code>. </> : ''}Choose a relative path. The new source is empty and stays as an ordinary file in this project.</> : 'Create an empty named scratchpad tab now; save it anywhere later.'}</p>
        <form className="new-source-form" onSubmit={(event) => { event.preventDefault(); void createFile(); }}>
          <fieldset className="new-source-type-picker">
            <legend>Choose a source format</legend>
            <div role="radiogroup" aria-label="Source format">
              {(Object.keys(SOURCE_META) as SourceType[]).map((type) => <button key={type} type="button" className={`source-type-option ${newSourceType === type ? 'selected' : ''}`} role="radio" aria-checked={newSourceType === type} onClick={() => changeNewSourceType(type)}>
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
                  : 'diagrams/architecture.mmd'
              : `untitled.${SOURCE_META[newSourceType].extension}`} />
          </label>
          <p className="new-source-hint">The selected format controls the extension. Pick <code>TikZ</code>, <code>LaTeX</code>, <code>SVG</code>, <code>Mermaid</code>, <code>Markdown</code>, or <code>Plain Text</code>, then name the source.</p>
          <footer className="new-source-footer"><button type="button" className="outline-button" onClick={() => setNewSourceOpen(false)} disabled={isCreatingSource}>Cancel</button><button type="submit" className="accent-button" disabled={isCreatingSource}>{isCreatingSource ? 'Creating…' : project ? 'Create file' : 'Open tab'}</button></footer>
        </form>
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
              <strong>Diagram Foundry</strong>
              <span>source-first diagram studio</span>
            </div>
          </div>
          <div className="project-crumb">
            <span className="status-orb"></span>
            <span>{project ? project.name : 'Scratchpad'}</span>
            <small>{project ? project.root : 'No source tabs open'}</small>
          </div>
          <div className="top-actions">
            <button className="ghost-button" onClick={() => void openProject()} title="Open folder (⌘O)">Open folder</button>
            <button className="accent-button empty-new-source-button" onClick={() => openNewSource()}>＋ New source</button>
          </div>
        </header>

        <section
          className={`empty-workspace-stage${project ? ' has-project' : ''}`}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }}
          onDrop={handleSourceDrop}
        >
          {dragActive && <div className="source-drop-overlay" role="status"><span>↓</span><strong>Open source as a new tab</strong><small>TikZ · LaTeX · SVG · Mermaid · Markdown · Text</small></div>}
          <section className="empty-workspace-card" aria-label="No editor tabs open">
            <div className="empty-workspace-mark" aria-hidden="true"><span></span><span></span><span></span></div>
            <p className="eyebrow">Workspace ready</p>
            <h1>No source tabs open</h1>
            <p>Start with an empty source file, open a folder, or drop an existing source here. Closing the last tab leaves this workspace ready for the next task.</p>
            <div className="empty-workspace-actions">
              <button className="accent-button" onClick={() => openNewSource()}>＋ New source</button>
              <button className="outline-button" onClick={() => void openProject()}>Open folder</button>
              <button className="outline-button" onClick={() => void newProject()}>New project</button>
            </div>
            <small>TikZ · LaTeX · SVG · Mermaid · Markdown · Plain Text</small>
          </section>

          {project && <aside className="empty-workspace-project" aria-label={`${project.name} file navigator`}>
            <div className="empty-workspace-project-head">
              <div><p className="eyebrow">Opened folder</p><strong>{project.name}</strong></div>
              <button className="icon-button" onClick={() => void window.diagramApi.shell.reveal(project.root).catch(() => showToast('Could not reveal this project folder.', 'error'))} title="Reveal project folder in Finder" aria-label="Reveal project folder in Finder">↗</button>
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
          <span className="status-spacer"></span>
          <button onClick={() => void openProject()}>Open folder</button>
          <button onClick={() => openNewSource()}>New source</button>
        </footer>
        {toast && <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}</span>{toast.text}</div>}
        {newSourceDialog}
      </main>
    );
  }

  return (
    <main className={`app-shell${zenMode ? ' zen-mode' : ''}${dragActive ? ' drag-active' : ''}`} data-theme={effectiveAppearance} style={appShellStyle}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
          <div>
            <strong>Diagram Foundry</strong>
            <span>source-first diagram studio</span>
          </div>
        </div>
        <div className="project-crumb">
          <span className="status-orb"></span>
          <span>{project ? project.name : 'Scratchpad'}</span>
          <small>{project ? project.root : 'Create or open a folder to start a project'}</small>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={() => setPaletteOpen(true)} title="Command Palette (⌘⇧P)"><kbd>⌘⇧P</kbd> Command Palette</button>
          <button className="ghost-button settings-shortcut" onClick={() => setSettingsOpen(true)} title="Settings (⌘,)">⚙ Settings</button>
          <button className="prompt-button" onClick={() => setPromptOpen(true)}><span>✦</span> Prompt Studio</button>
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
        <nav className="activity-rail" aria-label="Workbench sections">
          <button className={`activity ${panelLayout.explorerOpen ? 'active' : ''}`} onClick={() => togglePanel('explorerOpen')} title={panelLayout.explorerOpen ? 'Hide Explorer' : 'Show Explorer'}><span>▦</span></button>
          <button className={`activity ${panelLayout.previewOpen ? 'active' : ''}`} onClick={() => togglePanel('previewOpen')} title={panelLayout.previewOpen ? 'Hide Live Preview' : 'Show Live Preview'}><span>◉</span></button>
          <button className={`activity ${panelLayout.referenceOpen ? 'active' : ''}`} onClick={() => togglePanel('referenceOpen')} title={panelLayout.referenceOpen ? 'Hide Reference Deck' : 'Show Reference Deck'}><span>⌘</span></button>
          <button className="activity" onClick={() => setPromptOpen(true)} title="Prompt Studio"><span>✦</span></button>
          <div className="activity-spacer" />
          <button className="activity" onClick={() => setSettingsOpen(true)} title="Settings"><span>⚙</span></button>
          <button className="activity" onClick={refreshProject} title="Refresh project"><span>↻</span></button>
        </nav>

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
            <button className="accent-button" onClick={newProject}>New project</button>
            <button className="outline-button" onClick={openProject}>Open folder</button>
          </div>
          <div className="explorer-utilities">
            <button onClick={() => setProjectSearchOpen(true)} title="Find in project">⌕ Find</button>
            <button onClick={openGitPanel} title="Git status and history">⌘ Git</button>
            <button onClick={() => setTaskConsoleOpen(true)} title="Local build output">›_ Tasks</button>
            <button onClick={() => setTemplateGalleryOpen(true)} title="Starter templates">▦ Templates</button>
            <button onClick={() => setRecentProjectsOpen(true)} disabled={!recentProjects.length} title="Recently opened projects">↺ Recents</button>
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
                <button onClick={() => void window.diagramApi.shell.reveal(project.root).catch(() => showToast('Could not reveal this project folder.', 'error'))} title="Reveal project folder in Finder" aria-label="Reveal project folder in Finder">↗</button>
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
              <span>Your files remain portable: <code>.tikz</code>, <code>.tex</code>, <code>.latex</code>, <code>.ltx</code>, <code>.svg</code>, <code>.mmd</code>, <code>.md</code>, and <code>.txt</code>.</span>
            </div>
          )}
          <div className="explorer-footer">
            <button onClick={() => openNewSource()}>＋ New source</button>
            <button onClick={() => setPromptOpen(true)}>✦ Draft with LLM</button>
            {recentProjects.length > 0 && <button onClick={openLatestRecentProject}>↺ Reopen latest</button>}
            <button onClick={() => void runActiveBuild()} title={activeDocument.sourceType === 'latex' ? `Compile PDF with ${texPdfEngineLabel(texPdfEngine)}` : activeDocument.sourceType === 'tikz' ? `Compile PDF with ${texPdfEngineLabel(texPdfEngine)}` : 'Run the active TeX build'}>▶ {activeDocument.sourceType === 'latex' ? `Build ${texPdfEngineLabel(texPdfEngine)}` : activeDocument.sourceType === 'tikz' ? `Build ${texPdfEngineLabel(texPdfEngine)}` : 'Run build'}</button>
          </div>
          <div className="panel-resizer explorer-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Explorer" onPointerDown={(event) => startPanelResize('explorer', event)} />
        </aside>
        }

        <section className="editor-shell">
          <div className="tab-strip">
            <div className="tabs">
              {documents.map((document) => (
                <button
                  key={document.id}
                  className={`editor-tab ${document.id === activeDocument.id ? 'selected' : ''}`}
                  onClick={() => setActiveId(document.id)}
                >
                  <span className={`file-badge ${SOURCE_META[document.sourceType].color}`}>{SOURCE_META[document.sourceType].short}</span>
                  <span className="tab-name">{document.name}</span>
                  {document.dirty && <span className="dirty-dot" title="Unsaved changes"></span>}
                  <span className="tab-close" onClick={(event) => closeDocument(document, event)} title="Close tab">×</span>
                </button>
              ))}
              <button className="new-tab" onClick={() => openNewSource()} title="New source tab — choose a format">＋</button>
            </div>
            <div className="tab-tools">
              <button className="compact-button" onClick={formatActive} title="Format source (⌥⇧F)">Format</button>
              {activeDocument.sourceType === 'latex' && <div className="latex-preview-mode" role="group" aria-label="LaTeX preview format">
                <button className={latexPreviewMode === 'pdf' ? 'selected' : ''} type="button" aria-pressed={latexPreviewMode === 'pdf'} onClick={() => { setLatexPreviewMode('pdf'); void renderDocument(activeDocument, 'pdf'); }} title="Compile and preview PDF">PDF</button>
                <button className={latexPreviewMode === 'dvi' ? 'selected' : ''} type="button" aria-pressed={latexPreviewMode === 'dvi'} onClick={() => { setLatexPreviewMode('dvi'); void renderDocument(activeDocument, 'dvi'); }} title="Compile with classic latex and preview the DVI as SVG when dvisvgm is available">DVI</button>
              </div>}
              {(activeDocument.sourceType === 'tikz' || (activeDocument.sourceType === 'latex' && latexPreviewMode === 'pdf')) && <label className="tex-engine-select" title="PDF compiler. Choose XeLaTeX or LuaLaTeX for Unicode and fontspec workflows.">
                <span>Engine</span>
                <select value={texPdfEngine} aria-label="TeX PDF engine" onChange={(event) => {
                  const engine = event.target.value as TexPdfEngine;
                  setTexPdfEngine(engine);
                  void renderDocument(activeDocument, 'pdf', engine);
                }}>
                  {TEX_PDF_ENGINES.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
                </select>
              </label>}
              {activeDocument.sourceType === 'latex' && latexPreviewMode === 'dvi' && <span className="tex-classic-engine" title="DVI always uses classic latex; XeLaTeX and LuaLaTeX produce PDF only.">classic latex</span>}
              <button className="compact-button render-button" onClick={() => void renderDocument(activeDocument, activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf')} title="Render preview (⌘↵)">▶ Render</button>
            </div>
          </div>

          <div className="editor-meta">
            <div className="type-chip"><span className={SOURCE_META[activeDocument.sourceType].color}></span>{SOURCE_META[activeDocument.sourceType].label} source</div>
            <div className="editor-meta-actions">
              <button onClick={() => setOutlineOpen(true)} title="Document outline (⌘⇧O)">☷ Outline</button>
              <button onClick={() => setHistoryOpen(true)} title="Local version history">◴ History</button>
              <button onClick={() => editorRef.current?.trigger('toolbar', 'undo', null)}>↶ Undo</button>
              <button onClick={() => editorRef.current?.trigger('toolbar', 'redo', null)}>↷ Redo</button>
              <button onClick={() => saveDocument(false)}>Save <kbd>⌘S</kbd></button>
            </div>
          </div>

          <div className="monaco-wrap">
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
                renderLineHighlight: 'all',
                stickyScroll: { enabled: false },
              }}
            />
          </div>
        </section>

        {inspectorOpen && <aside className="inspector-panel" ref={inspectorRef} style={inspectorStyle}>
          {panelLayout.previewOpen && <PreviewViewport
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
            onRender={() => void renderDocument(activeDocument, activeDocument.sourceType === 'latex' ? latexPreviewMode : 'pdf')}
            onCopyOutput={preview.kind === 'pdf' ? undefined : copyPreviewOutput}
            onCopyImage={preview.kind === 'svg' ? copyPreviewPng : undefined}
            onExport={() => setExportOpen(true)}
            onPrompt={() => setPromptOpen(true)}
            onJumpToError={(message) => {
              const line = lineFromRenderMessage(message);
              if (line) revealEditorLine(line);
              else showToast('The renderer did not report a source line for this issue.', 'info');
            }}
            onClose={() => togglePanel('previewOpen')}
          />}
          {panelLayout.previewOpen && panelLayout.referenceOpen && <div className="panel-resizer preview-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize preview and references" onPointerDown={(event) => startPanelResize('preview', event)} />}

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
        <span><i className={`language-dot ${SOURCE_META[activeDocument.sourceType].color}`}></i>{SOURCE_META[activeDocument.sourceType].label}</span>
        <span>{autoSaving ? 'Auto-saving…' : activeDocument.dirty ? 'Unsaved edits' : 'Saved'}</span>
        <span>{settings.previewAutoRender ? 'Live preview' : 'Manual preview'}</span>
        <span>Local render · {activeDocument.sourceType === 'tikz' ? `${texPdfEngineLabel(texPdfEngine)} + Poppler` : activeDocument.sourceType === 'latex' ? latexPreviewMode === 'dvi' ? 'classic latex + dvisvgm DVI view' : `${texPdfEngineLabel(texPdfEngine)} PDF view` : activeDocument.sourceType === 'svg' ? 'Browser SVG + librsvg' : activeDocument.sourceType === 'mermaid' ? 'Mermaid + librsvg' : activeDocument.sourceType === 'markdown' ? 'GFM preview + Chromium PDF/PNG/HTML' : 'Plain-text preview + Chromium PDF/PNG/HTML'}</span>
        <span className="status-spacer"></span>
        <button onClick={() => setProjectSearchOpen(true)}>Find</button>
        <button onClick={openGitPanel}>Git</button>
        <button onClick={() => setZenMode((current) => !current)}>{zenMode ? 'Exit Zen' : 'Zen'}</button>
        <button className={panelLayout.explorerOpen ? 'active' : ''} onClick={() => togglePanel('explorerOpen')} aria-pressed={panelLayout.explorerOpen}>Explorer</button>
        <button className={panelLayout.previewOpen ? 'active' : ''} onClick={() => togglePanel('previewOpen')} aria-pressed={panelLayout.previewOpen}>Preview</button>
        <button className={panelLayout.referenceOpen ? 'active' : ''} onClick={() => togglePanel('referenceOpen')} aria-pressed={panelLayout.referenceOpen}>References</button>
        <button onClick={() => setPaletteOpen(true)}>⌘⇧P</button>
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
            <p className="modal-copy">A fresh local render is produced before export, so the saved file always matches the active source. Vector exports stay crisp; PNG uses the scale below.</p>
            <div className="export-preset-row" role="group" aria-label="PNG export scale">
              <span>PNG scale</span>
              {([1, 2, 4] as const).map((scale) => <button key={scale} className={exportScale === scale ? 'selected' : ''} onClick={() => setExportScale(scale)} aria-pressed={exportScale === scale}>{scale}×</button>)}
              <small>SVG and PDF retain their vector detail. Transparent source areas remain transparent where the renderer supports it.</small>
            </div>
            <div className={`export-grid ${exportFormats.length === 2 ? 'two' : ''}`}>
              {exportFormats.map((format) => <button key={format} className={`export-option ${format}`} onClick={() => exportActive(format)} disabled={isExporting}>
                <span className="export-icon">{format === 'png' ? '▧' : format === 'svg' ? '◇' : format === 'html' ? '‹/›' : format === 'dvi' ? '⇲' : '▤'}</span>
                <strong>{format.toUpperCase()}</strong>
                <small>{format === 'png' ? `${exportScale}× raster image` : format === 'svg' ? 'Editable vector image' : format === 'html' ? 'Portable rendered document' : format === 'dvi' ? 'TeX device-independent output' : 'Portable document'}</small>
              </button>)}
            </div>
            {isExporting && <div className="export-progress"><span></span>Preparing export…</div>}
          </section>
        </div>
      )}

      {newSourceDialog}

      {settingsOpen && (
        <div className="modal-backdrop settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Settings">
            <div className="modal-title"><div><p className="eyebrow">Local preferences</p><h2>Settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)}>×</button></div>
            <p className="modal-copy">Preferences are stored locally on this Mac and apply immediately.</p>
            <div className="settings-section">
              <div className="settings-section-head"><span>Appearance</span><small>Choose how Diagram Foundry follows your workspace.</small></div>
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
              <div className="settings-switch-grid">
                <label><input type="checkbox" checked={settings.editorWordWrap} onChange={(event) => setSettings((current) => ({ ...current, editorWordWrap: event.target.checked }))} /><span><strong>Word wrap</strong><small>Keep long labels and prose visible.</small></span></label>
                <label><input type="checkbox" checked={settings.editorMinimap} onChange={(event) => setSettings((current) => ({ ...current, editorMinimap: event.target.checked }))} /><span><strong>Minimap</strong><small>Show a compact source overview.</small></span></label>
                <label><input type="checkbox" checked={settings.formatOnSave} onChange={(event) => setSettings((current) => ({ ...current, formatOnSave: event.target.checked }))} /><span><strong>Format on save</strong><small>Run the local beautifier before writing.</small></span></label>
              </div>
            </div>
            <div className="settings-section automation-settings">
              <div className="settings-section-head"><span>Workflow</span><small>Keep local source and preview in sync without losing control.</small></div>
              <div className="settings-switch-grid">
                <label><input type="checkbox" checked={settings.autoSave} onChange={(event) => setSettings((current) => ({ ...current, autoSave: event.target.checked }))} /><span><strong>Auto-save project files</strong><small>Write after a brief idle pause; scratchpad tabs stay unsaved.</small></span></label>
                <label><input type="checkbox" checked={settings.previewAutoRender} onChange={(event) => setSettings((current) => ({ ...current, previewAutoRender: event.target.checked }))} /><span><strong>Automatic preview</strong><small>Render after source changes; use Render for manual builds anytime.</small></span></label>
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
            <footer className="settings-footer"><span>Syntax coloring, snippets, hover help, folding, and local diagnostics are tailored for TikZ, LaTeX, SVG, Mermaid, Markdown, and Plain Text.</span><button className="accent-button" onClick={() => setSettingsOpen(false)}>Done</button></footer>
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
              {project && projectSearchQuery && !isProjectSearching && !projectSearchHits.length && <div className="empty-workbench-state">No source matches yet. Press Search to scan all supported files.</div>}
              {!project && <div className="empty-workbench-state">Open a project folder to search across its ordinary source files.</div>}
            </div>
          </section>
        </div>
      )}

      {templateGalleryOpen && (
        <div className="modal-backdrop" onMouseDown={() => setTemplateGalleryOpen(false)}>
          <section className="workbench-modal template-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Template gallery">
            <div className="modal-title"><div><p className="eyebrow">Source-first starters</p><h2>Template gallery</h2></div><button className="icon-button" onClick={() => setTemplateGalleryOpen(false)}>×</button></div>
            <p className="modal-copy">Open a complete local starter in a fresh tab, then adapt it as ordinary source.</p>
            <div className="template-grid">
              {(Object.keys(SOURCE_META) as SourceType[]).map((type) => <button key={type} className={`template-card ${SOURCE_META[type].color}`} onClick={() => { createUnsavedStarterDocument(type); setTemplateGalleryOpen(false); }}><span className="template-badge">{SOURCE_META[type].short}</span><strong>{SOURCE_META[type].label} starter</strong><small>{SOURCE_DESCRIPTIONS[type]}</small><code>{samples[type].name}</code><em>Open template →</em></button>)}
            </div>
          </section>
        </div>
      )}

      {recentProjectsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setRecentProjectsOpen(false)}>
          <section className="workbench-modal recent-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Recent projects">
            <div className="modal-title"><div><p className="eyebrow">Local workspace memory</p><h2>Recent projects</h2></div><button className="icon-button" onClick={() => setRecentProjectsOpen(false)}>×</button></div>
            <div className="workbench-list recent-list">
              {recentProjects.map((recent) => <button key={recent.root} onClick={() => { void openRecentProject(recent); setRecentProjectsOpen(false); }}><span><strong>{recent.name}</strong><code>{compactPath(recent.root, 70)}</code></span><small>Open</small></button>)}
              {!recentProjects.length && <div className="empty-workbench-state">Projects you open will appear here for quick reuse.</div>}
            </div>
          </section>
        </div>
      )}

      {gitOpen && (
        <div className="modal-backdrop" onMouseDown={() => setGitOpen(false)}>
          <section className="workbench-modal git-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Git status">
            <div className="modal-title"><div><p className="eyebrow">Read-only repository context</p><h2>Git status {gitInfo?.branch ? `· ${gitInfo.branch}` : ''}</h2></div><div><button className="compact-button" onClick={() => void openGitPanel()}>↻ Refresh</button><button className="icon-button" onClick={() => setGitOpen(false)}>×</button></div></div>
            {isGitLoading && <div className="empty-workbench-state">Inspecting this project locally…</div>}
            {!isGitLoading && !gitInfo?.available && <div className="empty-workbench-state">{gitInfo?.message || 'This folder is not a Git repository.'}</div>}
            {!isGitLoading && gitInfo?.available && <>
              <div className="git-toolbar"><span>{gitInfo.files?.length ? `${gitInfo.files.length} changed file${gitInfo.files.length === 1 ? '' : 's'}` : 'Working tree clean'}</span><button onClick={showActiveDiff}>View active diff</button></div>
              <div className="git-grid">
                <div><h3>Changes</h3><div className="workbench-list git-changes">{gitInfo.files?.map((file) => <span key={file.path}><b>{file.status || `${file.index || ' '} ${file.workingTree || ' '}`}</b><code>{file.path}</code></span>)}{!gitInfo.files?.length && <div className="empty-workbench-state">No uncommitted project files.</div>}</div></div>
                <div><h3>Recent commits</h3><div className="workbench-list git-commits">{gitInfo.commits?.map((commit) => <span key={commit.hash}><b>{commit.hash}</b><strong>{commit.subject}</strong><small>{commit.author} · {commit.date ? new Date(commit.date).toLocaleDateString() : ''}</small></span>)}{!gitInfo.commits?.length && <div className="empty-workbench-state">No commits are available yet.</div>}</div></div>
              </div>
            </>}
          </section>
        </div>
      )}

      {taskConsoleOpen && (
        <div className="modal-backdrop" onMouseDown={() => setTaskConsoleOpen(false)}>
          <section className="workbench-modal task-console-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Task Console">
            <div className="modal-title"><div><p className="eyebrow">Local build and inspection output</p><h2>Task Console</h2></div><button className="icon-button" onClick={() => setTaskConsoleOpen(false)}>×</button></div>
            <div className="task-console-actions"><button className="accent-button" onClick={() => void runActiveBuild()} disabled={isTaskRunning}>{isTaskRunning ? 'Running…' : activeDocument.sourceType === 'latex' ? `Compile LaTeX PDF with ${texPdfEngineLabel(texPdfEngine)}` : activeDocument.sourceType === 'tikz' ? `Compile TikZ PDF with ${texPdfEngineLabel(texPdfEngine)}` : 'Run active TeX build'}</button>{activeDocument.sourceType === 'latex' && <button className="outline-button" onClick={() => void runActiveBuild('dvi')} disabled={isTaskRunning} title="DVI always uses classic latex">Compile DVI · classic latex</button>}<button className="outline-button" onClick={showActiveDiff} disabled={isTaskRunning}>Show Git diff</button></div>
            <pre className="task-console-output">{taskOutput}</pre>
          </section>
        </div>
      )}

      {promptOpen && (
        <div className="modal-backdrop prompt-backdrop" onMouseDown={() => setPromptOpen(false)}>
          <section className="prompt-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><p className="eyebrow">LLM handoff, without an API lock-in</p><h2>Prompt Studio</h2></div><button className="icon-button" onClick={() => setPromptOpen(false)}>×</button></div>
            <p className="modal-copy">Describe the diagram, copy the prompt to any LLM, then paste its source response directly into this editor.</p>
            <div className="prompt-layout">
              <form className="prompt-form" onSubmit={(event) => event.preventDefault()}>
                <label>Target source<span className={`source-label ${SOURCE_META[activeDocument.sourceType].color}`}>{SOURCE_META[activeDocument.sourceType].label}</span></label>
                <label>What should it show?<textarea autoFocus value={promptSpec.goal} onChange={(event) => setPromptSpec((spec) => ({ ...spec, goal: event.target.value }))} placeholder="e.g. A resilient service topology with queues, retry paths, and observability" /></label>
                <label>Audience / purpose<input value={promptSpec.audience} onChange={(event) => setPromptSpec((spec) => ({ ...spec, audience: event.target.value }))} placeholder="e.g. Engineering design review" /></label>
                <label>Visual direction<textarea value={promptSpec.style} onChange={(event) => setPromptSpec((spec) => ({ ...spec, style: event.target.value }))} /></label>
                <label>Technical constraints<textarea value={promptSpec.constraints} onChange={(event) => setPromptSpec((spec) => ({ ...spec, constraints: event.target.value }))} placeholder="e.g. use only arrows.meta and positioning; landscape; 16:9" /></label>
                <label className="check-label"><input type="checkbox" checked={promptSpec.outputOnly} onChange={(event) => setPromptSpec((spec) => ({ ...spec, outputOnly: event.target.checked }))} /> {activeDocument.sourceType === 'markdown' || activeDocument.sourceType === 'text' ? 'Document only—no outer fence or explanation' : 'Source only—no Markdown fences or explanation'}</label>
                <fieldset className="prompt-context-options">
                  <legend>Include context</legend>
                  <label className="check-label"><input type="checkbox" checked={promptSpec.includeActiveFile} onChange={(event) => setPromptSpec((spec) => ({ ...spec, includeActiveFile: event.target.checked }))} /> Full active source</label>
                  <label className="check-label"><input type="checkbox" checked={promptSpec.includeProjectContext} onChange={(event) => setPromptSpec((spec) => ({ ...spec, includeProjectContext: event.target.checked }))} disabled={!project} /> Project file map</label>
                  <label className="check-label"><input type="checkbox" checked={promptSpec.includeRenderError} onChange={(event) => setPromptSpec((spec) => ({ ...spec, includeRenderError: event.target.checked }))} disabled={preview.status !== 'error'} /> Current render error</label>
                  <small>{selectionSource ? 'The current editor selection is included automatically.' : 'Select source in the editor to add focused context.'}</small>
                </fieldset>
              </form>
              <div className="prompt-preview">
                <div className="prompt-preview-head"><span>Generated prompt</span><button onClick={() => copyText(promptText, 'Prompt copied — send it to your preferred LLM.')}>Copy prompt</button></div>
                <textarea readOnly value={promptText} aria-label="Generated LLM prompt" />
                <div className="prompt-tips"><span>✦ Context stays on this Mac until you copy it.</span><span>✓ No API key or remote service is used here.</span></div>
                <div className="prompt-response">
                  <label>Paste the LLM response
                    <textarea value={promptReply} onChange={(event) => setPromptReply(event.target.value)} placeholder="Paste source from your preferred LLM. Matching outer code fences are removed automatically." />
                  </label>
                  <div className="prompt-apply-controls" role="group" aria-label="Apply LLM response">
                    {([['replace', 'Replace'], ['insert', 'Insert'], ['new', 'New draft']] as const).map(([mode, label]) => <button key={mode} type="button" className={promptApplyMode === mode ? 'selected' : ''} onClick={() => setPromptApplyMode(mode)}>{label}</button>)}
                    <button type="button" className="accent-button" onClick={applyPromptReply}>Apply source</button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
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
    return <button key={node.relativePath} className={`tree-row file-row ${node.relativePath === activePath ? 'active' : ''} ${node.supported ? '' : 'unsupported'}`} style={{ paddingLeft: 29 + depth * 14 }} onClick={() => onOpen(node)} title={node.supported ? node.relativePath : 'This file type is not a diagram source'}>
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
