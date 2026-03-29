/**
 * Circuit model — visual representation only.
 *
 * Per Decision 3: Circuit is the visual model. No simulation state lives here.
 * No net IDs, no signal values. The compiler (Phase 3) transforms Circuit into
 * CompiledModel, which is what the engine runs.
 */

import type { Point } from "./renderer-interface.js";
import type { Pin } from "./pin.js";
import { pinWorldPosition } from "./pin.js";
import type { CircuitElement } from "./element.js";
import type { LogicFamilyConfig } from "./logic-family.js";
import { mergeCollinearSegments } from "./wire-utils.js";

// ---------------------------------------------------------------------------
// Wire — visual wire segment
// ---------------------------------------------------------------------------

/**
 * A single wire segment on the circuit canvas.
 *
 * Per Decision 3 and Decision 6: no netId, no signal value. The compiler
 * traces wire connectivity and assigns net IDs. The binding layer (Phase 6)
 * holds the Wire → netId mapping for the renderer.
 */
export class Wire {
  /** Bit width of this wire (1 = single-bit, >1 = bus). Set by net resolution. */
  bitWidth: number;

  constructor(
    public start: Point,
    public end: Point,
    bitWidth: number = 1,
  ) {
    this.bitWidth = bitWidth;
  }
}

// ---------------------------------------------------------------------------
// Net — visual connectivity grouping
// ---------------------------------------------------------------------------

/**
 * A set of pins that are electrically connected via wires.
 *
 * This is a pure visual construct used by the editor's net tracer and the
 * compiler. It carries no signal value and no net ID — those belong to
 * CompiledModel.
 */
export class Net {
  private readonly _pins: Set<Pin> = new Set();

  addPin(pin: Pin): void {
    this._pins.add(pin);
  }

  removePin(pin: Pin): void {
    this._pins.delete(pin);
  }

  getPins(): ReadonlySet<Pin> {
    return this._pins;
  }

  get size(): number {
    return this._pins.size;
  }
}

// ---------------------------------------------------------------------------
// CircuitMetadata
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom shape data types (for CUSTOM subcircuit shape mode)
// ---------------------------------------------------------------------------

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type CustomDrawable =
  | { type: "poly"; path: string; evenOdd: boolean; thickness: number; filled: boolean; color: RGBA }
  | { type: "line"; p1: Point; p2: Point; thickness: number; color: RGBA }
  | { type: "circle"; p1: Point; p2: Point; thickness: number; filled: boolean; color: RGBA }
  | { type: "text"; pos: Point; text: string; orientation: string; size: number; color: RGBA };

export interface CustomShapeData {
  pins: Map<string, { pos: { x: number; y: number }; showLabel: boolean }>;
  drawables: CustomDrawable[];
}

// ---------------------------------------------------------------------------
// CircuitMetadata
// ---------------------------------------------------------------------------

/**
 * Persisted trace entry — captures signal identity and panel assignment
 * so watched signals survive save/load cycles.
 */
export interface SavedTrace {
  /** Resolution key: component label for labeled signals, "instanceId:pinLabel" for unlabeled. */
  name: string;
  /** Signal domain at time of save. */
  domain: 'digital' | 'analog';
  /** Which scope panel this trace belongs to. */
  panelIndex: number;
  /** Signal grouping in the data table. */
  group: 'input' | 'output' | 'probe';
}

export interface CircuitMetadata {
  /** Display name for this circuit. */
  name: string;
  /** Optional description shown in the component palette when used as a sub-circuit. */
  description: string;
  /** References to test data files associated with this circuit. */
  testDataRefs: string[];
  /** Ordering of measurement probes for the data table. */
  measurementOrdering: string[];
  /** Whether this circuit uses generic (parameterised) resolution. */
  isGeneric: boolean;
  /** When true, users may not add, move, delete, or edit elements or wires. */
  isLocked: boolean;
  /** Subcircuit chip width in grid units (from Digital's Keys.WIDTH, default 3). */
  chipWidth: number;
  /** Subcircuit chip height in grid units (from Digital's Keys.HEIGHT, default 3). Used by LAYOUT shape. */
  chipHeight: number;
  /** Subcircuit shape type: DEFAULT, DIL, CUSTOM, LAYOUT. */
  shapeType: string;
  /** Custom shape data parsed from the <shape> element in CUSTOM mode subcircuits. */
  customShape?: CustomShapeData;
  /**
   * Logic family configuration for this circuit.
   * When absent, defaultLogicFamily() (CMOS 3.3V) is used by the analog engine.
   */
  logicFamily?: LogicFamilyConfig;
  /**
   * Controls where analog/digital bridge adapters are placed.
   *
   * - `"cross-domain"` (default, absent = this): Bridge adapters at digital/MNA
   *   partition boundaries only. Digital-to-digital connections are ideal.
   * - `"all"`: Every digital-model component pin gets bridge adapters. All wires
   *   become MNA nodes. Full loading everywhere.
   * - `"none"`: Bridges at partition boundaries use ideal conversion — rIn =
   *   Infinity (no input loading), rOut = 0 (ideal voltage source).
   */
  digitalPinLoading?: "cross-domain" | "all" | "none";

