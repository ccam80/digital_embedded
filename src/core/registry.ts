/**
 * Component registry- one registration shape per component type.
 *
 * Per Decision 4: ComponentDefinition bundles factory, models, pinLayout,
 * propertyDefs, and attributeMap. Type IDs are auto-assigned at registration
 * time (incrementing counter). They are never serialized.
 */

import type { CircuitElement } from "./element.js";
import type { PinDeclaration } from "./pin.js";
import { PropertyBag, PropertyType } from "./properties.js";
import type { PropertyDefinition, PropertyValue } from "./properties.js";
import type { AnalogElement } from "../solver/analog/element.js";
import type { MnaSubcircuitNetlist } from "./mna-subcircuit-netlist.js";
import type { PinElectricalSpec } from "./pin-electrical.js";

// ---------------------------------------------------------------------------
// AnalogFactory- named factory signature for MNA element construction
// ---------------------------------------------------------------------------

export type AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElement;

// ---------------------------------------------------------------------------
// ParamDef- schema entry for one model parameter
// ---------------------------------------------------------------------------

export interface ParamDef {
  key: string;
  /**
   * UI / SPICE type. Required for params that surface in the property panel
   * or get emitted on a `.model` card. Optional for internal-only definitions
   * whose params are never rendered or emitted (they only feed `createSeededBag`).
   */
  type?: PropertyType;
  /** Display label. Optional for internal-only definitions (no UI surface). */
  label?: string;
  unit?: string;
  description?: string;
  /** Property-panel rank. Optional for internal-only definitions. */
  rank?: "primary" | "secondary";
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
   * the digiTS key- the rename only applies at the netlist boundary.
   */
  spiceName?: string;
  /**
   * Emission style. `"key-value"` (default)- `KEY=value`. `"flag"`- bare
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
  /**
   * Optional value transform applied at SPICE netlist emission only. Use when
   * the digiTS internal unit differs from ngspice's expected netlist unit.
   * Example: TEMP/TNOM are stored in Kelvin in digiTS but ngspice's parser
   * adds CONSTCtoK (273.15), so they must be emitted in Celsius- the
   * converter is `v => v - 273.15`. Storage and `getModelParam` are
   * unaffected.
   */
  spiceConverter?: (value: number) => number;
}

/** SPICE-emission overrides for a ModelEntry. */
export interface ModelEmissionSpec {
  /**
   * Constant tokens prepended to the .model card body, in order, ahead of
   * any paramDefs-derived params. Use for static SPICE attributes that
   * are not exposed as digiTS model params (e.g. `LEVEL=3` for a future
   * SPICE-L3 tunnel-diode ModelEntry- not used by any component in this
   * cleanup; see ngspice-netlist-generator-architecture.md ss3.7a).
   */
  modelCardPrefix?: readonly string[];
}

// ---------------------------------------------------------------------------
// ModelEntry- unified model type (inline factory or netlist-derived)
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
      netlist: MnaSubcircuitNetlist | ((params: PropertyBag) => MnaSubcircuitNetlist);
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
// AttributeMapping- .dig XML attribute → PropertyBag entry
// ---------------------------------------------------------------------------

