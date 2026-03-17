/**
 * Analog circuit compiler — stub.
 *
 * Delivered in Phase 1. This module exists so that the runner can reference
 * the compile path without a runtime dependency on Phase 1 implementation.
 */

import type { Circuit } from "@/core/circuit";
import type { ComponentRegistry } from "@/core/registry";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";

/**
 * Compile an analog circuit into a `CompiledAnalogCircuit`.
 *
 * Phase 1 (Task 1.2) delivers this implementation. Until then, calling this
 * function throws to make the unimplemented path visible at runtime.
 */
export function compileAnalogCircuit(
  _circuit: Circuit,
  _registry: ComponentRegistry,
): CompiledAnalogCircuit {
  throw new Error("Analog compiler not yet implemented — Phase 1 delivers this");
}
