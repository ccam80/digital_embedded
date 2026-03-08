/**
 * Circuit model — visual representation only.
 *
 * Per Decision 3: Circuit is the visual model. No simulation state lives here.
 * No net IDs, no signal values. The compiler (Phase 3) transforms Circuit into
 * CompiledModel, which is what the engine runs.
 */

import type { Point } from "./renderer-interface.js";
import type { Pin } from "./pin.js";
import type { CircuitElement } from "./element.js";

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
}

export function defaultCircuitMetadata(): CircuitMetadata {
  return {
    name: "Untitled",
    description: "",
    testDataRefs: [],
    measurementOrdering: [],
    isGeneric: false,
    isLocked: false,
    chipWidth: 3,
    chipHeight: 3,
    shapeType: "DEFAULT",
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
    this.wires.push(wire);
  }

  removeWire(wire: Wire): void {
    const index = this.wires.indexOf(wire);
    if (index !== -1) {
      this.wires.splice(index, 1);
    }
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

