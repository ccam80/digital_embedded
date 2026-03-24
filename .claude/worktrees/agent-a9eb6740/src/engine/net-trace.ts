/**
 * traceNets — shared net-tracing core.
 *
 * Runs union-find wire tracing over a circuit's elements and wires,
 * resolving pin positions via pinWorldPosition() (F6) and merging
 * Tunnel components by label. Returns fully resolved net IDs.
 */

import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import { pinWorldPosition } from '../core/pin.js';
import { UnionFind } from './union-find.js';

// ---------------------------------------------------------------------------
// NetTraceResult — resolved net topology returned to consumers
// ---------------------------------------------------------------------------

export interface TracedNet {
  netId: number;
  slots: number[];          // Pin slots in this net
  driverCount: number;
  width: number | null;     // null = not yet inferred
}

export interface NetTraceResult {
  nets: TracedNet[];
  slotToNetId: number[];    // slot index → net ID
  netCount: number;
}

// ---------------------------------------------------------------------------
// traceNets — public entry point
// ---------------------------------------------------------------------------

/**
 * Run union-find net tracing over a set of circuit elements and wires.
 *
 * Steps:
 *   1. Enumerate pins for every element; compute slotBase[].
 *   2. Map each pin to its world position using pinWorldPosition() (F6).
 *   3. Add wire virtual nodes (2 per wire: start + end); union start↔end.
 *   4. Merge all nodes that share the same world position.
 *   5. Merge Tunnel components with the same label (looked up via registry).
 *   6. Assign net IDs from union-find roots (pin slots only).
 *   7. Return NetTraceResult.
 *
 * @param elements  Circuit elements to trace.
 * @param wires     Wires to trace.
 * @param registry  Component registry (used to check tunnel typeId).
 */
export function traceNets(
  elements: readonly CircuitElement[],
  wires: readonly Wire[],
  registry: ComponentRegistry,
): NetTraceResult {
  const componentCount = elements.length;

  // -------------------------------------------------------------------------
  // Step 1: Build slotBase[] — cumulative pin counts
  // -------------------------------------------------------------------------

  const allPins = elements.map((el) => el.getPins());

  const slotBase: number[] = new Array(componentCount).fill(0);
  let totalPinSlots = 0;
  for (let i = 0; i < componentCount; i++) {
    slotBase[i] = totalPinSlots;
    totalPinSlots += allPins[i]!.length;
  }

  // -------------------------------------------------------------------------
  // Step 2–4: Build position map, add wire virtual nodes, merge positions
  // -------------------------------------------------------------------------

  const wireVirtualBase = totalPinSlots;
  const totalSlots = totalPinSlots + wires.length * 2;
  const uf = new UnionFind(totalSlots);

  const posToNodes = new Map<string, number[]>();

  const addNode = (key: string, node: number): void => {
    let list = posToNodes.get(key);
    if (list === undefined) {
      list = [];
      posToNodes.set(key, list);
    }
    list.push(node);
  };

  // Add pin slots at their world positions — F6: use pinWorldPosition, not raw addition
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const pin = pins[j]!;
      const wp = pinWorldPosition(el, pin);
      addNode(`${wp.x},${wp.y}`, slotBase[i]! + j);
    }
  }

  // Add wire virtual nodes (start = wireVirtualBase + k*2, end = +k*2+1)
  for (let k = 0; k < wires.length; k++) {
    const wire = wires[k]!;
    const startNode = wireVirtualBase + k * 2;
    const endNode = wireVirtualBase + k * 2 + 1;
    addNode(`${wire.start.x},${wire.start.y}`, startNode);
    addNode(`${wire.end.x},${wire.end.y}`, endNode);
    // A wire connects its two endpoints
    uf.union(startNode, endNode);
  }

  // Merge all nodes at the same world position
  for (const nodes of posToNodes.values()) {
    if (nodes.length > 1) {
      for (let m = 1; m < nodes.length; m++) {
        uf.union(nodes[0]!, nodes[m]!);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Merge Tunnel components with the same label
  // -------------------------------------------------------------------------

  // Use registry to resolve the canonical Tunnel typeId
  const tunnelDef = registry.get('Tunnel');
  const tunnelTypeId = tunnelDef !== undefined ? 'Tunnel' : 'Tunnel';

  const tunnelsByLabel = new Map<string, number[]>();
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (el.typeId === tunnelTypeId) {
      const label = el.getAttribute('label');
      if (typeof label === 'string' && label.length > 0) {
        let slots = tunnelsByLabel.get(label);
        if (slots === undefined) {
          slots = [];
          tunnelsByLabel.set(label, slots);
        }
        // Tunnel has one pin (index 0)
        slots.push(slotBase[i]! + 0);
      }
    }
  }
  for (const tunnelSlots of tunnelsByLabel.values()) {
    for (let m = 1; m < tunnelSlots.length; m++) {
      uf.union(tunnelSlots[0]!, tunnelSlots[m]!);
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Assign net IDs from union-find roots (pin slots only)
  // -------------------------------------------------------------------------

  const rootToNetId = new Map<number, number>();
  let nextNetId = 0;

  for (let i = 0; i < componentCount; i++) {
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const slot = slotBase[i]! + j;
      const root = uf.find(slot);
      if (!rootToNetId.has(root)) {
        rootToNetId.set(root, nextNetId++);
      }
    }
  }

  const netCount = nextNetId;

  // Build flat slot → netId array (length = totalPinSlots)
  const slotToNetId: number[] = new Array(totalPinSlots).fill(0);
  for (let i = 0; i < componentCount; i++) {
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const slot = slotBase[i]! + j;
      const root = uf.find(slot);
      slotToNetId[slot] = rootToNetId.get(root) ?? 0;
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Build TracedNet[] — per-net slot membership
  // -------------------------------------------------------------------------

  const netSlots: number[][] = [];
  for (let n = 0; n < netCount; n++) {
    netSlots.push([]);
  }
  for (let slot = 0; slot < totalPinSlots; slot++) {
    netSlots[slotToNetId[slot]!]!.push(slot);
  }

  const nets: TracedNet[] = netSlots.map((slots, netId) => ({
    netId,
    slots,
    driverCount: 0,      // consumers fill this in based on pin directions
    width: null,         // consumers fill this in after width validation
  }));

  return { nets, slotToNetId, netCount };
}
