// ---------------------------------------------------------------------------
// PropertyType
// ---------------------------------------------------------------------------

export const enum PropertyType {
  INT = 'INT',
  FLOAT = 'FLOAT',
  STRING = 'STRING',
  ENUM = 'ENUM',
  BOOLEAN = 'BOOLEAN',
  BIT_WIDTH = 'BIT_WIDTH',
  HEX_DATA = 'HEX_DATA',
  COLOR = 'COLOR',
  LONG = 'LONG',
  FILE = 'FILE',
  ROTATION = 'ROTATION',
  INTFORMAT = 'INTFORMAT',
}

// ---------------------------------------------------------------------------
// PropertyValue — the union of all valid property value types
// ---------------------------------------------------------------------------

export type PropertyValue = number | string | boolean | bigint | number[] | Record<string, number>;

// ---------------------------------------------------------------------------
// PropertyDefinition — static description of one property slot
// ---------------------------------------------------------------------------

export interface PropertyDefinition {
  /** Internal key used in PropertyBag and serialization. E.g. "bitWidth", "label". */
  key: string;
  type: PropertyType;
  /** Human-readable name shown in the property panel. */
  label: string;
  defaultValue: PropertyValue;
  description?: string;
  /** Valid string values when type is ENUM. */
  enumValues?: string[];
  /** Inclusive minimum, used for INT and BIT_WIDTH. */
  min?: number;
  /** Inclusive maximum, used for INT and BIT_WIDTH. */
  max?: number;
  /** SI base unit string (e.g. "Ω", "F", "H", "V", "A"). When set, the
   *  property input displays with auto-scaled SI prefix and accepts prefixed
   *  text entry (e.g. "4.7k", "100n", "2.2u"). */
  unit?: string;
  /**
   * Conditional visibility: this property row is only shown when the property
   * identified by `key` has one of the listed `values`. Used to hide
   * waveform-specific parameters (e.g. sweep fields only when waveform="sweep").
   */
  visibleWhen?: { key: string; values: PropertyValue[] };
  /**
   * When true, the property is excluded from the visible property panel rows.
   * The value is still stored in the PropertyBag and accessible via
   * setComponentProperty / serialization.
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// PropertyBag — validated map<string, PropertyValue> with typed access
// ---------------------------------------------------------------------------

export class PropertyBag {
  private readonly _map: Map<string, PropertyValue>;
  private readonly _modelParams: Map<string, PropertyValue> = new Map();

  constructor(entries?: Iterable<readonly [string, PropertyValue]>) {
    this._map = new Map(entries);
  }

  /**
   * Typed read. Returns the stored value cast to T.
   * Throws if the key is absent so callers must use has() first when optional.
   */
  get<T extends PropertyValue>(key: string): T {
    const value = this._map.get(key);
    if (value === undefined) {
      throw new Error(`PropertyBag: key "${key}" not found`);
    }
    return value as T;
  }

  /**
   * Typed read with a fallback default when the key is absent.
   */
  getOrDefault<T extends PropertyValue>(key: string, defaultValue: T): T {
    const value = this._map.get(key);
    if (value === undefined) {
      return defaultValue;
    }
    return value as T;
  }

  /**
   * Write a value. The value must conform to the PropertyValue union type;
   * callers are responsible for type-correct writes.
   */
  set(key: string, value: PropertyValue): void {
    this._map.set(key, value);
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  // -------------------------------------------------------------------------
  // Model parameter partition
  // -------------------------------------------------------------------------

  getModelParam<T extends PropertyValue>(key: string): T {
    const value = this._modelParams.get(key);
    if (value === undefined) {
      throw new Error(`PropertyBag: model param "${key}" not found`);
    }
    return value as T;
  }

  setModelParam(key: string, value: PropertyValue): void {
    this._modelParams.set(key, value);
  }

  replaceModelParams(params: Record<string, PropertyValue>): void {
    this._modelParams.clear();
    for (const [k, v] of Object.entries(params)) {
      this._modelParams.set(k, v);
    }
  }

  getModelParamKeys(): string[] {
    return Array.from(this._modelParams.keys());
  }

  hasModelParam(key: string): boolean {
    return this._modelParams.has(key);
  }

  /**
   * Deep copy. Arrays within values are cloned element-by-element.
   * Primitive types (number, string, boolean, bigint) are copied by value.
   */
  clone(): PropertyBag {
    const cloned = new PropertyBag();
    for (const [k, v] of this._map) {
      cloned._map.set(k, Array.isArray(v) ? [...v] : (typeof v === 'object' && v !== null ? { ...v } : v));
    }
    for (const [k, v] of this._modelParams) {
      cloned._modelParams.set(k, Array.isArray(v) ? [...v] : (typeof v === 'object' && v !== null ? { ...v } : v));
    }
    return cloned;
  }

  entries(): IterableIterator<[string, PropertyValue]> {
    return this._map.entries();
  }

  /** Number of entries in this bag. */
  get size(): number {
    return this._map.size;
  }
}

export type SerializedPropertyBag = Record<string, number | string | boolean | number[] | Record<string, number>>;

/**
 * Serialize a PropertyBag to a plain object suitable for JSON.stringify.
 * bigint values are encoded as "0n<digits>" strings.
 */
export function propertyBagToJson(bag: PropertyBag): SerializedPropertyBag {
  const out: SerializedPropertyBag = {};
  for (const [k, v] of bag.entries()) {
    out[k] = typeof v === 'bigint' ? `0n${v.toString()}` : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared property definition constants
// ---------------------------------------------------------------------------

/**
 * Standard label property definition shared by all components that show an
 * optional user-supplied label above the component body.
 */
export const LABEL_PROPERTY_DEF: PropertyDefinition = {
  key: "label",
  type: PropertyType.STRING,
  label: "Label",
  defaultValue: "",
  description: "Optional label shown above the component",
};

