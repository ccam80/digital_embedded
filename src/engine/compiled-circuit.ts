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
 * inputOffsets[i]  = index in state[] of the first input net for component i
 * outputOffsets[i] = index in state[] of the first output net for component i
 * inputCounts[i]   = number of input pins for component i
 * outputCounts[i]  = number of output pins for component i
 */
export class FlatComponentLayout implements ComponentLayout {
  private readonly _componentProperties: ReadonlyArray<ReadonlyMap<string, PropertyValue>>;

  constructor(
    private readonly _inputOffsets: Int32Array,
    private readonly _outputOffsets: Int32Array,
    private readonly _inputCounts: Uint8Array,
    private readonly _outputCounts: Uint8Array,
    componentProperties?: ReadonlyArray<ReadonlyMap<string, PropertyValue>>,
  ) {
    this._componentProperties = componentProperties ?? [];
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

  stateOffset(_componentIndex: number): number {
    return 0;
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

  /** Type ID per component slot — indexes into executeFns. */
  readonly typeIds: Uint8Array;

  /** Function table indexed by type ID. Populated from registry. */
  readonly executeFns: ExecuteFunction[];

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

  constructor(fields: {
    netCount: number;
    componentCount: number;
    typeIds: Uint8Array;
    executeFns: ExecuteFunction[];
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
  }) {
    this.netCount = fields.netCount;
    this.componentCount = fields.componentCount;
    this.typeIds = fields.typeIds;
    this.executeFns = fields.executeFns;
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
  }
}
