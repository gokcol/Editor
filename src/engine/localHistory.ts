export type LocalSnapshot = {
  id: string;
  createdAt: number;
  value: string;
};

const HISTORY_PREFIX = 'diagram-foundry:history:';
const MAX_SNAPSHOTS = 32;

export function historyKey(scope: string) {
  return `${HISTORY_PREFIX}${scope}`;
}

export function readSnapshots(scope: string): LocalSnapshot[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(historyKey(scope)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LocalSnapshot => (
      item && typeof item.id === 'string' && typeof item.createdAt === 'number' && typeof item.value === 'string'
    )).slice(0, MAX_SNAPSHOTS);
  } catch {
    return [];
  }
}

export function rememberSnapshot(scope: string, value: string): LocalSnapshot[] {
  const current = readSnapshots(scope);
  if (current[0]?.value === value) return current;
  const next = [{ id: crypto.randomUUID(), createdAt: Date.now(), value }, ...current].slice(0, MAX_SNAPSHOTS);
  try {
    window.localStorage.setItem(historyKey(scope), JSON.stringify(next));
  } catch {
    // History is a local convenience; failing storage must never block editing.
  }
  return next;
}

export function clearSnapshots(scope: string) {
  try { window.localStorage.removeItem(historyKey(scope)); } catch { /* ignored */ }
}
