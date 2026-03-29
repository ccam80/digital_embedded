import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";

export class SubcircuitModelRegistry {
  private readonly models = new Map<string, MnaSubcircuitNetlist>();

  register(name: string, netlist: MnaSubcircuitNetlist): void {
    this.models.set(name, netlist);
  }

  get(name: string): MnaSubcircuitNetlist | undefined {
    return this.models.get(name);
  }

  has(name: string): boolean {
    return this.models.has(name);
  }
}
