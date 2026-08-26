import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import './styles.css';

type ViewMode = 'edit' | 'split' | 'preview';
type TextDocument = {
  id: string;
  name: string;
  path?: string;
  content: string;
  savedContent: string;
  isMarkdown: boolean;
  encoding: string;
  cursor?: number;
};
type OpenedTextFile = { name: string; path: string; content: string; isMarkdown: boolean; encoding: string };
type SavedTextFile = { name: string; path: string; encoding: string };
type RecentEntry = { name: string; path: string; isMarkdown: boolean; openedAt: number };
type DocumentHistory = { entries: string[]; index: number };
type FolderEntry = { name: string; path: string; kind: 'file' | 'directory' };
type ProjectFolder = { name: string; path: string; parentPath?: string; homePath: string; documentsPath: string; entries: FolderEntry[]; truncated: boolean };
type FolderBookmark = { name: string; path: string };
type FileFingerprint = { modifiedMillis: number; size: number };
type ExternalChange = { path: string; name: string; fingerprint?: FileFingerprint };
type EditorOptions = { wordWrap: boolean; indentation: 'spaces' | 'tabs'; tabSize: 2 | 4 | 8; lineEnding: 'lf' | 'crlf'; spellLanguage: string };
type SessionDocument = Omit<TextDocument, 'id'> & { cursor?: number };
type RestoredSession = { documents: SessionDocument[]; activeIndex: number; savedAt: number };

const RECENTS_KEY = '7txt:recent-files:v1';
const PROJECT_FOLDER_KEY = '7txt:open-folder:v1';
const FOLDER_BOOKMARKS_KEY = '7txt:folder-bookmarks:v1';
const EDITOR_APPEARANCE_KEY = '7txt:editor-appearance:v1';
const EDITOR_OPTIONS_KEY = '7txt:editor-options:v1';
const UI_THEME_KEY = '7txt:ui-theme:v1';
const UI_SCALE_KEY = '7txt:ui-scale:v1';
const EDITOR_SURFACE_KEY = '7txt:editor-surface:v1';
const SIDEBAR_VISIBLE_KEY = '7txt:sidebar-visible:v1';
const SIDEBAR_WIDTH_KEY = '7txt:sidebar-width:v1';
const SESSION_KEY = '7txt:workspace-session:v1';
const RECOVERY_KEY = '7txt:recovery-drafts:v1';
const MAX_RECENTS = 14;
const MAX_FOLDER_BOOKMARKS = 12;
const MAX_RECOVERY_BYTES = 3 * 1024 * 1024;
const MIN_SIDEBAR_WIDTH = 180;
const DEFAULT_SIDEBAR_WIDTH = 218;
const MAX_SIDEBAR_WIDTH = 430;
const EDITOR_FONTS = [
  ['ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', 'Mono'],
  ['SFMono-Regular, SF Mono, Menlo, Monaco, monospace', 'SF Mono'],
  ['Menlo, Monaco, monospace', 'Menlo'],
  ['Monaco, Menlo, monospace', 'Monaco'],
  ['Courier New, Courier, monospace', 'Courier'],
  ['-apple-system, BlinkMacSystemFont, sans-serif', 'System'],
  ['Georgia, Times New Roman, serif', 'Serif'],
] as const;
const EDITOR_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24] as const;
const DEFAULT_EDITOR_FONT = EDITOR_FONTS[0][0];
const DEFAULT_EDITOR_FONT_SIZE = 14;
const UI_THEMES = [
  ['system', 'System'], ['light', 'Light'], ['dark', 'Dark'],
  ['midnight', 'Midnight'], ['graphite', 'Graphite'], ['ocean', 'Ocean'],
  ['forest', 'Forest'], ['violet', 'Violet'], ['rose', 'Rose'],
  ['sepia', 'Sepia'], ['contrast', 'High contrast'], ['paper', 'Paper'],
] as const;
type UiTheme = typeof UI_THEMES[number][0];
const UI_SCALES = [
  ['compact', 'Compact'], ['normal', 'Normal'], ['comfortable', 'Comfortable'], ['large', 'Large'], ['very-large', 'Very large'],
] as const;
type UiScale = typeof UI_SCALES[number][0];
const UI_SCALE_FACTORS: Record<UiScale, number> = { compact: .88, normal: 1, comfortable: 1.08, large: 1.17, 'very-large': 1.28 };
const EDITOR_SURFACES = [
  ['plain', 'Plain'], ['glossy', 'Glossy'], ['ruled', 'Ruled'], ['college', 'College ruled'], ['graph', 'Graph paper'], ['dotted', 'Dotted'], ['musical', 'Musical staff'], ['blueprint', 'Blueprint'], ['warm-paper', 'Warm paper'], ['linen', 'Linen'], ['night-grid', 'Night grid'],
] as const;
type EditorSurface = typeof EDITOR_SURFACES[number][0];
const CHARACTER_ENCODINGS = [
  ['auto', 'Auto detect (UTF-8 / BOM / Windows-1252)'],
  ['utf-8', 'UTF-8'], ['utf-8-bom', 'UTF-8 with BOM'],
  ['utf-16le', 'UTF-16 Little Endian'], ['utf-16le-bom', 'UTF-16 Little Endian with BOM'],
  ['utf-16be', 'UTF-16 Big Endian'], ['utf-16be-bom', 'UTF-16 Big Endian with BOM'],
  ['windows-1252', 'Western: Windows-1252 / ISO-8859-1'], ['windows-1250', 'Central European: Windows-1250'], ['windows-1251', 'Cyrillic: Windows-1251'], ['windows-1253', 'Greek: Windows-1253'], ['windows-1254', 'Turkish: Windows-1254 / ISO-8859-9'], ['windows-1255', 'Hebrew: Windows-1255'], ['windows-1256', 'Arabic: Windows-1256'], ['windows-1257', 'Baltic: Windows-1257'], ['windows-1258', 'Vietnamese: Windows-1258'], ['windows-874', 'Thai: Windows-874 / ISO-8859-11'],
  ['iso-8859-2', 'ISO-8859-2 (Central European)'], ['iso-8859-3', 'ISO-8859-3 (South European)'], ['iso-8859-4', 'ISO-8859-4 (Baltic)'], ['iso-8859-5', 'ISO-8859-5 (Cyrillic)'], ['iso-8859-6', 'ISO-8859-6 (Arabic)'], ['iso-8859-7', 'ISO-8859-7 (Greek)'], ['iso-8859-8', 'ISO-8859-8 (Hebrew)'], ['iso-8859-8-i', 'ISO-8859-8-I (Hebrew visual)'], ['iso-8859-10', 'ISO-8859-10 (Nordic)'], ['iso-8859-13', 'ISO-8859-13 (Baltic)'], ['iso-8859-14', 'ISO-8859-14 (Celtic)'], ['iso-8859-15', 'ISO-8859-15 (Western)'], ['iso-8859-16', 'ISO-8859-16 (South-Eastern European)'],
  ['macintosh', 'Mac Roman'], ['x-mac-cyrillic', 'Mac Cyrillic'], ['koi8-r', 'KOI8-R'], ['koi8-u', 'KOI8-U'], ['ibm866', 'IBM866 / DOS Cyrillic'],
  ['shift_jis', 'Shift_JIS (Japanese)'], ['euc-jp', 'EUC-JP (Japanese)'], ['iso-2022-jp', 'ISO-2022-JP (Japanese)'], ['euc-kr', 'EUC-KR (Korean)'], ['big5', 'Big5 (Traditional Chinese)'], ['gbk', 'GBK (Simplified Chinese)'], ['gb18030', 'GB18030 (Chinese)'],
] as const;
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) throw new Error('7TXT could not create its editor window.');

