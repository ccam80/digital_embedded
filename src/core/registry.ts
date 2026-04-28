/**
 * Component registry — one registration shape per component type.
 *
 * Per Decision 4: ComponentDefinition bundles factory, models, pinLayout,
 * propertyDefs, and attributeMap. Type IDs are auto-assigned at registration
 * time (incrementing counter). They are never serialized.
 */

import type { CircuitElement } from "./element.js";
import type { PinDeclaration } from "./pin.js";
import { PropertyBag, PropertyType } from "./properties.js";
import type { PropertyDefinition, PropertyValue } from "./properties.js";
import type { AnalogElement } from "./analog-types.js";
import type { MnaSubcircuitNetlist } from "./mna-subcircuit-netlist.js";
import type { PinElectricalSpec } from "./pin-electrical.js";

// ---------------------------------------------------------------------------
// AnalogFactory — named factory signature for MNA element construction
// ---------------------------------------------------------------------------

export type AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElement;

// ---------------------------------------------------------------------------
// ParamDef — schema entry for one model parameter
// ---------------------------------------------------------------------------

export interface ParamDef {
  key: string;
  type: PropertyType;
  label: string;
  unit?: string;
  description?: string;
  rank: "primary" | "secondary";
  /**
   * SPICE-emission partition. "instance" means the param is emitted on the
   * element line (e.g. `D1 a k MOD AREA=2 OFF=1`) and is NOT a `.model` card
   * parameter. Anything else (including `undefined`) is treated as "model"
   * and emitted on the `.model` card. Defaulting to undefined preserves
   * compatibility with hand-authored ParamDef literals outside
   * defineModelParams().
   */
  partition?: "instance" | "model";
  min?: number;
  max?: number;
  default?: number;
  /**
   * SPICE keyword on emission. Defaults to `key`. Use when ngspice's parser
   * accepts a different identifier for the same parameter. Example: digiTS
   * uses `ISW` (sidewall saturation current); ngspice's diode parser names
   * the same parameter `JSW`. Storage and `getModelParam("ISW")` still use
   * the digiTS key — the rename only applies at the netlist boundary.
   */
  spiceName?: string;
  /**
   * Emission style. `"key-value"` (default) — `KEY=value`. `"flag"` — bare
   * uppercase keyword when value is truthy, omitted when zero/false. ngspice
   * rejects `OFF=0` as a parse error; this is how OFF and any other future
   * bare-keyword param emit.
   */
  emit?: "key-value" | "flag";
  /**
   * Combined-emission group. When set, the generator collects every ParamDef
   * with the same `emitGroup.name` and emits them as a single comma-joined
   * token: `<NAME>=v1,v2,v3` (in ascending `index` order). Currently used for
   * the MOS initial-condition triplet (ICVDS/ICVGS/ICVBS → `IC=vds,vgs,vbs`).
   * The group is emitted only when at least one member has a non-default value.
   */
  emitGroup?: { name: string; index: number };
}

/** SPICE-emission overrides for a ModelEntry. */
export interface ModelEmissionSpec {
  /**
   * Constant tokens prepended to the .model card body, in order, ahead of
   * any paramDefs-derived params. Use for static SPICE attributes that
   * are not exposed as digiTS model params (e.g. `LEVEL=3` for a future
   * SPICE-L3 tunnel-diode ModelEntry — not used by any component in this
   * cleanup; see ngspice-netlist-generator-architecture.md §3.7a).
   */
  modelCardPrefix?: readonly string[];
}

// ---------------------------------------------------------------------------
// ModelEntry — unified model type (inline factory or netlist-derived)
// ---------------------------------------------------------------------------

export type ModelEntry =
  | {
      kind: "inline";
      factory: AnalogFactory;
      paramDefs: ParamDef[];
      params: Record<string, number>;
      branchCount?: number | ((props: PropertyBag) => number);
      /** SPICE-emission overrides for this model. */
      spice?: ModelEmissionSpec;
      /** Maps digiTS pin label → ngspice node-variable suffix.
       *  Mirrors the same field on ComponentDefinition for per-model overrides. */
      ngspiceNodeMap?: Record<string, string>;
    }
  | {
      kind: "netlist";
      netlist: MnaSubcircuitNetlist;
      paramDefs: ParamDef[];
      params: Record<string, number>;
      /** SPICE-emission overrides for this model. */
      spice?: ModelEmissionSpec;
    };

// ---------------------------------------------------------------------------
// Well-known property keys
// ---------------------------------------------------------------------------

