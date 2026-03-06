/**
 * Delay resolution for timed simulation mode.
 *
 * Per-component propagation delays are resolved in a three-level priority:
 *   1. Instance property "delay" (set on the component in the circuit editor)
 *   2. ComponentDefinition.defaultDelay (set when the type is registered)
 *   3. DEFAULT_GATE_DELAY (10ns global fallback)
 *
 * The resulting flat Uint32Array is indexed by component slot index and
 * consumed by the engine's timed-mode scheduling logic.
 *
 * Java reference: de.neemann.digital.core.Model (gate delay scheduling)
 */

import type { ComponentRegistry } from "@/core/registry";
import type { CompiledCircuitImpl } from "./compiled-circuit.js";

/** Global fallback gate delay in nanoseconds. */
export const DEFAULT_GATE_DELAY = 10;

/**
 * Build a flat delay array indexed by component index.
 *
 * Resolution order per component:
 *   1. Instance property "delay" (number) on the component's CircuitElement
 *   2. ComponentDefinition.defaultDelay from the registry
 *   3. DEFAULT_GATE_DELAY (10ns)
 *
 * @param compiled  Compiled circuit with componentToElement map.
 * @param registry  Component registry providing ComponentDefinition records.
 * @returns         Uint32Array of delays, one entry per component.
 */
export function resolveDelays(
  compiled: CompiledCircuitImpl,
  registry: ComponentRegistry,
): Uint32Array {
  const delays = new Uint32Array(compiled.componentCount);

  for (let i = 0; i < compiled.componentCount; i++) {
    const element = compiled.componentToElement.get(i);

    if (element !== undefined) {
      // Priority 1: instance-level override
      const instanceDelay = element.getAttribute("delay");
      if (typeof instanceDelay === "number") {
        delays[i] = instanceDelay;
        continue;
      }

      // Priority 2: definition-level default
      const def = registry.get(element.typeId);
      if (def !== undefined && typeof def.defaultDelay === "number") {
        delays[i] = def.defaultDelay;
        continue;
      }
    }

    // Priority 3: global fallback
    delays[i] = DEFAULT_GATE_DELAY;
  }

  return delays;
}
