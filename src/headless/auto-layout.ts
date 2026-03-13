/**
 * Auto-layout engine for programmatically-built circuits.
 *
 * Implements Sugiyama-style layered graph layout optimised for digital
 * circuit schematics with up to ~100 components:
 *
 *   1. Cycle removal — DFS back-edge reversal
 *   2. Layer assignment — longest-path from sources
 *   3. Sink promotion — align outputs on the rightmost column
 *   4. Dummy node insertion — for multi-layer crossing reduction
 *   5. Crossing reduction — barycenter heuristic, bidirectional sweeps,
 *      best-of tracking
 *   6. Coordinate assignment — size-aware spacing with vertical centering
 *   7. Orthogonal wire routing — Z-shaped segments, waypoints through
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

export interface LayoutOptions {
  /** Horizontal gap between layer columns (grid units). Default: 8 */
  layerGap?: number;
  /** Minimum vertical gap between node centres (grid units). Default: 3 */
  nodeGap?: number;
  /** Number of crossing-reduction sweep passes. Default: 8 */
  sweeps?: number;
}

/**
 * Reposition every element in `circuit` using Sugiyama layered layout and
 * replace all wires with orthogonally-routed segments.
 *
 * Mutates the circuit in place.
 */
export function autoLayout(circuit: Circuit, options?: LayoutOptions): void {
  const opts: Required<LayoutOptions> = {
    layerGap: options?.layerGap ?? 8,
    nodeGap: options?.nodeGap ?? 3,
    sweeps: options?.sweeps ?? 8,
  };

  if (circuit.elements.length === 0) return;

  const g = buildGraph(circuit);
  if (g.nodes.size === 0) return;

  breakCycles(g);
  assignLayers(g);
  promoteSinks(g);
  insertDummies(g);
  buildLayerArrays(g);
  reduceCrossings(g, opts.sweeps);
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

/** Pin-level connection record — survives edge reversal / splitting. */
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
// Step 1 — Build directed graph from circuit wires
// ═══════════════════════════════════════════════════════════════════════════

function buildGraph(circuit: Circuit): Graph {
  // Index: world-position key → (element, pin)
  const posMap = new Map<string, { el: CircuitElement; pin: Pin }>();
  for (const el of circuit.elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      posMap.set(`${wp.x},${wp.y}`, { el, pin });
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
    const a = posMap.get(`${wire.start.x},${wire.start.y}`);
    const b = posMap.get(`${wire.end.x},${wire.end.y}`);
    if (!a || !b || a.el === b.el) continue;

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
// Step 2 — Break cycles via DFS back-edge reversal
// ═══════════════════════════════════════════════════════════════════════════

function breakCycles(g: Graph): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of g.nodes.keys()) color.set(id, WHITE);

  function dfs(u: string): void {
    color.set(u, GRAY);
    // Copy list — reverseEdge mutates the adjacency array
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
// Step 3 — Layer assignment (longest path from sources)
// ═══════════════════════════════════════════════════════════════════════════

function assignLayers(g: Graph): void {
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 3b — Promote sinks to the rightmost layer
// ═══════════════════════════════════════════════════════════════════════════

function promoteSinks(g: Graph): void {
  let maxLayer = 0;
  for (const n of g.nodes.values()) {
    maxLayer = Math.max(maxLayer, n.layer);
  }
  for (const [id, outs] of g.out) {
    if (outs.length === 0 && (g.in_.get(id)?.length ?? 0) > 0) {
      g.nodes.get(id)!.layer = maxLayer;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 4 — Insert dummy nodes for edges spanning multiple layers
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
// Step 5 — Build layer arrays and set initial order
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
// Step 6 — Crossing reduction (barycenter, best-of tracking)
// ═══════════════════════════════════════════════════════════════════════════

function reduceCrossings(g: Graph, sweeps: number): void {
  let bestOrder = snapshotOrder(g);
  let bestCrossings = countAllCrossings(g);

  for (let s = 0; s < sweeps; s++) {
    // Forward sweep
    for (let i = 1; i < g.layers.length; i++) {
      reorderLayer(g, i, 'left');
    }
    // Backward sweep
    for (let i = g.layers.length - 2; i >= 0; i--) {
      reorderLayer(g, i, 'right');
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
): void {
  const layer = g.layers[layerIdx];
  const bc = new Map<string, number>();

  for (const id of layer) {
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

  layer.sort((a, b) => bc.get(a)! - bc.get(b)!);
  layer.forEach((id, i) => {
    g.nodes.get(id)!.order = i;
  });
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
// Step 7 — Coordinate assignment
// ═══════════════════════════════════════════════════════════════════════════

function assignCoordinates(
  g: Graph,
  opts: Required<LayoutOptions>,
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
// Step 8 — Apply positions + collision-aware orthogonal wire routing
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
  // overlap each other — each gets its own channel offset.
  let feedbackAboveCount = 0;
  let feedbackBelowCount = 0;

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

    if (from.x >= to.x) {
      // --- Feedback path: must exit right, clear body, loop around ---
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

      const exitX = from.x + FEEDBACK_EXIT;
      const entryX = to.x - FEEDBACK_EXIT;

      // from → right (clear body) → vertical → left → vertical → to
      pushWire(circuit, from, { x: exitX, y: from.y });
      pushWire(circuit, { x: exitX, y: from.y }, { x: exitX, y: routeY });
      pushWire(circuit, { x: exitX, y: routeY }, { x: entryX, y: routeY });
      pushWire(circuit, { x: entryX, y: routeY }, { x: entryX, y: to.y });
      pushWire(circuit, { x: entryX, y: to.y }, to);
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

    const points = [from, ...waypoints, to];
    for (let i = 0; i < points.length - 1; i++) {
      routeSegmentSafe(circuit, points[i], points[i + 1], boxes);
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

/**
 * Route a single forward segment with body-collision avoidance.
 *
 * Aligned segments are emitted directly. Non-aligned segments become
 * Z-shapes whose vertical channel is shifted left/right if it would
 * intersect a component bounding box.
 */
function routeSegmentSafe(
  circuit: Circuit,
  a: { x: number; y: number },
  b: { x: number; y: number },
  boxes: BBox[],
): void {
  if (a.x === b.x || a.y === b.y) {
    circuit.wires.push(new Wire(a, b));
    return;
  }

  // Find a clear vertical channel between a.x and b.x
  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);
  let midX = Math.round((a.x + b.x) / 2);

  if (!isVerticalClear(midX, yMin, yMax, boxes)) {
    // Search outward from midpoint for a clear channel
    const limit = Math.abs(b.x - a.x) + 5;
    for (let offset = 1; offset <= limit; offset++) {
      if (isVerticalClear(midX + offset, yMin, yMax, boxes)) {
        midX = midX + offset;
        break;
      }
      if (isVerticalClear(midX - offset, yMin, yMax, boxes)) {
        midX = midX - offset;
        break;
      }
    }
  }

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

// ═══════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════

function spliceItem<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i !== -1) arr.splice(i, 1);
}
