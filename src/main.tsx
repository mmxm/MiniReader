import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import JSZip from 'jszip'
(window as any).JSZip = JSZip
import './index.css'
import App from './App.tsx'

// Intercepter la console pour le diagnostic en direct sur mobile/tablette
const logHistory: string[] = [];
if (typeof window !== 'undefined') {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args) => {
    logHistory.push(`[${new Date().toLocaleTimeString()}] [LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
    if (logHistory.length > 150) logHistory.shift();
    originalLog.apply(console, args);
  };

  console.warn = (...args) => {
    logHistory.push(`[${new Date().toLocaleTimeString()}] [WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
    if (logHistory.length > 150) logHistory.shift();
    originalWarn.apply(console, args);
  };

  console.error = (...args) => {
    logHistory.push(`[${new Date().toLocaleTimeString()}] [ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
    if (logHistory.length > 150) logHistory.shift();
    originalError.apply(console, args);
  };

  (window as any).__logHistory = logHistory;
}

import { registerSW } from 'virtual:pwa-register'

// Enregistrement du service worker avec mise à jour forcée automatique
const updateSW = registerSW({
  onNeedRefresh() {
    console.log('[PWA] Nouvelle version disponible, application de la mise à jour...');
    updateSW(true); // skipWaiting + window.location.reload() automatique
  },
  onOfflineReady() {
    console.log('[PWA] Application prête pour le mode hors ligne.');
  }
});

// Vérifier les mises à jour lorsque l'application redevient visible (retour application ou focus)
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateSW();
    }
  });
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
