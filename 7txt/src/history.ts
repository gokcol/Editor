/** The current document counts as one version, leaving at most 99 undo steps. */
export const MAX_HISTORY_VERSIONS = 100;

export type DocumentHistory = { entries: string[]; index: number };

export function recordHistory(history: DocumentHistory, content: string): void {
  if (history.entries[history.index] === content) return;
  history.entries.splice(history.index + 1);
  history.entries.push(content);
  if (history.entries.length > MAX_HISTORY_VERSIONS) {
    history.entries.splice(0, history.entries.length - MAX_HISTORY_VERSIONS);
  }
  history.index = history.entries.length - 1;
}
