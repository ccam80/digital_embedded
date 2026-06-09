/**
 * Sub-element parameter value. CLOSED 4-arm union — no other shapes permitted.
 *
 * - `number`: literal scalar (resistance, capacitance, gain, flag-as-0/1).
 * - `string`: lookup key into the enclosing subcircuit's `params` map; the
 *   compiler resolves it to a `number` at netlist-instantiation time.
 * - `{ kind: "ref"; name }`: reference to a peer sub-element by its
 *   `subElementName`. The compiler resolves this to the flattened label string
 *   `${parentLabel}:${name}` and writes it into the regular property partition.
 *   The element's setup() then uses that string with `ctx.findBranch` /
 *   `ctx.findDevice` (the ngspice CKTfndBranch / CKTfndDev analogues) to
 *   resolve a branch index or peer AnalogElement at runtime. Used by CSW
 *   (W-element ctrlBranch), CCCS/CCVS (F/H-element sense source), and MUT
 *   (K-element L1/L2 coupling).
 * - `{ kind: "literal"; value }`: a literal string written verbatim into the
 *   regular property partition (NOT a subcircuit-param lookup). Used to hand a
 *   behavioural B-source its `expression` text; a bare `string` would otherwise
 *   be read as a subcircuit-param reference and dropped.
 *
 * **Flags / booleans MUST be encoded as `0`/`1` numbers**, matching ngspice's
 * `IFvalue.iValue` convention (booleans are ints in the device-param ABI).
 * Passing `boolean` (or any other JS primitive / object shape) is a contract
 * violation and will fail at the type level. Builder functions that hold a
 * boolean must coerce at the netlist boundary: `flag: f ? 1 : 0`.
 */
export type SubcircuitElementParam =
  | number
  | string
  | { kind: "ref"; name: string }
  | { kind: "literal"; value: string };

export interface SubcircuitElement {
  /** Component type (NMOS, PMOS, Resistor, Diode, etc.) */
  typeId: string;
  /** Named .MODEL reference- resolved at compile time. */
  modelRef?: string;
  /** Stable name used by peer-element references (`{ kind: "ref", name }`). */
  subElementName?: string;
  /** Element-level parameter overrides. String values reference subcircuit params by name; `{ kind: "ref" }` values are cross-leaf references. */
  params?: Record<string, SubcircuitElementParam>;
  /** Number of MNA branch rows this element contributes (voltage sources, inductors = 1; MOSFETs, BJTs, resistors = 0). Defaults to 0. */
  branchCount?: number;
}

export interface MnaSubcircuitNetlist {
  /** Port labels in order- maps to outer component pins by label match */
  ports: string[];
  /** Exposed parameters with defaults- user can override at instance level. */
  params?: Record<string, number>;
  /** Sub-elements: topology + model references + per-element parameters */
  elements: SubcircuitElement[];
  /** Number of internal nets (nodes that aren't ports) */
  internalNetCount: number;
  /** Optional debug labels for internal nets. If supplied, length MUST equal `internalNetCount`. */
  internalNetLabels?: string[];
  /** Net connectivity: netlist[elementIndex][pinIndex] → net index.
      Net indices 0..ports.length-1 are external ports.
      Net indices ports.length.. are internal nets. */
  netlist: number[][];
}

/**
 * Build net connectivity arrays from parsed subcircuit node names.
 *
 * Port names are assigned net indices 0..N-1 (in declaration order).
 * Internal node names are assigned sequential indices starting at N.
 * Returns `{ internalNetCount, netlist }` ready for MnaSubcircuitNetlist.
 */
export function buildNetConnectivity(
  ports: string[],
  elementNodes: string[][],
): { internalNetCount: number; netlist: number[][] } {
  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < ports.length; i++) {
    nodeIndex.set(ports[i]!, i);
  }
  let nextNet = ports.length;
  const netlist: number[][] = [];
  for (const nodes of elementNodes) {
    const pinNets: number[] = [];
    for (const nodeName of nodes) {
      let idx = nodeIndex.get(nodeName);
      if (idx === undefined) {
        idx = nextNet++;
        nodeIndex.set(nodeName, idx);
      }
      pinNets.push(idx);
    }
    netlist.push(pinNets);
  }
  return { internalNetCount: nextNet - ports.length, netlist };
}
