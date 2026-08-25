import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
};
type OpenedTextFile = { name: string; path: string; content: string; isMarkdown: boolean; encoding: string };
type SavedTextFile = { name: string; path: string; encoding: string };
type RecentEntry = { name: string; path: string; isMarkdown: boolean; openedAt: number };
type DocumentHistory = { entries: string[]; index: number };
type FolderEntry = { name: string; path: string; kind: 'file' | 'directory'; children: FolderEntry[] };
type ProjectFolder = { name: string; path: string; entries: FolderEntry[]; truncated: boolean };

const RECENTS_KEY = '7txt:recent-files:v1';
const PROJECT_FOLDER_KEY = '7txt:open-folder:v1';
const MAX_RECENTS = 14;
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
      <div class="window-actions">
        <button data-action="find" title="Find (⌘F)">Find</button>
        <button data-action="save" class="primary" title="Save (⌘S)">Save</button>
      </div>
    </header>
    <nav class="document-tabs" aria-label="Open documents">
      <div class="tab-list" role="tablist"></div>
      <button class="tab-new" data-action="new-text" title="New text tab (⌘N)" aria-label="New text tab">+</button>
    </nav>
    <section class="toolbar" aria-label="Document controls">
      <div class="file-actions">
        <button data-action="new-text">New text</button>
        <button data-action="new-markdown">New MD</button>
        <button data-action="open">Open</button>
        <button data-action="open-folder">Folder</button>
        <button data-action="save-as">Save As</button>
      </div>
      <label class="encoding-control" title="Choose how this document is decoded when opening or encoded when saving."><span>Encoding</span><select data-encoding>${CHARACTER_ENCODINGS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <button data-action="reopen-encoding" class="reopen-encoding" title="Reload this saved document using the selected encoding">↻ Reopen</button>
      <div class="view-switch" role="group" aria-label="View mode">
        <button data-mode-button="edit" title="Edit view (⌘1)">Edit</button>
        <button data-mode-button="split" title="Split view (⌘2)">Split</button>
        <button data-mode-button="preview" title="Preview (⌘3)">Preview</button>
      </div>
      <div class="toolbar-spacer"></div>
      <button data-action="undo" title="Undo (⌘Z)">↶</button>
      <button data-action="redo" title="Redo (⇧⌘Z)">↷</button>
    </section>
    <section class="findbar" hidden>
      <label>Find <input type="search" placeholder="Search this document" spellcheck="false" /></label>
      <button data-action="find-next">Next</button>
      <button data-action="close-find" aria-label="Close Find">×</button>
    </section>
    <section class="workspace">
      <aside class="sidebar">
        <section class="sidebar-section project-section">
          <div class="section-head"><span>PROJECT</span><span class="section-actions"><button data-action="open-folder" title="Open a folder">Open</button><button data-action="refresh-folder" title="Refresh the open folder" aria-label="Refresh folder">↻</button></span></div>
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
      <section class="editor-pane">
        <div class="editor-heading"><span class="format-chip"></span><span class="editor-mode-label">Plain text</span><span class="editor-status"></span></div>
        <textarea class="editor" aria-label="Text editor" spellcheck="true" placeholder="Start writing…"></textarea>
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
  </main>
`;

const shell = required<HTMLElement>('.app-shell');
const editor = required<HTMLTextAreaElement>('.editor');
const preview = required<HTMLElement>('.markdown-preview');
const findbar = required<HTMLElement>('.findbar');
const findInput = required<HTMLInputElement>('.findbar input');
const outlineList = required<HTMLElement>('.outline-list');
const recentsList = required<HTMLElement>('.recents-list');
const projectTree = required<HTMLElement>('.project-tree');
const toast = required<HTMLElement>('.toast');
const encodingSelect = required<HTMLSelectElement>('[data-encoding]');
const reopenEncodingButton = required<HTMLButtonElement>('.reopen-encoding');
const tabList = required<HTMLElement>('.tab-list');

let nextDocumentId = 1;
const firstDocument = blankDocument();
let documents: TextDocument[] = [firstDocument];
let activeDocumentId = firstDocument.id;
let documentState: TextDocument = firstDocument;
let viewMode: ViewMode = 'split';
let projectFolder: ProjectFolder | null = null;
const histories = new Map<string, DocumentHistory>([[firstDocument.id, { entries: [''], index: 0 }]]);
let toastTimer: number | undefined;

function required<T extends Element>(selector: string): T {
  const value = app!.querySelector<T>(selector);
  if (!value) throw new Error(`7TXT is missing ${selector}.`);
  return value;
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
  viewMode = next.isMarkdown ? 'split' : 'edit';
  render();
}

function addDocument(next: TextDocument) {
  documents = [...documents, next];
  histories.set(next.id, { entries: [next.content], index: 0 });
  documentState = next;
  activeDocumentId = next.id;
  editor.value = next.content;
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

function storedProjectPath() {
  const path = localStorage.getItem(PROJECT_FOLDER_KEY);
  return path && path.trim() ? path : null;
}

function renderProjectTree() {
  projectTree.replaceChildren();
  if (!projectFolder) {
    projectTree.append(makeEmpty('Open a folder to browse its text and Markdown files.'));
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
    projectTree.append(makeEmpty('No supported files found in this folder.'));
  } else {
    const entries = document.createElement('div');
    entries.className = 'folder-entries';
    for (const entry of projectFolder.entries) entries.append(makeFolderEntry(entry, 0));
    projectTree.append(entries);
  }
  if (projectFolder.truncated) {
    const notice = makeEmpty('The tree is limited to the first 3,000 matching files.');
    notice.classList.add('folder-truncated');
    projectTree.append(notice);
  }
}

function makeFolderEntry(entry: FolderEntry, depth: number): HTMLElement {
  if (entry.kind === 'file') {
    const button = document.createElement('button');
    button.className = 'folder-file';
    button.textContent = entry.name;
    button.title = entry.path;
    button.style.setProperty('--tree-depth', String(depth));
    button.addEventListener('click', () => void openProjectFile(entry.path));
    return button;
  }
  const details = document.createElement('details');
  details.className = 'folder-directory';
  details.open = depth < 1;
  const summary = document.createElement('summary');
  summary.textContent = entry.name;
  summary.title = entry.path;
  summary.style.setProperty('--tree-depth', String(depth));
  const children = document.createElement('div');
  children.className = 'folder-children';
  for (const child of entry.children) children.append(makeFolderEntry(child, depth + 1));
  details.append(summary, children);
  return details;
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

async function refreshProjectFolder(quiet = false) {
  const path = projectFolder?.path || storedProjectPath();
  if (!path) {
    if (!quiet) showToast('Open a project folder first.');
    return;
  }
  try {
    const result = await invoke<ProjectFolder>('refresh_folder', { path });
    projectFolder = result;
    localStorage.setItem(PROJECT_FOLDER_KEY, result.path);
    renderProjectTree();
    if (!quiet) showToast('Project folder refreshed.', 'success');
  } catch (error) {
    projectFolder = null;
    localStorage.removeItem(PROJECT_FOLDER_KEY);
    renderProjectTree();
    if (!quiet) showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

function commitDocument(next: TextDocument, resetHistory = true) {
  setCurrentDocument(next);
  editor.value = next.content;
  if (resetHistory) {
    histories.set(next.id, { entries: [next.content], index: 0 });
  }
  editor.setSelectionRange(0, 0);
  render();
}

function recordContent(content: string) {
  if (content === documentState.content) return;
  setCurrentDocument({ ...documentState, content });
  const history = historyFor(documentState);
  history.entries = history.entries.slice(0, history.index + 1);
  history.entries.push(content);
  if (history.entries.length > 2500) history.entries.shift(); else history.index += 1;
  if (history.entries.length === 2500) history.index = history.entries.length - 1;
  render();
}

function restoreHistory(nextIndex: number) {
  const history = historyFor(documentState);
  if (nextIndex < 0 || nextIndex >= history.entries.length || nextIndex === history.index) return;
  history.index = nextIndex;
  setCurrentDocument({ ...documentState, content: history.entries[history.index] });
  editor.value = documentState.content;
  render();
  editor.focus();
}

function undo() { restoreHistory(historyFor(documentState).index - 1); }
function redo() { restoreHistory(historyFor(documentState).index + 1); }

function render() {
  if (!documentState.isMarkdown && viewMode !== 'edit') viewMode = 'edit';
  shell.dataset.mode = viewMode;
  shell.classList.toggle('text-document', !documentState.isMarkdown);
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
  required<HTMLElement>('.status-help').textContent = documentState.isMarkdown ? '⌘1 Edit · ⌘2 Split · ⌘3 Preview' : '⌘O Open · ⌘S Save · ⌘F Find';
  for (const button of app!.querySelectorAll<HTMLButtonElement>('[data-mode-button]')) {
    button.classList.toggle('selected', button.dataset.modeButton === viewMode);
  }
  preview.innerHTML = documentState.isMarkdown ? renderMarkdown(documentState.content) : `<pre>${escapeHtml(documentState.content || 'Start writing…')}</pre>`;
  renderTabs();
  renderOutline();
  renderRecents();
  updateCursor();
}

function documentStats(content: string) {
  const lines = content ? content.split('\n').length : 1;
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  return `${words} word${words === 1 ? '' : 's'} · ${content.length} char${content.length === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'}`;
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
        items.push(`<li>${renderInline(match[1])}</li>`);
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
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  required<HTMLElement>('.status-cursor').textContent = `Ln ${line}, Col ${column}`;
}

function goToLine(line: number) {
  const lines = editor.value.split('\n');
  const start = lines.slice(0, Math.max(0, line - 1)).reduce((offset, current) => offset + current.length + 1, 0);
  const end = start + (lines[line - 1]?.length || 0);
  setViewMode('edit');
  editor.focus();
  editor.setSelectionRange(start, end);
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

function openResultInTab(result: OpenedTextFile) {
  updateRecent(result);
  const alreadyOpen = documents.find((document) => document.path === result.path);
  if (alreadyOpen) {
    activateDocument(alreadyOpen.id);
    showToast(`${result.name} is already open.`, 'info');
    return;
  }
  addDocument({ id: `document-${nextDocumentId++}`, ...result, savedContent: result.content });
  showToast(`Opened ${result.name} in a new tab.`, 'success');
}

async function saveAs() {
  try {
    const result = await invoke<SavedTextFile | null>('save_as', { suggestedName: documentState.name, content: documentState.content, encoding: documentState.encoding });
    if (!result) return;
    setCurrentDocument({ ...documentState, ...result, savedContent: documentState.content, isMarkdown: isMarkdownName(result.name) });
    updateRecent({ ...result, isMarkdown: documentState.isMarkdown });
    render();
    showToast(`Saved ${result.name}.`, 'success');
  } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
}

async function save() {
  if (!documentState.path) { await saveAs(); return; }
  try {
    const result = await invoke<SavedTextFile>('write_file', { path: documentState.path, content: documentState.content, encoding: documentState.encoding });
    setCurrentDocument({ ...documentState, ...result, savedContent: documentState.content, isMarkdown: isMarkdownName(result.name) });
    updateRecent({ ...result, isMarkdown: documentState.isMarkdown });
    render();
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
    viewMode = 'edit';
  } else {
    documents = documents.filter((document) => document.id !== id);
    if (id === activeDocumentId) {
      const next = documents[Math.min(index, documents.length - 1)];
      documentState = next;
      activeDocumentId = next.id;
      editor.value = next.content;
      viewMode = next.isMarkdown ? 'split' : 'edit';
    }
  }
  render();
  showToast('Tab closed.');
}

function reopenWithEncoding() {
  const target = documentState;
  if (!target.path) return;
  if (target.content !== target.savedContent && !window.confirm(`Reload “${target.name}” from disk and discard its unsaved changes?`)) return;
  void (async () => {
    try {
      const result = await invoke<OpenedTextFile>('open_recent', { path: target.path, encoding: target.encoding });
      const reopened = { ...target, ...result, savedContent: result.content };
      if (documentState.id === target.id) commitDocument(reopened);
      else {
        documents = documents.map((document) => document.id === target.id ? reopened : document);
        histories.set(target.id, { entries: [reopened.content], index: 0 });
      }
      updateRecent(result);
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

function findNext() {
  const query = findInput.value;
  if (!query) return;
  const start = editor.selectionEnd;
  const index = editor.value.indexOf(query, start);
  const next = index >= 0 ? index : editor.value.indexOf(query, 0);
  if (next < 0) { showToast(`“${query}” was not found.`); return; }
  editor.focus();
  editor.setSelectionRange(next, next + query.length);
  editor.scrollTop = Math.max(0, editor.value.slice(0, next).split('\n').length * 23 - 92);
  updateCursor();
}

function handleAction(action?: string) {
  switch (action) {
    case 'new':
    case 'new-text': createDocument(); break;
    case 'new-markdown': createDocument(true); break;
    case 'open': void openFile(); break;
    case 'open-folder': void selectProjectFolder(); break;
    case 'refresh-folder': void refreshProjectFolder(); break;
    case 'save': void save(); break;
    case 'save-as': void saveAs(); break;
    case 'close': closeDocument(); break;
    case 'reopen-encoding': reopenWithEncoding(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'find': openFind(); break;
    case 'find-next': findNext(); break;
    case 'close-find': closeFind(); break;
    case 'clear-recents': localStorage.removeItem(RECENTS_KEY); renderRecents(); showToast('Recent files cleared.'); break;
    case 'refresh-outline': renderOutline(); showToast('Outline refreshed.'); break;
    case 'mode-edit': setViewMode('edit'); break;
    case 'mode-split': setViewMode('split'); break;
    case 'mode-preview': setViewMode('preview'); break;
  }
}

app.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('[data-action], [data-mode-button]');
  if (!target) return;
  if (target.dataset.modeButton) setViewMode(target.dataset.modeButton as ViewMode);
  else handleAction(target.dataset.action);
});

editor.addEventListener('input', () => recordContent(editor.value));
encodingSelect.addEventListener('change', () => {
  setCurrentDocument({ ...documentState, encoding: encodingSelect.value });
  render();
  showToast(documentState.path ? `Selected ${encodingSelect.options[encodingSelect.selectedIndex].text}; choose Reopen to decode the saved file again.` : `New documents will save as ${encodingSelect.options[encodingSelect.selectedIndex].text}.`);
});
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('click', updateCursor);
findInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); findNext(); } if (event.key === 'Escape') { closeFind(); } });

window.addEventListener('keydown', (event) => {
  const primary = event.metaKey || event.ctrlKey;
  if (!primary) return;
  const key = event.key.toLowerCase();
  if (key === 's') { event.preventDefault(); void (event.shiftKey ? saveAs() : save()); }
  else if (key === 'o' && event.shiftKey) { event.preventDefault(); void selectProjectFolder(); }
  else if (key === 'o') { event.preventDefault(); void openFile(); }
  else if (key === 'n') { event.preventDefault(); createDocument(event.shiftKey); }
  else if (key === 'w') { event.preventDefault(); closeDocument(); }
  else if (key === 'f') { event.preventDefault(); openFind(); }
  else if (key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (key === '1') { event.preventDefault(); setViewMode('edit'); }
  else if (key === '2') { event.preventDefault(); setViewMode('split'); }
  else if (key === '3') { event.preventDefault(); setViewMode('preview'); }
});

void listen<string>('menu-action', ({ payload }) => handleAction(payload));

window.addEventListener('beforeunload', (event) => {
  if (!documents.some((document) => document.content !== document.savedContent)) return;
  event.preventDefault();
  event.returnValue = '';
});

render();
renderProjectTree();
void refreshProjectFolder(true);
