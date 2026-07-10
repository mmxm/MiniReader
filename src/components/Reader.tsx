import React, { useEffect, useRef, useState } from 'react';
import ePub, { Book as EpubBook, Rendition } from 'epubjs';
import { db } from '../db/libraryDb';
import { syncQueueService } from '../services/syncQueue';
import { dictionaryService } from '../services/dictionary';
import { X, ArrowLeft, ArrowRight, Type, BookOpen, RefreshCw } from 'lucide-react';

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
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('reader_font_size') || '100%');
  const [fontFamily, setFontFamily] = useState(() => localStorage.getItem('reader_font_family') || 'system-ui');
  const [theme, setTheme] = useState(() => localStorage.getItem('reader_theme') || 'sepia'); // sepia, dark, light, night
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

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

    // Configuration des écouteurs pour la mise en veille et le flou (changement d'application)
    const handleVisibilityOrBlur = () => {
      saveProgressState(true); // true = force sync si en ligne
    };

    window.addEventListener('visibilitychange', handleVisibilityOrBlur);
    window.addEventListener('blur', handleVisibilityOrBlur);

    return () => {
      // Nettoyage et sauvegarde finale lors du démontage du composant (fermeture)
      saveProgressState(false);
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
  }, [theme, fontSize, fontFamily, isLoading]);

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

      if (!containerRef.current) return;

      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        flow: 'paginated', // paginé classique
        allowScriptedContent: false,
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

      // Écouter les changements de page
      rendition.on('relocated', (location: any) => {
        if (!renditionRef.current || !epubBookRef.current) return;
        
        // Calculer le pourcentage actuel
        let pct = 0;
        const startCfi = location.start.cfi;
        
        if (epubBookRef.current.locations && typeof epubBookRef.current.locations.percentageFromCfi === 'function') {
          pct = epubBookRef.current.locations.percentageFromCfi(startCfi) * 100;
        } else {
          // Fallback par index de spine
          const totalSpine = (epubBookRef.current.spine as any)?.spineItems?.length || (epubBookRef.current.spine as any)?.length || 1;
          pct = (location.start.index / totalSpine) * 100;
        }

        // Limiter entre 0 et 100
        pct = Math.max(0, Math.min(100, pct));
        if (pct > 99.5) pct = 100; // Arrondi de fin

        const spineHref = epubBookRef.current.spine?.get(location.start.index)?.href || '';

        const progressLocation = {
          Source: spineHref,
          Type: 'EPUBcfi',
          Value: startCfi
        };

        // Mettre à jour les refs et l'état réactif
        currentProgressRef.current = {
          percent: pct,
          location: progressLocation,
        };
        setProgress(pct);

        // Afficher le titre de la section actuelle si dispo
        const navItem = epubBookRef.current.navigation?.get(spineHref);
        setCurrentPage(navItem ? navItem.label : `Page ${location.start.displayed.page} sur ${location.start.displayed.total}`);
      });

      // Écouter la sélection de texte (pour le dictionnaire)
      rendition.on('selected', (_cfiRange: string, contents: any) => {
        const selectedText = contents.window.getSelection().toString();
        if (selectedText && selectedText.trim().length > 1) {
          handleWordSelection(selectedText);
        }
      });

      setIsLoading(false);
    } catch (e: any) {
      console.error(e);
      alert(`Erreur de rendu du livre : ${e.message}`);
      onClose();
    }
  };

  const updatePercentage = () => {
    if (!renditionRef.current || !epubBookRef.current || !renditionRef.current.location) return;
    const startCfi = renditionRef.current.location.start.cfi;
    try {
      const pct = epubBookRef.current.locations.percentageFromCfi(startCfi) * 100;
      const nextPct = Math.max(0, Math.min(100, pct));
      setProgress(nextPct);
      currentProgressRef.current.percent = nextPct;
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
        'font-size': `${fontSize} !important`,
        'line-height': '1.6 !important',
        'padding': '0 20px !important',
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

    // Forcer l'application du thème
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

  const handleFontSizeChange = (size: string) => {
    setFontSize(size);
    localStorage.setItem('reader_font_size', size);
  };

  const handleFontFamilyChange = (font: string) => {
    setFontFamily(font);
    localStorage.setItem('reader_font_family', font);
  };

  const activeThemeObj = themeStyles[theme as keyof typeof themeStyles] || themeStyles.sepia;

  return (
    <div className="reader-wrapper" style={{ backgroundColor: activeThemeObj.bg, color: activeThemeObj.text }}>
      {/* Barre de navigation haute */}
      <header className="reader-header glass" style={{ borderBottomColor: `rgba(${theme === 'dark' || theme === 'night' ? '255,255,255' : '0,0,0'}, 0.08)` }}>
        <button onClick={handleCloseReader} className="btn-back">
          <ArrowLeft size={20} />
          <span className="back-text">Bibliothèque</span>
        </button>
        <span className="reader-book-title">{bookTitle}</span>
        <button onClick={() => setShowSettingsMenu(!showSettingsMenu)} className="btn-settings">
          <Type size={20} />
        </button>
      </header>

      {/* Menu Options de police & thèmes */}
      {showSettingsMenu && (
        <div className="reader-settings-menu glass animate-fade-in">
          <div className="settings-section">
            <span className="settings-label">Taille du texte</span>
            <div className="size-buttons">
              <button onClick={() => handleFontSizeChange('85%')} className={fontSize === '85%' ? 'active' : ''}>A-</button>
              <button onClick={() => handleFontSizeChange('100%')} className={fontSize === '100%' ? 'active' : ''}>100%</button>
              <button onClick={() => handleFontSizeChange('120%')} className={fontSize === '120%' ? 'active' : ''}>A+</button>
              <button onClick={() => handleFontSizeChange('140%')} className={fontSize === '140%' ? 'active' : ''}>A++</button>
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
            )}
          </div>
        </div>
      )}
    </div>
  );
};
