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
 * inputOffset(index) and outputOffset(index) return the flat Uint32Array
 * index at which a given component's nth input/output net begins.
 */
export interface ComponentLayout {
  /** Number of input pins for component at the given index. */
  inputCount(componentIndex: number): number;
  /** Starting index in the signal array for component's inputs. */
  inputOffset(componentIndex: number): number;
  /** Number of output pins for component at the given index. */
  outputCount(componentIndex: number): number;
  /** Starting index in the signal array for component's outputs. */
  outputOffset(componentIndex: number): number;
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
 * @param index     Component slot index within the compiled model.
 * @param state     Signal value array owned by the engine.
 * @param layout    Wiring descriptor providing input/output offsets.
 */
export type ExecuteFunction = (
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
) => void;

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
  /** Flat simulation function called by the engine's inner loop. */
  executeFn: ExecuteFunction;
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
   * Default propagation delay in nanoseconds for timed simulation mode.
   * Individual component instances can override via a "delay" property.
   * Defaults to 10ns when not specified.
   */
  defaultDelay?: number;
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

  /** Total number of registered component types. */
  get size(): number {
    return this._byName.size;
  }
}
