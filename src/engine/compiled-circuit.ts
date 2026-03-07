/**
 * ConcreteCompiledCircuit — the engine-internal executable representation.
 *
 * Produced by compileCircuit() (compiler.ts) from a visual Circuit model.
 * Implements the opaque CompiledCircuit interface from Phase 1 with all
 * concrete fields the engine needs.
 *
 * Per Decision 3: this contains zero visual data — no positions, no wire
 * coordinates. The binding layer (Phase 6) holds cross-references.
 *
 */

import type { CompiledCircuit } from "@/core/engine-interface";
import type { CircuitElement } from "@/core/element";
import type { Wire } from "@/core/circuit";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";
import type { PropertyValue } from "@/core/properties";
import type { EvaluationGroup } from "./digital-engine.js";
import type { BusResolver } from "./bus-resolution.js";

// ---------------------------------------------------------------------------
// FlatComponentLayout — ComponentLayout backed by flat typed arrays
// ---------------------------------------------------------------------------

/**
 * ComponentLayout implementation backed by pre-computed flat arrays.
 *
 * The compiler produces these arrays once. The engine's inner loop calls
 * inputOffset/outputOffset on every component evaluation — these are O(1)
 * array reads.
 *
 * inputOffsets[i]  = index in wiringTable where component i's inputs start
 * outputOffsets[i] = index in wiringTable where component i's outputs start
 * inputCounts[i]   = number of input pins for component i
 * outputCounts[i]  = number of output pins for component i
 * wiringTable[k]   = net ID in the signal array for wiring-table position k
 */
export class FlatComponentLayout implements ComponentLayout {
  readonly wiringTable: Int32Array;
  private readonly _componentProperties: ReadonlyArray<ReadonlyMap<string, PropertyValue>>;
  private readonly _stateOffsets: Int32Array;

  constructor(
    private readonly _inputOffsets: Int32Array,
    private readonly _outputOffsets: Int32Array,
    private readonly _inputCounts: Uint8Array,
    private readonly _outputCounts: Uint8Array,
    wiringTable: Int32Array,
    componentProperties?: ReadonlyArray<ReadonlyMap<string, PropertyValue>>,
    stateOffsets?: Int32Array,
  ) {
    this.wiringTable = wiringTable;
    this._componentProperties = componentProperties ?? [];
    this._stateOffsets = stateOffsets ?? new Int32Array(_inputOffsets.length);
  }

  inputCount(componentIndex: number): number {
    return this._inputCounts[componentIndex] ?? 0;
  }

  inputOffset(componentIndex: number): number {
    return this._inputOffsets[componentIndex] ?? 0;
  }

  outputCount(componentIndex: number): number {
    return this._outputCounts[componentIndex] ?? 0;
  }

  outputOffset(componentIndex: number): number {
    return this._outputOffsets[componentIndex] ?? 0;
  }

  stateOffset(componentIndex: number): number {
    return this._stateOffsets[componentIndex] ?? 0;
  }

  getProperty(componentIndex: number, key: string): PropertyValue | undefined {
    return this._componentProperties[componentIndex]?.get(key);
  }
}

// ---------------------------------------------------------------------------
// CompiledCircuitImpl — concrete CompiledCircuit
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of CompiledCircuit produced by compileCircuit().
 *
 * All fields are readonly after construction — the engine reads them, never
 * writes them. The engine owns the signal arrays (Uint32Array) separately.
 */
export class CompiledCircuitImpl implements CompiledCircuit {
  readonly netCount: number;
  readonly componentCount: number;
  readonly totalStateSlots: number;
  readonly signalArraySize: number;

  /** Type ID per component slot — indexes into executeFns. */
  readonly typeIds: Uint8Array;

  /** Function table indexed by type ID. Populated from registry. */
  readonly executeFns: ExecuteFunction[];

  /** Sample function table indexed by type ID. Non-null for sequential components. */
  readonly sampleFns: (ExecuteFunction | null)[];

