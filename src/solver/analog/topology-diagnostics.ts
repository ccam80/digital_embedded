import type { Diagnostic } from "../../compile/types.js";
import type { AnalogElement } from "./element.js";
import { makeDiagnostic } from "./diagnostics.js";

export interface TopologyEntry {
  nodeIds: number[];
  isBranch: boolean;
  typeHint: "inductor" | "voltage" | "other";
  label: string;
}

export function buildTopologyInfo(elements: readonly AnalogElement[]): TopologyEntry[] {
  const result: TopologyEntry[] = [];
  for (const el of elements) {
    const nodeIds = [...el._pinNodes.values()];
    const isBranch = el.branchIndex !== -1;
    let typeHint: "inductor" | "voltage" | "other";
    if (isBranch && typeof el.getLteTimestep === "function") {
      typeHint = "inductor";
    } else if (isBranch) {
      typeHint = "voltage";
    } else {
      typeHint = "other";
    }
    const label = el.label !== "" ? el.label : "<unnamed>";
    result.push({ nodeIds, isBranch, typeHint, label });
  }
  return result;
}

export function runCompileTimeDetectors(
  topology: readonly TopologyEntry[],
  totalNodeCount: number,
  emit: (d: Diagnostic) => void,
): void {
  if (totalNodeCount === 0) return;
  const weak = detectWeakNodes(topology, totalNodeCount);
  for (const nodeId of weak.orphan) {
    emit(makeDiagnostic(
      "orphan-node",
      "error",
      `Node ${nodeId} is orphan (no element terminals connected)`,
      {
        explanation:
          `MNA node ${nodeId} has no element terminals connected to it. ` +
          `This typically results from a degenerate wire (zero-length or ` +
          `disconnected from all components). The orphan node creates a ` +
          `zero row in the MNA matrix, making it singular.`,
        involvedNodes: [nodeId],
        suggestions: [{
          text: "Remove the disconnected wire or wire fragment at this location.",
          automatable: false,
        }],
      },
    ));
  }
  for (const nodeId of weak.floating) {
    emit(makeDiagnostic(
      "floating-node",
      "warning",
      `Node ${nodeId} is floating (connected to only one element terminal)`,
      {
        explanation:
          `MNA node ${nodeId} has only one element terminal connected to it. ` +
          `A floating node has no complete current path, which makes the ` +
          `MNA system ill-conditioned or unsolvable.`,
        involvedNodes: [nodeId],
        suggestions: [{
          text: "Add a large resistor (e.g. 1 Gohm) from this node to ground to provide a DC path.",
          automatable: false,
        }],
      },
    ));
  }
}

export function runPostSetupDetectors(
  topology: readonly TopologyEntry[],
  emit: (d: Diagnostic) => void,
): void {
  if (detectVoltageSourceLoops(topology)) {
    emit(makeDiagnostic(
      "voltage-source-loop",
      "error",
      "Voltage source loop detected- two or more voltage sources form a loop with no resistance",
      {
        explanation:
          "A loop of ideal voltage sources with no resistive elements creates " +
          "contradictory KVL constraints. The MNA matrix will be singular and " +
          "cannot be solved. Add a series resistance to break the loop.",
        suggestions: [{
          text: "Add a small series resistance (e.g. 1 mohm) to one of the voltage source branches.",
          automatable: false,
        }],
      },
    ));
  }
  if (detectInductorLoops(topology)) {
    emit(makeDiagnostic(
      "inductor-loop",
      "error",
      "Inductor loop detected- inductors form a loop with no resistance",
      {
        explanation:
          "A loop of ideal inductors with no resistive elements creates a " +
          "degenerate branch equation system. The MNA matrix will be singular " +
          "at DC and during transient initialization. Add series resistance.",
        suggestions: [{
          text: "Add a small series resistance (e.g. 1 mohm) to one of the inductor branches.",
          automatable: false,
        }],
      },
    ));
  }
  for (const [comp1, comp2] of detectCompetingVoltageConstraints(topology)) {
    emit(makeDiagnostic(
      "competing-voltage-constraints",
      "error",
      `Two competing voltage sources are driving the net that connects to ${comp1}, ${comp2}- the circuit design needs to be fixed`,
      {
        explanation:
          `Both "${comp1}" and "${comp2}" impose a voltage constraint (branch equation) ` +
          `on the same MNA node. Two ideal voltage sources cannot drive the same net- ` +
          `this makes the MNA matrix singular and prevents the solver from converging.`,
        suggestions: [{
          text: `Remove one of the voltage sources (${comp1} or ${comp2}) driving the shared net, or insert a series resistor between them.`,
          automatable: false,
        }],
      },
    ));
  }
}

