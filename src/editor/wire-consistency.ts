/**
 * Wire consistency checking- validates new wires against circuit rules.
 *
 * Primary check: no two output pins connected to the same net without a bus
 * driver. This detects shorted outputs before they are committed to the circuit.
 */

import type { Circuit } from "@/core/circuit";
import { Wire } from "@/core/circuit";
import { PinDirection, pinWorldPosition } from "@/core/pin";
import type { Pin } from "@/core/pin";
import type { CircuitElement } from "@/core/element";
import { FacadeError } from "@/headless/types";

/**
 * Validate that the new wires do not create illegal connections.
 *
 * Returns a FacadeError describing the violation, or undefined if the wires
 * are consistent with the circuit.
 *
 * Current checks:
 *   - No two output pins connected to the same net (shorted outputs).
 */
export function checkWireConsistency(
  circuit: Circuit,
  newWires: Wire[],
  analogTypeIds?: ReadonlySet<string>,
): FacadeError | undefined {
  // Build the combined wire list (existing + new)
  const allWires = [...circuit.wires, ...newWires];

  // Build adjacency: for each point, which other points are connected via wires
  const connected = buildConnectivityMap(allWires);

  // Find all pins in the circuit
  const pins = collectPins(circuit.elements);

  // For each output pin, find all other pins on the same net
  // If any net has two or more output pins, that is a short
  const visited = new Set<string>();

  for (const { element, pin } of pins) {
    if (pin.direction !== PinDirection.OUTPUT) {
      continue;
    }
    // Analog components legitimately share nets via their output terminals
    if (analogTypeIds?.has(element.typeId)) {
      continue;
    }

    const wp = pinWorldPosition(element, pin);
    const pinKey = pointKey(wp.x, wp.y);

    if (visited.has(pinKey)) {
      continue;
    }

    // BFS/DFS to find all pins connected to this output pin's net
    const netPoints = floodFill(pinKey, connected);
    const outputPinsOnNet: { element: CircuitElement; pin: Pin }[] = [];

    for (const pt of netPoints) {
      visited.add(pt);
    }

    // Check which element pins land on points in this net
    for (const candidate of pins) {
      const candidateWp = pinWorldPosition(candidate.element, candidate.pin);
      const candidateKey = pointKey(candidateWp.x, candidateWp.y);
      if (netPoints.has(candidateKey) && candidate.pin.direction === PinDirection.OUTPUT
          && !analogTypeIds?.has(candidate.element.typeId)) {
        outputPinsOnNet.push(candidate);
      }
    }

    if (outputPinsOnNet.length >= 2) {
      const names = outputPinsOnNet.map((p) => `${p.element.typeId}.${p.pin.label}`).join(", ");
      return new FacadeError(
        `Shorted outputs: two or more output pins are connected to the same net (${names}). ` +
          `Use a bus driver to resolve multiple drivers.`,
        undefined,
        undefined,
        circuit.metadata.name,
        { shortedPins: names },
      );
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function pointKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Build a map from each wire endpoint to all endpoints it is directly
 * connected to via a single wire.
 */
function buildConnectivityMap(wires: Wire[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();

  function link(a: string, b: string): void {
    if (!map.has(a)) {
      map.set(a, new Set());
    }
    if (!map.has(b)) {
      map.set(b, new Set());
    }
    map.get(a)!.add(b);
    map.get(b)!.add(a);
  }

  for (const wire of wires) {
    const startKey = pointKey(wire.start.x, wire.start.y);
    const endKey = pointKey(wire.end.x, wire.end.y);
    link(startKey, endKey);
  }

  return map;
}

/**
 * Flood-fill from a starting point, returning all reachable point keys.
 */
function floodFill(start: string, connected: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [start];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const neighbors = connected.get(current);
    if (neighbors !== undefined) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }
  }

  return visited;
}

/**
 * Collect all { element, pin } pairs from a list of elements.
 */
function collectPins(elements: readonly CircuitElement[]): { element: CircuitElement; pin: Pin }[] {
  const result: { element: CircuitElement; pin: Pin }[] = [];
  for (const element of elements) {
    for (const pin of element.getPins()) {
      result.push({ element, pin });
    }
  }
  return result;
}
