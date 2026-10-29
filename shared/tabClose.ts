export type CloseableTab = { id: string; name: string; recoveryDraft?: boolean; pinned?: boolean };

export function isCloseProtected(tab: CloseableTab) {
  return tab.pinned === true && !tab.recoveryDraft;
}

/** Confirm the exact buffers being discarded, not newer edits arriving during the dialog. */
export async function confirmTabClose<T extends CloseableTab>(
  targets: readonly T[],
  current: (id: string) => T | undefined,
  isDirty: (tab: T) => boolean,
  confirm: (message: string) => Promise<boolean>,
): Promise<'confirmed' | 'cancelled' | 'changed' | 'protected'> {
  if (!targets.length) return 'cancelled';
  if (targets.some(isCloseProtected)) return 'protected';
  if (targets.some((tab) => tab.recoveryDraft || isDirty(tab))) {
    const recovered = targets.some((tab) => tab.recoveryDraft);
    const subject = targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} tabs`;
    const message = `Close ${subject} without saving? ${recovered
      ? 'Recovered drafts and their recovery copies will be discarded.'
      : 'Unsaved changes will be discarded.'} Choose Cancel to keep editing or use Save As first. Saved files on disk will not be deleted.`;
    if (!await confirm(message)) return 'cancelled';
  }
  return targets.every((tab) => current(tab.id) === tab) ? 'confirmed' : 'changed';
}
