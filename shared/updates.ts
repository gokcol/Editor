import { normalizeUpdatePreferences, updateCheckDue, updateNoticeId, type UpdateInfo, type UpdatePreferences, type UpdateReport, type UpdatesApi } from './updateState';
import './updates.css';

type Options = { appName: '7TXT' | 'Yedit'; installedVersion: string; releaseNotes: string; canNotify?: () => boolean };
let activeDialog: HTMLDialogElement | null = null;
export function isUpdatesOpen() { return activeDialog?.open === true; }

/** One controller per editor window. Only its explicit opt-in can start background checks. */
export function createUpdateController(api: UpdatesApi, options: Options) {
  const key = `${options.appName.toLowerCase()}:updates:v1`;
  let preferences = normalizeUpdatePreferences(null);
  let preferenceError = '';
  let info: UpdateInfo | null = null;
  let infoRequest: Promise<void> | null = null;
  let report: UpdateReport | null = null;
  let error = '';
  let checkedAt: number | null = null;
  let checking: Promise<void> | null = null;
  let dialog: HTMLDialogElement | null = null;
  let notice: HTMLElement | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let started = false;
  let lastInteraction = Date.now();
  let deferredNotice = false;
  let previousFocus: HTMLElement | null = null;
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

  function loadPreferences() {
    try { preferences = normalizeUpdatePreferences(JSON.parse(localStorage.getItem(key) || '{}')); }
    catch { preferences = normalizeUpdatePreferences(null); preferenceError = 'Update preferences could not be read. Automatic checks are off.'; }
  }
  function savePreferences(next: UpdatePreferences) {
    try { localStorage.setItem(key, JSON.stringify(next)); preferences = next; preferenceError = ''; return true; }
    catch { preferenceError = 'Update preferences could not be saved. Automatic checks are off.'; preferences = { ...preferences, automatic: false }; return false; }
  }
  async function loadInfo() {
    if (!api.native || disposed) return;
    if (!infoRequest) infoRequest = api.info().then((value) => { if (!disposed) info = value; })
      .catch((cause) => { if (!disposed) error = message(cause); })
      .finally(() => { infoRequest = null; render(); });
    await infoRequest;
  }
  const control = <T extends HTMLElement>(selector: string) => dialog!.querySelector<T>(selector)!;
  const supported = () => api.native && info?.channel !== 'unsupported' && info?.channel !== 'sideloaded';

  function render() {
    if (disposed || !dialog) return;
    const store = info?.channel === 'store' || info?.channel === 'sideloaded';
    const available = !error && report?.available;
    control('.editor-update-version').textContent = `Installed version ${info?.installedVersion ?? options.installedVersion}`;
    control('.editor-update-channel').textContent = !api.native ? 'Available in the desktop app' : store ? 'Updates from Microsoft Store' : 'Updates from GitHub';
    control('.editor-update-state').textContent = checking ? 'Checking for updates…' : error ? "Couldn't check for updates" : available ? available.title : report
      ? store ? 'Microsoft Store has no update available for this installation.' : "You're up to date with the latest stable release for this app." : 'Check whenever you’re ready.';
    control('.editor-update-state').setAttribute('data-state', error ? 'error' : available ? 'available' : 'current');
    control('.editor-update-error').textContent = error;
    control('.editor-update-notes').textContent = available ? available.notes : '';
    control<HTMLElement>('.editor-update-notes').hidden = !available;
    const download = control<HTMLButtonElement>('.editor-update-download');
    download.hidden = !available;
    download.disabled = Boolean(checking);
    download.textContent = store ? 'Open Microsoft Store' : `Download ${info?.appName ?? options.appName} update`;
    control<HTMLButtonElement>('.editor-update-browse').textContent = store ? 'Open Microsoft Store' : 'Browse GitHub releases';
    control<HTMLButtonElement>('.editor-update-browse').disabled = !api.native;
    control<HTMLButtonElement>('.editor-update-check').disabled = Boolean(checking) || !supported();
    control('.editor-update-privacy').textContent = store ? 'Checks use Microsoft Store services. Your documents stay on this device. Windows manages Store updates.'
      : 'Checks contact GitHub for public release information. Your documents and file paths are not sent. Downloads open in your browser.';
    control<HTMLInputElement>('.editor-update-automatic').checked = preferences.automatic;
    control<HTMLInputElement>('.editor-update-automatic').disabled = !supported();
    control('.editor-update-preference-error').textContent = preferenceError;
    control('.editor-update-last-check').textContent = checkedAt ? `Last checked ${new Date(checkedAt).toLocaleString()}` : '';
  }

  async function open(destination: 'releases' | 'download') {
    try { await api.open(destination); }
    catch (cause) { if (!disposed) { error = message(cause); render(); } }
  }

  function close() { dialog?.close(); }
  function show() {
    if (disposed) return;
    if (dialog) { dialog.focus(); return; }
    if (activeDialog) { activeDialog.focus(); return; }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog = document.createElement('dialog'); activeDialog = dialog;
    dialog.className = 'editor-updates';
    dialog.setAttribute('aria-labelledby', 'editor-update-title');
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const theme = shell?.dataset.theme;
    dialog.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme ?? 'light';
    // Only static markup uses HTML. All remote notes/status/version text uses textContent.
    dialog.innerHTML = `<header><div><small>APP UPDATES</small><h2 id="editor-update-title"></h2><p class="editor-update-version"></p></div><button class="editor-update-close" aria-label="Close updates" autofocus>×</button></header>
      <div class="editor-update-body"><section class="editor-update-card"><p class="editor-update-channel"></p><h3 class="editor-update-state" role="status" aria-live="polite"></h3><p class="editor-update-error" role="alert"></p><pre class="editor-update-notes" hidden></pre><p class="editor-update-last-check"></p><button class="editor-update-download" hidden>Download update</button></section>
      <label class="editor-update-option"><input type="checkbox" class="editor-update-automatic">Check automatically once a day</label><p class="editor-update-privacy"></p><p class="editor-update-preference-error" role="alert"></p><button class="editor-update-browse">Browse releases</button>
      <details class="editor-update-local-notes"><summary>What’s new in this installed version</summary><p></p></details></div>
      <footer><button class="editor-update-check">Check for Updates</button><button class="editor-update-done">Done</button></footer>`;
    control('#editor-update-title').textContent = `${options.appName} updates`;
    control('.editor-update-local-notes p').textContent = options.releaseNotes;
    control('.editor-update-close').addEventListener('click', close);
    control('.editor-update-done').addEventListener('click', close);
    control('.editor-update-check').addEventListener('click', () => { void check(false); });
    control('.editor-update-browse').addEventListener('click', () => { void open('releases'); });
    control('.editor-update-download').addEventListener('click', () => { void open('download'); });
    control<HTMLInputElement>('.editor-update-automatic').addEventListener('change', (event) => {
      savePreferences({ ...preferences, automatic: (event.target as HTMLInputElement).checked }); render();
    });
    dialog.addEventListener('keydown', (event) => { event.stopPropagation(); });
    dialog.addEventListener('close', () => {
      const closed = dialog;
      if (activeDialog === closed) activeDialog = null;
      dialog = null; closed?.remove();
      if (report?.available) savePreferences({ ...preferences, dismissedRelease: report.available.id });
      notice?.remove(); notice = null; deferredNotice = false;
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    document.body.append(dialog); render(); dialog.showModal();
    void check(false);
  }

  async function check(background: boolean) {
    if (checking || disposed || !api.native) return checking;
    if (background) { loadPreferences(); if (!updateCheckDue(preferences, Date.now())) return; }
    checking = (async () => {
      await loadInfo();
      if (disposed) return;
      if (info?.channel === 'sideloaded') { error = 'This package wasn’t signed by Microsoft Store. Open the Store to install its supported edition.'; return; }
      if (!supported()) return;
      // A failed attempt is throttled too; failures never claim the app is current.
      savePreferences({ ...preferences, lastAttempt: Date.now() });
      if (background && !preferences.automatic) return;
      error = ''; report = null; render();
      try {
        const result = await api.check();
        if (!disposed) { report = result; info = result.info; checkedAt = Date.now(); deferredNotice = background && Boolean(updateNoticeId(report, preferences)); }
      } catch (cause) { if (!disposed) { error = message(cause); checkedAt = null; } }
    })().finally(() => { checking = null; render(); });
    render(); return checking;
  }

  function interact() { lastInteraction = Date.now(); }
  function preferencesChanged(event: StorageEvent) {
    if (event.key === key) { loadPreferences(); render(); }
  }
  function tick() {
    if (disposed || document.hidden || !document.hasFocus()) return;
    if (!checking && !dialog && updateCheckDue(preferences, Date.now())) void check(true);
    if (!deferredNotice || notice || dialog || activeDialog || Date.now() - lastInteraction < 1800 || options.canNotify?.() === false
      || document.querySelector('dialog[open], .modal-backdrop')) return;
    notice = document.createElement('aside'); notice.className = 'editor-update-notice'; notice.setAttribute('aria-label', 'App update available');
    const label = document.createElement('span'); label.textContent = `A ${options.appName} update is available.`;
    const view = document.createElement('button'); view.textContent = 'View update'; view.addEventListener('click', show);
    const dismiss = document.createElement('button'); dismiss.textContent = 'Later'; dismiss.addEventListener('click', () => {
      if (report?.available) savePreferences({ ...preferences, dismissedRelease: report.available.id });
      deferredNotice = false; notice?.remove(); notice = null;
    });
    notice.append(label, view, dismiss); document.body.append(notice);
  }
  return {
    show,
    start() {
      if (started || disposed) return; started = true; loadPreferences();
      // Reading local version/channel metadata makes no request to an update service.
      void loadInfo();
      document.addEventListener('keydown', interact, { passive: true }); document.addEventListener('pointerdown', interact, { passive: true });
      window.addEventListener('storage', preferencesChanged);
      interval = setInterval(tick, 15_000);
    },
    dispose() {
      disposed = true; if (interval) clearInterval(interval);
      document.removeEventListener('keydown', interact); document.removeEventListener('pointerdown', interact);
      window.removeEventListener('storage', preferencesChanged);
      dialog?.close(); notice?.remove();
    },
  };
}
