/**
 * WireCurrentResolver — derives per-wire current magnitudes from MNA results.
 *
 * Builds a wire endpoint graph per MNA node, identifies element terminal
 * positions via pinWorldPosition, and propagates currents through the tree
 * using BFS + bottom-up subtree-sum computation. Each wire's current equals
 * the signed subtree injection sum of its child vertex (positive = start→end).
 *
 * For wire graphs that contain cycles (rare — parallel wires within a node),
 * returns 0 for those wires since the per-wire split is physically
 * indeterminate without resistance.
 */

import type { Wire, Circuit } from "@/core/circuit";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { AnalogElement } from "@/analog/element";
import type { CircuitElement } from "@/core/element";
import { pinWorldPosition } from "@/core/pin";

// ---------------------------------------------------------------------------
// WireCurrentResult
// ---------------------------------------------------------------------------

export interface WireCurrentResult {
  /** Current magnitude in amperes (always >= 0). */
  current: number;
  /** Unit vector along the wire (start → end). */
  direction: [number, number];
  /** +1 if current flows start→end, -1 if end→start, 0 if zero. */
  flowSign: 1 | -1 | 0;
}

/** Current path through a component body (between its two pins). */
export interface ComponentCurrentPath {
  /** World position of pin 0. */
  pin0: { x: number; y: number };
  /** World position of pin 1. */
  pin1: { x: number; y: number };
  /** Current magnitude in amperes (>= 0). */
  current: number;
  /** +1 if current flows pin0→pin1, -1 if pin1→pin0, 0 if zero. */
  flowSign: 1 | -1 | 0;
}

// ---------------------------------------------------------------------------
// ResolvedAnalogCircuit — the fields the resolver needs from the compiled
// circuit. ConcreteCompiledAnalogCircuit satisfies this.
// ---------------------------------------------------------------------------

export interface ResolvedAnalogCircuit {
  readonly wireToNodeId: Map<Wire, number>;
  readonly elements: readonly AnalogElement[];
  readonly elementToCircuitElement: Map<number, CircuitElement>;
  /** Compiler-resolved wire vertices for each element pin. When present,
   *  the resolver uses these directly instead of re-computing pin positions. */
  readonly elementPinVertices?: Map<number, Array<{ x: number; y: number } | null>>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pointKey(p: { x: number; y: number }): string {
  return `${p.x},${p.y}`;
}

// ---------------------------------------------------------------------------
// WireCurrentResolver
// ---------------------------------------------------------------------------

export class WireCurrentResolver {
  private _results: Map<Wire, WireCurrentResult> = new Map();
  private _componentPaths: ComponentCurrentPath[] = [];