app.innerHTML = `
  <main class="app-shell" data-mode="split">
    <header class="titlebar">
      <div class="brand"><span class="brand-mark">7</span><strong>7TXT</strong><span class="brand-subtitle">quiet text &amp; Markdown</span></div>
      <div class="document-title"><span class="dirty-dot" aria-hidden="true"></span><strong></strong><small></small></div>
      <div aria-hidden="true"></div>
    </header>
    <nav class="document-tabs" aria-label="Open documents">
      <div class="tab-list" role="tablist"></div>
      <button class="tab-new" data-action="new-text" title="New text tab (⌘N)" aria-label="New text tab">+</button>
    </nav>
    <section class="toolbar" aria-label="Document controls">
      <div class="file-actions">
        <button class="toolbar-icon-button" data-action="new-text" title="New text tab (⌘N)" aria-label="New text tab"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M12 11v6M9 14h6"/></svg></button>
        <button class="toolbar-icon-button" data-action="new-markdown" title="New Markdown tab (⇧⌘N)" aria-label="New Markdown tab"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M8.5 16v-5l2 2.7L12.5 11v5M15 11v5"/></svg></button>
        <button class="toolbar-icon-button" data-action="open" title="Open file (⌘O)" aria-label="Open file"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3zM3 7V5h7l2 2"/></svg></button>
        <button class="toolbar-icon-button" data-action="save-as" title="Save As (⇧⌘S)" aria-label="Save As"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M10 18l6.4-6.4 2 2L12 20l-3 1z"/></svg></button>
      </div>
      <button class="toolbar-icon-button sidebar-toggle" data-action="toggle-sidebar" title="Hide Files sidebar (⇧⌘B)" aria-label="Hide Files sidebar" aria-expanded="true"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM10 4v16M7 8h.01M7 12h.01M7 16h.01"/></svg></button>
      <div class="quick-actions" aria-label="Quick actions">
        <button class="toolbar-icon-button save-button" data-action="save" title="Save (⌘S)" aria-label="Save"><svg class="toolbar-icon toolbar-save-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="save-body" d="M5 3h12l3 3v15H5z"/><path d="M8 3v6h8V3M8 20v-6h8v6"/></svg></button>
        <button class="toolbar-icon-button" data-action="find" title="Find (⌘F)" aria-label="Find"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="5.5"/><path d="m16 16 4 4"/></svg></button>
        <button class="toolbar-icon-button folder-bookmark-toggle" data-action="toggle-folder-bookmark" title="Bookmark this folder" aria-label="Bookmark this folder"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/></svg></button>
        <button class="toolbar-icon-button" data-action="command-palette" title="Command Palette (⇧⌘P)" aria-label="Command Palette"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 9h.01M12 9h4M8 13h.01M12 13h4M8 17h8"/></svg></button>
      </div>
      <label class="encoding-control" title="Text encoding — click to choose how this document is opened or saved."><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 6l-4 12"/></svg><select data-encoding aria-label="Text encoding">${CHARACTER_ENCODINGS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <button data-action="reopen-encoding" class="toolbar-icon-button reopen-encoding" title="Reload this saved document using the selected encoding" aria-label="Reload using selected encoding"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5M20 5v6h-6"/></svg></button>
      <div class="view-switch" role="group" aria-label="View mode">
        <button data-mode-button="edit" title="Edit view (⌘1)">Edit</button>
        <button data-mode-button="split" title="Split view (⌘2)">Split</button>
        <button data-mode-button="preview" title="Preview (⌘3)">Preview</button>
      </div>
      <div class="markdown-actions" aria-label="Markdown tools">
        <button class="toolbar-icon-button" data-action="insert-table" title="Insert Markdown table" aria-label="Insert Markdown table"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14"/></svg></button>
        <button class="toolbar-icon-button" data-action="toggle-task" title="Toggle Markdown task list" aria-label="Toggle Markdown task list"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h3v3H4zM10 7h10M4 15h3v3H4zM10 16h10M4.5 15.5 5.7 17l2-3"/></svg></button>
        <button class="toolbar-icon-button" data-action="export-html" title="Export Markdown as HTML" aria-label="Export Markdown as HTML"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M12 11v7M9 15l3 3 3-3"/></svg></button>
      </div>
      <div class="toolbar-spacer"></div>
      <details class="theme-picker">
        <summary title="Interface theme and size" aria-label="Interface theme and size"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="11" r="8"/><path d="M5.5 15.5 3.8 19a1.4 1.4 0 0 0 1.9 1.9l3.5-1.7M9 9h.01M13 7h.01M17 9h.01M16 14h.01"/></svg></summary>
        <div class="theme-picker-menu" aria-label="Interface appearance"><div class="theme-choice-grid" role="group" aria-label="Interface theme">${UI_THEMES.map(([value, label]) => `<button type="button" data-theme-choice="${value}" aria-pressed="false"><span class="theme-swatch theme-swatch-${value}"></span><span>${label}</span></button>`).join('')}</div><div class="theme-menu-divider"></div><span class="theme-menu-heading">Interface size</span><div class="ui-scale-options" role="group" aria-label="Interface size">${UI_SCALES.map(([value, label]) => `<button type="button" data-ui-scale-choice="${value}" aria-pressed="false">${label}</button>`).join('')}</div></div>
      </details>
      <details class="editor-appearance">
        <summary title="Editor font and size" aria-label="Editor font and size"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19 9.5 5h5L20 19M7 14h10M10 19h4"/></svg></summary>
        <div class="editor-appearance-menu">
          <label>Font<select data-editor-font aria-label="Editor font">${EDITOR_FONTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
          <label>Size<select data-editor-font-size aria-label="Editor font size">${EDITOR_FONT_SIZES.map((size) => `<option value="${size}">${size} px</option>`).join('')}</select></label>
          <label>Writing surface<select data-editor-surface aria-label="Writing surface">${EDITOR_SURFACES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
          <label>Wrap<select data-editor-wrap aria-label="Word wrap"><option value="on">Wrap lines</option><option value="off">No wrap</option></select></label>
          <label>Indent<select data-editor-indent aria-label="Indentation"><option value="spaces">Spaces</option><option value="tabs">Tabs</option></select></label>
          <label>Tab width<select data-editor-tab-size aria-label="Tab width"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="8">8 spaces</option></select></label>
          <label>Line endings<select data-editor-line-ending aria-label="Line endings"><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
          <label>Spell check<select data-editor-spell-language aria-label="Spell check language"><option value="en">English</option><option value="tr">Türkçe</option><option value="de">Deutsch</option><option value="fr">Français</option><option value="es">Español</option><option value="it">Italiano</option><option value="none">Off</option></select></label>
        </div>
      </details>
      <button class="toolbar-icon-button" data-action="toggle-editor-split" title="Split editor" aria-label="Split editor"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM12 4v16"/></svg></button>
      <button class="toolbar-icon-button" data-action="zen" title="Zen mode" aria-label="Zen mode"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M12 4v16M7 7l10 10M17 7 7 17"/></svg></button>
      <button data-action="undo" title="Undo (⌘Z)">↶</button>
      <button data-action="redo" title="Redo (⇧⌘Z)">↷</button>
    </section>
    <section class="findbar" hidden>
      <span class="find-input"><svg class="find-input-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="5.5"/><path d="m16 16 4 4"/></svg><input type="search" placeholder="Search this document" aria-label="Find in document" spellcheck="false" /></span>
      <span class="replace-input"><input type="search" placeholder="Replace with" aria-label="Replace with" spellcheck="false" /></span>
      <label class="find-option"><input type="checkbox" data-find-case />Case</label>
      <label class="find-option"><input type="checkbox" data-find-regex />Regex</label>
      <button data-action="find-next">Next</button>
      <button data-action="replace">Replace</button>
      <button data-action="replace-all">All</button>
      <button data-action="close-find" aria-label="Close Find">×</button>
    </section>
    <section class="workspace">
      <aside class="sidebar">
        <section class="sidebar-section project-section">
          <div class="section-head"><span class="files-section-icon" title="Files" aria-label="Files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3zM3 7V5h7l2 2"/></svg></span><span class="section-actions"><button data-action="new-browser-entry" title="New text file or folder" aria-label="New text file or folder">+</button><button data-action="toggle-hidden-files" title="Show hidden files" aria-label="Show hidden files">·</button><button data-action="browser-up" title="Go to parent folder" aria-label="Go up">↑</button><button class="sidebar-icon-button" data-action="browser-home" title="Go to your home folder" aria-label="Go to your home folder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10h-6v-6h-6v6H3z"/></svg></button><button class="sidebar-icon-button" data-action="browser-documents" title="Go to Documents" aria-label="Go to Documents"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6"/></svg></button><button class="sidebar-icon-button" data-action="open-folder" title="Choose any folder or disk" aria-label="Choose any folder or disk"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3zM3 7V5h7l2 2M12 12v5M9.5 14.5h5"/></svg></button><button data-action="refresh-folder" title="Refresh this folder" aria-label="Refresh folder">↻</button></span></div>
          <input class="folder-filter" type="search" placeholder="Filter files…" aria-label="Filter folder files" spellcheck="false" />
          <div class="folder-bookmarks" aria-label="Folder bookmarks" hidden></div>
          <div class="project-tree"></div>
        </section>
        <section class="sidebar-section outline-section">
          <div class="section-head"><span>OUTLINE</span><button data-action="refresh-outline" title="Refresh Markdown outline">↻</button></div>
          <div class="outline-list"></div>
        </section>
        <section class="sidebar-section recents-section">
          <div class="section-head"><span>RECENT FILES</span><button data-action="clear-recents" title="Clear recent files">Clear</button></div>
          <div class="recents-list"></div>
        </section>
      </aside>
      <div class="sidebar-resizer" role="separator" aria-label="Resize Files sidebar" aria-orientation="vertical" aria-valuemin="180" aria-valuemax="430" tabindex="0"></div>
      <section class="editor-pane">
        <div class="external-change" hidden><span></span><button data-action="reload-external">Reload</button><button data-action="compare-external">Compare</button><button data-action="ignore-external">Ignore</button></div>
        <div class="editor-heading"><span class="format-chip"></span><span class="editor-mode-label">Plain text</span><span class="editor-status"></span></div>
        <div class="editor-surface"><textarea class="editor" aria-label="Text editor" spellcheck="true" placeholder="Start writing…"></textarea><textarea class="editor editor-secondary" aria-label="Second text editor pane" spellcheck="true" placeholder="Start writing…"></textarea></div>
      </section>
      <section class="preview-pane">
        <div class="preview-heading"><span>PREVIEW</span><span class="preview-kind"></span></div>
        <article class="markdown-preview" aria-label="Document preview"></article>
      </section>
    </section>
    <footer class="statusbar">
      <span class="status-file">Untitled</span>
      <span class="status-stats"></span>
      <span class="status-cursor">Ln 1, Col 1</span>
      <span class="status-spacer"></span>
      <span class="status-help">⌘O Open · ⌘S Save · ⌘F Find</span>
    </footer>
    <div class="toast" role="status" aria-live="polite" hidden></div>
    <section class="command-palette" hidden aria-label="Command Palette"><div class="command-palette-card"><input type="search" placeholder="Type a command…" aria-label="Search commands" spellcheck="false" /><div class="command-list"></div><small>↑↓ navigate · Enter run · Esc close</small></div></section>
  </main>
`;

const shell = required<HTMLElement>('.app-shell');
const editor = required<HTMLTextAreaElement>('.editor');
const secondaryEditor = required<HTMLTextAreaElement>('.editor-secondary');
const preview = required<HTMLElement>('.markdown-preview');
const findbar = required<HTMLElement>('.findbar');
const findInput = required<HTMLInputElement>('.findbar input');
const replaceInput = required<HTMLInputElement>('.replace-input input');
const findCase = required<HTMLInputElement>('[data-find-case]');
const findRegex = required<HTMLInputElement>('[data-find-regex]');
const outlineList = required<HTMLElement>('.outline-list');
const recentsList = required<HTMLElement>('.recents-list');
const projectTree = required<HTMLElement>('.project-tree');
const folderBookmarks = required<HTMLElement>('.folder-bookmarks');
const toast = required<HTMLElement>('.toast');
const encodingSelect = required<HTMLSelectElement>('[data-encoding]');
const reopenEncodingButton = required<HTMLButtonElement>('.reopen-encoding');
const editorFontSelect = required<HTMLSelectElement>('[data-editor-font]');
const editorFontSizeSelect = required<HTMLSelectElement>('[data-editor-font-size]');
const editorSurfaceSelect = required<HTMLSelectElement>('[data-editor-surface]');
const editorWrapSelect = required<HTMLSelectElement>('[data-editor-wrap]');
const editorIndentSelect = required<HTMLSelectElement>('[data-editor-indent]');
const editorTabSizeSelect = required<HTMLSelectElement>('[data-editor-tab-size]');
const editorLineEndingSelect = required<HTMLSelectElement>('[data-editor-line-ending]');
const editorSpellLanguageSelect = required<HTMLSelectElement>('[data-editor-spell-language]');
const folderBookmarkToggle = required<HTMLButtonElement>('[data-action="toggle-folder-bookmark"]');
const sidebarToggle = required<HTMLButtonElement>('[data-action="toggle-sidebar"]');
const themePicker = required<HTMLDetailsElement>('.theme-picker');
const folderFilter = required<HTMLInputElement>('.folder-filter');
const workspace = required<HTMLElement>('.workspace');
const sidebarResizer = required<HTMLElement>('.sidebar-resizer');
const externalChangeBar = required<HTMLElement>('.external-change');
const commandPalette = required<HTMLElement>('.command-palette');
const commandPaletteInput = required<HTMLInputElement>('.command-palette input');
const commandList = required<HTMLElement>('.command-list');
const tabList = required<HTMLElement>('.tab-list');

