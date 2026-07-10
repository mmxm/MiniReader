export interface KoboBookEntitlement {
  Accessibility: string;
  ActivePeriod: { From: string };
  Created: string;
  CrossRevisionId: string;
  Id: string;
  IsRemoved: boolean;
  IsHiddenFromArchive: boolean;
  IsLocked: boolean;
  LastModified: string;
  OriginCategory: string;
  RevisionId: string;
  Status: string;
  Type: string;
}

export interface KoboBookMetadata {
  CrossRevisionId: string;
  RevisionId: string;
  EntitlementId: string;
  WorkId: string;
  Title: string;
  Slug: string;
  Description: string | null;
  Downloads: { Url: string }[];
  Authors: { Name: string }[];
  Publisher: { Name: string; Imprint: string } | null;
  PublicationDate: string | null;
  CoverUrl?: string; // Derived or custom
}

export interface KoboReadingStatePayload {
  CurrentBookmark: {
    LastModified: string;
    ProgressPercent: number; // 0 to 100
    Location?: {
      Source: string;
      Type: string;
      Value: string;
    } | null;
    ContentSourceProgressPercent?: number;
  };
  Statistics?: any;
  StatusInfo?: any;
}

export interface SyncDeltaResult {
  entitlements: any[];
  hasMore: boolean;
  nextSyncToken: string | null;
}

/**
 * Normalise l'URL du serveur BookOrbit.
 * Si l'utilisateur saisit l'URL complète 'https://serveur.com/api/v1/kobo/token',
 * nous extrayons le token de périphérique et l'URL de base pour simplifier les requêtes.
 */
export interface BookOrbitConfig {
  baseUrl: string; // ex: https://serveur.com/api/v1/kobo/token
  deviceToken: string;
}

export function parseSyncUrl(url: string): BookOrbitConfig {
  const trimmed = url.trim().replace(/\/$/, '');
  const match = trimmed.match(/\/kobo\/([^\/]+)/);
  if (!match) {
    throw new Error("L'URL saisie n'a pas le format Kobo Sync attendu (elle doit contenir /api/v1/kobo/token)");
  }
  return {
    baseUrl: trimmed,
    deviceToken: match[1]
  };
}

export function getRequestUrl(url: string): string {
  const useProxy = localStorage.getItem('bookorbit_use_proxy') === 'true';
  if (useProxy) {
    return `/api/proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

/**
 * Service pour interagir directement avec l'API Kobo Sync de BookOrbit.
 */
export const koboSyncApi = {
  /**
   * Effectue l'initialisation du périphérique virtuel Kobo
   */
  async initialize(syncUrl: string): Promise<any> {
    const config = parseSyncUrl(syncUrl);
    const targetUrl = getRequestUrl(`${config.baseUrl}/v1/initialization`);
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Kobo eReader'
      }
    });

    if (!response.ok) {
      throw new Error(`Erreur lors de l'initialisation Kobo (${response.status})`);
    }

    return response.json();
  },

  /**
   * Récupère une page de delta de la bibliothèque.
   * Retourne la liste des entitlements modifiés ou supprimés et s'il y a d'autres pages.
   */
  async fetchLibraryDelta(syncUrl: string, syncToken?: string): Promise<SyncDeltaResult> {
    const config = parseSyncUrl(syncUrl);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'Kobo eReader'
    };

    if (syncToken) {
      headers['x-kobo-synctoken'] = syncToken;
    }

    const targetUrl = getRequestUrl(`${config.baseUrl}/v1/library/sync`);
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(`Erreur de synchronisation du catalogue (${response.status})`);
    }

    const entitlements = await response.json();
    
    // Dans la spec Kobo, la présence de la suite est signalée par le header 'x-kobo-sync' = 'continue'
    const xKoboSync = response.headers.get('x-kobo-sync');
    const hasMore = xKoboSync === 'continue' || entitlements.length >= 5; // Fallback sécurité
    const nextSyncToken = response.headers.get('x-kobo-synctoken');

    return {
      entitlements,
      hasMore,
      nextSyncToken
    };
  },

  /**
   * Télécharge un fichier EPUB pour un livre donné
   */
  async downloadBook(syncUrl: string, entitlementId: string): Promise<Blob> {
    const config = parseSyncUrl(syncUrl);
    const targetUrl = getRequestUrl(`${config.baseUrl}/v1/books/${entitlementId}/download`);
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Kobo eReader'
      }
    });

    if (!response.ok) {
      throw new Error(`Impossible de télécharger le fichier du livre (${response.status})`);
    }

    return response.blob();
  },

  /**
   * Récupère la progression de lecture actuelle d'un livre depuis le serveur
   */
  async fetchReadingState(syncUrl: string, entitlementId: string): Promise<any> {
    const config = parseSyncUrl(syncUrl);
    const targetUrl = getRequestUrl(`${config.baseUrl}/v1/library/${entitlementId}/state`);
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Kobo eReader'
      }
    });

    if (!response.ok) {
      throw new Error(`Impossible de récupérer l'état de lecture (${response.status})`);
    }

    const states = await response.json();
    return Array.isArray(states) && states.length > 0 ? states[0] : null;
  },

  /**
   * Met à jour la progression de lecture sur BookOrbit
   */
  async updateReadingState(
    syncUrl: string,
    entitlementId: string,
    payload: any
  ): Promise<any> {
    const config = parseSyncUrl(syncUrl);
    const targetUrl = getRequestUrl(`${config.baseUrl}/v1/library/${entitlementId}/state`);
    const response = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Kobo eReader'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Impossible de synchroniser l'état de lecture (${response.status})`);
    }

    return response.json();
  }
};