  /** Wiring indirection table mapping layout indices to net IDs. */
  readonly wiringTable: Int32Array;

  /** Wiring layout — O(1) input/output offset lookups per component. */
  readonly layout: FlatComponentLayout;

  /** Topologically sorted evaluation groups (SCCs in DAG order). */
  readonly evaluationOrder: EvaluationGroup[];

  /** Component indices of sequential elements (evaluated on clock edge). */
  readonly sequentialComponents: Uint32Array;

  /** Bit width per net for BitVector construction. */
  readonly netWidths: Uint8Array;

  /** Pre-allocated snapshot buffer for synchronized SCC evaluation. */
  readonly sccSnapshotBuffer: Uint32Array;

  /** Per-component gate delay in nanoseconds for timed mode. */
  readonly delays: Uint32Array;

  /** Maps component index to its CircuitElement for debugging/micro-step UI. */
  readonly componentToElement: Map<number, CircuitElement>;

  /**
   * Maps label string to net ID for facade's setInput/readOutput resolution.
   * Labels come from In/Out/Probe components whose label property is set.
   */
  readonly labelToNetId: Map<string, number>;

  /**
   * Maps Wire instance to net ID for the renderer's wire coloring.
   * Populated by the net resolver during compilation.
   */
  readonly wireToNetId: Map<Wire, number>;

  /**
   * Maps "{instanceId}:{pinLabel}" keys to net IDs for interactive input
   * (e.g. clicking an In component) and pin-level signal reading.
   * Populated by the compiler after net IDs are assigned.
   */
  readonly pinNetMap: Map<string, number>;

  /** Indices of Reset components (if any). Used by init sequence. */
  readonly resetComponentIndices: Uint32Array;

  /** Bus resolver for multi-driver nets, or null if no multi-driver nets exist. */
  readonly busResolver: BusResolver | null;

  /** Set of net IDs that have multiple drivers (used by switch classification). */
  readonly multiDriverNets: Set<number>;

  constructor(fields: {
    netCount: number;
    componentCount: number;
    totalStateSlots?: number;
    typeIds: Uint8Array;
    executeFns: ExecuteFunction[];
    sampleFns?: (ExecuteFunction | null)[];
    wiringTable: Int32Array;
    layout: FlatComponentLayout;
    evaluationOrder: EvaluationGroup[];
    sequentialComponents: Uint32Array;
    netWidths: Uint8Array;
    sccSnapshotBuffer: Uint32Array;
    delays: Uint32Array;
    componentToElement: Map<number, CircuitElement>;
    labelToNetId: Map<string, number>;
    wireToNetId: Map<Wire, number>;
    pinNetMap: Map<string, number>;
    resetComponentIndices?: Uint32Array;
    busResolver?: BusResolver | null;
    multiDriverNets?: Set<number>;
  }) {
    this.netCount = fields.netCount;
    this.componentCount = fields.componentCount;
    this.totalStateSlots = fields.totalStateSlots ?? 0;
    this.signalArraySize = fields.netCount + (fields.totalStateSlots ?? 0);
    this.typeIds = fields.typeIds;
    this.executeFns = fields.executeFns;
    this.sampleFns = fields.sampleFns ?? fields.executeFns.map(() => null);
    this.wiringTable = fields.wiringTable;
    this.layout = fields.layout;
    this.evaluationOrder = fields.evaluationOrder;
    this.sequentialComponents = fields.sequentialComponents;
    this.netWidths = fields.netWidths;
    this.sccSnapshotBuffer = fields.sccSnapshotBuffer;
    this.delays = fields.delays;
    this.componentToElement = fields.componentToElement;
    this.labelToNetId = fields.labelToNetId;
    this.wireToNetId = fields.wireToNetId;
    this.pinNetMap = fields.pinNetMap;
    this.resetComponentIndices = fields.resetComponentIndices ?? new Uint32Array(0);
    this.busResolver = fields.busResolver ?? null;
    this.multiDriverNets = fields.multiDriverNets ?? new Set();
  }
}