let nextDocumentId = 1;
const firstDocument = blankDocument();
let documents: TextDocument[] = [firstDocument];
let activeDocumentId = firstDocument.id;
let documentState: TextDocument = firstDocument;
let viewMode: ViewMode = 'split';
let projectFolder: ProjectFolder | null = null;
let showHiddenFiles = false;
let folderFilterValue = '';
let editorSplit = false;
let zenMode = false;
let uiTheme = readUiTheme();
let uiScale = readUiScale();
let editorSurface = readEditorSurface();
let sidebarVisible = readSidebarVisible();
let sidebarWidth = readSidebarWidth();
let sidebarResizePointerId: number | null = null;
let externalChange: ExternalChange | null = null;
const fileFingerprints = new Map<string, FileFingerprint>();
const histories = new Map<string, DocumentHistory>([[firstDocument.id, { entries: [''], index: 0 }]]);
let toastTimer: number | undefined;
let recoveryTimer: number | undefined;
let autosaveInFlight = false;
let commandSelection = 0;

function required<T extends Element>(selector: string): T {
  const value = app!.querySelector<T>(selector);
  if (!value) throw new Error(`7TXT is missing ${selector}.`);
  return value;
}

function isUiTheme(value: string): value is UiTheme {
  return UI_THEMES.some(([theme]) => theme === value);
}

function readUiTheme(): UiTheme {
  const stored = localStorage.getItem(UI_THEME_KEY) || 'system';
  return isUiTheme(stored) ? stored : 'system';
}

function applyUiTheme() {
  shell.dataset.theme = uiTheme;
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    const selected = button.dataset.themeChoice === uiTheme;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function setUiTheme(next: string) {
  if (!isUiTheme(next)) return;
  uiTheme = next;
  localStorage.setItem(UI_THEME_KEY, uiTheme);
  applyUiTheme();
  themePicker.open = false;
  showToast(`${UI_THEMES.find(([theme]) => theme === uiTheme)?.[1] || 'System'} theme selected.`);
}

function isUiScale(value: string): value is UiScale {
  return UI_SCALES.some(([scale]) => scale === value);
}

function readUiScale(): UiScale {
  const stored = localStorage.getItem(UI_SCALE_KEY) || 'normal';
  return isUiScale(stored) ? stored : 'normal';
}

function uiScaleFactor() {
  return UI_SCALE_FACTORS[uiScale];
}

function applyUiScale() {
  shell.dataset.uiScale = uiScale;
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-ui-scale-choice]')) {
    const selected = button.dataset.uiScaleChoice === uiScale;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function setUiScale(next: string) {
  if (!isUiScale(next)) return;
  uiScale = next;
  localStorage.setItem(UI_SCALE_KEY, uiScale);
  applyUiScale();
  themePicker.open = false;
  showToast(`${UI_SCALES.find(([scale]) => scale === uiScale)?.[1] || 'Normal'} interface size selected.`);
}

function isEditorSurface(value: string): value is EditorSurface {
  return EDITOR_SURFACES.some(([surface]) => surface === value);
}

function readEditorSurface(): EditorSurface {
  const stored = localStorage.getItem(EDITOR_SURFACE_KEY) || 'plain';
  return isEditorSurface(stored) ? stored : 'plain';
}

function applyEditorSurface() {
  shell.dataset.editorSurface = editorSurface;
  editorSurfaceSelect.value = editorSurface;
}

function setEditorSurface(next: string) {
  if (!isEditorSurface(next)) return;
  editorSurface = next;
  localStorage.setItem(EDITOR_SURFACE_KEY, editorSurface);
  applyEditorSurface();
  showToast(`${EDITOR_SURFACES.find(([surface]) => surface === editorSurface)?.[1] || 'Plain'} writing surface selected.`);
}

function closeTransientMenus() {
  for (const menu of app!.querySelectorAll<HTMLDetailsElement>('.theme-picker, .editor-appearance')) menu.open = false;
}

function setupTransientMenus() {
  for (const menu of app!.querySelectorAll<HTMLDetailsElement>('.theme-picker, .editor-appearance')) {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of app!.querySelectorAll<HTMLDetailsElement>('.theme-picker, .editor-appearance')) {
        if (other !== menu) other.open = false;
      }
    });
  }
}

function clampSidebarWidth(width: number) {
  const available = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth / uiScaleFactor() - 320);
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), Math.min(MAX_SIDEBAR_WIDTH, available)));
}

function readSidebarVisible() {
  return localStorage.getItem(SIDEBAR_VISIBLE_KEY) !== 'false';
}

function readSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
}

function applySidebarLayout() {
  const visibleLabel = sidebarVisible ? 'Hide Files sidebar' : 'Show Files sidebar';
  workspace.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  shell.classList.toggle('sidebar-hidden', !sidebarVisible);
  sidebarToggle.title = `${visibleLabel} (⇧⌘B)`;
  sidebarToggle.setAttribute('aria-label', visibleLabel);
  sidebarToggle.setAttribute('aria-expanded', String(sidebarVisible));
  sidebarResizer.setAttribute('aria-valuenow', String(sidebarWidth));
}

function setSidebarWidth(width: number, persist = true) {
  sidebarWidth = clampSidebarWidth(width);
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  applySidebarLayout();
}

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(sidebarVisible));
  applySidebarLayout();
  showToast(sidebarVisible ? 'Files sidebar shown.' : 'Files sidebar hidden.');
}

function blankDocument(isMarkdown = false): TextDocument {
  return {
    id: `document-${nextDocumentId++}`,
    name: isMarkdown ? 'untitled.md' : 'untitled.txt',
    content: '',
    savedContent: '',
    isMarkdown,
    encoding: 'auto',
  };
}

function isMarkdownName(name: string) {
  return /\.(?:md|markdown)$/i.test(name);
}

function isDirty() {
  return documentState.content !== documentState.savedContent;
}

function setCurrentDocument(next: TextDocument) {
  documentState = next;
  activeDocumentId = next.id;
  documents = documents.map((document) => document.id === next.id ? next : document);
}

function historyFor(document: TextDocument) {
  const existing = histories.get(document.id);
  if (existing) return existing;
  const created = { entries: [document.content], index: 0 };
  histories.set(document.id, created);
  return created;
}

function activateDocument(id: string) {
  const next = documents.find((document) => document.id === id);
  if (!next || id === activeDocumentId) return;
  documentState = next;
  activeDocumentId = next.id;
  editor.value = next.content;
  secondaryEditor.value = next.content;
  const cursor = Math.min(next.cursor || 0, next.content.length);
  editor.setSelectionRange(cursor, cursor);
  secondaryEditor.setSelectionRange(cursor, cursor);
  viewMode = next.isMarkdown ? 'split' : 'edit';
  render();
  window.requestAnimationFrame(() => {
    editor.setSelectionRange(cursor, cursor);
    secondaryEditor.setSelectionRange(cursor, cursor);
  });
}

function addDocument(next: TextDocument) {
  documents = [...documents, next];
  histories.set(next.id, { entries: [next.content], index: 0 });
  documentState = next;
  activeDocumentId = next.id;
  editor.value = next.content;
  secondaryEditor.value = next.content;
  viewMode = next.isMarkdown ? 'split' : 'edit';
  render();
  window.requestAnimationFrame(() => editor.focus());
}

function createDocument(isMarkdown = false) {
  addDocument(blankDocument(isMarkdown));
  showToast(isMarkdown ? 'Created a new Markdown tab.' : 'Created a new text tab.');
}

