export type UpdateChannel = 'github' | 'store' | 'sideloaded' | 'unsupported';
export type UpdateInfo = { appName: string; installedVersion: string; channel: UpdateChannel; releasesUrl: string };
export type AvailableUpdate = { id: string; version: string | null; title: string; notes: string; url: string };
export type UpdateReport = { info: UpdateInfo; available: AvailableUpdate | null };
export type UpdatesApi = {
  native: boolean;
  info: () => Promise<UpdateInfo>;
  check: () => Promise<UpdateReport>;
  open: (destination: 'releases' | 'download') => Promise<void>;
};
export type UpdatePreferences = { automatic: boolean; lastAttempt: number | null; dismissedRelease: string | null };
export const UPDATE_INTERVAL = 86_400_000;

export function normalizeUpdatePreferences(value: unknown): UpdatePreferences {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    automatic: raw.automatic === true,
    lastAttempt: typeof raw.lastAttempt === 'number' && Number.isSafeInteger(raw.lastAttempt) && raw.lastAttempt > 0 ? raw.lastAttempt : null,
    dismissedRelease: typeof raw.dismissedRelease === 'string' && raw.dismissedRelease.length <= 200 ? raw.dismissedRelease : null,
  };
}

export function updateCheckDue(prefs: UpdatePreferences, now: number): boolean {
  return prefs.automatic && (prefs.lastAttempt === null || now < prefs.lastAttempt || now - prefs.lastAttempt >= UPDATE_INTERVAL);
}

export function updateNoticeId(report: UpdateReport | null, prefs: UpdatePreferences): string | null {
  return report?.available && report.available.id !== prefs.dismissedRelease ? report.available.id : null;
}

export function unavailableUpdatesApi(): UpdatesApi {
  const unavailable = async (): Promise<never> => { throw new Error('Update checks are available in the desktop app.'); };
  return { native: false, info: unavailable, check: unavailable, open: unavailable };
}
