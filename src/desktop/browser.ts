import type { AppSettings } from '../types';
import type { DesktopApi } from './contract';

const browserSettingsKey = 'yedit-settings';
const legacyBrowserSettingsKey = 'diagram-foundry-settings';

const browserDefaults: AppSettings = {
  appearance: 'system',
  uiScale: 110,
  editorFontFamily: 'SF Mono',
  editorFontSize: 14,
  editorBackgroundColor: 'theme',
  editorBackgroundPattern: 'none',
  enabledSourceTypes: ['tikz', 'latex', 'metafont', 'svg', 'mermaid', 'markdown', 'text', 'yaml', 'json', 'javascript', 'typescript', 'python', 'fortran', 'sql', 'html', 'css'],
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
};

const readBrowserSettings = () => window.localStorage.getItem(browserSettingsKey)
  ?? window.localStorage.getItem(legacyBrowserSettingsKey)
  ?? '{}';

/**
 * Allows the Vite renderer to stay useful without a native shell. Native-only
 * actions retain their existing friendly errors rather than pretending to
 * offer filesystem or compiler access in a browser tab.
 */
export function createBrowserDesktopApi(): DesktopApi {
  return {
    project: {
      open: async () => ({ canceled: true }),
      openFile: async () => ({ canceled: true }),
      create: async () => ({ canceled: true }),
      refresh: async () => { throw new Error('Project folders are available in the desktop app.'); },
      readFile: async () => { throw new Error('Project folders are available in the desktop app.'); },
      writeFile: async () => ({ relativePath: '' }),
      createFile: async () => ({ relativePath: '' }),
      renameFile: async () => { throw new Error('Project file tools are available in the desktop app.'); },
      duplicateFile: async () => { throw new Error('Project file tools are available in the desktop app.'); },
      deleteFile: async () => { throw new Error('Project file tools are available in the desktop app.'); },
      watch: async () => ({ watchId: 'browser-preview', root: '', recursive: false }),
      unwatch: async () => ({ stopped: true }),
      onChanged: () => () => undefined,
      listTasks: async () => [],
      runTask: async (_root, taskId) => ({
        ok: false,
        taskId,
        label: 'Project task',
        error: 'Project tasks require the local desktop shell.',
      }),
      buildProfiles: async () => [],
      runBuild: async () => ({ ok: false, profile: 'tikz-pdf', error: 'Build profiles require the local desktop shell.' }),
      writeOpenedFile: async () => { throw new Error('Opening individual files requires the local desktop shell.'); },
      readOpenedFile: async () => { throw new Error('Opening individual files requires the local desktop shell.'); },
      saveAs: async () => ({ canceled: true }),
    },
    recents: {
      list: async () => [],
      migrateLegacyProjects: async () => [],
      open: async () => { throw new Error('Recent items are available in the desktop app.'); },
      remove: async () => [],
      clear: async () => [],
    },
    render: {
      tikz: async () => ({ ok: false, error: 'TikZ previews require the local desktop shell.' }),
      latex: async () => ({ ok: false, error: 'LaTeX previews require the local desktop shell.' }),
      metafont: async () => ({ ok: false, error: 'MetaFont previews require the local desktop shell.' }),
      export: async () => ({ ok: false, error: 'Exports require the local desktop shell.' }),
    },
    settings: {
      load: async () => {
        try {
          return { ...browserDefaults, ...JSON.parse(readBrowserSettings()) } as AppSettings;
        } catch {
          return browserDefaults;
        }
      },
      save: async (settings) => {
        window.localStorage.setItem(browserSettingsKey, JSON.stringify(settings));
        return settings;
      },
    },
    git: {
      status: async () => ({ available: false, isRepository: false, root: '', error: 'Git inspection requires the local desktop shell.' }),
      diff: async () => ({ available: false, isRepository: false, root: '', error: 'Git inspection requires the local desktop shell.', diff: '' }),
      log: async () => ({ available: false, isRepository: false, root: '', error: 'Git inspection requires the local desktop shell.', entries: [] }),
      stage: async () => ({ ok: false, available: false, isRepository: false, root: '', error: 'Git editing requires the local desktop shell.' }),
      unstage: async () => ({ ok: false, available: false, isRepository: false, root: '', error: 'Git editing requires the local desktop shell.' }),
      commit: async () => ({ ok: false, available: false, isRepository: false, root: '', error: 'Git editing requires the local desktop shell.' }),
      branches: async () => ({ available: false, isRepository: false, root: '', error: 'Git inspection requires the local desktop shell.', branches: [] }),
      switchBranch: async () => ({ ok: false, available: false, isRepository: false, root: '', error: 'Git editing requires the local desktop shell.' }),
    },
    clipboard: {
      writeSvg: async (svg) => { await navigator.clipboard?.writeText(svg); return { ok: true }; },
      writeDataUriImage: async () => { throw new Error('Copy Image requires the local desktop shell.'); },
    },
    shell: { reveal: async () => undefined },
    onMenuAction: () => () => undefined,
    rendererReady: () => undefined,
  };
}
