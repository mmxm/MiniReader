import { useState, useEffect } from 'react';
import { db } from './db/libraryDb';
import { syncQueueService } from './services/syncQueue';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { Settings } from './components/Settings';
import { ConflictResolver } from './components/ConflictResolver';
import { BookOpen, Settings as SettingsIcon } from 'lucide-react';

export default function App() {
  const [activeView, setActiveView] = useState<'library' | 'settings'>('library');
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [syncTrigger, setSyncTrigger] = useState(0);

  // État de gestion des conflits
  const [conflict, setConflict] = useState<{
    bookId: string;
    bookTitle: string;
    localProgress: number;
    localDate: string;
    remoteProgress: number;
    remoteDate: string;
  } | null>(null);

  useEffect(() => {
    // Essayer de traiter la queue de synchro au chargement si on est en ligne
    if (navigator.onLine) {
      syncQueueService.processQueue().catch(console.error);
    }
  }, []);

  const handleConflictDetected = (data: typeof conflict) => {
    setConflict(data);
  };

  const handleResolveConflict = async (choice: 'local' | 'remote') => {
    if (!conflict) return;

    const { bookId, localProgress, remoteProgress, remoteDate } = conflict;

    try {
      if (choice === 'local') {
        // Option locale : on garde la progression locale. 
        // On la marque non synchronisée pour forcer le push vers BookOrbit.
        await db.readingStates.update(bookId, { synced: false });
        
        // Empiler la progression locale pour le prochain push
        const localState = await db.readingStates.get(bookId);
        if (localState) {
          await syncQueueService.addProgressUpdate(
            bookId, 
            localProgress, 
            localState.location
          );
        }
      } else {
        // Option distante : on écrase l'avancement local avec l'avancement serveur.
        const localState = await db.readingStates.get(bookId);
        await db.readingStates.put({
          bookId,
          progressPercent: remoteProgress,
          lastModified: remoteDate,
          location: localState ? localState.location : null, // Fallback location
          statistics: localState ? localState.statistics : null,
          statusInfo: localState ? localState.statusInfo : null,
          synced: true // Déjà aligné avec le serveur
        });
      }

      // Fermer le dialogue de conflit
      setConflict(null);
      // Forcer le rechargement de la bibliothèque
      setSyncTrigger(prev => prev + 1);
    } catch (e) {
      console.error('Erreur lors de la résolution du conflit :', e);
    }
  };

  const handleConfigSaved = () => {
    // Rafraîchir la bibliothèque une fois configuré
    setSyncTrigger(prev => prev + 1);
    setActiveView('library');
  };

  // Si un livre est en cours de lecture, on affiche uniquement le lecteur (sans les menus globaux)
  if (activeBookId) {
    return (
      <Reader 
        bookId={activeBookId} 
        onClose={() => {
          setActiveBookId(null);
          setSyncTrigger(prev => prev + 1); // Rafraîchir bibliothèque
        }} 
      />
    );
  }

  return (
    <div className="app-container">
      {/* Contenu principal */}
      <main className="app-main">
        {activeView === 'library' && (
          <Library 
            onOpenBook={setActiveBookId} 
            onConflictDetected={handleConflictDetected}
            syncTrigger={syncTrigger}
          />
        )}
        {activeView === 'settings' && (
          <Settings onConfigSaved={handleConfigSaved} />
        )}
      </main>

      {/* Menu de navigation bas de page */}
      <nav className="bottom-nav glass">
        <button 
          onClick={() => setActiveView('library')} 
          className={`nav-item ${activeView === 'library' ? 'active' : ''}`}
        >
          <BookOpen size={20} />
          <span>Bibliothèque</span>
        </button>
        <button 
          onClick={() => setActiveView('settings')} 
          className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
        >
          <SettingsIcon size={20} />
          <span>Paramètres</span>
        </button>
      </nav>

      {/* Pop-up de Résolution de Conflits */}
      {conflict && (
        <ConflictResolver
          isOpen={true}
          bookTitle={conflict.bookTitle}
          localProgress={conflict.localProgress}
          localDate={conflict.localDate}
          remoteProgress={conflict.remoteProgress}
          remoteDate={conflict.remoteDate}
          onResolve={handleResolveConflict}
        />
      )}
    </div>
  );
}
