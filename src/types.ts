/**
 * Every first-class text format understood by the workbench.  These remain
 * deliberately file-format oriented rather than tying the editor to a build
 * system or runtime: a JavaScript file is still an ordinary `.js` file, for
 * example, and can be opened in any other editor without conversion.
 */
export type SourceType =
  | 'tikz'
  | 'latex'
  | 'metafont'
  | 'svg'
  | 'mermaid'
  | 'markdown'
  | 'text'
  | 'yaml'
  | 'json'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'fortran'
  | 'sql'
  | 'html'
  | 'css';

/** Monaco language identifiers owned by Yedit. */
export type FoundryLanguageId = `foundry-${SourceType}`;

/**
 * A lightweight, source-local diagnostic. The engine deliberately keeps this
 * format independent of Monaco so it can also power a Problems view, tests,
 * or a future CLI validation command.
 */
export type EditorDiagnosticSeverity = 'error' | 'warning' | 'info';

export type EditorDiagnostic = {
  code: string;
  message: string;
  severity: EditorDiagnosticSeverity;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type Appearance = 'system' | 'dark' | 'light';
export type EditorBackgroundPattern = 'none' | 'grid' | 'dots' | 'lines';

export type AppSettings = {
  appearance: Appearance;
  /**
   * Scale the whole workbench, including controls, panels, dialogs, and the
   * editor. Kept separate from editorFontSize so source typography can still
   * be tuned independently.
   */
  uiScale: number;
  editorFontFamily: string;
  editorFontSize: number;
  /** `theme` follows the current light/dark editor palette; custom values are #RRGGBB. */
  editorBackgroundColor: string;
  editorBackgroundPattern: EditorBackgroundPattern;
  /** Formats available for new sources, templates, and creation commands. */
  enabledSourceTypes: SourceType[];
  referenceFontSize: number;
  autoSave: boolean;
  formatOnSave: boolean;
  previewAutoRender: boolean;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  editorTabSize: number;
  explorerOpen: boolean;
  previewOpen: boolean;
  referenceOpen: boolean;
  explorerWidth: number;
  inspectorWidth: number;
  previewSplit: number;
};

export type FileNode = {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  sourceType?: SourceType;
  supported?: boolean;
  size?: number;
  modifiedAt?: number;
  createdAt?: number;
  isSymbolicLink?: boolean;
  children?: FileNode[];
};

export type Project = {
  root: string;
  name: string;
  tree: FileNode[];
};

export type DocumentModel = {
  id: string;
  name: string;
  sourceType: SourceType;
  value: string;
  relativePath?: string;
  dirty: boolean;
  revision: number;
};

export type ReferenceEntry = {
  id: string;
  title: string;
  category: string;
  syntax: string;
  description: string;
  example: string;
  insertText: string;
  tags: string[];
};

export type PreviewState = {
  status: 'idle' | 'rendering' | 'ready' | 'error';
  revision: number;
  kind?: 'pdf' | 'svg' | 'html';
  content?: string;
  message?: string;
};

export type ExportFormat = 'png' | 'pdf' | 'dvi' | 'svg' | 'html' | 'ttf';
export type TexPdfEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export type ProjectWatchUpdate = {
  watchId: string;
  root: string;
  changes: Array<{ relativePath: string; eventType: 'rename' | 'change' | string }>;
};

export type BuildProfile = {
  id: string;
  label: string;
  sourceTypes: SourceType[];
  outputExtension: string;
  compiler?: string;
  engine?: TexPdfEngine | 'latex';
};

/** A deliberately small, local-only contract for running the active Python buffer. */
export type PythonRunOptions = {
  mode?: 'run' | 'test';
  /** When present, the local project folder is used as the process working directory. */
  projectRoot?: string;
  /** Lets the runner preserve the active file's suffix for tracebacks and test discovery. */
  relativePath?: string;
  /** A backend-enforced upper bound; the UI normally asks for 15 seconds. */
  timeoutMs?: number;
};

export type PythonRunResult = {
  ok: boolean;
  /** Captured standard output. */
  output: string;
  /** Captured standard error, kept separate so the output pane can label it clearly. */
  stderr?: string;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
  command?: string;
};

export type GitStatusResponse = {
  available: boolean;
  isRepository: boolean;
  root: string;
  branch?: string;
  clean?: boolean;
  error?: string;
  changes?: Array<{ status: string; indexStatus: string; workTreeStatus: string; path: string; originalPath?: string }>;
};

export type GitLogResponse = {
  available: boolean;
  isRepository: boolean;
  root: string;
  error?: string;
  entries?: Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }>;
};

