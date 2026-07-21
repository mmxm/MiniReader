import React, { useEffect, useRef, useState } from 'react';
import { db } from '../db/libraryDb';
import { syncQueueService } from '../services/syncQueue';
import { koboSyncApi } from '../services/koboSyncApi';

interface ReaderProps {
  bookId: string;
  onClose: () => void;
}

export const Reader: React.FC<ReaderProps> = ({ bookId, onClose }) => {
  const [isLoading, setIsLoading] = useState(true);
  const currentProgressRef = useRef({
    percent: 0,
    location: null as { Source: string; Type: string; Value: string } | null,
  });

  const isSavedRef = useRef(false);

  useEffect(() => {
    // 1. Initialiser le jeton pour passer la sécurité de Codexa
    localStorage.setItem('br_token', 'fake-pwa-token');

    // 2. Charger le livre et sa progression
    let active = true;

    async function loadBookData() {
      try {
        const bookData = await db.books.get(bookId);
        const fileData = await db.bookFiles.get(bookId);

        if (!bookData || !fileData) {
          throw new Error('Livre ou fichier introuvable.');
        }

        const arrayBuffer = await fileData.blob.arrayBuffer();

        if (!active) return;

        // Charger la progression locale
        const lastState = await db.readingStates.get(bookId);
        let startPercent = 0;
        let startLocation = '';

        if (lastState && lastState.location) {
          startPercent = lastState.progressPercent;
          startLocation = lastState.location.Value;
          currentProgressRef.current = {
            percent: startPercent,
            location: lastState.location,
          };
        }

        // Tenter de charger la progression distante (si en ligne)
        const syncUrl = localStorage.getItem('bookorbit_sync_url');
        if (syncUrl && navigator.onLine) {
          try {
            const remoteState = await Promise.race([
              koboSyncApi.fetchReadingState(syncUrl, bookId),
              new Promise<any>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout de synchronisation distante')), 1200)
              )
            ]);
            if (remoteState && remoteState.CurrentBookmark) {
              const remoteBookmark = remoteState.CurrentBookmark;
              const remotePercent = remoteBookmark.ProgressPercent ?? 0;
              const remoteLocation = remoteBookmark.Location;
              const remoteLastModified = remoteBookmark.LastModified || new Date().toISOString();

              if (remoteLocation && remoteLocation.Value) {
                const isRemoteNewer = !lastState || new Date(remoteLastModified) > new Date(lastState.lastModified);
                if (isRemoteNewer) {
                  startPercent = remotePercent;
                  startLocation = remoteLocation.Value;
                  
                  currentProgressRef.current = {
                    percent: remotePercent,
                    location: {
                      Source: 'BookOrbit',
                      Type: 'epubcfi',
                      Value: remoteLocation.Value
                    }
                  };
                }
              }
            }
          } catch (err) {
            console.warn('[Reader PWA] Erreur fetch progression distante :', err);
          }
        }

        // Pré-remplir localStorage de Codexa pour qu'il reprenne à la bonne page
        const cachePayload = {
          cfi_position: startLocation,
          percentage: startPercent / 100,
          device: 'Codexa'
        };
        localStorage.setItem(`br_progress_${bookId}`, JSON.stringify(cachePayload));

        // Rendre les variables globales disponibles pour l'iframe
        (window as any)._epubArrayBuffer = arrayBuffer;
        (window as any)._bookMetadata = {
          id: bookId,
          title: bookData.title,
          file_hash: bookId
        };

        setIsLoading(false);
      } catch (err) {
        console.error('[Reader PWA] Erreur chargement :', err);
        alert('Erreur lors du chargement du livre.');
        onClose();
      }
    }

    loadBookData();

    // Écouter les messages provenant de l'iframe
    const handleMessage = async (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;

      if (e.data.type === 'cx-progress') {
        const { cfi, percent } = e.data;
        currentProgressRef.current = {
          percent: percent,
          location: {
            Source: 'BookOrbit',
            Type: 'epubcfi',
            Value: cfi
          }
        };
      }

      if (e.data.type === 'cx-close') {
        setIsLoading(true);
        await saveProgressState(true); // force sync
        isSavedRef.current = true;
        onClose();
      }
    };

    window.addEventListener('message', handleMessage);

    // Sauvegarde en cas de mise en veille / flou de fenêtre
    const handleVisibilityOrBlur = () => {
      saveProgressState(true);
    };
    window.addEventListener('visibilitychange', handleVisibilityOrBlur);
    window.addEventListener('blur', handleVisibilityOrBlur);

    return () => {
      active = false;
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('visibilitychange', handleVisibilityOrBlur);
      window.removeEventListener('blur', handleVisibilityOrBlur);
      
      // Nettoyer les variables globales
      delete (window as any)._epubArrayBuffer;
      delete (window as any)._bookMetadata;

      // Sauvegarde finale de secours
      if (!isSavedRef.current) {
        saveProgressState(false);
      }
    };
  }, [bookId]);

  const saveProgressState = async (_triggerSync: boolean): Promise<void> => {
    const curr = currentProgressRef.current;
    if (curr.percent === 0 && curr.location === null) return;

    try {
      await syncQueueService.addProgressUpdate(
        bookId,
        curr.percent,
        curr.location
      );
    } catch (e) {
      console.error('[Reader PWA] Erreur sauvegarde progression :', e);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'fixed', inset: 0, backgroundColor: '#000', zIndex: 1000 }}>
      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#fff', gap: '16px', fontFamily: 'system-ui' }}>
          <div style={{ border: '4px solid rgba(255,255,255,0.1)', borderLeftColor: '#fff', borderRadius: '50%', width: '40px', height: '40px', animation: 'spin 1s linear infinite' }}></div>
          <p>Chargement du lecteur d'ebook...</p>
          <style>{`
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      ) : (
        <iframe
          src={`/reader.html?id=${bookId}`}
          style={{ border: 'none', width: '100%', height: '100%' }}
          title="Lecteur d'ebook Codexa"
        />
      )}
    </div>
  );
};
