import React, { useEffect, useRef, useState } from 'react';
import ePub, { Book as EpubBook, Rendition } from 'epubjs';
import { db } from '../db/libraryDb';
import { syncQueueService } from '../services/syncQueue';
import { dictionaryService } from '../services/dictionary';
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

  // État du dictionnaire
  const [selectedWord, setSelectedWord] = useState('');
  const [definition, setDefinition] = useState<string | null>(null);
  const [isSearchingWord, setIsSearchingWord] = useState(false);

  // Variables pour stocker la progression en cours d'utilisation
  const currentProgressRef = useRef({
    percent: 0,
    location: null as { Source: string; Type: string; Value: string } | null,
  });

  // Définition des thèmes graphiques pour l'iframe epub.js
  const themeStyles = {
    light: { bg: '#ffffff', text: '#1a1a1a', label: 'Clair' },
    sepia: { bg: '#fbf0d9', text: '#433422', label: 'Sépia' },
    dark: { bg: '#1c1c1e', text: '#e5e5ea', label: 'Sombre' },
    night: { bg: '#0b0e14', text: '#8e9aa8', label: 'Nuit' },
  };

  useEffect(() => {
    loadAndRenderBook();

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
      saveProgressState(false);
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

      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        flow: 'paginated', // paginé classique
        allowScriptedContent: false,
        spread: columns === '1' ? 'none' : (columns === '2' ? 'always' : 'auto')
      });
      renditionRef.current = rendition;

      // Charger le dernier état de lecture enregistré
      const lastState = await db.readingStates.get(bookId);
      let targetLocation: string | undefined = undefined;

      if (lastState && lastState.location) {
        targetLocation = lastState.location.Value; // CFI
        currentProgressRef.current = {
          percent: lastState.progressPercent,
          location: lastState.location,
        };
        setProgress(lastState.progressPercent);
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
      const doc = contents.document;
      
      // Clavier (touches fléchées)
      doc.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleNextPage();
        if (e.key === 'ArrowLeft') handlePrevPage();
      });
      
      // Clics sur les 25% latéraux
      doc.addEventListener('click', (e: MouseEvent) => {
        const selection = doc.getSelection();
        if (selection && selection.toString().trim().length > 0) return; // Ne pas tourner si sélection de mot
        
        const width = doc.documentElement.clientWidth;
        const clickX = e.clientX;
        
        if (clickX < width * 0.25) {
          handlePrevPage();
        } else if (clickX > width * 0.75) {
          handleNextPage();
        }
      });
      
      // Touch/Swipe
      let touchStartX = 0;
      let touchStartY = 0;
      let touchStartTime = 0;
      
      doc.addEventListener('touchstart', (e: TouchEvent) => {
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
        touchStartTime = Date.now();
      }, { passive: true });
      
      doc.addEventListener('touchend', (e: TouchEvent) => {
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const touchEndTime = Date.now();
        
        const diffX = touchEndX - touchStartX;
        const diffY = touchEndY - touchStartY;
        const timeDiff = touchEndTime - touchStartTime;
        
        // Swipe horizontal (seuil : 50px de distance, < 300ms de temps, Y peu décalé)
        if (Math.abs(diffX) > 50 && Math.abs(diffY) < 100 && timeDiff < 300) {
          if (diffX < 0) {
            handleNextPage(); // swipe gauche -> suivant
          } else {
            handlePrevPage(); // swipe droite -> précédent
          }
          return;
        }
        
        // Tap (seuil : mouvement < 10px, temps < 200ms)
        if (Math.abs(diffX) < 10 && Math.abs(diffY) < 10 && timeDiff < 200) {
          const width = doc.documentElement.clientWidth;
          const clickX = e.changedTouches[0].clientX;
          
          if (clickX < width * 0.25) {
            handlePrevPage();
          } else if (clickX > width * 0.75) {
            handleNextPage();
          }
        }
      }, { passive: true });
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

    // Définir la feuille de style par défaut de l'iframe
    rendition.themes.default({
      body: {
        'background-color': `${activeTheme.bg} !important`,
        'color': `${activeTheme.text} !important`,
        'font-family': `${fontFamily} !important`,
        'font-size': `${fontSize}% !important`,
        'line-height': `${lineHeight} !important`,
        'padding': `0 ${margin}px !important`,
        'text-align': 'justify !important',
      },
      p: {
        'margin-bottom': '1em !important',
        'text-indent': '1.5em !important',
      },
      a: {
        'color': `${activeTheme.text} !important`,
        'text-decoration': 'underline !important',
      }
    });

    rendition.themes.select('default');
    
    // Mettre à jour la couleur d'arrière-plan du container parent pour éviter les flashs blancs
    if (containerRef.current) {
      containerRef.current.style.backgroundColor = activeTheme.bg;
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

  const saveProgressState = (_triggerSync: boolean) => {
    const curr = currentProgressRef.current;
    if (curr.percent === 0 && curr.location === null) return;

    // Lancer de façon asynchrone la mise à jour de progression dans le service
    syncQueueService.addProgressUpdate(
      bookId,
      curr.percent,
      curr.location
    ).catch(e => console.error('[Reader] Erreur de sauvegarde de progression :', e));
  };

  const handleCloseReader = () => {
    saveProgressState(true);
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
        const rendition = epubBookRef.current.renderTo(containerRef.current, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          allowScriptedContent: false,
          spread: val === '1' ? 'none' : (val === '2' ? 'always' : 'auto')
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
        <div className="reader-settings-menu glass animate-fade-in">
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
      <div className="reader-viewport">
        {isLoading && (
          <div className="reader-loader">
            <BookOpen size={48} className="spin icon" />
            <p>Chargement de l'ebook...</p>
          </div>
        )}
        <div ref={containerRef} className="epub-container" onClick={() => setShowSettingsMenu(false)}></div>
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
    </div>
  );
};
