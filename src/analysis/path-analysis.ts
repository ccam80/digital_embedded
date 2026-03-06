/**
 * Critical path analysis for combinational circuits.
 *
 * Computes the longest propagation delay path through the circuit by
 * performing a topological traversal of the component DAG and accumulating
 * delays along each path.
 *
 * The delay of each component is taken from the `defaultDelay` field of its
 * ComponentDefinition in the registry. If the definition is not found (e.g.
 * for stub components not in the registry), a default of 10 ns is assumed.
 *
 * Port of Digital's ModelAnalyser.calcMaxPathLen().
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import { PinDirection } from '../core/pin.js';
import type { ComponentRegistry } from '../core/registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CriticalPath {
  /** Total delay along the critical path in nanoseconds. */
  pathLength: number;
  /** Component names (typeId or label) on the critical path, in topological order. */
  components: string[];
  /** Number of gate elements on the critical path (excludes In and Out components). */
  gateCount: number;
}

// ---------------------------------------------------------------------------
// Default delay constant
// ---------------------------------------------------------------------------

const DEFAULT_DELAY_NS = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the critical (longest propagation delay) path through a combinational
 * circuit.
 *
 * @param circuit   The circuit to analyse.
 * @param registry  Component registry providing defaultDelay per component type.
 * @returns         Critical path descriptor.
 */
export function findCriticalPath(circuit: Circuit, registry: ComponentRegistry): CriticalPath {
  if (circuit.elements.length === 0) {
    return { pathLength: 0, components: [], gateCount: 0 };
  }

  // Build adjacency: for each element, which elements does it drive?
  // We determine connectivity by pin proximity: an output pin of element A
  // at position P is connected to an element B that has an input pin at P,
  // OR via a wire that connects them.
  const adjacency = buildAdjacency(circuit);

  // Delay map: elementInstanceId → delay in ns
  const delayMap = buildDelayMap(circuit, registry);

  // Compute the longest path from any source element to any sink element
  // using topological DP.
  return longestPath(circuit.elements, adjacency, delayMap, registry);
}

// ---------------------------------------------------------------------------
// Adjacency building
// ---------------------------------------------------------------------------

/**
 * Build an adjacency list: for each element, the set of elements it drives.
 *
 * Connectivity is determined by matching pin world-space positions through
 * the wire segments. Two elements are connected if there is a wire path
 * between an output pin of one and an input pin of another.
 */
function buildAdjacency(circuit: Circuit): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const el of circuit.elements) {
    adj.set(el.instanceId, new Set());
  }

  // Build a map: point (x,y) → elements with input/output pins at that point
  const outputPinMap = new Map<string, string[]>(); // point → instanceIds with output pin
  const inputPinMap = new Map<string, string[]>();  // point → instanceIds with input pin

  for (const el of circuit.elements) {
    for (const pin of el.getPins()) {
      const key = pointKey(el.position.x + pin.position.x, el.position.y + pin.position.y);
      if (pin.direction === PinDirection.OUTPUT) {
        let list = outputPinMap.get(key);
        if (list === undefined) { list = []; outputPinMap.set(key, list); }
        list.push(el.instanceId);
      } else if (pin.direction === PinDirection.INPUT) {
        let list = inputPinMap.get(key);
        if (list === undefined) { list = []; inputPinMap.set(key, list); }
        list.push(el.instanceId);
      }
    }
  }

  // Build a wire graph: endpoints of wires that connect points
  // We do a union-find so we can group all points connected by wires.
  const pointGroups = buildWireGroups(circuit, outputPinMap, inputPinMap);

  // For each group, find all output-pin elements and all input-pin elements,
  // then create edges: output elements → input elements
  for (const group of pointGroups.values()) {
    const outputEls = new Set<string>();
    const inputEls = new Set<string>();

    for (const pt of group) {
      for (const id of (outputPinMap.get(pt) ?? [])) outputEls.add(id);
      for (const id of (inputPinMap.get(pt) ?? [])) inputEls.add(id);
    }

    for (const src of outputEls) {
      const edges = adj.get(src)!;
      for (const dst of inputEls) {
        if (src !== dst) edges.add(dst);
      }
    }
  }

  return adj;
}

/**
 * Group all circuit points into connectivity clusters using wire segments.
 * Returns a map from canonical point → set of all connected points.
 */