/**
 * Maps one XML attribute key from a .dig file to a PropertyBag entry.
 *
 * Per Decision 5: Components only see PropertyBag. The parser reads the
 * registry's attributeMap and applies converters mechanically- it never
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
// ComponentLayout- wiring info for a component instance in the engine
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
   * Required by all engines- analog engines use it for live slider updates,
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
// ExecuteFunction- flat simulation function type
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
// ComponentModels- structured simulation model container
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
// ComponentDefinition (base + extender)
// ---------------------------------------------------------------------------

/**
 * Base registration record for one component type.
 *
 * Carries the fields the registry stores and the compiler / SPICE emitter /
 * harness consume. Any internal-only sub-element (behavioural driver,
 * transmission-line segment, digital-pin leaf, etc.) registers as this base
 * shape with `internalOnly: true`. User-facing components extend this base
 * via `StandaloneComponentDefinition` to add the editor / property-panel /
 * .dig-XML / digital-engine fields.
 *
 * Three downstream effects of `internalOnly: true`:
 *   1. Editor palette excludes it (palette-builder filters via getAllStandalone).
 *   2. SPICE-import target selection cannot reach it. Two paths exist and both
 *      are structurally safe:
 *      - UI dialog (openSpiceImportDialog / applySpiceImportResult): the caller
 *        pre-selects the target element from the palette, so effect #1 above
 *        already excludes internalOnly defs.
 *      - SUBCKT body parsing (src/io/spice-model-builder.ts): maps SPICE
 *        prefix letters (R/L/C/V/I/Q/M/D/J) to digiTS typeIds via a hardcoded
 *        switch covering only user-facing primitives. Does not iterate the
 *        registry, so an internalOnly typeId can never be picked.
 *   3. harness_describe groups it under its parent composite's label.
 */
export interface ComponentDefinition {
  /** Type name. For user-facing components matches the .dig elementName
   *  (e.g. "And", "FlipflopD"). For internal-only sub-elements the name is
   *  the registry lookup key referenced by `SubcircuitElement.typeId` in
   *  parent netlists (e.g. "BehavioralAndDriver"). */
  name: string;
  /**
   * Numeric type ID auto-assigned by ComponentRegistry.register().
   * Not serialized. Used only at runtime for function-table dispatch.
   * Set to -1 in the object passed to register(); the registry replaces it.
   */
  typeId: number;
  /** When true, this definition is an internal-only sub-element. Excluded
   *  from the editor palette, SPICE-import primary matching, and surfaced
   *  under its parent in harness_describe. Defaults to false / absent. */
  internalOnly?: boolean;
  /** Named MNA models keyed by model name (e.g. "behavioral", "ideal"). */
  modelRegistry?: Record<string, ModelEntry>;
  /**
   * Default model key- indexes into `modelRegistry` keys or the implicit
   * `"digital"` key when a digital model exists. When omitted, the first key
   * present in `models` is used. Hidden from the property panel when only one
   * model is available.
   */
  defaultModel?: string;
  /** Optional pin labels in netlist-connectivity-row order. Required for
   *  user-facing components (narrowed in StandaloneComponentDefinition).
   *  Optional for internal-only sub-elements- some drivers (e.g.
   *  BehavioralDFlipflopDriver) need explicit pin labels to map netlist
   *  connectivity rows to `_pinNodes` entries during expansion; others
   *  (pure stamp leaves) omit it.
   *
   *  For drivers whose pin set varies per instance (gates with N inputs,
   *  counters/registers with N output bits, etc.) use `pinLayoutFactory`
   *  instead. If both are present `pinLayoutFactory` wins. */
  pinLayout?: PinDeclaration[];
  /** Per-instance pin-layout builder for variable-shape internal-only
   *  sub-elements (Template A-variable). Invoked by the compiler with the
   *  sub-element's resolved `PropertyBag` at expansion time, before pin-node
   *  binding. Mutually exclusive with `pinLayout`; if both are present this
   *  factory wins. Standalone components express variable shape on the
   *  element class via `getPins()`, not here. */
  pinLayoutFactory?: (props: PropertyBag) => PinDeclaration[];
  /** Maps digiTS pin label → ngspice node-variable suffix.
   *  See doc on StandaloneComponentDefinition for the full contract. */
  ngspiceNodeMap?: Record<string, string>;
}

/**
 * Resolve a definition's effective pin layout for a given instance. Prefers
 * `pinLayoutFactory(props)` when present, otherwise falls back to the static
 * `pinLayout`, otherwise an empty array (pure-stamp leaves with no pins).
 *
 * Compiler / harness sites that need to walk pin labels for an instance MUST
 * call this helper instead of reading `def.pinLayout` directly, so that
 * variable-shape drivers expand correctly.
 */
