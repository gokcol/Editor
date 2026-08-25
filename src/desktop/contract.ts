import type {
  AppSettings,
  BuildProfile,
  CharacterEncoding,
  DecodedSourceFile,
  ExternalOpenFilesResult,
  ExportFormat,
  GitLogResponse,
  GitBranchesResponse,
  GitMutationResponse,
  GitStatusResponse,
  OpenedSourceFile,
  OpenRecentResult,
  Project,
  ProjectTask,
  ProjectTaskResult,
  ProjectWatchUpdate,
  PythonRunOptions,
  PythonRunResult,
  RecentEntry,
  SourceType,
  TexPdfEngine,
} from '../types';

/**
 * The renderer's intentionally small, local-only desktop boundary.
 *
 * The native shell implements this contract without making the React
 * workbench aware of its IPC or runtime details.
 */
export interface DesktopApi {
  project: {
    open: () => Promise<Project | { canceled: true }>;
    openFile: (projectRoot?: string, encoding?: CharacterEncoding) => Promise<OpenedSourceFile | { canceled: true }>;
    /** Shows the containing folder of an independently opened file in Files. */
    revealOpenedFileFolder: (fileHandle: string) => Promise<Project>;
    create: (name: string) => Promise<Project | { canceled: true }>;
    refresh: (root: string) => Promise<Project>;
    readFile: (root: string, relativePath: string, encoding?: CharacterEncoding) => Promise<DecodedSourceFile>;
    writeFile: (root: string, relativePath: string, content: string, encoding?: CharacterEncoding) => Promise<{ relativePath: string }>;
    createFile: (root: string, relativePath: string, content: string) => Promise<{ relativePath: string }>;
    renameFile: (root: string, fromRelativePath: string, toRelativePath: string) => Promise<{ relativePath: string; previousRelativePath: string }>;
    duplicateFile: (root: string, fromRelativePath: string, toRelativePath: string) => Promise<{ relativePath: string; sourceRelativePath: string }>;
    deleteFile: (root: string, relativePath: string) => Promise<{ relativePath: string }>;
    watch: (root: string) => Promise<{ watchId: string; root: string; recursive: boolean }>;
    unwatch: (watchId: string) => Promise<{ stopped: boolean }>;
    onChanged: (callback: (update: ProjectWatchUpdate) => void) => () => void;
    /** Lists safe, backend-discovered project tasks such as book build/preview. */
    listTasks: (root: string) => Promise<ProjectTask[]>;
    /** Runs one backend-approved task; task IDs are never shell commands. */
    runTask: (root: string, taskId: string) => Promise<ProjectTaskResult>;
    buildProfiles: () => Promise<BuildProfile[]>;
    runBuild: (root: string, relativePath: string, profileId: string) => Promise<{ ok: boolean; profile: string; outputPath?: string; outputRelativePath?: string; error?: string }>;
    /** Runs the editor's current Python buffer locally; no source must be saved first. */
    runPython?: (source: string, name: string, options?: PythonRunOptions) => Promise<PythonRunResult>;
    writeOpenedFile: (fileHandle: string, content: string, encoding?: CharacterEncoding) => Promise<{ name: string }>;
    readOpenedFile: (fileHandle: string, encoding?: CharacterEncoding) => Promise<DecodedSourceFile>;
    saveAs: (suggestedName: string, content: string, type: SourceType, projectRoot?: string, encoding?: CharacterEncoding) => Promise<{ name?: string; relativePath?: string; fileHandle?: string; canceled?: boolean }>;
  };
  recents: {
    list: () => Promise<RecentEntry[]>;
    /** Imports folders remembered by pre-Yedit renderer builds once. */
    migrateLegacyProjects: (projects: Array<{ root: string; name: string }>) => Promise<RecentEntry[]>;
    open: (id: string, projectRoot?: string, encoding?: CharacterEncoding) => Promise<OpenRecentResult>;
    remove: (id: string) => Promise<RecentEntry[]>;
    clear: () => Promise<RecentEntry[]>;
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
    stage: (root: string, relativePath: string) => Promise<GitMutationResponse>;
    unstage: (root: string, relativePath: string) => Promise<GitMutationResponse>;
    commit: (root: string, message: string) => Promise<GitMutationResponse>;
    branches: (root: string) => Promise<GitBranchesResponse>;
    switchBranch: (root: string, branch: string) => Promise<GitMutationResponse>;
  };
  clipboard: {
    writeSvg: (svg: string) => Promise<{ ok: boolean }>;
    writeDataUriImage: (dataUri: string) => Promise<{ ok: boolean; size?: { width: number; height: number } }>;
  };
  shell: {
    reveal: (path: string) => Promise<void>;
  };
  externalFiles: {
    /** Drains regular files that Finder delivered to the running native app. */
    takePending: (projectRoot?: string) => Promise<ExternalOpenFilesResult>;
    onOpen: (callback: () => void) => () => void;
  };
  onMenuAction: (callback: (action: string) => void) => () => void;
  rendererReady: () => void;
}
