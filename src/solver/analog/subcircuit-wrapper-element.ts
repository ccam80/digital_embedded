/**
 * SubcircuitWrapperElement- presentation-only AnalogElement representing a
 * compiled subcircuit composite from the perspective of the per-instance
 * caller (slider/property-panel hot-patching, per-pin current introspection,
 * internal-node labelling).
 *
 * The real MNA work lives entirely in the wrapper's leaves (allocator,
 * patcher, sub-elements), which are pushed into the global `analogElements`
 * accumulator alongside the wrapper itself by `compileAnalogPartition`. The
 * wrapper participates in the engine's per-element walks structurally
 * (no-op `setup` / `load`) but contributes nothing to the matrix or RHS.
 *
 * `setLabel` is the one moment the per-instance caller invokes on the wrapper:
 * it propagates the resolved instance label to (a) the wrapper itself,
 * (b) the `labelRef` shared with the allocator/patcher leaf closures so they
 * can name internal nodes `${parentLabel}:intN`, and (c) every sub-element so
 * each leaf carries `${parentLabel}:${subElementName}` (Composite I5).
 */
import type { AnalogElement } from "./element.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";

export interface SubcircuitWrapperBindings {
  /**
   * Subcircuit-level param name -> sub-element / param-key pairs to update
   * when `setParam(name, value)` is called on the wrapper. Built by
   * `compileSubcircuitToMnaModel` from string-form `SubcircuitElementParam`
   * entries. Unbound keys fall back to the per-sub-element default propagation
   * (see `setParam` body).
   */
  readonly map: ReadonlyMap<string, ReadonlyArray<{ el: AnalogElement; key: string }>>;
}

export interface SubcircuitWrapperOptions {
  /** Pin label -> MNA node ID, copied as the wrapper's `_pinNodes`. */
  pinNodes: ReadonlyMap<string, number>;
  /**
   * Position in the global ngspice load order. Architecturally arbitrary
   * because the wrapper does no MNA work; the engine's NGSPICE_LOAD_ORDER
   * sort still needs a numeric key. `compileSubcircuitToMnaModel` passes
   * `NGSPICE_LOAD_ORDER.VCVS` for parity with the controlled-source family.
   */
  ngspiceLoadOrder: number;
  /** Sub-element leaves (real MNA participants). */
  subElements: readonly AnalogElement[];
  /** All children including allocator, patcher, sub-elements- exposed via
   *  `_subcircuitLeaves` so `compileAnalogPartition` can flatten them into
   *  the global accumulator. */
  leaves: readonly AnalogElement[];
  /** setParam routing table. */
  bindings: SubcircuitWrapperBindings;
  /** sub-element label-stamping records used by `setLabel`. */
  subElementLabelInfo: ReadonlyArray<{ el: AnalogElement; subElementName: string }>;
  /** Internal-net suffixes (e.g. `["int0", "int1"]`) returned by
   *  `getInternalNodeLabels()` for harness diagnostic node labelling. */
  internalNetLabels: readonly string[];
  /** Mutable shared label cell read by allocator/patcher leaf closures during
   *  their own `setup()` to name internal nodes `${parentLabel}:intN`. */
  labelRef: { value: string };
}

export class SubcircuitWrapperElement implements AnalogElement {
  label: string = "";
  readonly ngspiceLoadOrder: number;
  _pinNodes: Map<string, number>;
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly _subcircuitLeaves: readonly AnalogElement[];

  private readonly _subElements: readonly AnalogElement[];
  private readonly _bindings: SubcircuitWrapperBindings;
  private readonly _subElementLabelInfo: ReadonlyArray<{
    el: AnalogElement;
    subElementName: string;
  }>;
  private readonly _internalNetLabels: readonly string[];
  private readonly _labelRef: { value: string };

  constructor(opts: SubcircuitWrapperOptions) {
    this.ngspiceLoadOrder = opts.ngspiceLoadOrder;
    this._pinNodes = new Map(opts.pinNodes);
    this._subcircuitLeaves = opts.leaves;
    this._subElements = opts.subElements;
    this._bindings = opts.bindings;
    this._subElementLabelInfo = opts.subElementLabelInfo;
    this._internalNetLabels = opts.internalNetLabels;
    this._labelRef = opts.labelRef;
  }

  setup(_ctx: SetupContext): void {
    // No matrix work- leaves carry every TSTALLOC / makeVolt / makeCur.
  }

  load(_ctx: LoadContext): void {
    // No stamps- leaves carry every conductance / RHS contribution.
  }

  setParam(key: string, value: number): void {
    const bound = this._bindings.map.get(key);
    if (bound) {
      for (const { el, key: elKey } of bound) el.setParam(elKey, value);
    } else {
      for (const sub of this._subElements) sub.setParam(key, value);
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const currents: number[] = [];
    for (const sub of this._subElements) {
      currents.push(...sub.getPinCurrents(rhs));
    }
    return currents;
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalNetLabels;
  }

  setLabel(label: string): void {
    this.label = label;
    this._labelRef.value = label;
    for (const { el, subElementName } of this._subElementLabelInfo) {
      el.label = `${label}:${subElementName}`;
    }
  }
}
