import type { AnalogElement } from "./element.js";
import type { PropertyBag } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// AnalogElementFactory- type alias used by ComponentDefinition
// ---------------------------------------------------------------------------

/**
 * Factory function signature for analog element creation.
 *
 * Called by the analog compiler for each component instance.
 *   pinNodes- label → MNA node ID map, one entry per pin in pinLayout order.
 */
export type AnalogElementFactory = (
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElement;