  /**
   * Compute currents for all wire segments using tree-traced propagation.
   *
   * For each MNA node, builds a wire endpoint graph, identifies element
   * terminal injection points via pinWorldPosition, and propagates currents
   * through the tree. Each wire's current = signed subtree injection sum of
   * its child vertex (positive = start→end direction).
   */
  resolve(engine: AnalogEngine, circuit: Circuit, compiled: ResolvedAnalogCircuit): void {
    this._results.clear();
    this._componentPaths = [];

    const { wireToNodeId, elements, elementToCircuitElement, elementPinVertices } = compiled;

    // ------------------------------------------------------------------
    // Step 1: Build node → wires map.
    // ------------------------------------------------------------------
    const nodeToWires = new Map<number, Wire[]>();

    for (const wire of circuit.wires) {
      const nodeId = wireToNodeId.get(wire);
      if (nodeId === undefined) {
        this._results.set(wire, { current: 0, direction: this._unitDir(wire), flowSign: 0 });
        continue;
      }
      if (!nodeToWires.has(nodeId)) nodeToWires.set(nodeId, []);
      nodeToWires.get(nodeId)!.push(wire);
    }

    // ------------------------------------------------------------------
    // Step 2: Build point → current injection map from element terminals.
    //
    // For each 2-terminal element, record how much current each pin
    // injects into the wire graph at the vertex where it connects.
    // The vertex comes from elementPinVertices — the exact wire endpoint
    // the compiler matched in resolveElementNodes. Elements without a
    // compiler-provided vertex are skipped (their current won't appear
    // in the wire graph).
    //
    // Convention: positive getElementCurrent(eIdx) means current flows
    // from nodeIndices[0] through the element to nodeIndices[1].
    //   At nodeIndices[0]: current LEAVES the node → injection = -I
    //   At nodeIndices[1]: current ENTERS the node → injection = +I
    // ------------------------------------------------------------------
    const pointInjections = new Map<string, number>();

    for (let eIdx = 0; eIdx < elements.length; eIdx++) {
      const ae = elements[eIdx];
      if (ae.nodeIndices.length !== 2) continue;

      const I = engine.getElementCurrent(eIdx);
      const vertices = elementPinVertices?.get(eIdx);
      if (!vertices) continue;

      for (let t = 0; t < 2; t++) {
        const cv = vertices[t];
        if (!cv) continue;
        const injection = t === 0 ? -I : +I;
        pointInjections.set(pointKey(cv), (pointInjections.get(pointKey(cv)) ?? 0) + injection);
      }
    }

    // ------------------------------------------------------------------
    // Step 3: Assign currents to wires per node via tree propagation.
    // ------------------------------------------------------------------
    for (const [_nodeId, wires] of nodeToWires) {
      const assigned = this._traceTreeCurrents(wires, pointInjections);
      for (const [wire, signedCurrent] of assigned) {
        const mag = Math.abs(signedCurrent);
        this._results.set(wire, {
          current: mag,
          direction: this._unitDir(wire),
          flowSign: signedCurrent > 1e-15 ? 1 : signedCurrent < -1e-15 ? -1 : 0,
        });
      }
    }

    // ------------------------------------------------------------------
    // Step 4: Build component-body current paths for 2-terminal elements.
    // ------------------------------------------------------------------
    this._componentPaths = [];
    for (let eIdx = 0; eIdx < elements.length; eIdx++) {
      const ae = elements[eIdx];
      if (ae.nodeIndices.length !== 2) continue;
      const I = engine.getElementCurrent(eIdx);
      const ce = elementToCircuitElement.get(eIdx);
      if (!ce) continue;
      const pins = ce.getPins();
      if (pins.length < 2) continue;
      this._componentPaths.push({
        pin0: pinWorldPosition(ce, pins[0]),
        pin1: pinWorldPosition(ce, pins[1]),
        current: Math.abs(I),
        flowSign: I > 1e-15 ? 1 : I < -1e-15 ? -1 : 0,
      });
    }
  }

  /** Return the resolved current for a wire, or undefined if not resolved. */
  getWireCurrent(wire: Wire): WireCurrentResult | undefined {
    return this._results.get(wire);
  }

  /** Return current paths through component bodies (computed during resolve()). */
  getComponentPaths(): readonly ComponentCurrentPath[] {
    return this._componentPaths;
  }

  /** Reset all computed currents. */
  clear(): void {
    this._results.clear();
    this._componentPaths = [];
  }

  // ---------------------------------------------------------------------------
  // Tree-traced current assignment
  // ---------------------------------------------------------------------------

