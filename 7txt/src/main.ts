import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import brandIconUrl from '../src-tauri/icons/7txt-icon.svg?url';
import './styles.css';
import { createRecoveryQueue, flushStableRecovery } from '../../shared/recoveryQueue';

type ViewMode = 'edit' | 'split' | 'preview';
type DocumentKind = 'text' | 'pdf' | 'image';
type AnnotationKind = 'highlight' | 'note';
type HelpSection = 'getting-started' | 'shortcuts' | 'whats-new' | 'about';
type MediaAnnotation = { id: string; kind: AnnotationKind; x: number; y: number; width?: number; height?: number; text?: string; color: string; page?: number };
type AnnotationDrag =
  | { mode: 'move'; id: string; pointerId: number; dx: number; dy: number }
  | { mode: 'draw'; id: string; pointerId: number; x: number; y: number };
type TextDocument = {
  diskVersion?: string;
  conflict?: boolean;
  recoveryOrigin?: string;
  id: string;
  name: string;
  path?: string;
  content: string;
  savedContent: string;
  isMarkdown: boolean;
  encoding: string;
  kind: DocumentKind;
  mediaData?: string;
  mimeType?: string;
  annotations?: MediaAnnotation[];
  savedAnnotations?: string;
  cursor?: number;
  /** A formerly saved file that disappeared; retain it as a dirty draft. */
  recoveryDraft?: boolean;
  /** The untouched tab created by New/launch, safe to omit from recovery. */
  defaultUntitled?: boolean;
};
type OpenedDocument = {
  diskVersion?: string;
  name: string;
  path: string;
  content: string;
  isMarkdown: boolean;
  encoding: string;
  kind: DocumentKind;
  mediaData?: string;
  mimeType?: string;
};
type SavedTextFile = { name: string; path: string; encoding: string; diskVersion: string };
type RecentEntry = { name: string; path: string; isMarkdown: boolean; kind: DocumentKind; openedAt: number };
type DocumentHistory = { entries: string[]; index: number };
type TimelineSnapshot = { id: string; savedAt: number; label: string; content: string };
type QuickSwitchItem = { group: string; label: string; detail: string; run: () => void };
type FolderEntry = { name: string; path: string; kind: 'file' | 'directory' };
type ProjectFolder = { name: string; path: string; parentPath?: string; homePath: string; documentsPath: string; entries: FolderEntry[]; truncated: boolean };
type FolderBookmark = { name: string; path: string };
type FileFingerprint = { modifiedMillis: number; size: number };
type ExternalChange = { path: string; name: string; fingerprint?: FileFingerprint };
type SaveTarget = { id: string; path?: string; generation: number };
type EditorOptions = { wordWrap: boolean; indentation: 'spaces' | 'tabs'; tabSize: 2 | 4 | 8; lineEnding: 'lf' | 'crlf'; spellLanguage: string };
type SessionDocument = Omit<TextDocument, 'id'> & { cursor?: number };
type RestoredSession = { documents: SessionDocument[]; activeIndex: number; savedAt: number };
type WorkbenchState = {
  viewMode?: ViewMode;
  editorSplit?: boolean;
  zenMode?: boolean;
  readingMode?: boolean;
  sidebarVisible?: boolean;
  sidebarAutoHidden?: boolean;
  sidebarWidth?: number;
  previewEnabled?: boolean;
  previewWidth?: number;
  showHiddenFiles?: boolean;
  folderFilterValue?: string;
  projectFolderPath?: string;
};

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
const PREVIEW_VISIBLE_KEY = '7txt:preview-visible:v1';
const PREVIEW_WIDTH_KEY = '7txt:preview-width:v1';
const WRITING_GOAL_KEY = '7txt:writing-goal:v1';
const TIMELINE_KEY_PREFIX = '7txt:document-timeline:v1:';
const SESSION_KEY = '7txt:workspace-session:v1';
const WORKBENCH_STATE_KEY = '7txt:workbench-state:v1';
const RECOVERY_KEY = '7txt:recovery-drafts:v1';
const SAVE_TARGET_MISSING_PREFIX = 'SAVE_TARGET_MISSING:';
const APP_VERSION = '1.0.0';
const MAX_RECENTS = 14;
const MAX_FOLDER_BOOKMARKS = 12;
const MAX_TIMELINE_SNAPSHOTS = 16;
const MAX_TIMELINE_SNAPSHOT_CHARS = 280_000;
const MIN_SIDEBAR_WIDTH = 180;
const DEFAULT_SIDEBAR_WIDTH = 218;
const MAX_SIDEBAR_WIDTH = 430;
const MIN_PREVIEW_WIDTH = 280;
const DEFAULT_PREVIEW_WIDTH = 460;
const MAX_PREVIEW_WIDTH = 760;
const TAB_WIDTHS = [230, 172, 129, 97] as const;
const TAB_GAP = 5;
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

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

if (!app) throw new Error('7TXT could not create its editor window.');

app.innerHTML = `
  <main class="app-shell" data-mode="split">
    <header class="titlebar">
      <div class="brand"><button class="brand-mark-button" data-action="toggle-sidebar" title="Hide Files sidebar" aria-label="Hide Files sidebar"><img class="brand-mark" src="${brandIconUrl}" alt="" /></button><strong>7TXT</strong></div>
      <div class="header-actions" aria-label="Workspace actions">
        <div class="header-file-actions">
          <button class="toolbar-icon-button" data-action="new-text" title="New text tab (⌘N)" aria-label="New text tab"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M12 11v6M9 14h6"/></svg></button>
          <button class="toolbar-icon-button" data-action="new-markdown" title="New Markdown tab (⇧⌘N)" aria-label="New Markdown tab"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M8.5 16v-5l2 2.7L12.5 11v5M15 11v5"/></svg></button>
          <button class="toolbar-icon-button" data-action="open" title="Open file (⌘O)" aria-label="Open file"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3zM3 7V5h7l2 2"/></svg></button>
          <button class="toolbar-icon-button" data-action="save-as" title="Save As (⇧⌘S)" aria-label="Save As"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M10 18l6.4-6.4 2 2L12 20l-3 1z"/></svg></button>
        </div>
        <button class="toolbar-icon-button sidebar-toggle" data-action="toggle-sidebar" title="Hide Files sidebar (⇧⌘B)" aria-label="Hide Files sidebar" aria-expanded="true"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM10 4v16M7 8h.01M7 12h.01M7 16h.01"/></svg></button>
        <button class="toolbar-icon-button" data-action="quick-switch" title="Quick switcher (⌘K)" aria-label="Quick switcher"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="5.5"/><path d="m16 16 4 4M8.5 11h5"/></svg></button>
        <button class="toolbar-icon-button" data-action="command-palette" title="Command Palette (⇧⌘P)" aria-label="Command Palette"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 9h.01M12 9h4M8 13h.01M12 13h4M8 17h8"/></svg></button>
      </div>
    </header>
    <nav class="document-tabs" aria-label="Open documents">
      <div class="tab-list" role="tablist"></div>
      <div class="open-tabs-popover"><button class="open-tabs-toggle" data-action="toggle-open-tabs" title="Show all open tabs" aria-label="Show all open tabs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h10"/><path d="m17 16 2 2 2-2"/></svg></button><div class="open-tabs-menu" role="menu" hidden></div></div>
      <button class="tab-new" data-action="new-text" title="New text tab (⌘N)" aria-label="New text tab">+</button>
    </nav>
    <section class="toolbar" aria-label="Document controls">
      <div class="quick-actions" aria-label="Quick actions">
        <button class="toolbar-icon-button save-button" data-action="save" title="Save (⌘S)" aria-label="Save"><svg class="toolbar-icon toolbar-save-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="save-body" d="M5 3h12l3 3v15H5z"/><path d="M8 3v6h8V3M8 20v-6h8v6"/></svg></button>
        <button class="toolbar-icon-button" data-action="find" title="Find (⌘F)" aria-label="Find"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="5.5"/><path d="m16 16 4 4"/></svg></button>
        <button class="toolbar-icon-button folder-bookmark-toggle" data-action="toggle-folder-bookmark" title="Bookmark this folder" aria-label="Bookmark this folder"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/></svg></button>
      </div>
      <label class="encoding-control" title="Text encoding — click to choose how this document is opened or saved."><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 6l-4 12"/></svg><select data-encoding aria-label="Text encoding">${CHARACTER_ENCODINGS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <button data-action="reopen-encoding" class="toolbar-icon-button reopen-encoding" title="Reload this saved document using the selected encoding" aria-label="Reload using selected encoding"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5M20 5v6h-6"/></svg></button>
      <div class="view-switch" role="group" aria-label="View mode">
        <button data-mode-button="edit" title="Edit view (⌘1)">Edit</button>
        <button data-mode-button="split" title="Split view (⌘2)">Split</button>
        <button data-mode-button="preview" title="Preview (⌘3)">Preview</button>
      </div>
      <button class="toolbar-icon-button preview-toggle" data-action="toggle-preview" title="Hide Markdown preview" aria-label="Hide Markdown preview" aria-pressed="true"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.2-5.5 9.5-5.5S21.5 12 21.5 12 18.3 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.7"/></svg></button>
      <div class="markdown-actions" aria-label="Markdown tools">
        <button class="toolbar-icon-button" data-action="insert-table" title="Insert Markdown table" aria-label="Insert Markdown table"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14"/></svg></button>
        <button class="toolbar-icon-button" data-action="toggle-task" title="Toggle Markdown task list" aria-label="Toggle Markdown task list"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h3v3H4zM10 7h10M4 15h3v3H4zM10 16h10M4.5 15.5 5.7 17l2-3"/></svg></button>
        <button class="toolbar-icon-button" data-action="insert-link" title="Insert Markdown link from clipboard" aria-label="Insert Markdown link from clipboard"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13.5a4 4 0 0 0 5.7.1l2-2a4 4 0 0 0-5.7-5.7l-1.1 1.1M14 10.5a4 4 0 0 0-5.7-.1l-2 2a4 4 0 0 0 5.7 5.7l1.1-1.1"/></svg></button>
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
      <button class="toolbar-icon-button" data-action="timeline" title="Local document timeline" aria-label="Local document timeline"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.5 2M5 5l2 2"/></svg></button>
      <button class="toolbar-icon-button" data-action="reading-mode" title="Focused reading mode" aria-label="Focused reading mode"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5c2.8-.8 5.4-.4 8 1.3 2.6-1.7 5.2-2.1 8-1.3v13c-2.8-.8-5.4-.4-8 1.3-2.6-1.7-5.2-2.1-8-1.3zM12 6.8v13"/></svg></button>
      <button class="toolbar-icon-button" data-action="zen" title="Zen mode" aria-label="Zen mode"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M12 4v16M7 7l10 10M17 7 7 17"/></svg></button>
      <button class="toolbar-icon-button" data-action="undo" title="Undo (⌘Z)" aria-label="Undo"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-4 4 4 4M5 11h7a6 6 0 0 1 6 6"/></svg></button>
      <button class="toolbar-icon-button" data-action="redo" title="Redo (⇧⌘Z)" aria-label="Redo"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 7 4 4-4 4M19 11h-7a6 6 0 0 0-6 6"/></svg></button>
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
        <div class="external-change" hidden><span></span><button data-action="reload-external">Use disk</button><button data-action="compare-external">Compare</button><button data-action="ignore-external">Keep mine…</button><button data-action="save-both-external">Save As…</button></div>
        <div class="recovery-status" role="status"></div>
        <div class="recovered-notice" hidden><span></span><button data-action="save-as">Save As…</button></div>
        <div class="editor-heading"><span class="format-chip"></span><span class="editor-mode-label">Plain text</span><span class="editor-status"></span></div>
        <div class="editor-surface"><div class="editor-view"><pre class="line-numbers" aria-hidden="true">1</pre><textarea class="editor" aria-label="Text editor" spellcheck="true" placeholder="Start writing…"></textarea></div><div class="editor-view editor-secondary-view"><pre class="line-numbers line-numbers-secondary" aria-hidden="true">1</pre><textarea class="editor editor-secondary" aria-label="Second text editor pane" spellcheck="true" placeholder="Start writing…"></textarea></div></div>
        <div class="empty-workspace" hidden><strong>No file open</strong><span>Create a note or open a file to begin.</span><div><button data-action="new-text">New text</button><button data-action="new-markdown">New Markdown</button><button data-action="open">Open file</button></div></div>
      </section>
      <div class="preview-resizer" role="separator" aria-label="Resize Markdown preview" aria-orientation="vertical" aria-valuemin="280" aria-valuemax="760" tabindex="0"></div>
      <section class="preview-pane">
        <div class="preview-heading"><span>PREVIEW</span><span class="preview-kind"></span></div>
        <article class="markdown-preview" aria-label="Document preview"></article>
      </section>
      <section class="media-pane" hidden aria-label="Media viewer">
        <div class="media-heading"><span class="media-kind-chip">PDF</span><span class="media-label">Media viewer</span><span class="media-page-status"></span><span class="toolbar-spacer"></span><button class="media-control" data-action="media-previous-page" title="Previous PDF page" aria-label="Previous PDF page">‹</button><span class="media-page-count"></span><button class="media-control" data-action="media-next-page" title="Next PDF page" aria-label="Next PDF page">›</button><span class="media-control-divider"></span><button class="media-control" data-action="media-zoom-out" title="Zoom out" aria-label="Zoom out">−</button><button class="media-zoom-label" data-action="media-zoom-fit" title="Fit media to view" aria-label="Fit media to view">100%</button><button class="media-control" data-action="media-zoom-in" title="Zoom in" aria-label="Zoom in">+</button></div>
        <div class="media-body">
          <div class="media-scroller"><div class="media-stage" aria-label="Document or image canvas"><img class="media-image" alt="" hidden /><canvas class="pdf-canvas" hidden></canvas><div class="annotation-layer" aria-label="Media annotations"></div></div><div class="media-empty">Loading preview…</div></div>
          <aside class="annotation-panel" aria-label="Annotations"><div class="annotation-panel-heading"><span>ANNOTATE</span><button data-action="clear-media-annotations" title="Clear all annotations" aria-label="Clear all annotations">Clear</button></div><div class="annotation-tools" role="group" aria-label="Annotation tool"><button data-annotation-tool="select" title="Select and move an annotation" aria-pressed="true">Select</button><button data-annotation-tool="highlight" title="Click and drag to draw a highlight" aria-pressed="false">Highlight</button><button data-annotation-tool="note" title="Click to attach a note" aria-pressed="false">Note</button></div><p class="annotation-hint">Choose Highlight, then drag over the area you want to mark.</p><div class="annotation-colors" role="group" aria-label="Annotation color"><button data-annotation-color="#f5c451" aria-label="Gold annotation"></button><button data-annotation-color="#4ac6bd" aria-label="Teal annotation"></button><button data-annotation-color="#8198ee" aria-label="Blue annotation"></button><button data-annotation-color="#e9899d" aria-label="Rose annotation"></button></div><div class="annotation-list"></div><div class="annotation-panel-footer"><button data-action="edit-media-annotation" title="Edit selected note">Edit selected</button><button data-action="delete-media-annotation" title="Delete selected annotation">Delete selected</button><button data-action="save-media-annotations" title="Save annotations next to the original media">Save notes</button></div></aside>
        </div>
      </section>
    </section>
    <footer class="statusbar">
      <span class="status-stats"></span>
      <span class="status-cursor">Ln 1, Col 1</span>
      <button class="writing-progress" data-action="writing-goal" title="Set a writing goal"></button>
      <span class="status-spacer"></span>
      <span class="status-help">⌘O Open · ⌘S Save · ⌘F Find</span>
    </footer>
    <div class="toast" role="status" aria-live="polite" hidden></div>
    <section class="command-palette" hidden aria-label="Command Palette"><div class="command-palette-card"><input type="search" placeholder="Type a command…" aria-label="Search commands" spellcheck="false" /><div class="command-list"></div><small>↑↓ navigate · Enter run · Esc close</small></div></section>
    <section class="quick-switcher overlay-panel" hidden aria-label="Quick switcher"><div class="overlay-card"><div class="overlay-heading"><strong>Quick switcher</strong><button data-action="close-quick-switch" aria-label="Close quick switcher">×</button></div><input type="search" placeholder="Open tabs, recents, bookmarks, or this folder…" aria-label="Quick switcher search" spellcheck="false" /><div class="quick-switch-list"></div><small>⌘K opens this switcher · Esc closes</small></div></section>
    <section class="timeline-panel overlay-panel" hidden aria-label="Document timeline"><div class="overlay-card timeline-card"><div class="overlay-heading"><strong>Local timeline</strong><button data-action="close-timeline" aria-label="Close timeline">×</button></div><p class="timeline-intro">Saved locally in this browser profile. Restore a snapshot into the current tab.</p><div class="timeline-list"></div></div></section>
    <section class="help-panel overlay-panel" hidden role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="overlay-card help-card">
        <div class="overlay-heading"><div class="help-title"><strong id="help-title">7TXT Help</strong><span>Version ${APP_VERSION}</span></div><button data-action="close-help" aria-label="Close Help">×</button></div>
        <div class="help-layout"><nav class="help-nav" aria-label="Help topics"><button type="button" data-help-section="getting-started">Getting started</button><button type="button" data-help-section="shortcuts">Keyboard shortcuts</button><button type="button" data-help-section="whats-new">What’s new</button><button type="button" data-help-section="about">About 7TXT</button></nav><div class="help-content" tabindex="0"></div></div>
      </div>
    </section>
  </main>
`;

