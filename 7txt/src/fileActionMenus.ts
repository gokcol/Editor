type Menu = { group: HTMLElement; trigger: HTMLButtonElement; panel: HTMLElement; items: HTMLButtonElement[] };

/** Toolbar menus reveal on hover without taking focus from the editor. */
export function setupFileActionMenus(root: HTMLElement, options: { canOpen: () => boolean; beforeOpen: () => void }) {
  const menus = Array.from(root.querySelectorAll<HTMLElement>('.file-action-group')).map((group): Menu => ({
    group,
    trigger: group.querySelector<HTMLButtonElement>('.file-action-trigger')!,
    panel: group.querySelector<HTMLElement>('.file-action-menu')!,
    items: Array.from(group.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')),
  }));
  let active: Menu | null = null;
  let explicit = false;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers() { clearTimeout(openTimer); clearTimeout(closeTimer); }
  function close(restoreFocus = false) {
    clearTimers();
    const previous = active;
    active = null;
    if (!previous) return;
    // Never leave focus inside a panel that is about to become hidden.
    if (restoreFocus || previous.panel.contains(document.activeElement)) previous.trigger.focus({ preventScroll: true });
    previous.panel.hidden = true;
    previous.trigger.setAttribute('aria-expanded', 'false');
  }
  function open(menu: Menu, focusIndex?: number) {
    clearTimers();
    if (!options.canOpen()) return;
    if (active !== menu) {
      close();
      options.beforeOpen();
      active = menu;
      explicit = false;
      menu.panel.hidden = false;
      menu.trigger.setAttribute('aria-expanded', 'true');
    }
    if (focusIndex !== undefined) {
      explicit = true;
      menu.items[focusIndex]?.focus({ preventScroll: true });
    }
  }

  for (const menu of menus) {
    menu.group.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return;
      clearTimers();
      if (active !== menu) openTimer = setTimeout(() => open(menu), 120);
    });
    menu.group.addEventListener('pointerleave', () => {
      clearTimers();
      if (active === menu && !menu.group.contains(document.activeElement)) closeTimer = setTimeout(() => close(), 180);
    });
    menu.trigger.addEventListener('click', () => {
      if (active === menu && explicit) close(true);
      else open(menu, 0);
    });
    menu.group.addEventListener('focusout', (event) => {
      // During pointer focus changes activeElement can briefly be body. Use the
      // destination so clicking another item cannot hide it before its click.
      if (active === menu && !(event.relatedTarget instanceof Node && menu.group.contains(event.relatedTarget))) close();
    });
    menu.panel.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[role="menuitem"]')) return;
      // The existing action handler runs next. Dialogs can return to this trigger.
      close(true);
    });
    menu.group.addEventListener('keydown', (event) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === 'Tab') { close(true); return; }
      if (event.key === 'Escape') { close(true); event.preventDefault(); event.stopPropagation(); return; }
      const index = menu.items.indexOf(document.activeElement as HTMLButtonElement);
      const fromTrigger = document.activeElement === menu.trigger;
      let next: number | undefined;
      if (event.key === 'ArrowDown') next = fromTrigger ? 0 : (index + 1) % menu.items.length;
      else if (event.key === 'ArrowUp') next = fromTrigger ? menu.items.length - 1 : (index - 1 + menu.items.length) % menu.items.length;
      else if (!fromTrigger && event.key === 'Home') next = 0;
      else if (!fromTrigger && event.key === 'End') next = menu.items.length - 1;
      else if (active === menu && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        open(menus[(menus.indexOf(menu) + direction + menus.length) % menus.length], 0);
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (next !== undefined) { open(menu, next); event.preventDefault(); event.stopPropagation(); }
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (!active) return;
    if (event.key === 'Escape') {
      close(active.group.contains(document.activeElement));
      event.preventDefault(); event.stopPropagation();
    } else if (event.metaKey || event.ctrlKey) close();
  });
  window.addEventListener('blur', () => close());
  return { close };
}
