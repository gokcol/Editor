export type ContextAction = {
  label: string;
  run: () => void;
  enabled?: boolean;
  checked?: boolean;
};

export type ContextGroup = { label: string; actions: ContextAction[] };

export function createVisualContextMenu(pane: HTMLElement, focusEditor: () => void, signal: AbortSignal) {
  const menu = document.createElement('div');
  menu.className = 'visual-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Markdown actions');
  menu.hidden = true;
  pane.append(menu);

  function close(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (restoreFocus) focusEditor();
  }

  function items() {
    return Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  }

  function show(groups: ContextGroup[], left: number, top: number) {
    close();
    for (const group of groups) {
      const section = document.createElement('div');
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.label);
      const heading = document.createElement('span');
      heading.className = 'visual-context-heading';
      heading.textContent = group.label;
      heading.setAttribute('aria-hidden', 'true');
      section.append(heading);
      for (const action of group.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
        button.textContent = action.label;
        button.disabled = action.enabled === false;
        button.setAttribute('role', action.checked === undefined ? 'menuitem' : 'menuitemradio');
        if (action.checked !== undefined) {
          button.setAttribute('aria-checked', String(action.checked));
          if (action.checked) {
            const check = document.createElement('span');
            check.className = 'visual-context-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '✓';
            button.append(check);
          }
        }
        button.addEventListener('click', () => {
          close(true);
          action.run();
        });
        section.append(button);
      }
      menu.append(section);
    }
    menu.hidden = false;
    const bounds = pane.getBoundingClientRect();
    const scale = bounds.width / pane.offsetWidth || 1;
    const inset = 4;
    menu.style.left = `${Math.max(inset, Math.min((left - bounds.left) / scale, pane.clientWidth - menu.offsetWidth - inset))}px`;
    menu.style.top = `${Math.max(inset, Math.min((top - bounds.top) / scale, pane.clientHeight - menu.offsetHeight - inset))}px`;
    items()[0]?.focus({ preventScroll: true });
  }

  menu.addEventListener('keydown', event => {
    const buttons = items();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + direction + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home') {
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      buttons.at(-1)?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }, { signal });

  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Node && !menu.contains(event.target)) close();
  }, { capture: true, signal });
  window.addEventListener('blur', () => close(), { signal });
  window.addEventListener('resize', () => close(menu.contains(document.activeElement)), { signal });
  pane.addEventListener('scroll', event => {
    if (event.target instanceof Node && !menu.contains(event.target)) close(menu.contains(document.activeElement));
  }, { capture: true, signal });
  signal.addEventListener('abort', () => menu.remove(), { once: true });
  return { show, close };
}
