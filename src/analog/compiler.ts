import type { Circuit } from "@/core/circuit";
import type { ComponentRegistry } from "@/core/registry";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";

/** Compile an analog circuit into a `CompiledAnalogCircuit`. */
export function compileAnalogCircuit(
  _circuit: Circuit,
  _registry: ComponentRegistry,
): CompiledAnalogCircuit {
  throw new Error("Analog compiler not yet implemented — Phase 1 delivers this");
}