function buildWireGroups(
  circuit: Circuit,
  outputPinMap: Map<string, string[]>,
  inputPinMap: Map<string, string[]>,
): Map<string, Set<string>> {
  // Union-Find (path compression)
  const parent = new Map<string, string>();

  function find(key: string): string {
    let root = parent.get(key) ?? key;
    if (root !== key) {
      root = find(root);
      parent.set(key, root);
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Seed all known points (from pins)
  for (const key of outputPinMap.keys()) find(key);
  for (const key of inputPinMap.keys()) find(key);

  // Union wire endpoints
  for (const wire of circuit.wires) {
    const a = pointKey(wire.start.x, wire.start.y);
    const b = pointKey(wire.end.x, wire.end.y);
    union(a, b);
  }

  // Build result: root → set of all points in that group
  const groups = new Map<string, Set<string>>();

  const allPoints = new Set<string>([
    ...outputPinMap.keys(),
    ...inputPinMap.keys(),
  ]);

  for (const pt of allPoints) {
    const root = find(pt);
    let group = groups.get(root);
    if (group === undefined) { group = new Set(); groups.set(root, group); }
    group.add(pt);
  }

  return groups;
}

function pointKey(x: number, y: number): string {
  return `${x},${y}`;
}

// ---------------------------------------------------------------------------
// Delay map
// ---------------------------------------------------------------------------

function buildDelayMap(circuit: Circuit, registry: ComponentRegistry): Map<string, number> {
  const map = new Map<string, number>();
  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    const delay = def?.defaultDelay ?? DEFAULT_DELAY_NS;
    map.set(el.instanceId, delay);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Longest path via topological DP
// ---------------------------------------------------------------------------

interface PathState {
  totalDelay: number;
  path: string[]; // sequence of instanceIds
}

function longestPath(
  elements: CircuitElement[],
  adjacency: Map<string, Set<string>>,
  delayMap: Map<string, number>,
  _registry: ComponentRegistry,
): CriticalPath {
  const idToEl = new Map<string, CircuitElement>();
  for (const el of elements) idToEl.set(el.instanceId, el);

  // Compute in-degree for topological sort
  const inDegree = new Map<string, number>();
  for (const el of elements) inDegree.set(el.instanceId, 0);

  for (const [_src, dsts] of adjacency) {
    for (const dst of dsts) {
      inDegree.set(dst, (inDegree.get(dst) ?? 0) + 1);
    }
  }

  // Kahn's algorithm for topological ordering
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // Best path state arriving at each node
  const best = new Map<string, PathState>();
  for (const el of elements) {
    best.set(el.instanceId, { totalDelay: 0, path: [] });
  }

  const topoOrder: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);

    const myDelay = delayMap.get(id) ?? DEFAULT_DELAY_NS;
    const incoming = best.get(id)!;
    const newDelay = incoming.totalDelay + myDelay;
    const newPath = [...incoming.path, id];

    for (const dst of (adjacency.get(id) ?? [])) {
      const dstState = best.get(dst)!;
      if (newDelay > dstState.totalDelay) {
        best.set(dst, { totalDelay: newDelay, path: newPath });
      }

      const deg = (inDegree.get(dst) ?? 0) - 1;
      inDegree.set(dst, deg);
      if (deg === 0) queue.push(dst);
    }
  }

  // Find the element with the maximum accumulated delay
  let maxDelay = 0;
  let bestPath: string[] = [];

  for (const el of elements) {
    const state = best.get(el.instanceId)!;
    const myDelay = delayMap.get(el.instanceId) ?? DEFAULT_DELAY_NS;
    const total = state.totalDelay + myDelay;
    const fullPath = [...state.path, el.instanceId];

    if (total > maxDelay) {
      maxDelay = total;
      bestPath = fullPath;
    }
  }

  // Convert instanceIds to component names and count gates
  const componentNames: string[] = [];
  let gateCount = 0;

  for (const id of bestPath) {
    const el = idToEl.get(id)!;
    // Use label if set, otherwise typeId
    const props = el.getProperties();
    const label = props.has('label') ? props.get<string>('label') : '';
    const name = label.length > 0 ? label : el.typeId;
    componentNames.push(name);

    // Count non-IO components as gates
    if (el.typeId !== 'In' && el.typeId !== 'Out') {
      gateCount++;
    }
  }

  return {
    pathLength: maxDelay,
    components: componentNames,
    gateCount,
  };
}
