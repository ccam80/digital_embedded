/**
 * Node mapping for analog circuit compilation.
 *
 * Assigns integer MNA node IDs to circuit wire groups using union-find
 * (path-compressed disjoint-set union). Ground is always node ID 0.
 * All other connected wire groups receive unique IDs starting at 1.
 *
 * The node map is used by the analog compiler to bind AnalogElement
 * nodeIndices to their correct MNA matrix rows/columns.
 */

import type { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { Point } from "../core/renderer-interface.js";
import { pinWorldPosition } from "../core/pin.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { SolverDiagnostic } from "../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// NodeMap type
// ---------------------------------------------------------------------------

/**
 * Result of `buildNodeMap()`.
 *
 * Provides the complete mapping from wire segments, component labels, and
 * circuit elements to MNA node IDs needed by the analog compiler.
 */
export interface NodeMap {
  /** Number of non-ground MNA nodes (node IDs 1 … nodeCount). */
  nodeCount: number;

  /**
   * Number of branch-current rows introduced by voltage sources and inductors.
   * Determined by the analog compiler after elements are instantiated;
   * `buildNodeMap` always sets this to 0 — the compiler fills it in.
   */
  branchCount: number;

  /** Total MNA matrix dimension: nodeCount + branchCount. */
  matrixSize: number;

  /** Maps every wire segment to its MNA node ID. */
  wireToNodeId: Map<Wire, number>;

  /**
   * Maps In / Out / Probe component labels to the MNA node ID of the wire
   * connected to their signal pin.
   */
  labelToNodeId: Map<string, number>;

  /**
   * Per-element ordered list of MNA node IDs matching pin order.
   * Populated by the analog compiler; `buildNodeMap` returns this as empty.
   */
  elementNodes: Map<CircuitElement, number[]>;

  /**
   * Maps world-space position keys ("x,y") to MNA node IDs.
   * Includes both wire endpoints and component pin positions.
   * Used by resolveElementNodes to find node IDs for pins that
   * overlap other pins without an explicit wire.
   */
  positionToNodeId: Map<string, number>;

  /** Any diagnostics emitted during node mapping (e.g. missing ground). */
  diagnostics: SolverDiagnostic[];
}

// ---------------------------------------------------------------------------
// Union-Find helpers
// ---------------------------------------------------------------------------

/** Find root with path compression. */
function find(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]]; // path halving
    i = parent[i];
  }
  return i;
}

/** Union by rank. Returns the new root. */
function union(parent: number[], rank: number[], a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra === rb) return;
  if (rank[ra] < rank[rb]) {
    parent[ra] = rb;
  } else if (rank[ra] > rank[rb]) {
    parent[rb] = ra;
  } else {
    parent[rb] = ra;
    rank[ra]++;
  }
}

// ---------------------------------------------------------------------------
// Point key helpers
// ---------------------------------------------------------------------------

function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

// ---------------------------------------------------------------------------
// buildNodeMap
// ---------------------------------------------------------------------------

/**
 * Build the MNA node map for a circuit.
 *
 * Algorithm:
 * 1. Assign each wire endpoint a unique integer ID.
 * 2. Union each wire's start and end endpoint IDs.
 * 3. Find which endpoint group connects to a Ground element's pin.
 *    - If none found, emit a `no-ground` diagnostic and assign node 0 to the
 *      most-connected group.
 * 4. Walk every group: ground group → node 0, others → 1, 2, 3, …
 * 5. Map wires and component labels.
 *
 * @param circuit - The visual circuit model to analyse.
 * @returns A `NodeMap` with wire-to-node and label-to-node mappings.
 */