/**
 * Detect poorly-connected nodes by counting element terminals per node.
 *
 * Returns two lists:
 * - `orphan`: nodes with **zero** element terminals- completely disconnected
 *   from any component. These make the MNA matrix singular (error).
 * - `floating`: nodes with exactly **one** element terminal- no current path.
 *   These make the system ill-conditioned (warning).
 */
function detectWeakNodes(
  elements: readonly TopologyEntry[],
  nodeCount: number,
): { orphan: number[]; floating: number[] } {
  // Count how many element terminals touch each node (excluding ground = 0).
  const terminalCount = new Array<number>(nodeCount + 1).fill(0);
  for (const el of elements) {
    for (const n of el.nodeIds) {
      if (n >= 0 && n <= nodeCount) {
        terminalCount[n]++;
      }
    }
  }
  const orphan: number[] = [];
  const floating: number[] = [];
  for (let n = 1; n <= nodeCount; n++) {
    if (terminalCount[n] === 0) {
      orphan.push(n);
    } else if (terminalCount[n] === 1) {
      floating.push(n);
    }
  }
  return { orphan, floating };
}

/**
 * Detect voltage-source loops: cycles consisting only of voltage sources.
 *
 * A loop of ideal voltage sources (with no resistors in between) creates a
 * contradictory constraint system that makes the MNA matrix singular. We
 * detect this by building a graph of voltage-source connections and looking
 * for cycles within that graph.
 */
function detectVoltageSourceLoops(
  elements: readonly TopologyEntry[],
): boolean {
  // Build adjacency for voltage-source-only graph
  const vSources = elements.filter((e) => e.isBranch && e.typeHint === "voltage");
  if (vSources.length < 2) return false;

  // Build adjacency list: node → set of reachable nodes through voltage sources
  const adj = new Map<number, Set<number>>();
  for (const vs of vSources) {
    const [a, b] = vs.nodeIds;
    if (a < 0 || b < 0) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  // DFS cycle detection
  const visited = new Set<number>();
  function hasCycle(node: number, parent: number): boolean {
    visited.add(node);
    const neighbors = adj.get(node) ?? new Set<number>();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, node)) return true;
      } else if (neighbor !== parent) {
        return true;
      }
    }
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (hasCycle(node, -1)) return true;
    }
  }
  return false;
}

/**
 * Detect inductor loops: cycles consisting only of inductors.
 *
 * A loop of ideal inductors creates a singular MNA system (degenerate branch
 * equations) at DC and during transient initialization.
 */
function detectInductorLoops(
  elements: readonly TopologyEntry[],
): boolean {
  const inductors = elements.filter((e) => e.isBranch && e.typeHint === "inductor");
  if (inductors.length < 2) return false;

  const adj = new Map<number, Set<number>>();
  for (const ind of inductors) {
    const [a, b] = ind.nodeIds;
    if (a < 0 || b < 0) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  const visited = new Set<number>();
  function hasCycle(node: number, parent: number): boolean {
    visited.add(node);
    const neighbors = adj.get(node) ?? new Set<number>();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, node)) return true;
      } else if (neighbor !== parent) {
        return true;
      }
    }
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (hasCycle(node, -1)) return true;
    }
  }
  return false;
}

/**
 * Detect nets driven by two or more voltage-source branch equations.
 *
 * Returns pairs of component labels that compete on the same node.
 * Each pair represents one conflict: two components that both impose
 * a voltage constraint on the same MNA node.
 */
function detectCompetingVoltageConstraints(
  elements: readonly TopologyEntry[],
): Array<[string, string]> {
  const vSources = elements.filter((e) => e.isBranch && e.typeHint === "voltage");
  if (vSources.length < 2) return [];

  // Map from node ID → list of component labels that drive that node via a branch equation
  const nodeDrivers = new Map<number, string[]>();
  for (const vs of vSources) {
    for (const nodeId of vs.nodeIds) {
      if (nodeId <= 0) continue;
      let drivers = nodeDrivers.get(nodeId);
      if (!drivers) { drivers = []; nodeDrivers.set(nodeId, drivers); }
      if (!drivers.includes(vs.label)) drivers.push(vs.label);
    }
  }

  const conflicts: Array<[string, string]> = [];
  const reportedPairs = new Set<string>();
  for (const drivers of nodeDrivers.values()) {
    if (drivers.length < 2) continue;
    for (let i = 0; i < drivers.length - 1; i++) {
      for (let j = i + 1; j < drivers.length; j++) {
        const key = `${drivers[i]!}|${drivers[j]!}`;
        if (!reportedPairs.has(key)) {
          reportedPairs.add(key);
          conflicts.push([drivers[i]!, drivers[j]!]);
        }
      }
    }
  }
  return conflicts;
}