/**
 * Property keys with special handling by the editor, compiler, or engine.
 *
 * These keys are recognized by the property panel and simulation pipeline
 * and receive dedicated UI treatment beyond the generic property editor.
 */
export const WELL_KNOWN_PROPERTY_KEYS = new Set<string>([
  "label", "showLabel", "showValue",
]);

/**
 * Component types that should NOT receive auto-injected label/showLabel/showValue
 * properties. These are fixed-symbol components with no user-visible label.
 */
const LABEL_EXEMPT_TYPES = new Set<string>(["VDD", "Ground", "NotConnected"]);

// ---------------------------------------------------------------------------
// ComponentCategory
// ---------------------------------------------------------------------------

export const enum ComponentCategory {
  LOGIC = "LOGIC",
  IO = "IO",
  FLIP_FLOPS = "FLIP_FLOPS",
  MEMORY = "MEMORY",
  ARITHMETIC = "ARITHMETIC",
  WIRING = "WIRING",
  SWITCHING = "SWITCHING",
  PLD = "PLD",
  MISC = "MISC",
  GRAPHICS = "GRAPHICS",
  TERMINAL = "TERMINAL",
  SEVENTY_FOUR_XX = "74XX",
  SUBCIRCUIT = "SUBCIRCUIT",
  PASSIVES = "PASSIVES",
  SEMICONDUCTORS = "SEMICONDUCTORS",
  SOURCES = "SOURCES",
  ACTIVE = "ACTIVE",
}

// ---------------------------------------------------------------------------
// AttributeMapping — .dig XML attribute → PropertyBag entry
// ---------------------------------------------------------------------------

/**
 * Maps one XML attribute key from a .dig file to a PropertyBag entry.
 *
 * Per Decision 5: Components only see PropertyBag. The parser reads the
 * registry's attributeMap and applies converters mechanically — it never
 * needs to know what properties a component has.
 */
export interface AttributeMapping {
  /** Key as it appears in the .dig XML, e.g. "Bits". */
  xmlName: string;
  /** Key used in the PropertyBag, e.g. "bitWidth". */
  propertyKey: string;
  /** Converts the raw XML string value to the typed PropertyValue. */
  convert: (xmlValue: string) => PropertyValue;
  /** When true, the value is written to the model-param partition (_mparams). */
  modelParam?: boolean;
}

// ---------------------------------------------------------------------------
// ComponentLayout — wiring info for a component instance in the engine
// ---------------------------------------------------------------------------

/**
 * The engine's wiring descriptor for a single component instance.
 *
 * Produced by the compiler (Phase 3). Defined here as a type so that
 * ExecuteFunction can reference it. Phase 3 implements layout computation.
 *
 * inputOffset(index) and outputOffset(index) return indices into the
 * wiringTable. The wiringTable maps those indices to actual net IDs in
 * the signal array. Access pattern:
 *   - Inputs:  state[wiringTable[inputOffset(i) + k]]
 *   - Outputs: state[wiringTable[outputOffset(i) + k]]
 *   - State:   state[stateOffset(i) + k]  (direct, no indirection)
 */
