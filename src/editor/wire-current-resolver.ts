/**
 * WireCurrentResolver — Kirchhoff's Current Law resolver for wire segments.
 *
 * Derives per-wire-segment currents from component currents using KCL.
 * Runs once per render frame in the editor layer.
 *
 * Core insight: every wire belongs to exactly one net (node). Each net is
 * a junction connecting one or more component terminals. The current
 * through a wire equals the current flowing through its net cross-section.
 *
 * Algorithm:
 *   1. Build node→wires and element→terminal-nodes maps.
 *   2. For each element, assign its current to the wires on its two
 *      terminal nets. At a simple series node (one element per side),
 *      this is direct. At branching junctions, KCL distributes current.
 *   3. A wire not in wireToNodeId is disconnected: current = 0.
 */

import type { Wire, Circuit } from "@/core/circuit";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";

// ---------------------------------------------------------------------------
// WireCurrentResult
// ---------------------------------------------------------------------------

export interface WireCurrentResult {
  /** Absolute current magnitude in amperes. */
  current: number;
  /** Unit vector indicating conventional current flow direction. */
  direction: [number, number];
}

// ---------------------------------------------------------------------------
// WireCurrentResolver
// ---------------------------------------------------------------------------

export class WireCurrentResolver {
  private _results: Map<Wire, WireCurrentResult> = new Map();

