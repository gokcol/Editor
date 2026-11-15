// Test-only desktop bridge. Vite aliases this module in the browser runner;
// it is never imported by the production renderer.
const listeners = new Map<string, Set<(event: { payload: unknown }) => unknown>>();
const counts: Record<string, number> = {};
const last: Record<string, Record<string, any>> = {};
let version = 1;

export function isTauri() { return true; }
export async function invoke(command: string, args: Record<string, any> = {}) {
  counts[command] = (counts[command] || 0) + 1;
  last[command] = args;
  switch (command) {
    case 'recovery_load': return null;
    case 'recovery_save': return Date.now();
    case 'take_pending_open_files': return [];
    case 'file_fingerprint': return { modifiedMillis: 1, size: 0 };
    case 'write_file': return { path: args.path, name: args.path.split('/').at(-1), encoding: args.encoding || 'utf-8', diskVersion: `test-${++version}` };
    default: return null;
  }
}
export async function listen(name: string, callback: (event: { payload: unknown }) => unknown) {
  const callbacks = listeners.get(name) || new Set();
  callbacks.add(callback);
  listeners.set(name, callbacks);
  return () => callbacks.delete(callback);
}
export function getCurrentWebview() { return { onDragDropEvent: async () => () => {} }; }

Object.assign(window, { __desktopTest: {
  counts, last,
  emit: async (name: string, payload?: unknown) => {
    for (const callback of listeners.get(name) || []) await callback({ payload });
  },
} });
