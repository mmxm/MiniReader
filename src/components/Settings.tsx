import React, { useState, useEffect } from 'react';
import { koboSyncApi } from '../services/koboSyncApi';
import { db } from '../db/libraryDb';
import { ShieldCheck, CloudLightning, HardDrive, RefreshCw } from 'lucide-react';

declare const __APP_VERSION__: string;
declare const __COMMIT_HASH__: string;

interface SettingsProps {
  onConfigSaved: () => void;
  appTheme: string;
  onThemeChange: (theme: string) => void;
}

export const Settings: React.FC<SettingsProps> = ({ onConfigSaved, appTheme, onThemeChange }) => {
  const [syncUrl, setSyncUrl] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [stats, setStats] = useState({
    booksCount: 0,
    downloadedCount: 0,
    dictionaryCount: 0,
    queueCount: 0,
  });
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const handleToggleLogs = () => {
    if (!showLogs) {
      setLogs((window as any).__logHistory || []);
    }
    setShowLogs(!showLogs);
  };

  useEffect(() => {
    const savedUrl = localStorage.getItem('bookorbit_sync_url') || '';
    setSyncUrl(savedUrl);
    setUseProxy(localStorage.getItem('bookorbit_use_proxy') === 'true');
    if (savedUrl) {
      if (navigator.onLine) {
        setStatus('testing');
        koboSyncApi.initialize(savedUrl)
          .then((data) => {
            if (data && data.Resources) {
              setStatus('success');
            } else {
              setStatus('error');
              setErrorMessage('Réponse serveur incorrecte.');
            }
          })
          .catch((err) => {
            setStatus('error');
            if (err.message && err.message.includes('401')) {
              setErrorMessage('Jeton de périphérique expiré ou invalide (Erreur 401).');
            } else {
              setErrorMessage(err.message || 'Impossible de joindre le serveur.');
            }
          });
      } else {
        setStatus('success');
      }
    } else {
      setStatus('idle');
    }
    loadStorageStats();
  }, []);

  const loadStorageStats = async () => {
    try {
      const books = await db.books.toArray();
      const downloaded = books.filter(b => b.downloaded).length;
      const dict = await db.dictionary.count();
      const queue = await db.syncQueue.count();
      setStats({
        booksCount: books.length,
        downloadedCount: downloaded,
        dictionaryCount: dict,
        queueCount: queue,
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleTestAndSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!syncUrl.trim()) {
      setStatus('idle');
      localStorage.removeItem('bookorbit_sync_url');
      localStorage.removeItem('bookorbit_use_proxy');
      onConfigSaved();
      return;
    }

    setStatus('testing');
    setErrorMessage('');

    // Sauvegarder d'abord la préférence temporairement car koboSyncApi.initialize va la lire
    localStorage.setItem('bookorbit_use_proxy', useProxy ? 'true' : 'false');

    try {
      // Tester l'initialisation de l'API
      const data = await koboSyncApi.initialize(syncUrl);
      if (data && data.Resources) {
        localStorage.setItem('bookorbit_sync_url', syncUrl.trim());
        setStatus('success');
        onConfigSaved();
        loadStorageStats();
      } else {
        throw new Error('Réponse invalide du serveur (les ressources Kobo sont absentes).');
      }
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMessage(err.message || 'Impossible de se connecter au serveur. Vérifiez l\'URL.');
    }
  };

  const handleClearCache = async () => {
    if (window.confirm('Voulez-vous supprimer tous les livres téléchargés localement ? Les métadonnées et votre avancement seront conservés.')) {
      try {
        await db.bookFiles.clear();
        await db.books.toCollection().modify({ downloaded: false });
        loadStorageStats();
        alert('Cache vidé avec succès.');
      } catch (err) {
        console.error(err);
        alert('Erreur lors du nettoyage du cache.');
      }
    }
  };

  const handleCompleteResetAndSync = async () => {
    if (window.confirm('ATTENTION: Cela va supprimer tous vos livres téléchargés localement, vider votre progression locale et forcer une synchronisation complète depuis zéro. Votre URL BookOrbit sera conservée. Voulez-vous continuer ?')) {
      try {
        setStatus('testing');
        await db.books.clear();
        await db.bookFiles.clear();
        await db.readingStates.clear();
        await db.syncQueue.clear();
        
        localStorage.removeItem('bookorbit_sync_token');
        localStorage.removeItem('bookorbit_last_sync_date');
        
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('br_progress_') || key.startsWith('br_cx_page_'))) {
            localStorage.removeItem(key);
          }
        }
        
        localStorage.setItem('force_sync_on_load', 'true');
        loadStorageStats();
        setStatus('success');
        
        alert('Réinitialisation terminée. Redirection vers la bibliothèque pour lancer la synchronisation...');
        onConfigSaved();
      } catch (err) {
        console.error(err);
        setStatus('error');
        alert('Erreur lors de la réinitialisation.');
      }
    }
  };

  const handleForceFullSync = () => {
    if (window.confirm('Voulez-vous réinitialiser le jeton de synchronisation locale ? La prochaine synchronisation retéléchargera tout le catalogue à partir de zéro.')) {
      localStorage.removeItem('bookorbit_sync_token');
      localStorage.removeItem('bookorbit_last_sync_date');
      alert('Jeton réinitialisé. La prochaine synchronisation sera complète.');
      loadStorageStats();
    }
  };

  return (
    <div className="settings-container">
      <div className="card glass">
        <h2 className="card-title">
          <CloudLightning className="title-icon" /> Connexion BookOrbit
        </h2>
        <p className="card-subtitle">
          Renseignez l'URL Kobo Sync de votre serveur BookOrbit pour charger vos livres et synchroniser votre avancement.
        </p>

        <form onSubmit={handleTestAndSave} className="settings-form">
          <div className="input-group">
            <label htmlFor="sync-url">URL Kobo Sync</label>
            <input
              id="sync-url"
              type="url"
              placeholder="https://votre-serveur.com/api/v1/kobo/votre_device_token"
              value={syncUrl}
              onChange={(e) => setSyncUrl(e.target.value)}
              className="glass-input"
            />
            <span className="input-help">
              Vous trouverez cette URL dans BookOrbit, sous <strong>Paramètres &gt; Kobo &gt; Ajouter un périphérique</strong>.
            </span>
          </div>

          <div className="input-group checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={useProxy}
                onChange={(e) => setUseProxy(e.target.checked)}
              />
              <span>Utiliser le proxy Vercel (contournement CORS)</span>
            </label>
            <span className="input-help">
              Cochez cette case si votre navigateur bloque les requêtes directes (erreur CORS).
            </span>
          </div>

          <div className="input-group">
            <label>Thème de l'application</label>
            <div className="theme-buttons">
              <button
                type="button"
                className={`theme-btn ${appTheme === 'dark' ? 'active' : ''}`}
                onClick={() => onThemeChange('dark')}
              >
                Sombre
              </button>
              <button
                type="button"
                className={`theme-btn ${appTheme === 'light' ? 'active' : ''}`}
                onClick={() => onThemeChange('light')}
              >
                Clair
              </button>
            </div>
          </div>

          <div className="status-indicator-wrapper">
            {status === 'testing' && (
              <div className="status-badge testing">
                <RefreshCw className="spinner" /> Connexion en cours...
              </div>
            )}
            {status === 'success' && (
              <div className="status-badge success">
                <ShieldCheck /> Connecté à BookOrbit
              </div>
            )}
            {status === 'error' && (
              <div className="status-badge error">
                Connexion échouée : {errorMessage}
              </div>
            )}
          </div>

          <button 
            type="submit" 
            className="btn btn-primary"
            disabled={status === 'testing'}
          >
            Tester et Enregistrer
          </button>
        </form>
      </div>

      <div className="card glass stats-card">
        <h2 className="card-title">
          <HardDrive className="title-icon" /> Stockage &amp; Données
        </h2>
        <div className="stats-grid">
          <div className="stat-item">
            <span className="stat-label">Livres synchronisés</span>
            <span className="stat-val">{stats.booksCount}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Téléchargés hors ligne</span>
            <span className="stat-val">{stats.downloadedCount}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Définitions dans le dictionnaire</span>
            <span className="stat-val">{stats.dictionaryCount}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">En attente de synchro</span>
            <span className="stat-val">{stats.queueCount}</span>
          </div>
        </div>

        <div className="stats-actions" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' }}>
          <button 
            type="button" 
            className="btn btn-danger" 
            onClick={handleClearCache}
          >
            Vider le cache hors ligne
          </button>
          <button 
            type="button" 
            className="btn btn-warning" 
            onClick={handleCompleteResetAndSync}
          >
            Réinitialiser &amp; Tout Synchroniser
          </button>
          <button 
            type="button" 
            className="btn btn-secondary" 
            onClick={handleForceFullSync}
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-color)' }}
          >
            Forcer une synchronisation complète
          </button>
        </div>
      </div>

      {/* Console de diagnostic */}
      <div className="card settings-card" style={{ marginTop: '24px' }}>
        <h2 className="card-title" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={handleToggleLogs}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>📋 Diagnostic &amp; Logs</span>
          <button type="button" className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 8px' }}>
            {showLogs ? 'Masquer' : 'Afficher'}
          </button>
        </h2>
        {showLogs && (
          <div style={{ marginTop: '16px' }}>
            <button 
              type="button"
              onClick={() => setLogs((window as any).__logHistory || [])} 
              className="btn btn-secondary" 
              style={{ marginBottom: '12px', fontSize: '12px', padding: '4px 8px' }}
            >
              Rafraîchir
            </button>
            <div style={{ 
              backgroundColor: 'rgba(0,0,0,0.2)', 
              borderRadius: '4px', 
              padding: '12px', 
              maxHeight: '250px', 
              overflowY: 'auto', 
              fontFamily: 'monospace', 
              fontSize: '11px',
              whiteSpace: 'pre-wrap',
              border: '1px solid rgba(255,255,255,0.05)',
              textAlign: 'left'
            }}>
              {logs.length === 0 ? (
                <span style={{ color: 'var(--text-muted)' }}>Aucun log enregistré pour l'instant.</span>
              ) : (
                logs.map((log, i) => {
                  let color = 'inherit';
                  if (log.includes('[WARN]')) color = '#f59e0b';
                  if (log.includes('[ERROR]')) color = '#ef4444';
                  return (
                    <div key={i} style={{ color, marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '4px' }}>
                      {log}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      <div className="version-info">
        MiniReader v{__APP_VERSION__} (commit {__COMMIT_HASH__})
      </div>
    </div>
  );
};
