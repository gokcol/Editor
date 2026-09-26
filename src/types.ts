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
/** Where the primary workbench commands live. The status readout stays below
 * the editor in either mode; only one command surface is shown at a time. */
export type NavigationPlacement = 'bottom' | 'left';
/** Canonical label for one of the locally supported character codecs. */
export type CharacterEncoding = string;

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
  /** Keeps opened projects passive: no task, build, or runner execution. */
  safeMode: boolean;
  formatOnSave: boolean;
  previewAutoRender: boolean;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  editorTabSize: number;
  navigationPlacement: NavigationPlacement;
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
  diskVersion?: string;
  conflict?: boolean;
  recoveryOrigin?: string;
  id: string;
  name: string;
  sourceType: SourceType;
  value: string;
  relativePath?: string;
  /** Project that owns `relativePath`; prevents a tab from following a later folder switch. */
  projectRoot?: string;
  /** Opaque main-process permission for a file opened outside a project. */
  fileHandle?: string;
  /** Codec used to decode the file and to preserve its byte representation on save. */
  encoding?: CharacterEncoding;
  /** Pinned tabs stay open until explicitly unpinned. */
  pinned?: boolean;
  /** A saved target disappeared; retain this as a Save As-able recovery draft. */
  recoveryDraft?: boolean;
  /** The untouched launch/new tab may be omitted from scratch-session restore. */
  defaultUntitled?: boolean;
  dirty: boolean;
  revision: number;
};

export type OpenedProjectSourceFile = {
  diskVersion?: string;
  name: string;
  sourceType: SourceType;
  content: string;
  encoding: CharacterEncoding;
  /** A file within the currently opened project retains its project binding. */
  relativePath: string;
};

export type OpenedStandaloneSourceFile = {
  diskVersion?: string;
  name: string;
  sourceType: SourceType;
  content: string;
  encoding: CharacterEncoding;
  /** Opaque handle used to save this independently opened file in place. */
  fileHandle: string;
};

export type OpenedSourceFile = OpenedProjectSourceFile | OpenedStandaloneSourceFile;

/** Files passed to Yedit by Finder after the native window is already live. */
export type ExternalOpenFilesResult = {
  files: OpenedSourceFile[];
  errors: string[];
};

export type DecodedSourceFile = {
  diskVersion?: string;
  content: string;
  encoding: CharacterEncoding;
};

/** A locally remembered folder or standalone source file. */
export type RecentEntry = {
  id: string;
  kind: 'project' | 'file';
  name: string;
  /** Display path. The native process validates it again before reopening. */
  path: string;
  openedAt: number;
};

/** Result of reopening a native recent entry. */
export type OpenRecentResult =
  | { kind: 'project'; project: Project }
  | { kind: 'file'; file: OpenedSourceFile };

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

/**
 * A project-owned build or preview entry discovered by the local desktop
 * backend. Tasks deliberately remain descriptive rather than exposing an
 * arbitrary command line to the renderer.
 */
export type ProjectTask = {
  id: string;
  label: string;
  description: string;
  /** Display-only source for the task, such as `build.sh`. */
  script?: string;
  /** Display-only argv for a checked `yedit.tasks.json` task. */
  command?: string;
  /** Backend-classified intent used to surface build and preview tasks first. */
  kind?: 'build' | 'preview' | 'test' | 'run' | 'lint' | 'format';
};

/** Result returned by a guarded project task run. */
export type ProjectTaskResult = {
  ok: boolean;
  taskId: string;
  label: string;
  output?: string;
  error?: string;
  outputPath?: string;
  outputRelativePath?: string;
  /** A PDF data URI when the task generated a previewable document. */
  dataUri?: string;
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

export type GitMutationResponse = {
  ok: boolean;
  available: boolean;
  isRepository: boolean;
  root: string;
  error?: string;
};

export type GitBranchesResponse = {
  available: boolean;
  isRepository: boolean;
  root: string;
  current?: string;
  branches?: string[];
  error?: string;
};
