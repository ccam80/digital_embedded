/**
 * Cycle detector — identifies combinational feedback loops in a circuit.
 *
 * A combinational feedback loop exists when a signal path leads from a
 * component's output back to one of its own inputs without passing through
 * any memory element (flip-flop, latch, RAM). Such loops prevent the circuit
 * from reaching a stable state and cannot be analyzed exhaustively.
 *
 * Algorithm: build a directed graph where nodes are components and edges run
 * from driver components to driven components via shared nets. Run DFS
 * cycle detection. Memory components (flip-flops, latches) are treated as
 * cycle breakers — their inputs do not feed their outputs combinationally.
 *
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import { PinDirection } from '../core/pin.js';

// ---------------------------------------------------------------------------
// CycleInfo — describes one detected cycle
// ---------------------------------------------------------------------------

/**
 * Description of a single detected combinational feedback cycle.
 */
export interface CycleInfo {
  /** Instance IDs of components forming the cycle, in cycle order. */
  componentIds: string[];
  /** Human-readable description of the cycle path. */
  description: string;
}

// ---------------------------------------------------------------------------
// Memory component type names — treated as cycle breakers
// ---------------------------------------------------------------------------

/**
 * Component type names that are memory elements.
 * These break combinational cycles: their inputs do not combinationally
 * drive their outputs within a single propagation step.
 */
const MEMORY_COMPONENT_TYPES = new Set([
  'FlipflopD',
  'FlipflopT',
  'FlipflopRS',
  'FlipflopJK',
  'DLatch',
  'RAM',
  'ROM',
  'Register',
  'Counter',
  'DecoupledDualPortRAM',
]);

// ---------------------------------------------------------------------------
// detectCycles — public API
// ---------------------------------------------------------------------------

/**
 * Detect combinational feedback cycles in a circuit.
 *
 * @param circuit  The circuit to analyse.
 * @returns        Empty array if no cycles found; otherwise one CycleInfo per cycle.
 */
export function detectCycles(circuit: Circuit): CycleInfo[] {
  const elements = circuit.elements;
  if (elements.length === 0) return [];

  // Build net → driver map: position key → element that drives it (has OUTPUT pin there)
  const netDrivers = new Map<string, CircuitElement>();
  // Build net → consumers map: position key → elements that consume it (have INPUT pin there)
  const netConsumers = new Map<string, CircuitElement[]>();

  for (const el of elements) {
    if (isMemoryComponent(el)) continue;

    for (const pin of el.getPins()) {
      const key = posKey(pin.position);
      if (pin.direction === PinDirection.OUTPUT) {
        netDrivers.set(key, el);
      } else if (pin.direction === PinDirection.INPUT) {
        let consumers = netConsumers.get(key);
        if (consumers === undefined) {
          consumers = [];
          netConsumers.set(key, consumers);
        }
        consumers.push(el);
      }
    }
  }

  // Expand net connectivity through wires: build union-find or propagate
  // wire segments to connect pin positions into nets.
  const netId = buildNetMap(circuit, netDrivers, netConsumers);

  // Build adjacency: for each non-memory component, find which net IDs
  // its outputs drive (output net IDs) and which it consumes (input net IDs).
  // Edge: from driver component → consumer component (sharing a net).
  const adjacency = new Map<string, Set<string>>();

  for (const el of elements) {
    if (isMemoryComponent(el)) continue;
    if (!adjacency.has(el.instanceId)) {
      adjacency.set(el.instanceId, new Set());
    }
  }

  for (const el of elements) {
    if (isMemoryComponent(el)) continue;

    for (const pin of el.getPins()) {
      if (pin.direction === PinDirection.OUTPUT) {
        const key = posKey(pin.position);
        const nid = netId.get(key);
        if (nid === undefined) continue;

        // Find all components that consume this net
        const consumers = collectNetConsumers(nid, netId, netConsumers, elements);
        for (const consumer of consumers) {
          adjacency.get(el.instanceId)?.add(consumer.instanceId);
        }
      }
    }
  }

  // DFS cycle detection
  return findCycles(adjacency, elements);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function isMemoryComponent(el: CircuitElement): boolean {
  return MEMORY_COMPONENT_TYPES.has(el.typeId);
}

function posKey(pos: { x: number; y: number }): string {
  return `${pos.x},${pos.y}`;
}

/**
 * Build a map from position key to net ID using union-find over wire segments.
 * Returns: Map<positionKey, netId> where netId is the canonical representative key.
 */
function buildNetMap(
  circuit: Circuit,
  _netDrivers: Map<string, CircuitElement>,
  _netConsumers: Map<string, CircuitElement[]>,
): Map<string, string> {
  // Union-Find parent map
  const parent = new Map<string, string>();

  function find(k: string): string {
    if (!parent.has(k)) parent.set(k, k);
    let root = k;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let cur = k;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Register all pin positions as nodes
  for (const el of circuit.elements) {
    for (const pin of el.getPins()) {
      find(posKey(pin.position));
    }
  }

  // Union wire endpoints
  for (const wire of circuit.wires) {
    const startKey = posKey(wire.start);
    const endKey = posKey(wire.end);
    find(startKey);
    find(endKey);
    union(startKey, endKey);
  }

  // Build result: each registered position maps to its canonical net root
  const netId = new Map<string, string>();
  for (const [k] of parent) {
    netId.set(k, find(k));
  }

  return netId;
}

/**
 * Collect all consumer components that share a given net ID.
 */
function collectNetConsumers(
  nid: string,
  netId: Map<string, string>,
  netConsumers: Map<string, CircuitElement[]>,
  elements: CircuitElement[],
): CircuitElement[] {
  const result: CircuitElement[] = [];

  for (const el of elements) {
    for (const pin of el.getPins()) {
      if (pin.direction === PinDirection.INPUT) {
        const key = posKey(pin.position);
        if (netId.get(key) === nid) {
          result.push(el);
          break;
        }
      }
    }
  }

  return result;
}

/**
 * DFS-based cycle detection on the adjacency graph.
 * Returns CycleInfo for each unique cycle found.
 */
function findCycles(
  adjacency: Map<string, Set<string>>,
  elements: CircuitElement[],
): CycleInfo[] {
  const idToElement = new Map<string, CircuitElement>();
  for (const el of elements) {
    idToElement.set(el.instanceId, el);
  }

  const cycles: CycleInfo[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackPath: string[] = [];

  function dfs(nodeId: string): void {
    if (inStack.has(nodeId)) {
      // Found a cycle — extract the cycle portion of the stack
      const cycleStart = stackPath.indexOf(nodeId);
      const cyclePath = stackPath.slice(cycleStart);
      const componentIds = [...cyclePath, nodeId];

      const description = componentIds
        .map((id) => {
          const el = idToElement.get(id);
          return el ? `${el.typeId}(${id})` : id;
        })
        .join(' → ');

      cycles.push({ componentIds, description });
      return;
    }

    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    inStack.add(nodeId);
    stackPath.push(nodeId);

    const neighbours = adjacency.get(nodeId);
    if (neighbours) {
      for (const neighbour of neighbours) {
        dfs(neighbour);
      }
    }

    stackPath.pop();
    inStack.delete(nodeId);
  }

  for (const nodeId of adjacency.keys()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId);
    }
  }

  return cycles;
}