export function resolvePinLayout(
  def: ComponentDefinition,
  props: PropertyBag,
): readonly PinDeclaration[] {
  if (def.pinLayoutFactory) return def.pinLayoutFactory(props);
  return def.pinLayout ?? [];
}

/**
 * Registration record for a user-facing component type. All UI / editor /
 * property-panel surfaces consume this shape via `getStandalone()` /
 * `getAllStandalone()` / `getByCategory()`.
 */
export interface StandaloneComponentDefinition extends ComponentDefinition {
  /** Explicitly not internal-only (or absent). */
  internalOnly?: false;
  /** Construct a CircuitElement for a placed instance from its properties. */
  factory: (props: PropertyBag) => CircuitElement;
  /** Default pin layout for property panel and compiler- required for
   *  user-facing components. */
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
  /** Bridge adapter electrical specs for digital model pins. */
  pinElectrical?: PinElectricalSpec;
  /** Per-pin overrides for bridge adapter specs. */
  pinElectricalOverrides?: Record<string, PinElectricalSpec>;
}

/** Type guard: narrows a definition to the user-facing extender. */
export function isStandalone(def: ComponentDefinition): def is StandaloneComponentDefinition {
  return def.internalOnly !== true;
}

// ---------------------------------------------------------------------------
// ComponentRegistry
// ---------------------------------------------------------------------------

/**
 * Central registry of all component types.
 *
 * Type IDs are auto-assigned as an incrementing counter starting at 0.
 * Registration order determines type ID order- this is intentional and must
 * remain stable within a session (the IDs are never persisted).
 */