function showToast(message: string, tone: 'info' | 'error' | 'success' = 'info') {
  if (toastTimer) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast ${tone}`;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3000);
}

function updateRecent(file: Pick<OpenedTextFile, 'name' | 'path' | 'isMarkdown'>) {
  const next = [{ ...file, openedAt: Date.now() }, ...readRecents().filter((entry) => entry.path !== file.path)].slice(0, MAX_RECENTS);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  renderRecents();
}

function readRecents(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentEntry => Boolean(
      entry && typeof entry === 'object'
      && typeof (entry as RecentEntry).name === 'string'
      && typeof (entry as RecentEntry).path === 'string'
      && typeof (entry as RecentEntry).isMarkdown === 'boolean'
      && typeof (entry as RecentEntry).openedAt === 'number',
    )).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function readFolderBookmarks(): FolderBookmark[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FOLDER_BOOKMARKS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((entry): entry is FolderBookmark => Boolean(
      entry && typeof entry === 'object'
      && typeof (entry as FolderBookmark).name === 'string'
      && typeof (entry as FolderBookmark).path === 'string'
      && (entry as FolderBookmark).name.trim()
      && (entry as FolderBookmark).path.trim()
      && !seen.has((entry as FolderBookmark).path)
      && seen.add((entry as FolderBookmark).path),
    )).slice(0, MAX_FOLDER_BOOKMARKS);
  } catch {
    return [];
  }
}

function saveFolderBookmarks(bookmarks: FolderBookmark[]) {
  localStorage.setItem(FOLDER_BOOKMARKS_KEY, JSON.stringify(bookmarks.slice(0, MAX_FOLDER_BOOKMARKS)));
}

function isBookmarked(path?: string) {
  return Boolean(path && readFolderBookmarks().some((bookmark) => bookmark.path === path));
}

function renderBookmarks() {
  const bookmarks = readFolderBookmarks();
  folderBookmarks.replaceChildren();
  folderBookmarks.hidden = bookmarks.length === 0;
  const marked = isBookmarked(projectFolder?.path);
  folderBookmarkToggle.classList.toggle('bookmarked', marked);
  folderBookmarkToggle.disabled = !projectFolder;
  folderBookmarkToggle.title = marked ? 'Remove this folder bookmark' : 'Bookmark this folder';
  folderBookmarkToggle.setAttribute('aria-label', marked ? 'Remove this folder bookmark' : 'Bookmark this folder');
  if (!bookmarks.length) return;

  const heading = document.createElement('span');
  heading.className = 'folder-bookmarks-title';
  heading.textContent = 'BOOKMARKS';
  folderBookmarks.append(heading);
  const list = document.createElement('div');
  list.className = 'folder-bookmark-list';
  for (const bookmark of bookmarks) {
    const row = document.createElement('div');
    row.className = 'folder-bookmark';
    const open = document.createElement('button');
    open.className = 'folder-bookmark-open';
    open.textContent = bookmark.name;
    open.title = `Browse ${bookmark.path}`;
    open.addEventListener('click', () => void browseFolder(bookmark.path));
    const remove = document.createElement('button');
    remove.className = 'folder-bookmark-remove';
    remove.textContent = '×';
    remove.title = `Remove ${bookmark.name} bookmark`;
    remove.setAttribute('aria-label', `Remove ${bookmark.name} bookmark`);
    remove.addEventListener('click', () => {
      saveFolderBookmarks(readFolderBookmarks().filter((entry) => entry.path !== bookmark.path));
      renderBookmarks();
      showToast(`Removed ${bookmark.name} bookmark.`);
    });
    row.append(open, remove);
    list.append(row);
  }
  folderBookmarks.append(list);
}

function toggleFolderBookmark() {
  if (!projectFolder) {
    showToast('Choose a folder before bookmarking it.', 'error');
    return;
  }
  const bookmarks = readFolderBookmarks();
  const existing = bookmarks.find((bookmark) => bookmark.path === projectFolder!.path);
  if (existing) {
    saveFolderBookmarks(bookmarks.filter((bookmark) => bookmark.path !== projectFolder!.path));
    showToast(`Removed ${existing.name} bookmark.`);
  } else {
    saveFolderBookmarks([{ name: projectFolder.name, path: projectFolder.path }, ...bookmarks]);
    showToast(`Bookmarked ${projectFolder.name}.`, 'success');
  }
  renderBookmarks();
}

function readEditorAppearance() {
  const fallback = { fontFamily: DEFAULT_EDITOR_FONT, fontSize: DEFAULT_EDITOR_FONT_SIZE };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EDITOR_APPEARANCE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return fallback;
    const candidate = parsed as { fontFamily?: unknown; fontSize?: unknown };
    const fontFamily = typeof candidate.fontFamily === 'string' && EDITOR_FONTS.some(([value]) => value === candidate.fontFamily)
      ? candidate.fontFamily
      : fallback.fontFamily;
    const fontSize = typeof candidate.fontSize === 'number' && EDITOR_FONT_SIZES.includes(candidate.fontSize as typeof EDITOR_FONT_SIZES[number])
      ? candidate.fontSize
      : fallback.fontSize;
    return { fontFamily, fontSize };
  } catch {
    return fallback;
  }
}

let editorAppearance = readEditorAppearance();

function applyEditorAppearance() {
  shell.style.setProperty('--editor-font-family', editorAppearance.fontFamily);
  shell.style.setProperty('--editor-font-size', `${editorAppearance.fontSize}px`);
  editorFontSelect.value = editorAppearance.fontFamily;
  editorFontSizeSelect.value = String(editorAppearance.fontSize);
}

function saveEditorAppearance() {
  localStorage.setItem(EDITOR_APPEARANCE_KEY, JSON.stringify(editorAppearance));
  applyEditorAppearance();
}

function readEditorOptions(): EditorOptions {
  const fallback: EditorOptions = { wordWrap: true, indentation: 'spaces', tabSize: 2, lineEnding: 'lf', spellLanguage: 'en' };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EDITOR_OPTIONS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return fallback;
    const value = parsed as Partial<EditorOptions>;
    return {
      wordWrap: typeof value.wordWrap === 'boolean' ? value.wordWrap : fallback.wordWrap,
      indentation: value.indentation === 'tabs' ? 'tabs' : 'spaces',
      tabSize: value.tabSize === 4 || value.tabSize === 8 ? value.tabSize : 2,
      lineEnding: value.lineEnding === 'crlf' ? 'crlf' : 'lf',
      spellLanguage: ['en', 'tr', 'de', 'fr', 'es', 'it', 'none'].includes(value.spellLanguage || '') ? value.spellLanguage! : fallback.spellLanguage,
    };
  } catch {
    return fallback;
  }
}

let editorOptions = readEditorOptions();

function applyEditorOptions() {
  for (const surface of [editor, secondaryEditor]) {
    surface.wrap = editorOptions.wordWrap ? 'soft' : 'off';
    surface.spellcheck = editorOptions.spellLanguage !== 'none';
    surface.lang = editorOptions.spellLanguage === 'none' ? '' : editorOptions.spellLanguage;
    surface.style.tabSize = String(editorOptions.tabSize);
  }
  shell.classList.toggle('no-word-wrap', !editorOptions.wordWrap);
  editorWrapSelect.value = editorOptions.wordWrap ? 'on' : 'off';
  editorIndentSelect.value = editorOptions.indentation;
  editorTabSizeSelect.value = String(editorOptions.tabSize);
  editorLineEndingSelect.value = editorOptions.lineEnding;
  editorSpellLanguageSelect.value = editorOptions.spellLanguage;
}

function saveEditorOptions() {
  localStorage.setItem(EDITOR_OPTIONS_KEY, JSON.stringify(editorOptions));
  applyEditorOptions();
}

function normaliseLineEndings(content: string) {
  return content.replace(/\r\n?/g, '\n');
}

function contentForSave(content: string) {
  const normalised = normaliseLineEndings(content);
  return editorOptions.lineEnding === 'crlf' ? normalised.replace(/\n/g, '\r\n') : normalised;
}

function readSession(): RestoredSession | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const session = parsed as Partial<RestoredSession>;
    if (!Array.isArray(session.documents) || !session.documents.length) return null;
    const documents = session.documents.filter((document): document is SessionDocument => Boolean(
      document && typeof document === 'object'
      && typeof document.name === 'string'
      && typeof document.content === 'string'
      && typeof document.savedContent === 'string'
      && typeof document.isMarkdown === 'boolean'
      && typeof document.encoding === 'string',
    ));
    return documents.length ? { documents, activeIndex: Math.max(0, Math.min(Number(session.activeIndex) || 0, documents.length - 1)), savedAt: Number(session.savedAt) || 0 } : null;
  } catch {
    return null;
  }
}

function persistRecovery() {
  const session: RestoredSession = {
    documents: documents.map(({ id, ...document }) => ({ ...document, cursor: id === activeDocumentId ? editor.selectionStart : document.cursor })),
    activeIndex: Math.max(0, documents.findIndex((document) => document.id === activeDocumentId)),
    savedAt: Date.now(),
  };
  try {
    const serialized = JSON.stringify(session);
    if (serialized.length > MAX_RECOVERY_BYTES) return;
    localStorage.setItem(SESSION_KEY, serialized);
    const drafts = session.documents.filter((document) => document.content !== document.savedContent);
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ drafts, savedAt: session.savedAt }));
  } catch {
    // Recovery is best-effort and should never interrupt writing.
  }
}

async function autosaveOpenDocuments() {
  if (autosaveInFlight) return;
  const pending = documents.filter((document) => document.path && document.content !== document.savedContent);
  if (!pending.length) return;
  autosaveInFlight = true;
  let savedCurrent = false;
  try {
    for (const target of pending) {
      const snapshot = target.content;
      const result = await invoke<SavedTextFile>('write_file', { path: target.path, content: contentForSave(snapshot), encoding: target.encoding });
      const latest = documents.find((document) => document.id === target.id);
      if (!latest || latest.content !== snapshot) continue;
      const saved = { ...latest, ...result, savedContent: snapshot, isMarkdown: isMarkdownName(result.name) };
      documents = documents.map((document) => document.id === saved.id ? saved : document);
      if (activeDocumentId === saved.id) {
        documentState = saved;
        savedCurrent = true;
      }
      await captureFingerprint(result.path);
    }
  } catch (error) {
    showToast(`Autosave paused: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    autosaveInFlight = false;
  }
  if (savedCurrent) {
    render();
    required<HTMLElement>('.editor-status').textContent = 'Autosaved';
  }
}

function scheduleRecovery() {
  if (recoveryTimer) window.clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => {
    persistRecovery();
    recoveryTimer = undefined;
    void autosaveOpenDocuments();
    if (isDirty()) required<HTMLElement>('.editor-status').textContent = documentState.path ? 'Autosaving…' : 'Recovery saved';
  }, 700);
}

function restoreSession() {
  const session = readSession();
  if (!session) return;
  const restored = session.documents.map((document) => ({
    ...document,
    id: `document-${nextDocumentId++}`,
    content: normaliseLineEndings(document.content),
    savedContent: normaliseLineEndings(document.savedContent),
  }));
  if (!restored.length) return;
  histories.clear();
  documents = restored;
  for (const document of documents) histories.set(document.id, { entries: [document.content], index: 0 });
  const active = documents[Math.min(session.activeIndex, documents.length - 1)];
  documentState = active;
  activeDocumentId = active.id;
  editor.value = active.content;
  secondaryEditor.value = active.content;
  const cursor = Math.min(active.cursor || 0, active.content.length);
  editor.setSelectionRange(cursor, cursor);
  secondaryEditor.setSelectionRange(cursor, cursor);
  viewMode = active.isMarkdown ? 'split' : 'edit';
  if (session.savedAt) showToast('Restored your previous workspace and recovery drafts.', 'success');
}

function storedProjectPath() {
  const path = localStorage.getItem(PROJECT_FOLDER_KEY);
  return path && path.trim() ? path : null;
}

function renderProjectTree() {
  projectTree.replaceChildren();
  renderBookmarks();
  if (!projectFolder) {
    projectTree.append(makeEmpty('Loading your Documents folder…'));
    return;
  }
  const root = document.createElement('div');
  root.className = 'project-root';
  const name = document.createElement('strong');
  const path = document.createElement('small');
  name.textContent = projectFolder.name;
  path.textContent = projectFolder.path;
  root.title = projectFolder.path;
  root.append(name, path);
  projectTree.append(root);
  if (!projectFolder.entries.length) {
    projectTree.append(makeEmpty('This folder has no visible folders or files.'));
  } else {
    const entries = document.createElement('div');
    entries.className = 'folder-entries';
    const filter = folderFilterValue.trim().toLocaleLowerCase();
    const visible = filter ? projectFolder.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter)) : projectFolder.entries;
    if (!visible.length) {
      projectTree.append(makeEmpty(`No items match “${folderFilterValue}”.`));
    } else {
      for (const entry of visible) entries.append(makeFolderEntry(entry));
      projectTree.append(entries);
    }
  }
  if (projectFolder.truncated) {
    const notice = makeEmpty('The folder view is limited to the first 8,000 items.');
    notice.classList.add('folder-truncated');
    projectTree.append(notice);
  }
}

function makeFolderEntry(entry: FolderEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'folder-entry';
  const button = document.createElement('button');
  if (entry.kind === 'file') {
    button.className = 'folder-file';
    button.textContent = entry.name;
    button.title = entry.path;
    button.addEventListener('click', () => void openProjectFile(entry.path));
  } else {
    button.className = 'folder-directory';
    button.textContent = entry.name;
    button.title = `Browse ${entry.path}`;
    button.addEventListener('click', () => void browseFolder(entry.path));
  }
  const rename = document.createElement('button');
  rename.className = 'folder-entry-control';
  rename.textContent = '✎';
  rename.title = `Rename ${entry.name}`;
  rename.setAttribute('aria-label', `Rename ${entry.name}`);
  rename.addEventListener('click', (event) => { event.stopPropagation(); void renameBrowserEntry(entry); });
  const trash = document.createElement('button');
  trash.className = 'folder-entry-control trash';
  trash.textContent = '⌫';
  trash.title = `Move ${entry.name} to Trash`;
  trash.setAttribute('aria-label', `Move ${entry.name} to Trash`);
  trash.addEventListener('click', (event) => { event.stopPropagation(); void trashBrowserEntry(entry); });
  row.append(button, rename, trash);
  return row;
}

