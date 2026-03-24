/**
 * Circuit statistics — summary metrics for a placed circuit.
 *
 * Computes:
 *   - Component counts by type (typeId → count)
 *   - Total gate count (non-IO, non-subcircuit component count)
 *   - Total wire count (number of Wire segments)
 *   - Total net count (number of distinct connected wire groups)
 *   - Input count (number of In components)
 *   - Output count (number of Out components)
 *   - Subcircuit count (number of elements with category SUBCIRCUIT)
 *   - Circuit depth (longest path in gate count, not delay)
 */

import type { Circuit } from '../core/circuit.js';
import { PinDirection } from '../core/pin.js';
import type { ComponentRegistry } from '../core/registry.js';
import { ComponentCategory } from '../core/registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CircuitStatistics {
  /** Count of each component type: typeId → count. */
  componentCounts: ReadonlyMap<string, number>;
  /** Total number of gate-class components (non-IO). */
  totalGateCount: number;
  /** Total number of Wire segments in the circuit. */
  wireCount: number;
  /** Total number of electrically distinct nets. */
  netCount: number;
  /** Number of In components. */
  inputCount: number;
  /** Number of Out components. */
  outputCount: number;
  /** Number of subcircuit components (not expanded). */
  subcircuitCount: number;
  /** Longest path through the circuit measured in gate count. */
  circuitDepth: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute summary statistics for a circuit.
 *
 * @param circuit   The circuit to analyse.
 * @param registry  Component registry for category lookup.
 * @returns         Statistics summary.
 */
export function computeStatistics(circuit: Circuit, registry: ComponentRegistry): CircuitStatistics {
  // Component counts by typeId
  const componentCounts = new Map<string, number>();
  let inputCount = 0;
  let outputCount = 0;
  let subcircuitCount = 0;
  let totalGateCount = 0;

  for (const el of circuit.elements) {
    const prev = componentCounts.get(el.typeId) ?? 0;
    componentCounts.set(el.typeId, prev + 1);

    if (el.typeId === 'In') {
      inputCount++;
    } else if (el.typeId === 'Out') {
      outputCount++;
    } else {
      const def = registry.get(el.typeId);
      if (def?.category === ComponentCategory.SUBCIRCUIT) {
        subcircuitCount++;
      } else {
        totalGateCount++;
      }
    }
  }

  const wireCount = circuit.wires.length;

  // Net count: number of distinct wire-connected groups
  const netCount = computeNetCount(circuit);

  // Circuit depth: longest path in gate count
  const circuitDepth = computeCircuitDepth(circuit, registry);

  return {
    componentCounts,
    totalGateCount,
    wireCount,
    netCount,
    inputCount,
    outputCount,
    subcircuitCount,
    circuitDepth,
  };
}

// ---------------------------------------------------------------------------
// Net count (union-find over wire-connected points)
// ---------------------------------------------------------------------------

function computeNetCount(circuit: Circuit): number {
  if (circuit.wires.length === 0) return 0;

  const parent = new Map<string, string>();

  function key(x: number, y: number): string {
    return `${x},${y}`;
  }

  function find(k: string): string {
    let root = parent.get(k) ?? k;
    if (root !== k) {
      root = find(root);
      parent.set(k, root);
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const wire of circuit.wires) {
    const a = key(wire.start.x, wire.start.y);
    const b = key(wire.end.x, wire.end.y);
    union(a, b);
  }

  // Count distinct roots
  const roots = new Set<string>();
  for (const k of parent.keys()) {
    roots.add(find(k));
  }

  // Also account for isolated points that were unioned via find
  const allPoints = new Set<string>();
  for (const wire of circuit.wires) {
    allPoints.add(key(wire.start.x, wire.start.y));
    allPoints.add(key(wire.end.x, wire.end.y));
  }

  const distinctRoots = new Set<string>();
  for (const pt of allPoints) {
    distinctRoots.add(find(pt));
  }

  return distinctRoots.size;
}

// ---------------------------------------------------------------------------
// Circuit depth (longest path in gate count)
// ---------------------------------------------------------------------------

function computeCircuitDepth(circuit: Circuit, registry: ComponentRegistry): number {
  if (circuit.elements.length === 0) return 0;

  // Build adjacency from pin positions and wires (same approach as path-analysis)
  const outputPinMap = new Map<string, string[]>();
  const inputPinMap = new Map<string, string[]>();

  function ptKey(x: number, y: number): string { return `${x},${y}`; }

  for (const el of circuit.elements) {
    for (const pin of el.getPins()) {
      const k = ptKey(el.position.x + pin.position.x, el.position.y + pin.position.y);
      if (pin.direction === PinDirection.OUTPUT) {
        let list = outputPinMap.get(k);
        if (!list) { list = []; outputPinMap.set(k, list); }
        list.push(el.instanceId);
      } else if (pin.direction === PinDirection.INPUT) {
        let list = inputPinMap.get(k);
        if (!list) { list = []; inputPinMap.set(k, list); }
        list.push(el.instanceId);
      }
    }
  }

  // Union-find for wire groups
  const parent = new Map<string, string>();
  function find(k: string): string {
    let root = parent.get(k) ?? k;
    if (root !== k) { root = find(root); parent.set(k, root); }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const wire of circuit.wires) {
    union(ptKey(wire.start.x, wire.start.y), ptKey(wire.end.x, wire.end.y));
  }

  // Build groups: root → all points in group
  const allPts = new Set<string>([...outputPinMap.keys(), ...inputPinMap.keys()]);
  const groups = new Map<string, Set<string>>();
  for (const pt of allPts) {
    const root = find(pt);
    let grp = groups.get(root);
    if (!grp) { grp = new Set(); groups.set(root, grp); }
    grp.add(pt);
  }

  // Build adjacency: src → dst element IDs
  const adj = new Map<string, Set<string>>();
  for (const el of circuit.elements) adj.set(el.instanceId, new Set());

  for (const grp of groups.values()) {
    const outEls = new Set<string>();
    const inEls = new Set<string>();
    for (const pt of grp) {
      for (const id of (outputPinMap.get(pt) ?? [])) outEls.add(id);
      for (const id of (inputPinMap.get(pt) ?? [])) inEls.add(id);
    }
    for (const src of outEls) {
      const edges = adj.get(src)!;
      for (const dst of inEls) { if (src !== dst) edges.add(dst); }
    }
  }

  // Gate cost: 0 for In/Out, 1 for all other types
  function isGate(typeId: string): boolean {
    if (typeId === 'In' || typeId === 'Out') return false;
    const def = registry.get(typeId);
    return def?.category !== ComponentCategory.IO;
  }

  // Topological DP for longest gate-count path
  const inDegree = new Map<string, number>();
  for (const el of circuit.elements) inDegree.set(el.instanceId, 0);
  for (const [_src, dsts] of adj) {
    for (const dst of dsts) inDegree.set(dst, (inDegree.get(dst) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);

  const depth = new Map<string, number>();
  for (const el of circuit.elements) depth.set(el.instanceId, 0);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const el = circuit.elements.find((e) => e.instanceId === id)!;
    const myDepth = (depth.get(id) ?? 0) + (isGate(el.typeId) ? 1 : 0);

    for (const dst of (adj.get(id) ?? [])) {
      if (myDepth > (depth.get(dst) ?? 0)) depth.set(dst, myDepth);
      const deg = (inDegree.get(dst) ?? 0) - 1;
      inDegree.set(dst, deg);
      if (deg === 0) queue.push(dst);
    }
  }

  let maxDepth = 0;
  for (const d of depth.values()) if (d > maxDepth) maxDepth = d;
  return maxDepth;
}
