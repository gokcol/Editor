export type RecentMenuItem = { id: string; label: string };

const ACTION_PREFIX = 'open-recent:';
const MAX_ITEMS = 20;
const MAX_ID_LENGTH = 4096;
const MAX_LABEL_LENGTH = 240;

function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function shorten(value: string, limit: number, middle = false): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  if (!middle) return characters.slice(0, limit - 1).join('') + '…';
  const start = Math.ceil((limit - 1) / 2);
  return characters.slice(0, start).join('') + '…' + characters.slice(-(limit - 1 - start)).join('');
}

/** Input is already ordered by recency. Menu IDs identify entries, never list positions. */
export function recentMenuItems(
  entries: readonly { id: string; name: string; path: string; kind?: string }[],
): RecentMenuItem[] {
  const selected: { id: string; name: string; path: string; kind?: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let id: string;
    try { id = encodeURIComponent(entry.id); } catch { continue; }
    // Do not truncate an identity: that could open a different recent entry.
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const path = cleanLabel(entry.path);
    const name = cleanLabel(entry.name) || path.split(/[\\/]/).pop() || 'Untitled';
    selected.push({ id, name, path, kind: entry.kind });
    if (selected.length === MAX_ITEMS) break;
  }
  const counts = new Map<string, number>();
  for (const entry of selected) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const labels = new Map<string, number>();
  return selected.map(({ id, name, path, kind }) => {
    let label = (counts.get(name) ?? 0) > 1
      ? `${shorten(name, 80)} — ${shorten(path, 150, true) || cleanLabel(kind ?? '') || 'Recent item'}`
      : shorten(name, MAX_LABEL_LENGTH);
    const duplicate = (labels.get(label) ?? 0) + 1;
    labels.set(label, duplicate);
    if (duplicate > 1) label = `${shorten(label, MAX_LABEL_LENGTH - 6)} (${duplicate})`;
    return { id, label };
  });
}

export function recentMenuEntryId(action: string): string | null {
  if (!action.startsWith(ACTION_PREFIX)) return null;
  const token = action.slice(ACTION_PREFIX.length);
  if (!token || token.length > MAX_ID_LENGTH || !/^(?:[A-Za-z0-9_.!~*'()-]|%[\da-fA-F]{2})+$/.test(token)) return null;
  try { return decodeURIComponent(token) || null; } catch { return null; }
}

type Waiter = { resolve: () => void; reject: (reason: unknown) => void };
type Update = { entries: RecentMenuItem[]; key: string; waiters: Waiter[] };

/** Queued calls settle with the latest queued snapshot; an in-flight failure rejects its own callers. */
export function createRecentMenuSync(write: (entries: RecentMenuItem[]) => Promise<void>) {
  let pending: Update | undefined;
  let running = false;
  let appliedKey: string | undefined;

  async function drain() {
    running = true;
    while (pending) {
      const update = pending;
      pending = undefined;
      try {
        if (update.key !== appliedKey) await write(update.entries);
        appliedKey = update.key;
        update.waiters.forEach(({ resolve }) => resolve());
      } catch (error) {
        // A failed native update may have partially changed the menu; allow a full retry.
        appliedKey = undefined;
        update.waiters.forEach(({ reject }) => reject(error));
      }
    }
    running = false;
  }

  return (entries: RecentMenuItem[]): Promise<void> => {
    const snapshot = entries.map(({ id, label }) => ({ id, label }));
    const key = JSON.stringify(snapshot);
    return new Promise<void>((resolve, reject) => {
      const waiters = pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      pending = { entries: snapshot, key, waiters };
      if (!running) void drain();
    });
  };
}
