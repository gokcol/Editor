import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import type { AppSettings } from './types';
import './styles.css';

// The real bridge is installed by Electron's preload script. This tiny fallback
// lets a browser-based preview of the renderer open during UI development.
if (!window.diagramApi) {
  const browserSettingsKey = 'yedit-settings';
  const legacyBrowserSettingsKey = 'diagram-foundry-settings';
  const readBrowserSettings = () => window.localStorage.getItem(browserSettingsKey)
    ?? window.localStorage.getItem(legacyBrowserSettingsKey)
    ?? '{}';
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
  window.diagramApi = {
    project: {
      open: async () => ({ canceled: true }),
      openRecent: async () => { throw new Error('Recent projects are available in the desktop app.'); },
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
      buildProfiles: async () => [],
      runBuild: async () => ({ ok: false, profile: 'tikz-pdf', error: 'Build profiles require the local desktop shell.' }),
      saveAs: async () => ({ canceled: true }),
    },
    render: {
      tikz: async (_source, _name, _engine) => ({ ok: false as const, error: 'TikZ previews require the local desktop shell.' }),
      latex: async (_source, _name, _mode, _engine) => ({ ok: false as const, error: 'LaTeX previews require the local desktop shell.' }),
      metafont: async () => ({ ok: false as const, error: 'MetaFont previews require the local desktop shell.' }),
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
