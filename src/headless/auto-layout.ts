/**
 * Auto-layout engine for programmatically-built circuits.
 *
 * Implements Sugiyama-style layered graph layout optimised for digital
 * circuit schematics with up to ~100 components:
 *
 *   1. Cycle removal- DFS back-edge reversal
 *   2. Layer assignment- longest-path from sources
 *   3. Sink promotion- align outputs on the rightmost column
 *   4. Dummy node insertion- for multi-layer crossing reduction
 *   5. Crossing reduction- barycenter heuristic, bidirectional sweeps,
 *      best-of tracking
 *   6. Coordinate assignment- size-aware spacing with vertical centering
 *   7. Orthogonal wire routing- Z-shaped segments, waypoints through
 *      dummy nodes for long edges
 *
 * Complexity: O(sweeps · n · m) where n = nodes, m = edges.
 * For 100 components / 8 sweeps this is well under 100 K operations.
 */

import type { Circuit } from '../core/circuit.js';
import { Wire } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import { pinWorldPosition, PinDirection } from '../core/pin.js';
import type { Pin } from '../core/pin.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-component layout constraint, keyed by element instanceId.
 *
 * - `col` pins the node to a specific Sugiyama layer (column).
 * - `row` pins the node's order (vertical position) within its layer.
 * - Either or both may be specified; omitted axes are auto-assigned.
 */
export interface LayoutConstraint {
  col?: number;
  row?: number;
}

export interface LayoutOptions {
  /** Horizontal gap between layer columns (grid units). Default: 8 */
  layerGap?: number;
  /** Minimum vertical gap between node centres (grid units). Default: 3 */
  nodeGap?: number;
  /** Number of crossing-reduction sweep passes. Default: 8 */
  sweeps?: number;
  /**
   * Per-node layout constraints, keyed by element instanceId.
   * Nodes with a `col` constraint are pinned to that layer.
   * Nodes with a `row` constraint are pinned to that order within their layer.
   */
  constraints?: Map<string, LayoutConstraint>;
}

/**
 * Reposition every element in `circuit` using Sugiyama layered layout and
 * replace all wires with orthogonally-routed segments.
 *
 * Mutates the circuit in place.
 */
