/**
 * Net resolver — traces wire connections to determine which pins are
 * electrically connected, forming nets.
 *
 * Starting from the visual Circuit model (elements + wires), connectivity is
 * determined by matching wire endpoints to pin positions and wire-to-wire
 * junctions. Tunnel components with the same label are merged into one net.
 *
 * Java reference: de.neemann.digital.core.Net.interconnect (adapted for our
 * pre-compilation, flat-array architecture).
 */

import type { Circuit } from "@/core/circuit.js";
import type { CircuitElement } from "@/core/element.js";
import type { Pin } from "@/core/pin.js";
import type { ComponentRegistry } from "@/core/registry.js";
import { BitsException } from "@/core/errors.js";

// ---------------------------------------------------------------------------
// PinRef — a resolved pin instance on a placed component
// ---------------------------------------------------------------------------

export interface PinRef {
  readonly element: CircuitElement;
  readonly pin: Pin;
}

// ---------------------------------------------------------------------------
// ResolvedNet — one electrically-connected group of pins
// ---------------------------------------------------------------------------

export interface ResolvedNet {
  /** Sequential net ID (0-based). */
  readonly netId: number;
  /** All pins belonging to this net. */
  readonly pins: PinRef[];
  /** Number of output (driver) pins on this net. */
  readonly driverCount: number;
  /** Bit width shared by all pins on this net. */
  readonly bitWidth: number;
  /** True when multiple output pins drive this net (needs bus resolution). */
  readonly needsBus: boolean;
}

// ---------------------------------------------------------------------------
// NetResolution — result of resolveNets()
// ---------------------------------------------------------------------------

export interface NetResolution {
  readonly nets: ResolvedNet[];
  /** Non-fatal warnings (e.g. unconnected input pins). */
  readonly warnings: string[];
}

