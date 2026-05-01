/**
 * File history- recently-opened file paths.
 *
 * Maintains a most-recent-first list of file paths, capped at MAX_ENTRIES.
 * Duplicate paths are deduplicated: re-opening an existing entry moves it to
 * the front rather than duplicating it. History is persisted to localStorage.
 */

const MAX_ENTRIES = 10;
const STORAGE_KEY = "digital-js:file-history";

// ---------------------------------------------------------------------------
// FileHistory
// ---------------------------------------------------------------------------

/**
 * Recently-opened file path history.
 *
 * add(path)      - prepend path; deduplicate; trim to MAX_ENTRIES.
 * getRecent()    - return paths, most recent first.
 * clear()        - empty the history.
 * save()         - persist to localStorage.
 * load()         - restore from localStorage.
 */
export class FileHistory {
  private _paths: string[] = [];
  private _storage: Storage | null;

  constructor(storage: Storage | null = null) {
    this._storage = storage;
  }

  add(path: string): void {
    const existing = this._paths.indexOf(path);
    if (existing !== -1) {
      this._paths.splice(existing, 1);
    }
    this._paths.unshift(path);
    if (this._paths.length > MAX_ENTRIES) {
      this._paths.length = MAX_ENTRIES;
    }
  }

  getRecent(): string[] {
    return [...this._paths];
  }

  clear(): void {
    this._paths = [];
  }

  save(): void {
    if (this._storage === null) return;
    this._storage.setItem(STORAGE_KEY, JSON.stringify(this._paths));
  }

  load(): void {
    if (this._storage === null) return;
    const raw = this._storage.getItem(STORAGE_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this._paths = parsed.filter((v): v is string => typeof v === "string");
        if (this._paths.length > MAX_ENTRIES) {
          this._paths.length = MAX_ENTRIES;
        }
      }
    } catch (e) {
      // Corrupted localStorage entry- surface the anomaly and keep empty
      // history. Per spec/architectural-alignment.md ssI1 the prior silent
      // swallow hid real parse/quota errors.
      console.warn(`[file-history] Failed to parse stored history; keeping empty.`, e);
    }
  }
}
