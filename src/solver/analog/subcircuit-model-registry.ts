import type { Circuit } from "../../core/circuit.js";

export class SubcircuitModelRegistry {
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