export function buildNodeMap(circuit: Circuit): NodeMap {
  const diagnostics: SolverDiagnostic[] = [];

  // -------------------------------------------------------------------------
  // Step 1: collect all unique endpoint positions across all wires
  // -------------------------------------------------------------------------
  const pointToId = new Map<string, number>();
  let nextId = 0;

  function getOrCreateId(p: Point): number {
    const k = pointKey(p);
    let id = pointToId.get(k);
    if (id === undefined) {
      id = nextId++;
      pointToId.set(k, id);
    }
    return id;
  }

  const wireStartIds: number[] = [];
  const wireEndIds: number[] = [];

  for (const wire of circuit.wires) {
    wireStartIds.push(getOrCreateId(wire.start));
    wireEndIds.push(getOrCreateId(wire.end));
  }

  // -------------------------------------------------------------------------
  // Step 2: union-find — each wire merges its two endpoints into one group
  // -------------------------------------------------------------------------
  const total = nextId;
  const parent = Array.from({ length: total }, (_, i) => i);
  const rank = new Array<number>(total).fill(0);

  for (let i = 0; i < circuit.wires.length; i++) {
    union(parent, rank, wireStartIds[i], wireEndIds[i]);
  }

  // Add component pin world positions to the point set so that overlapping
  // pins (two component pins at the same position) share the same union-find
  // ID — no explicit wire needed. getOrCreateId returns the existing ID when
  // a wire endpoint or another pin already occupies the same position.
  for (const el of circuit.elements) {
    const pins = el.getPins();
    for (const pin of pins) {
      const wp = pinWorldPosition(el, pin);
      const pinId = getOrCreateId(wp);
      // Grow union-find arrays for any newly created IDs
      while (parent.length <= pinId) {
        parent.push(parent.length);
        rank.push(0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: identify ground group
  // -------------------------------------------------------------------------
  const groundElements = circuit.elements.filter(
    (el) => el.typeId === "Ground",
  );

  let groundRoots = new Set<number>();

  for (const gnd of groundElements) {
    for (const pin of gnd.getPins()) {
      // Use world position (element pos + pin offset) to match wire endpoints.
      // pin.position is local; pinWorldPosition applies rotation/mirror/offset.
      const wp = pinWorldPosition(gnd, pin);
      const id = pointToId.get(pointKey(wp));
      if (id !== undefined) {
        groundRoots.add(find(parent, id));
      }
    }
  }

  if (groundRoots.size === 0 && total > 0) {
    // No ground found — pick the most-connected group as ground (best effort)
    // and emit a diagnostic.
    const groupCount = new Map<number, number>();
    for (let i = 0; i < total; i++) {
      const root = find(parent, i);
      groupCount.set(root, (groupCount.get(root) ?? 0) + 1);
    }
    let bestRoot = 0;
    let bestCount = 0;
    for (const [root, count] of groupCount) {
      if (count > bestCount) {
        bestCount = count;
        bestRoot = root;
      }
    }
    groundRoots.add(bestRoot);

    diagnostics.push(
      makeDiagnostic(
        "no-ground",
        "warning",
        "No Ground element found in circuit",
        {
          explanation:
            "MNA simulation requires a ground reference node. " +
            "The most-connected wire group has been assigned as ground (node 0). " +
            "Add a Ground element to suppress this warning.",
          suggestions: [
            {
              text: "Add a Ground element connected to the reference node.",
              automatable: false,
            },
          ],
        },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: assign MNA node IDs
  //   ground group(s) → 0
  //   all other groups → 1, 2, 3, …
  // -------------------------------------------------------------------------
  const rootToNodeId = new Map<number, number>();
  let nextNodeId = 1;

  // Pre-assign ground roots to 0
  for (const gr of groundRoots) {
    rootToNodeId.set(gr, 0);
  }

  // Assign remaining roots in order of first encounter
  for (let i = 0; i < total; i++) {
    const root = find(parent, i);
    if (!rootToNodeId.has(root)) {
      rootToNodeId.set(root, nextNodeId++);
    }
  }

  const nodeCount = nextNodeId - 1; // IDs 1 … nextNodeId-1

  // -------------------------------------------------------------------------
  // Step 5: build wireToNodeId map
  // -------------------------------------------------------------------------
  const wireToNodeId = new Map<Wire, number>();

  for (let i = 0; i < circuit.wires.length; i++) {
    const root = find(parent, wireStartIds[i]);
    const nodeId = rootToNodeId.get(root) ?? 0;
    wireToNodeId.set(circuit.wires[i], nodeId);
  }

  // -------------------------------------------------------------------------
  // Step 6: build labelToNodeId map
  //   Walk In, Out, and Probe elements; look up the node ID of their pin.
  // -------------------------------------------------------------------------
  const labelToNodeId = new Map<string, number>();
  const labelTypes = new Set(["In", "Out", "Probe", "in", "out", "probe"]);

  for (const el of circuit.elements) {
    if (!labelTypes.has(el.typeId)) continue;

    let label: string | undefined;
    const props = el.getProperties();
    if (props.has("label")) {
      label = String(props.get("label"));
    }
    if (!label) continue;

    // Find the node ID for any pin of this element (use world position)
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      const id = pointToId.get(pointKey(wp));
      if (id !== undefined) {
        const root = find(parent, id);
        const nodeId = rootToNodeId.get(root) ?? 0;
        labelToNodeId.set(label, nodeId);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: build positionToNodeId map — all positions → MNA node ID
  // -------------------------------------------------------------------------
  const positionToNodeId = new Map<string, number>();
  for (const [key, id] of pointToId) {
    const root = find(parent, id);
    const nodeId = rootToNodeId.get(root) ?? 0;
    positionToNodeId.set(key, nodeId);
  }

  return {
    nodeCount,
    branchCount: 0,
    matrixSize: nodeCount,
    wireToNodeId,
    labelToNodeId,
    positionToNodeId,
    elementNodes: new Map(),
    diagnostics,
  };
}
