import React, { useState, useEffect } from 'react';
import { db, type Book, type ReadingState } from '../db/libraryDb';
import { koboSyncApi, parseSyncUrl } from '../services/koboSyncApi';
import { syncQueueService } from '../services/syncQueue';
import { Download, BookOpen, Trash2, RefreshCw, Search, Folder } from 'lucide-react';

interface LibraryProps {
  onOpenBook: (bookId: string) => void;
  onConflictDetected: (conflict: {
    bookId: string;
    bookTitle: string;
    localProgress: number;
    localDate: string;
    remoteProgress: number;
    remoteDate: string;
  }) => void;
  syncTrigger: number; // Force reload when changes occur outside
}

export const Library: React.FC<LibraryProps> = ({ 
  onOpenBook, 
  onConflictDetected,
  syncTrigger 
}) => {
  const [books, setBooks] = useState<Book[]>([]);
  const [readingStates, setReadingStates] = useState<Record<string, ReadingState>>({});
  const [selectedTab, setSelectedTab] = useState<'all' | 'downloaded' | string>('all');
  const [collections, setCollections] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState('');
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [lastSyncDate, setLastSyncDate] = useState<string | null>(null);

  useEffect(() => {
    loadLibrary();
    setLastSyncDate(localStorage.getItem('bookorbit_last_sync_date'));
  }, [syncTrigger]);

  const loadLibrary = async () => {
    try {
      const allBooks = await db.books.toArray();
      setBooks(allBooks);

      // Extraire la liste unique des collections
      const colsSet = new Set<string>();
      allBooks.forEach(b => b.collections?.forEach(c => colsSet.add(c)));
      setCollections(Array.from(colsSet));

      // Charger les états de lecture
      const states = await db.readingStates.toArray();
      const statesMap: Record<string, ReadingState> = {};
      states.forEach(s => {
        statesMap[s.bookId] = s;
      });
      setReadingStates(statesMap);
    } catch (e) {
      console.error('Erreur de chargement de la bibliothèque locale :', e);
    }
  };

  const handleSyncCatalog = async () => {
    const syncUrl = localStorage.getItem('bookorbit_sync_url');
    if (!syncUrl) {
      alert("Veuillez d'abord configurer l'URL BookOrbit dans les Paramètres.");
      return;
    }

    setIsSyncing(true);
    setSyncProgress('Initialisation de la synchronisation...');

    try {
      // 1. Dépiler d'abord les avancements hors ligne non synchronisés
      await syncQueueService.processQueue();

      // 2. Initialiser Kobo (vérifier le token)
      setSyncProgress('Authentification...');
      await koboSyncApi.initialize(syncUrl);

      // 3. Boucle de synchronisation incrémentale
      let hasMore = true;
      let syncToken = localStorage.getItem('bookorbit_sync_token') || undefined;
      let pageCount = 1;
      const config = parseSyncUrl(syncUrl);

      while (hasMore) {
        setSyncProgress(`Récupération de la page ${pageCount}...`);
        const result = await koboSyncApi.fetchLibraryDelta(syncUrl, syncToken);
        
        const entitlements = result.entitlements;
        hasMore = result.hasMore;
        if (result.nextSyncToken) {
          syncToken = result.nextSyncToken;
        }

        setSyncProgress(`Traitement de la page ${pageCount} (${entitlements.length} éléments)...`);

        for (const item of entitlements) {
          // A. Nouveau livre ou metadonnées changées
          if (item.NewEntitlement || item.ChangedProductMetadata || item.ChangedEntitlement) {
            const ent = item.NewEntitlement || item.ChangedProductMetadata || item.ChangedEntitlement;
            const metadata = ent.BookMetadata;
            const entitlement = ent.BookEntitlement;
            const bookId = metadata?.EntitlementId || entitlement?.Id;

            if (!bookId) continue;

            // Si le livre est marqué supprimé
            if (entitlement?.IsRemoved || entitlement?.Status === 'Deleted') {
              await db.books.delete(bookId);
              await db.bookFiles.delete(bookId);
              await db.readingStates.delete(bookId);
              continue;
            }

            const title = metadata.Title || 'Sans titre';
            const authors = Array.isArray(metadata.Authors) ? metadata.Authors.map((a: any) => a.Name) : ['Auteur inconnu'];
            const description = metadata.Description || null;
            const publisher = metadata.Publisher?.Name || null;
            const publishedDate = metadata.PublicationDate || null;
            const fileFormat = 'epub'; // Kobo utilise EPUB/KEPUB par défaut
            const fileSizeBytes = null;
            const fileHash = null;

            // Construire l'URL de couverture à partir du template Kobo de Bookorbit
            const coverUrl = `${config.baseUrl}/v1/books/${bookId}/thumbnail/300/400/false/image.jpg`;

            // Récupérer le livre existant pour préserver le statut téléchargé localement
            const existingBook = await db.books.get(bookId);
            const downloaded = existingBook ? existingBook.downloaded : false;
            const collections = existingBook ? existingBook.collections || [] : [];

            const book: Book = {
              id: bookId,
              title,
              authors,
              description,
              publisher,
              publishedDate,
              fileFormat,
              fileSizeBytes,
              fileHash,
              coverUrl,
              downloaded,
              addedAt: entitlement?.Created || new Date().toISOString(),
              updatedAt: entitlement?.LastModified || new Date().toISOString(),
              collections
            };

            await db.books.put(book);

            // Gérer l'état de lecture fourni à la création
            if (ent.ReadingState) {
              const currentBookmark = ent.ReadingState.CurrentBookmark;
              if (currentBookmark) {
                const pct = currentBookmark.ProgressPercent ?? 0;
                const lastMod = currentBookmark.LastModified || new Date().toISOString();
                const location = currentBookmark.Location || null;

                // Vérifier s'il y a un conflit avec un avancement local non synchronisé
                const localState = await db.readingStates.get(bookId);
                if (localState && !localState.synced && localState.progressPercent !== pct) {
                  // Détection de conflit !
                  onConflictDetected({
                    bookId,
                    bookTitle: title,
                    localProgress: localState.progressPercent,
                    localDate: localState.lastModified,
                    remoteProgress: pct,
                    remoteDate: lastMod
                  });
                } else {
                  // Pas de conflit, on applique l'état serveur
                  await db.readingStates.put({
                    bookId,
                    lastModified: lastMod,
                    progressPercent: pct,
                    location,
                    statistics: ent.ReadingState.Statistics || null,
                    statusInfo: ent.ReadingState.StatusInfo || null,
                    synced: true
                  });
                }
              }
            }
          }
          // B. Changement de l'état de lecture seul
          else if (item.ChangedReadingState) {
            const state = item.ChangedReadingState.ReadingState;
            const bookId = state?.EntitlementId;
            const currentBookmark = state?.CurrentBookmark;

            if (bookId && currentBookmark) {
              const pct = currentBookmark.ProgressPercent ?? 0;
              const lastMod = currentBookmark.LastModified || new Date().toISOString();
              const location = currentBookmark.Location || null;

              const localState = await db.readingStates.get(bookId);
              const bookInfo = await db.books.get(bookId);
              
              if (localState && !localState.synced && localState.progressPercent !== pct) {
                onConflictDetected({
                  bookId,
                  bookTitle: bookInfo?.title || 'Livre inconnu',
                  localProgress: localState.progressPercent,
                  localDate: localState.lastModified,
                  remoteProgress: pct,
                  remoteDate: lastMod
                });
              } else {
                await db.readingStates.put({
                  bookId,
                  lastModified: lastMod,
                  progressPercent: pct,
                  location,
                  statistics: state.Statistics || null,
                  statusInfo: state.StatusInfo || null,
                  synced: true
                });
              }
            }
          }
          // C. Changement de tags/collections
          else if (item.ChangedTag) {
            const tag = item.ChangedTag.Tag;
            const collectionName = tag.Name;
            const bookEntitlementIds: string[] = Array.isArray(tag.Items) 
              ? tag.Items.map((i: any) => i.RevisionId) 
              : [];

            // Supprimer cette collection de tous les livres qui l'avaient
            const allBooks = await db.books.toArray();
            for (const b of allBooks) {
              if (b.collections?.includes(collectionName)) {
                const nextCols = b.collections.filter(c => c !== collectionName);
                await db.books.update(b.id, { collections: nextCols });
              }
            }

            // Ajouter la collection aux livres listés
            for (const bid of bookEntitlementIds) {
              const b = await db.books.get(bid);
              if (b) {
                const nextCols = Array.from(new Set([...(b.collections || []), collectionName]));
                await db.books.update(bid, { collections: nextCols });
              }
            }
          }
        }

        pageCount++;
      }

      if (syncToken) {
        localStorage.setItem('bookorbit_sync_token', syncToken);
      }

      const syncDateString = new Date().toLocaleString('fr-FR');
      localStorage.setItem('bookorbit_last_sync_date', syncDateString);
      setLastSyncDate(syncDateString);
      setSyncProgress('Synchronisation réussie !');
      await loadLibrary();
    } catch (error: any) {
      console.error(error);
      alert(`Erreur lors de la synchronisation : ${error.message}`);
    } finally {
      setIsSyncing(false);
      setSyncProgress('');
    }
  };

  const handleDownloadBook = async (bookId: string) => {
    const syncUrl = localStorage.getItem('bookorbit_sync_url');
    if (!syncUrl) return;

    setDownloadingBookId(bookId);

    try {
      const blob = await koboSyncApi.downloadBook(syncUrl, bookId);
      
      // Stocker le fichier binaire localement
      await db.bookFiles.put({ bookId, blob });
      
      // Marquer le livre comme téléchargé
      await db.books.update(bookId, { downloaded: true });
      
      console.log(`Livre ${bookId} téléchargé avec succès.`);
      await loadLibrary();
    } catch (e: any) {
      console.error(e);
      alert(`Échec du téléchargement du livre : ${e.message}`);
    } finally {
      setDownloadingBookId(null);
    }
  };

  const handleDeleteLocalBook = async (bookId: string) => {
    if (window.confirm("Voulez-vous supprimer ce livre de votre stockage local ? Vous pourrez le télécharger à nouveau plus tard.")) {
      try {
        await db.bookFiles.delete(bookId);
        await db.books.update(bookId, { downloaded: false });
        await loadLibrary();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // Filtrer les livres
  const filteredBooks = books.filter(book => {
    const matchesSearch = 
      book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      book.authors.some(a => a.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!matchesSearch) return false;

    if (selectedTab === 'all') return true;
    if (selectedTab === 'downloaded') return book.downloaded;
    return book.collections?.includes(selectedTab);
  });

  return (
    <div className="library-container">
      {/* Barre de contrôle du Catalogue */}
      <div className="library-header glass">
        <div className="sync-info">
          <h3>Ma Bibliothèque</h3>
          {lastSyncDate && (
            <span className="last-sync">Dernière synchro : {lastSyncDate}</span>
          )}
        </div>
        <button 
          onClick={handleSyncCatalog} 
          disabled={isSyncing}
          className={`btn btn-primary sync-btn ${isSyncing ? 'loading' : ''}`}
        >
          <RefreshCw className={`icon ${isSyncing ? 'spin' : ''}`} />
          {isSyncing ? 'Synchronisation...' : 'Synchroniser'}
        </button>
      </div>

      {isSyncing && (
        <div className="sync-overlay glass">
          <div className="sync-status-box">
            <RefreshCw className="spin" size={32} />
            <p>{syncProgress}</p>
          </div>
        </div>
      )}

      {/* Recherche et Catégories */}
      <div className="library-controls">
        <div className="search-bar glass">
          <Search className="search-icon" size={18} />
          <input 
            type="text" 
            placeholder="Rechercher par titre ou auteur..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Onglets (Collections) */}
        <div className="tabs-bar">
          <button 
            className={`tab-btn glass ${selectedTab === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedTab('all')}
          >
            Tous ({books.length})
          </button>
          <button 
            className={`tab-btn glass ${selectedTab === 'downloaded' ? 'active' : ''}`}
            onClick={() => setSelectedTab('downloaded')}
          >
            Hors ligne ({books.filter(b => b.downloaded).length})
          </button>
          
          {collections.map(col => (
            <button 
              key={col}
              className={`tab-btn glass ${selectedTab === col ? 'active' : ''}`}
              onClick={() => setSelectedTab(col)}
            >
              <Folder size={14} className="folder-icon" /> {col} ({books.filter(b => b.collections?.includes(col)).length})
            </button>
          ))}
        </div>
      </div>

      {/* Grille des Livres */}
      {filteredBooks.length === 0 ? (
        <div className="empty-state glass">
          <BookOpen size={48} className="empty-icon" />
          <p>Aucun livre trouvé.</p>
          {books.length === 0 && (
            <span className="empty-help">Cliquez sur "Synchroniser" pour charger vos livres depuis BookOrbit.</span>
          )}
        </div>
      ) : (
        <div className="books-grid">
          {filteredBooks.map(book => {
            const state = readingStates[book.id];
            const progress = state ? state.progressPercent : 0;
            const isDownloading = downloadingBookId === book.id;

            return (
              <div key={book.id} className="book-card glass">
                <div className="book-cover-wrapper">
                  <img 
                    src={book.coverUrl} 
                    alt={`Couverture de ${book.title}`} 
                    className="book-cover"
                    onError={(e) => {
                      // Fallback si la couverture échoue
                      (e.target as HTMLImageElement).src = 'https://placehold.co/150x200?text=Pas+de+Couverture';
                    }}
                  />
                  {book.downloaded && (
                    <span className="download-badge">Disponible hors ligne</span>
                  )}
                </div>

                <div className="book-info">
                  <h4 className="book-title" title={book.title}>{book.title}</h4>
                  <span className="book-author">{book.authors.join(', ')}</span>
                  
                  {/* Barre de progression */}
                  <div className="progress-wrapper">
                    <div className="progress-bar-container">
                      <div 
                        className="progress-bar-fill" 
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                    <span className="progress-text">{Math.round(progress)}% lu</span>
                  </div>

                  {/* Actions */}
                  <div className="book-actions">
                    {book.downloaded ? (
                      <>
                        <button 
                          onClick={() => onOpenBook(book.id)} 
                          className="btn btn-read"
                          title="Lire le livre"
                        >
                          <BookOpen size={16} /> Lire
                        </button>
                        <button 
                          onClick={() => handleDeleteLocalBook(book.id)} 
                          className="btn btn-icon btn-danger-icon"
                          title="Supprimer du stockage local"
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : (
                      <button 
                        onClick={() => handleDownloadBook(book.id)} 
                        className="btn btn-download"
                        disabled={isDownloading}
                      >
                        {isDownloading ? (
                          <>
                            <RefreshCw className="spin icon" size={16} /> Téléchargement...
                          </>
                        ) : (
                          <>
                            <Download size={16} /> Télécharger
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