declare global {
  interface Window {
    diagramApi: {
      project: {
        open: () => Promise<Project | { canceled: true }>;
        openRecent: (root: string) => Promise<Project>;
        create: (name: string) => Promise<Project | { canceled: true }>;
        refresh: (root: string) => Promise<Project>;
        readFile: (root: string, relativePath: string) => Promise<string>;
        writeFile: (root: string, relativePath: string, content: string) => Promise<{ relativePath: string }>;
        createFile: (root: string, relativePath: string, content: string) => Promise<{ relativePath: string }>;
        renameFile: (root: string, fromRelativePath: string, toRelativePath: string) => Promise<{ relativePath: string; previousRelativePath: string }>;
        duplicateFile: (root: string, fromRelativePath: string, toRelativePath: string) => Promise<{ relativePath: string; sourceRelativePath: string }>;
        deleteFile: (root: string, relativePath: string) => Promise<{ relativePath: string }>;
        watch: (root: string) => Promise<{ watchId: string; root: string; recursive: boolean }>;
        unwatch: (watchId: string) => Promise<{ stopped: boolean }>;
        onChanged: (callback: (update: ProjectWatchUpdate) => void) => () => void;
        buildProfiles: () => Promise<BuildProfile[]>;
        runBuild: (root: string, relativePath: string, profileId: string) => Promise<{ ok: boolean; profile: string; outputPath?: string; outputRelativePath?: string; error?: string }>;
        /** Runs the editor's current Python buffer locally; no source must be saved first. */
        runPython?: (source: string, name: string, options?: PythonRunOptions) => Promise<PythonRunResult>;
        saveAs: (suggestedName: string, content: string, type: SourceType) => Promise<{ path?: string; canceled?: boolean }>;
      };
      render: {
        tikz: (source: string, name: string, engine?: TexPdfEngine) => Promise<
          | { ok: true; dataUri: string; pdfPath: string; directory: string; engine: TexPdfEngine }
          | { ok: false; error: string }
        >;
        latex: (source: string, name: string, mode?: 'pdf' | 'dvi', engine?: TexPdfEngine) => Promise<
          | { ok: true; format: 'pdf'; dataUri: string; pdfPath: string; directory: string; engine: TexPdfEngine }
          | { ok: true; format: 'dvi'; dviPath: string; directory: string; engine: 'latex'; previewKind: 'svg'; svg: string }
          | { ok: true; format: 'dvi'; dviPath: string; directory: string; engine: 'latex'; previewKind: 'none'; warning: string }
          | { ok: false; error: string }
        >;
        metafont: (source: string, name: string) => Promise<
          | { ok: true; svg: string }
          | { ok: false; error: string }
        >;
        export: (payload: {
          sourceType: SourceType;
          source: string;
          svg?: string;
          html?: string;
          format: ExportFormat;
          suggestedName: string;
          scale?: 1 | 2 | 4;
          /** Applies to TikZ and LaTeX PDF-family exports; DVI always uses classic latex. */
          engine?: TexPdfEngine;
        }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      };
      settings: {
        load: () => Promise<AppSettings>;
        save: (settings: AppSettings) => Promise<AppSettings>;
      };
      git: {
        status: (root: string) => Promise<GitStatusResponse>;
        diff: (root: string, relativePath?: string, options?: { staged?: boolean }) => Promise<{ available: boolean; isRepository: boolean; root: string; error?: string; diff?: string; hasChanges?: boolean }>;
        log: (root: string, relativePath?: string, options?: { limit?: number }) => Promise<GitLogResponse>;
      };
      clipboard: {
        writeSvg: (svg: string) => Promise<{ ok: boolean }>;
        writeDataUriImage: (dataUri: string) => Promise<{ ok: boolean; size?: { width: number; height: number } }>;
      };
      shell: {
        reveal: (path: string) => Promise<void>;
      };
      onMenuAction: (callback: (action: string) => void) => () => void;
      rendererReady: () => void;
    };
  }
}
