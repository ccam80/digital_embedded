/**
 * Wire bit-width propagation — reusable across loader and editor.
 *
 * Sets each wire's bitWidth by tracing connected nets from multi-bit pins.
 * Extracted from dig-loader.ts (Step 5 of architectural refactor) so that
 * the editor can re-propagate after any circuit mutation that changes
 * connectivity or pin widths.
 */

import type { Circuit } from "./circuit.js";
import { Wire } from "./circuit.js";
import { pinWorldPosition } from "./pin.js";

function ptKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Set each wire's bitWidth by tracing connected nets from multi-bit pins.
 *
 * 1. Build adjacency: endpoint position → list of wires touching that point.
 * 2. Seed from multi-bit component pins.
 * 3. Flood-fill through connected wires so the entire net gets the bit width.
 *
 * Safe to call multiple times — resets wire bitWidths to 1 before propagating
 * so stale values from a previous run are cleared.
 */
export function propagateWireBitWidths(circuit: Circuit): void {
  if (circuit.wires.length === 0) return;

  // Reset all wires to 1-bit before propagating
  for (const wire of circuit.wires) {
    wire.bitWidth = 1;
  }

  // Adjacency: position key → wires sharing that endpoint
  const pointToWires = new Map<string, Wire[]>();
  const wireKeys = new Map<Wire, [string, string]>();

  for (const wire of circuit.wires) {
    const sk = ptKey(wire.start.x, wire.start.y);
    const ek = ptKey(wire.end.x, wire.end.y);
    wireKeys.set(wire, [sk, ek]);

    let sl = pointToWires.get(sk);
    if (!sl) { sl = []; pointToWires.set(sk, sl); }
    sl.push(wire);

    let el = pointToWires.get(ek);
    if (!el) { el = []; pointToWires.set(ek, el); }
    el.push(wire);
  }

  // Seed: collect multi-bit pin positions
  const seeds = new Map<string, number>(); // position key → max bitWidth
  for (const element of circuit.elements) {
    for (const pin of element.getPins()) {
      if (pin.bitWidth <= 1) continue;
      const wp = pinWorldPosition(element, pin);
      const key = ptKey(wp.x, wp.y);
      const existing = seeds.get(key) ?? 1;
      if (pin.bitWidth > existing) {
        seeds.set(key, pin.bitWidth);
      }
    }
  }

  if (seeds.size === 0) return;

  // Flood-fill from each seed through connected wires
  const visited = new Set<Wire>();

  for (const [seedKey, bw] of seeds) {
    const startWires = pointToWires.get(seedKey);
    if (!startWires) continue;

    const queue: Wire[] = [];
    for (const w of startWires) {
      if (!visited.has(w)) {
        visited.add(w);
        queue.push(w);
      }
    }

    while (queue.length > 0) {
      const wire = queue.pop()!;
      if (bw > wire.bitWidth) wire.bitWidth = bw;

      const [sk, ek] = wireKeys.get(wire)!;
      for (const neighborKey of [sk, ek]) {
        const neighbors = pointToWires.get(neighborKey);
        if (!neighbors) continue;
        for (const nw of neighbors) {
          if (!visited.has(nw)) {
            visited.add(nw);
            queue.push(nw);
          }
        }
      }
    }
  }
}