const shell = required<HTMLElement>('.app-shell');
const editor = required<HTMLTextAreaElement>('.editor');
const secondaryEditor = required<HTMLTextAreaElement>('.editor-secondary');
const lineNumbers = required<HTMLElement>('.line-numbers');
const secondaryLineNumbers = required<HTMLElement>('.line-numbers-secondary');
const preview = required<HTMLElement>('.markdown-preview');
const previewPane = required<HTMLElement>('.preview-pane');
const viewSwitch = required<HTMLElement>('.view-switch');
const emptyWorkspaceMessage = required<HTMLElement>('.empty-workspace');
const mediaPane = required<HTMLElement>('.media-pane');
const mediaScroller = required<HTMLElement>('.media-scroller');
const mediaStage = required<HTMLElement>('.media-stage');
const mediaImage = required<HTMLImageElement>('.media-image');
const pdfCanvas = required<HTMLCanvasElement>('.pdf-canvas');
const mediaEmpty = required<HTMLElement>('.media-empty');
const annotationLayer = required<HTMLElement>('.annotation-layer');
const annotationList = required<HTMLElement>('.annotation-list');
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
const sidebarToggle = required<HTMLButtonElement>('.sidebar-toggle');
const brandSidebarToggle = required<HTMLButtonElement>('.brand-mark-button');
const themePicker = required<HTMLDetailsElement>('.theme-picker');
const folderFilter = required<HTMLInputElement>('.folder-filter');
const workspace = required<HTMLElement>('.workspace');
const sidebar = required<HTMLElement>('.sidebar');
const sidebarResizer = required<HTMLElement>('.sidebar-resizer');
const previewResizer = required<HTMLElement>('.preview-resizer');
const previewToggle = required<HTMLButtonElement>('.preview-toggle');
const readingModeButton = required<HTMLButtonElement>('[data-action="reading-mode"]');
const externalChangeBar = required<HTMLElement>('.external-change');
const commandPalette = required<HTMLElement>('.command-palette');
const commandPaletteInput = required<HTMLInputElement>('.command-palette input');
const commandList = required<HTMLElement>('.command-list');
const quickSwitcher = required<HTMLElement>('.quick-switcher');
const quickSwitchInput = required<HTMLInputElement>('.quick-switcher input');
const quickSwitchList = required<HTMLElement>('.quick-switch-list');
const timelinePanel = required<HTMLElement>('.timeline-panel');
const timelineList = required<HTMLElement>('.timeline-list');
const helpPanel = required<HTMLElement>('.help-panel');
const helpContent = required<HTMLElement>('.help-content');
const writingProgress = required<HTMLButtonElement>('.writing-progress');
const tabList = required<HTMLElement>('.tab-list');
const openTabsToggle = required<HTMLButtonElement>('.open-tabs-toggle');
const openTabsMenu = required<HTMLElement>('.open-tabs-menu');
const openTabsList = openTabsMenu;
const savedWorkbenchState = readWorkbenchState();

let nextDocumentId = 1;
const firstDocument = blankDocument();
let documents: TextDocument[] = [firstDocument];
let activeDocumentId = firstDocument.id;
let documentState: TextDocument = firstDocument;
let workspaceEmpty = false;
let tabDrag: { id: string; pointerId: number; startX: number; dragging: boolean } | null = null;
let viewMode: ViewMode = savedWorkbenchState.viewMode || 'split';
let projectFolder: ProjectFolder | null = null;
let showHiddenFiles = savedWorkbenchState.showHiddenFiles || false;
let folderFilterValue = savedWorkbenchState.folderFilterValue || '';
let editorSplit = savedWorkbenchState.editorSplit || false;
let zenMode = savedWorkbenchState.zenMode || false;
let readingMode = savedWorkbenchState.readingMode || false;
let writingGoal = readWritingGoal();
let writingStartedAt = Date.now();
let uiTheme = readUiTheme();
let uiScale = readUiScale();
let editorSurface = readEditorSurface();
let sidebarVisible = savedWorkbenchState.sidebarVisible ?? readSidebarVisible();
let sidebarAutoHidden = savedWorkbenchState.sidebarAutoHidden || false;
let sidebarWidth = savedWorkbenchState.sidebarWidth === undefined ? readSidebarWidth() : clampSidebarWidth(savedWorkbenchState.sidebarWidth);
let sidebarResizePointerId: number | null = null;
let previewEnabled = savedWorkbenchState.previewEnabled ?? readPreviewVisible();
let previewWidth = savedWorkbenchState.previewWidth === undefined ? readPreviewWidth() : clampPreviewWidth(savedWorkbenchState.previewWidth);
let previewResizePointerId: number | null = null;
let focusedReadingAvailable: boolean | undefined;
let sidebarAutoHideTimer: number | undefined;
let sidebarPointerInside = false;
let externalChange: ExternalChange | null = null;
let recoveryReady = false;
let recoveryLoadFailed = false;
const recoveryQueue = createRecoveryQueue<RestoredSession>((payload) => invoke<number>('recovery_save', { payload }));
const fileFingerprints = new Map<string, FileFingerprint>();
const histories = new Map<string, DocumentHistory>([[firstDocument.id, { entries: [''], index: 0 }]]);
let toastTimer: number | undefined;
let recoveryTimer: number | undefined;
let timelineTimer: number | undefined;
let autosaveInFlight = false;
let commandSelection = 0;
let helpSection: HelpSection = 'getting-started';
let mediaPdf: PDFDocumentProxy | null = null;
let mediaPdfPath: string | undefined;
let mediaPage = 1;
let mediaPageCount = 0;
let mediaZoom = 1;
let mediaRenderToken = 0;
let mediaLastRenderKey = '';
let annotationTool: 'select' | AnnotationKind = 'select';
let annotationColor = '#f5c451';
let selectedAnnotationId: string | null = null;
let annotationSaveTimer: number | undefined;
let annotationDrag: AnnotationDrag | null = null;

function required<T extends Element>(selector: string): T {
  const value = app!.querySelector<T>(selector);
  if (!value) throw new Error(`7TXT is missing ${selector}.`);
  return value;
}

function isUiTheme(value: string): value is UiTheme {
  return UI_THEMES.some(([theme]) => theme === value);
}

function readWritingGoal() {
  const value = Number(localStorage.getItem(WRITING_GOAL_KEY));
  return Number.isInteger(value) && value > 0 && value <= 100_000 ? value : 0;
}

function wordCount(content: string) {
  return content.trim() ? content.trim().split(/\s+/).length : 0;
}

function renderWritingProgress() {
  if (isMediaDocument(documentState)) {
    writingProgress.hidden = true;
    return;
  }
  writingProgress.hidden = false;
  const words = wordCount(documentState.content);
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - writingStartedAt) / 60_000));
  writingProgress.textContent = writingGoal ? `${Math.min(words, writingGoal)} / ${writingGoal} words${elapsedMinutes ? ` · ${elapsedMinutes}m` : ''}` : `${words} words${elapsedMinutes ? ` · ${elapsedMinutes}m` : ''}`;
  writingProgress.classList.toggle('complete', writingGoal > 0 && words >= writingGoal);
  writingProgress.title = writingGoal ? 'Change or clear this writing goal' : 'Set a writing goal';
}

function setWritingGoal() {
  const answer = window.prompt('Writing goal for this session (words). Enter 0 to clear it:', writingGoal ? String(writingGoal) : '500');
  if (answer === null) return;
  const next = Number(answer.trim());
  if (!Number.isInteger(next) || next < 0 || next > 100_000) {
    showToast('Enter a whole number between 0 and 100,000.', 'error');
    return;
  }
  writingGoal = next;
  writingStartedAt = Date.now();
  if (writingGoal) localStorage.setItem(WRITING_GOAL_KEY, String(writingGoal));
  else localStorage.removeItem(WRITING_GOAL_KEY);
  renderWritingProgress();
  showToast(writingGoal ? `Writing goal set to ${writingGoal} words.` : 'Writing goal cleared.', 'success');
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

function isViewMode(value: unknown): value is ViewMode {
  return value === 'edit' || value === 'split' || value === 'preview';
}

function readWorkbenchState(): WorkbenchState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(WORKBENCH_STATE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const state = parsed as Record<string, unknown>;
    const finiteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const nonEmptyText = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
    return {
      viewMode: isViewMode(state.viewMode) ? state.viewMode : undefined,
      editorSplit: typeof state.editorSplit === 'boolean' ? state.editorSplit : undefined,
      zenMode: typeof state.zenMode === 'boolean' ? state.zenMode : undefined,
      readingMode: typeof state.readingMode === 'boolean' ? state.readingMode : undefined,
      sidebarVisible: typeof state.sidebarVisible === 'boolean' ? state.sidebarVisible : undefined,
      sidebarAutoHidden: typeof state.sidebarAutoHidden === 'boolean' ? state.sidebarAutoHidden : undefined,
      sidebarWidth: finiteNumber(state.sidebarWidth),
      previewEnabled: typeof state.previewEnabled === 'boolean' ? state.previewEnabled : undefined,
      previewWidth: finiteNumber(state.previewWidth),
      showHiddenFiles: typeof state.showHiddenFiles === 'boolean' ? state.showHiddenFiles : undefined,
      folderFilterValue: typeof state.folderFilterValue === 'string' ? state.folderFilterValue : undefined,
      projectFolderPath: nonEmptyText(state.projectFolderPath),
    };
  } catch {
    return {};
  }
}

function persistWorkbenchState() {
  try {
    const projectFolderPath = projectFolder?.path || localStorage.getItem(PROJECT_FOLDER_KEY) || savedWorkbenchState.projectFolderPath;
    const state: WorkbenchState = {
      viewMode,
      editorSplit,
      zenMode,
      readingMode,
      sidebarVisible,
      sidebarAutoHidden,
      sidebarWidth,
      previewEnabled,
      previewWidth,
      showHiddenFiles,
      folderFilterValue,
      projectFolderPath: projectFolderPath || undefined,
    };
    localStorage.setItem(WORKBENCH_STATE_KEY, JSON.stringify(state));
  } catch {
    // Workspace layout persistence is best-effort.
  }
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
  window.requestAnimationFrame(updateTabWidth);
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
  openTabsMenu.hidden = true;
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

function readPreviewVisible() {
  return localStorage.getItem(PREVIEW_VISIBLE_KEY) !== 'false';
}

function clampPreviewWidth(width: number) {
  const sidebarSpace = sidebarIsShown() ? sidebarWidth + 6 : 0;
  const available = Math.max(MIN_PREVIEW_WIDTH, window.innerWidth / uiScaleFactor() - sidebarSpace - 360);
  return Math.round(Math.min(Math.max(width, MIN_PREVIEW_WIDTH), Math.min(MAX_PREVIEW_WIDTH, available)));
}

function readPreviewWidth() {
  const stored = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  return Number.isFinite(stored) ? clampPreviewWidth(stored) : DEFAULT_PREVIEW_WIDTH;
}

function applySidebarLayout() {
  const shown = sidebarIsShown();
  const visibleLabel = shown ? 'Hide Files sidebar' : 'Show Files sidebar';
  workspace.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  shell.classList.toggle('sidebar-hidden', !shown);
  sidebarToggle.title = `${visibleLabel} (⇧⌘B)`;
  sidebarToggle.setAttribute('aria-label', visibleLabel);
  sidebarToggle.setAttribute('aria-expanded', String(shown));
  brandSidebarToggle.title = visibleLabel;
  brandSidebarToggle.setAttribute('aria-label', visibleLabel);
  brandSidebarToggle.setAttribute('aria-expanded', String(shown));
  sidebarResizer.setAttribute('aria-valuenow', String(sidebarWidth));
  persistWorkbenchState();
}

function applyPreviewLayout() {
  const available = documentState.isMarkdown && !isMediaDocument(documentState);
  const shown = available && previewEnabled;
  workspace.style.setProperty('--preview-width', `${previewWidth}px`);
  previewToggle.hidden = !available;
  previewToggle.setAttribute('aria-pressed', String(shown));
  previewToggle.title = shown ? 'Hide Markdown preview' : 'Show Markdown preview';
  previewToggle.setAttribute('aria-label', previewToggle.title);
  previewResizer.setAttribute('aria-valuenow', String(previewWidth));
  persistWorkbenchState();
}

function syncFocusedReadingAvailability(available: boolean) {
  readingModeButton.hidden = !available;
  readingModeButton.disabled = !available;
  if (focusedReadingAvailable === available) return;
  focusedReadingAvailable = available;
  void invoke('set_focused_reading_available', { available }).catch(() => undefined);
}

function sidebarIsShown() {
  return sidebarVisible && !sidebarAutoHidden;
}

function cancelSidebarAutoHide() {
  if (sidebarAutoHideTimer !== undefined) window.clearTimeout(sidebarAutoHideTimer);
  sidebarAutoHideTimer = undefined;
}

function scheduleSidebarAutoHide() {
  cancelSidebarAutoHide();
  if (!sidebarIsShown() || sidebarPointerInside || zenMode) return;
  sidebarAutoHideTimer = window.setTimeout(() => {
    sidebarAutoHideTimer = undefined;
    if (!sidebarIsShown() || sidebarPointerInside || zenMode || sidebarResizePointerId !== null || sidebar.contains(document.activeElement)) return;
    sidebarAutoHidden = true;
    applySidebarLayout();
  }, 3000);
}

function setSidebarWidth(width: number, persist = true) {
  sidebarWidth = clampSidebarWidth(width);
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  applySidebarLayout();
}

function toggleSidebar() {
  const wasShown = sidebarIsShown();
  cancelSidebarAutoHide();
  sidebarVisible = !wasShown;
  sidebarAutoHidden = false;
  localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(sidebarVisible));
  applySidebarLayout();
  showToast(sidebarVisible ? 'Files sidebar shown.' : 'Files sidebar hidden.');
}

function setPreviewWidth(width: number, persist = true) {
  previewWidth = clampPreviewWidth(width);
  if (persist) localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidth));
  applyPreviewLayout();
}

function togglePreview() {
  if (!documentState.isMarkdown || isMediaDocument(documentState)) {
    showToast('Preview is available for Markdown documents.', 'error');
    return;
  }
  previewEnabled = !previewEnabled;
  localStorage.setItem(PREVIEW_VISIBLE_KEY, String(previewEnabled));
  viewMode = previewEnabled ? 'split' : 'edit';
  render();
  showToast(previewEnabled ? 'Markdown preview shown.' : 'Markdown preview hidden.');
}

function preferredViewMode(document: Pick<TextDocument, 'isMarkdown'>): ViewMode {
  return document.isMarkdown && previewEnabled ? 'split' : 'edit';
}

function blankDocument(isMarkdown = false): TextDocument {
  return {
    id: `document-${nextDocumentId++}`,
    name: isMarkdown ? 'untitled.md' : 'untitled.txt',
    content: '',
    savedContent: '',
    isMarkdown,
    encoding: 'auto',
    kind: 'text',
    defaultUntitled: true,
  };
}

function isMediaDocument(document: TextDocument) {
  return document.kind === 'pdf' || document.kind === 'image';
}

function documentKindLabel(document: Pick<TextDocument, 'kind' | 'isMarkdown'>) {
  if (document.kind === 'pdf') return 'PDF';
  if (document.kind === 'image') return 'IMG';
  return document.isMarkdown ? 'MD' : 'TXT';
}

function isMarkdownName(name: string) {
  return /\.(?:md|markdown)$/i.test(name);
}

