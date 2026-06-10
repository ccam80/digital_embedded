import type { Diagnostic } from "../../compile/types.js";
import type { AnalogElement } from "./element.js";
import { makeDiagnostic } from "./diagnostics.js";

export interface TopologyEntry {
  /** All pin nodes of the element. Used for connectivity (weak-node) counting. */
  nodeIds: number[];
  /**
   * For a branch element, the nodes its branch row actually constrains — the
   * KCL current-injection terminals (e.g. a VCVS's out+/out-, not its sense
   * ctrl pins; a DAC driver's OUT/GND, not its VREF sense pin). Undefined when
   * the branch's terminal incidence is unavailable (compile-time, pre-setup).
   * Source/loop detection keys on this, falling back to `nodeIds`.
   */
  branchNodeIds?: number[] | undefined;
  isBranch: boolean;
  typeHint: "inductor" | "voltage" | "other";
  label: string;
}

/**
 * @param branchTerminals  Map of branchIndex → constrained terminal nodes (the
 *   KCL incidence of that branch column from the solver). When supplied, a
 *   branch element's `branchNodeIds` is set from it so the voltage/inductor/
 *   competing detectors reason about the real driven terminals rather than
 *   every pin (which falsely implicates sense/control pins).
 */
export function buildTopologyInfo(
  elements: readonly AnalogElement[],
  branchTerminals?: ReadonlyMap<number, number[]>,
): TopologyEntry[] {
  const result: TopologyEntry[] = [];
  for (const el of elements) {
    const nodeIds = [...el.pinNodes.values()];
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
    const branchNodeIds = isBranch ? branchTerminals?.get(el.branchIndex) : undefined;
    result.push({
      nodeIds,
      ...(branchNodeIds !== undefined ? { branchNodeIds } : {}),
      isBranch,
      typeHint,
      label,
    });
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

  // Build adjacency list: node â†’ set of reachable nodes through voltage sources
  const adj = new Map<number, Set<number>>();
  for (const vs of vSources) {
    const [a, b] = vs.branchNodeIds ?? vs.nodeIds;
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
    const [a, b] = ind.branchNodeIds ?? ind.nodeIds;
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
 * Detect ideal voltage sources connected in parallel- two or more branch
 * equations constraining the *same* pair of nodes. Parallel ideal voltage
 * sources impose redundant/contradictory rows on the identical node set,
 * making the MNA matrix singular.
 *
 * Two sources that share only *one* node are a valid series stack (e.g. a
 * digital output pin's `vLowRail` + `eDrive`, or any reference chain), not a
 * conflict- so grouping is by the full terminal-node SET, not per-node. Loops
 * of voltage sources are a separate singularity handled by
 * `detectVoltageSourceLoops`.
 *
 * Each terminal set is the branch's KCL current-injection nodes (`branchNodeIds`,
 * which excludes ground and sense pins); ground is never a driven terminal.
 *
 * Returns pairs of component labels that share an identical terminal set.
 */
function detectCompetingVoltageConstraints(
  elements: readonly TopologyEntry[],
): Array<[string, string]> {
  const vSources = elements.filter((e) => e.isBranch && e.typeHint === "voltage");
  if (vSources.length < 2) return [];

  // Group sources by their constrained terminal-node set (sorted, ground-free).
  // Sources sharing an identical set are in parallel → singular.
  const byTerminalSet = new Map<string, string[]>();
  for (const vs of vSources) {
    const nodes = [...new Set((vs.branchNodeIds ?? vs.nodeIds).filter((n) => n > 0))].sort((a, b) => a - b);
    if (nodes.length === 0) continue; // fully grounded / degenerate- not a drive
    const key = nodes.join(",");
    let labels = byTerminalSet.get(key);
    if (!labels) { labels = []; byTerminalSet.set(key, labels); }
    if (!labels.includes(vs.label)) labels.push(vs.label);
  }

  const conflicts: Array<[string, string]> = [];
  const reportedPairs = new Set<string>();
  for (const labels of byTerminalSet.values()) {
    if (labels.length < 2) continue;
    for (let i = 0; i < labels.length - 1; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const key = `${labels[i]!}|${labels[j]!}`;
        if (!reportedPairs.has(key)) {
          reportedPairs.add(key);
          conflicts.push([labels[i]!, labels[j]!]);
        }
      }
    }
  }
  return conflicts;
}
