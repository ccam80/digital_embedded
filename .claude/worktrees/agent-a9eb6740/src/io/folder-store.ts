/**
 * Single-slot IndexedDB storage for uploaded folder contents.
 *
 * Stores the most recent folder's .dig file contents so they survive
 * page refresh. Uploading a new folder overwrites the previous one.
 * "Close Folder" clears the store entirely.
 */

const DB_NAME = "digital-js-folder";
const DB_VERSION = 1;
const STORE_NAME = "folder";
const FOLDER_KEY = "current";

export interface StoredFolder {
  /** Display name (top-level directory name). */
  name: string;
  /**
   * Map of relative path → XML content for every .dig file in the folder.
   * Keys use forward-slash separators regardless of OS.
   */
  files: Record<string, string>;
  /** Unix-ms timestamp of when the folder was stored. */
  timestamp: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store folder contents, replacing any previous folder. */
export async function storeFolder(
  name: string,
  files: Map<string, string>,
): Promise<void> {
  const db = await openDB();
  const record: StoredFolder = {
    name,
    files: Object.fromEntries(files),
    timestamp: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, FOLDER_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Load the stored folder, or null if none exists. */
export async function loadFolder(): Promise<StoredFolder | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(FOLDER_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Clear the stored folder. */
export async function clearFolder(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(FOLDER_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