export interface ComponentLayout {
  /** Wiring indirection table mapping layout indices to net IDs. */
  readonly wiringTable: Int32Array;
  /** Number of input pins for component at the given index. */
  inputCount(componentIndex: number): number;
  /** Starting index in the wiringTable for component's inputs. */
  inputOffset(componentIndex: number): number;
  /** Number of output pins for component at the given index. */
  outputCount(componentIndex: number): number;
  /** Starting index in the wiringTable for component's outputs. */
  outputOffset(componentIndex: number): number;
  /** Starting index in the state array for component's persistent state slots. */
  stateOffset(componentIndex: number): number;
  /**
   * Read a per-instance property value for a component at the given index.
   * Returns undefined when the property is not set.
   * ExecuteFunctions use this to read bitWidth, signed, etc. at runtime.
   * Required by all engines — analog engines use it for live slider updates,
   * digital engines populate it at compile time.
   */
  getProperty(componentIndex: number, key: string): PropertyValue | undefined;
  /**
   * Returns the switch classification for a component: 0=not a switch,
   * 1=unidirectional, 2=bidirectional. Used by switch executeFns to choose
   * between forwarding values directly or writing closedFlag only.
   */
  getSwitchClassification?(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// ExecuteFunction — flat simulation function type
// ---------------------------------------------------------------------------

/**
 * Standalone simulation function for one component type.
 *
 * Per Decision 1: simulation logic does NOT live on CircuitElement. These
 * functions are stored in the ComponentDefinition and called by the engine's
 * inner loop via a function table indexed by typeId.
 *
 * Access pattern inside executeFns:
 *   const wt = layout.wiringTable;
 *   const inBase = layout.inputOffset(index);
 *   const outBase = layout.outputOffset(index);
 *   // Read input k:  state[wt[inBase + k]]
 *   // Write output k: state[wt[outBase + k]] = value
 *   // Read/write state slot k: state[layout.stateOffset(index) + k]  (direct)
 *
 * @param index     Component slot index within the compiled model.
 * @param state     Signal value array owned by the engine.
 * @param highZs    High-impedance flags array, parallel to `state`. Components
 *                  that support tri-state output set `highZs[netId] = 1` when
 *                  the output is high-Z, `0` otherwise.
 * @param layout    Wiring descriptor providing input/output offsets.
 */
export type ExecuteFunction = (
  index: number,
  state: Uint32Array,
  highZs: Uint32Array,
  layout: ComponentLayout,
) => void;

// ---------------------------------------------------------------------------
// ComponentModels — structured simulation model container
// ---------------------------------------------------------------------------

/**
 * Event-driven digital simulation model.
 * Reads/writes bit vectors on discrete nets via executeFn.
 */
export interface DigitalModel {
  executeFn: ExecuteFunction;
  sampleFn?: ExecuteFunction;
  stateSlotCount?: number | ((props: PropertyBag) => number);
  defaultDelay?: number;
  switchPins?: [number, number];
  inputSchema?: string[] | ((props: PropertyBag) => string[]);
  outputSchema?: string[] | ((props: PropertyBag) => string[]);
}

/**
 * Container for all simulation models a component type supports.
 */
export interface ComponentModels {
  /** Event-driven digital: reads/writes bit vectors on discrete nets. */
  digital?: DigitalModel;
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

/**
 * Complete registration record for one component type.
 *
 * Every field is required at registration time. typeId is filled in by the
 * registry — callers supply everything else.
 */
export interface ComponentDefinition {
  /** Type name matching the .dig elementName, e.g. "And", "FlipflopD". */
  name: string;
  /**
   * Numeric type ID auto-assigned by ComponentRegistry.register().
   * Not serialized. Used only at runtime for function-table dispatch.
   * Set to -1 in the object passed to register(); the registry replaces it.
   */
  typeId: number;
  /** Construct a CircuitElement for a placed instance from its properties. */
  factory: (props: PropertyBag) => CircuitElement;
  /** Default pin layout for property panel and compiler. */
  pinLayout: PinDeclaration[];
  /** Property definitions for the property panel. */
  propertyDefs: PropertyDefinition[];
  /** .dig XML attribute → PropertyBag converters. */
  attributeMap: AttributeMapping[];
  /** Palette grouping. */
  category: ComponentCategory;
  /** Help text displayed to the user. */
  helpText: string;
  /** Structured simulation model container. */
  models: ComponentModels;
  /** Named MNA models keyed by model name (e.g. "behavioral", "ideal"). */
  modelRegistry?: Record<string, ModelEntry>;
  /**
   * Default model key — indexes into `modelRegistry` keys or the implicit
   * `"digital"` key when a digital model exists. When omitted, the first key
   * present in `models` is used. Hidden from the property panel when only one
   * model is available.
   */
  defaultModel?: string;
  /** Bridge adapter electrical specs for digital model pins. */
  pinElectrical?: PinElectricalSpec;
  /** Per-pin overrides for bridge adapter specs. */
  pinElectricalOverrides?: Record<string, PinElectricalSpec>;
  /** Maps digiTS pin label → ngspice node-variable suffix.
   *  Used by the netlist generator and by setup() bodies to reach
   *  ngspice's named view of nodes from digiTS's labelled view.
   *
   *  Examples:
   *    Resistor: { A: "pos", B: "neg" }
   *      → pinNodes.get("A") corresponds to RESposNode
   *    MOSFET:   { G: "gate", D: "drain", S: "source", B: "bulk" }
   *      → pinNodes.get("D") corresponds to MOS1dNode
   *
   *  Sub-element composites (transformer, opamp, ADC, etc.) leave this
   *  field UNDEFINED; the composite's own setup() does not reach into
   *  ngspice — it constructs sub-elements which carry their own
   *  ngspiceNodeMap entries.
   *
   *  Sibling pattern to ParamDef.spiceName which renames param keys for
   *  netlist emission.
   */
  ngspiceNodeMap?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ComponentRegistry
// ---------------------------------------------------------------------------

/**
 * Central registry of all component types.
 *
 * Type IDs are auto-assigned as an incrementing counter starting at 0.
 * Registration order determines type ID order — this is intentional and must
 * remain stable within a session (the IDs are never persisted).
 */
export class ComponentRegistry {
  private readonly _byName: Map<string, ComponentDefinition> = new Map();
  private readonly _byCategory: Map<ComponentCategory, ComponentDefinition[]> = new Map();
  private readonly _aliases: Map<string, string> = new Map();
  private _nextTypeId = 0;

  /**
   * Register a component definition.
   *
   * The caller should pass typeId: -1 (or any sentinel); the registry
   * overwrites it with the next available integer.
   *
   * Throws if a definition with the same name is already registered.
   */
  register(def: ComponentDefinition): void {
    if (this._byName.has(def.name)) {
      throw new Error(`ComponentRegistry: "${def.name}" is already registered`);
    }

    // Auto-inject label, showLabel, showValue for non-exempt components
    if (!LABEL_EXEMPT_TYPES.has(def.name)) {
      def = _injectBaseProperties(def);
    }

    const assigned: ComponentDefinition = { ...def, typeId: this._nextTypeId++ };

    this._byName.set(assigned.name, assigned);

    let categoryList = this._byCategory.get(assigned.category);
    if (categoryList === undefined) {
      categoryList = [];
      this._byCategory.set(assigned.category, categoryList);
    }
    categoryList.push(assigned);
  }

  /**
   * Update an existing component definition, preserving its typeId.
   *
   * Used when a subcircuit .dig file is reloaded or modified. The existing
   * typeId is retained so that compiled models referencing the old typeId
   * remain valid. All other fields are replaced.
   *
   * Throws if the name is not already registered.
   */
  update(def: ComponentDefinition): void {
    const existing = this._byName.get(def.name);
    if (existing === undefined) {
      throw new Error(`ComponentRegistry: "${def.name}" is not registered — use register()`);
    }

    const updated: ComponentDefinition = { ...def, typeId: existing.typeId };
    this._byName.set(updated.name, updated);

    // Update category list entry
    if (existing.category !== updated.category) {
      // Category changed — move between lists
      const oldList = this._byCategory.get(existing.category);
      if (oldList) {
        const idx = oldList.indexOf(existing);
        if (idx >= 0) oldList.splice(idx, 1);
      }
      let newList = this._byCategory.get(updated.category);
      if (!newList) { newList = []; this._byCategory.set(updated.category, newList); }
      newList.push(updated);
    } else {
      const list = this._byCategory.get(updated.category);
      if (list) {
        const idx = list.indexOf(existing);
        if (idx >= 0) list[idx] = updated;
      }
    }
  }

  /**
   * Register a new definition, or update an existing one.
   *
   * Convenience method for subcircuit loading where the caller doesn't know
   * (or care) whether the name was previously registered.
   */
  registerOrUpdate(def: ComponentDefinition): void {
    if (this._byName.has(def.name)) {
      this.update(def);
    } else {
      this.register(def);
    }
  }

  /**
   * Register an alias for an existing canonical component name.
   *
   * When `get(alias)` is called it returns the canonical definition.
   * Aliases do NOT appear in `getByCategory()` or `getAll()` results —
   * they are invisible to the palette and component list.
   *
   * Throws if the canonical name is not already registered, or if the
   * alias name is already registered as a canonical type.
   */
  registerAlias(alias: string, canonicalName: string): void {
    if (this._byName.has(alias)) {
      throw new Error(`ComponentRegistry: cannot register alias "${alias}" — a canonical type with that name already exists`);
    }
    if (!this._byName.has(canonicalName)) {
      throw new Error(`ComponentRegistry: cannot register alias "${alias}" → "${canonicalName}" — canonical type is not registered`);
    }
    this._aliases.set(alias, canonicalName);
  }

  /**
   * Look up a component definition by its type name or alias.
   * Returns undefined when the name is not registered.
   */
  get(name: string): ComponentDefinition | undefined {
    const canonical = this._aliases.get(name);
    if (canonical !== undefined) {
      return this._byName.get(canonical);
    }
    return this._byName.get(name);
  }

  /** Return all registered definitions in registration order. */
  getAll(): ComponentDefinition[] {
    return Array.from(this._byName.values());
  }

  /** Return all definitions in the given category, in registration order. */
  getByCategory(category: ComponentCategory): ComponentDefinition[] {
    return this._byCategory.get(category) ?? [];
  }

  /** Return all definitions that have a simulation model for the given model key.
   * Passing "analog" returns all components with any modelRegistry entry. */
  getWithModel(modelKey: string): ComponentDefinition[] {
    return Array.from(this._byName.values()).filter((d) => {
      if (modelKey === 'analog') {
        return d.modelRegistry !== undefined && Object.keys(d.modelRegistry).length > 0;
      }
      if (modelKey === 'digital') {
        return d.models.digital !== undefined;
      }
      return d.modelRegistry?.[modelKey] !== undefined;
    });
  }

  /**
   * Create an element with a PropertyBag pre-seeded with model param defaults.
   * Callers should use this instead of `def.factory(new PropertyBag())`.
   */
  createElement(name: string): CircuitElement {
    const def = this.get(name);
    if (!def) throw new Error(`ComponentRegistry: "${name}" is not registered`);
    return def.factory(createSeededBag(def));
  }

  /** Total number of registered component types. */
  get size(): number {
    return this._byName.size;
  }
}

// ---------------------------------------------------------------------------
// createSeededBag — PropertyBag with model param defaults from a definition
// ---------------------------------------------------------------------------

/**
 * Create a PropertyBag pre-seeded with model param defaults from the
 * definition's default model entry.
 */
export function createSeededBag(def: ComponentDefinition): PropertyBag {
  const bag = new PropertyBag();
  const entry = def.modelRegistry?.[def.defaultModel ?? ""];
  if (entry?.params) bag.replaceModelParams({ ...entry.params });
  if (def.defaultModel) bag.set("model", def.defaultModel);
  return bag;
}

// ---------------------------------------------------------------------------
// Base property injection — ensures label/showLabel/showValue on all
// non-exempt components without requiring each file to declare them.
// ---------------------------------------------------------------------------

const BASE_LABEL_DEF: PropertyDefinition = {
  key: "label",
  type: PropertyType.STRING,
  label: "Label",
  defaultValue: "",
  description: "Label shown on the component",
};

const BASE_SHOW_LABEL_DEF: PropertyDefinition = {
  key: "showLabel",
  type: PropertyType.BOOLEAN,
  label: "Show label",
  defaultValue: true,
  description: "Whether the label is rendered on the canvas",
};

const BASE_SHOW_VALUE_DEF: PropertyDefinition = {
  key: "showValue",
  type: PropertyType.BOOLEAN,
  label: "Show value",
  defaultValue: true,
  description: "Whether component values are rendered on the canvas",
};

const BASE_LABEL_ATTR: AttributeMapping = {
  xmlName: "Label",
  propertyKey: "label",
  convert: (v) => v,
};

const BASE_SHOW_LABEL_ATTR: AttributeMapping = {
  xmlName: "showLabel",
  propertyKey: "showLabel",
  convert: (v) => v === "true",
};

const BASE_SHOW_VALUE_ATTR: AttributeMapping = {
  xmlName: "showValue",
  propertyKey: "showValue",
  convert: (v) => v === "true",
};

/**
 * Return a copy of `def` with label, showLabel, showValue injected if missing.
 * Existing definitions are preserved — this only fills gaps.
 */
function _injectBaseProperties(def: ComponentDefinition): ComponentDefinition {
  const hasKey = (defs: readonly PropertyDefinition[], key: string) =>
    defs.some((d) => d.key === key);
  const hasAttr = (maps: readonly AttributeMapping[], key: string) =>
    maps.some((m) => m.propertyKey === key);

  let propertyDefs = def.propertyDefs;
  let attributeMap = def.attributeMap;
  let changed = false;

  // Inject label if missing
  if (!hasKey(propertyDefs, "label")) {
    propertyDefs = [...propertyDefs, BASE_LABEL_DEF];
    changed = true;
  }
  if (!hasAttr(attributeMap, "label")) {
    attributeMap = [...attributeMap, BASE_LABEL_ATTR];
    changed = true;
  }

  // Inject showLabel if missing
  if (!hasKey(propertyDefs, "showLabel")) {
    propertyDefs = [...propertyDefs, BASE_SHOW_LABEL_DEF];
    changed = true;
  }
  if (!hasAttr(attributeMap, "showLabel")) {
    attributeMap = [...attributeMap, BASE_SHOW_LABEL_ATTR];
    changed = true;
  }

  // Inject showValue if missing
  if (!hasKey(propertyDefs, "showValue")) {
    propertyDefs = [...propertyDefs, BASE_SHOW_VALUE_DEF];
    changed = true;
  }
  if (!hasAttr(attributeMap, "showValue")) {
    attributeMap = [...attributeMap, BASE_SHOW_VALUE_ATTR];
    changed = true;
  }

  if (!changed) return def;
  return { ...def, propertyDefs, attributeMap };
}
