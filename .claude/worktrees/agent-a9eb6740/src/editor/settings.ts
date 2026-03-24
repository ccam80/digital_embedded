/**
 * Application settings — typed access with localStorage persistence.
 *
 * Settings are identified by SettingKey enum values. Each key has a type-safe
 * default. Values are persisted to localStorage as JSON. Per-setting change
 * listeners allow the UI and engine layers to react to preference changes.
 */

// ---------------------------------------------------------------------------
// SettingKey enum
// ---------------------------------------------------------------------------

export enum SettingKey {
  GRID_SIZE = "GRID_SIZE",
  DEFAULT_DELAY = "DEFAULT_DELAY",
  COLOR_SCHEME = "COLOR_SCHEME",
  LANGUAGE = "LANGUAGE",
  SIM_SPEED = "SIM_SPEED",
  DEFAULT_RADIX = "DEFAULT_RADIX",
  GATE_SHAPE = "GATE_SHAPE",
  SNAP_TO_GRID = "SNAP_TO_GRID",
}

// ---------------------------------------------------------------------------
// Setting value types
// ---------------------------------------------------------------------------

export type Radix = "hex" | "dec" | "bin" | "signed";
export type GateShape = "ieee" | "iec";

/** Map from SettingKey to its value type. */
export interface SettingTypeMap {
  [SettingKey.GRID_SIZE]: number;
  [SettingKey.DEFAULT_DELAY]: number;
  [SettingKey.COLOR_SCHEME]: string;
  [SettingKey.LANGUAGE]: string;
  [SettingKey.SIM_SPEED]: number;
  [SettingKey.DEFAULT_RADIX]: Radix;
  [SettingKey.GATE_SHAPE]: GateShape;
  [SettingKey.SNAP_TO_GRID]: boolean;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULTS: SettingTypeMap = {
  [SettingKey.GRID_SIZE]: 1,
  [SettingKey.DEFAULT_DELAY]: 1,
  [SettingKey.COLOR_SCHEME]: "default",
  [SettingKey.LANGUAGE]: "en",
  [SettingKey.SIM_SPEED]: 1,
  [SettingKey.DEFAULT_RADIX]: "hex",
  [SettingKey.GATE_SHAPE]: "ieee",
  [SettingKey.SNAP_TO_GRID]: true,
};

const STORAGE_KEY = "digital-js:settings";

// ---------------------------------------------------------------------------
// AppSettings
// ---------------------------------------------------------------------------

/**
 * Typed application preferences store.
 *
 * get<T>(key) returns the current value (default if not yet set).
 * set(key, value) updates the value and fires per-key listeners.
 * reset(key) restores the default for that key and fires listeners.
 * save() serialises all settings to localStorage.
 * load() deserialises from localStorage and applies defaults for missing keys.
 * onChange(key, callback) registers a listener invoked on every set/reset of that key.
 */
export class AppSettings {
  private _values: SettingTypeMap;
  private _listeners: Map<SettingKey, Array<(value: unknown) => void>> =
    new Map();
  private _storage: Storage | null;

  constructor(storage: Storage | null = null) {
    this._storage = storage;
    this._values = { ...DEFAULTS };
  }

  get<K extends SettingKey>(key: K): SettingTypeMap[K] {
    return this._values[key];
  }

  set<K extends SettingKey>(key: K, value: SettingTypeMap[K]): void {
    this._values[key] = value;
    this._fireListeners(key, value);
  }

  reset<K extends SettingKey>(key: K): void {
    const defaultValue = DEFAULTS[key];
    this._values[key] = defaultValue;
    this._fireListeners(key, defaultValue);
  }

  save(): void {
    if (this._storage === null) return;
    this._storage.setItem(STORAGE_KEY, JSON.stringify(this._values));
  }

  load(): void {
    if (this._storage === null) return;
    const raw = this._storage.getItem(STORAGE_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<SettingTypeMap>;
      for (const key of Object.values(SettingKey)) {
        if (key in parsed) {
          (this._values as unknown as Record<string, unknown>)[key] = (
            parsed as unknown as Record<string, unknown>
          )[key];
        }
      }
    } catch {
      // Corrupted storage — fall back to defaults silently.
    }
  }

  onChange<K extends SettingKey>(
    key: K,
    callback: (value: SettingTypeMap[K]) => void,
  ): void {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, []);
    }
    this._listeners.get(key)!.push(callback as (value: unknown) => void);
  }

  private _fireListeners(key: SettingKey, value: unknown): void {
    const callbacks = this._listeners.get(key);
    if (callbacks === undefined) return;
    for (const cb of callbacks) {
      cb(value);
    }
  }
}
