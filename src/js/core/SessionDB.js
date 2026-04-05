/**
 * SessionDB.js
 * IndexedDB-backed session persistence (SPEC.md Section 5.11, 8.3).
 * Key: SHA-256 of PDF file content (not filename).
 * Auto-saves annotations + scroll position with 2s debounce.
 * Cleans up sessions older than 30 days on open.
 */

const DB_NAME    = 'openspec-v1';
const STORE_NAME = 'sessions';
const DB_VERSION = 1;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class SessionDB {
  #db = null;
  #saveTimer = null;
  #available = true;

  async init() {
    try {
      this.#db = await this.#openDB();
    } catch (err) {
      console.warn('[SessionDB] IndexedDB unavailable:', err.message);
      this.#available = false;
    }
  }

  get isAvailable() { return this.#available && this.#db !== null; }

  /** Load a session by file hash. Returns null if not found. */
  async load(fileHash) {
    if (!this.isAvailable) return null;
    return new Promise((resolve) => {
      const tx = this.#db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(fileHash);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  }

  /**
   * Save session data (debounced 2s).
   * Call this whenever annotations or position changes.
   */
  save(fileHash, data) {
    if (!this.isAvailable) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#write(fileHash, { ...data, fileHash, savedAt: new Date().toISOString() });
    }, 2000);
  }

  /** Force-save immediately (e.g. before page unload). */
  async saveNow(fileHash, data) {
    if (!this.isAvailable) return;
    clearTimeout(this.#saveTimer);
    await this.#write(fileHash, { ...data, fileHash, savedAt: new Date().toISOString() });
  }

  /** Clear all sessions. Used by Tools > Clear Session Data. */
  async clearAll() {
    if (!this.isAvailable) return;
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = resolve;
      req.onerror   = () => reject(req.error);
    });
  }

  /** Remove a single session. */
  async remove(fileHash) {
    if (!this.isAvailable) return;
    return new Promise((resolve) => {
      const tx = this.#db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(fileHash);
      tx.oncomplete = resolve;
    });
  }

  /** Clean sessions older than 30 days. Call on app startup. */
  async cleanOld() {
    if (!this.isAvailable) return;
    const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
    return new Promise((resolve) => {
      const tx = this.#db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('savedAt');
      const range = IDBKeyRange.upperBound(cutoff);
      const req = index.openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = resolve;
    });
  }

  // ---- Private ----

  async #write(fileHash, data) {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(data);
      req.onsuccess = resolve;
      req.onerror   = () => reject(req.error);
    });
  }

  #openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'fileHash' });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
}

export const sessionDB = new SessionDB();
export default SessionDB;
