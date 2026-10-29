import './closeConfirmation.css';

let open = false;
export function isCloseConfirmationOpen() { return open; }

/** WKWebView does not supply window.confirm; use a modal with explicit, safe choices. */
export function showCloseConfirmation(message: string): Promise<boolean> {
  if (open) return Promise.resolve(false);
  open = true;
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'tab-close-confirmation';
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const theme = shell?.dataset.theme;
    dialog.dataset.theme = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme ?? 'light';
    // Keep 7TXT's custom palettes without placing the dialog in a scaled or
    // inert app shell. Yedit uses the light/dark defaults in the shared CSS.
    if (shell) {
      const style = getComputedStyle(shell);
      for (const [token, property] of [['--paper', 'background-color'], ['--ink', 'color'], ['--line', 'border-color']]) {
        const value = style.getPropertyValue(token).trim();
        if (value) dialog.style.setProperty(property, value);
      }
    }
    dialog.setAttribute('aria-labelledby', 'tab-close-title');
    dialog.setAttribute('aria-describedby', 'tab-close-description');
    const title = document.createElement('h2');
    title.id = 'tab-close-title';
    title.textContent = 'Close without saving?';
    const description = document.createElement('p');
    description.id = 'tab-close-description';
    description.textContent = message;
    const actions = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.autofocus = true;
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'discard';
    discard.textContent = 'Close Without Saving';
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      dialog.remove();
      open = false;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(confirmed);
    };
    cancel.addEventListener('click', () => finish(false));
    discard.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => finish(false));
    // Leave Tab/Enter/Escape to the dialog, not the editor's global shortcuts.
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    actions.append(cancel, discard);
    dialog.append(title, description, actions);
    document.body.append(dialog);
    try { dialog.showModal(); cancel.focus(); }
    catch { finish(false); }
  });
}