async function createBrowserEntry() {
  if (!projectFolder) return;
  const name = window.prompt('New item name. Use any extension for a text file; end with / for a folder.', 'untitled.txt');
  if (!name?.trim()) return;
  const trimmed = name.trim();
  const kind = trimmed.endsWith('/') ? 'directory' : 'file';
  const entryName = kind === 'directory' ? trimmed.slice(0, -1) : trimmed;
  try {
    const created = await invoke<FolderEntry>('create_browser_entry', { parentPath: projectFolder.path, name: entryName, kind });
    await refreshProjectFolder(true);
    if (created.kind === 'file') await openProjectFile(created.path);
    showToast(`Created ${created.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function renameBrowserEntry(entry: FolderEntry) {
  const name = window.prompt(`Rename ${entry.name} to:`, entry.name);
  if (!name?.trim() || name.trim() === entry.name) return;
  try {
    const path = await invoke<string>('rename_browser_entry', { path: entry.path, name: name.trim() });
    documents = documents.map((document) => document.path === entry.path ? { ...document, path, name: name.trim(), isMarkdown: isMarkdownName(name.trim()) } : document);
    if (documentState.path === entry.path) documentState = documents.find((document) => document.id === activeDocumentId) || documentState;
    await refreshProjectFolder(true);
    render();
    showToast(`Renamed to ${name.trim()}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function trashBrowserEntry(entry: FolderEntry) {
  if (!window.confirm(`Move “${entry.name}” to Trash?`)) return;
  try {
    await invoke('move_browser_entry_to_trash', { path: entry.path });
    await refreshProjectFolder(true);
    showToast(`Moved ${entry.name} to Trash.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function selectProjectFolder() {
  try {
    const result = await invoke<ProjectFolder | null>('open_folder');
    if (!result) return;
    projectFolder = result;
    localStorage.setItem(PROJECT_FOLDER_KEY, result.path);
    renderProjectTree();
    showToast(`Opened ${result.name} as a project folder.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function browseFolder(path?: string, quiet = false) {
  try {
    const result = await invoke<ProjectFolder>('browse_folder', { path: path || null, showHidden: showHiddenFiles });
    projectFolder = result;
    localStorage.setItem(PROJECT_FOLDER_KEY, result.path);
    renderProjectTree();
    if (!quiet) showToast(`Browsing ${result.name}.`, 'success');
  } catch (error) {
    if (!quiet) showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function refreshProjectFolder(quiet = false) {
  const path = projectFolder?.path || storedProjectPath();
  if (!path) { await browseFolder(undefined, quiet); return; }
  try {
    const result = await invoke<ProjectFolder>('refresh_folder', { path, showHidden: showHiddenFiles });
    projectFolder = result;
    localStorage.setItem(PROJECT_FOLDER_KEY, result.path);
    renderProjectTree();
    if (!quiet) showToast('Folder refreshed.', 'success');
  } catch (error) {
    localStorage.removeItem(PROJECT_FOLDER_KEY);
    await browseFolder(undefined, quiet);
    if (!quiet) showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

function browseUp() {
  if (projectFolder?.parentPath) void browseFolder(projectFolder.parentPath);
}

function browseHome() {
  if (projectFolder) void browseFolder(projectFolder.homePath);
}

function browseDocuments() {
  if (projectFolder) void browseFolder(projectFolder.documentsPath);
  else void browseFolder();
}

function commitDocument(next: TextDocument, resetHistory = true) {
  setCurrentDocument(next);
  editor.value = next.content;
  secondaryEditor.value = next.content;
  if (resetHistory) {
    histories.set(next.id, { entries: [next.content], index: 0 });
  }
  editor.setSelectionRange(0, 0);
  render();
}

function recordContent(content: string) {
  if (content === documentState.content) return;
  setCurrentDocument({ ...documentState, content });
  if (editor.value !== content) editor.value = content;
  if (secondaryEditor.value !== content) secondaryEditor.value = content;
  const history = historyFor(documentState);
  history.entries = history.entries.slice(0, history.index + 1);
  history.entries.push(content);
  if (history.entries.length > 2500) history.entries.shift(); else history.index += 1;
  if (history.entries.length === 2500) history.index = history.entries.length - 1;
  render();
  scheduleRecovery();
}

function restoreHistory(nextIndex: number) {
  const history = historyFor(documentState);
  if (nextIndex < 0 || nextIndex >= history.entries.length || nextIndex === history.index) return;
  history.index = nextIndex;
  setCurrentDocument({ ...documentState, content: history.entries[history.index] });
  editor.value = documentState.content;
  secondaryEditor.value = documentState.content;
  render();
  editor.focus();
  scheduleRecovery();
}

function undo() { restoreHistory(historyFor(documentState).index - 1); }
function redo() { restoreHistory(historyFor(documentState).index + 1); }

function render() {
  if (!documentState.isMarkdown && viewMode !== 'edit') viewMode = 'edit';
  shell.dataset.mode = viewMode;
  shell.classList.toggle('text-document', !documentState.isMarkdown);
  shell.classList.toggle('editor-split', editorSplit);
  shell.classList.toggle('zen-mode', zenMode);
  if (editor.value !== documentState.content) editor.value = documentState.content;
  if (secondaryEditor.value !== documentState.content) secondaryEditor.value = documentState.content;
  document.title = `${isDirty() ? '• ' : ''}${documentState.name} — 7TXT`;
  required<HTMLElement>('.document-title strong').textContent = documentState.name;
  required<HTMLElement>('.document-title small').textContent = documentState.path || 'Unsaved document';
  required<HTMLElement>('.dirty-dot').classList.toggle('visible', isDirty());
  required<HTMLElement>('.format-chip').textContent = documentState.isMarkdown ? 'MD' : 'TXT';
  required<HTMLElement>('.format-chip').classList.toggle('markdown', documentState.isMarkdown);
  required<HTMLElement>('.editor-mode-label').textContent = documentState.isMarkdown ? 'Markdown' : 'Plain text';
  required<HTMLElement>('.editor-status').textContent = isDirty() ? 'Unsaved changes' : documentState.path ? 'Saved locally' : 'Ready';
  required<HTMLElement>('.status-file').textContent = documentState.path || documentState.name;
  required<HTMLElement>('.status-stats').textContent = documentStats(documentState.content);
  required<HTMLElement>('.preview-kind').textContent = documentState.isMarkdown ? 'MARKDOWN' : 'TEXT';
  encodingSelect.value = documentState.encoding;
  reopenEncodingButton.disabled = !documentState.path;
  for (const action of app!.querySelectorAll<HTMLElement>('.markdown-actions')) action.hidden = !documentState.isMarkdown;
  externalChangeBar.hidden = !externalChange;
  required<HTMLElement>('.external-change span').textContent = externalChange ? `${externalChange.name} changed on disk.` : '';
  required<HTMLElement>('.status-help').textContent = documentState.isMarkdown ? '⌘1 Edit · ⌘2 Split · ⌘3 Preview' : '⌘O Open · ⌘S Save · ⌘F Find';
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-mode-button]')) {
    button.classList.toggle('selected', button.dataset.modeButton === viewMode);
  }
  preview.innerHTML = documentState.isMarkdown ? renderMarkdown(documentState.content) : `<pre>${escapeHtml(documentState.content || 'Start writing…')}</pre>`;
  renderTabs();
  renderOutline();
  renderRecents();
  updateCursor();
  scheduleRecovery();
}

function documentStats(content: string) {
  const lines = content ? content.split('\n').length : 1;
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const minutes = Math.max(1, Math.ceil(words / 220));
  return `${words} word${words === 1 ? '' : 's'} · ${content.length} char${content.length === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'} · ${minutes} min read`;
}

function renderOutline() {
  outlineList.replaceChildren();
  if (!documentState.isMarkdown) {
    outlineList.append(makeEmpty('Outline is available for Markdown documents.'));
    return;
  }
  const headings = documentState.content.split('\n').map((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return match ? { level: match[1].length, label: match[2], line: index + 1 } : null;
  }).filter((item): item is { level: number; label: string; line: number } => Boolean(item));
  if (!headings.length) {
    outlineList.append(makeEmpty('Add headings to navigate this note.'));
    return;
  }
  for (const heading of headings) {
    const button = document.createElement('button');
    button.textContent = heading.label;
    button.style.setProperty('--heading-level', String(heading.level));
    button.title = `Go to line ${heading.line}`;
    button.addEventListener('click', () => goToLine(heading.line));
    outlineList.append(button);
  }
}

function makeEmpty(message: string) {
  const element = document.createElement('p');
  element.className = 'empty-list';
  element.textContent = message;
  return element;
}

function renderRecents() {
  recentsList.replaceChildren();
  const entries = readRecents();
  if (!entries.length) {
    recentsList.append(makeEmpty('Opened text and Markdown files will appear here.'));
    return;
  }
  for (const entry of entries) {
    const button = document.createElement('button');
    const name = document.createElement('strong');
    const path = document.createElement('small');
    name.textContent = entry.name;
    path.textContent = entry.path;
    button.append(name, path);
    button.title = `Open ${entry.path}`;
    button.addEventListener('click', () => void openRecent(entry));
    recentsList.append(button);
  }
}

function renderTabs() {
  tabList.replaceChildren();
  for (const document of documents) {
    const tab = window.document.createElement('div');
    const activate = window.document.createElement('button');
    const close = window.document.createElement('button');
    tab.className = `document-tab${document.id === activeDocumentId ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(document.id === activeDocumentId));
    activate.className = 'tab-activate';
    activate.type = 'button';
    activate.textContent = document.name;
    activate.title = document.path || document.name;
    activate.addEventListener('click', () => activateDocument(document.id));
    close.className = 'tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = `Close ${document.name}`;
    close.setAttribute('aria-label', `Close ${document.name}`);
    close.addEventListener('click', () => closeDocument(document.id));
    tab.append(activate, close);
    tabList.append(tab);
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderInline(value: string) {
  let output = escapeHtml(value);
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  output = output.replace(/_([^_]+)_/g, '<em>$1</em>');
  return output;
}

function renderListItem(value: string) {
  const task = /^\[([ xX])\]\s+(.+)$/.exec(value);
  if (!task) return renderInline(value);
  return `<label class="markdown-task"><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''} />${renderInline(task[2])}</label>`;
}

function renderMarkdown(source: string) {
  const lines = source.split('\n');
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      output.push(`<pre><code${language ? ` data-language="${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { output.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) { output.push('<hr />'); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^>\s?/, '')); index += 1; }
      output.push(`<blockquote>${renderInline(quote.join(' '))}</blockquote>`);
      continue;
    }
    if (/^(?:[-*+]\s+|\d+\.\s+)/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const items: string[] = [];
      const expression = ordered ? /^\d+\.\s+(.+)$/ : /^(?:[-*+]\s+)(.+)$/;
      while (index < lines.length) {
        const match = expression.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${renderListItem(match[1])}</li>`);
        index += 1;
      }
      output.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s+|```|>\s?|(?:[-*+]\s+|\d+\.\s+))/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }
  return output.join('') || '<p class="preview-empty">Start writing Markdown to see a clean reading preview.</p>';
}

function updateCursor() {
  const source = activeEditor();
  const before = source.value.slice(0, source.selectionStart);
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  if (documentState.cursor !== source.selectionStart) {
    documentState = { ...documentState, cursor: source.selectionStart };
    documents = documents.map((document) => document.id === activeDocumentId ? documentState : document);
  }
  required<HTMLElement>('.status-cursor').textContent = `Ln ${line}, Col ${column}`;
}

function goToLine(line: number) {
  const lines = editor.value.split('\n');
  const start = lines.slice(0, Math.max(0, line - 1)).reduce((offset, current) => offset + current.length + 1, 0);
  const end = start + (lines[line - 1]?.length || 0);
  setViewMode('edit');
  editor.focus();
  editor.setSelectionRange(start, end);
  secondaryEditor.setSelectionRange(start, end);
  editor.scrollTop = Math.max(0, (line - 3) * 23);
  updateCursor();
}

function setViewMode(next: ViewMode) {
  viewMode = documentState.isMarkdown ? next : 'edit';
  render();
}

async function openFile() {
  try {
    const result = await invoke<OpenedTextFile | null>('open_file', { encoding: documentState.encoding });
    if (!result) return;
    openResultInTab(result);
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function openRecent(entry: RecentEntry) {
  try {
    const result = await invoke<OpenedTextFile>('open_recent', { path: entry.path, encoding: documentState.encoding });
    openResultInTab(result);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
    const remaining = readRecents().filter((item) => item.path !== entry.path);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(remaining));
    renderRecents();
  }
}

async function openProjectFile(path: string) {
  try {
    const result = await invoke<OpenedTextFile>('open_recent', { path, encoding: documentState.encoding });
    openResultInTab(result);
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function revealFileFolder(path: string, quiet = true) {
  try {
    const result = await invoke<ProjectFolder>('reveal_file_folder', { path, showHidden: showHiddenFiles });
    projectFolder = result;
    localStorage.setItem(PROJECT_FOLDER_KEY, result.path);
    renderProjectTree();
    if (!quiet) showToast(`Revealed ${result.name}.`, 'success');
  } catch (error) {
    if (!quiet) showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function openExternalFile(path: string) {
  try {
    const result = await invoke<OpenedTextFile>('open_recent', { path, encoding: documentState.encoding });
    openResultInTab(result, true);
    await revealFileFolder(result.path);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

const queuedExternalPaths = new Set<string>();
let externalOpenQueue = Promise.resolve();

function enqueueExternalFiles(paths: string[]) {
  const accepted = paths.filter((path) => {
    const normalized = path.trim();
    if (!normalized || queuedExternalPaths.has(normalized)) return false;
    queuedExternalPaths.add(normalized);
    return true;
  });
  if (!accepted.length) return;
  externalOpenQueue = externalOpenQueue.then(async () => {
    for (const path of accepted) {
      try { await openExternalFile(path); } finally { queuedExternalPaths.delete(path.trim()); }
    }
  });
}

function openResultInTab(result: OpenedTextFile, replacePristineBlank = false) {
  const normalised = { ...result, content: normaliseLineEndings(result.content) };
  updateRecent(normalised);
  const alreadyOpen = documents.find((document) => document.path === normalised.path);
  if (alreadyOpen) {
    activateDocument(alreadyOpen.id);
    showToast(`${normalised.name} is already open.`, 'info');
    return;
  }
  const next = { id: `document-${nextDocumentId++}`, ...normalised, savedContent: normalised.content };
  const onlyPristineBlank = documents.length === 1
    && !documents[0].path
    && documents[0].content === ''
    && documents[0].savedContent === '';
  if (replacePristineBlank && onlyPristineBlank) {
    histories.delete(documents[0].id);
    documents = [next];
    histories.set(next.id, { entries: [next.content], index: 0 });
    documentState = next;
    activeDocumentId = next.id;
    editor.value = next.content;
    viewMode = next.isMarkdown ? 'split' : 'edit';
    render();
    window.requestAnimationFrame(() => editor.focus());
    void captureFingerprint(normalised.path);
    showToast(`Opened ${normalised.name}.`, 'success');
    return;
  }
  addDocument(next);
  void captureFingerprint(normalised.path);
  showToast(`Opened ${normalised.name} in a new tab.`, 'success');
}

async function saveAs() {
  try {
    const result = await invoke<SavedTextFile | null>('save_as', { suggestedName: documentState.name, content: contentForSave(documentState.content), encoding: documentState.encoding });
    if (!result) return;
    setCurrentDocument({ ...documentState, ...result, savedContent: documentState.content, isMarkdown: isMarkdownName(result.name) });
    updateRecent({ ...result, isMarkdown: documentState.isMarkdown });
    if (externalChange?.path === result.path) externalChange = null;
    render();
    await captureFingerprint(result.path);
    showToast(`Saved ${result.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function save() {
  if (!documentState.path) { await saveAs(); return; }
  try {
    const result = await invoke<SavedTextFile>('write_file', { path: documentState.path, content: contentForSave(documentState.content), encoding: documentState.encoding });
    setCurrentDocument({ ...documentState, ...result, savedContent: documentState.content, isMarkdown: isMarkdownName(result.name) });
    updateRecent({ ...result, isMarkdown: documentState.isMarkdown });
    if (externalChange?.path === result.path) externalChange = null;
    render();
    await captureFingerprint(result.path);
    showToast('Saved locally.', 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

function closeDocument(id = activeDocumentId) {
  const target = documents.find((document) => document.id === id);
  if (!target) return;
  if (target.content !== target.savedContent && !window.confirm(`Close “${target.name}” without saving its changes?`)) return;
  const index = documents.findIndex((document) => document.id === id);
  histories.delete(id);
  if (documents.length === 1) {
    const blank = blankDocument();
    documents = [blank];
    documentState = blank;
    activeDocumentId = blank.id;
    histories.set(blank.id, { entries: [''], index: 0 });
    editor.value = blank.content;
    secondaryEditor.value = blank.content;
    viewMode = 'edit';
  } else {
    documents = documents.filter((document) => document.id !== id);
    if (id === activeDocumentId) {
      const next = documents[Math.min(index, documents.length - 1)];
      documentState = next;
      activeDocumentId = next.id;
      editor.value = next.content;
      secondaryEditor.value = next.content;
      viewMode = next.isMarkdown ? 'split' : 'edit';
    }
  }
  render();
  scheduleRecovery();
  showToast('Tab closed.');
}

function reopenWithEncoding() {
  const target = documentState;
  if (!target.path) return;
  if (target.content !== target.savedContent && !window.confirm(`Reload “${target.name}” from disk and discard its unsaved changes?`)) return;
  void (async () => {
    try {
      const result = await invoke<OpenedTextFile>('open_recent', { path: target.path, encoding: target.encoding });
      const content = normaliseLineEndings(result.content);
      const reopened = { ...target, ...result, content, savedContent: content };
      if (documentState.id === target.id) commitDocument(reopened);
      else {
        documents = documents.map((document) => document.id === target.id ? reopened : document);
        histories.set(target.id, { entries: [reopened.content], index: 0 });
      }
      updateRecent(result);
      await captureFingerprint(result.path);
      showToast(`Reloaded ${result.name} using ${encodingSelect.options[encodingSelect.selectedIndex].text}.`, 'success');
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
  })();
}

function openFind() {
  findbar.hidden = false;
  shell.classList.add('find-open');
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findbar.hidden = true;
  shell.classList.remove('find-open');
  editor.focus();
}

function searchExpression(global = true): RegExp | null {
  const query = findInput.value;
  if (!query) return null;
  const source = findRegex.checked ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, `${global ? 'g' : ''}${findCase.checked ? '' : 'i'}`);
  } catch {
    showToast('That regular expression is invalid.', 'error');
    return null;
  }
}

function nextMatch(start = editor.selectionEnd) {
  const expression = searchExpression();
  if (!expression) return null;
  expression.lastIndex = start;
  let match = expression.exec(documentState.content);
  if (!match && start > 0) {
    expression.lastIndex = 0;
    match = expression.exec(documentState.content);
  }
  if (!match || !match[0].length) return null;
  return { index: match.index, text: match[0] };
}

function selectMatch(match: { index: number; text: string }) {
  editor.focus();
  editor.setSelectionRange(match.index, match.index + match.text.length);
  secondaryEditor.setSelectionRange(match.index, match.index + match.text.length);
  editor.scrollTop = Math.max(0, documentState.content.slice(0, match.index).split('\n').length * 23 - 92);
  updateCursor();
}

function findNext() {
  const match = nextMatch();
  if (!match) { showToast(`“${findInput.value}” was not found.`); return; }
  selectMatch(match);
}

function selectionMatchesQuery() {
  const selected = documentState.content.slice(editor.selectionStart, editor.selectionEnd);
  if (!selected) return false;
  const expression = searchExpression(false);
  return Boolean(expression && new RegExp(`^(?:${expression.source})$`, expression.flags.replace('g', '')).test(selected));
}

function replaceOne() {
  if (!findInput.value) return;
  if (!selectionMatchesQuery()) {
    const match = nextMatch();
    if (!match) { showToast(`“${findInput.value}” was not found.`); return; }
    selectMatch(match);
  }
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const next = `${documentState.content.slice(0, start)}${replaceInput.value}${documentState.content.slice(end)}`;
  recordContent(next);
  editor.setSelectionRange(start, start + replaceInput.value.length);
  secondaryEditor.setSelectionRange(start, start + replaceInput.value.length);
  showToast('Replaced one occurrence.', 'success');
}

function replaceAll() {
  const expression = searchExpression();
  if (!expression) return;
  let count = 0;
  const next = documentState.content.replace(expression, () => { count += 1; return replaceInput.value; });
  if (!count) { showToast(`“${findInput.value}” was not found.`); return; }
  recordContent(next);
  showToast(`Replaced ${count} occurrence${count === 1 ? '' : 's'}.`, 'success');
}

function activeEditor() {
  return document.activeElement === secondaryEditor ? secondaryEditor : editor;
}

function insertAtSelection(value: string) {
  const target = activeEditor();
  const start = target.selectionStart;
  const end = target.selectionEnd;
  recordContent(`${documentState.content.slice(0, start)}${value}${documentState.content.slice(end)}`);
  const cursor = start + value.length;
  editor.setSelectionRange(cursor, cursor);
  secondaryEditor.setSelectionRange(cursor, cursor);
  target.focus();
}

function insertMarkdownTable() {
  if (!documentState.isMarkdown) { showToast('Markdown tools are available for Markdown documents.', 'error'); return; }
  insertAtSelection('| Column | Column |\n| --- | --- |\n| Value | Value |');
  showToast('Inserted a Markdown table.', 'success');
}

function toggleMarkdownTask() {
  if (!documentState.isMarkdown) { showToast('Markdown tools are available for Markdown documents.', 'error'); return; }
  const target = activeEditor();
  const before = documentState.content.slice(0, target.selectionStart);
  const selected = documentState.content.slice(target.selectionStart, target.selectionEnd) || documentState.content.slice(before.lastIndexOf('\n') + 1, documentState.content.indexOf('\n', target.selectionStart) === -1 ? documentState.content.length : documentState.content.indexOf('\n', target.selectionStart));
  const start = selected === documentState.content.slice(target.selectionStart, target.selectionEnd) ? target.selectionStart : before.lastIndexOf('\n') + 1;
  const updated = selected.split('\n').map((line) => {
    if (/^(\s*[-*+]\s+)\[ \]\s+/.test(line)) return line.replace(/^(\s*[-*+]\s+)\[ \]\s+/, '$1[x] ');
    if (/^(\s*[-*+]\s+)\[x\]\s+/i.test(line)) return line.replace(/^(\s*[-*+]\s+)\[x\]\s+/i, '$1[ ] ');
    return line.replace(/^(\s*)/, '$1- [ ] ');
  }).join('\n');
  recordContent(`${documentState.content.slice(0, start)}${updated}${documentState.content.slice(start + selected.length)}`);
  editor.setSelectionRange(start, start + updated.length);
  secondaryEditor.setSelectionRange(start, start + updated.length);
  showToast('Updated Markdown task list.', 'success');
}

function htmlExportDocument() {
  const title = escapeHtml(documentState.name.replace(/\.(md|markdown)$/i, '') || '7TXT document');
  const body = documentState.isMarkdown ? renderMarkdown(documentState.content) : `<pre>${escapeHtml(documentState.content)}</pre>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{max-width:48rem;margin:3rem auto;padding:0 1.5rem;color:#243047;font:17px/1.65 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}pre{overflow:auto;padding:1rem;border-radius:.5rem;background:#f2f5fa;white-space:pre-wrap}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}table{border-collapse:collapse}th,td{padding:.45rem .7rem;border:1px solid #d7dfec}blockquote{margin:1rem 0;padding:.2rem 1rem;border-left:3px solid #0e8989;color:#5f6d83}</style></head><body>${body}</body></html>`;
}

async function exportHtml() {
  const base = documentState.name.replace(/\.(txt|md|markdown)$/i, '') || 'document';
  try {
    const result = await invoke<{ name: string; path: string } | null>('export_document', { suggestedName: base, content: htmlExportDocument(), extension: 'html' });
    if (result) showToast(`Exported ${result.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

function printDocument() {
  if (documentState.isMarkdown && viewMode !== 'preview') setViewMode('preview');
  window.setTimeout(() => window.print(), 80);
  showToast('Use the macOS print dialog for page setup or Save as PDF.');
}

function toggleEditorSplit() {
  editorSplit = !editorSplit;
  render();
  showToast(editorSplit ? 'Editor split into two synchronized panes.' : 'Editor split closed.');
}

function toggleZenMode() {
  zenMode = !zenMode;
  render();
  showToast(zenMode ? 'Zen mode on. Press Escape to leave.' : 'Zen mode off.');
}

function startSidebarResizing() {
  sidebarResizer.addEventListener('pointerdown', (event) => {
    if (!sidebarVisible || event.button !== 0) return;
    sidebarResizePointerId = event.pointerId;
    sidebarResizer.setPointerCapture(event.pointerId);
    workspace.classList.add('sidebar-resizing');
    event.preventDefault();
  });

  sidebarResizer.addEventListener('pointermove', (event) => {
    if (sidebarResizePointerId !== event.pointerId) return;
    const bounds = workspace.getBoundingClientRect();
    setSidebarWidth((event.clientX - bounds.left) / uiScaleFactor(), false);
  });

  const finishResize = (event: PointerEvent) => {
    if (sidebarResizePointerId !== event.pointerId) return;
    if (sidebarResizer.hasPointerCapture(event.pointerId)) sidebarResizer.releasePointerCapture(event.pointerId);
    sidebarResizePointerId = null;
    workspace.classList.remove('sidebar-resizing');
    setSidebarWidth(sidebarWidth);
  };
  sidebarResizer.addEventListener('pointerup', finishResize);
  sidebarResizer.addEventListener('pointercancel', finishResize);
  sidebarResizer.addEventListener('keydown', (event) => {
    let nextWidth: number | undefined;
    const step = event.shiftKey ? 30 : 10;
    if (event.key === 'ArrowLeft') nextWidth = sidebarWidth - step;
    else if (event.key === 'ArrowRight') nextWidth = sidebarWidth + step;
    else if (event.key === 'Home') nextWidth = MIN_SIDEBAR_WIDTH;
    else if (event.key === 'End') nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    setSidebarWidth(nextWidth);
  });
}

function goToLinePrompt() {
  const line = Number(window.prompt('Go to line:', String(editor.value.slice(0, editor.selectionStart).split('\n').length)));
  if (Number.isInteger(line) && line > 0) goToLine(line);
}

type PaletteCommand = { label: string; hint: string; run: () => void };

function paletteCommands(): PaletteCommand[] {
  return [
    { label: 'New text file', hint: '⌘N', run: () => createDocument() },
    { label: 'New Markdown file', hint: '⇧⌘N', run: () => createDocument(true) },
    { label: 'Open file', hint: '⌘O', run: () => void openFile() },
    { label: 'Save', hint: '⌘S', run: () => void save() },
    { label: 'Save As', hint: '⇧⌘S', run: () => void saveAs() },
    { label: 'Find and replace', hint: '⌘F', run: openFind },
    { label: 'Go to line', hint: '⌘L', run: goToLinePrompt },
    { label: 'Toggle Files sidebar', hint: '⇧⌘B', run: toggleSidebar },
    { label: 'Toggle editor split', hint: '', run: toggleEditorSplit },
    { label: 'Toggle Zen mode', hint: 'Esc', run: toggleZenMode },
    { label: 'Print / Save as PDF', hint: '⌘P', run: printDocument },
    { label: 'Export HTML', hint: '', run: () => void exportHtml() },
    { label: 'Insert Markdown table', hint: '', run: insertMarkdownTable },
    { label: 'Toggle Markdown task', hint: '', run: toggleMarkdownTask },
    { label: 'Toggle word wrap', hint: '', run: () => { editorOptions = { ...editorOptions, wordWrap: !editorOptions.wordWrap }; saveEditorOptions(); render(); } },
    { label: 'Refresh folder', hint: '', run: () => void refreshProjectFolder() },
  ];
}

function renderCommandPalette() {
  const query = commandPaletteInput.value.trim().toLocaleLowerCase();
  const commands = paletteCommands().filter((command) => command.label.toLocaleLowerCase().includes(query));
  commandSelection = Math.max(0, Math.min(commandSelection, Math.max(0, commands.length - 1)));
  commandList.replaceChildren();
  if (!commands.length) { commandList.append(makeEmpty('No matching commands.')); return; }
  commands.forEach((command, index) => {
    const button = document.createElement('button');
    button.className = index === commandSelection ? 'selected' : '';
    button.innerHTML = `<span>${escapeHtml(command.label)}</span><small>${escapeHtml(command.hint)}</small>`;
    button.addEventListener('click', () => { closeCommandPalette(); command.run(); });
    commandList.append(button);
  });
}

function openCommandPalette() {
  commandPalette.hidden = false;
  commandSelection = 0;
  commandPaletteInput.value = '';
  renderCommandPalette();
  window.requestAnimationFrame(() => commandPaletteInput.focus());
}

function closeCommandPalette() {
  commandPalette.hidden = true;
  editor.focus();
}

async function captureFingerprint(path: string) {
  try {
    const fingerprint = await invoke<FileFingerprint>('file_fingerprint', { path });
    fileFingerprints.set(path, fingerprint);
  } catch { /* A later watch pass will surface a missing file. */ }
}

function fingerprintsMatch(left: FileFingerprint, right: FileFingerprint) {
  return left.size === right.size && left.modifiedMillis === right.modifiedMillis;
}

async function watchFiles() {
  if (externalChange) return;
  for (const document of documents) {
    if (!document.path) continue;
    try {
      const current = await invoke<FileFingerprint>('file_fingerprint', { path: document.path });
      const previous = fileFingerprints.get(document.path);
      if (!previous) { fileFingerprints.set(document.path, current); continue; }
      if (!fingerprintsMatch(previous, current)) {
        externalChange = { path: document.path, name: document.name, fingerprint: current };
        render();
        return;
      }
    } catch {
      externalChange = { path: document.path, name: document.name };
      render();
      return;
    }
  }
}

async function reloadExternalChange() {
  if (!externalChange) return;
  const target = documents.find((document) => document.path === externalChange!.path);
  if (!target) { externalChange = null; render(); return; }
  if (target.content !== target.savedContent && !window.confirm(`Reload “${target.name}” and discard unsaved changes?`)) return;
  try {
    const result = await invoke<OpenedTextFile>('open_recent', { path: target.path, encoding: target.encoding });
    const reopened = { ...target, ...result, content: normaliseLineEndings(result.content), savedContent: normaliseLineEndings(result.content) };
    documents = documents.map((document) => document.id === target.id ? reopened : document);
    if (activeDocumentId === target.id) documentState = reopened;
    histories.set(target.id, { entries: [reopened.content], index: 0 });
    externalChange = null;
    await captureFingerprint(result.path);
    render();
    showToast(`Reloaded ${result.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function compareExternalChange() {
  if (!externalChange) return;
  const target = documents.find((document) => document.path === externalChange!.path);
  if (!target) return;
  try {
    const result = await invoke<OpenedTextFile>('open_recent', { path: target.path, encoding: target.encoding });
    addDocument({ id: `document-${nextDocumentId++}`, ...result, name: `${result.name} — disk`, path: undefined, content: normaliseLineEndings(result.content), savedContent: normaliseLineEndings(result.content) });
    externalChange = null;
    await captureFingerprint(result.path);
    showToast('Opened the on-disk copy in a comparison tab.', 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

function ignoreExternalChange() {
  if (externalChange?.fingerprint) fileFingerprints.set(externalChange.path, externalChange.fingerprint);
  externalChange = null;
  render();
}

function handleAction(action?: string) {
  switch (action) {
    case 'new':
    case 'new-text': createDocument(); break;
    case 'new-markdown': createDocument(true); break;
    case 'open': void openFile(); break;
    case 'open-folder': void selectProjectFolder(); break;
    case 'refresh-folder': void refreshProjectFolder(); break;
    case 'browser-up': browseUp(); break;
    case 'browser-home': browseHome(); break;
    case 'browser-documents': browseDocuments(); break;
    case 'new-browser-entry': void createBrowserEntry(); break;
    case 'toggle-hidden-files': showHiddenFiles = !showHiddenFiles; void refreshProjectFolder(); showToast(showHiddenFiles ? 'Showing hidden files.' : 'Hiding hidden files.'); break;
    case 'toggle-folder-bookmark': toggleFolderBookmark(); break;
    case 'save': void save(); break;
    case 'save-as': void saveAs(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'close': closeDocument(); break;
    case 'reopen-encoding': reopenWithEncoding(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'find': openFind(); break;
    case 'find-next': findNext(); break;
    case 'replace': replaceOne(); break;
    case 'replace-all': replaceAll(); break;
    case 'close-find': closeFind(); break;
    case 'command-palette': openCommandPalette(); break;
    case 'go-to-line': goToLinePrompt(); break;
    case 'toggle-editor-split': toggleEditorSplit(); break;
    case 'zen': toggleZenMode(); break;
    case 'print': printDocument(); break;
    case 'export-pdf': printDocument(); break;
    case 'export-html': void exportHtml(); break;
    case 'insert-table': insertMarkdownTable(); break;
    case 'toggle-task': toggleMarkdownTask(); break;
    case 'reload-external': void reloadExternalChange(); break;
    case 'compare-external': void compareExternalChange(); break;
    case 'ignore-external': ignoreExternalChange(); break;
    case 'clear-recents': localStorage.removeItem(RECENTS_KEY); renderRecents(); showToast('Recent files cleared.'); break;
    case 'refresh-outline': renderOutline(); showToast('Outline refreshed.'); break;
    case 'mode-edit': setViewMode('edit'); break;
    case 'mode-split': setViewMode('split'); break;
    case 'mode-preview': setViewMode('preview'); break;
  }
}

app.addEventListener('pointerdown', (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('.theme-picker, .editor-appearance')) return;
  closeTransientMenus();
});

app.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const themeChoice = event.target.closest<HTMLButtonElement>('[data-theme-choice]');
  if (themeChoice?.dataset.themeChoice) {
    setUiTheme(themeChoice.dataset.themeChoice);
    return;
  }
  const scaleChoice = event.target.closest<HTMLButtonElement>('[data-ui-scale-choice]');
  if (scaleChoice?.dataset.uiScaleChoice) {
    setUiScale(scaleChoice.dataset.uiScaleChoice);
    return;
  }
  const target = event.target.closest<HTMLElement>('[data-action], [data-mode-button]');
  if (!target) return;
  if (target.dataset.modeButton) setViewMode(target.dataset.modeButton as ViewMode);
  else handleAction(target.dataset.action);
});

function handleEditorTab(event: KeyboardEvent, surface: HTMLTextAreaElement) {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const indent = editorOptions.indentation === 'tabs' ? '\t' : ' '.repeat(editorOptions.tabSize);
  const start = surface.selectionStart;
  const end = surface.selectionEnd;
  if (start !== end && documentState.content.slice(start, end).includes('\n')) {
    const selected = documentState.content.slice(start, end);
    const changed = event.shiftKey
      ? selected.replace(new RegExp(`^(?:${editorOptions.indentation === 'tabs' ? '\\t' : ` {1,${editorOptions.tabSize}}`})`, 'gm'), '')
      : selected.replace(/^/gm, indent);
    recordContent(`${documentState.content.slice(0, start)}${changed}${documentState.content.slice(end)}`);
    surface.setSelectionRange(start, start + changed.length);
    return;
  }
  if (event.shiftKey) return;
  recordContent(`${documentState.content.slice(0, start)}${indent}${documentState.content.slice(end)}`);
  surface.setSelectionRange(start + indent.length, start + indent.length);
}

for (const surface of [editor, secondaryEditor]) {
  surface.addEventListener('input', () => recordContent(surface.value));
  surface.addEventListener('keydown', (event) => handleEditorTab(event, surface));
  surface.addEventListener('keyup', updateCursor);
  surface.addEventListener('click', updateCursor);
  surface.addEventListener('select', updateCursor);
}
encodingSelect.addEventListener('change', () => {
  setCurrentDocument({ ...documentState, encoding: encodingSelect.value });
  render();
  showToast(documentState.path ? `Selected ${encodingSelect.options[encodingSelect.selectedIndex].text}; choose Reopen to decode the saved file again.` : `New documents will save as ${encodingSelect.options[encodingSelect.selectedIndex].text}.`);
});
editorFontSelect.addEventListener('change', () => {
  editorAppearance = { ...editorAppearance, fontFamily: editorFontSelect.value };
  saveEditorAppearance();
});
editorFontSizeSelect.addEventListener('change', () => {
  editorAppearance = { ...editorAppearance, fontSize: Number(editorFontSizeSelect.value) };
  saveEditorAppearance();
});
editorSurfaceSelect.addEventListener('change', () => setEditorSurface(editorSurfaceSelect.value));
editorWrapSelect.addEventListener('change', () => { editorOptions = { ...editorOptions, wordWrap: editorWrapSelect.value === 'on' }; saveEditorOptions(); });
editorIndentSelect.addEventListener('change', () => { editorOptions = { ...editorOptions, indentation: editorIndentSelect.value === 'tabs' ? 'tabs' : 'spaces' }; saveEditorOptions(); });
editorTabSizeSelect.addEventListener('change', () => { const size = Number(editorTabSizeSelect.value); editorOptions = { ...editorOptions, tabSize: size === 4 || size === 8 ? size : 2 }; saveEditorOptions(); });
editorLineEndingSelect.addEventListener('change', () => { editorOptions = { ...editorOptions, lineEnding: editorLineEndingSelect.value === 'crlf' ? 'crlf' : 'lf' }; saveEditorOptions(); showToast(`New saves will use ${editorOptions.lineEnding.toUpperCase()} line endings.`); });
editorSpellLanguageSelect.addEventListener('change', () => { editorOptions = { ...editorOptions, spellLanguage: editorSpellLanguageSelect.value }; saveEditorOptions(); });
folderFilter.addEventListener('input', () => { folderFilterValue = folderFilter.value; renderProjectTree(); });
findInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); findNext(); } if (event.key === 'Escape') { closeFind(); } });
replaceInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); event.shiftKey ? replaceAll() : replaceOne(); } if (event.key === 'Escape') { closeFind(); } });
commandPaletteInput.addEventListener('input', () => { commandSelection = 0; renderCommandPalette(); });
commandPaletteInput.addEventListener('keydown', (event) => {
  const commands = paletteCommands().filter((command) => command.label.toLocaleLowerCase().includes(commandPaletteInput.value.trim().toLocaleLowerCase()));
  if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); commandSelection = Math.min(commands.length - 1, commandSelection + 1); renderCommandPalette(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); commandSelection = Math.max(0, commandSelection - 1); renderCommandPalette(); }
  else if (event.key === 'Enter') { event.preventDefault(); const command = commands[commandSelection]; if (command) { closeCommandPalette(); command.run(); } }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const hasOpenTransientMenu = Boolean(app!.querySelector<HTMLDetailsElement>('.theme-picker[open], .editor-appearance[open]'));
    if (hasOpenTransientMenu) {
      event.preventDefault();
      closeTransientMenus();
      return;
    }
  }
  if (event.key === 'Escape' && zenMode) { event.preventDefault(); toggleZenMode(); return; }
  if (!commandPalette.hidden) return;
  const primary = event.metaKey || event.ctrlKey;
  if (!primary) return;
  const key = event.key.toLowerCase();
  if (key === 's') { event.preventDefault(); void (event.shiftKey ? saveAs() : save()); }
  else if (key === 'o' && event.shiftKey) { event.preventDefault(); void selectProjectFolder(); }
  else if (key === 'o') { event.preventDefault(); void openFile(); }
  else if (key === 'n') { event.preventDefault(); createDocument(event.shiftKey); }
  else if (key === 'w') { event.preventDefault(); closeDocument(); }
  else if (key === 'f') { event.preventDefault(); openFind(); }
  else if (key === 'h') { event.preventDefault(); openFind(); window.requestAnimationFrame(() => replaceInput.focus()); }
  else if (key === 'g') { event.preventDefault(); if (findbar.hidden) openFind(); else findNext(); }
  else if (key === 'b' && event.shiftKey) { event.preventDefault(); toggleSidebar(); }
  else if (key === 'l') { event.preventDefault(); goToLinePrompt(); }
  else if (key === 'p' && event.shiftKey) { event.preventDefault(); openCommandPalette(); }
  else if (key === 'p') { event.preventDefault(); printDocument(); }
  else if (key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (key === '1') { event.preventDefault(); setViewMode('edit'); }
  else if (key === '2') { event.preventDefault(); setViewMode('split'); }
  else if (key === '3') { event.preventDefault(); setViewMode('preview'); }
});

void listen<string>('menu-action', ({ payload }) => handleAction(payload));

async function startExternalFileHandling() {
  try {
    await listen<string[]>('external-open-files', ({ payload }) => enqueueExternalFiles(payload));
    enqueueExternalFiles(await invoke<string[]>('take_pending_open_files'));
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function openDroppedPath(path: string) {
  try {
    const folder = await invoke<ProjectFolder>('browse_folder', { path, showHidden: showHiddenFiles });
    projectFolder = folder;
    localStorage.setItem(PROJECT_FOLDER_KEY, folder.path);
    renderProjectTree();
    showToast(`Opened ${folder.name} in the folder pane.`, 'success');
  } catch {
    await openExternalFile(path);
  }
}

async function startDragAndDrop() {
  try {
    await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        shell.classList.add('file-drop-active');
      } else if (event.payload.type === 'leave') {
        shell.classList.remove('file-drop-active');
      } else if (event.payload.type === 'drop') {
        shell.classList.remove('file-drop-active');
        for (const path of event.payload.paths) void openDroppedPath(path);
      }
    });
  } catch {
    // Native file drops are unavailable only in unsupported development contexts.
  }
}

window.addEventListener('beforeunload', (event) => {
  persistRecovery();
  if (!documents.some((document) => document.content !== document.savedContent)) return;
  event.preventDefault();
  event.returnValue = '';
});

restoreSession();
applyEditorAppearance();
applyEditorOptions();
applySidebarLayout();
applyUiTheme();
applyUiScale();
applyEditorSurface();
setupTransientMenus();
startSidebarResizing();
render();
renderProjectTree();
void refreshProjectFolder(true);
void startExternalFileHandling();
void startDragAndDrop();
window.addEventListener('resize', () => {
  const constrained = clampSidebarWidth(sidebarWidth);
  if (constrained !== sidebarWidth) setSidebarWidth(constrained);
});
window.setInterval(() => { void watchFiles(); }, 4000);