function isTextDocumentDirty(document: Pick<TextDocument, 'content' | 'savedContent' | 'recoveryDraft'>) {
  return document.recoveryDraft === true || document.content !== document.savedContent;
}

function isDirty() {
  if (isMediaDocument(documentState)) return annotationSnapshot(documentState) !== (documentState.savedAnnotations || '');
  return isTextDocumentDirty(documentState);
}

function setCurrentDocument(next: TextDocument) {
  documentState = next;
  activeDocumentId = next.id;
  documents = documents.map((document) => document.id === next.id ? next : document);
}

const saveTargetGenerations = new Map<string, number>();
const documentWriteQueues = new Map<string, Promise<void>>();
// A native Save/Save As dialog can remain open while the idle timer fires.
// Keep autosave and the file watcher from advancing that document's target
// generation underneath the user-initiated operation.
const manualSaveInFlight = new Set<string>();
let watchFilesInFlight = false;

function targetFor(document: Pick<TextDocument, 'id' | 'path'>): SaveTarget {
  return {
    id: document.id,
    path: document.path,
    generation: saveTargetGenerations.get(document.id) || 0,
  };
}

function sameSaveTarget(document: Pick<TextDocument, 'id' | 'path'>, target: SaveTarget) {
  return document.id === target.id
    && document.path === target.path
    && (saveTargetGenerations.get(document.id) || 0) === target.generation;
}

function beginSaveTargetOperation(document: Pick<TextDocument, 'id' | 'path'>): SaveTarget | null {
  const target = targetFor(document);
  const latest = documents.find((candidate) => candidate.id === target.id);
  if (!latest || !sameSaveTarget(latest, target)) return null;
  const operation = { ...target, generation: target.generation + 1 };
  saveTargetGenerations.set(operation.id, operation.generation);
  return operation;
}

function invalidateSaveTarget(id: string) {
  saveTargetGenerations.set(id, (saveTargetGenerations.get(id) || 0) + 1);
}

function enqueueDocumentWrite<Result>(target: SaveTarget, write: (version?: string) => Promise<Result>, requireRecovery = true): Promise<Result | null> {
  const previous = documentWriteQueues.get(target.id) || Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    if (!await persistRecovery() && requireRecovery) throw new Error('Recovery is unavailable. Use Save As to rescue your work to another destination.');
    // A queued write may outlive a close, Save As, rename, or recovery
    // detachment. Check the target immediately before native I/O rather than
    // merely ignoring its late result after it has already written a stale
    // pathname.
    const latest = documents.find((document) => document.id === target.id);
    if (!latest || !sameSaveTarget(latest, target)) return null;
    const written = await write(latest.diskVersion);
    if (requireRecovery && written && typeof written === 'object' && 'diskVersion' in written && typeof written.diskVersion === 'string') {
      const diskVersion = written.diskVersion;
      // Keep the next queued save on our own completed byte version, without
      // reviving a detached binding or overriding a newer external read.
      documents = documents.map((document) => document.id === target.id && document.path === target.path && document.diskVersion === latest.diskVersion
        ? { ...document, diskVersion }
        : document);
      documentState = documents.find((document) => document.id === activeDocumentId) ?? documentState;
    }
    return written;
  });
  const settled = result.then(() => undefined, () => undefined);
  documentWriteQueues.set(target.id, settled);
  void settled.finally(() => {
    if (documentWriteQueues.get(target.id) === settled) documentWriteQueues.delete(target.id);
  });
  return result;
}

function historyFor(document: TextDocument) {
  const existing = histories.get(document.id);
  if (existing) return existing;
  const created = { entries: [document.content], index: 0 };
  histories.set(document.id, created);
  return created;
}

function timelineKey(document: TextDocument) {
  return `${TIMELINE_KEY_PREFIX}${document.path || `draft-${document.id}`}`;
}

function readTimeline(document = documentState): TimelineSnapshot[] {
  if (isMediaDocument(document)) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(timelineKey(document)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is TimelineSnapshot => Boolean(
      entry && typeof entry === 'object'
      && typeof (entry as TimelineSnapshot).id === 'string'
      && typeof (entry as TimelineSnapshot).savedAt === 'number'
      && typeof (entry as TimelineSnapshot).label === 'string'
      && typeof (entry as TimelineSnapshot).content === 'string',
    )).slice(0, MAX_TIMELINE_SNAPSHOTS);
  } catch {
    return [];
  }
}

function captureTimeline(label = 'Snapshot') {
  const target = documentState;
  if (isMediaDocument(target) || target.content.length > MAX_TIMELINE_SNAPSHOT_CHARS) return;
  const existing = readTimeline(target);
  if (existing[0]?.content === target.content) return;
  const next: TimelineSnapshot[] = [{
    id: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    savedAt: Date.now(),
    label,
    content: target.content,
  }, ...existing].slice(0, MAX_TIMELINE_SNAPSHOTS);
  try {
    localStorage.setItem(timelineKey(target), JSON.stringify(next));
  } catch {
    // A full browser profile should never prevent editing or saving a document.
  }
}

function scheduleTimelineSnapshot() {
  if (timelineTimer) window.clearTimeout(timelineTimer);
  const documentId = documentState.id;
  timelineTimer = window.setTimeout(() => {
    if (documentState.id === documentId) captureTimeline('Automatic snapshot');
  }, 18_000);
}

function formatSnapshotTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function openTimeline() {
  if (isMediaDocument(documentState)) {
    showToast('Timeline snapshots are available for text and Markdown documents.', 'info');
    return;
  }
  const snapshots = readTimeline();
  timelineList.replaceChildren();
  if (!snapshots.length) {
    timelineList.append(makeEmpty('Snapshots appear after you edit for a short while or save this document.'));
  } else {
    for (const snapshot of snapshots) {
      const row = document.createElement('div');
      row.className = 'timeline-entry';
      const label = document.createElement('div');
      label.innerHTML = `<strong>${escapeHtml(snapshot.label)}</strong><small>${escapeHtml(formatSnapshotTime(snapshot.savedAt))} · ${wordCount(snapshot.content)} words</small>`;
      const restore = document.createElement('button');
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => restoreTimelineSnapshot(snapshot));
      row.append(label, restore);
      timelineList.append(row);
    }
  }
  timelinePanel.hidden = false;
}

function closeTimeline() {
  timelinePanel.hidden = true;
  if (!isMediaDocument(documentState)) editor.focus();
}

function isHelpSection(value: string | undefined): value is HelpSection {
  return value === 'getting-started' || value === 'shortcuts' || value === 'whats-new' || value === 'about';
}

function helpMarkup(section: HelpSection) {
  switch (section) {
    case 'shortcuts':
      return `
        <section class="help-topic" aria-labelledby="help-topic-title">
          <p class="help-eyebrow">MOVE QUICKLY</p>
          <h2 id="help-topic-title">Keyboard shortcuts</h2>
          <p class="help-lede">The essentials are intentionally familiar on macOS. Use <kbd>Esc</kbd> to dismiss any sheet, menu, Focused Reading, or Zen mode.</p>
          <div class="shortcut-list">
            <div><kbd>⌘N</kbd><span>New text tab</span></div><div><kbd>⇧⌘N</kbd><span>New Markdown tab</span></div>
            <div><kbd>⌘O</kbd><span>Open a file</span></div><div><kbd>⇧⌘O</kbd><span>Open a folder</span></div>
            <div><kbd>⌘S</kbd><span>Save</span></div><div><kbd>⇧⌘S</kbd><span>Save As</span></div>
            <div><kbd>⌘W</kbd><span>Close current tab</span></div><div><kbd>⌘F</kbd><span>Find</span></div>
            <div><kbd>⌘L</kbd><span>Go to line</span></div><div><kbd>⌘K</kbd><span>Quick switcher</span></div>
            <div><kbd>⇧⌘P</kbd><span>Command Palette</span></div><div><kbd>⇧⌘B</kbd><span>Show or hide Files sidebar</span></div>
            <div><kbd>⌘1</kbd><span>Edit view</span></div><div><kbd>⌘2</kbd><span>Split Markdown preview</span></div>
            <div><kbd>⌘3</kbd><span>Markdown preview</span></div><div><kbd>⌘Z</kbd><span>Undo</span></div>
          </div>
          <p class="help-note">Use the Command Palette for less-frequent actions such as export, typography, reflow, themes, and document tools.</p>
        </section>`;
    case 'whats-new':
      return `
        <section class="help-topic" aria-labelledby="help-topic-title">
          <p class="help-eyebrow">RELEASE NOTES</p>
          <h2 id="help-topic-title">What’s new in 1.0.0</h2>
          <p class="help-lede">This is the practical difference between the early <strong>0.1.10</strong> build and the finished <strong>1.0.0</strong> editor.</p>
          <div class="release-history">
            <article class="release-entry current"><div class="release-version">1.0.0</div><div><h3>A complete everyday workspace</h3><ul><li>Reliable, reorderable tabs, an all-tabs list, bulk close commands, and restored workspace state.</li><li>A navigable folder browser with recents, bookmarks, home/Documents shortcuts, and broad text-file opening based on content rather than filename extension.</li><li>Markdown tables, a resizable preview, Markdown-only Focused Reading, clean PDF/HTML export, plus local timeline and recovery.</li><li>PDF and image viewing with local highlight and note annotations.</li><li>Editor fonts, sizes, surfaces, themes, interface scaling, line numbers, and explicit text encoding for opening and saving.</li></ul></div></article>
            <article class="release-entry"><div class="release-version muted">0.1.10</div><div><h3>The foundation</h3><p>Native text and Markdown editing, local save/open, basic preview, files sidebar, and a deliberately lightweight workflow.</p></div></article>
          </div>
        </section>`;
    case 'about':
      return `
        <section class="help-topic" aria-labelledby="help-topic-title">
          <p class="help-eyebrow">ABOUT</p>
          <h2 id="help-topic-title">7TXT ${APP_VERSION}</h2>
          <p class="help-lede">A compact, local-first editor for everyday text and Markdown work, with enough workspace tools to stay out of your way.</p>
          <dl class="about-details"><div><dt>Developer</dt><dd>Orhan Gökçöl</dd></div><div><dt>Copyright</dt><dd>© 2026 Orhan Gökçöl</dd></div><div><dt>License</dt><dd>MIT</dd></div><div><dt>Built with</dt><dd>Tauri, TypeScript, and PDF.js</dd></div></dl>
          <p class="help-note">7TXT keeps documents, recents, recovery data, and annotations on this Mac. It does not require an online account.</p>
        </section>`;
    case 'getting-started':
    default:
      return `
        <section class="help-topic" aria-labelledby="help-topic-title">
          <p class="help-eyebrow">WELCOME TO 7TXT</p>
          <h2 id="help-topic-title">Start simply</h2>
          <p class="help-lede">Open a document, make the space yours, and stay with the writing. 7TXT saves locally and preserves your workspace between launches.</p>
          <ol class="help-steps"><li><span>1</span><div><strong>Open a file or folder</strong><p>Use File → Open, drag files in, or choose a folder for a navigable Files sidebar. Use the star to bookmark folders you revisit.</p></div></li><li><span>2</span><div><strong>Work in tabs</strong><p>Create text or Markdown tabs, drag tabs to reorder them, and use the list button beside the tabs to jump or close several at once.</p></div></li><li><span>3</span><div><strong>Choose the right view</strong><p>Markdown supports Edit, Split, and Preview. Focused Reading is deliberately available only for Markdown; PDFs and images open in the viewer.</p></div></li><li><span>4</span><div><strong>Save with confidence</strong><p>Choose an encoding before reopening or saving, and use the local timeline and recovery copies as a safety net while you write.</p></div></li></ol>
        </section>`;
  }
}

function renderHelp() {
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-help-section]')) {
    const selected = button.dataset.helpSection === helpSection;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  }
  helpContent.innerHTML = helpMarkup(helpSection);
}

function openHelp(section: HelpSection = 'getting-started') {
  closeTransientMenus();
  commandPalette.hidden = true;
  quickSwitcher.hidden = true;
  timelinePanel.hidden = true;
  helpSection = section;
  renderHelp();
  helpPanel.hidden = false;
  window.requestAnimationFrame(() => helpPanel.querySelector<HTMLButtonElement>('[data-action="close-help"]')?.focus());
}

function closeHelp() {
  helpPanel.hidden = true;
  if (!isMediaDocument(documentState)) editor.focus();
}

function restoreTimelineSnapshot(snapshot: TimelineSnapshot) {
  if (!window.confirm(`Restore the ${snapshot.label.toLowerCase()} from ${formatSnapshotTime(snapshot.savedAt)}? Your current text will remain available as a new snapshot.`)) return;
  captureTimeline('Before restore');
  recordContent(snapshot.content);
  closeTimeline();
  showToast('Snapshot restored to the current tab.', 'success');
}

function activateDocument(id: string) {
  const next = documents.find((document) => document.id === id);
  if (!next || id === activeDocumentId) return;
  workspaceEmpty = false;
  documentState = next;
  activeDocumentId = next.id;
  editor.value = next.content;
  secondaryEditor.value = next.content;
  const cursor = Math.min(next.cursor || 0, next.content.length);
  editor.setSelectionRange(cursor, cursor);
  secondaryEditor.setSelectionRange(cursor, cursor);
  viewMode = preferredViewMode(next);
  render();
  if (isMediaDocument(next)) return;
  window.requestAnimationFrame(() => {
    editor.setSelectionRange(cursor, cursor);
    secondaryEditor.setSelectionRange(cursor, cursor);
  });
}

function addDocument(next: TextDocument) {
  documents = workspaceEmpty ? [next] : [...documents, next];
  workspaceEmpty = false;
  histories.set(next.id, { entries: [next.content], index: 0 });
  documentState = next;
  activeDocumentId = next.id;
  editor.value = next.content;
  secondaryEditor.value = next.content;
  viewMode = preferredViewMode(next);
  render();
  if (!isMediaDocument(next)) window.requestAnimationFrame(() => editor.focus());
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

function updateRecent(file: Pick<OpenedDocument, 'name' | 'path' | 'isMarkdown' | 'kind'>) {
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
    )).map((entry) => ({ ...entry, kind: entry.kind === 'pdf' || entry.kind === 'image' ? entry.kind : 'text' as const })).slice(0, MAX_RECENTS);
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSaveTargetError(error: unknown) {
  const message = errorMessage(error);
  // The prefix comes from the native command. Keep the legacy check too so a
  // workspace restored by an older bundled backend can recover cleanly.
  return message.startsWith(SAVE_TARGET_MISSING_PREFIX)
    || /(?:no such file|os error 2|enoent)/i.test(message);
}

function clearExternalChangeForPath(path?: string) {
  if (path) documents = documents.map((document) => document.path === path ? { ...document, conflict: false } : document);
  documentState = documents.find((document) => document.id === activeDocumentId) ?? documentState;
  if (path && externalChange?.path === path) externalChange = null;
}

function markConflict(target: SaveTarget) {
  const latest = documents.find((document) => document.id === target.id);
  if (!latest || !sameSaveTarget(latest, target) || !target.path) return;
  invalidateSaveTarget(target.id);
  const updated = { ...latest, conflict: true };
  documents = documents.map((document) => document.id === target.id ? updated : document);
  if (activeDocumentId === target.id) documentState = updated;
  externalChange = { path: target.path, name: latest.name };
  render();
}

function isSaveConflict(error: unknown) { return errorMessage(error).startsWith('SAVE_CONFLICT:'); }

function isEmptyDefaultUntitledDocument(document: Pick<TextDocument, 'name' | 'isMarkdown' | 'path' | 'content' | 'savedContent' | 'recoveryDraft' | 'defaultUntitled'>) {
  return document.defaultUntitled === true
    && document.name.toLocaleLowerCase() === `untitled.${document.isMarkdown ? 'md' : 'txt'}`
    && !document.path
    && !document.recoveryDraft
    && !document.content
    && !document.savedContent;
}

function detachMissingSaveTarget(target: SaveTarget) {
  const stalePath = target.path;
  if (!stalePath) return false;
  const latest = documents.find((document) => document.id === target.id);
  if (!latest || !sameSaveTarget(latest, target)) return false;
  // Preserve the text and its recovery history, but remove the dead path so
  // autosave does not keep retrying a deleted file. This marker keeps even an
  // empty real file dirty and recoverable across a relaunch.
  const recovered = {
    ...latest,
    conflict: false,
    recoveryOrigin: stalePath,
    path: undefined,
    defaultUntitled: false,
    recoveryDraft: true,
  };
  documents = documents.map((document) => document.id === recovered.id ? recovered : document);
  if (activeDocumentId === recovered.id) documentState = recovered;
  invalidateSaveTarget(recovered.id);
  fileFingerprints.delete(stalePath);
  clearExternalChangeForPath(stalePath);
  // The error path can be the only event before a quit/crash. Persist this
  // detached binding now rather than relying on a later input debounce.
  persistRecovery();
  return true;
}