  /**
   * Per-net overrides for digital pin loading mode.
   * Each entry identifies a net by stable net ID and overrides the circuit-level
   * digitalPinLoading setting for that net.
   */
  digitalPinLoadingOverrides?: Array<{
    anchor:
      | { type: 'label'; label: string }
      | { type: 'pin'; instanceId: string; pinLabel: string };
    loading: 'loaded' | 'ideal';
  }>;

  /**
   * Named SPICE .MODEL parameter sets imported by the user.
   * Keys are model names (e.g. "2N2222", "1N4148").
   * Values are serialized as { deviceType, params } for persistence.
   */
  namedParameterSets?: Record<string, {
    deviceType: string;
    params: Record<string, number>;
  }>;

  /**
   * Subcircuit model definitions imported from .SUBCKT blocks.
   * Keys are subcircuit names (e.g. "OPAMP", "MYBJT").
   * Values are serialized Circuit JSON for persistence.
   */
  modelDefinitions?: Record<string, {
    /** Port names in order (from the .SUBCKT header). */
    ports: string[];
    /** Serialized element count — informational only; the full Circuit is in SubcircuitModelRegistry. */
    elementCount: number;
  }>;
  /** Maps component instance IDs to their resolved subcircuit model name. */
  subcircuitBindings?: Record<string, string>;

  /** Persisted scope traces — restored after compilation. */
  traces?: SavedTrace[];
}

function defaultCircuitMetadata(): CircuitMetadata {
  return {
    name: "Untitled",
    description: "",
    testDataRefs: [],
    measurementOrdering: [],
    isGeneric: false,
    isLocked: false,
    chipWidth: 3,
    chipHeight: 3,
    shapeType: "",
  };
}

// ---------------------------------------------------------------------------
// Circuit — the top-level visual model
// ---------------------------------------------------------------------------

/**
 * The visual circuit model.
 *
 * Holds placed elements, wire segments, and metadata. This is what the .dig
 * parser produces and what the editor manipulates. Contains zero simulation
 * state — see Decision 3.
 */
export class Circuit {
  readonly elements: CircuitElement[] = [];
  readonly wires: Wire[] = [];
  metadata: CircuitMetadata;

  constructor(metadata?: Partial<CircuitMetadata>) {
    this.metadata = { ...defaultCircuitMetadata(), ...metadata };
  }

  addElement(element: CircuitElement): void {
    this.elements.push(element);
  }

  removeElement(element: CircuitElement): void {
    const index = this.elements.indexOf(element);
    if (index !== -1) {
      this.elements.splice(index, 1);
    }
  }

  addWire(wire: Wire): void {
    if (wire.start.x === wire.end.x && wire.start.y === wire.end.y) {
      // Zero-length wire — skip silently. These are degenerate artifacts
      // from .dig loading, wire merging, or junction splitting that contribute
      // nothing to circuit topology and can cause orphan MNA nodes.
      return;
    }
    this.wires.push(wire);
  }

  removeWire(wire: Wire): void {
    const index = this.wires.indexOf(wire);
    if (index !== -1) {
      this.wires.splice(index, 1);
    }
  }

