/**
 * TransistorModelRegistry — stores transistor model subcircuits by name.
 *
 * Separate from ComponentRegistry (which stores ComponentDefinition objects).
 * Populated by registerAllCmosGateModels(modelRegistry) in Phase 4c.2.
 */

import type { Circuit } from "../../core/circuit.js";

export class TransistorModelRegistry {
  private readonly models = new Map<string, Circuit>();

  register(name: string, circuit: Circuit): void {
    this.models.set(name, circuit);
  }

  get(name: string): Circuit | undefined {
    return this.models.get(name);
  }

  has(name: string): boolean {
    return this.models.has(name);
  }
}
