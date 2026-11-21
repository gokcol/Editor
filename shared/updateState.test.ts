import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUpdatePreferences, updateCheckDue, updateNoticeId, UPDATE_INTERVAL, type UpdateReport } from './updateState.ts';

test('automatic checks require explicit opt-in and use a daily attempt throttle', () => {
  const prefs = normalizeUpdatePreferences(null);
  assert.equal(updateCheckDue(prefs, Date.now()), false);
  for (const raw of [{ automatic: 'true' }, { automatic: 1 }, [], 'yes']) assert.equal(normalizeUpdatePreferences(raw).automatic, false);
  prefs.automatic = true;
  assert.equal(updateCheckDue(prefs, UPDATE_INTERVAL), true);
  prefs.lastAttempt = UPDATE_INTERVAL;
  assert.equal(updateCheckDue(prefs, UPDATE_INTERVAL + 1), false);
  assert.equal(updateCheckDue(prefs, UPDATE_INTERVAL * 2), true);
  assert.equal(updateCheckDue(prefs, UPDATE_INTERVAL - 1), true, 'clock rollback cannot block checks indefinitely');
});

test('malformed preferences cannot enable automatic checks or retain invalid timestamps', () => {
  for (const stamp of [-1, 0, Infinity, NaN, '123', 1.1]) assert.equal(normalizeUpdatePreferences({ lastAttempt: stamp }).lastAttempt, null);
  assert.equal(normalizeUpdatePreferences({ dismissedRelease: 'x'.repeat(201) }).dismissedRelease, null);
});

test('dismissal is scoped to a release and never turns a failed/missing check into an update', () => {
  const prefs = normalizeUpdatePreferences({ dismissedRelease: 'v1.0.2' });
  const report: UpdateReport = { info: { appName: '7TXT', installedVersion: '1.0.1', channel: 'github', releasesUrl: 'https://github.com/gokcol/Editor/releases' }, available: { id: 'v1.0.2', version: '1.0.2', title: 'New', notes: 'Notes', url: 'https://github.com/gokcol/Editor/releases' } };
  assert.equal(updateNoticeId(null, prefs), null);
  assert.equal(updateNoticeId(report, prefs), null);
  report.available!.id = 'v1.0.3';
  assert.equal(updateNoticeId(report, prefs), 'v1.0.3');
  report.available = null;
  assert.equal(updateNoticeId(report, prefs), null);
});
