import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
