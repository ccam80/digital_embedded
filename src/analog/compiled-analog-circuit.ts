/**
 * ConcreteCompiledAnalogCircuit — the executable analog circuit produced by
 * the analog compiler.
 *
 * Implements `CompiledAnalogCircuit` (which extends `CompiledCircuit`) so the
 * runner's label resolution and compilation infrastructure work uniformly
 * across engine types.
 */

import type { CompiledAnalogCircuit, SolverDiagnostic } from "../core/analog-engine-interface.js";
import type { Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { AnalogElement } from "./element.js";
import type { BridgeInstance } from "./bridge-instance.js";
import type { ResolvedPin } from "../core/pin.js";

// ---------------------------------------------------------------------------
// DeviceModel — placeholder for Phase 2 .MODEL support
// ---------------------------------------------------------------------------

/**
 * Opaque device model record. Phase 2 populates this with SPICE-style .MODEL
 * parameters. The compiler allocates an empty map so downstream code can
 * unconditionally access `compiled.models` without null checks.
 */
export interface DeviceModel {
  /** Model name (e.g. "1N4148"). */
  name: string;
  /** Model type identifier (e.g. "D", "NPN", "PMOS"). */
  type: string;
  /** Model parameters as key→value pairs. */
  params: Map<string, number>;
}

// ---------------------------------------------------------------------------
// ConcreteCompiledAnalogCircuit
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `CompiledAnalogCircuit`.
 *
 * Fields:
 * - `nodeCount`         — number of non-ground MNA nodes (IDs 1…nodeCount)
 * - `branchCount`       — number of voltage-source / inductor branch rows
 * - `matrixSize`        — nodeCount + branchCount (MNA matrix dimension)
 * - `elements`          — all AnalogElement instances with stamp functions
 * - `labelToNodeId`     — maps component labels to MNA node IDs (runner label resolution)
 * - `wireToNodeId`      — maps Wire objects to MNA node IDs (wire renderer)
 * - `models`            — device models (empty until Phase 2 adds .MODEL support)
 * - `elementToCircuitElement` — element index → visual CircuitElement (diagnostics / UI)
 *
 * `CompiledCircuit` base fields:
 * - `netCount`          — aliases nodeCount (same concept for analog)
 * - `componentCount`    — aliases elementCount
 */
export class ConcreteCompiledAnalogCircuit implements CompiledAnalogCircuit {
  /** Number of non-ground MNA nodes. */
  readonly nodeCount: number;

  /** Number of branch-current rows (voltage sources, inductors). */
  readonly branchCount: number;

  /** MNA matrix dimension: nodeCount + branchCount. */
  readonly matrixSize: number;

  /** All analog element instances. */
  readonly elements: AnalogElement[];

  /** Maps component label strings to MNA node IDs. */
  readonly labelToNodeId: Map<string, number>;

  /** Maps Wire objects to MNA node IDs. */
  readonly wireToNodeId: Map<Wire, number>;

  /** Device models. Empty until Phase 2. */
  readonly models: Map<string, DeviceModel>;

  /** Maps element index to the originating CircuitElement for diagnostics. */
  readonly elementToCircuitElement: Map<number, CircuitElement>;

  /** Maps element index to the wire vertex each pin connects to.
   *  Used by WireCurrentResolver to place current injections at exact
   *  wire graph vertices without re-doing spatial matching. */
  readonly elementPinVertices: Map<number, Array<{ x: number; y: number } | null>>;

  /** Maps element index to resolved pins in pinLayout order.
   *  Replaces elementPinVertices — carries label, vertex, nodeId in one object.
   *  During migration, coexists with elementPinVertices. */
  readonly elementResolvedPins: Map<number, ResolvedPin[]>;

  /** Diagnostics emitted during compilation (topology issues, missing models, etc.). */
  readonly diagnostics: SolverDiagnostic[];

  /**
   * Bridge instances for cross-engine subcircuits found during compilation.
   *
   * Each entry corresponds to one CrossEngineBoundary in the FlattenResult.
   * The DefaultSimulationCoordinator reads this list to create DigitalEngine
   * instances and synchronize signal values at each analog timestep. Empty
   * when no mixed-signal subcircuits are present.
   */
  readonly bridges: BridgeInstance[];

  /** Mutable time reference shared with element closures. The engine updates
   *  `timeRef.value` each timestep so elements see the current simulation time. */
  readonly timeRef: { value: number };

  constructor(params: {
    nodeCount: number;
    branchCount: number;
    elements: AnalogElement[];
    labelToNodeId: Map<string, number>;
    wireToNodeId: Map<Wire, number>;
    models: Map<string, DeviceModel>;
    elementToCircuitElement: Map<number, CircuitElement>;
    elementPinVertices?: Map<number, Array<{ x: number; y: number } | null>>;
    elementResolvedPins?: Map<number, ResolvedPin[]>;
    diagnostics?: SolverDiagnostic[];
    bridges?: BridgeInstance[];
    timeRef?: { value: number };
  }) {
    this.nodeCount = params.nodeCount;
    this.branchCount = params.branchCount;
    this.matrixSize = params.nodeCount + params.branchCount;
    this.elements = params.elements;
    this.labelToNodeId = params.labelToNodeId;
    this.wireToNodeId = params.wireToNodeId;
    this.models = params.models;
    this.elementToCircuitElement = params.elementToCircuitElement;
    this.elementPinVertices = params.elementPinVertices ?? new Map();
    this.elementResolvedPins = params.elementResolvedPins ?? new Map();
    this.diagnostics = params.diagnostics ?? [];
    this.bridges = params.bridges ?? [];
    this.timeRef = params.timeRef ?? { value: 0 };
  }

  // CompiledCircuit base interface
  get netCount(): number {
    return this.nodeCount;
  }

  get componentCount(): number {
    return this.elements.length;
  }

  get elementCount(): number {
    return this.elements.length;
  }
}