  /**
   * For wires forming a tree within a single node, compute per-wire currents
   * by propagating element terminal injections through the tree.
   *
   * Algorithm:
   *   1. Build a graph of wire endpoints (vertices) connected by wires (edges).
   *   2. Verify the graph is a connected tree (V = E + 1).
   *   3. BFS from an arbitrary root to establish parent-child relationships.
   *   4. Bottom-up: compute subtree injection sum at each vertex.
   *   5. Each wire's signed current = childSum × (childIsEnd ? +1 : -1).
   *      Positive = current flows start→end.
   *
   * Returns a map of signed currents for all wires. If the graph has cycles,
   * wires get current 0.
   */
  private _traceTreeCurrents(
    wires: Wire[],
    pointInjections: Map<string, number>,
  ): Map<Wire, number> {
    const result = new Map<Wire, number>();
    if (wires.length === 0) return result;

    // Build adjacency: point → wire indices
    const pointToWireIdx = new Map<string, number[]>();
    const wireEndpoints: [string, string][] = [];

    for (let i = 0; i < wires.length; i++) {
      const w = wires[i];
      const sk = pointKey(w.start);
      const ek = pointKey(w.end);
      wireEndpoints.push([sk, ek]);

      // Handle zero-length wires (start === end)
      if (sk === ek) {
        if (!pointToWireIdx.has(sk)) pointToWireIdx.set(sk, []);
        pointToWireIdx.get(sk)!.push(i);
        continue;
      }

      if (!pointToWireIdx.has(sk)) pointToWireIdx.set(sk, []);
      if (!pointToWireIdx.has(ek)) pointToWireIdx.set(ek, []);
      pointToWireIdx.get(sk)!.push(i);
      pointToWireIdx.get(ek)!.push(i);
    }

    const vertices = [...pointToWireIdx.keys()];
    const V = vertices.length;
    const E = wires.length;

    // Single zero-length wire: V=1, E≥1. Use injection at that point (signed).
    if (V === 1 && E >= 1) {
      const pk = vertices[0];
      const inj = pointInjections.get(pk) ?? 0;
      for (const w of wires) result.set(w, inj); // signed, but direction meaningless
      return result;
    }

    // A connected tree has V = E + 1. If not, the graph has cycles — set all to 0.
    if (V !== E + 1) {
      for (const w of wires) result.set(w, 0);
      return result;
    }

    // BFS from root to establish parent-child relationships.
    const visited = new Set<string>();
    const parentVertex = new Map<string, string | null>();
    const parentWireIdx = new Map<string, number>();
    const bfsOrder: string[] = [];
    const queue: string[] = [];

    const root = vertices[0];
    visited.add(root);
    parentVertex.set(root, null);
    queue.push(root);

    while (queue.length > 0) {
      const v = queue.shift()!;
      bfsOrder.push(v);

      const adjWires = pointToWireIdx.get(v) ?? [];
      for (const wi of adjWires) {
        const [s, e] = wireEndpoints[wi];
        const neighbor = s === v ? e : s;
        if (neighbor === v) continue; // self-loop (zero-length wire)
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          parentVertex.set(neighbor, v);
          parentWireIdx.set(neighbor, wi);
          queue.push(neighbor);
        }
      }
    }

    // Check connectivity
    if (visited.size !== V) {
      for (const w of wires) result.set(w, 0);
      return result;
    }

    // Compute subtree injection sums (bottom-up).
    const subtreeSum = new Map<string, number>();
    for (const v of vertices) {
      subtreeSum.set(v, pointInjections.get(v) ?? 0);
    }

    // Process in reverse BFS order (children before parents).
    for (let i = bfsOrder.length - 1; i >= 0; i--) {
      const v = bfsOrder[i];
      const p = parentVertex.get(v);
      if (p !== null && p !== undefined) {
        subtreeSum.set(p, subtreeSum.get(p)! + subtreeSum.get(v)!);
      }
    }

    // Each wire's signed current (positive = flows start→end):
    //
    // By KCL, every node in a closed circuit has zero net injection
    // (total ≈ 0). The current through each wire equals the subtree
    // injection sum of its child vertex: I_wire = -childSum.
    //
    // If total is NOT near zero, injections are missing (pin-wire
    // misalignment bug) — the snap-to-vertex logic in Step 2 should
    // prevent this. We don't paper over it with heuristics.
    //
    // If child vertex is at wire.end: parent→child = start→end → positive.
    // If child vertex is at wire.start: parent→child = end→start → negative.
    for (const v of vertices) {
      const p = parentVertex.get(v);
      if (p === null || p === undefined) continue; // root has no parent wire
      const wi = parentWireIdx.get(v)!;
      const childSum = subtreeSum.get(v)!;

      // Current flowing parent→child = -childSum (from child subtree KCL).
      const signedParentToChild = -childSum;

      // Determine if child vertex v is at wire.end or wire.start
      const [, ek] = wireEndpoints[wi];
      const childIsEnd = ek === v;

      // positive signedParentToChild means current flows parent→child.
      // If child is wire.end: parent→child = start→end → positive flow sign.
      // If child is wire.start: parent→child = end→start → negative flow sign.
      result.set(wires[wi], (childIsEnd ? 1 : -1) * signedParentToChild);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Unit vector from wire.start to wire.end. Returns [1,0] for zero-length wires. */
  private _unitDir(wire: Wire): [number, number] {
    const dx = wire.end.x - wire.start.x;
    const dy = wire.end.y - wire.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-12) return [1, 0];
    return [dx / len, dy / len];
  }

}
