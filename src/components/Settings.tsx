import React, { useState, useEffect } from 'react';
import { koboSyncApi } from '../services/koboSyncApi';
import { db } from '../db/libraryDb';
import { ShieldCheck, CloudLightning, HardDrive, RefreshCw } from 'lucide-react';

interface SettingsProps {
  onConfigSaved: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onConfigSaved }) => {
  const [syncUrl, setSyncUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [stats, setStats] = useState({
    booksCount: 0,
    downloadedCount: 0,
    dictionaryCount: 0,
    queueCount: 0,
  });

  useEffect(() => {
    const savedUrl = localStorage.getItem('bookorbit_sync_url') || '';
    setSyncUrl(savedUrl);
    if (savedUrl) {
      setStatus('success');
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
      onConfigSaved();
      return;
    }

    setStatus('testing');
    setErrorMessage('');

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
        await db.books.where('downloaded').equals(1).modify({ downloaded: false });
        loadStorageStats();
        alert('Cache vidé avec succès.');
      } catch (err) {
        console.error(err);
        alert('Erreur lors du nettoyage du cache.');
      }
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

        <div className="stats-actions">
          <button 
            type="button" 
            className="btn btn-danger" 
            onClick={handleClearCache}
            disabled={stats.downloadedCount === 0}
          >
            Vider le cache hors ligne
          </button>
        </div>
      </div>
    </div>
  );
};
