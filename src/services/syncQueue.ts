import { db, type ReadingState } from '../db/libraryDb';
import { koboSyncApi } from './koboSyncApi';

export const syncQueueService = {
  getSyncUrl(): string | null {
    return localStorage.getItem('bookorbit_sync_url');
  },

  setSyncUrl(url: string) {
    localStorage.setItem('bookorbit_sync_url', url);
  },

  /**
   * Enregistre la progression localement et tente de l'envoyer au serveur si connecté.
   * Sinon, place la progression dans la file d'attente hors ligne.
   */
  async addProgressUpdate(
    bookId: string,
    progressPercent: number, // 0 à 100
    location: { Source: string; Type: string; Value: string } | null,
    stats?: any,
    statusInfo?: any
  ) {
    const lastModified = new Date().toISOString();
    
    const state: ReadingState = {
      bookId,
      lastModified,
      progressPercent,
      location,
      statistics: stats || {
        "PercentComplete": Math.round(progressPercent),
        "LastModified": lastModified
      },
      statusInfo: statusInfo || {
        "LastModified": lastModified
      },
      synced: false
    };

    // 1. Sauvegarde locale immédiate (IndexedDB)
    await db.readingStates.put(state);

    // Préparation du payload attendu par BookOrbit (Kobo Sync)
    const payload = {
      ReadingStates: [
        {
          CurrentBookmark: {
            LastModified: lastModified,
            ProgressPercent: progressPercent,
            Location: location ? {
              Source: location.Source,
              Type: location.Type,
              Value: location.Value
            } : null
          },
          Statistics: state.statistics,
          StatusInfo: state.statusInfo
        }
      ]
    };

    const syncUrl = this.getSyncUrl();
    if (syncUrl && navigator.onLine) {
      // Envoyer la progression au serveur en tâche de fond pour ne pas bloquer l'appelant (retour Bibliothèque instantané)
      koboSyncApi.updateReadingState(syncUrl, bookId, payload)
        .then(async () => {
          await db.readingStates.update(bookId, { synced: true });
          console.log(`[Sync] Progression synchronisée en ligne pour le livre ${bookId}.`);
        })
        .catch(async (error) => {
          console.warn(`[Sync] Échec de synchronisation immédiate pour ${bookId}. Ajout à la file d'attente.`, error);
          await db.syncQueue.put({ bookId, payload, timestamp: Date.now() });
        });
    } else {
      console.log(`[Sync] Appareil hors ligne. Progression pour le livre ${bookId} mise en file d'attente.`);
      db.syncQueue.put({ bookId, payload, timestamp: Date.now() }).catch(() => undefined);
    }
  },

  /**
   * Traite les éléments de la file d'attente hors ligne
   */
  async processQueue(): Promise<void> {
    const syncUrl = this.getSyncUrl();
    if (!syncUrl || !navigator.onLine) return;

    const items = await db.syncQueue.toArray();
    if (items.length === 0) return;

    console.log(`[Sync] Traitement de la file d'attente (${items.length} élément(s))...`);

    for (const item of items) {
      try {
        await koboSyncApi.updateReadingState(syncUrl, item.bookId, item.payload);
        
        // Si l'état local actuel n'est pas plus récent que celui qu'on vient d'envoyer, on le marque synchronisé
        const localState = await db.readingStates.get(item.bookId);
        const payloadBookmark = item.payload.ReadingStates[0].CurrentBookmark;
        if (localState && localState.lastModified <= payloadBookmark.LastModified) {
          await db.readingStates.update(item.bookId, { synced: true });
        }
        
        // Suppression de la queue
        await db.syncQueue.delete(item.id!);
      } catch (error) {
        console.error(`[Sync] Impossible de synchroniser la ligne de queue ${item.id} pour ${item.bookId}:`, error);
        // En cas d'erreur réseau récurrente ou d'erreur serveur, on arrête pour préserver l'ordre
        break;
      }
    }
  }
};

// Écouteur pour la reconnexion automatique du navigateur
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    syncQueueService.processQueue().catch(console.error);
  });
}
