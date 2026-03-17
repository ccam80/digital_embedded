/**
 * Component registry — one registration shape per component type.
 *
 * Per Decision 4: ComponentDefinition bundles factory, executeFn, pinLayout,
 * propertyDefs, and attributeMap. Type IDs are auto-assigned at registration
 * time (incrementing counter). They are never serialized.
 */

import type { CircuitElement } from "./element.js";
import type { PinDeclaration } from "./pin.js";
import type { PropertyBag, PropertyDefinition, PropertyValue } from "./properties.js";
import type { AnalogElement } from "../analog/element.js";

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

/**
 * No-op ExecuteFunction for pure-analog components.
 * Pure analog components have no digital simulation behavior.
 */
export const noOpAnalogExecuteFn: ExecuteFunction = () => {};

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
  /** Engine type this component targets. Defaults to "digital" when omitted. */
  engineType?: "digital" | "analog" | "both";
  /**
   * Numeric type ID auto-assigned by ComponentRegistry.register().
   * Not serialized. Used only at runtime for function-table dispatch.
   * Set to -1 in the object passed to register(); the registry replaces it.
   */
  typeId: number;
  /** Construct a CircuitElement for a placed instance from its properties. */
  factory: (props: PropertyBag) => CircuitElement;
  /** Flat simulation function called by the engine's inner loop. */
  executeFn: ExecuteFunction;
  /**
   * Sequential components provide `sampleFn` to latch inputs on clock edges.
   * Called before the combinational sweep. Combinational components leave
   * this undefined.
   */
  sampleFn?: ExecuteFunction;
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
  /**
   * Number of persistent state slots this component type requires.
   * Static number for most components; function of properties for components
   * whose state size depends on configuration (RAM, register-file, EEPROM).
   * Defaults to 0 (combinational, no state).
   */
  stateSlotCount?: number | ((props: PropertyBag) => number);
  /**
   * Default propagation delay in nanoseconds for timed simulation mode.
   * Individual component instances can override via a "delay" property.
   * Defaults to 10ns when not specified.
   */
  defaultDelay?: number;
  /**
   * For switch components, identifies the two pin indices that form the
   * switchable connection (e.g. drain/source for FETs, A/B for TransGate).
   * Only switch components set this field.
   */
  switchPins?: [number, number];
  /**
   * Factory for creating analog element instances during MNA compilation.
   *
   * Called by the analog compiler (Phase 1) for each component instance.
   * `nodeIds` is the ordered list of MNA node IDs connected to this component's
   * pins. `branchIdx` is the MNA branch-current row index (-1 if
   * `requiresBranchRow` is false). `getTime` returns the current simulation
   * time in seconds and is used by time-dependent sources.
   *
   * Not set on digital-only components. Does not affect existing registrations.
   */
  analogFactory?: (
    nodeIds: number[],
    branchIdx: number,
    props: PropertyBag,
    getTime: () => number,
  ) => AnalogElement;
  /**
   * When `true`, the analog compiler assigns an MNA branch-current row index
   * to this component before calling `analogFactory`. Used by voltage sources
   * and inductors which require an extra row in the MNA matrix.
   *
   * Defaults to `false` when not set.
   */
  requiresBranchRow?: boolean;
  /**
   * Returns the number of internal MNA nodes this component requires.
   *
   * Called by the analog compiler before matrix allocation so the total node
   * count (and therefore matrix size) is known before any stamps are applied.
   * Used by components with variable internal topology, such as transmission
   * lines with configurable segment counts.
   *
   * Defaults to 0 when not implemented.
   */
  getInternalNodeCount?: (props: PropertyBag) => number;
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
   * Look up a component definition by its type name.
   * Returns undefined when the name is not registered.
   */
  get(name: string): ComponentDefinition | undefined {
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

  /** Return all definitions matching the given engine type, in registration order. */
  getByEngineType(engineType: "digital" | "analog"): ComponentDefinition[] {
    return Array.from(this._byName.values()).filter((d) => {
      const et = d.engineType ?? "digital";
      return et === engineType || et === "both";
    });
  }

  /** Total number of registered component types. */
  get size(): number {
    return this._byName.size;
  }
}
