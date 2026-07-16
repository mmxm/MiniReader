import React, { useEffect, useRef, useState } from 'react';
import ePub, { Book as EpubBook, Rendition } from 'epubjs';
import { db } from '../db/libraryDb';
import { syncQueueService } from '../services/syncQueue';
import { dictionaryService } from '../services/dictionary';
import { koboSyncApi } from '../services/koboSyncApi';
import { X, ArrowLeft, ArrowRight, Type, BookOpen, RefreshCw, Menu } from 'lucide-react';

interface ReaderProps {
  bookId: string;
  onClose: () => void;
}

export const Reader: React.FC<ReaderProps> = ({ bookId, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const epubBookRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);

  const [bookTitle, setBookTitle] = useState('Lecture');
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState('');
  const [progress, setProgress] = useState(0);

  // Préférences de lecture
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('reader_font_size');
    if (saved && saved.endsWith('%')) {
      return Number(saved.replace('%', ''));
    }
    return Number(saved) || 100;
  });
  const [fontFamily, setFontFamily] = useState(() => localStorage.getItem('reader_font_family') || 'system-ui');
  const [theme, setTheme] = useState(() => localStorage.getItem('reader_theme') || 'sepia'); // sepia, dark, light, night
  const [lineHeight, setLineHeight] = useState<number>(() => {
    const saved = localStorage.getItem('reader_line_height');
    return Number(saved) || 1.5;
  });
  const [margin, setMargin] = useState<number>(() => {
    const saved = localStorage.getItem('reader_margin');
    return Number(saved) || 20;
  });
  const [columns, setColumns] = useState<'1' | '2' | 'auto'>(() => {
    return (localStorage.getItem('reader_columns') as any) || '1';
  });

  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

  // Table des matières
  const [toc, setToc] = useState<any[]>([]);
  const [showToc, setShowToc] = useState(false);

  // Conflit de progression au démarrage
  const [readerConflict, setReaderConflict] = useState<{
    localPercent: number;
    localDate: string;
    remotePercent: number;
    remoteDate: string;
    remoteLocation: string;
    remoteStatePayload: any;
  } | null>(null);

  // État du dictionnaire
  const [selectedWord, setSelectedWord] = useState('');
  const [definition, setDefinition] = useState<string | null>(null);
  const [isSearchingWord, setIsSearchingWord] = useState(false);

  // Variables pour stocker la progression en cours d'utilisation
  const currentProgressRef = useRef({
    percent: 0,
    location: null as { Source: string; Type: string; Value: string } | null,
  });

  const isSavedRef = useRef(false);
  const themeRef = useRef(theme);
  const fontFamilyRef = useRef(fontFamily);
  const fontSizeRef = useRef(fontSize);
  const lineHeightRef = useRef(lineHeight);
  const marginRef = useRef(margin);

  useEffect(() => {
    themeRef.current = theme;
    fontFamilyRef.current = fontFamily;
    fontSizeRef.current = fontSize;
    lineHeightRef.current = lineHeight;
    marginRef.current = margin;
  }, [theme, fontFamily, fontSize, lineHeight, margin]);

  // Définition des thèmes graphiques pour l'iframe epub.js
  const themeStyles = {
    light: { bg: '#ffffff', text: '#1a1a1a', label: 'Clair' },
    sepia: { bg: '#fbf0d9', text: '#433422', label: 'Sépia' },
    dark: { bg: '#1c1c1e', text: '#e5e5ea', label: 'Sombre' },
    night: { bg: '#0b0e14', text: '#8e9aa8', label: 'Nuit' },
  };

  useEffect(() => {
    loadAndRenderBook();

    // Dummy listeners pour "réveiller" le tactile sur iOS Safari (fenêtre parent, document, body)
    const dummyTouchStart = () => {};
    window.addEventListener('touchstart', dummyTouchStart, { passive: true });
    document.addEventListener('touchstart', dummyTouchStart, { passive: true });
    document.body.addEventListener('touchstart', dummyTouchStart, { passive: true });

    // Raccourcis clavier au niveau parent (fenêtre principale)
    const handleParentKeydown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') handleNextPage();
      if (e.key === 'ArrowLeft') handlePrevPage();
    };
    window.addEventListener('keydown', handleParentKeydown);

    // Configuration des écouteurs pour la mise en veille et le flou (changement d'application)
    const handleVisibilityOrBlur = () => {
      saveProgressState(true); // true = force sync si en ligne
    };

    window.addEventListener('visibilitychange', handleVisibilityOrBlur);
    window.addEventListener('blur', handleVisibilityOrBlur);

    return () => {
      // Nettoyage et sauvegarde finale lors du démontage du composant (fermeture)
      if (!isSavedRef.current) {
        saveProgressState(false);
      }
      window.removeEventListener('touchstart', dummyTouchStart);
      document.removeEventListener('touchstart', dummyTouchStart);
      document.body.removeEventListener('touchstart', dummyTouchStart);
      window.removeEventListener('keydown', handleParentKeydown);
      window.removeEventListener('visibilitychange', handleVisibilityOrBlur);
      window.removeEventListener('blur', handleVisibilityOrBlur);
      if (epubBookRef.current) {
        epubBookRef.current.destroy();
      }
    };
  }, [bookId]);

  // Appliquer les préférences de style lorsque le thème, la police ou la taille changent
  useEffect(() => {
    applyStylesToRendition();
  }, [theme, fontSize, fontFamily, lineHeight, margin, isLoading]);

  const loadAndRenderBook = async () => {
    try {
      setIsLoading(true);
      const bookData = await db.books.get(bookId);
      if (bookData) {
        setBookTitle(bookData.title);
      }

      const fileData = await db.bookFiles.get(bookId);
      if (!fileData) {
        throw new Error('Fichier du livre introuvable en local. Veuillez le télécharger à nouveau.');
      }

      // Initialiser epub.js avec le contenu ArrayBuffer
      const arrayBuffer = await fileData.blob.arrayBuffer();
      const book = ePub(arrayBuffer);
      epubBookRef.current = book;
      await book.ready;

      // Générer les emplacements pour un calcul précis du pourcentage (en tâche de fond)
      book.locations.generate(1024).then(() => {
        console.log('[Reader] Emplacements epub.js générés.');
        updatePercentage();
      });

      // Charger la table des matières
      book.loaded.navigation.then((nav) => {
        setToc(nav.toc || []);
      });

      if (!containerRef.current) return;
      containerRef.current.innerHTML = ''; // Nettoyer le conteneur pour éviter les duplications d'iframe sur iOS

      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        flow: 'paginated', // paginé classique
        allowScriptedContent: false,
        spread: columns === '1' ? 'none' : (columns === '2' ? 'always' : 'auto'),
        minSpreadWidth: columns === '2' ? 0 : 800
      });
      renditionRef.current = rendition;

      // 1. Charger le dernier état de lecture enregistré localement
      const lastState = await db.readingStates.get(bookId);
      let targetLocation: string | undefined = undefined;
      let startPercent = 0;

      if (lastState && lastState.location) {
        targetLocation = lastState.location.Value; // CFI
        currentProgressRef.current = {
          percent: lastState.progressPercent,
          location: lastState.location,
        };
        startPercent = lastState.progressPercent;
      }
      setProgress(startPercent);

      // 2. Tenter de récupérer la progression distante au démarrage (si en ligne)
      const syncUrl = localStorage.getItem('bookorbit_sync_url');
      if (syncUrl && navigator.onLine) {
        try {
          const remoteState = await koboSyncApi.fetchReadingState(syncUrl, bookId);
          if (remoteState && remoteState.CurrentBookmark) {
            const remoteBookmark = remoteState.CurrentBookmark;
            const remotePercent = remoteBookmark.ProgressPercent ?? 0;
            const remoteLastModified = remoteBookmark.LastModified || new Date().toISOString();
            const remoteLocation = remoteBookmark.Location;

            if (remoteLocation && remoteLocation.Value) {
              const hasLocalState = !!lastState;
              const isLocalSynced = lastState ? lastState.synced : true;
              
              if (hasLocalState && !isLocalSynced && lastState.progressPercent !== remotePercent) {
                // Détection de conflit ! On remplit l'état pour afficher la modale
                setReaderConflict({
                  localPercent: lastState.progressPercent,
                  localDate: lastState.lastModified,
                  remotePercent,
                  remoteDate: remoteLastModified,
                  remoteLocation: remoteLocation.Value,
                  remoteStatePayload: remoteState
                });
              } else {
                // Pas de conflit : si la progression distante est plus récente, ou si pas d'état local
                const isRemoteNewer = !lastState || new Date(remoteLastModified) > new Date(lastState.lastModified);
                if (isRemoteNewer) {
                  targetLocation = remoteLocation.Value;
                  startPercent = remotePercent;
                  
                  currentProgressRef.current = {
                    percent: remotePercent,
                    location: {
                      Source: 'BookOrbit',
                      Type: 'epubcfi',
                      Value: remoteLocation.Value
                    }
                  };
                  setProgress(remotePercent);

                  // Mettre à jour IndexedDB localement
                  await db.readingStates.put({
                    bookId,
                    lastModified: remoteLastModified,
                    progressPercent: remotePercent,
                    location: {
                      Source: 'BookOrbit',
                      Type: 'epubcfi',
                      Value: remoteLocation.Value
                    },
                    statistics: remoteState.Statistics || null,
                    statusInfo: remoteState.StatusInfo || null,
                    synced: true
                  });
                }
              }
            }
          }
        } catch (err) {
          console.warn('[Reader] Impossible de récupérer la progression distante au démarrage :', err);
        }
      }

      await rendition.display(targetLocation);

      // Attacher les écouteurs d'événements (tactile, clavier dans l'iframe, etc.)
      attachEventsToRendition(rendition);
      setIsLoading(false);
    } catch (e: any) {
      console.error(e);
      alert(e.message || 'Erreur lors de l\'ouverture du livre.');
      setIsLoading(false);
    }
  };

  const attachEventsToRendition = (rendition: Rendition) => {
    // Écouter les changements de page
    rendition.on('relocated', (location: any) => {
      if (!renditionRef.current || !epubBookRef.current) return;
      
      let pct = 0;
      const startCfi = location.start.cfi;
      
      if (epubBookRef.current.locations && typeof epubBookRef.current.locations.percentageFromCfi === 'function') {
        pct = epubBookRef.current.locations.percentageFromCfi(startCfi) * 100;
      } else {
        const totalSpine = (epubBookRef.current.spine as any)?.spineItems?.length || (epubBookRef.current.spine as any)?.length || 1;
        pct = (location.start.index / totalSpine) * 100;
      }
      
      // Arrondir
      pct = Math.round(pct);
      
      setProgress(pct);
      currentProgressRef.current = {
        percent: pct,
        location: {
          Source: 'BookOrbit',
          Type: 'epubcfi',
          Value: startCfi
        }
      };
      
      if (location.start && location.start.displayed) {
        setCurrentPage(`Page ${location.start.displayed.page} sur ${location.start.displayed.total}`);
      } else {
        setCurrentPage('');
      }
    });

    // Écouter la sélection de mots pour le dictionnaire
    rendition.on('selected', (_cfiRange: string, contents: any) => {
      const selection = contents.window.getSelection();
      const text = selection.toString().trim();
      if (text.length > 0) {
        handleWordSelection(text);
      }
    });

    // Enregistrer les écouteurs d'événements dans le document de l'iframe
    rendition.hooks.content.register((contents: any) => {
      let lastTapTime = 0;

      // Injecter la feuille de style personnalisée dynamique pour écraser les styles internes de l'EPUB
      const doc = contents.document;
      if (doc) {
        let styleEl = doc.getElementById('minireader-custom-styles');
        if (!styleEl) {
          styleEl = doc.createElement('style');
          styleEl.id = 'minireader-custom-styles';
          doc.head.appendChild(styleEl);
        }
        
        const activeTheme = themeStyles[themeRef.current as keyof typeof themeStyles] || themeStyles.sepia;
        styleEl.textContent = `
          body {
            background-color: ${activeTheme.bg} !important;
            color: ${activeTheme.text} !important;
            font-family: ${fontFamilyRef.current} !important;
            font-size: ${fontSizeRef.current}% !important;
            line-height: ${lineHeightRef.current} !important;
            padding: 0 ${marginRef.current}px !important;
            margin: 0 !important;
            text-align: justify !important;
          }
          p, span, div, li, h1, h2, h3, h4, h5, h6, td, th {
            font-family: ${fontFamilyRef.current} !important;
            color: ${activeTheme.text} !important;
          }
          p, span, div, li {
            font-size: inherit !important;
            line-height: inherit !important;
          }
          p {
            margin-bottom: 1em !important;
            text-indent: 1.5em !important;
          }
          a {
            color: ${activeTheme.text} !important;
            text-decoration: underline !important;
          }
        `;
      }

      const handleKeydown = (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleNextPage();
        if (e.key === 'ArrowLeft') handlePrevPage();
      };

      const handleClick = (e: MouseEvent) => {
        console.log('[Touch Iframe] Click event detected inside iframe');
        const selection = contents.window?.getSelection() || contents.document?.getSelection();
        if (selection && selection.toString().trim().length > 0) {
          console.log('[Touch Iframe] Text selection detected, ignore page turn');
          return;
        }
        
        // Bloquer l'événement s'il a déjà été traité par un événement tactile
        if (Date.now() - lastTapTime < 500) return;

        const width = contents.window?.innerWidth || contents.document?.documentElement?.clientWidth || 375;
        const clickX = e.clientX;
        
        if (clickX < width * 0.25) {
          console.log('[Touch Iframe] Click left 25%, turning page prev');
          handlePrevPage();
        } else if (clickX > width * 0.75) {
          console.log('[Touch Iframe] Click right 25%, turning page next');
          handleNextPage();
        }
      };

      // Attacher les écouteurs de façon robuste via contents.on d'epub.js (méthode officielle)
      if (typeof contents.on === 'function') {
        contents.on('keydown', handleKeydown);
        contents.on('click', handleClick);
      } else {
        // Fallback si contents.on est manquant
        const el = contents.document?.body || contents.document?.documentElement || contents.document;
        if (el) {
          el.addEventListener('keydown', handleKeydown);
          el.addEventListener('click', handleClick);
        }
      }
    });

  };

  const updatePercentage = () => {
    if (!renditionRef.current || !epubBookRef.current || !epubBookRef.current.locations) return;
    try {
      const cfi = renditionRef.current.location?.start?.cfi;
      if (cfi) {
        const pct = epubBookRef.current.locations.percentageFromCfi(cfi) * 100;
        setProgress(pct);
      }
    } catch (e) {
      console.warn('Erreur calcul pourcentage exact', e);
    }
  };

  const applyStylesToRendition = () => {
    const rendition = renditionRef.current;
    if (!rendition) return;

    const activeTheme = themeStyles[theme as keyof typeof themeStyles] || themeStyles.sepia;

    // Construire le CSS à appliquer dynamiquement
    const customCSS = `
      body {
        background-color: ${activeTheme.bg} !important;
        color: ${activeTheme.text} !important;
        font-family: ${fontFamily} !important;
        font-size: ${fontSize}% !important;
        line-height: ${lineHeight} !important;
        padding: 0 ${margin}px !important;
        margin: 0 !important;
        text-align: justify !important;
      }
      p, span, div, li, h1, h2, h3, h4, h5, h6, td, th {
        font-family: ${fontFamily} !important;
        color: ${activeTheme.text} !important;
      }
      p, span, div, li {
        font-size: inherit !important;
        line-height: inherit !important;
      }
      p {
        margin-bottom: 1em !important;
        text-indent: 1.5em !important;
      }
      a {
        color: ${activeTheme.text} !important;
        text-decoration: underline !important;
      }
    `;

    // Injecter ou mettre à jour la balise style dans toutes les sections d'iframe chargées
    try {
      rendition.views().forEach((view: any) => {
        if (view.contents && view.contents.document) {
          const doc = view.contents.document;
          let styleEl = doc.getElementById('minireader-custom-styles');
          if (!styleEl) {
            styleEl = doc.createElement('style');
            styleEl.id = 'minireader-custom-styles';
            doc.head.appendChild(styleEl);
          }
          styleEl.textContent = customCSS;
        }
      });
    } catch (e) {
      console.warn('[Reader Styles] Impossible de mettre à jour le style des vues actives', e);
    }

    // Mettre à jour l'arrière-plan du container parent
    if (containerRef.current) {
      containerRef.current.style.backgroundColor = activeTheme.bg;
      containerRef.current.style.width = '100%';
      containerRef.current.style.paddingLeft = '0px';
      containerRef.current.style.paddingRight = '0px';
      containerRef.current.style.boxSizing = 'border-box';
    }
  };

  const handleWordSelection = async (text: string) => {
    const word = text.trim();
    // Limiter la recherche aux sélections de 1-2 mots max
    if (word.split(/\s+/).length > 2) return;

    setIsSearchingWord(true);
    setSelectedWord(word);
    setDefinition(null);

    try {
      const def = await dictionaryService.defineWord(word);
      setDefinition(def);
    } catch (e) {
      setDefinition("Impossible de charger la définition.");
    } finally {
      setIsSearchingWord(false);
    }
  };

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
      console.error('[Reader] Erreur de sauvegarde de progression :', e);
    }
  };

  const handleCloseReader = async () => {
    setIsLoading(true);
    await saveProgressState(true);
    isSavedRef.current = true;
    onClose();
  };

  const handleNextPage = () => {
    if (renditionRef.current) renditionRef.current.next();
  };

  const handlePrevPage = () => {
    if (renditionRef.current) renditionRef.current.prev();
  };

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    localStorage.setItem('reader_theme', newTheme);
  };

  const handleFontSizeChange = (size: number) => {
    setFontSize(size);
    localStorage.setItem('reader_font_size', String(size));
  };

  const handleLineHeightChange = (lh: number) => {
    setLineHeight(lh);
    localStorage.setItem('reader_line_height', String(lh));
  };

  const handleMarginChange = (m: number) => {
    setMargin(m);
    localStorage.setItem('reader_margin', String(m));
  };

  const handleColumnsChange = async (val: '1' | '2' | 'auto') => {
    setColumns(val);
    localStorage.setItem('reader_columns', val);
    
    // Recréer la rendition à la position courante
    if (renditionRef.current && epubBookRef.current) {
      const currentLocation = renditionRef.current.location?.start?.cfi || undefined;
      
      renditionRef.current.destroy();
      
      if (containerRef.current) {
        containerRef.current.innerHTML = ''; // Nettoyer le conteneur pour éviter les duplications d'iframe sur iOS
        const rendition = epubBookRef.current.renderTo(containerRef.current, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          allowScriptedContent: false,
          spread: val === '1' ? 'none' : (val === '2' ? 'always' : 'auto'),
          minSpreadWidth: val === '2' ? 0 : 800
        });
        
        renditionRef.current = rendition;
        attachEventsToRendition(rendition);
        
        setTimeout(() => {
          applyStylesToRendition();
          if (currentLocation) {
            rendition.display(currentLocation);
          }
        }, 50);
      }
    }
  };

  const handleFontFamilyChange = (font: string) => {
    setFontFamily(font);
    localStorage.setItem('reader_font_family', font);
  };

  const activeThemeObj = themeStyles[theme as keyof typeof themeStyles] || themeStyles.sepia;

  const handleResolveReaderConflict = async (choice: 'local' | 'remote') => {
    if (!readerConflict) return;
    
    const { remotePercent, remoteLocation, remoteDate, remoteStatePayload } = readerConflict;
    
    if (choice === 'remote') {
      if (renditionRef.current) {
        await renditionRef.current.display(remoteLocation);
      }
      setProgress(remotePercent);
      currentProgressRef.current = {
        percent: remotePercent,
        location: {
          Source: 'BookOrbit',
          Type: 'epubcfi',
          Value: remoteLocation
        }
      };
      
      const lastState = await db.readingStates.get(bookId);
      await db.readingStates.put({
        bookId,
        lastModified: remoteDate,
        progressPercent: remotePercent,
        location: {
          Source: 'BookOrbit',
          Type: 'epubcfi',
          Value: remoteLocation
        },
        statistics: remoteStatePayload.Statistics || (lastState ? lastState.statistics : null),
        statusInfo: remoteStatePayload.StatusInfo || (lastState ? lastState.statusInfo : null),
        synced: true
      });
    } else {
      await db.readingStates.update(bookId, { synced: false });
      saveProgressState(true);
    }
    
    setReaderConflict(null);
  };

  const renderTocItems = (items: any[]) => {
    return items.map((item, idx) => (
      <div key={item.id || idx} className="toc-item-wrapper">
        <button 
          onClick={() => {
            if (renditionRef.current) {
              renditionRef.current.display(item.href);
              setShowToc(false);
            }
          }}
          className="toc-link"
        >
          {item.label}
        </button>
        {item.subitems && item.subitems.length > 0 && (
          <div className="toc-sublist">
            {renderTocItems(item.subitems)}
          </div>
        )}
      </div>
    ));
  };

  const handleParentClick = (e: MouseEvent) => {
    console.log('[Touch Parent] Click event detected on parent container');
    const container = containerRef.current;
    if (!container) return;

    // Ignorer si le clic provient d'une interface de réglages, en-tête, barre basse ou d'un bouton
    const target = e.target as HTMLElement;
    if (
      target.closest('.reader-settings-menu') || 
      target.closest('.reader-header') || 
      target.closest('.reader-footer') || 
      target.closest('.btn-back') || 
      target.closest('.btn-settings') || 
      target.closest('.btn-toc') ||
      target.closest('.btn-close-sidebar')
    ) {
      console.log('[Touch Parent] Click on UI element, ignored');
      return;
    }
    
    const width = container.clientWidth;
    const clickX = e.clientX - container.getBoundingClientRect().left;

    if (clickX < width * 0.25) {
      console.log('[Touch Parent] Click left 25%, turning page prev');
      handlePrevPage();
    } else if (clickX > width * 0.75) {
      console.log('[Touch Parent] Click right 25%, turning page next');
      handleNextPage();
    }
  };

  // Listeners de secours sur le conteneur parent (epub-container) pour les clics et touchers bloqués ou capturés par epub.js
  useEffect(() => {
    const container = containerRef.current;
    if (!container || isLoading) return;

    container.addEventListener('click', handleParentClick);

    return () => {
      container.removeEventListener('click', handleParentClick);
    };
  }, [isLoading]);

  return (
    <div className="reader-wrapper" style={{ backgroundColor: activeThemeObj.bg, color: activeThemeObj.text }}>
      {/* Barre de navigation haute */}
      <header className="reader-header glass" style={{ borderBottomColor: `rgba(${theme === 'dark' || theme === 'night' ? '255,255,255' : '0,0,0'}, 0.08)` }}>
        <div className="header-left" style={{ display: 'flex', alignItems: 'center' }}>
          <button onClick={handleCloseReader} className="btn-back" title="Retour à la bibliothèque">
            <ArrowLeft size={20} />
          </button>
          <button onClick={() => setShowToc(!showToc)} className="btn-toc" title="Table des matières" style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: '12px' }}>
            <Menu size={20} />
          </button>
        </div>
        <span className="reader-book-title">{bookTitle}</span>
        <button onClick={() => setShowSettingsMenu(!showSettingsMenu)} className="btn-settings">
          <Type size={20} />
        </button>
      </header>

      {/* Volet latéral de la Table des matières */}
      <div className={`reader-sidebar glass ${showToc ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h3>Table des matières</h3>
          <button onClick={() => setShowToc(false)} className="btn-close-sidebar">
            <X size={20} />
          </button>
        </div>
        <div className="toc-list">
          {toc.length === 0 ? (
            <p className="toc-empty">Aucune table des matières disponible.</p>
          ) : (
            renderTocItems(toc)
          )}
        </div>
      </div>

      {/* Menu Options de police & thèmes */}
      {showSettingsMenu && (
        <div className="reader-settings-menu glass animate-fade-in" onClick={(e) => e.stopPropagation()}>
          <div className="settings-menu-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '8px' }}>
            <span style={{ fontWeight: 600, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Options d'affichage</span>
            <button 
              type="button"
              onClick={() => setShowSettingsMenu(false)} 
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '4px' }}
              title="Fermer le menu"
            >
              <X size={18} />
            </button>
          </div>
          <div className="settings-section">
            <span className="settings-label">Taille du texte</span>
            <div className="adjust-control">
              <button onClick={() => handleFontSizeChange(Math.max(50, fontSize - 5))} className="btn-adjust">-</button>
              <span className="adjust-val">{fontSize}%</span>
              <button onClick={() => handleFontSizeChange(Math.min(250, fontSize + 5))} className="btn-adjust">+</button>
            </div>
          </div>

          <div className="settings-section">
            <span className="settings-label">Interligne</span>
            <div className="adjust-control">
              <button onClick={() => handleLineHeightChange(Math.max(1.0, parseFloat((lineHeight - 0.1).toFixed(1))))} className="btn-adjust">-</button>
              <span className="adjust-val">{lineHeight}</span>
              <button onClick={() => handleLineHeightChange(Math.min(2.5, parseFloat((lineHeight + 0.1).toFixed(1))))} className="btn-adjust">+</button>
            </div>
          </div>

          <div className="settings-section">
            <span className="settings-label">Marges</span>
            <div className="adjust-control">
              <button onClick={() => handleMarginChange(Math.max(5, margin - 5))} className="btn-adjust">-</button>
              <span className="adjust-val">{margin}px</span>
              <button onClick={() => handleMarginChange(Math.min(80, margin + 5))} className="btn-adjust">+</button>
            </div>
          </div>

          <div className="settings-section">
            <span className="settings-label">Colonnes</span>
            <div className="column-buttons">
              <button 
                onClick={() => handleColumnsChange('1')} 
                className={`column-btn ${columns === '1' ? 'active' : ''}`}
              >
                1 col
              </button>
              <button 
                onClick={() => handleColumnsChange('2')} 
                className={`column-btn ${columns === '2' ? 'active' : ''}`}
              >
                2 col
              </button>
              <button 
                onClick={() => handleColumnsChange('auto')} 
                className={`column-btn ${columns === 'auto' ? 'active' : ''}`}
              >
                Auto
              </button>
            </div>
          </div>

          <div className="settings-section">
            <span className="settings-label">Police</span>
            <select value={fontFamily} onChange={(e) => handleFontFamilyChange(e.target.value)} className="glass-select">
              <option value="system-ui">Sans-Serif (Système)</option>
              <option value="Georgia, serif">Georgia (Serif)</option>
              <option value="Playfair Display, serif">Playfair Display</option>
              <option value="OpenDyslexic, sans-serif">OpenDyslexic</option>
            </select>
          </div>

          <div className="settings-section">
            <span className="settings-label">Thème</span>
            <div className="theme-buttons">
              {Object.entries(themeStyles).map(([key, style]) => (
                <button
                  key={key}
                  onClick={() => handleThemeChange(key)}
                  className={`theme-btn ${theme === key ? 'active' : ''}`}
                  style={{ backgroundColor: style.bg, color: style.text }}
                >
                  {style.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Rendu EPUB */}
      <div className="reader-viewport" style={{ position: 'relative' }}>
        {isLoading && (
          <div className="reader-loader">
            <BookOpen size={48} className="spin icon" />
            <p>Chargement de l'ebook...</p>
          </div>
        )}
        <div ref={containerRef} className="epub-container" onClick={() => setShowSettingsMenu(false)}></div>

        {/* Zones tactiles de clic/swipe de secours natives React (gauche 20%, droite 20%) */}
        {!isLoading && (
          <>
            <div 
              className="mobile-touch-zone prev" 
              onClick={(e) => {
                e.stopPropagation();
                if (showSettingsMenu) {
                  console.log('[Touch Overlay] Tapped left overlay while settings open, close settings');
                  setShowSettingsMenu(false);
                } else if (showToc) {
                  console.log('[Touch Overlay] Tapped left overlay while sidebar open, close sidebar');
                  setShowToc(false);
                } else {
                  console.log('[Touch Overlay] Prev page clicked');
                  handlePrevPage();
                }
              }}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '20%',
                height: '100%',
                zIndex: 150,
                cursor: 'pointer',
                background: 'transparent'
              }}
              aria-label="Page précédente"
            />
            <div 
              className="mobile-touch-zone next" 
              onClick={(e) => {
                e.stopPropagation();
                if (showSettingsMenu) {
                  console.log('[Touch Overlay] Tapped right overlay while settings open, close settings');
                  setShowSettingsMenu(false);
                } else if (showToc) {
                  console.log('[Touch Overlay] Tapped right overlay while sidebar open, close sidebar');
                  setShowToc(false);
                } else {
                  console.log('[Touch Overlay] Next page clicked');
                  handleNextPage();
                }
              }}
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                width: '20%',
                height: '100%',
                zIndex: 150,
                cursor: 'pointer',
                background: 'transparent'
              }}
              aria-label="Page suivante"
            />
          </>
        )}
      </div>

      {/* Contrôles latéraux pour tablettes / ordinateurs */}
      <button className="nav-side-btn prev glass" onClick={handlePrevPage} aria-label="Page précédente">
        <ArrowLeft />
      </button>
      <button className="nav-side-btn next glass" onClick={handleNextPage} aria-label="Page suivante">
        <ArrowRight />
      </button>

      {/* Barre d'état basse */}
      <footer className="reader-footer">
        <button onClick={handlePrevPage} className="nav-bar-btn" aria-label="Page précédente">
          <ArrowLeft size={18} /> Précédent
        </button>
        <div className="reader-progress-info">
          <span className="chapter-title">{currentPage}</span>
          <span className="percentage-info">{Math.round(progress)}% lu</span>
        </div>
        <button onClick={handleNextPage} className="nav-bar-btn" aria-label="Page suivante">
          Suivant <ArrowRight size={18} />
        </button>
      </footer>

      {/* Tiroir ou Pop-up Dictionnaire local */}
      {selectedWord && (
        <div className="dictionary-drawer glass animate-slide-up">
          <div className="drawer-header">
            <h4>Dictionnaire : <strong>{selectedWord}</strong></h4>
            <button onClick={() => setSelectedWord('')} className="btn-close-drawer">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-content">
            {isSearchingWord ? (
              <p className="loading-text"><RefreshCw size={14} className="spin inline-icon" /> Recherche de la définition...</p>
            ) : (
              <p className="definition-text">{definition || "Aucune définition trouvée."}</p>
            )
            }
          </div>
        </div>
      )}

      {/* Pop-up de Conflit de progression interne */}
      {readerConflict && (
        <div className="modal-overlay">
          <div className="modal-content glass animate-scale-in" style={{ maxWidth: '400px' }}>
            <h3 className="modal-title" style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Conflit de progression</h3>
            <p className="modal-description" style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Une progression différente a été détectée sur le serveur BookOrbit pour ce livre.
            </p>
            <div className="conflict-options" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div 
                className="conflict-option-card" 
                onClick={() => handleResolveReaderConflict('local')}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  transition: 'background 0.2s ease'
                }}
              >
                <span className="option-title" style={{ fontSize: '14px', fontWeight: 600 }}>Garder la position locale</span>
                <span className="option-detail" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{readerConflict.localPercent}% lu</span>
                <span className="option-date" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Enregistré le {new Date(readerConflict.localDate).toLocaleString('fr-FR')}</span>
              </div>
              <div 
                className="conflict-option-card" 
                onClick={() => handleResolveReaderConflict('remote')}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  transition: 'background 0.2s ease'
                }}
              >
                <span className="option-title" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--accent)' }}>Prendre la position serveur</span>
                <span className="option-detail" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{readerConflict.remotePercent}% lu</span>
                <span className="option-date" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Enregistré le {new Date(readerConflict.remoteDate).toLocaleString('fr-FR')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