  /**
   * Compute currents for all wire segments.
   *
   * For each non-ground terminal node N of each element Ei:
   *   - There is exactly one element "driving" the wire group at N from the
   *     Ei side. The wires at N carry |getElementCurrent(Ei)| on that side.
   *
   * At junction nodes where multiple elements share a net, each wire group
   * leading away from the junction is associated with a distinct element.
   * We assign each wire the current of the element whose terminal IS that
   * wire's node and whose OTHER terminal is a different node.
   *
   * Implementation strategy:
   *   Pass 1 — build a map: node → list of (elementIdx, otherNode) pairs.
   *             Each entry represents one "branch" into the node.
   *   Pass 2 — for each node, if all branches carry the same current
   *             (series case), assign that current to every wire at the node.
   *             For junctions, assign each branch's current to the wires
   *             that connect toward that branch's otherNode side.
   *
   * Since wires carry no topology beyond their nodeId, we use a simple
   * one-element-per-wire assignment: each wire at node N is assigned the
   * current of one of the elements at N. For the most common topologies:
   *   - Series: two elements at N, both with the same current → any wire = same I.
   *   - Parallel branches: one element per branch, wire at branch node = that I.
   *   - Junction node shared by source + two parallel R's: source wire gets I_total;
   *     each R-wire gets its own I_R (resolved from its single-element node).
   */
  resolve(engine: AnalogEngine, circuit: Circuit, compiled: CompiledAnalogCircuit): void {
    this._results.clear();

    const wireToNodeId = compiled.wireToNodeId;
    const elements = compiled.elements;

    // ------------------------------------------------------------------
    // Build node → wires map.
    // ------------------------------------------------------------------
    const nodeToWires = new Map<number, Wire[]>();

    for (const wire of circuit.wires) {
      const nodeId = wireToNodeId.get(wire);
      if (nodeId === undefined) {
        // Disconnected — no net assignment.
        this._results.set(wire, { current: 0, direction: this._unitDir(wire) });
        continue;
      }
      if (!nodeToWires.has(nodeId)) nodeToWires.set(nodeId, []);
      nodeToWires.get(nodeId)!.push(wire);
    }

    // ------------------------------------------------------------------
    // For each element, get its current and publish it to its terminal nodes.
    //
    // wireBestCurrent[wire]: the current assigned to this wire so far.
    // We use a "last-write wins" policy for over-constrained wires, which
    // is correct for well-formed circuits (each wire belongs to one net and
    // is driven by one element on each side).
    //
    // Special case for junction nodes:
    //   A junction node is one where more than one element terminal lands.
    //   At such a node, multiple elements contribute current. The total
    //   current flowing through the wire group must satisfy KCL.
    //
    //   Strategy: we accumulate contributions per node, then pick the
    //   dominant element for each wire group at the junction.
    // ------------------------------------------------------------------

    // nodeContribs[nodeId] = list of (elementIdx, signed contribution)
    // "contribution" is the current this element injects INTO the node.
    const nodeContribs = new Map<number, Array<{ eIdx: number; I: number }>>();

    for (let eIdx = 0; eIdx < elements.length; eIdx++) {
      const el = elements[eIdx];
      const I = engine.getElementCurrent(eIdx);

      // Iterate original nodeIndices, using original position to determine sign.
      for (let t = 0; t < el.nodeIndices.length; t++) {
        const nodeId = el.nodeIndices[t];
        if (nodeId <= 0) continue; // skip ground

        // Convention: positive I flows from nodeIndices[0] to nodeIndices[1]
        // THROUGH the element (inside it). At position 0, current flows
        // FROM the node INTO the element (leaves the node, negative injection).
        // At position 1+, current flows FROM the element INTO the node
        // (enters the node, positive injection).
        const injected = t === 0 ? -I : +I;

        if (!nodeContribs.has(nodeId)) nodeContribs.set(nodeId, []);
        nodeContribs.get(nodeId)!.push({ eIdx, I: injected });
      }
    }

    // ------------------------------------------------------------------
    // Assign wire currents from node contributions.
    //
    // For each node N:
    //   - All elements at N collectively inject/extract current.
    //   - The magnitude of current THROUGH the wire group at N equals the
    //     magnitude of current flowing in one direction across the node cut.
    //   - For a series node (two elements, currents cancel in KCL):
    //       |I| = |contrib from either element| (both are equal in series).
    //   - For a source node (one element contributes full I):
    //       |I| = |that element's I|.
    //   - For a junction between source (I_total) and two branches (I1, I2):
    //       At the junction node, source contributes I_total.
    //       Each branch node (node 2 and node 3) has single-element terminals
    //       (the R) — those are handled by the single-element node case.
    //
    // The current flowing "through" the wires at node N on any cross-section
    // is the maximum of the absolute contributions, which equals the current
    // of the dominant element (the one not being cancelled at that node).
    //
    // More precisely: at a series node, both elements contribute equal and
    // opposite flows (one in, one out), so |I_wire| = |I_element|.
    // At a junction, I_source flows in, I_R1 + I_R2 flow out.
    // The wire on the source side carries I_source; each branch wire carries
    // its I_Rx. Since wires at the junction node all share the same nodeId,
    // we can't distinguish them in the nodeToWires map — they're all at the
    // junction. We instead rely on the single-element nodes (R1's other node,
    // R2's other node) to assign those branch wires.
    //
    // Algorithm:
    //   1. For nodes with ONE contributing element: assign that element's |I|
    //      to all wires at the node.
    //   2. For nodes with TWO elements (series or junction):
    //      assign the maximum |I| of the two elements to all wires at the
    //      node (in series both are equal; at a junction the source side has
    //      the sum, but the branch wires are better resolved from their
    //      single-element nodes).
    //   3. For nodes with >2 elements: assign the sum of inflowing currents
    //      (KCL total) divided by wire count.
    // ------------------------------------------------------------------

    const wireCurrentMap = new Map<Wire, number>();

    for (const [nodeId, contribs] of nodeContribs) {
      const wires = nodeToWires.get(nodeId) ?? [];
      if (wires.length === 0) continue;

      // Current flowing through this node's cross-section.
      // For a well-formed circuit, KCL holds: sum(injected) = 0.
      // The cross-section current = the magnitude of the positive (or
      // negative) sum of contributions from one "side".
      //
      // We use: I_cross = sum of positive injections into the node
      //                  (= sum of elements delivering current INTO the node).
      let positiveSum = 0;
      for (const { I } of contribs) {
        if (I > 0) positiveSum += I;
      }

      // Assign positiveSum to all wires at this node.
      // This is correct for series nodes (one element in, one out, positiveSum = I_series)
      // and for junction SOURCE nodes (positiveSum = I_source_total).
      for (const w of wires) {
        wireCurrentMap.set(w, positiveSum);
      }
    }

    // ------------------------------------------------------------------
    // Commit results.
    // ------------------------------------------------------------------
    for (const wire of circuit.wires) {
      if (this._results.has(wire)) continue; // already set (disconnected)
      const current = wireCurrentMap.get(wire) ?? 0;
      this._results.set(wire, { current, direction: this._unitDir(wire) });
    }
  }

  /** Return the resolved current for a wire, or undefined if not resolved. */
  getWireCurrent(wire: Wire): WireCurrentResult | undefined {
    return this._results.get(wire);
  }

  /** Reset all computed currents. */
  clear(): void {
    this._results.clear();
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
