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
    if (!isLoading) {
      console.log("[Reader PWA] [Parent] isLoading est passé à false. L'élément <iframe> va être injecté.");
    }
  }, [isLoading]);

  useEffect(() => {
    console.log(`[Reader PWA] Montage du lecteur pour le livre ID: ${bookId}`);
    
    // 1. Initialiser le jeton pour passer la sécurité de Codexa
    localStorage.setItem('br_token', 'fake-pwa-token');
    console.log('[Reader PWA] Jeton fake-pwa-token injecté dans localStorage.');

    // 2. Charger le livre et sa progression
    let active = true;

    async function loadBookData() {
      try {
        console.log('[Reader PWA] [Étape 1/6] Lecture des métadonnées du livre dans IndexedDB...');
        const bookData = await db.books.get(bookId);
        if (!bookData) {
          throw new Error('Métadonnées du livre introuvables.');
        }
        console.log(`[Reader PWA] Métadonnées chargées. Titre: "${bookData.title}"`);

        console.log('[Reader PWA] [Étape 2/6] Lecture du fichier ePub dans IndexedDB...');
        const fileData = await db.bookFiles.get(bookId);
        if (!fileData) {
          throw new Error('Fichier ePub du livre introuvable en local.');
        }
        console.log(`[Reader PWA] Fichier ePub récupéré. Taille du blob: ${fileData.blob.size} octets`);

        console.log('[Reader PWA] [Étape 3/6] Extraction de l\'ArrayBuffer depuis le Blob...');
        const arrayBuffer = await fileData.blob.arrayBuffer();
        console.log(`[Reader PWA] ArrayBuffer extrait avec succès. Taille: ${arrayBuffer.byteLength} octets`);

        if (!active) {
          console.log('[Reader PWA] Chargement annulé (le composant a été démonté pendant l\'extraction).');
          return;
        }

        // Charger la progression locale
        console.log('[Reader PWA] [Étape 4/6] Lecture de la progression locale (IndexedDB)...');
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
          console.log(`[Reader PWA] Progression locale trouvée: ${startPercent}% (CFI: ${startLocation})`);
        } else {
          console.log('[Reader PWA] Aucune progression locale trouvée. Démarrage au début (0%).');
        }

        // Tenter de charger la progression distante (si en ligne)
        const syncUrl = localStorage.getItem('bookorbit_sync_url');
        console.log(`[Reader PWA] [Étape 5/6] Configuration BookOrbit : ${syncUrl ? 'Détectée' : 'Aucune URL configurée'}`);
        
        if (syncUrl && navigator.onLine) {
          try {
            console.log('[Reader PWA] Lancement de la requête de synchronisation distante avec un timeout de 1.2s...');
            const remoteState = await Promise.race([
              koboSyncApi.fetchReadingState(syncUrl, bookId),
              new Promise<any>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout de synchronisation distante (1.2s dépassé)')), 1200)
              )
            ]);
            
            console.log('[Reader PWA] Réponse brute reçue de BookOrbit:', remoteState);
            
            if (remoteState && remoteState.CurrentBookmark) {
              const remoteBookmark = remoteState.CurrentBookmark;
              const remotePercent = remoteBookmark.ProgressPercent ?? 0;
              const remoteLocation = remoteBookmark.Location;
              const remoteLastModified = remoteBookmark.LastModified || new Date().toISOString();

              console.log(`[Reader PWA] Progression distante trouvée : ${remotePercent}% (CFI: ${remoteLocation?.Value || 'aucun'}, modifiée le: ${remoteLastModified})`);

              if (remoteLocation && remoteLocation.Value) {
                const isRemoteNewer = !lastState || new Date(remoteLastModified) > new Date(lastState.lastModified);
                console.log(`[Reader PWA] Comparaison progression distante vs locale : distante est plus récente ? ${isRemoteNewer}`);
                
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
                  console.log(`[Reader PWA] Progression distante appliquée comme point de départ: ${startPercent}%`);
                }
              }
            } else {
              console.log('[Reader PWA] Aucune progression distante trouvée sur BookOrbit pour ce livre.');
            }
          } catch (err: any) {
            console.warn('[Reader PWA] Échec ou timeout de la progression distante (utilisation de la progression locale) :', err.message || err);
          }
        } else {
          console.log(`[Reader PWA] Pas de requête distante : en ligne ? ${navigator.onLine}, a une URL de synchro ? ${!!syncUrl}`);
        }

        // Pré-remplir localStorage de Codexa pour qu'il reprenne à la bonne page
        console.log('[Reader PWA] [Étape 6/6] Pré-remplissage du cache de progression localStorage pour Codexa...');
        const cachePayload = {
          cfi_position: startLocation,
          percentage: startPercent / 100,
          device: 'Codexa'
        };
        localStorage.setItem(`br_progress_${bookId}`, JSON.stringify(cachePayload));
        console.log(`[Reader PWA] Clé br_progress_${bookId} écrite dans localStorage :`, cachePayload);

        // Rendre les variables globales disponibles pour l'iframe
        console.log('[Reader PWA] Injection des variables _epubArrayBuffer et _bookMetadata sur l\'objet global window...');
        (window as any)._epubArrayBuffer = arrayBuffer;
        (window as any)._bookMetadata = {
          id: bookId,
          title: bookData.title,
          file_hash: bookId
        };
        console.log('[Reader PWA] Injection globale réussie.');

        console.log('[Reader PWA] Initialisation terminée. isLoading = false. L\'iframe du lecteur va s\'insérer.');
        setIsLoading(false);
      } catch (err: any) {
        console.error('[Reader PWA] Erreur critique lors de la phase de chargement :', err.message || err);
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
        console.log(`[Reader PWA] Progression reçue de l'IFrame : ${percent}% (CFI: ${cfi})`);
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
        console.log('[Reader PWA] Message de fermeture cx-close reçu de l\'IFrame. Démarrage de la sauvegarde finale...');
        setIsLoading(true);
        await saveProgressState(true); // force sync
        isSavedRef.current = true;
        console.log('[Reader PWA] Sauvegarde finale terminée. Fermeture du lecteur.');
        onClose();
      }
    };

    window.addEventListener('message', handleMessage);

    // Sauvegarde en cas de mise en veille / flou de fenêtre
    const handleVisibilityOrBlur = () => {
      if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
        console.log("[Reader PWA] Ignoré blur car le focus est sur l'iframe de lecture.");
        return;
      }
      console.log("[Reader PWA] Perte de focus ou mise en veille de l'application (sauvegarde et synchronisation intermédiaire)");
      saveProgressState(true);
    };
    window.addEventListener('visibilitychange', handleVisibilityOrBlur);
    window.addEventListener('blur', handleVisibilityOrBlur);

    return () => {
      console.log('[Reader PWA] Nettoyage / Démontage du composant Reader...');
      active = false;
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('visibilitychange', handleVisibilityOrBlur);
      window.removeEventListener('blur', handleVisibilityOrBlur);
      
      // Nettoyer les variables globales
      delete (window as any)._epubArrayBuffer;
      delete (window as any)._bookMetadata;
      console.log('[Reader PWA] Variables globales window supprimées.');

      // Sauvegarde finale de secours
      if (!isSavedRef.current) {
        console.log('[Reader PWA] Lancement d\'une sauvegarde finale de secours...');
        saveProgressState(false);
      }
    };
  }, [bookId]);

  const saveProgressState = async (_triggerSync: boolean): Promise<void> => {
    const curr = currentProgressRef.current;
    if (curr.percent === 0 && curr.location === null) {
      console.log('[Reader PWA] Annulation de la sauvegarde (progression vide).');
      return;
    }

    try {
      console.log(`[Reader PWA] Enregistrement de la progression locale : ${curr.percent}% (CFI: ${curr.location?.Value || 'aucun'})`);
      await syncQueueService.addProgressUpdate(
        bookId,
        curr.percent,
        curr.location
      );
    } catch (e) {
      console.error('[Reader PWA] Erreur lors de la sauvegarde de progression :', e);
    }
  };

  return (
    <div style={{ width: '100dvw', height: '100dvh', position: 'fixed', inset: 0, backgroundColor: '#000', zIndex: 1000, overflow: 'hidden' }}>
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
          style={{ border: 'none', width: '100%', height: '100%', display: 'block' }}
          title="Lecteur d'ebook Codexa"
          onLoad={() => console.log("[Reader PWA] [Parent] onLoad natif de l'IFrame déclenché !")}
        />
      )}
    </div>
  );
};
