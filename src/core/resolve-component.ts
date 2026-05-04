/**
 * Unified component definition resolution.
 *
 * Checks circuit-scoped subcircuit definitions first, then falls back to the
 * global ComponentRegistry (built-in types only). This eliminates the need to
 * register subcircuit definitions into the global registry for element creation.
 */

import type { Circuit } from "./circuit.js";
import type { ComponentRegistry, StandaloneComponentDefinition } from "./registry.js";
import { buildSubcircuitComponentDef } from "../components/subcircuit/subcircuit.js";

/**
 * Resolve a component type name to its StandaloneComponentDefinition.
 *
 * Resolution order:
 *  1. Circuit-scoped subcircuit definitions (circuit.metadata.subcircuits)
 *  2. Global registry user-facing definitions (built-in component types)
 *
 * Handles both bare names ("HalfAdder") and prefixed names ("Subcircuit:HalfAdder").
 *
 * Internal-only sub-elements (behavioural drivers, transmission-line segments,
 * etc.) are excluded- they exist only inside parent composite netlists and are
 * never resolved as top-level circuit elements.
 */
export function resolveComponentDef(
  typeName: string,
  circuit: Circuit | null,
  registry: ComponentRegistry,
): StandaloneComponentDefinition | undefined {
  if (circuit?.metadata.subcircuits) {
    const lookupName = typeName.startsWith("Subcircuit:")
      ? typeName.slice(11)
      : typeName;
    const subDef = circuit.metadata.subcircuits.get(lookupName);
    if (subDef !== undefined) {
      return buildSubcircuitComponentDef(lookupName, subDef);
    }
  }
  return registry.getStandalone(typeName);
}