function readSession(durable?: unknown): RestoredSession | null {
  try {
    const parsed: unknown = durable ?? JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const session = parsed as Partial<RestoredSession>;
    if (!Array.isArray(session.documents) || !session.documents.length) return null;
    const restoredDocuments = session.documents.filter((document): document is SessionDocument => Boolean(
      document && typeof document === 'object'
      && typeof document.name === 'string'
      && typeof document.content === 'string'
      && typeof document.savedContent === 'string'
      && typeof document.isMarkdown === 'boolean'
      && typeof document.encoding === 'string',
    )).map((document) => ({
      ...document,
      kind: 'text' as const,
      recoveryDraft: document.recoveryDraft === true,
      defaultUntitled: document.defaultUntitled === true,
    }));
    const requestedActive = restoredDocuments[Math.max(0, Math.min(Number(session.activeIndex) || 0, restoredDocuments.length - 1))];
    const documents = restoredDocuments.filter((document) => !isEmptyDefaultUntitledDocument(document));
    if (!documents.length) return null;
    return {
      documents,
      activeIndex: Math.max(0, documents.findIndex((document) => document === requestedActive)),
      savedAt: Number(session.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

async function persistRecovery(): Promise<boolean> {
  if (!recoveryReady || recoveryLoadFailed) return false;
  const textDocuments = (workspaceEmpty ? [] : documents)
    .filter((document) => document.kind === 'text')
    // A launch/new tab has no recoverable work. Never infer this from a
    // pathname: a real saved empty untitled file is a recovery draft instead.
    .filter((document) => !isEmptyDefaultUntitledDocument(document));
  const session: RestoredSession = {
    documents: textDocuments.map(({ id, ...document }) => ({ ...document, cursor: id === activeDocumentId ? editor.selectionStart : document.cursor })),
    activeIndex: Math.max(0, textDocuments.findIndex((document) => document.id === activeDocumentId)),
    savedAt: Date.now(),
  };
  try {
    const { savedAt, current } = await recoveryQueue.save(session);
    if (current) required<HTMLElement>('.recovery-status').textContent = `Recovery saved ${new Date(savedAt).toLocaleTimeString()}`;
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(RECOVERY_KEY); } catch { /* native checkpoint acknowledged */ }
    return true;
  } catch (error) {
    required<HTMLElement>('.recovery-status').textContent = `Recovery not saved: ${errorMessage(error)}. Keep this window open.`;
    return false;
  }
}

async function autosaveOpenDocuments() {
  if (autosaveInFlight) return;
  const pending = documents.filter((document) => (
    document.kind === 'text'
    && document.path
    && isTextDocumentDirty(document)
    && !manualSaveInFlight.has(document.id)
    && !document.conflict
    && externalChange?.path !== document.path
  ));
  if (!pending.length) return;
  autosaveInFlight = true;
  let savedCurrent = false;
  let recoveredMissingTarget: TextDocument | null = null;
  let autosaveError: string | null = null;
  try {
    for (const queuedTarget of pending) {
      const target = beginSaveTargetOperation(queuedTarget);
      if (!target?.path) continue;
      const source = documents.find((document) => sameSaveTarget(document, target));
      if (!source) continue;
      const snapshot = source.content;
      try {
        const result = await enqueueDocumentWrite(target, (diskVersion) => invoke<SavedTextFile>('write_file', {
          path: target.path!,
          content: contentForSave(snapshot),
          encoding: source.encoding,
          expectedVersion: diskVersion,
        }));
        if (!result) continue;
        const latest = documents.find((document) => document.id === target.id);
        if (!latest || !sameSaveTarget(latest, target)) continue;
        // A newer edit is still dirty against the snapshot just written to
        // disk; retain it instead of discarding it when this async write ends.
        const saved = {
          ...latest,
          ...result,
          savedContent: snapshot,
          isMarkdown: isMarkdownName(result.name),
          recoveryDraft: false,
          defaultUntitled: false,
        };
        documents = documents.map((document) => document.id === saved.id ? saved : document);
        if (activeDocumentId === saved.id) {
          documentState = saved;
          savedCurrent = latest.content === snapshot;
        }
        await captureFingerprint(result.path);
      } catch (error) {
        if (isSaveConflict(error)) { markConflict(target); continue; }
        if (isMissingSaveTargetError(error)) {
          if (detachMissingSaveTarget(target)) {
            recoveredMissingTarget = source;
          }
          // A stale save failure belongs to an older binding/operation and is
          // already harmless. Never turn it into a repeating autosave toast.
          continue;
        }
        if (sameSaveTarget(documents.find((document) => document.id === target.id) || { id: '', path: undefined }, target)) {
          autosaveError = errorMessage(error);
        }
        break;
      }
    }
  } finally {
    autosaveInFlight = false;
  }
  if (autosaveError) showToast(`Autosave paused: ${autosaveError}`, 'error');
  if (savedCurrent || recoveredMissingTarget) {
    render();
    if (savedCurrent) required<HTMLElement>('.editor-status').textContent = 'Autosaved';
  }
  if (recoveredMissingTarget) {
    showToast(`“${recoveredMissingTarget.name}” is no longer on disk. Its text is kept as an unsaved tab; use Save As to choose a new location.`, 'info');
  }
}

function scheduleRecovery() {
  recoveryQueue.invalidate();
  if (recoveryTimer) window.clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => {
    void persistRecovery();
    recoveryTimer = undefined;
    void autosaveOpenDocuments();
    if (isDirty()) required<HTMLElement>('.editor-status').textContent = documentState.conflict ? 'Conflict — autosave paused' : documentState.path ? 'Autosaving…' : 'Unsaved draft';
  }, 700);
}

function restoreSession(durable?: unknown) {
  const session = readSession(durable);
  if (!session) return;
  const restored = session.documents.map((document) => ({
    ...document,
    ...(isTextDocumentDirty(document) ? { path: undefined, diskVersion: undefined, recoveryOrigin: document.recoveryOrigin ?? document.path, recoveryDraft: true, conflict: false, pinned: false } : {}),
    id: `document-${nextDocumentId++}`,
    content: normaliseLineEndings(document.content),
    savedContent: normaliseLineEndings(document.savedContent),
  }));
  if (!restored.length) return;
  workspaceEmpty = false;
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
  viewMode = active.isMarkdown && previewEnabled ? viewMode : 'edit';
  if (session.savedAt) showToast('Restored your previous workspace and recovery drafts.', 'success');
}

function storedProjectPath() {
  const path = localStorage.getItem(PROJECT_FOLDER_KEY) || savedWorkbenchState.projectFolderPath;
  return path && path.trim() ? path : null;
}

function renderProjectTree() {
  if (folderFilter.value !== folderFilterValue) folderFilter.value = folderFilterValue;
  persistWorkbenchState();
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
    const renamedIds = documents
      .filter((document) => document.path === entry.path)
      .map((document) => document.id);
    documents = documents.map((document) => document.path === entry.path ? { ...document, path, name: name.trim(), isMarkdown: isMarkdownName(name.trim()) } : document);
    for (const id of renamedIds) invalidateSaveTarget(id);
    fileFingerprints.delete(entry.path);
    clearExternalChangeForPath(entry.path);
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
  workspaceEmpty = false;
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
  if (isMediaDocument(documentState)) return;
  if (content === documentState.content) return;
  workspaceEmpty = false;
  setCurrentDocument({ ...documentState, content, defaultUntitled: false });
  if (editor.value !== content) editor.value = content;
  if (secondaryEditor.value !== content) secondaryEditor.value = content;
  const history = historyFor(documentState);
  history.entries = history.entries.slice(0, history.index + 1);
  history.entries.push(content);
  if (history.entries.length > 2500) history.entries.shift(); else history.index += 1;
  if (history.entries.length === 2500) history.index = history.entries.length - 1;
  render();
  scheduleRecovery();
  scheduleTimelineSnapshot();
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

function undo() { if (!isMediaDocument(documentState)) restoreHistory(historyFor(documentState).index - 1); }
function redo() { if (!isMediaDocument(documentState)) restoreHistory(historyFor(documentState).index + 1); }

function annotationSnapshot(document: TextDocument) {
  return JSON.stringify({ version: 1, annotations: document.annotations || [] });
}

function validAnnotation(value: unknown): value is MediaAnnotation {
  if (!value || typeof value !== 'object') return false;
  const annotation = value as Partial<MediaAnnotation>;
  return typeof annotation.id === 'string'
    && (annotation.kind === 'highlight' || annotation.kind === 'note')
    && typeof annotation.x === 'number'
    && typeof annotation.y === 'number'
    && typeof annotation.color === 'string'
    && (annotation.page === undefined || (typeof annotation.page === 'number' && Number.isInteger(annotation.page) && annotation.page > 0));
}

function annotationsFromSidecar(raw: string | null) {
  if (!raw) return [] as MediaAnnotation[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [] as MediaAnnotation[];
    const annotations = (parsed as { annotations?: unknown }).annotations;
    return Array.isArray(annotations) ? annotations.filter(validAnnotation) : [] as MediaAnnotation[];
  } catch {
    return [] as MediaAnnotation[];
  }
}

function mediaDataUrl(document: TextDocument) {
  return document.mediaData && document.mimeType ? `data:${document.mimeType};base64,${document.mediaData}` : '';
}

function base64Bytes(value: string) {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function updateMediaDocument(next: TextDocument) {
  setCurrentDocument(next);
  render();
}

function setMediaAnnotations(annotations: MediaAnnotation[], autosave = true) {
  if (!isMediaDocument(documentState)) return;
  updateMediaDocument({ ...documentState, annotations });
  if (!autosave || !documentState.path) return;
  if (annotationSaveTimer) window.clearTimeout(annotationSaveTimer);
  annotationSaveTimer = window.setTimeout(() => { void saveMediaAnnotations(false); }, 550);
}

async function saveMediaAnnotations(announce = true) {
  const target = documentState;
  if (!isMediaDocument(target) || !target.path) return;
  const annotations = annotationSnapshot(target);
  try {
    await invoke('write_media_annotations', { path: target.path, annotations });
    const latest = documents.find((document) => document.id === target.id);
    if (latest && annotationSnapshot(latest) === annotations) {
      const saved = { ...latest, savedAnnotations: annotations };
      documents = documents.map((document) => document.id === saved.id ? saved : document);
      if (activeDocumentId === saved.id) documentState = saved;
      render();
    }
    if (announce) showToast('Annotations saved next to the original file.', 'success');
  } catch (error) {
    if (announce) showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function loadMediaAnnotations(target: TextDocument) {
  if (!isMediaDocument(target) || !target.path) return;
  try {
    const raw = await invoke<string | null>('read_media_annotations', { path: target.path });
    const annotations = annotationsFromSidecar(raw);
    const savedAnnotations = JSON.stringify({ version: 1, annotations });
    const latest = documents.find((document) => document.id === target.id);
    if (!latest || latest.path !== target.path) return;
    const hydrated = { ...latest, annotations, savedAnnotations };
    documents = documents.map((document) => document.id === hydrated.id ? hydrated : document);
    if (activeDocumentId === hydrated.id) documentState = hydrated;
    render();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

function renderMediaAnnotations() {
  annotationLayer.replaceChildren();
  annotationLayer.dataset.tool = annotationTool;
  const annotations = documentState.annotations || [];
  const visibleAnnotations = annotations.filter((annotation) => documentState.kind !== 'pdf' || annotation.page === undefined || annotation.page === mediaPage);
  for (const annotation of visibleAnnotations) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = `media-annotation ${annotation.kind}${annotationTool === 'select' && annotation.id === selectedAnnotationId ? ' selected' : ''}`;
    marker.dataset.annotationId = annotation.id;
    marker.style.setProperty('--annotation-color', annotation.color);
    marker.style.left = `${Math.max(0, Math.min(1, annotation.x)) * 100}%`;
    marker.style.top = `${Math.max(0, Math.min(1, annotation.y)) * 100}%`;
    if (annotation.kind === 'highlight') {
      marker.style.width = `${Math.max(.02, Math.min(.95, annotation.width || .22)) * 100}%`;
      marker.style.height = `${Math.max(.02, Math.min(.95, annotation.height || .07)) * 100}%`;
      marker.title = annotation.text || 'Highlight';
    } else {
      marker.textContent = '•';
      marker.title = annotation.text || 'Note';
      marker.setAttribute('aria-label', marker.title);
    }
    annotationLayer.append(marker);
  }
  annotationList.replaceChildren();
  if (!annotations.length) {
    annotationList.append(makeEmpty('Choose Highlight or Note, then click the document.'));
  } else {
    annotations.forEach((annotation, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = annotation.id === selectedAnnotationId ? 'selected' : '';
      item.dataset.annotationId = annotation.id;
      const page = documentState.kind === 'pdf' && annotation.page ? `Page ${annotation.page} · ` : '';
      item.innerHTML = `<span style="--annotation-color:${escapeHtml(annotation.color)}"></span><strong>${page}${annotation.kind === 'highlight' ? 'Highlight' : 'Note'} ${index + 1}</strong><small>${escapeHtml(annotation.text || (annotation.kind === 'highlight' ? 'Drawn highlight' : 'Untitled note'))}</small>`;
      annotationList.append(item);
    });
  }
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-annotation-tool]')) {
    const selected = button.dataset.annotationTool === annotationTool;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-annotation-color]')) {
    const selected = button.dataset.annotationColor === annotationColor;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function renderMediaChrome() {
  const isPdf = documentState.kind === 'pdf';
  required<HTMLElement>('.media-kind-chip').textContent = documentKindLabel(documentState);
  required<HTMLElement>('.media-label').textContent = documentState.name;
  required<HTMLElement>('.media-page-status').textContent = isPdf ? 'PDF document' : 'Image';
  required<HTMLElement>('.media-page-count').textContent = isPdf && mediaPageCount ? `${mediaPage} / ${mediaPageCount}` : '';
  required<HTMLButtonElement>('[data-action="media-previous-page"]').disabled = !isPdf || mediaPage <= 1;
  required<HTMLButtonElement>('[data-action="media-next-page"]').disabled = !isPdf || mediaPage >= mediaPageCount;
  required<HTMLButtonElement>('.media-zoom-label').textContent = `${Math.round(mediaZoom * 100)}%`;
}

function renderImageDocument(target: TextDocument) {
  const source = mediaDataUrl(target);
  mediaImage.hidden = false;
  pdfCanvas.hidden = true;
  if (mediaImage.dataset.path !== target.path || mediaImage.src !== source) {
    mediaImage.dataset.path = target.path || '';
    mediaImage.src = source;
    mediaImage.onload = () => {
      if (documentState.id !== target.id) return;
      const availableWidth = Math.max(280, mediaScroller.clientWidth - 58);
      const availableHeight = Math.max(260, mediaScroller.clientHeight - 58);
      const fit = Math.min(1, availableWidth / mediaImage.naturalWidth, availableHeight / mediaImage.naturalHeight);
      mediaImage.style.width = `${Math.max(120, Math.round(mediaImage.naturalWidth * fit * mediaZoom))}px`;
      mediaImage.style.height = 'auto';
      mediaEmpty.hidden = true;
      renderMediaAnnotations();
    };
    mediaImage.onerror = () => { mediaEmpty.hidden = false; mediaEmpty.textContent = 'This image cannot be previewed.'; };
  } else if (mediaImage.naturalWidth) {
    const availableWidth = Math.max(280, mediaScroller.clientWidth - 58);
    const availableHeight = Math.max(260, mediaScroller.clientHeight - 58);
    const fit = Math.min(1, availableWidth / mediaImage.naturalWidth, availableHeight / mediaImage.naturalHeight);
    mediaImage.style.width = `${Math.max(120, Math.round(mediaImage.naturalWidth * fit * mediaZoom))}px`;
    mediaEmpty.hidden = true;
  }
  renderMediaChrome();
  renderMediaAnnotations();
}

async function renderPdfDocument(target: TextDocument) {
  const token = ++mediaRenderToken;
  mediaImage.hidden = true;
  pdfCanvas.hidden = false;
  mediaEmpty.hidden = false;
  mediaEmpty.textContent = 'Rendering PDF…';
  try {
    if (mediaPdfPath !== target.path || !mediaPdf) {
      mediaPdf?.destroy();
      mediaPdf = await getDocument({ data: base64Bytes(target.mediaData || '') }).promise;
      mediaPdfPath = target.path;
      mediaPage = 1;
      mediaPageCount = mediaPdf.numPages;
    }
    if (token !== mediaRenderToken || documentState.id !== target.id || !mediaPdf) return;
    mediaPage = Math.max(1, Math.min(mediaPage, mediaPdf.numPages));
    const page = await mediaPdf.getPage(mediaPage);
    if (token !== mediaRenderToken || documentState.id !== target.id) return;
    const natural = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(320, mediaScroller.clientWidth - 58);
    const availableHeight = Math.max(320, mediaScroller.clientHeight - 58);
    const fit = Math.min(1.4, Math.max(.45, Math.min(availableWidth / natural.width, availableHeight / natural.height)));
    const pixelRatio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: fit * mediaZoom * pixelRatio });
    pdfCanvas.width = Math.max(1, Math.floor(viewport.width));
    pdfCanvas.height = Math.max(1, Math.floor(viewport.height));
    pdfCanvas.style.width = `${Math.round(viewport.width / pixelRatio)}px`;
    pdfCanvas.style.height = `${Math.round(viewport.height / pixelRatio)}px`;
    const context = pdfCanvas.getContext('2d');
    if (!context) throw new Error('7TXT could not prepare the PDF canvas.');
    await page.render({ canvasContext: context, viewport }).promise;
    if (token !== mediaRenderToken || documentState.id !== target.id) return;
    mediaEmpty.hidden = true;
    renderMediaChrome();
    renderMediaAnnotations();
  } catch (error) {
    if (token !== mediaRenderToken) return;
    mediaEmpty.hidden = false;
    mediaEmpty.textContent = `PDF preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
    mediaPageCount = 0;
    renderMediaChrome();
  }
}

function renderMediaDocument() {
  const target = documentState;
  if (!isMediaDocument(target)) return;
  mediaPane.hidden = false;
  const key = `${target.id}:${target.kind}:${mediaPage}:${mediaZoom}:${mediaScroller.clientWidth}:${mediaScroller.clientHeight}`;
  if (key === mediaLastRenderKey) {
    renderMediaChrome();
    renderMediaAnnotations();
    return;
  }
  mediaLastRenderKey = key;
  if (target.kind === 'pdf') void renderPdfDocument(target);
  else renderImageDocument(target);
}

function setMediaZoom(next: number) {
  if (!isMediaDocument(documentState)) return;
  mediaZoom = Math.max(.5, Math.min(3, next));
  mediaLastRenderKey = '';
  renderMediaDocument();
}

function changePdfPage(delta: number) {
  if (documentState.kind !== 'pdf' || !mediaPdf) return;
  mediaPage = Math.max(1, Math.min(mediaPdf.numPages, mediaPage + delta));
  mediaLastRenderKey = '';
  renderMediaDocument();
}

function annotationPosition(event: PointerEvent) {
  const bounds = mediaStage.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function mediaAnnotationById(id: string | null) {
  return documentState.annotations?.find((annotation) => annotation.id === id);
}

function setAnnotationTool(next: string | undefined) {
  if (next === 'select' || next === 'highlight' || next === 'note') annotationTool = next;
  renderMediaAnnotations();
}

function addMediaNote(event: PointerEvent) {
  if (!isMediaDocument(documentState) || annotationTool !== 'note') return;
  const { x, y } = annotationPosition(event);
  const text = window.prompt('Note text (optional):') || '';
  const annotation: MediaAnnotation = {
    id: `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: 'note',
    x,
    y,
    text,
    color: annotationColor,
    page: documentState.kind === 'pdf' ? mediaPage : undefined,
  };
  selectedAnnotationId = annotation.id;
  setMediaAnnotations([...(documentState.annotations || []), annotation]);
}

function startMediaHighlight(event: PointerEvent) {
  if (!isMediaDocument(documentState) || annotationTool !== 'highlight') return;
  const { x, y } = annotationPosition(event);
  const annotation: MediaAnnotation = {
    id: `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: 'highlight',
    x,
    y,
    width: .001,
    height: .001,
    color: annotationColor,
    page: documentState.kind === 'pdf' ? mediaPage : undefined,
  };
  selectedAnnotationId = annotation.id;
  setMediaAnnotations([...(documentState.annotations || []), annotation], false);
  annotationDrag = { mode: 'draw', id: annotation.id, pointerId: event.pointerId, x, y };
  annotationLayer.setPointerCapture(event.pointerId);
}

function deleteSelectedMediaAnnotation() {
  if (!isMediaDocument(documentState) || !selectedAnnotationId) return;
  setMediaAnnotations((documentState.annotations || []).filter((annotation) => annotation.id !== selectedAnnotationId));
  selectedAnnotationId = null;
  renderMediaAnnotations();
}

function editSelectedMediaAnnotation() {
  if (!isMediaDocument(documentState) || !selectedAnnotationId) return;
  const target = mediaAnnotationById(selectedAnnotationId);
  if (!target) return;
  const label = target.kind === 'note' ? 'Note text:' : 'Highlight label (optional):';
  const text = window.prompt(label, target.text || '');
  if (text === null) return;
  setMediaAnnotations((documentState.annotations || []).map((annotation) => annotation.id === target.id ? { ...annotation, text } : annotation));
}

function clearMediaAnnotations() {
  if (!isMediaDocument(documentState) || !(documentState.annotations || []).length) return;
  if (!window.confirm(`Clear all annotations from “${documentState.name}”? The original file will not be changed.`)) return;
  selectedAnnotationId = null;
  setMediaAnnotations([]);
}

function render() {
  const isMedia = isMediaDocument(documentState);
  if (!isMedia && !documentState.isMarkdown && viewMode !== 'edit') viewMode = 'edit';
  if (!isMedia && documentState.isMarkdown && !previewEnabled && viewMode !== 'edit') viewMode = 'edit';
  if (isMedia || !documentState.isMarkdown) readingMode = false;
  const hasMarkdownPreview = !isMedia && documentState.isMarkdown;
  shell.dataset.mode = viewMode;
  shell.classList.toggle('text-document', documentState.kind === 'text' && !documentState.isMarkdown);
  shell.classList.toggle('media-document', isMedia);
  shell.classList.toggle('editor-split', editorSplit);
  shell.classList.toggle('empty-workspace', workspaceEmpty);
  shell.classList.toggle('zen-mode', zenMode);
  shell.classList.toggle('reading-mode', readingMode && documentState.isMarkdown && !isMedia);
  syncFocusedReadingAvailability(!workspaceEmpty && documentState.isMarkdown && !isMedia);
  mediaPane.hidden = !isMedia;
  emptyWorkspaceMessage.hidden = !workspaceEmpty;
  editor.disabled = workspaceEmpty;
  secondaryEditor.disabled = workspaceEmpty;
  previewPane.hidden = !hasMarkdownPreview;
  previewResizer.hidden = !hasMarkdownPreview;
  viewSwitch.hidden = !hasMarkdownPreview;
  if (editor.value !== documentState.content) editor.value = documentState.content;
  if (secondaryEditor.value !== documentState.content) secondaryEditor.value = documentState.content;
  document.title = `${isDirty() ? '• ' : ''}${documentState.name} — 7TXT`;
  required<HTMLElement>('.format-chip').textContent = workspaceEmpty ? '—' : documentKindLabel(documentState);
  required<HTMLElement>('.format-chip').hidden = workspaceEmpty;
  required<HTMLElement>('.format-chip').classList.toggle('markdown', documentState.isMarkdown);
  required<HTMLElement>('.editor-mode-label').textContent = workspaceEmpty ? 'No file open' : documentState.isMarkdown ? 'Markdown' : documentState.kind === 'text' ? 'Plain text' : documentState.kind === 'pdf' ? 'PDF document' : 'Image';
  required<HTMLElement>('.editor-status').textContent = workspaceEmpty ? '' : isDirty() ? (isMedia ? 'Unsaved annotations' : 'Unsaved changes') : documentState.path ? 'Saved locally' : 'Ready';
  required<HTMLElement>('.status-stats').textContent = workspaceEmpty ? 'No open files' : isMedia ? `${documentState.kind === 'pdf' ? 'PDF' : 'Image'} · ${documentState.annotations?.length || 0} annotation${documentState.annotations?.length === 1 ? '' : 's'}` : documentStats(documentState.content);
  required<HTMLElement>('.preview-kind').textContent = documentState.isMarkdown ? 'MARKDOWN' : 'TEXT';
  encodingSelect.value = documentState.encoding;
  encodingSelect.closest<HTMLElement>('.encoding-control')?.toggleAttribute('hidden', isMedia);
  reopenEncodingButton.hidden = isMedia;
  reopenEncodingButton.disabled = isMedia || !documentState.path;
  for (const action of app!.querySelectorAll<HTMLElement>('.markdown-actions')) action.hidden = !documentState.isMarkdown;
  const conflicted = documents.find((document) => document.id === activeDocumentId && document.conflict && document.path)
    ?? documents.find((document) => document.conflict && document.path);
  externalChange = conflicted ? { path: conflicted.path!, name: conflicted.name } : null;
  externalChangeBar.hidden = !externalChange;
  required<HTMLElement>('.external-change span').textContent = externalChange ? `${externalChange.name} changed on disk. Autosave paused.` : '';
  required<HTMLElement>('.recovered-notice').hidden = !documentState.recoveryDraft;
  required<HTMLElement>('.recovered-notice span').textContent = `Recovered draft${documentState.recoveryOrigin ? ` — ${documentState.recoveryOrigin}` : ''}`;
  required<HTMLElement>('.status-help').textContent = isMedia ? 'Click Highlight or Note, then click the canvas · ⌘S Save notes' : documentState.isMarkdown ? '⌘1 Edit · ⌘2 Split · ⌘3 Preview' : '⌘O Open · ⌘S Save · ⌘F Find';
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-mode-button]')) {
    button.hidden = isMedia;
    button.classList.toggle('selected', !isMedia && button.dataset.modeButton === viewMode);
  }
  applyPreviewLayout();
  if (hasMarkdownPreview) {
    preview.innerHTML = renderMarkdown(documentState.content);
  } else if (!isMedia) {
    preview.replaceChildren();
  } else {
    void renderMediaDocument();
  }
  renderTabs();
  renderOutline();
  renderRecents();
  renderLineNumbers();
  updateCursor();
  renderWritingProgress();
  persistWorkbenchState();
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
  // Rebuilding the tab controls happens after ordinary editing actions too.
  // Preserve an open switcher through that work so the user can close several
  // tabs in sequence; explicit activation, outside click, and Escape still
  // dismiss it through their own handlers.
  const keepOpenTabsMenu = !openTabsMenu.hidden;
  tabList.replaceChildren();
  openTabsList.replaceChildren();
  openTabsToggle.hidden = workspaceEmpty || documents.length === 0;
  openTabsMenu.hidden = !(keepOpenTabsMenu && !workspaceEmpty && documents.length > 0);
  updateTabWidth();
  if (workspaceEmpty) return;
  for (const document of documents) {
    const tab = window.document.createElement('div');
    const activate = window.document.createElement('button');
    const close = window.document.createElement('button');
    const dirty = isMediaDocument(document)
      ? annotationSnapshot(document) !== (document.savedAnnotations || '')
      : isTextDocumentDirty(document);
    tab.className = `document-tab${document.id === activeDocumentId ? ' active' : ''}${dirty ? ' dirty' : ''}`;
    tab.dataset.tabId = document.id;
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

    const menuRow = window.document.createElement('div');
    menuRow.className = `open-tabs-row${document.id === activeDocumentId ? ' active' : ''}`;
    const menuActivate = window.document.createElement('button');
    menuActivate.className = 'open-tabs-activate';
    menuActivate.textContent = document.name;
    menuActivate.title = document.path || document.name;
    menuActivate.setAttribute('role', 'menuitem');
    menuActivate.addEventListener('click', () => { openTabsMenu.hidden = true; activateDocument(document.id); });
    const menuClose = window.document.createElement('button');
    menuClose.className = 'open-tabs-close';
    menuClose.textContent = '×';
    menuClose.title = `Close ${document.name}`;
    menuClose.setAttribute('aria-label', menuClose.title);
    menuClose.addEventListener('click', () => closeDocument(document.id));
    menuRow.append(menuActivate, menuClose);
    openTabsList.append(menuRow);

    tab.addEventListener('pointerdown', (event) => beginTabDrag(event, document.id));
  }

  const menuActions = document.createElement('div');
  menuActions.className = 'open-tabs-actions';
  const closeOthers = document.createElement('button');
  closeOthers.type = 'button';
  closeOthers.className = 'open-tabs-action';
  closeOthers.textContent = 'Close all except current';
  closeOthers.title = `Close every tab except ${documentState.name}`;
  closeOthers.disabled = documents.length <= 1;
  closeOthers.setAttribute('role', 'menuitem');
  closeOthers.addEventListener('click', closeAllExceptCurrent);
  const closeAll = document.createElement('button');
  closeAll.type = 'button';
  closeAll.className = 'open-tabs-action destructive';
  closeAll.textContent = 'Close all';
  closeAll.title = 'Close every open tab';
  closeAll.setAttribute('role', 'menuitem');
  closeAll.addEventListener('click', closeAllDocuments);
  menuActions.append(closeOthers, closeAll);
  openTabsList.append(menuActions);
}

function updateTabWidth() {
  const tabCount = Math.max(documents.length, 1);
  const availableWidth = tabList.clientWidth;
  const requiredWidth = (tabWidth: number) => tabCount * tabWidth + Math.max(0, tabCount - 1) * TAB_GAP;
  const tabWidth = TAB_WIDTHS.find((candidate) => requiredWidth(candidate) <= availableWidth)
    ?? TAB_WIDTHS[TAB_WIDTHS.length - 1];
  tabList.style.setProperty('--tab-width', `${tabWidth}px`);
}

function clearTabDropMarkers() {
  for (const item of tabList.querySelectorAll('.document-tab')) item.classList.remove('dragging', 'drop-before', 'drop-after');
}

function beginTabDrag(event: PointerEvent, id: string) {
  if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.tab-close'))) return;
  tabDrag = { id, pointerId: event.pointerId, startX: event.clientX, dragging: false };
}

function trackTabDrag(event: PointerEvent) {
  const active = tabDrag;
  if (!active || active.pointerId !== event.pointerId) return;
  if (!active.dragging && Math.abs(event.clientX - active.startX) < 7) return;
  active.dragging = true;
  event.preventDefault();
  clearTabDropMarkers();
  const dragged = tabList.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active.id)}"]`);
  dragged?.classList.add('dragging');
  const target = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.document-tab');
  if (!target || target.dataset.tabId === active.id) return;
  const before = event.clientX < target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2;
  target.classList.add(before ? 'drop-before' : 'drop-after');
}

function finishTabDrag(event: PointerEvent) {
  const active = tabDrag;
  if (!active || active.pointerId !== event.pointerId) return;
  tabDrag = null;
  if (!active.dragging) return;
  event.preventDefault();
  const target = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.document-tab');
  const targetId = target?.dataset.tabId;
  if (target && targetId && targetId !== active.id) {
    const before = event.clientX < target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2;
    reorderTabs(active.id, targetId, before);
  }
  clearTabDropMarkers();
}

function reorderTabs(movedId: string, targetId: string, before: boolean) {
  if (movedId === targetId) return;
  const moving = documents.find((document) => document.id === movedId);
  const target = documents.find((document) => document.id === targetId);
  if (!moving || !target) return;
  const ordered = documents.filter((document) => document.id !== movedId);
  let targetIndex = ordered.findIndex((document) => document.id === targetId);
  if (!before) targetIndex += 1;
  ordered.splice(Math.max(0, targetIndex), 0, moving);
  documents = ordered;
  renderTabs();
  scheduleRecovery();
}

function toggleOpenTabsMenu() {
  const shouldOpen = openTabsMenu.hidden;
  closeTransientMenus();
  openTabsMenu.hidden = !shouldOpen;
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

function renderParagraph(lines: string[]) {
  return lines.map((line, index) => {
    const hardBreak = /(?: {2,}|\\)$/.test(line);
    const content = hardBreak ? line.replace(/(?: {2,}|\\)$/, '') : line;
    const separator = index === lines.length - 1 ? '' : hardBreak ? '<br />' : ' ';
    return `${renderInline(content.trim())}${separator}`;
  }).join('');
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  const content = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return content.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function markdownTableRule(line: string) {
  const cells = markdownTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAlignment(rule: string) {
  if (/^:-+:$/.test(rule)) return 'center';
  if (/^-+:$/.test(rule)) return 'right';
  if (/^:-+$/.test(rule)) return 'left';
  return '';
}

function renderMarkdownTable(headerLine: string, ruleLine: string, rows: string[]) {
  const headers = markdownTableCells(headerLine);
  const rules = markdownTableCells(ruleLine);
  const header = headers.map((cell, index) => `<th${tableAlignment(rules[index] || '') ? ` style="text-align:${tableAlignment(rules[index] || '')}"` : ''}>${renderInline(cell)}</th>`).join('');
  const body = rows.map((line) => {
    const cells = markdownTableCells(line);
    return `<tr>${headers.map((_, index) => `<td${tableAlignment(rules[index] || '') ? ` style="text-align:${tableAlignment(rules[index] || '')}"` : ''}>${renderInline(cells[index] || '')}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="markdown-table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
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
    if (line.includes('|') && index + 1 < lines.length && markdownTableRule(lines[index + 1])) {
      const rows: string[] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(lines[index]);
        index += 1;
      }
      output.push(renderMarkdownTable(line, lines[index - rows.length - 1], rows));
      continue;
    }
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
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s+|```|>\s?|(?:[-*+]\s+|\d+\.\s+))/.test(lines[index]) && !(lines[index].includes('|') && index + 1 < lines.length && markdownTableRule(lines[index + 1]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${renderParagraph(paragraph)}</p>`);
  }
  return output.join('') || '<p class="preview-empty">Start writing Markdown to see a clean reading preview.</p>';
}

function updateCursor() {
  if (isMediaDocument(documentState)) {
    required<HTMLElement>('.status-cursor').textContent = 'Media view';
    return;
  }
  const source = activeEditor();
  syncLineNumbers(source);
  const before = source.value.slice(0, source.selectionStart);
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  if (documentState.cursor !== source.selectionStart) {
    documentState = { ...documentState, cursor: source.selectionStart };
    documents = documents.map((document) => document.id === activeDocumentId ? documentState : document);
  }
  required<HTMLElement>('.status-cursor').textContent = `Ln ${line}, Col ${column}`;
}

function renderLineNumbers() {
  for (const [surface, gutter] of [[editor, lineNumbers], [secondaryEditor, secondaryLineNumbers]] as const) {
    const lineCount = Math.max(1, surface.value.split('\n').length);
    gutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
    gutter.parentElement?.style.setProperty('--line-number-digits', String(String(lineCount).length));
    gutter.scrollTop = surface.scrollTop;
  }
}

function syncLineNumbers(surface: HTMLTextAreaElement) {
  (surface === secondaryEditor ? secondaryLineNumbers : lineNumbers).scrollTop = surface.scrollTop;
}

function goToLine(line: number) {
  if (isMediaDocument(documentState)) return;
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
  if (isMediaDocument(documentState)) return;
  if (documentState.isMarkdown && next !== 'edit' && !previewEnabled) {
    previewEnabled = true;
    localStorage.setItem(PREVIEW_VISIBLE_KEY, 'true');
  }
  viewMode = documentState.isMarkdown ? next : 'edit';
  render();
}

async function openFile() {
  try {
    const result = await invoke<OpenedDocument | null>('open_file', { encoding: documentState.encoding });
    if (!result) return;
    openResultInTab(result);
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function openRecent(entry: RecentEntry) {
  try {
    const result = await invoke<OpenedDocument>('open_recent', { path: entry.path, encoding: documentState.encoding });
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
    const result = await invoke<OpenedDocument>('open_recent', { path, encoding: documentState.encoding });
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
    const result = await invoke<OpenedDocument>('open_recent', { path, encoding: documentState.encoding });
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

function openResultInTab(result: OpenedDocument, replacePristineBlank = false) {
  workspaceEmpty = false;
  const normalised = { ...result, content: normaliseLineEndings(result.content) };
  updateRecent(normalised);
  const alreadyOpen = documents.find((document) => document.path === normalised.path);
  if (alreadyOpen) {
    activateDocument(alreadyOpen.id);
    showToast(`${normalised.name} is already open.`, 'info');
    return;
  }
  const next: TextDocument = {
    id: `document-${nextDocumentId++}`,
    ...normalised,
    savedContent: normalised.content,
    annotations: normalised.kind === 'text' ? undefined : [],
    savedAnnotations: normalised.kind === 'text' ? undefined : JSON.stringify({ version: 1, annotations: [] }),
  };
  const onlyPristineBlank = documents.length === 1
    && isEmptyDefaultUntitledDocument(documents[0]);
  if (replacePristineBlank && onlyPristineBlank) {
    histories.delete(documents[0].id);
    documents = [next];
    histories.set(next.id, { entries: [next.content], index: 0 });
    documentState = next;
    activeDocumentId = next.id;
    editor.value = next.content;
    viewMode = preferredViewMode(next);
    render();
    if (!isMediaDocument(next)) window.requestAnimationFrame(() => editor.focus());
    void captureFingerprint(normalised.path);
    void loadMediaAnnotations(next);
    showToast(`Opened ${normalised.name}.`, 'success');
    return;
  }
  addDocument(next);
  void captureFingerprint(normalised.path);
  void loadMediaAnnotations(next);
  showToast(`Opened ${normalised.name} in a new tab.`, 'success');
}

async function saveAs() {
  workspaceEmpty = false;
  if (isMediaDocument(documentState)) {
    await saveMediaAnnotations(true);
    return;
  }
  const source = documentState;
  if (manualSaveInFlight.has(source.id)) return;
  manualSaveInFlight.add(source.id);
  const target = beginSaveTargetOperation(source);
  if (!target) {
    manualSaveInFlight.delete(source.id);
    return;
  }
  const snapshot = source.content;
  try {
    const result = await enqueueDocumentWrite(target, () => invoke<SavedTextFile | null>('save_as', {
      suggestedName: source.name,
      content: contentForSave(snapshot),
      encoding: source.encoding,
    }), false);
    if (!result) return;
    const latest = documents.find((document) => document.id === target.id);
    if (!latest || !sameSaveTarget(latest, target)) return;
    // If the user typed while the native Save As sheet was open, bind the
    // chosen destination but keep those newer edits dirty against the exact
    // snapshot that was written.
    const saved = {
      ...latest,
      ...result,
      savedContent: snapshot,
      isMarkdown: isMarkdownName(result.name),
      recoveryDraft: false,
      defaultUntitled: false,
    };
    documents = documents.map((document) => document.id === saved.id ? saved : document);
    if (activeDocumentId === saved.id) documentState = saved;
    updateRecent({ ...result, isMarkdown: saved.isMarkdown, kind: 'text' });
    clearExternalChangeForPath(target.path);
    clearExternalChangeForPath(result.path);
    render();
    await captureFingerprint(result.path);
    if (activeDocumentId === saved.id) captureTimeline('Saved');
    showToast(`Saved ${result.name}.`, 'success');
  } catch (error) {
    const latest = documents.find((document) => document.id === target.id);
    if (latest && sameSaveTarget(latest, target)) showToast(errorMessage(error), 'error');
  } finally {
    manualSaveInFlight.delete(source.id);
  }
}

async function save() {
  if (isMediaDocument(documentState)) {
    await saveMediaAnnotations(true);
    return;
  }
  if (!documentState.path) { await saveAs(); return; }
  if (documentState.conflict) { showToast('Resolve the disk conflict or use Save As before saving.', 'info'); render(); return; }
  const source = documentState;
  if (manualSaveInFlight.has(source.id)) return;
  manualSaveInFlight.add(source.id);
  const target = beginSaveTargetOperation(source);
  if (!target?.path) {
    manualSaveInFlight.delete(source.id);
    return;
  }
  const snapshot = source.content;
  try {
    const result = await enqueueDocumentWrite(target, (diskVersion) => invoke<SavedTextFile>('write_file', {
      path: target.path!,
      content: contentForSave(snapshot),
      encoding: source.encoding,
      expectedVersion: diskVersion,
    }));
    if (!result) return;
    const latest = documents.find((document) => document.id === target.id);
    if (!latest || !sameSaveTarget(latest, target)) return;
    const saved = {
      ...latest,
      ...result,
      savedContent: snapshot,
      isMarkdown: isMarkdownName(result.name),
      recoveryDraft: false,
      defaultUntitled: false,
    };
    documents = documents.map((document) => document.id === saved.id ? saved : document);
    if (activeDocumentId === saved.id) documentState = saved;
    updateRecent({ ...result, isMarkdown: saved.isMarkdown, kind: 'text' });
    clearExternalChangeForPath(target.path);
    clearExternalChangeForPath(result.path);
    render();
    await captureFingerprint(result.path);
    if (activeDocumentId === saved.id) captureTimeline('Saved');
    showToast('Saved locally.', 'success');
  } catch (error) {
    if (isSaveConflict(error)) { markConflict(target); return; }
    if (isMissingSaveTargetError(error)) {
      if (detachMissingSaveTarget(target)) {
        render();
        showToast(`“${source.name}” is no longer on disk. Its text is kept here; Save will now choose a new location.`, 'info');
      }
      return;
    }
    const latest = documents.find((document) => document.id === target.id);
    if (latest && sameSaveTarget(latest, target)) showToast(errorMessage(error), 'error');
  } finally {
    manualSaveInFlight.delete(source.id);
  }
}

function closeDocument(id = activeDocumentId) {
  const target = documents.find((document) => document.id === id);
  if (!target) return;
  const targetDirty = isMediaDocument(target)
    ? annotationSnapshot(target) !== (target.savedAnnotations || '')
    : isTextDocumentDirty(target);
  // Recovery drafts deliberately have no path. They still contain work the
  // user may want to Save As, so treat them like any other dirty tab here.
  if (targetDirty && !window.confirm(`Close “${target.name}” without saving its changes?`)) return;
  const index = documents.findIndex((document) => document.id === id);
  histories.delete(id);
  saveTargetGenerations.delete(id);
  manualSaveInFlight.delete(id);
  clearExternalChangeForPath(target.path);
  if (documents.length === 1) {
    const blank = blankDocument();
    documents = [blank];
    documentState = blank;
    activeDocumentId = blank.id;
    workspaceEmpty = true;
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
      viewMode = preferredViewMode(next);
    }
  }
  render();
  scheduleRecovery();
  showToast('Tab closed.');
}

function closeAllExceptCurrent() {
  const currentId = activeDocumentId;
  const targets = documents.filter((document) => document.id !== currentId);
  if (!targets.length) {
    showToast('There are no other tabs to close.');
    return;
  }
  const changedSavedFiles = targets.filter((document) => {
    const dirty = isMediaDocument(document)
      ? annotationSnapshot(document) !== (document.savedAnnotations || '')
      : isTextDocumentDirty(document);
    return dirty;
  });
  if (changedSavedFiles.length && !window.confirm(`Close ${targets.length} other tab${targets.length === 1 ? '' : 's'} without saving ${changedSavedFiles.length === 1 ? 'its changes' : 'their changes'}?`)) return;
  for (const document of targets) {
    histories.delete(document.id);
    saveTargetGenerations.delete(document.id);
    manualSaveInFlight.delete(document.id);
    clearExternalChangeForPath(document.path);
  }
  documents = documents.filter((document) => document.id === currentId);
  documentState = documents[0];
  activeDocumentId = documentState.id;
  editor.value = documentState.content;
  secondaryEditor.value = documentState.content;
  viewMode = preferredViewMode(documentState);
  render();
  scheduleRecovery();
  showToast(`Closed ${targets.length} other tab${targets.length === 1 ? '' : 's'}.`);
}

function closeAllDocuments() {
  const targets = [...documents];
  const changedSavedFiles = targets.filter((document) => {
    const dirty = isMediaDocument(document)
      ? annotationSnapshot(document) !== (document.savedAnnotations || '')
      : isTextDocumentDirty(document);
    return dirty;
  });
  if (changedSavedFiles.length && !window.confirm(`Close all ${targets.length} tab${targets.length === 1 ? '' : 's'} without saving ${changedSavedFiles.length === 1 ? 'its changes' : 'their changes'}?`)) return;
  for (const document of targets) {
    histories.delete(document.id);
    saveTargetGenerations.delete(document.id);
    manualSaveInFlight.delete(document.id);
  }
  externalChange = null;
  const blank = blankDocument();
  documents = [blank];
  documentState = blank;
  activeDocumentId = blank.id;
  workspaceEmpty = true;
  histories.set(blank.id, { entries: [''], index: 0 });
  editor.value = blank.content;
  secondaryEditor.value = blank.content;
  viewMode = 'edit';
  render();
  scheduleRecovery();
  showToast(`Closed ${targets.length} tab${targets.length === 1 ? '' : 's'}.`);
}

function reopenWithEncoding() {
  const target = documentState;
  if (isMediaDocument(target)) return;
  if (!target.path) return;
  const targetRef = targetFor(target);
  const contentAtRequest = target.content;
  const savedContentAtRequest = target.savedContent;
  if (isTextDocumentDirty(target) && !window.confirm(`Reload “${target.name}” from disk and discard its unsaved changes?`)) return;
  void (async () => {
    try {
      const result = await invoke<OpenedDocument>('open_recent', { path: target.path, encoding: target.encoding });
      const content = normaliseLineEndings(result.content);
      const latest = documents.find((document) => document.id === targetRef.id);
      if (!latest
        || !sameSaveTarget(latest, targetRef)
        || latest.content !== contentAtRequest
        || latest.savedContent !== savedContentAtRequest) return;
      const reopened = {
        ...latest,
        ...result,
        content,
        savedContent: content,
        recoveryDraft: false,
        defaultUntitled: false,
      };
      if (documentState.id === targetRef.id) commitDocument(reopened);
      else {
        documents = documents.map((document) => document.id === targetRef.id ? reopened : document);
        histories.set(targetRef.id, { entries: [reopened.content], index: 0 });
      }
      updateRecent(result);
      await captureFingerprint(result.path);
      showToast(`Reloaded ${result.name} using ${encodingSelect.options[encodingSelect.selectedIndex].text}.`, 'success');
    } catch (error) {
      if (isMissingSaveTargetError(error) && detachMissingSaveTarget(targetRef)) {
        render();
        showToast(`“${target.name}” is no longer on disk. Its text is kept as an unsaved tab; use Save As to choose a new location.`, 'info');
        return;
      }
      const latest = documents.find((document) => document.id === targetRef.id);
      if (latest && sameSaveTarget(latest, targetRef)) showToast(errorMessage(error), 'error');
    }
  })();
}

function openFind() {
  if (isMediaDocument(documentState)) {
    showToast('Find is available for text and Markdown documents.', 'info');
    return;
  }
  findbar.hidden = false;
  shell.classList.add('find-open');
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findbar.hidden = true;
  shell.classList.remove('find-open');
  if (!isMediaDocument(documentState)) editor.focus();
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

function selectedTextRange() {
  const target = activeEditor();
  if (target.selectionStart !== target.selectionEnd) {
    return { start: target.selectionStart, end: target.selectionEnd, text: documentState.content.slice(target.selectionStart, target.selectionEnd) };
  }
  const content = documentState.content;
  const start = content.lastIndexOf('\n\n', Math.max(0, target.selectionStart - 1)) + 2;
  const nextBreak = content.indexOf('\n\n', target.selectionEnd);
  const end = nextBreak === -1 ? content.length : nextBreak;
  return { start, end, text: content.slice(start, end) };
}

function replaceTextRange(start: number, end: number, replacement: string) {
  const target = activeEditor();
  recordContent(`${documentState.content.slice(0, start)}${replacement}${documentState.content.slice(end)}`);
  editor.setSelectionRange(start, start + replacement.length);
  secondaryEditor.setSelectionRange(start, start + replacement.length);
  target.focus();
}

function reflowParagraph() {
  if (isMediaDocument(documentState)) return;
  const width = Number(window.prompt('Reflow selected text or the current paragraph to this column width:', '78'));
  if (!Number.isInteger(width) || width < 24 || width > 200) {
    showToast('Choose a column width between 24 and 200.', 'error');
    return;
  }
  const { start, end, text } = selectedTextRange();
  if (!text.trim()) return;
  const prefixMatch = /^(\s*(?:(?:[-*+])|\d+[.)])\s+)?/.exec(text);
  const prefix = prefixMatch?.[0] || '';
  const words = text.replace(/^\s*(?:(?:[-*+])|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const available = Math.max(16, width - prefix.length);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && `${current} ${word}`.length > available) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  const replacement = lines.map((line, index) => index === 0 ? `${prefix}${line}` : `${' '.repeat(prefix.length)}${line}`).join('\n');
  replaceTextRange(start, end, replacement);
  showToast(`Reflowed text to ${width} columns.`, 'success');
}

function convertTextCase(kind: 'upper' | 'lower' | 'title') {
  const { start, end, text } = selectedTextRange();
  if (!text) return;
  const replacement = kind === 'upper' ? text.toLocaleUpperCase()
    : kind === 'lower' ? text.toLocaleLowerCase()
      : text.toLocaleLowerCase().replace(/\b[\p{L}\p{N}]/gu, (letter) => letter.toLocaleUpperCase());
  replaceTextRange(start, end, replacement);
  showToast(`${kind === 'title' ? 'Title' : kind[0].toUpperCase() + kind.slice(1)} case applied.`, 'success');
}

function smartTypography() {
  const { start, end, text } = selectedTextRange();
  if (!text) return;
  const replacement = text
    .replace(/\.\.\./g, '…')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/"([^"\n]+)"/g, '“$1”')
    .replace(/'([^'\n]+)'/g, '‘$1’');
  replaceTextRange(start, end, replacement);
  showToast('Applied smart typography.', 'success');
}

function trimTrailingWhitespace() {
  if (isMediaDocument(documentState)) return;
  const replacement = documentState.content.replace(/[\t ]+$/gm, '');
  if (replacement === documentState.content) { showToast('There is no trailing whitespace to remove.'); return; }
  recordContent(replacement);
  showToast('Trimmed trailing whitespace.', 'success');
}

function insertMarkdownTable() {
  if (!documentState.isMarkdown) { showToast('Markdown tools are available for Markdown documents.', 'error'); return; }
  insertAtSelection('| Column | Column |\n| --- | --- |\n| Value | Value |');
  showToast('Inserted a Markdown table.', 'success');
}

async function insertMarkdownLink() {
  if (!documentState.isMarkdown) { showToast('Markdown link tools are available for Markdown documents.', 'error'); return; }
  let url = '';
  try { url = (await navigator.clipboard.readText()).trim(); } catch { /* The prompt below remains available. */ }
  if (!/^(https?:\/\/|mailto:)/i.test(url)) url = window.prompt('Paste a web address for this link:', url) || '';
  if (!/^(https?:\/\/|mailto:)/i.test(url)) { showToast('Enter a complete web address, such as https://example.com.', 'error'); return; }
  const selected = documentState.content.slice(activeEditor().selectionStart, activeEditor().selectionEnd);
  const label = selected || window.prompt('Link text:', 'Link') || '';
  if (!label.trim()) return;
  insertAtSelection(`[${label}](${url})`);
  showToast('Inserted Markdown link.', 'success');
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
  const title = escapeHtml(documentExportBaseName());
  const body = documentState.isMarkdown ? renderMarkdown(documentState.content) : `<pre>${escapeHtml(documentState.content)}</pre>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}html{background:#fff}body{max-width:none;margin:0;padding:18mm 17mm 20mm;color:#202a39;font:11.5pt/1.68 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-rendering:optimizeLegibility}h1,h2,h3,h4,h5,h6{color:#172c42;line-height:1.25;letter-spacing:-.018em;break-after:avoid-page;page-break-after:avoid}h1{margin:0 0 .9em;padding-bottom:.45em;border-bottom:2px solid #11928d;font-size:24pt}h2{margin:1.8em 0 .7em;padding-bottom:.27em;border-bottom:1px solid #d8e3e5;font-size:17pt}h3{margin:1.5em 0 .55em;font-size:13pt}p,li{orphans:3;widows:3}p{margin:.85em 0}a{color:#087c82;text-decoration:none}hr{margin:1.8em 0;border:0;border-top:1px solid #d8e3e5}blockquote{margin:1.2em 0;padding:.25em 1.05em;border-left:3px solid #11928d;color:#516276;background:#f2faf9}pre{overflow:auto;margin:1.1em 0;padding:1em 1.1em;border:1px solid #dce5ed;border-radius:.45em;background:#f5f8fb;white-space:pre-wrap;font:9.5pt/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}p code,li code{padding:.08em .28em;border-radius:.23em;background:#edf3f7}table{display:table;width:100%;margin:1.2em 0;border-collapse:collapse;font-size:10.5pt;break-inside:avoid-page}thead{display:table-header-group}tr{break-inside:avoid-page}th,td{padding:.5em .65em;border:1px solid #d7e0e8;text-align:left;vertical-align:top}th{background:#eef8f7;color:#1a5660;font-weight:700}img,svg{max-width:100%;height:auto;break-inside:avoid-page}</style></head><body>${body}</body></html>`;
}

function documentExportBaseName() {
  return documentState.name.replace(/\.(txt|md|markdown)$/i, '').trim() || 'document';
}

async function exportHtml() {
  const base = documentExportBaseName();
  try {
    const result = await invoke<{ name: string; path: string } | null>('export_document', { suggestedName: base, content: htmlExportDocument(), extension: 'html' });
    if (result) showToast(`Exported ${result.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function exportPdf() {
  try {
    const result = await invoke<{ name: string; path: string } | null>('export_document', { suggestedName: documentExportBaseName(), content: htmlExportDocument(), extension: 'pdf' });
    if (result) showToast(`Exported ${result.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function printDocument() {
  if (documentState.isMarkdown && viewMode !== 'preview') setViewMode('preview');
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  try {
    await invoke('print_window');
    showToast('In the macOS print dialog, choose PDF → Save as PDF.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
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

function toggleReadingMode() {
  if (!documentState.isMarkdown || isMediaDocument(documentState)) {
    showToast('Focused reading mode is available for Markdown documents.', 'info');
    return;
  }
  readingMode = !readingMode;
  if (readingMode) {
    previewEnabled = true;
    localStorage.setItem(PREVIEW_VISIBLE_KEY, 'true');
    viewMode = 'preview';
  }
  render();
  showToast(readingMode ? 'Focused reading mode on. Press Escape to leave.' : 'Focused reading mode off.');
}

function startSidebarResizing() {
  sidebarResizer.addEventListener('pointerdown', (event) => {
    if (!sidebarIsShown() || event.button !== 0) return;
    cancelSidebarAutoHide();
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

function startPreviewResizing() {
  previewResizer.addEventListener('pointerdown', (event) => {
    if (!documentState.isMarkdown || !previewEnabled || viewMode !== 'split' || event.button !== 0) return;
    previewResizePointerId = event.pointerId;
    previewResizer.setPointerCapture(event.pointerId);
    workspace.classList.add('preview-resizing');
    event.preventDefault();
  });

  previewResizer.addEventListener('pointermove', (event) => {
    if (previewResizePointerId !== event.pointerId) return;
    const bounds = workspace.getBoundingClientRect();
    setPreviewWidth((bounds.right - event.clientX) / uiScaleFactor(), false);
  });

  const finishResize = (event: PointerEvent) => {
    if (previewResizePointerId !== event.pointerId) return;
    if (previewResizer.hasPointerCapture(event.pointerId)) previewResizer.releasePointerCapture(event.pointerId);
    previewResizePointerId = null;
    workspace.classList.remove('preview-resizing');
    setPreviewWidth(previewWidth);
  };
  previewResizer.addEventListener('pointerup', finishResize);
  previewResizer.addEventListener('pointercancel', finishResize);
  previewResizer.addEventListener('keydown', (event) => {
    let nextWidth: number | undefined;
    const step = event.shiftKey ? 30 : 10;
    if (event.key === 'ArrowLeft') nextWidth = previewWidth + step;
    else if (event.key === 'ArrowRight') nextWidth = previewWidth - step;
    else if (event.key === 'Home') nextWidth = MIN_PREVIEW_WIDTH;
    else if (event.key === 'End') nextWidth = MAX_PREVIEW_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    setPreviewWidth(nextWidth);
  });
}

function startSidebarAutoHide() {
  const markInside = () => {
    sidebarPointerInside = true;
    cancelSidebarAutoHide();
  };
  const markOutside = () => {
    sidebarPointerInside = false;
    scheduleSidebarAutoHide();
  };
  for (const element of [sidebar, sidebarResizer]) {
    element.addEventListener('pointerenter', markInside);
    element.addEventListener('pointerleave', markOutside);
  }
  sidebar.addEventListener('focusin', cancelSidebarAutoHide);
  sidebar.addEventListener('focusout', () => window.setTimeout(() => {
    if (!sidebar.contains(document.activeElement)) scheduleSidebarAutoHide();
  }, 0));
}

function goToLinePrompt() {
  const line = Number(window.prompt('Go to line:', String(editor.value.slice(0, editor.selectionStart).split('\n').length)));
  if (Number.isInteger(line) && line > 0) goToLine(line);
}

function quickSwitchItems(): QuickSwitchItem[] {
  const openTabs = documents.map((document) => ({
    group: 'OPEN TAB',
    label: document.name,
    detail: document.path || 'Unsaved document',
    run: () => activateDocument(document.id),
  }));
  const recents = readRecents().map((entry) => ({
    group: 'RECENT',
    label: entry.name,
    detail: entry.path,
    run: () => void openRecent(entry),
  }));
  const bookmarks = readFolderBookmarks().map((bookmark) => ({
    group: 'BOOKMARK',
    label: bookmark.name,
    detail: bookmark.path,
    run: () => void browseFolder(bookmark.path),
  }));
  const folderEntries = (projectFolder?.entries || []).filter((entry) => entry.kind === 'file').slice(0, 160).map((entry) => ({
    group: 'THIS FOLDER',
    label: entry.name,
    detail: entry.path,
    run: () => void openProjectFile(entry.path),
  }));
  return [...openTabs, ...recents, ...bookmarks, ...folderEntries];
}

function renderQuickSwitcher() {
  const query = quickSwitchInput.value.trim().toLocaleLowerCase();
  const matches = quickSwitchItems().filter((item) => `${item.label} ${item.detail} ${item.group}`.toLocaleLowerCase().includes(query)).slice(0, 80);
  quickSwitchList.replaceChildren();
  if (!matches.length) {
    quickSwitchList.append(makeEmpty('No tabs, recent files, bookmarks, or folder entries match.'));
    return;
  }
  let lastGroup = '';
  for (const item of matches) {
    if (item.group !== lastGroup) {
      const heading = document.createElement('span');
      heading.className = 'quick-switch-group';
      heading.textContent = item.group;
      quickSwitchList.append(heading);
      lastGroup = item.group;
    }
    const button = document.createElement('button');
    button.innerHTML = `<strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small>`;
    button.addEventListener('click', () => { closeQuickSwitcher(); item.run(); });
    quickSwitchList.append(button);
  }
}

function openQuickSwitcher() {
  closeCommandPalette();
  quickSwitcher.hidden = false;
  quickSwitchInput.value = '';
  renderQuickSwitcher();
  window.requestAnimationFrame(() => quickSwitchInput.focus());
}

function closeQuickSwitcher() {
  quickSwitcher.hidden = true;
  if (!isMediaDocument(documentState)) editor.focus();
}

type PaletteCommand = { label: string; hint: string; run: () => void };

function paletteCommands(): PaletteCommand[] {
  return [
    { label: 'Help: Getting started', hint: '', run: () => openHelp('getting-started') },
    { label: 'Help: Keyboard shortcuts', hint: '', run: () => openHelp('shortcuts') },
    { label: `What's new in 7TXT ${APP_VERSION}`, hint: '', run: () => openHelp('whats-new') },
    { label: 'About 7TXT', hint: '', run: () => openHelp('about') },
    { label: 'New text file', hint: '⌘N', run: () => createDocument() },
    { label: 'New Markdown file', hint: '⇧⌘N', run: () => createDocument(true) },
    { label: 'Open file', hint: '⌘O', run: () => void openFile() },
    { label: 'Save', hint: '⌘S', run: () => void save() },
    { label: 'Save As', hint: '⇧⌘S', run: () => void saveAs() },
    { label: 'Find and replace', hint: '⌘F', run: openFind },
    { label: 'Go to line', hint: '⌘L', run: goToLinePrompt },
    { label: 'Quick switcher', hint: '⌘K', run: openQuickSwitcher },
    { label: 'Set writing goal', hint: '', run: setWritingGoal },
    { label: 'Open local timeline', hint: '', run: openTimeline },
    { label: 'Toggle Files sidebar', hint: '⇧⌘B', run: toggleSidebar },
    { label: 'Toggle Markdown preview', hint: '', run: togglePreview },
    { label: 'Toggle editor split', hint: '', run: toggleEditorSplit },
    { label: 'Toggle Zen mode', hint: 'Esc', run: toggleZenMode },
    ...(documentState.isMarkdown && !isMediaDocument(documentState) ? [{ label: 'Focused reading mode', hint: '', run: toggleReadingMode }] : []),
    { label: 'Export clean PDF', hint: '', run: () => void exportPdf() },
    { label: 'Print', hint: '⌘P', run: () => void printDocument() },
    { label: 'Export HTML', hint: '', run: () => void exportHtml() },
    { label: 'Insert Markdown table', hint: '', run: insertMarkdownTable },
    { label: 'Toggle Markdown task', hint: '', run: toggleMarkdownTask },
    { label: 'Insert Markdown link from clipboard', hint: '', run: () => void insertMarkdownLink() },
    { label: 'Reflow current paragraph', hint: '', run: reflowParagraph },
    { label: 'Smart typography', hint: '', run: smartTypography },
    { label: 'Uppercase selection or paragraph', hint: '', run: () => convertTextCase('upper') },
    { label: 'Lowercase selection or paragraph', hint: '', run: () => convertTextCase('lower') },
    { label: 'Title case selection or paragraph', hint: '', run: () => convertTextCase('title') },
    { label: 'Trim trailing whitespace', hint: '', run: trimTrailingWhitespace },
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
  if (!recoveryReady || watchFilesInFlight) return;
  watchFilesInFlight = true;
  try {
    for (const queuedDocument of documents) {
      if (queuedDocument.kind !== 'text' || !queuedDocument.path || queuedDocument.conflict || manualSaveInFlight.has(queuedDocument.id)) continue;
      const target = targetFor(queuedDocument);
      if (!target.path) continue;
      try {
        const current = await invoke<FileFingerprint>('file_fingerprint', { path: target.path });
        const latest = documents.find((document) => document.id === target.id);
        if (!latest || !sameSaveTarget(latest, target)) continue;
        const previous = fileFingerprints.get(target.path);
        if (!previous) { fileFingerprints.set(target.path, current); continue; }
        if (!fingerprintsMatch(previous, current)) {
          // A write already in flight must not restore stale state after an
          // outside change is surfaced. It will be skipped if it has not
          // reached native I/O yet, and its late response is ignored either
          // way.
          markConflict(target);
          continue;
        }
      } catch (error) {
        const latest = documents.find((document) => document.id === target.id);
        if (!latest || !sameSaveTarget(latest, target)) continue;
        // A restored path can disappear between launches. Keep every former
        // saved file—including an empty untitled file—as a Save As-able draft.
        if (isMissingSaveTargetError(error) && detachMissingSaveTarget(target)) {
          render();
          showToast(`“${latest.name}” is no longer on disk. Its text is kept as an unsaved tab; use Save As to choose a new location.`, 'info');
          return;
        }
        markConflict(target);
      }
    }
  } finally {
    watchFilesInFlight = false;
  }
}

async function reloadExternalChange() {
  if (!externalChange) return;
  const target = documents.find((document) => document.path === externalChange!.path);
  if (!target) { externalChange = null; render(); return; }
  const targetRef = targetFor(target);
  const contentAtRequest = target.content;
  const savedContentAtRequest = target.savedContent;
  if (isTextDocumentDirty(target) && !window.confirm(`Reload “${target.name}” and discard unsaved changes?`)) return;
  try {
    const result = await invoke<OpenedDocument>('open_recent', { path: target.path, encoding: target.encoding });
    const latest = documents.find((document) => document.id === targetRef.id);
    if (!latest
      || !sameSaveTarget(latest, targetRef)
      || latest.content !== contentAtRequest
      || latest.savedContent !== savedContentAtRequest) return;
    const content = normaliseLineEndings(result.content);
    const reopened = {
      ...latest,
      ...result,
      content,
      savedContent: content,
      recoveryDraft: false,
      defaultUntitled: false,
    };
    documents = documents.map((document) => document.id === targetRef.id ? reopened : document);
    if (activeDocumentId === targetRef.id) documentState = reopened;
    histories.set(targetRef.id, { entries: [reopened.content], index: 0 });
    clearExternalChangeForPath(target.path);
    if (activeDocumentId === targetRef.id) documentState = documents.find((document) => document.id === targetRef.id)!;
    await captureFingerprint(result.path);
    render();
    showToast(`Reloaded ${result.name}.`, 'success');
    } catch (error) {
      if (isMissingSaveTargetError(error) && detachMissingSaveTarget(targetRef)) {
        render();
        showToast(`“${target.name}” is no longer on disk. Its text is kept as an unsaved tab; use Save As to choose a new location.`, 'info');
        return;
      }
      const latest = documents.find((document) => document.id === targetRef.id);
      if (latest && sameSaveTarget(latest, targetRef)) showToast(errorMessage(error), 'error');
    }
}

async function compareExternalChange() {
  if (!externalChange) return;
  const target = documents.find((document) => document.path === externalChange!.path);
  if (!target) return;
  const targetRef = targetFor(target);
  try {
    const result = await invoke<OpenedDocument>('open_recent', { path: target.path, encoding: target.encoding });
    const latest = documents.find((document) => document.id === targetRef.id);
    if (!latest || !sameSaveTarget(latest, targetRef)) return;
    addDocument({ id: `document-${nextDocumentId++}`, ...result, name: `${result.name} — disk`, path: undefined, content: normaliseLineEndings(result.content), savedContent: normaliseLineEndings(result.content) });
    // Comparing does not authorize overwriting the original.
    render();
    showToast('Opened the disk copy. The original stays paused until you resolve the conflict.', 'info');
  } catch (error) {
    if (isMissingSaveTargetError(error) && detachMissingSaveTarget(targetRef)) {
      render();
      showToast(`“${target.name}” is no longer on disk. Its text is kept as an unsaved tab; use Save As to choose a new location.`, 'info');
      return;
    }
    const latest = documents.find((document) => document.id === targetRef.id);
    if (latest && sameSaveTarget(latest, targetRef)) showToast(errorMessage(error), 'error');
  }
}

async function ignoreExternalChange() {
  if (!externalChange) return;
  const source = documents.find((document) => document.path === externalChange!.path);
  if (!source || manualSaveInFlight.has(source.id)) return;
  const target = targetFor(source);
  manualSaveInFlight.add(source.id);
  try {
    const disk = await invoke<OpenedDocument>('open_recent', { path: source.path, encoding: source.encoding });
    if (!sameSaveTarget(documents.find((document) => document.id === source.id) || { id: '' }, target)) return;
    if (!window.confirm(`Replace the current disk version of “${source.name}” with your edits? Use Compare first if you need to inspect it.`)) return;
    const result = await enqueueDocumentWrite(target, () => invoke<SavedTextFile>('write_file', {
      path: source.path, content: contentForSave(source.content), encoding: source.encoding, expectedVersion: disk.diskVersion,
    }));
    if (!result) return;
    const latest = documents.find((document) => document.id === target.id);
    if (!latest || !sameSaveTarget(latest, target)) return;
    documents = documents.map((document) => document.id === target.id ? { ...document, ...result, savedContent: source.content, conflict: false } : document);
    clearExternalChangeForPath(source.path);
    if (activeDocumentId === source.id) documentState = documents.find((document) => document.id === source.id)!;
    await captureFingerprint(result.path);
    render();
  } catch (error) {
    if (isMissingSaveTargetError(error)) detachMissingSaveTarget(target);
    showToast(isSaveConflict(error) ? 'The disk file changed again. Compare before trying again.' : errorMessage(error), 'error');
  } finally { manualSaveInFlight.delete(source.id); }
}

function handleAction(action?: string) {
  if (!recoveryReady || shell.inert) return;
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
    case 'toggle-hidden-files': showHiddenFiles = !showHiddenFiles; persistWorkbenchState(); void refreshProjectFolder(); showToast(showHiddenFiles ? 'Showing hidden files.' : 'Hiding hidden files.'); break;
    case 'toggle-folder-bookmark': toggleFolderBookmark(); break;
    case 'save': void save(); break;
    case 'save-as': void saveAs(); break;
    case 'save-media-annotations': void saveMediaAnnotations(true); break;
    case 'clear-media-annotations': clearMediaAnnotations(); break;
    case 'edit-media-annotation': editSelectedMediaAnnotation(); break;
    case 'delete-media-annotation': deleteSelectedMediaAnnotation(); break;
    case 'media-zoom-in': setMediaZoom(mediaZoom + .2); break;
    case 'media-zoom-out': setMediaZoom(mediaZoom - .2); break;
    case 'media-zoom-fit': setMediaZoom(1); break;
    case 'media-previous-page': changePdfPage(-1); break;
    case 'media-next-page': changePdfPage(1); break;
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
    case 'help-getting-started': openHelp('getting-started'); break;
    case 'help-keyboard-shortcuts': openHelp('shortcuts'); break;
    case 'help-whats-new': openHelp('whats-new'); break;
    case 'help-about': openHelp('about'); break;
    case 'close-help': closeHelp(); break;
    case 'quick-switch': openQuickSwitcher(); break;
    case 'toggle-open-tabs': toggleOpenTabsMenu(); break;
    case 'close-quick-switch': closeQuickSwitcher(); break;
    case 'timeline': openTimeline(); break;
    case 'close-timeline': closeTimeline(); break;
    case 'writing-goal': setWritingGoal(); break;
    case 'go-to-line': goToLinePrompt(); break;
    case 'toggle-editor-split': toggleEditorSplit(); break;
    case 'toggle-preview': togglePreview(); break;
    case 'reading-mode': toggleReadingMode(); break;
    case 'zen': toggleZenMode(); break;
    case 'print': void printDocument(); break;
    case 'export-pdf': void exportPdf(); break;
    case 'export-html': void exportHtml(); break;
    case 'insert-table': insertMarkdownTable(); break;
    case 'toggle-task': toggleMarkdownTask(); break;
    case 'insert-link': void insertMarkdownLink(); break;
    case 'reflow-paragraph': reflowParagraph(); break;
    case 'smart-typography': smartTypography(); break;
    case 'uppercase': convertTextCase('upper'); break;
    case 'lowercase': convertTextCase('lower'); break;
    case 'title-case': convertTextCase('title'); break;
    case 'trim-trailing-whitespace': trimTrailingWhitespace(); break;
    case 'reload-external': void reloadExternalChange(); break;
    case 'compare-external': void compareExternalChange(); break;
    case 'ignore-external': void ignoreExternalChange(); break;
    case 'save-both-external': {
      const target = documents.find((document) => document.path === externalChange?.path);
      if (target) { activateDocument(target.id); void saveAs(); }
      break;
    }
    case 'clear-recents': localStorage.removeItem(RECENTS_KEY); renderRecents(); showToast('Recent files cleared.'); break;
    case 'refresh-outline': renderOutline(); showToast('Outline refreshed.'); break;
    case 'mode-edit': setViewMode('edit'); break;
    case 'mode-split': setViewMode('split'); break;
    case 'mode-preview': setViewMode('preview'); break;
  }
}

app.addEventListener('pointerdown', (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('.theme-picker, .editor-appearance, .open-tabs-popover')) return;
  closeTransientMenus();
});

window.addEventListener('pointermove', trackTabDrag);
window.addEventListener('pointerup', finishTabDrag);
window.addEventListener('pointercancel', finishTabDrag);

app.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const helpSectionButton = event.target.closest<HTMLButtonElement>('[data-help-section]');
  if (isHelpSection(helpSectionButton?.dataset.helpSection)) {
    helpSection = helpSectionButton.dataset.helpSection;
    renderHelp();
    return;
  }
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
  const annotationToolButton = event.target.closest<HTMLButtonElement>('[data-annotation-tool]');
  if (annotationToolButton) {
    setAnnotationTool(annotationToolButton.dataset.annotationTool);
    return;
  }
  const annotationColorButton = event.target.closest<HTMLButtonElement>('[data-annotation-color]');
  if (annotationColorButton?.dataset.annotationColor) {
    annotationColor = annotationColorButton.dataset.annotationColor;
    renderMediaAnnotations();
    return;
  }
  const annotationEntry = event.target.closest<HTMLButtonElement>('.annotation-list [data-annotation-id]');
  if (annotationEntry?.dataset.annotationId) {
    selectedAnnotationId = annotationEntry.dataset.annotationId;
    renderMediaAnnotations();
    return;
  }
  const target = event.target.closest<HTMLElement>('[data-action], [data-mode-button]');
  if (!target) return;
  if (target.dataset.modeButton) setViewMode(target.dataset.modeButton as ViewMode);
  else handleAction(target.dataset.action);
});

annotationLayer.addEventListener('pointerdown', (event) => {
  if (!isMediaDocument(documentState) || event.button !== 0) return;
  const marker = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-annotation-id]') : null;
  if (!marker?.dataset.annotationId) {
    if (annotationTool === 'highlight') startMediaHighlight(event);
    else if (annotationTool === 'note') addMediaNote(event);
    return;
  }
  if (annotationTool !== 'select') return;
  const annotation = mediaAnnotationById(marker.dataset.annotationId);
  if (!annotation) return;
  event.preventDefault();
  event.stopPropagation();
  selectedAnnotationId = annotation.id;
  const position = annotationPosition(event);
  annotationDrag = { mode: 'move', id: annotation.id, pointerId: event.pointerId, dx: position.x - annotation.x, dy: position.y - annotation.y };
  annotationLayer.setPointerCapture(event.pointerId);
  renderMediaAnnotations();
});

annotationLayer.addEventListener('pointermove', (event) => {
  const drag = annotationDrag;
  if (!drag || drag.pointerId !== event.pointerId || !isMediaDocument(documentState)) return;
  const moving = mediaAnnotationById(drag.id);
  if (!moving) return;
  const position = annotationPosition(event);
  if (drag.mode === 'draw') {
    const x = Math.min(drag.x, position.x);
    const y = Math.min(drag.y, position.y);
    const width = Math.max(.001, Math.abs(position.x - drag.x));
    const height = Math.max(.001, Math.abs(position.y - drag.y));
    setMediaAnnotations((documentState.annotations || []).map((annotation) => annotation.id === moving.id
      ? { ...annotation, x, y, width, height }
      : annotation), false);
    return;
  }
  const maxX = 1 - (moving.kind === 'highlight' ? moving.width || .02 : 0);
  const maxY = 1 - (moving.kind === 'highlight' ? moving.height || .02 : 0);
  const annotations = (documentState.annotations || []).map((annotation) => annotation.id === moving.id
    ? { ...annotation, x: Math.max(0, Math.min(maxX, position.x - drag.dx)), y: Math.max(0, Math.min(maxY, position.y - drag.dy)) }
    : annotation);
  setMediaAnnotations(annotations);
});

function finishAnnotationDrag(event: PointerEvent) {
  if (!annotationDrag || annotationDrag.pointerId !== event.pointerId) return;
  const finished = annotationDrag;
  if (annotationLayer.hasPointerCapture(event.pointerId)) annotationLayer.releasePointerCapture(event.pointerId);
  annotationDrag = null;
  if (finished.mode === 'draw') {
    const annotation = mediaAnnotationById(finished.id);
    if (!annotation || (annotation.width || 0) < .008 || (annotation.height || 0) < .008) {
      setMediaAnnotations((documentState.annotations || []).filter((item) => item.id !== finished.id), false);
      selectedAnnotationId = null;
      showToast('Drag across an area to create a highlight.', 'info');
      return;
    }
    setMediaAnnotations(documentState.annotations || []);
  }
}

annotationLayer.addEventListener('pointerup', finishAnnotationDrag);
annotationLayer.addEventListener('pointercancel', finishAnnotationDrag);

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
  surface.addEventListener('scroll', () => syncLineNumbers(surface));
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
folderFilter.addEventListener('input', () => { folderFilterValue = folderFilter.value; persistWorkbenchState(); renderProjectTree(); });
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
quickSwitchInput.addEventListener('input', renderQuickSwitcher);
quickSwitchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeQuickSwitcher(); }
  else if (event.key === 'Enter') {
    event.preventDefault();
    quickSwitchList.querySelector<HTMLButtonElement>('button')?.click();
  }
});
quickSwitcher.addEventListener('pointerdown', (event) => { if (event.target === quickSwitcher) closeQuickSwitcher(); });
timelinePanel.addEventListener('pointerdown', (event) => { if (event.target === timelinePanel) closeTimeline(); });
helpPanel.addEventListener('pointerdown', (event) => { if (event.target === helpPanel) closeHelp(); });

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !helpPanel.hidden) { event.preventDefault(); closeHelp(); return; }
  if (event.key === 'Escape' && !quickSwitcher.hidden) { event.preventDefault(); closeQuickSwitcher(); return; }
  if (event.key === 'Escape' && !timelinePanel.hidden) { event.preventDefault(); closeTimeline(); return; }
  if (event.key === 'Escape') {
    const hasOpenTransientMenu = Boolean(app!.querySelector<HTMLDetailsElement>('.theme-picker[open], .editor-appearance[open]')) || !openTabsMenu.hidden;
    if (hasOpenTransientMenu) {
      event.preventDefault();
      closeTransientMenus();
      return;
    }
  }
  if (event.key === 'Escape' && readingMode) { event.preventDefault(); toggleReadingMode(); return; }
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
  else if (key === 'k') { event.preventDefault(); openQuickSwitcher(); }
  else if (key === 'p' && event.shiftKey) { event.preventDefault(); openCommandPalette(); }
  else if (key === 'p') { event.preventDefault(); void printDocument(); }
  else if (key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (key === '1') { event.preventDefault(); setViewMode('edit'); }
  else if (key === '2') { event.preventDefault(); setViewMode('split'); }
  else if (key === '3') { event.preventDefault(); setViewMode('preview'); }
});

window.addEventListener('resize', () => {
  if (!isMediaDocument(documentState)) return;
  mediaLastRenderKey = '';
  renderMediaDocument();
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
  persistWorkbenchState();
  persistRecovery();
  captureTimeline('Before close');
  if (!documents.some((document) => document.kind === 'text' && isTextDocumentDirty(document))) return;
  event.preventDefault();
  event.returnValue = '';
});

shell.inert = true;
async function startWorkspace() {
  await listen('recovery-close-requested', async () => {
    if (!recoveryReady || shell.inert) return;
    shell.inert = true;
    try {
      persistWorkbenchState();
      captureTimeline('Before close');
      await flushStableRecovery(() => documents, async () => {
        if (!await persistRecovery()) throw new Error('Recovery is unavailable. Use Save As to rescue your work.');
      });
      await invoke('recovery_finish_close');
    } catch (error) {
      showToast(`Could not close safely: ${errorMessage(error)}`, 'error');
      if (window.confirm('Recovery could not be saved. Close anyway? Unsaved work from this session may be lost. Choose Cancel to keep editing or use Save As.')) await invoke('recovery_finish_close');
    } finally { shell.inert = false; }
  });
  let durable: unknown;
  try { durable = (await invoke<{ payload: unknown } | null>('recovery_load'))?.payload; }
  catch (error) {
    recoveryLoadFailed = true;
    required<HTMLElement>('.recovery-status').textContent = `Recovery could not be read: ${errorMessage(error)}. Existing recovery is preserved.`;
  }
  restoreSession(durable);
  recoveryReady = true;
  shell.inert = false;
  applyEditorAppearance();
  applyEditorOptions();
  applySidebarLayout();
  applyPreviewLayout();
  applyUiTheme();
  applyUiScale();
  applyEditorSurface();
  setupTransientMenus();
  startSidebarResizing();
  startPreviewResizing();
  startSidebarAutoHide();
  render();
  renderProjectTree();
  void refreshProjectFolder(true);
  void startExternalFileHandling();
  void startDragAndDrop();
}
void startWorkspace();
window.addEventListener('resize', () => {
  const constrained = clampSidebarWidth(sidebarWidth);
  if (constrained !== sidebarWidth) setSidebarWidth(constrained);
  const constrainedPreview = clampPreviewWidth(previewWidth);
  if (constrainedPreview !== previewWidth) setPreviewWidth(constrainedPreview);
  window.requestAnimationFrame(updateTabWidth);
});
window.setInterval(() => { void watchFiles(); }, 4000);
window.setInterval(renderWritingProgress, 30_000);
