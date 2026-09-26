import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createBrowserDesktopApi } from './desktop/browser';
import { createTauriDesktopApi, isTauriDesktop } from './desktop/tauri';
import './styles.css';

// Choose the native bridge before the workbench mounts. Tauri is detected via
// its own guarded runtime predicate; browser development falls back to a
// local, intentionally limited adapter.
const desktop = isTauriDesktop()
  ? createTauriDesktopApi()
  : createBrowserDesktopApi();

async function start() {
  let recovery: unknown;
  let recoveryError: string | undefined;
  try { recovery = (await desktop.recovery.load())?.payload; }
  catch (error) { recoveryError = String(error); }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App desktop={desktop} initialRecovery={recovery} recoveryLoadError={recoveryError} />
    </StrictMode>,
  );
}
void start();
