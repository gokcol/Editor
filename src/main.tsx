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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App desktop={desktop} />
  </StrictMode>,
);