// ---------------------------------------------------------------------------
// UnionFind — efficient net merging via union-find (path compression + rank)
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly _parent: number[];
  private readonly _rank: number[];
  private _size: number;

  constructor(initialSize: number) {
    this._parent = Array.from({ length: initialSize }, (_, i) => i);
    this._rank = new Array<number>(initialSize).fill(0);
    this._size = initialSize;
  }

  /** Allocate a new node and return its index. */
  addNode(): number {
    const idx = this._size++;
    this._parent.push(idx);
    this._rank.push(0);
    return idx;
  }

  find(x: number): number {
    while (this._parent[x] !== x) {
      // Path halving
      this._parent[x] = this._parent[this._parent[x]!]!;
      x = this._parent[x]!;
    }
    return x;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this._rank[ra]! < this._rank[rb]!) {
      this._parent[ra] = rb;
    } else if (this._rank[ra]! > this._rank[rb]!) {
      this._parent[rb] = ra;
    } else {
      this._parent[rb] = ra;
      (this._rank[ra] as number)++;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveNets — main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve all nets in a visual circuit.
 *
 * Algorithm:
 * 1. Collect all pin positions (world-space) and assign each pin a node index.
 * 2. Union pins that share the same grid position (junctions).
 * 3. For each wire: union its two endpoints. Endpoints that match pin positions
 *    resolve to those pin nodes. Bare wire endpoints get virtual nodes; chained
 *    wires sharing an endpoint reuse the same virtual node.
 * 4. Resolve Tunnel components: all Tunnels with the same label in the same
 *    circuit are unioned into one net.
 * 5. Group pin nodes by union-find root to form nets.
 * 6. Validate bit widths within each net; throw BitsException on mismatch.
 * 7. Classify nets: detect multi-driver (needsBus) and unconnected inputs
 *    (warning).
 */
export function resolveNets(
  circuit: Circuit,
  registry: ComponentRegistry,
): NetResolution {
  // -------------------------------------------------------------------------
  // Step 1: assign a node index to every pin instance
  // -------------------------------------------------------------------------

  interface PinNode {
    readonly element: CircuitElement;
    readonly pin: Pin;
    readonly nodeIndex: number;
  }

  const pinNodes: PinNode[] = [];

  // Map "x,y" string → first pin nodeIndex at that position (for wire lookups)
  const posToFirstPinNode = new Map<string, number>();

  for (const element of circuit.elements) {
    for (const pin of element.getPins()) {
      const key = pointKey(pin.position.x, pin.position.y);
      const nodeIndex = pinNodes.length;
      pinNodes.push({ element, pin, nodeIndex });
      if (!posToFirstPinNode.has(key)) {
        posToFirstPinNode.set(key, nodeIndex);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: union-find over all nodes (pins + virtual wire-endpoint nodes)
  // -------------------------------------------------------------------------

  const uf = new UnionFind(pinNodes.length);

  // Union pins that share the same grid position
  {
    const seenAtPos = new Map<string, number>(); // key → first nodeIndex seen
    for (const pn of pinNodes) {
      const key = pointKey(pn.pin.position.x, pn.pin.position.y);
      const first = seenAtPos.get(key);
      if (first !== undefined) {
        uf.union(first, pn.nodeIndex);
      } else {
        seenAtPos.set(key, pn.nodeIndex);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: trace wires — union endpoints
  // -------------------------------------------------------------------------

  // Virtual nodes represent wire-endpoint positions that have no pin. They are
  // allocated on demand and reused when multiple wires share an endpoint.
  const virtualNodeByPos = new Map<string, number>();

  const resolveWireEndpoint = (key: string): number => {
    // Prefer a pin node at this position
    const pinNode = posToFirstPinNode.get(key);
    if (pinNode !== undefined) return pinNode;
    // Reuse existing virtual node for chained wires
    const existing = virtualNodeByPos.get(key);
    if (existing !== undefined) return existing;
    // Allocate a fresh virtual node
    const newNode = uf.addNode();
    virtualNodeByPos.set(key, newNode);
    return newNode;
  };

  for (const wire of circuit.wires) {
    const startKey = pointKey(wire.start.x, wire.start.y);
    const endKey = pointKey(wire.end.x, wire.end.y);
    const startNode = resolveWireEndpoint(startKey);
    const endNode = resolveWireEndpoint(endKey);
    uf.union(startNode, endNode);
  }

  // Union virtual wire-endpoint nodes with any pin at the same position that
  // was registered after the posToFirstPinNode map was built. (Handles the
  // case where a pin and a wire endpoint share a position.)
  for (const [key, virtualNode] of virtualNodeByPos) {
    const pinNode = posToFirstPinNode.get(key);
    if (pinNode !== undefined) {
      uf.union(pinNode, virtualNode);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Tunnel resolution — merge all Tunnels sharing the same label
  // -------------------------------------------------------------------------

  {
    const tunnelFirstNode = new Map<string, number>(); // label → first pin nodeIndex

    for (const pn of pinNodes) {
      if (pn.element.typeId !== "Tunnel") continue;
      const label = String(pn.element.getAttribute("label") ?? "");
      const existing = tunnelFirstNode.get(label);
      if (existing !== undefined) {
        uf.union(existing, pn.nodeIndex);
      } else {
        tunnelFirstNode.set(label, pn.nodeIndex);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: group pin nodes by union-find root
  // -------------------------------------------------------------------------

  const rootToGroup = new Map<number, PinNode[]>();
  for (const pn of pinNodes) {
    const root = uf.find(pn.nodeIndex);
    let group = rootToGroup.get(root);
    if (group === undefined) {
      group = [];
      rootToGroup.set(root, group);
    }
    group.push(pn);
  }

  // -------------------------------------------------------------------------
  // Step 6 & 7: validate bit widths, classify, and produce ResolvedNet list
  // -------------------------------------------------------------------------

  const nets: ResolvedNet[] = [];
  const warnings: string[] = [];
  let nextNetId = 0;

  for (const [, group] of rootToGroup) {
    // Determine consensus bit width; throw on first mismatch
    let groupBitWidth: number | undefined;

    for (const pn of group) {
      const w = pn.pin.bitWidth;
      if (groupBitWidth === undefined) {
        groupBitWidth = w;
      } else if (w !== groupBitWidth) {
        throw new BitsException(
          `Bit-width mismatch on net: pin "${pn.pin.label}" of element "${pn.element.instanceId}" has width ${w}, expected ${groupBitWidth}`,
          {
            expectedBits: groupBitWidth,
            actualBits: w,
          },
        );
      }
    }

    const bitWidth = groupBitWidth ?? 1;

    // Count output (driver) pins — OUTPUT and BIDIRECTIONAL pins drive the net
    let driverCount = 0;
    for (const pn of group) {
      const dir = pn.pin.direction;
      if (dir === "OUTPUT" || dir === "BIDIRECTIONAL") {
        driverCount++;
      }
    }

    // Warn about unconnected single-pin nets that have an input pin
    if (group.length === 1) {
      const only = group[0]!;
      if (only.pin.direction === "INPUT") {
        warnings.push(
          `Unconnected input pin "${only.pin.label}" on element "${only.element.instanceId}"`,
        );
      }
    }

    nets.push({
      netId: nextNetId++,
      pins: group.map((pn) => ({ element: pn.element, pin: pn.pin })),
      driverCount,
      bitWidth,
      needsBus: driverCount > 1,
    });
  }

  return { nets, warnings };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pointKey(x: number, y: number): string {
  return `${x},${y}`;
}
