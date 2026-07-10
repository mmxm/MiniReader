import { db } from '../db/libraryDb';

// Glossaire embarqué de secours (termes littéraires et mots courants)
const EMBEDDED_GLOSSARY: Record<string, string> = {
  aberration: "Égarement du jugement, absurdité, anomalie par rapport à ce qui est considéré comme normal.",
  chimere: "Projet séduisant mais irréalisable ; illusion ou utopie.",
  dichotomie: "Division de quelque chose en deux éléments nettement opposés ou différents.",
  ephemere: "Qui ne dure qu'un court instant ; très passager.",
  hegemonie: "Domination souveraine, suprématie d'une nation, d'une classe ou d'un groupe sur d'autres.",
  idiosyncrasie: "Comportement ou tempérament propre à un individu particulier ; réactivité individuelle.",
  laconique: "Qui s'exprime en peu de mots ; bref et concis.",
  metaphore: "Figure de style par laquelle on associe un terme concret à une idée abstraite par analogie.",
  neophyte: "Personne qui a récemment adhéré à une doctrine, à un groupe, ou qui débute dans une activité.",
  pleonasme: "Répétition de mots ayant le même sens (ex: monter en haut).",
  paradoxe: "Proposition qui va à l'encontre de l'opinion commune ou de la logique.",
  soliloque: "Discours qu'une personne se tient à elle-même ; monologue intérieur.",
  stoique: "Qui fait preuve de courage et de fermeté d'âme face aux épreuves de la vie.",
  utopie: "Représentation d'une société idéale, mais irréalisable dans la réalité actuelle.",
  vaciller: "Être instable, osciller, ou menacer de s'effondrer.",
  zenith: "Le point le plus élevé, le sommet du succès ou du pouvoir.",
  garrulite: "Bavardage excessif, indiscret ou fatigant.",
  melliflu: "Qui a la douceur du miel ; doucereux, insistant.",
  serendipite: "Fait de trouver autre chose que ce que l'on cherchait, par hasard et par sagacité.",
  obsolete: "Qui est sorti de l'usage ; périmé, dépassé.",
  magnanime: "Qui a de la grandeur d'âme, enclin au pardon et à la générosité.",
  velléité: "Intention faible et passagère de faire quelque chose, qui ne se traduit pas par une action.",
  abnégation: "Sacrifice volontaire de soi-même ou de son intérêt au bénéfice d'autrui.",
  altruisme: "Disposition à s'intéresser et à se dévouer à autrui.",
  pragmatique: "Qui est orienté vers l'action pratique et l'efficacité, plutôt que vers la théorie.",
  procrastiner: "Remettre systématiquement à plus tard des actions ou tâches.",
  resilience: "Capacité à surmonter les chocs traumatiques et à se reconstruire."
};

export const dictionaryService = {
  /**
   * Nettoie et normalise le mot sélectionné pour la recherche.
   */
  normalizeWord(word: string): string {
    return word
      .trim()
      .toLowerCase()
      // Conserve les lettres de l'alphabet français et les tirets/apostrophes intérieurs
      .replace(/^[^\wàâäéèêëîïôöùûüç]+|[^\wàâäéèêëîïôöùûüç]+$/g, '')
      .replace(/[^a-zàâäéèêëîïôöùûüç\-']/g, '');
  },

  /**
   * Obtient la définition d'un mot.
   * Recherche :
   * 1. Dans la base de données IndexedDB locale.
   * 2. Dans le glossaire embarqué de secours.
   * 3. Via l'API Wiktionnaire française en ligne (puis sauvegarde dans IndexedDB pour l'offline).
   */
  async defineWord(word: string): Promise<string | null> {
    const cleanWord = this.normalizeWord(word);
    if (!cleanWord || cleanWord.length < 2) return null;

    // 1. Recherche dans la DB locale
    try {
      const localResult = await db.dictionary.get(cleanWord);
      if (localResult) {
        console.log(`[Dico] Mot "${cleanWord}" trouvé en base de données locale.`);
        return localResult.definition;
      }
    } catch (e) {
      console.warn("[Dico] Impossible de lire dans IndexedDB", e);
    }

    // 2. Recherche dans le glossaire statique embarqué
    if (EMBEDDED_GLOSSARY[cleanWord]) {
      console.log(`[Dico] Mot "${cleanWord}" trouvé dans le dictionnaire embarqué.`);
      return EMBEDDED_GLOSSARY[cleanWord];
    }

    // 3. Recherche en ligne (API Wiktionnaire) si connecté
    if (navigator.onLine) {
      console.log(`[Dico] Recherche en ligne pour "${cleanWord}"...`);
      try {
        const definition = await this.fetchFromWiktionary(cleanWord);
        if (definition) {
          // Sauvegarde locale pour usage ultérieur hors ligne
          await db.dictionary.put({ word: cleanWord, definition });
          return definition;
        }
      } catch (err) {
        console.warn(`[Dico] Échec lors de la requête Wiktionnaire pour "${cleanWord}" :`, err);
      }
    }

    return "Définition introuvable hors ligne. Connectez-vous à Internet pour rechercher ce mot.";
  },

  /**
   * Interroge l'API de Wiktionnaire pour récupérer une définition concise en français.
   */
  async fetchFromWiktionary(word: string): Promise<string | null> {
    try {
      // API dictionnaire Wiktionary libre et sans clé api
      const url = `https://fr.wiktionary.org/w/api.php?action=query&format=json&origin=*&titles=${encodeURIComponent(word)}&prop=extracts&exintro=1&explaintext=1&redirects=1`;
      const res = await fetch(url);
      if (!res.ok) return null;
      
      const data = await res.json();
      const pages = data.query?.pages;
      if (!pages) return null;

      const pageId = Object.keys(pages)[0];
      if (pageId === '-1') return null;

      const extract: string = pages[pageId].extract || '';
      if (!extract.trim()) return null;

      // Nettoyage sommaire de l'extract pour extraire la première définition utile
      // Wiktionnaire renvoie parfois un grand texte, on isole les premières lignes ou définitions.
      const lines = extract.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('===') && !line.startsWith('=='));
      
      if (lines.length > 0) {
        // Prendre les 2 ou 3 premières lignes significatives
        return lines.slice(0, 3).join('\n');
      }

      return extract;
    } catch (error) {
      console.error("[Dico API Error]", error);
      return null;
    }
  }
};
