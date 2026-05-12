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
// PoolSlotRef- compile-time-resolved cross-element state-pool reference.
//
// The compiler writes one of these into a sub-element's PropertyBag when it
// resolves a `{ kind: "siblingState", subElementName, slotName }` netlist
// param (compiler.ts siblingState resolver). The receiving leaf reads it via
// `props.get<PoolSlotRef>(paramKey)` and computes a flat pool index in
// load() as `ref.element._stateBase + ref.slotIdx`.
//
// The `element` field is typed structurally (`{ _stateBase: number }`) to
// avoid a properties.ts -> solver/analog/element.ts import cycle. Consumers
// that need the full AnalogElement shape intersect at the use site.
// ---------------------------------------------------------------------------

export interface PoolSlotRef {
  kind: "poolSlotRef";
  element: { _stateBase: number };
  slotIdx: number;
}

// ---------------------------------------------------------------------------
// PropertyValue- the union of all valid property value types
// ---------------------------------------------------------------------------

/**
 * Sidecar storage shape: arbitrary object/map data attached to a PropertyBag
 * under an underscore-prefixed key (e.g. `_pinElectrical`, `_pinLoading`,
 * `_pinElectricalOverrides`). Sidecar consumers cast back to the concrete
 * inner shape on read; the union arm exists to keep the write side type-safe.
 *
 * Both `Record<string, unknown>` and `ReadonlyMap<string, unknown>` are
 * accepted so callers can use whichever container fits the data.
 */
export type PropertyValue =
  | number
  | string
  | boolean
  | bigint
  | number[]
  | Record<string, number>
  | Record<string, unknown>
  | ReadonlyMap<string, unknown>
  | PoolSlotRef;

// ---------------------------------------------------------------------------
// PropertyDefinition- static description of one property slot
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

  /**
   * When true, changing this property alters circuit topology (pin count,
   * net allocation, MNA matrix structure) and always requires recompilation.
   * When false or absent, numeric values are hot-loaded via setParam.
   *
   * Used by the canvas-popup dispatch to override the typeof heuristic:
   * a numeric property marked structural will trigger recompilation even
   * though it is a number.
   */
  structural?: boolean;
}

// ---------------------------------------------------------------------------
// PropertyBag- validated map<string, PropertyValue> with typed access
// ---------------------------------------------------------------------------

export class PropertyBag {
  private readonly _map: Map<string, PropertyValue>;
  private readonly _mparams: Map<string, PropertyValue> = new Map();
  // ngspice-style *Given tracking: which model params were set by user action
  // (setModelParam / runtime setParam / explicit markGiven) vs seeded as
  // registry defaults (replaceModelParams without opts). Mirrors per-instance
  // *Given flags in ngspice (e.g. DIOtempGiven, BJTtempGiven). The netlist
  // generator emits per-instance overrides only for given keys so .options
  // TEMP=<celsius> can drive cktTemp uniformly across both engines.
  private readonly _mparamsGiven: Set<string> = new Set();

  constructor(entries?: Iterable<readonly [string, PropertyValue]>) {
    this._map = new Map();
    if (entries) {
      for (const [k, v] of entries) {
        this._map.set(k, v);
      }
    }
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

  /** Remove a key from the regular property partition. */
  delete(key: string): boolean {
    return this._map.delete(key);
  }

  // -------------------------------------------------------------------------
  // Model parameter partition
  // -------------------------------------------------------------------------

  getModelParam<T extends PropertyValue>(key: string): T {
    const value = this._mparams.get(key);
    if (value === undefined) {
      throw new Error(`PropertyBag: model param "${key}" not found`);
    }
    return value as T;
  }

  setModelParam(key: string, value: PropertyValue): void {
    this._mparams.set(key, value);
    this._mparamsGiven.add(key);
  }

  /**
   * Replace the entire model-param partition. By default, written keys are
   * NOT marked given — they represent registry defaults.
   *
   * Options:
   * - `markGiven: true` — mark every written key as given (e.g. .dts loader
   *   re-hydrating user-supplied _modelParams).
   * - `preserveGivenness: true` — snapshot the existing _mparamsGiven set
   *   before clearing, then re-mark any key from that snapshot that is still
   *   present in the new params (e.g. the analog compiler re-merging defaults
   *   while a runtime setParam("TEMP", v) is in effect).
   */
  replaceModelParams(
    params: Record<string, PropertyValue>,
    opts?: { markGiven?: boolean; preserveGivenness?: boolean },
  ): void {
    const preserved = opts?.preserveGivenness ? new Set(this._mparamsGiven) : null;
    this._mparams.clear();
    this._mparamsGiven.clear();
    for (const [k, v] of Object.entries(params)) {
      this._mparams.set(k, v);
      if (opts?.markGiven) {
        this._mparamsGiven.add(k);
      } else if (preserved?.has(k)) {
        this._mparamsGiven.add(k);
      }
    }
  }

  getModelParamKeys(): string[] {
    return Array.from(this._mparams.keys());
  }

  hasModelParam(key: string): boolean {
    return this._mparams.has(key);
  }

  /** Mirror of ngspice per-instance *Given flags (e.g. DIOtempGiven). True iff
   * the value was set by user action (setModelParam, runtime setParam, or
   * loaded from a .dts _modelParams block); false when seeded as a registry
   * default via replaceModelParams. */
  isModelParamGiven(key: string): boolean {
    return this._mparamsGiven.has(key);
  }

  /** Keys whose values were explicitly set by user action. Used by the
   * netlist generator and .dts serializer to emit only user-given values. */
  getGivenModelParamKeys(): string[] {
    return Array.from(this._mparamsGiven);
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
    for (const [k, v] of this._mparams) {
      cloned._mparams.set(k, Array.isArray(v) ? [...v] : (typeof v === 'object' && v !== null ? { ...v } : v));
    }
    for (const k of this._mparamsGiven) {
      cloned._mparamsGiven.add(k);
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
export function isPoolSlotRef(v: PropertyValue): v is PoolSlotRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && 'kind' in v && (v as { kind: unknown }).kind === 'poolSlotRef';
}

export function propertyBagToJson(bag: PropertyBag): SerializedPropertyBag {
  const out: SerializedPropertyBag = {};
  for (const [k, v] of bag.entries()) {
    if (typeof v === 'bigint') {
      out[k] = `0n${v.toString()}`;
    } else if (isPoolSlotRef(v)) {
      // PoolSlotRef holds a runtime element reference and is re-resolved by
      // the compiler on every expansion. Skip serialisation — re-emit by
      // re-running the compiler.
      continue;
    } else if (v instanceof Map) {
      // ReadonlyMap sidecars (compiler-built per-pin loading / electrical
      // tables, etc.) are runtime-only and re-derived from the compiled
      // circuit on every recompile.
      continue;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // Object-shaped sidecars (`_pinElectrical`, `_pinLoading`) are
      // runtime-only. The narrow Record<string, number> arm (used by user-
      // facing `_pinElectricalOverrides`) IS serialised; broader
      // Record<string, unknown> values are not.
      const allNumeric = Object.values(v).every((x) => typeof x === 'number');
      if (!allNumeric) continue;
      out[k] = v as Record<string, number>;
    } else {
      out[k] = v;
    }
  }
  // Serialize model params under a reserved key
  const mparamKeys = bag.getModelParamKeys();
  if (mparamKeys.length > 0) {
    const mp: Record<string, number> = {};
    for (const k of mparamKeys) mp[k] = bag.getModelParam<number>(k);
    out['_modelParams'] = mp;
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

