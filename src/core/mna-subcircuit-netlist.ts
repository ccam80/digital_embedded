export interface SubcircuitElement {
  /** Component type (NMOS, PMOS, Resistor, Diode, etc.) */
  typeId: string;
  /** Named .MODEL reference — resolved from ModelLibrary at compile time. */
  modelRef?: string;
  /** Element-level parameter overrides. String values reference subcircuit params by name. */
  params?: Record<string, number | string>;
}

export interface MnaSubcircuitNetlist {
  /** Port labels in order — maps to outer component pins by label match */
  ports: string[];
  /** Exposed parameters with defaults — user can override at instance level. */
  params?: Record<string, number>;
  /** Sub-elements: topology + model references + per-element parameters */
  elements: SubcircuitElement[];
  /** Number of internal nets (nodes that aren't ports) */
  internalNetCount: number;
  /** Net connectivity: netlist[elementIndex][pinIndex] → net index.
      Net indices 0..ports.length-1 are external ports.
      Net indices ports.length.. are internal nets. */
  netlist: number[][];
}
