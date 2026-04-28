/**
 * Shared registry builder functions for use in tests.
 *
 * Eliminates ~40 repeated inline buildRegistry/makeRegistry functions
 * across the test suite.
 */

import { ComponentRegistry, ComponentCategory } from "../core/registry.js";
import type { ComponentDefinition, ExecuteFunction } from "../core/registry.js";
import { PropertyBag } from "../core/properties.js";
import { TestElement } from "./test-element.js";
import { noopExecFn } from "./execute-stubs.js";

// ---------------------------------------------------------------------------
// Component config types
// ---------------------------------------------------------------------------

/**
 * Minimal config for a digital-only component in a test registry.
 */
export interface DigitalComponentConfig {
  /** Component type name, e.g. "And", "In", "Out". */
  name: string;
  /** Execute function. Defaults to noopExecFn. */
  executeFn?: ExecuteFunction;
  /** Category. Defaults to ComponentCategory.MISC. */
  category?: ComponentCategory;
}

/**
 * Minimal config for an analog-only component in a test registry.
 */
export interface AnalogComponentConfig {
  /** Component type name, e.g. "Resistor", "Ground". */
  name: string;
  /** Default model key. Defaults to "behavioral". */
  defaultModel?: string;
  /** Category. Defaults to ComponentCategory.PASSIVES. */
  category?: ComponentCategory;
}

/**
 * Config for a component with both digital and analog models.
 */
export interface MixedComponentConfig {
  /** Component type name. */
  name: string;
  /** Execute function for digital model. Defaults to noopExecFn. */
  executeFn?: ExecuteFunction;
  /** Default model key for analog. Defaults to "behavioral". */
  defaultModel?: string;
  /** Category. Defaults to ComponentCategory.MISC. */
  category?: ComponentCategory;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeNoopAnalogFactory(pinNodes: ReadonlyMap<string, number>) {
  return {
    label: "",
    ngspiceLoadOrder: 0,
    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1 as const,
    setup: (_ctx: unknown) => {},
    load: (_ctx: unknown) => {},
    getPinCurrents: () => [] as number[],
    setParam: (_key: string, _value: number) => {},
  };
}

function makeDigitalDef(config: DigitalComponentConfig): Omit<ComponentDefinition, "typeId"> & { typeId: -1 } {
  return {
    name: config.name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement(config.name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: config.category ?? ComponentCategory.MISC,
    helpText: config.name,
    models: {
      digital: { executeFn: config.executeFn ?? noopExecFn },
    },
  };
}

function makeAnalogDef(config: AnalogComponentConfig): Omit<ComponentDefinition, "typeId"> & { typeId: -1 } {
  const modelKey = config.defaultModel ?? "behavioral";
  return {
    name: config.name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement(config.name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: config.category ?? ComponentCategory.PASSIVES,
    helpText: config.name,
    defaultModel: modelKey,
    models: {},
    modelRegistry: {
      [modelKey]: {
        kind: "inline" as const,
        factory: (pinNodes: ReadonlyMap<string, number>) => makeNoopAnalogFactory(pinNodes),
        paramDefs: [],
        params: {},
      },
    },
  };
}

function makeMixedDef(config: MixedComponentConfig): Omit<ComponentDefinition, "typeId"> & { typeId: -1 } {
  const modelKey = config.defaultModel ?? "behavioral";
  return {
    name: config.name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement(config.name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: config.category ?? ComponentCategory.MISC,
    helpText: config.name,
    defaultModel: modelKey,
    models: {
      digital: { executeFn: config.executeFn ?? noopExecFn },
    },
    modelRegistry: {
      [modelKey]: {
        kind: "inline" as const,
        factory: (pinNodes: ReadonlyMap<string, number>) => makeNoopAnalogFactory(pinNodes),
        paramDefs: [],
        params: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public builder functions
// ---------------------------------------------------------------------------

/**
 * Create a ComponentRegistry containing only digital components.
 *
 * @param components List of component configs. Each gets a digital model only.
 */
export function buildDigitalRegistry(
  components: DigitalComponentConfig[],
): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const config of components) {
    registry.register(makeDigitalDef(config) as ComponentDefinition);
  }
  return registry;
}

/**
 * Create a ComponentRegistry containing only analog components.
 *
 * @param components List of component configs. Each gets a modelRegistry entry only.
 */
export function buildAnalogRegistry(
  components: AnalogComponentConfig[],
): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const config of components) {
    registry.register(makeAnalogDef(config) as ComponentDefinition);
  }
  return registry;
}

/**
 * Create a ComponentRegistry with mixed analog+digital components.
 *
 * @param components List of component configs. Each gets both digital and analog models.
 */
export function buildMixedRegistry(
  components: MixedComponentConfig[],
): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const config of components) {
    registry.register(makeMixedDef(config) as ComponentDefinition);
  }
  return registry;
}

/**
 * Convenience: build a digital registry from a plain list of type names.
 * All components get noopExecFn and ComponentCategory.MISC.
 */
export function buildDigitalRegistryFromNames(names: string[]): ComponentRegistry {
  return buildDigitalRegistry(names.map((name) => ({ name })));
}
