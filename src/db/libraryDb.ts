import Dexie, { type Table } from 'dexie';

export interface Book {
  id: string; // Kobo EntitlementId
  title: string;
  authors: string[];
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  fileFormat: string;
  fileSizeBytes: number | null;
  fileHash: string | null;
  coverUrl: string;
  downloaded: boolean;
  addedAt: string;
  updatedAt: string;
  collections: string[]; // collections/tags to which the book belongs
}

export interface BookFile {
  bookId: string;
  blob: Blob;
}

export interface ReadingState {
  bookId: string;
  lastModified: string;
  progressPercent: number; // 0 à 100
  location: {
    Source: string; // chapterFilename / spineId
    Type: string;   // ex: 'KoboSpan', 'EPUBcfi'
    Value: string;  // ex: spanId, cfi
  } | null;
  statistics: any | null;
  statusInfo: any | null;
  synced: boolean;
}

export interface SyncQueueItem {
  id?: number;
  bookId: string;
  payload: any;
  timestamp: number;
}

export interface DictionaryWord {
  word: string; // lowercase
  definition: string;
}

class LibraryDatabase extends Dexie {
  books!: Table<Book, string>;
  bookFiles!: Table<BookFile, string>;
  readingStates!: Table<ReadingState, string>;
  syncQueue!: Table<SyncQueueItem, number>;
  dictionary!: Table<DictionaryWord, string>;

  constructor() {
    super('MiniReaderLibrary');
    this.version(1).stores({
      books: 'id, title, downloaded, updatedAt',
      bookFiles: 'bookId',
      readingStates: 'bookId, progressPercent, synced',
      syncQueue: '++id, bookId, timestamp',
      dictionary: 'word',
    });
  }
}

export const db = new LibraryDatabase();