  /**
   * Remove all zero-length wires (start === end) from the circuit.
   *
   * Zero-length wires contribute nothing to electrical connectivity but can
   * create orphan MNA nodes that cause singular matrices in analog simulation.
   * Call this after loading external files, after wire splitting, or after
   * element deletion to clean up degenerate artifacts.
   *
   * @returns The number of wires removed.
   */
  removeZeroLengthWires(): number {
    let removed = 0;
    for (let i = this.wires.length - 1; i >= 0; i--) {
      const w = this.wires[i]!;
      if (w.start.x === w.end.x && w.start.y === w.end.y) {
        this.wires.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Merge collinear overlapping or adjacent wire segments.
   *
   * Replaces the wire list with the output of mergeCollinearSegments(),
   * which fuses horizontal/vertical wires that share an axis and touch or
   * overlap.  This eliminates duplicate, reversed, and redundant segments
   * that can appear in hand-edited .dig files or after interactive edits.
   *
   * @returns The number of wires removed by merging.
   */
  mergeCollinearWires(): number {
    const before = this.wires.length;
    const merged = mergeCollinearSegments(this.wires);
    this.wires.length = 0;
    for (const w of merged) {
      this.wires.push(w);
    }
    return before - this.wires.length;
  }

  /**
   * Split wires at T-junctions.
   *
   * In Digital's Java editor, when a wire endpoint lands on the interior of
   * another wire, the editor splits the longer wire into two segments at that
   * point. This ensures endpoint-based net resolution sees the connection.
   *
   * .dig files from the original editor always have split wires, but
   * hand-edited or externally-generated files may not.  Call this after
   * loading a .dig file to normalise the wire list.
   */
  splitWiresAtJunctions(extraPoints?: ReadonlySet<string>): void {
    // Collect all "interesting" points: wire endpoints + pin world positions
    const points = new Set<string>();
    for (const wire of this.wires) {
      points.add(`${wire.start.x},${wire.start.y}`);
      points.add(`${wire.end.x},${wire.end.y}`);
    }
    for (const el of this.elements) {
      for (const pin of el.getPins()) {
        const wp = pinWorldPosition(el, pin);
        points.add(`${wp.x},${wp.y}`);
      }
    }
    // Include caller-supplied points (e.g. pre-merge junction points that
    // mergeCollinearWires() may have absorbed into wire interiors).
    if (extraPoints) {
      for (const p of extraPoints) points.add(p);
    }
    this._splitAtPoints(points);
  }

  /**
   * Split wires at an explicit set of points.
   *
   * Like splitWiresAtJunctions but uses the caller-provided point set
   * instead of auto-computing from wire endpoints and pin positions.
   * Used by wire drawing to avoid false junctions at intermediate
   * routing corners.
   */
  splitWiresAtPoints(points: ReadonlySet<string>): void {
    this._splitAtPoints(points);
  }

  /** Internal splitting loop shared by splitWiresAtJunctions and splitWiresAtPoints. */
  private _splitAtPoints(points: ReadonlySet<string>): void {
    // For each wire, check if any point lies strictly on its interior.
    // If so, split the wire at that point into two segments.
    // Repeat until no more splits are needed (a wire may need multiple splits).
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = this.wires.length - 1; i >= 0; i--) {
        const wire = this.wires[i]!;
        const sx = wire.start.x, sy = wire.start.y;
        const ex = wire.end.x, ey = wire.end.y;
        const dx = ex - sx, dy = ey - sy;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        // Find the split point closest to start (lowest t) so we split
        // one segment at a time from the start end.
        let bestT = 2; // > 1 means no split found
        let bestPx = 0, bestPy = 0;

        for (const key of points) {
          const commaIdx = key.indexOf(',');
          const px = +key.slice(0, commaIdx);
          const py = +key.slice(commaIdx + 1);

          if (px === sx && py === sy) continue;
          if (px === ex && py === ey) continue;

          // Collinearity (cross product == 0)
          const cross = dx * (py - sy) - dy * (px - sx);
          if (cross !== 0) continue;

          // Parameterise: t = dot(P-S, E-S) / |E-S|²
          const dot = (px - sx) * dx + (py - sy) * dy;
          if (dot <= 0 || dot >= lenSq) continue;

          const t = dot / lenSq;
          if (t < bestT) {
            bestT = t;
            bestPx = px;
            bestPy = py;
          }
        }

        if (bestT < 1) {
          // Split: replace wire with [start→splitPt] and [splitPt→end]
          const splitPt = { x: bestPx, y: bestPy };
          this.wires.splice(i, 1,
            new Wire(wire.start, splitPt, wire.bitWidth),
            new Wire(splitPt, wire.end, wire.bitWidth),
          );
          changed = true;
        }
      }
    }
  }

  /**
   * Normalize wires: merge collinear segments, then split at junctions.
   *
   * Before merging, snapshots all junction points (where 3+ wire endpoints
   * coincide). After merging absorbs those points into wire interiors, the
   * split pass re-introduces them via the extraPoints parameter.
   */
  normalizeWires(): void {
    // 1. Snapshot junction points: any point where 3+ wire endpoints meet.
    const endpointCount = new Map<string, number>();
    for (const wire of this.wires) {
      const sk = `${wire.start.x},${wire.start.y}`;
      const ek = `${wire.end.x},${wire.end.y}`;
      endpointCount.set(sk, (endpointCount.get(sk) ?? 0) + 1);
      endpointCount.set(ek, (endpointCount.get(ek) ?? 0) + 1);
    }
    const junctionPoints = new Set<string>();
    for (const [key, count] of endpointCount) {
      if (count >= 3) junctionPoints.add(key);
    }

    // 2. Merge collinear/overlapping/duplicate wire segments.
    this.mergeCollinearWires();

    // 3. Split at junctions, including the pre-merge junction points.
    this.splitWiresAtJunctions(junctionPoints);

    // 4. Clean up any zero-length artifacts.
    this.removeZeroLengthWires();
  }

  /**
   * Return all elements whose bounding box contains the given point.
   */
  getElementsAt(point: Point): CircuitElement[] {
    return this.elements.filter((el) => {
      const bb = el.getBoundingBox();
      return (
        point.x >= bb.x &&
        point.x <= bb.x + bb.width &&
        point.y >= bb.y &&
        point.y <= bb.y + bb.height
      );
    });
  }
}