export function autoLayout(circuit: Circuit, options?: LayoutOptions): void {
  const opts = {
    layerGap: options?.layerGap ?? 8,
    nodeGap: options?.nodeGap ?? 3,
    sweeps: options?.sweeps ?? 8,
  };
  const constraints = options?.constraints ?? new Map<string, LayoutConstraint>();

  if (circuit.elements.length === 0) return;

  const g = buildGraph(circuit);
  if (g.nodes.size === 0) return;

  breakCycles(g);
  assignLayers(g, constraints);
  promoteSinks(g, constraints);
  insertDummies(g);
  buildLayerArrays(g);
  applyRowConstraints(g, constraints);
  reduceCrossings(g, opts.sweeps, constraints);
  assignCoordinates(g, opts);
  applyLayout(g, circuit);
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════════════════

interface GNode {
  id: string;
  element?: CircuitElement; // absent for dummy nodes
  layer: number;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GEdge {
  src: string;
  dst: string;
  reversed: boolean;
}

/** Pin-level connection record- survives edge reversal / splitting. */
interface PinConn {
  srcId: string;
  srcPin: string;
  dstId: string;
  dstPin: string;
}

interface Graph {
  nodes: Map<string, GNode>;
  edges: GEdge[];
  conns: PinConn[];
  out: Map<string, GEdge[]>;
  in_: Map<string, GEdge[]>;
  layers: string[][];
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 1- Build directed graph from circuit wires
// ═══════════════════════════════════════════════════════════════════════════

function buildGraph(circuit: Circuit): Graph {
  // Index: world-position key → list of (element, pin) at that position.
  // Multiple pins from different components can share coordinates (e.g. when
  // auto-positioned components have tall pin spans), so we store an array.
  const posMap = new Map<string, Array<{ el: CircuitElement; pin: Pin }>>();
  for (const el of circuit.elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      const key = `${wp.x},${wp.y}`;
      let arr = posMap.get(key);
      if (arr === undefined) {
        arr = [];
        posMap.set(key, arr);
      }
      arr.push({ el, pin });
    }
  }

  const nodes = new Map<string, GNode>();
  const out = new Map<string, GEdge[]>();
  const in_ = new Map<string, GEdge[]>();

  for (const el of circuit.elements) {
    const bb = el.getBoundingBox();
    nodes.set(el.instanceId, {
      id: el.instanceId,
      element: el,
      layer: -1,
      order: -1,
      x: 0,
      y: 0,
      width: Math.max(bb.width, 2),
      height: Math.max(bb.height, 1),
    });
    out.set(el.instanceId, []);
    in_.set(el.instanceId, []);
  }

  const edges: GEdge[] = [];
  const conns: PinConn[] = [];
  const seen = new Set<string>();

  for (const wire of circuit.wires) {
    const aList = posMap.get(`${wire.start.x},${wire.start.y}`);
    const bList = posMap.get(`${wire.end.x},${wire.end.y}`);
    if (!aList || !bList) continue;

    // Find a pair (a, b) from different elements.
    let a: { el: CircuitElement; pin: Pin } | undefined;
    let b: { el: CircuitElement; pin: Pin } | undefined;
    for (const ai of aList) {
      for (const bi of bList) {
        if (ai.el !== bi.el) {
          a = ai;
          b = bi;
          break;
        }
      }
      if (a) break;
    }
    if (!a || !b) continue;

    // Orient: output → input
    let src = a;
    let dst = b;
    if (
      src.pin.direction === PinDirection.INPUT &&
      dst.pin.direction === PinDirection.OUTPUT
    ) {
      [src, dst] = [dst, src];
    }

    const srcId = src.el.instanceId;
    const dstId = dst.el.instanceId;
    const key = `${srcId}:${src.pin.label}->${dstId}:${dst.pin.label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const edge: GEdge = { src: srcId, dst: dstId, reversed: false };
    edges.push(edge);
    out.get(srcId)!.push(edge);
    in_.get(dstId)!.push(edge);

    conns.push({
      srcId,
      srcPin: src.pin.label,
      dstId,
      dstPin: dst.pin.label,
    });
  }

  return { nodes, edges, conns, out, in_, layers: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 2- Break cycles via DFS back-edge reversal
// ═══════════════════════════════════════════════════════════════════════════

function breakCycles(g: Graph): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of g.nodes.keys()) color.set(id, WHITE);

  function dfs(u: string): void {
    color.set(u, GRAY);
    // Copy list- reverseEdge mutates the adjacency array
    for (const e of [...(g.out.get(u) ?? [])]) {
      const c = color.get(e.dst)!;
      if (c === GRAY) {
        reverseEdge(g, e);
      } else if (c === WHITE) {
        dfs(e.dst);
      }
    }
    color.set(u, BLACK);
  }

  for (const id of g.nodes.keys()) {
    if (color.get(id) === WHITE) dfs(id);
  }
}

function reverseEdge(g: Graph, e: GEdge): void {
  spliceItem(g.out.get(e.src)!, e);
  spliceItem(g.in_.get(e.dst)!, e);
  [e.src, e.dst] = [e.dst, e.src];
  e.reversed = !e.reversed;
  g.out.get(e.src)!.push(e);
  g.in_.get(e.dst)!.push(e);
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 3- Layer assignment (longest path from sources)
// ═══════════════════════════════════════════════════════════════════════════

function assignLayers(
  g: Graph,
  constraints: Map<string, LayoutConstraint>,
): void {
  const inDeg = new Map<string, number>();
  for (const id of g.nodes.keys()) inDeg.set(id, 0);
  for (const e of g.edges) {
    inDeg.set(e.dst, (inDeg.get(e.dst) ?? 0) + 1);
  }

  const dist = new Map<string, number>();
  for (const id of g.nodes.keys()) dist.set(id, 0);

  // Kahn's algorithm with longest-path tracking
  const queue: string[] = [];
  for (const [id, d] of inDeg) {
    if (d === 0) queue.push(id);
  }

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const e of g.out.get(u) ?? []) {
      dist.set(e.dst, Math.max(dist.get(e.dst)!, dist.get(u)! + 1));
      const nd = inDeg.get(e.dst)! - 1;
      inDeg.set(e.dst, nd);
      if (nd === 0) queue.push(e.dst);
    }
  }

  for (const [id, layer] of dist) {
    g.nodes.get(id)!.layer = layer;
  }

  // Override layers for nodes with col constraints
  for (const [id, constraint] of constraints) {
    if (constraint.col !== undefined) {
      const node = g.nodes.get(id);
      if (node) node.layer = constraint.col;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 3b- Promote sinks to the rightmost layer
// ═══════════════════════════════════════════════════════════════════════════

function promoteSinks(
  g: Graph,
  constraints: Map<string, LayoutConstraint>,
): void {
  let maxLayer = 0;
  for (const n of g.nodes.values()) {
    maxLayer = Math.max(maxLayer, n.layer);
  }
  for (const [id, outs] of g.out) {
    // Skip nodes that have an explicit col constraint
    if (constraints.get(id)?.col !== undefined) continue;
    if (outs.length === 0 && (g.in_.get(id)?.length ?? 0) > 0) {
      g.nodes.get(id)!.layer = maxLayer;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 4- Insert dummy nodes for edges spanning multiple layers
// ═══════════════════════════════════════════════════════════════════════════

function insertDummies(g: Graph): void {
  for (const edge of [...g.edges]) {
    const srcLayer = g.nodes.get(edge.src)!.layer;
    const dstLayer = g.nodes.get(edge.dst)!.layer;
    const span = dstLayer - srcLayer;
    if (span <= 1) continue;

    removeEdge(g, edge);

    let prev = edge.src;
    for (let layer = srcLayer + 1; layer < dstLayer; layer++) {
      const did = `__d_${edge.src}_${edge.dst}_${layer}`;
      g.nodes.set(did, {
        id: did,
        layer,
        order: -1,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
      g.out.set(did, []);
      g.in_.set(did, []);
      addEdge(g, prev, did);
      prev = did;
    }
    addEdge(g, prev, edge.dst);
  }
}

function removeEdge(g: Graph, e: GEdge): void {
  spliceItem(g.edges, e);
  spliceItem(g.out.get(e.src)!, e);
  spliceItem(g.in_.get(e.dst)!, e);
}

function addEdge(g: Graph, src: string, dst: string): void {
  const e: GEdge = { src, dst, reversed: false };
  g.edges.push(e);
  g.out.get(src)!.push(e);
  g.in_.get(dst)!.push(e);
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 5- Build layer arrays and set initial order
// ═══════════════════════════════════════════════════════════════════════════

function buildLayerArrays(g: Graph): void {
  let maxLayer = 0;
  for (const n of g.nodes.values()) {
    maxLayer = Math.max(maxLayer, n.layer);
  }

  g.layers = Array.from({ length: maxLayer + 1 }, () => [] as string[]);
  for (const n of g.nodes.values()) {
    if (n.layer >= 0) g.layers[n.layer].push(n.id);
  }
  for (const layer of g.layers) {
    layer.forEach((id, i) => {
      g.nodes.get(id)!.order = i;
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 5b- Apply row constraints (initial order pinning)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set the initial order for nodes with row constraints, then compact
 * unconstrained nodes into the remaining slots.
 */
function applyRowConstraints(
  g: Graph,
  constraints: Map<string, LayoutConstraint>,
): void {
  for (const layer of g.layers) {
    // Collect pinned and unpinned nodes in this layer
    const pinned: { id: string; row: number }[] = [];
    const unpinned: string[] = [];

    for (const id of layer) {
      const c = constraints.get(id);
      if (c?.row !== undefined) {
        pinned.push({ id, row: c.row });
      } else {
        unpinned.push(id);
      }
    }

    if (pinned.length === 0) continue;

    // Sort pinned by their requested row
    pinned.sort((a, b) => a.row - b.row);

    // Build the new layer order: place pinned nodes at their requested
    // positions, fill gaps with unpinned nodes in their current order.
    const result: string[] = [];
    let pinnedIdx = 0;
    let unpinnedIdx = 0;

    // Interleave: walk through slot indices, placing pinned nodes at
    // their requested row and filling the rest with unpinned nodes.
    const totalCount = layer.length;
    for (let slot = 0; slot < totalCount; slot++) {
      if (pinnedIdx < pinned.length && pinned[pinnedIdx].row <= slot) {
        result.push(pinned[pinnedIdx].id);
        pinnedIdx++;
      } else if (unpinnedIdx < unpinned.length) {
        result.push(unpinned[unpinnedIdx]);
        unpinnedIdx++;
      } else if (pinnedIdx < pinned.length) {
        result.push(pinned[pinnedIdx].id);
        pinnedIdx++;
      }
    }

    // Copy back and update order indices
    for (let i = 0; i < result.length; i++) {
      layer[i] = result[i];
      g.nodes.get(result[i])!.order = i;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 6- Crossing reduction (barycenter, best-of tracking)
// ═══════════════════════════════════════════════════════════════════════════

function reduceCrossings(
  g: Graph,
  sweeps: number,
  constraints: Map<string, LayoutConstraint>,
): void {
  let bestOrder = snapshotOrder(g);
  let bestCrossings = countAllCrossings(g);

  for (let s = 0; s < sweeps; s++) {
    // Forward sweep
    for (let i = 1; i < g.layers.length; i++) {
      reorderLayer(g, i, 'left', constraints);
    }
    // Backward sweep
    for (let i = g.layers.length - 2; i >= 0; i--) {
      reorderLayer(g, i, 'right', constraints);
    }

    const crossings = countAllCrossings(g);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      bestOrder = snapshotOrder(g);
    }
  }

  restoreOrder(g, bestOrder);
}

function reorderLayer(
  g: Graph,
  layerIdx: number,
  fixed: 'left' | 'right',
  constraints: Map<string, LayoutConstraint>,
): void {
  const layer = g.layers[layerIdx];

  // Separate pinned (row-constrained) from free nodes
  const pinnedIds = new Set<string>();
  for (const id of layer) {
    if (constraints.get(id)?.row !== undefined) pinnedIds.add(id);
  }

  // Compute barycentres only for free nodes
  const bc = new Map<string, number>();
  for (const id of layer) {
    if (pinnedIds.has(id)) continue;
    const neighbors =
      fixed === 'left'
        ? (g.in_.get(id) ?? []).map((e) => e.src)
        : (g.out.get(id) ?? []).map((e) => e.dst);

    if (neighbors.length === 0) {
      bc.set(id, g.nodes.get(id)!.order);
    } else {
      const sum = neighbors.reduce(
        (s, n) => s + g.nodes.get(n)!.order,
        0,
      );
      bc.set(id, sum / neighbors.length);
    }
  }

  // Sort free nodes by barycenter
  const freeNodes = layer.filter((id) => !pinnedIds.has(id));
  freeNodes.sort((a, b) => bc.get(a)! - bc.get(b)!);

  // Rebuild layer: pinned nodes stay at their constrained positions,
  // free nodes fill the remaining slots in barycenter order.
  const pinned = layer
    .filter((id) => pinnedIds.has(id))
    .map((id) => ({ id, row: constraints.get(id)!.row! }));
  pinned.sort((a, b) => a.row - b.row);

  const result: string[] = [];
  let pinnedIdx = 0;
  let freeIdx = 0;
  for (let slot = 0; slot < layer.length; slot++) {
    if (pinnedIdx < pinned.length && pinned[pinnedIdx].row <= slot) {
      result.push(pinned[pinnedIdx].id);
      pinnedIdx++;
    } else if (freeIdx < freeNodes.length) {
      result.push(freeNodes[freeIdx]);
      freeIdx++;
    } else if (pinnedIdx < pinned.length) {
      result.push(pinned[pinnedIdx].id);
      pinnedIdx++;
    }
  }

  for (let i = 0; i < result.length; i++) {
    layer[i] = result[i];
    g.nodes.get(result[i])!.order = i;
  }
}

function countAllCrossings(g: Graph): number {
  let total = 0;
  for (let i = 0; i < g.layers.length - 1; i++) {
    total += countCrossingsBetween(g, i);
  }
  return total;
}

function countCrossingsBetween(g: Graph, layerIdx: number): number {
  const pairs: [number, number][] = [];
  for (const id of g.layers[layerIdx]) {
    const srcOrder = g.nodes.get(id)!.order;
    for (const e of g.out.get(id) ?? []) {
      const dst = g.nodes.get(e.dst);
      if (dst && dst.layer === layerIdx + 1) {
        pairs.push([srcOrder, dst.order]);
      }
    }
  }

  let crossings = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) {
        crossings++;
      }
    }
  }
  return crossings;
}

function snapshotOrder(g: Graph): Map<string, number> {
  const snap = new Map<string, number>();
  for (const [id, node] of g.nodes) snap.set(id, node.order);
  return snap;
}

function restoreOrder(g: Graph, snap: Map<string, number>): void {
  for (const [id, order] of snap) {
    const node = g.nodes.get(id);
    if (node) node.order = order;
  }
  for (const layer of g.layers) {
    layer.sort((a, b) => g.nodes.get(a)!.order - g.nodes.get(b)!.order);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 7- Coordinate assignment
// ═══════════════════════════════════════════════════════════════════════════

function assignCoordinates(
  g: Graph,
  opts: { layerGap: number; nodeGap: number },
): void {
  // --- X: cumulative layer widths ---
  let x = 0;
  for (let i = 0; i < g.layers.length; i++) {
    const layer = g.layers[i];
    let maxW = 2; // minimum column width
    for (const id of layer) {
      maxW = Math.max(maxW, g.nodes.get(id)!.width);
    }

    let y = 0;
    for (const id of layer) {
      const node = g.nodes.get(id)!;
      node.x = Math.round(x);
      node.y = Math.round(y);
      y += Math.max(node.height, 1) + opts.nodeGap;
    }

    x += maxW + opts.layerGap;
  }

  // --- Centre layers vertically around the tallest ---
  let maxH = 0;
  for (const layer of g.layers) {
    if (layer.length === 0) continue;
    const last = g.nodes.get(layer[layer.length - 1])!;
    maxH = Math.max(maxH, last.y + last.height);
  }

  for (const layer of g.layers) {
    if (layer.length === 0) continue;
    const last = g.nodes.get(layer[layer.length - 1])!;
    const h = last.y + last.height;
    const offset = Math.round((maxH - h) / 2);
    for (const id of layer) {
      g.nodes.get(id)!.y += offset;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 8- Apply positions + collision-aware orthogonal wire routing
// ═══════════════════════════════════════════════════════════════════════════

/** Padded bounding box for collision tests. */
interface BBox {
  x: number;
  y: number;
  r: number; // x + width
  b: number; // y + height
}

/** Minimum clearance (grid units) between a wire and a component body. */
const BODY_PAD = 1;

/** Horizontal run-out before a feedback wire turns vertical. */
const FEEDBACK_EXIT = 2;

/** Minimum stub extension from a pin before any dogleg (grid units). */
const PIN_STUB = 1;

/**
 * Determine which direction a wire should exit a pin, based on
 * the pin's position relative to its component's bounding box.
 * Returns a unit vector pointing away from the component body.
 */
function pinExitDelta(
  el: CircuitElement,
  pin: Pin,
): { dx: number; dy: number } {
  const bb = el.getBoundingBox();
  const wp = pinWorldPosition(el, pin);
  const dL = Math.abs(wp.x - bb.x);
  const dR = Math.abs(wp.x - (bb.x + bb.width));
  const dT = Math.abs(wp.y - bb.y);
  const dB = Math.abs(wp.y - (bb.y + bb.height));
  const min = Math.min(dL, dR, dT, dB);
  if (min === dL) return { dx: -1, dy: 0 };
  if (min === dR) return { dx: 1, dy: 0 };
  if (min === dT) return { dx: 0, dy: -1 };
  if (min === dB) return { dx: 0, dy: 1 };
  return pin.direction === PinDirection.OUTPUT
    ? { dx: 1, dy: 0 }
    : { dx: -1, dy: 0 };
}

function applyLayout(g: Graph, circuit: Circuit): void {
  const elMap = new Map<string, CircuitElement>();
  for (const el of circuit.elements) elMap.set(el.instanceId, el);

  // Reposition elements
  for (const node of g.nodes.values()) {
    if (node.element) {
      node.element.position = { x: node.x, y: node.y };
    }
  }

  // Compute padded bounding boxes for collision avoidance
  const boxes: BBox[] = [];
  let layoutMinY = Infinity;
  let layoutMaxY = -Infinity;
  for (const el of circuit.elements) {
    const bb = el.getBoundingBox();
    const box: BBox = {
      x: bb.x - BODY_PAD,
      y: bb.y - BODY_PAD,
      r: bb.x + bb.width + BODY_PAD,
      b: bb.y + bb.height + BODY_PAD,
    };
    boxes.push(box);
    layoutMinY = Math.min(layoutMinY, box.y);
    layoutMaxY = Math.max(layoutMaxY, box.b);
  }

  // Clear all wires
  circuit.wires.length = 0;

  // Track how many feedback wires are routed above/below so they don't
  // overlap each other- each gets its own channel offset.
  let feedbackAboveCount = 0;
  let feedbackBelowCount = 0;

  // Track vertical wire channels so subsequent Z-routes don't overlap
  const usedChannels: VChannel[] = [];

  // Route each connection
  for (const conn of g.conns) {
    const srcEl = elMap.get(conn.srcId);
    const dstEl = elMap.get(conn.dstId);
    if (!srcEl || !dstEl) continue;

    const srcPin = srcEl.getPins().find((p) => p.label === conn.srcPin);
    const dstPin = dstEl.getPins().find((p) => p.label === conn.dstPin);
    if (!srcPin || !dstPin) continue;

    const from = pinWorldPosition(srcEl, srcPin);
    const to = pinWorldPosition(dstEl, dstPin);

    // Compute stub points: extend PIN_STUB grid units in the pin's exit
    // direction before any dogleg.  This guarantees that top/bottom pins
    // start with a vertical segment and left/right pins start horizontal.
    const srcDir = pinExitDelta(srcEl, srcPin);
    const dstDir = pinExitDelta(dstEl, dstPin);
    const fromStub = {
      x: from.x + srcDir.dx * PIN_STUB,
      y: from.y + srcDir.dy * PIN_STUB,
    };
    const toStub = {
      x: to.x + dstDir.dx * PIN_STUB,
      y: to.y + dstDir.dy * PIN_STUB,
    };

    // Emit pin-to-stub wires (straight extension from pin)
    pushWire(circuit, from, fromStub);
    pushWire(circuit, to, toStub);

    if (from.x >= to.x) {
      // --- Feedback path: exit, loop around layout, re-enter ---
      const avgY = (from.y + to.y) / 2;
      const centerY = (layoutMinY + layoutMaxY) / 2;
      const goBelow = avgY <= centerY;

      let routeY: number;
      if (goBelow) {
        routeY = layoutMaxY + 1 + feedbackBelowCount * 2;
        feedbackBelowCount++;
      } else {
        routeY = layoutMinY - 1 - feedbackAboveCount * 2;
        feedbackAboveCount++;
      }

      const exitX = Math.max(fromStub.x, from.x + FEEDBACK_EXIT);
      const entryX = Math.min(toStub.x, to.x - FEEDBACK_EXIT);

      // fromStub → exit column → feedback channel → entry column → toStub
      pushWire(circuit, fromStub, { x: exitX, y: fromStub.y });
      pushWire(circuit, { x: exitX, y: fromStub.y }, { x: exitX, y: routeY });
      pushWire(circuit, { x: exitX, y: routeY }, { x: entryX, y: routeY });
      pushWire(circuit, { x: entryX, y: routeY }, { x: entryX, y: toStub.y });
      pushWire(circuit, { x: entryX, y: toStub.y }, toStub);
      continue;
    }

    // --- Forward path: route through dummy waypoints with body avoidance ---
    const waypoints: { x: number; y: number }[] = [];
    const prefix1 = `__d_${conn.srcId}_${conn.dstId}_`;
    const prefix2 = `__d_${conn.dstId}_${conn.srcId}_`;
    for (const [id, node] of g.nodes) {
      if (id.startsWith(prefix1) || id.startsWith(prefix2)) {
        waypoints.push({ x: node.x, y: node.y });
      }
    }
    waypoints.sort((a, b) => a.x - b.x);

    const points = [fromStub, ...waypoints, toStub];
    for (let i = 0; i < points.length - 1; i++) {
      routeSegmentSafe(circuit, points[i], points[i + 1], boxes, usedChannels);
    }
  }
}

/** Add a wire, skipping zero-length segments. */
function pushWire(
  circuit: Circuit,
  a: { x: number; y: number },
  b: { x: number; y: number },
): void {
  if (a.x === b.x && a.y === b.y) return;
  circuit.wires.push(new Wire(a, b));
}

/** An occupied vertical wire channel: x position with y-span. */
interface VChannel {
  x: number;
  yMin: number;
  yMax: number;
}

/**
 * Route a single forward segment with body-collision avoidance.
 *
 * Aligned segments are checked for body crossings and detoured if
 * needed.  Non-aligned segments become Z-shapes whose vertical
 * channel AND horizontal runs are verified clear of component bodies
 * and previously routed channels.
 */
function routeSegmentSafe(
  circuit: Circuit,
  a: { x: number; y: number },
  b: { x: number; y: number },
  boxes: BBox[],
  usedChannels: VChannel[],
): void {
  // --- Aligned vertical ---
  if (a.x === b.x) {
    const yMin = Math.min(a.y, b.y);
    const yMax = Math.max(a.y, b.y);
    if (isVerticalClear(a.x, yMin, yMax, boxes)) {
      circuit.wires.push(new Wire(a, b));
      return;
    }
    // Blocked- detour with a horizontal jog
    for (let off = 1; off <= 10; off++) {
      for (const dx of [off, -off]) {
        const jx = a.x + dx;
        if (
          isVerticalClear(jx, yMin, yMax, boxes) &&
          isHorizontalClear(a.y, Math.min(a.x, jx), Math.max(a.x, jx), boxes) &&
          isHorizontalClear(b.y, Math.min(a.x, jx), Math.max(a.x, jx), boxes)
        ) {
          pushWire(circuit, a, { x: jx, y: a.y });
          pushWire(circuit, { x: jx, y: a.y }, { x: jx, y: b.y });
          pushWire(circuit, { x: jx, y: b.y }, b);
          return;
        }
      }
    }
    circuit.wires.push(new Wire(a, b)); // fallback
    return;
  }

  // --- Aligned horizontal ---
  if (a.y === b.y) {
    const xMin = Math.min(a.x, b.x);
    const xMax = Math.max(a.x, b.x);
    if (isHorizontalClear(a.y, xMin, xMax, boxes)) {
      circuit.wires.push(new Wire(a, b));
      return;
    }
    // Blocked- detour with a vertical jog
    for (let off = 1; off <= 10; off++) {
      for (const dy of [off, -off]) {
        const jy = a.y + dy;
        if (
          isHorizontalClear(jy, xMin, xMax, boxes) &&
          isVerticalClear(a.x, Math.min(a.y, jy), Math.max(a.y, jy), boxes) &&
          isVerticalClear(b.x, Math.min(a.y, jy), Math.max(a.y, jy), boxes)
        ) {
          pushWire(circuit, a, { x: a.x, y: jy });
          pushWire(circuit, { x: a.x, y: jy }, { x: b.x, y: jy });
          pushWire(circuit, { x: b.x, y: jy }, b);
          return;
        }
      }
    }
    circuit.wires.push(new Wire(a, b)); // fallback
    return;
  }

  // --- Non-aligned: Z-route with full clearance (vertical + horizontal) ---
  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);
  let midX = Math.round((a.x + b.x) / 2);

  if (!isZRouteClear(a.x, a.y, b.x, b.y, midX, boxes, usedChannels)) {
    const limit = Math.abs(b.x - a.x) + 5;
    let found = false;
    for (let offset = 1; offset <= limit; offset++) {
      const xp = midX + offset;
      if (isZRouteClear(a.x, a.y, b.x, b.y, xp, boxes, usedChannels)) {
        midX = xp;
        found = true;
        break;
      }
      const xm = midX - offset;
      if (isZRouteClear(a.x, a.y, b.x, b.y, xm, boxes, usedChannels)) {
        midX = xm;
        found = true;
        break;
      }
    }
    // Fallback: body-only clearance (ignore channel overlaps)
    if (!found) {
      midX = Math.round((a.x + b.x) / 2);
      if (!isZRouteBodyClear(a.x, a.y, b.x, b.y, midX, boxes)) {
        for (let offset = 1; offset <= limit; offset++) {
          if (isZRouteBodyClear(a.x, a.y, b.x, b.y, midX + offset, boxes)) {
            midX = midX + offset;
            break;
          }
          if (isZRouteBodyClear(a.x, a.y, b.x, b.y, midX - offset, boxes)) {
            midX = midX - offset;
            break;
          }
        }
      }
    }
  }

  // Record this vertical channel so later wires avoid it
  usedChannels.push({ x: midX, yMin, yMax });

  // Emit the Z-shape (or L-shape if midX aligns with an endpoint)
  if (midX === a.x) {
    pushWire(circuit, a, { x: a.x, y: b.y });
    pushWire(circuit, { x: a.x, y: b.y }, b);
  } else if (midX === b.x) {
    pushWire(circuit, a, { x: b.x, y: a.y });
    pushWire(circuit, { x: b.x, y: a.y }, b);
  } else {
    pushWire(circuit, a, { x: midX, y: a.y });
    pushWire(circuit, { x: midX, y: a.y }, { x: midX, y: b.y });
    pushWire(circuit, { x: midX, y: b.y }, b);
  }
}

/** Check if a vertical channel at x overlapping [yMin, yMax] is already used. */
function isChannelOccupied(
  x: number,
  yMin: number,
  yMax: number,
  channels: VChannel[],
): boolean {
  for (const ch of channels) {
    if (ch.x === x && yMax >= ch.yMin && yMin <= ch.yMax) {
      return true;
    }
  }
  return false;
}

/** Test whether a vertical line at x, spanning [yMin, yMax], is clear of all boxes. */
function isVerticalClear(
  x: number,
  yMin: number,
  yMax: number,
  boxes: BBox[],
): boolean {
  for (const box of boxes) {
    if (x >= box.x && x <= box.r && yMax >= box.y && yMin <= box.b) {
      return false;
    }
  }
  return true;
}

/**
 * Test whether a horizontal line at y, spanning [xMin, xMax], is clear of
 * all boxes.  Uses strict inequality so that wires exactly at the padded
 * boundary (where pin stubs land) are allowed through.
 */
function isHorizontalClear(
  y: number,
  xMin: number,
  xMax: number,
  boxes: BBox[],
): boolean {
  for (const box of boxes) {
    if (y > box.y && y < box.b && xMax > box.x && xMin < box.r) {
      return false;
    }
  }
  return true;
}

/**
 * Check whether all three segments of a Z-route (horizontal-vertical-
 * horizontal) avoid component bodies and previously used channels.
 */
function isZRouteClear(
  ax: number, ay: number,
  bx: number, by: number,
  midX: number,
  boxes: BBox[],
  usedChannels: VChannel[],
): boolean {
  const yMin = Math.min(ay, by);
  const yMax = Math.max(ay, by);
  if (!isVerticalClear(midX, yMin, yMax, boxes)) return false;
  if (isChannelOccupied(midX, yMin, yMax, usedChannels)) return false;
  if (ax !== midX) {
    if (!isHorizontalClear(ay, Math.min(ax, midX), Math.max(ax, midX), boxes)) return false;
  }
  if (midX !== bx) {
    if (!isHorizontalClear(by, Math.min(midX, bx), Math.max(midX, bx), boxes)) return false;
  }
  return true;
}

/** Body-only variant of isZRouteClear (ignores channel overlaps). */
function isZRouteBodyClear(
  ax: number, ay: number,
  bx: number, by: number,
  midX: number,
  boxes: BBox[],
): boolean {
  const yMin = Math.min(ay, by);
  const yMax = Math.max(ay, by);
  if (!isVerticalClear(midX, yMin, yMax, boxes)) return false;
  if (ax !== midX) {
    if (!isHorizontalClear(ay, Math.min(ax, midX), Math.max(ax, midX), boxes)) return false;
  }
  if (midX !== bx) {
    if (!isHorizontalClear(by, Math.min(midX, bx), Math.max(midX, bx), boxes)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════

function spliceItem<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i !== -1) arr.splice(i, 1);
}
