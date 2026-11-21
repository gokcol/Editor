import { invoke, isTauri } from '@tauri-apps/api/core';
import { unavailableUpdatesApi, type UpdateInfo, type UpdateReport, type UpdatesApi } from './updateState';

export function createNativeUpdatesApi(): UpdatesApi {
  if (!isTauri()) return unavailableUpdatesApi();
  return {
    native: true,
    info: () => invoke<UpdateInfo>('updates_info'),
    check: () => invoke<UpdateReport>('updates_check'),
    open: (destination) => invoke<void>('updates_open', { destination }),
  };
}
