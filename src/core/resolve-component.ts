/**
 * Unified component definition resolution.
 *
 * Checks circuit-scoped subcircuit definitions first, then falls back to the
 * global ComponentRegistry (built-in types only). This eliminates the need to
 * register subcircuit definitions into the global registry for element creation.
 */

import type { Circuit } from "./circuit.js";
import type { ComponentDefinition, ComponentRegistry } from "./registry.js";
import { buildSubcircuitComponentDef } from "../components/subcircuit/subcircuit.js";

/**
 * Resolve a component type name to its ComponentDefinition.
 *
 * Resolution order:
 *  1. Circuit-scoped subcircuit definitions (circuit.metadata.subcircuits)
 *  2. Global registry (built-in component types)
 *
 * Handles both bare names ("HalfAdder") and prefixed names ("Subcircuit:HalfAdder").
 */
export function resolveComponentDef(
  typeName: string,
  circuit: Circuit | null,
  registry: ComponentRegistry,
): ComponentDefinition | undefined {
  if (circuit?.metadata.subcircuits) {
    const lookupName = typeName.startsWith("Subcircuit:")
      ? typeName.slice(11)
      : typeName;
    const subDef = circuit.metadata.subcircuits.get(lookupName);
    if (subDef !== undefined) {
      return buildSubcircuitComponentDef(lookupName, subDef);
    }
  }
  return registry.get(typeName);
}