export class ComponentRegistry {
  private readonly _byName: Map<string, ComponentDefinition> = new Map();
  // Category index only tracks user-facing definitions (palette / property panel).
  private readonly _byCategory: Map<ComponentCategory, StandaloneComponentDefinition[]> = new Map();
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
  register(def: ComponentDefinition | StandaloneComponentDefinition): void {
    if (this._byName.has(def.name)) {
      throw new Error(`ComponentRegistry: "${def.name}" is already registered`);
    }

    // Auto-inject label/showLabel/showValue only for user-facing definitions.
    // Internal-only sub-elements have no property panel surface to inject into.
    if (isStandalone(def) && !LABEL_EXEMPT_TYPES.has(def.name)) {
      def = _injectBaseProperties(def);
    }

    const assigned: ComponentDefinition = { ...def, typeId: this._nextTypeId++ };

    this._byName.set(assigned.name, assigned);

    // Category index is only meaningful for user-facing definitions
    // (internal-only never surfaces in the palette).
    if (isStandalone(assigned)) {
      let categoryList = this._byCategory.get(assigned.category);
      if (categoryList === undefined) {
        categoryList = [];
        this._byCategory.set(assigned.category, categoryList);
      }
      categoryList.push(assigned);
    }
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
  update(def: ComponentDefinition | StandaloneComponentDefinition): void {
    const existing = this._byName.get(def.name);
    if (existing === undefined) {
      throw new Error(`ComponentRegistry: "${def.name}" is not registered- use register()`);
    }

    const updated: ComponentDefinition = { ...def, typeId: existing.typeId };
    this._byName.set(updated.name, updated);

    // Category index: only user-facing definitions appear in the palette.
    // Maintain it across the four transitions (standalone↔standalone,
    // standalone↔internal, internal↔internal).
    if (isStandalone(existing)) {
      const oldList = this._byCategory.get(existing.category);
      if (oldList) {
        const idx = oldList.indexOf(existing);
        if (idx >= 0) oldList.splice(idx, 1);
      }
    }
    if (isStandalone(updated)) {
      let newList = this._byCategory.get(updated.category);
      if (!newList) { newList = []; this._byCategory.set(updated.category, newList); }
      newList.push(updated);
    }
  }

  /**
   * Register a new definition, or update an existing one.
   *
   * Convenience method for subcircuit loading where the caller doesn't know
   * (or care) whether the name is already registered.
   */
  registerOrUpdate(def: ComponentDefinition | StandaloneComponentDefinition): void {
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
   * Aliases do NOT appear in `getByCategory()` or `getAll()` results-
   * they are invisible to the palette and component list.
   *
   * Throws if the canonical name is not already registered, or if the
   * alias name is already registered as a canonical type.
   */
  registerAlias(alias: string, canonicalName: string): void {
    if (this._byName.has(alias)) {
      throw new Error(`ComponentRegistry: cannot register alias "${alias}"- a canonical type with that name already exists`);
    }
    if (!this._byName.has(canonicalName)) {
      throw new Error(`ComponentRegistry: cannot register alias "${alias}" → "${canonicalName}"- canonical type is not registered`);
    }
    this._aliases.set(alias, canonicalName);
  }

  /**
   * Look up a component definition by its type name or alias.
   * Returns undefined when the name is not registered.
   *
   * Returns the base `ComponentDefinition`- callers that need standalone
   * fields (factory, propertyDefs, category, etc.) should use
   * `getStandalone()` instead, or narrow with `isStandalone()`.
   */
  get(name: string): ComponentDefinition | undefined {
    const canonical = this._aliases.get(name);
    if (canonical !== undefined) {
      return this._byName.get(canonical);
    }
    return this._byName.get(name);
  }

  /**
   * Look up a user-facing component definition by name or alias.
   * Returns undefined when the name is not registered or refers to an
   * internal-only sub-element.
   *
   * Use this from UI / palette / property-panel / .dig-XML / digital-engine
   * call sites that access standalone-only fields.
   */
  getStandalone(name: string): StandaloneComponentDefinition | undefined {
    const def = this.get(name);
    return def !== undefined && isStandalone(def) ? def : undefined;
  }

  /** Return all registered definitions in registration order, including
   *  internal-only sub-elements. Use from compiler / SPICE / harness paths
   *  that need every registered type. */
  getAll(): ComponentDefinition[] {
    return Array.from(this._byName.values());
  }

  /** Return all user-facing definitions in registration order. Internal-only
   *  sub-elements are excluded. Use from UI / palette / iteration sites that
   *  access standalone-only fields. */
  getAllStandalone(): StandaloneComponentDefinition[] {
    const out: StandaloneComponentDefinition[] = [];
    for (const def of this._byName.values()) {
      if (isStandalone(def)) out.push(def);
    }
    return out;
  }

  /** Return all user-facing definitions in the given category, in registration
   *  order. Internal-only definitions never appear in any category. */
  getByCategory(category: ComponentCategory): StandaloneComponentDefinition[] {
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
        // Internal-only definitions have no `models` container; treat as
        // having no digital model.
        return isStandalone(d) && d.models.digital !== undefined;
      }
      return d.modelRegistry?.[modelKey] !== undefined;
    });
  }

  /**
   * Create an element with a PropertyBag pre-seeded with model param defaults.
   * Callers should use this instead of `def.factory(new PropertyBag())`.
   *
   * Internal-only definitions have no `factory` (they exist solely as
   * sub-elements inside parent netlists) and throw if called here.
   */
  createElement(name: string): CircuitElement {
    const def = this.get(name);
    if (!def) throw new Error(`ComponentRegistry: "${name}" is not registered`);
    if (!isStandalone(def)) {
      throw new Error(`ComponentRegistry: "${name}" is internal-only and cannot be instantiated as a top-level element`);
    }
    return def.factory(createSeededBag(def));
  }

  /** Total number of registered component types. */
  get size(): number {
    return this._byName.size;
  }
}

// ---------------------------------------------------------------------------
// createSeededBag- PropertyBag with model param defaults from a definition
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
// Base property injection- ensures label/showLabel/showValue on all
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
 * Existing definitions are preserved- this only fills gaps. Internal-only
 * definitions are never passed in (caller in `register()` narrows first).
 */
function _injectBaseProperties(def: StandaloneComponentDefinition): StandaloneComponentDefinition {
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
