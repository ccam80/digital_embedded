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
  /** Optional intermediate points for routing through component body. */
  waypoints?: { x: number; y: number }[];
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
  /** Compiler-resolved pins in pinLayout order (label, vertex, nodeId).
   *  When present, preferred over elementPinVertices for vertex lookup,
   *  and over pinWorldPosition() calls for world positions in Step 4. */
  readonly elementResolvedPins?: Map<number, import("../core/pin.js").ResolvedPin[]>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pointKey(p: { x: number; y: number }): string {
  return `${p.x},${p.y}`;
}

/**
 * Local-space body junction point for multi-pin components.
 * Returns the point where internal current paths converge (bar, channel, etc.)
 * so that animated dots follow the component's visible leads instead of
 * cutting diagonally through empty space.
 */
function bodyJunctionLocal(typeId: string): { x: number; y: number } | null {
  switch (typeId) {
    case "NpnBJT":
    case "PnpBJT":
    case "NMOS":
    case "PMOS":
    case "NJFET":
    case "PJFET":
      return { x: 3, y: 0 };
    case "SCR":
    case "Triac":
    case "Triode":
      return { x: 2, y: 0 };
    default:
      return null;
  }
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

    const { wireToNodeId, elements, elementToCircuitElement, elementPinVertices, elementResolvedPins } = compiled;

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
    // For each element, record how much current each pin injects into the
    // wire graph at the vertex where it connects. The vertex comes from
    // elementPinVertices — the exact wire endpoint the compiler matched
    // in resolveElementNodes.
    //
    // For 2-terminal elements: positive getElementCurrent(eIdx) means
    // current flows from pinNodeIds[0] through the element to pinNodeIds[1].
    //   At pinNodeIds[0]: current LEAVES the node → injection = -I
    //   At pinNodeIds[1]: current ENTERS the node → injection = +I
    //
    // For N-terminal elements: getElementPinCurrents returns per-pin
    // currents where positive = current into element, so injection at
    // each pin = -pinCurrent (current leaves the node into the element).
    // ------------------------------------------------------------------
    const pointInjections = new Map<string, number>();

    for (let eIdx = 0; eIdx < elements.length; eIdx++) {
      // Prefer resolvedPins (pinLayout order, label+vertex+nodeId) when available.
      // Fall back to elementPinVertices for backwards compatibility.
      const resolvedPins = elementResolvedPins?.get(eIdx);
      const vertices = resolvedPins
        ? resolvedPins.map((rp) => rp.wireVertex)
        : elementPinVertices?.get(eIdx);
      if (!vertices) continue;

      const pinCurrents = engine.getElementPinCurrents(eIdx);
      if (pinCurrents !== null) {
        // Use per-pin currents (works for both 2-pin and N-pin elements)
        for (let t = 0; t < pinCurrents.length; t++) {
          const cv = vertices[t];
          if (!cv) continue;
          // pinCurrents[t] > 0 means current flows into element (out of node)
          const injection = -pinCurrents[t];
          pointInjections.set(pointKey(cv), (pointInjections.get(pointKey(cv)) ?? 0) + injection);
        }
      } else if (elements[eIdx].pinNodeIds.length === 2) {
        // Fallback for 2-terminal elements without getPinCurrents
        const I = engine.getElementCurrent(eIdx);
        for (let t = 0; t < 2; t++) {
          const cv = vertices[t];
          if (!cv) continue;
          const injection = t === 0 ? -I : +I;
          pointInjections.set(pointKey(cv), (pointInjections.get(pointKey(cv)) ?? 0) + injection);
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 2b: Identify tunnel vertex positions per MNA node.
    //
    // Tunnel components merge physically separate wire groups into one
    // MNA node. When the wire graph for a node is a forest (multiple
    // connected components), the tunnel pin positions are where current
    // crosses between trees. We scan circuit elements for Tunnels and
    // map their pin world positions to node IDs via wireToNodeId.
    // ------------------------------------------------------------------
    const tunnelVerticesByNode = new Map<number, Set<string>>();

    for (const el of circuit.elements) {
      if (el.typeId !== "Tunnel") continue;
      const pins = el.getPins();
      if (pins.length === 0) continue;
      const wp = pinWorldPosition(el, pins[0]);
      const pk = pointKey(wp);

      // Find nodeId by matching against wire endpoints at this position
      for (const wire of circuit.wires) {
        if (pointKey(wire.start) === pk || pointKey(wire.end) === pk) {
          const nodeId = wireToNodeId.get(wire);
          if (nodeId !== undefined) {
            if (!tunnelVerticesByNode.has(nodeId)) tunnelVerticesByNode.set(nodeId, new Set());
            tunnelVerticesByNode.get(nodeId)!.add(pk);
            break;
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 3: Assign currents to wires per node via tree propagation.
    // ------------------------------------------------------------------
    for (const [_nodeId, wires] of nodeToWires) {
      const assigned = this._traceTreeCurrents(wires, pointInjections, tunnelVerticesByNode.get(_nodeId));
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
    // Step 4: Build component-body current paths.
    //
    // For 2-terminal elements: single path pin0 → pin1.
    // For N-terminal elements: one path per source→sink pin pair, where
    // "source" pins have current flowing in and "sink" pins have current
    // flowing out. Current is distributed proportionally across pairs.
    // ------------------------------------------------------------------
    this._componentPaths = [];
    for (let eIdx = 0; eIdx < elements.length; eIdx++) {
      const ce = elementToCircuitElement.get(eIdx);
      if (!ce) continue;
      const cePins = ce.getPins();

      const pinCurrents = engine.getElementPinCurrents(eIdx);

      if (pinCurrents !== null && elements[eIdx].pinNodeIds.length > 2) {
        // Multi-pin element: create paths from source pins to sink pins
        if (cePins.length < 2) continue;

        // Compute optional body junction waypoint so dots follow visible
        // leads instead of cutting diagonally through empty space.
        const jLocal = bodyJunctionLocal(ce.typeId);
        const junctionWorld = jLocal
          ? pinWorldPosition(ce, { position: jLocal })
          : null;

        // Collect source pins (current into element, pinCurrent > 0) and
        // sink pins (current out of element, pinCurrent < 0).
        // Prefer resolvedPins world positions (pinLayout order, computed once
        // at compile time) over calling pinWorldPosition() again.
        const step4ResolvedPins = elementResolvedPins?.get(eIdx);
        const sources: { pos: { x: number; y: number }; current: number }[] = [];
        const sinks: { pos: { x: number; y: number }; current: number }[] = [];

        for (let t = 0; t < Math.min(pinCurrents.length, cePins.length); t++) {
          const pc = pinCurrents[t];
          if (Math.abs(pc) < 1e-15) continue;
          const pos = (step4ResolvedPins && step4ResolvedPins[t])
            ? step4ResolvedPins[t].worldPosition
            : pinWorldPosition(ce, cePins[t]);
          if (pc > 0) {
            sources.push({ pos, current: pc });
          } else {
            sinks.push({ pos, current: -pc }); // store as positive magnitude
          }
        }

        const totalSource = sources.reduce((s, e) => s + e.current, 0);
        const totalSink = sinks.reduce((s, e) => s + e.current, 0);

        if (totalSource < 1e-15 || totalSink < 1e-15) {
          // All pin currents are zero — create a stationary fallback path
          // from pin0 to the last pin so dots remain visible (matching
          // the 2-terminal behaviour where zero-current shows static dots).
          const p0 = (step4ResolvedPins && step4ResolvedPins[0])
            ? step4ResolvedPins[0].worldPosition
            : pinWorldPosition(ce, cePins[0]);
          const pN = (step4ResolvedPins && step4ResolvedPins[cePins.length - 1])
            ? step4ResolvedPins[cePins.length - 1].worldPosition
            : pinWorldPosition(ce, cePins[cePins.length - 1]);
          const fallbackPath: ComponentCurrentPath = {
            pin0: p0,
            pin1: pN,
            current: 0,
            flowSign: 0,
          };
          if (junctionWorld) fallbackPath.waypoints = [junctionWorld];
          this._componentPaths.push(fallbackPath);
          continue;
        }

        // For each source-sink pair, create a path with proportionally
        // distributed current. For a FET with one source and one sink
        // this produces exactly one path.
        for (const src of sources) {
          for (const snk of sinks) {
            // Current through this pair = src.current * (snk.current / totalSink)
            const pairCurrent = src.current * (snk.current / totalSink);
            if (pairCurrent < 1e-15) continue;
            const pairPath: ComponentCurrentPath = {
              pin0: src.pos,
              pin1: snk.pos,
              current: pairCurrent,
              flowSign: 1, // always source → sink direction
            };
            if (junctionWorld) pairPath.waypoints = [junctionWorld];
            this._componentPaths.push(pairPath);
          }
        }
      } else {
        // 2-terminal element (or fallback): single path pin0 → pin1
        if (cePins.length < 2) continue;
        // Prefer getPinCurrents (covers all elements including nonlinear
        // devices like diodes that have no getCurrent or branchIndex).
        // Fall back to getElementCurrent for elements that only have
        // getCurrent or branchIndex.
        const pc = pinCurrents;
        const I = (pc !== null && pc.length >= 1) ? pc[0] : engine.getElementCurrent(eIdx);
        this._componentPaths.push({
          pin0: pinWorldPosition(ce, cePins[0]),
          pin1: pinWorldPosition(ce, cePins[1]),
          current: Math.abs(I),
          flowSign: I > 1e-15 ? 1 : I < -1e-15 ? -1 : 0,
        });
      }
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
   * For wires within a single MNA node, compute per-wire currents by
   * propagating element terminal injections through each connected tree.
   *
   * The wire graph for a single node may be a **forest** (multiple
   * disconnected trees) when Tunnel components merge physically separate
   * wire groups into one electrical node. It may also contain **parallel
   * edges** (duplicate wires between the same two endpoints) or
   * **zero-length self-loops** from redundant XML wire entries.
   *
   * Algorithm:
   *   1. Filter out zero-length wires (current = 0, visually invisible).
   *   2. Deduplicate parallel edges — keep one representative per endpoint
   *      pair; duplicates inherit the representative's current.
   *   3. Build an adjacency graph of wire endpoints (vertices) and edges.
   *   4. Find connected components via BFS.
   *   5. For each component, verify it is a tree (V_cc = E_cc + 1).
   *      If it has cycles, set those wires to 0 (physically indeterminate).
   *   6. BFS from root, bottom-up subtree injection sums, assign currents.
   *
   * Returns a map of signed currents for all wires (positive = start→end).
   */
  private _traceTreeCurrents(
    wires: Wire[],
    pointInjections: Map<string, number>,
    tunnelVertices?: Set<string>,
  ): Map<Wire, number> {
    const result = new Map<Wire, number>();
    if (wires.length === 0) return result;

    // ----- Step 1: Filter zero-length wires -----
    const realWires: Wire[] = [];
    const realIndices: number[] = [];

    for (let i = 0; i < wires.length; i++) {
      const w = wires[i];
      if (pointKey(w.start) === pointKey(w.end)) {
        result.set(w, 0); // zero-length → no visible current
      } else {
        realWires.push(w);
        realIndices.push(i);
      }
    }

    if (realWires.length === 0) return result;

    // ----- Step 2: Deduplicate parallel edges -----
    // Multiple wires between the same two endpoints are electrically
    // identical — keep one representative; duplicates get the same current.
    const edgeKeyToRepIdx = new Map<string, number>(); // canonical edge key → index in realWires
    const duplicateOf = new Map<number, number>();      // realWires index → representative index

    for (let i = 0; i < realWires.length; i++) {
      const w = realWires[i];
      const sk = pointKey(w.start);
      const ek = pointKey(w.end);
      // Canonical key: sorted endpoints so A→B and B→A map to the same edge
      const edgeKey = sk < ek ? `${sk}|${ek}` : `${ek}|${sk}`;
      const existing = edgeKeyToRepIdx.get(edgeKey);
      if (existing !== undefined) {
        duplicateOf.set(i, existing);
      } else {
        edgeKeyToRepIdx.set(edgeKey, i);
      }
    }

    // Build the deduplicated wire list for graph construction
    const uniqueWires: Wire[] = [];
    const uniqueToReal: number[] = [];     // uniqueWires index → realWires index
    const realToUnique = new Map<number, number>(); // realWires index → uniqueWires index
    for (let i = 0; i < realWires.length; i++) {
      if (!duplicateOf.has(i)) {
        realToUnique.set(i, uniqueWires.length);
        uniqueToReal.push(i);
        uniqueWires.push(realWires[i]);
      }
    }

    // ----- Step 3: Build adjacency graph -----
    const pointToEdgeIdx = new Map<string, number[]>();
    const edgeEndpoints: [string, string][] = [];

    for (let i = 0; i < uniqueWires.length; i++) {
      const w = uniqueWires[i];
      const sk = pointKey(w.start);
      const ek = pointKey(w.end);
      edgeEndpoints.push([sk, ek]);

      if (!pointToEdgeIdx.has(sk)) pointToEdgeIdx.set(sk, []);
      if (!pointToEdgeIdx.has(ek)) pointToEdgeIdx.set(ek, []);
      pointToEdgeIdx.get(sk)!.push(i);
      pointToEdgeIdx.get(ek)!.push(i);
    }

    // ----- Step 4: Find connected components via BFS -----
    const allVertices = [...pointToEdgeIdx.keys()];
    const visited = new Set<string>();
    const components: { vertices: string[]; edges: number[] }[] = [];

    for (const startV of allVertices) {
      if (visited.has(startV)) continue;

      const compVerts: string[] = [];
      const compEdgeSet = new Set<number>();
      const queue: string[] = [startV];
      visited.add(startV);

      while (queue.length > 0) {
        const v = queue.shift()!;
        compVerts.push(v);

        for (const ei of (pointToEdgeIdx.get(v) ?? [])) {
          compEdgeSet.add(ei);
          const [s, e] = edgeEndpoints[ei];
          const neighbor = s === v ? e : s;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      components.push({ vertices: compVerts, edges: [...compEdgeSet] });
    }

    // ----- Step 5–6: Process each component independently -----
    // Per-unique-wire signed current (filled by component processing)
    const uniqueCurrents = new Float64Array(uniqueWires.length);

    for (const comp of components) {
      const Vc = comp.vertices.length;
      const Ec = comp.edges.length;

      // A tree has V = E + 1. If not, cycles exist — set to 0.
      if (Vc !== Ec + 1) {
        // Leave uniqueCurrents[edge] at 0 for all edges in this component
        continue;
      }

      // BFS from first vertex to establish parent-child relationships
      const parentVertex = new Map<string, string | null>();
      const parentEdgeIdx = new Map<string, number>();
      const bfsOrder: string[] = [];
      const bfsQueue: string[] = [];
      const compEdgeSet = new Set(comp.edges);

      const root = comp.vertices[0];
      parentVertex.set(root, null);
      bfsQueue.push(root);

      while (bfsQueue.length > 0) {
        const v = bfsQueue.shift()!;
        bfsOrder.push(v);

        for (const ei of (pointToEdgeIdx.get(v) ?? [])) {
          if (!compEdgeSet.has(ei)) continue; // edge not in this component
          const [s, e] = edgeEndpoints[ei];
          const neighbor = s === v ? e : s;
          if (parentVertex.has(neighbor)) continue; // already visited
          parentVertex.set(neighbor, v);
          parentEdgeIdx.set(neighbor, ei);
          bfsQueue.push(neighbor);
        }
      }

      // Bottom-up subtree injection sums.
      // First, compute total local injection for this component. If nonzero,
      // the imbalance is current flowing through tunnel(s) to/from other
      // components sharing this MNA node. Distribute the balancing injection
      // across identified tunnel vertices within this component. When
      // multiple tunnels exit the same tree, the split is indeterminate
      // (ideal wires = zero resistance), so we split evenly.
      const subtreeSum = new Map<string, number>();
      let localTotal = 0;
      for (const v of comp.vertices) {
        const inj = pointInjections.get(v) ?? 0;
        subtreeSum.set(v, inj);
        localTotal += inj;
      }

      if (Math.abs(localTotal) > 1e-18) {
        // Find tunnel vertices within this component
        const compTunnels: string[] = [];
        if (tunnelVertices) {
          for (const v of comp.vertices) {
            if (tunnelVertices.has(v)) compTunnels.push(v);
          }
        }

        if (compTunnels.length > 0) {
          // Distribute balance evenly across tunnel vertices
          const perTunnel = -localTotal / compTunnels.length;
          for (const tv of compTunnels) {
            subtreeSum.set(tv, subtreeSum.get(tv)! + perTunnel);
          }
        } else {
          // Fallback: no identified tunnel — inject at BFS root
          subtreeSum.set(root, subtreeSum.get(root)! + (-localTotal));
        }
      }

      for (let i = bfsOrder.length - 1; i >= 0; i--) {
        const v = bfsOrder[i];
        const p = parentVertex.get(v);
        if (p !== null && p !== undefined) {
          subtreeSum.set(p, subtreeSum.get(p)! + subtreeSum.get(v)!);
        }
      }

      // Assign signed current to each edge
      for (const v of comp.vertices) {
        const p = parentVertex.get(v);
        if (p === null || p === undefined) continue; // root
        const ei = parentEdgeIdx.get(v)!;
        const childSum = subtreeSum.get(v)!;
        const signedParentToChild = -childSum;

        const [, ek] = edgeEndpoints[ei];
        const childIsEnd = ek === v;

        uniqueCurrents[ei] = (childIsEnd ? 1 : -1) * signedParentToChild;
      }
    }

    // ----- Map results back to all wires (including duplicates) -----
    // Assign unique wire currents
    for (let i = 0; i < uniqueWires.length; i++) {
      result.set(uniqueWires[i], uniqueCurrents[i]);
    }

    // Assign duplicate wire currents from their representative
    for (const [dupIdx, repIdx] of duplicateOf) {
      const repUniqueIdx = realToUnique.get(repIdx);
      if (repUniqueIdx !== undefined) {
        result.set(realWires[dupIdx], uniqueCurrents[repUniqueIdx]);
      } else {
        result.set(realWires[dupIdx], 0);
      }
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
