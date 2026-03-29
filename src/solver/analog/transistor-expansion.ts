/**
 * Analog factory registry — maps typeId strings to inline analog factories.
 *
 * Leaf analog components (MOSFETs, BJTs, resistors, etc.) register their
 * factory functions here so that the composite factory path
 * (`compileSubcircuitToMnaModel` in compiler.ts) can instantiate them when
 * compiling MnaSubcircuitNetlist definitions into MnaModel factories.
 */

import type { AnalogElementCore } from "./element.js";
import { PropertyBag } from "../../core/properties.js";

type AnalogFactory = (
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElementCore;

// Known analog component type IDs and their factories.
// This map is populated by registerAnalogFactory() calls from component modules.
const _analogFactoryRegistry = new Map<string, AnalogFactory>();

/**
 * Register an analog factory for a component typeId.
 * Called by component modules during initialization.
 */
export function registerAnalogFactory(typeId: string, factory: AnalogFactory): void {
  _analogFactoryRegistry.set(typeId, factory);
}

/**
 * Look up an analog factory by typeId. Returns undefined for unknown types.
 */
export function getAnalogFactory(typeId: string): AnalogFactory | undefined {
  return _analogFactoryRegistry.get(typeId);
}
