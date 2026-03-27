/**
 * IndexedDB persistence for user-created subcircuits.
 *
 * Stores multiple named subcircuits (one entry per user-created subcircuit),
 * each serialized as .dig XML. Entries survive page refresh.
 *
 * Unlike folder-store (single-slot), this store holds multiple named entries.
 */

const DB_NAME = "digital-js-subcircuits";
const DB_VERSION = 1;
const STORE_NAME = "subcircuits";

export interface StoredSubcircuit {
  /** User-assigned subcircuit name (primary key). */
  name: string;
  /** Serialized .dig XML content. */
  xml: string;
  /** Unix-ms timestamp of initial creation. */
  created: number;
  /** Unix-ms timestamp of most recent update. */
  modified: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Upsert a subcircuit entry.
 *
 * If an entry with the given name already exists, its `xml` and `modified`
 * timestamp are updated. If it does not exist, a new entry is created with
 * both `created` and `modified` set to now.
 */
export async function storeSubcircuit(
  name: string,
  xml: string,
): Promise<void> {
  const db = await openDB();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const getReq = store.get(name);
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredSubcircuit | undefined;
      const record: StoredSubcircuit = {
        name,
        xml,
        created: existing?.created ?? now,
        modified: now,
      };
      store.put(record);
    };
    getReq.onerror = () => {
      db.close();
      reject(getReq.error);
    };

    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Load all stored subcircuits, in insertion order.
 */
export async function loadAllSubcircuits(): Promise<StoredSubcircuit[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result as StoredSubcircuit[]); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Delete a subcircuit entry by name. No-op if name does not exist.
 */
export async function deleteSubcircuit(name: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(name);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
