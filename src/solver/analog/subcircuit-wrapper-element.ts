/**
 * SubcircuitWrapperElement- presentation-only AnalogElement representing a
 * compiled subcircuit composite from the perspective of the per-instance
 * caller (slider/property-panel hot-patching, per-pin current introspection,
 * internal-node labelling).
 *
 * The real MNA work lives entirely in the wrapper's leaves (sub-elements),
 * which are pushed into the global `analogElements` accumulator alongside
 * the wrapper itself by `compileAnalogPartition`. The wrapper participates
 * in the engine's per-element walks structurally (no-op `setup`) but
 * contributes nothing to the matrix or RHS.
 *
 * Optional parent-side runtime hook (`AnalogWrapperHook`): the wrapper
 * forwards `load`, `setDiagnosticEmitter`, `setParam`, and `acceptStep`
 * calls to the hook when supplied by a `kind: "netlist"` parent's
 * `analogWrapperHook` factory. This is the seat for parent-specific
 * concerns that don't belong on canonical leaves (e.g. PolarizedCap's
 * reverse-bias diagnostic).
 *
 * Under the compile-time-expansion architecture, the wrapper's label and
 * each sub-element's label are set inside `expandCompositeInstance` at
 * compile time. There is no `setLabel` patcher dance and no shared `labelRef`
 * cell- by the time the engine sees these elements every label is already
 * set, every internal-net node ID is already allocated, and every sub-element
 * `pinNodes` Map carries fully-resolved IDs.
 */
import { AnalogElement } from "./element.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import type { AnalogWrapperHook } from "../../core/registry.js";
import type { Diagnostic } from "../../compile/types.js";

export interface SubcircuitWrapperBindings {
  /**
   * Subcircuit-level param name -> sub-element / param-key pairs to update
   * when `setParam(name, value)` is called on the wrapper. Built by
   * `expandCompositeInstance` from string-form `SubcircuitElementParam`
   * entries. Unbound keys fall back to the per-sub-element default propagation
   * (see `setParam` body).
   */
  readonly map: ReadonlyMap<string, ReadonlyArray<{ el: AnalogElement; key: string }>>;
}

export interface SubcircuitWrapperOptions {
  /** Pin label -> MNA node ID, copied as the wrapper's `pinNodes`. */
  pinNodes: ReadonlyMap<string, number>;
  /**
   * Position in the global ngspice load order. Architecturally arbitrary
   * because the wrapper does no MNA work; the engine's NGSPICE_LOAD_ORDER
   * sort still needs a numeric key. `expandCompositeInstance` passes
   * `NGSPICE_LOAD_ORDER.VCVS` for parity with the controlled-source family.
   */
  ngspiceLoadOrder: number;
  /** Direct sub-element children (one per netlist.elements entry). For
   *  nested composites this includes the inner wrapper. */
  subElements: readonly AnalogElement[];
  /** Depth-first flat list of leaves below this wrapper- exposed via
   *  `_subcircuitLeaves` so `compileAnalogPartition` can flatten them into
   *  the global accumulator. */
  leaves: readonly AnalogElement[];
  /** setParam routing table. */
  bindings: SubcircuitWrapperBindings;
  /** sub-element label-stamping records. Retained for diagnostic
   *  introspection; sub-element labels are already set during expansion. */
  subElementLabelInfo: ReadonlyArray<{ el: AnalogElement; subElementName: string }>;
  /** Internal-net suffixes (e.g. `["int0", "int1"]`) returned by
   *  `getInternalNodeLabels()` for harness diagnostic node labelling. */
  internalNetLabels: readonly string[];
  /** Resolved instance label, e.g. `"opto1"` or `"opto1:cccsCouple"` for
   *  nested composites. Set at expansion time before any leaf's `setup()`
   *  runs. */
  label: string;
  /** Optional parent-side runtime hook for `kind: "netlist"` parents that
   *  need parent-specific concerns (UI diagnostics, etc.). Methods on the
   *  hook are forwarded by the wrapper at the corresponding lifecycle
   *  points. See `AnalogWrapperHook` in `core/registry.ts`. */
  hook?: AnalogWrapperHook;
}

export class SubcircuitWrapperElement extends AnalogElement {
  readonly ngspiceLoadOrder: number;
  readonly _subcircuitLeaves: readonly AnalogElement[];

  private readonly _subElements: readonly AnalogElement[];
  private readonly _bindings: SubcircuitWrapperBindings;
  private readonly _subElementLabelInfo: ReadonlyArray<{
    el: AnalogElement;
    subElementName: string;
  }>;
  private readonly _internalNetLabels: readonly string[];
  private readonly _hook: AnalogWrapperHook | undefined;

  constructor(opts: SubcircuitWrapperOptions) {
    super(opts.pinNodes);
    this.ngspiceLoadOrder = opts.ngspiceLoadOrder;
    this._subcircuitLeaves = opts.leaves;
    this._subElements = opts.subElements;
    this._bindings = opts.bindings;
    this._subElementLabelInfo = opts.subElementLabelInfo;
    this._internalNetLabels = opts.internalNetLabels;
    this.label = opts.label;
    this._hook = opts.hook;
    // Attach optional `acceptStep` to the instance only when the hook
    // supplies one. The engine's per-step accept loop checks
    // `if (el.acceptStep)` before invoking, so wrappers without hooks stay
    // out of the iteration entirely.
    if (this._hook?.acceptStep) {
      const hook = this._hook;
      this.acceptStep = (simTime, addBreakpoint, atBreakpoint): void => {
        hook.acceptStep!(simTime, addBreakpoint, atBreakpoint);
      };
    }
  }

  setup(_ctx: SetupContext): void {
    // No matrix work- leaves carry every TSTALLOC / makeVolt / makeCur.
  }

  load(ctx: LoadContext): void {
    // Wrapper itself contributes no stamps. Forward to the parent-side hook
    // if registered; the hook reads voltages via ctx.rhsOld and emits
    // diagnostics via the captured emitter (no MNA contribution).
    this._hook?.load?.(ctx);
  }

  /**
   * RuntimeDiagnosticAware opt-in. Forwards the engine-supplied emitter to
   * the parent-side hook if one is registered. Method-presence on the
   * wrapper class itself satisfies `isRuntimeDiagnosticAware`; wrappers
   * without a hook simply no-op.
   */
  setDiagnosticEmitter(emit: (diag: Diagnostic) => void): void {
    this._hook?.setDiagnosticEmitter?.(emit);
  }

  setParam(key: string, value: number): void {
    // Parent-side hook gets first shot at the param (e.g. `reverseMax`
    // updates a polarity-warning threshold without touching any leaf).
    this._hook?.setParam?.(key, value);
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

  /**
   * Read access to the wrapper's sub-element label info. Retained for
   * diagnostic / introspection paths that previously called `setLabel` to
   * walk children. Sub-element labels are already set during expansion.
   */
  get subElementLabelInfo(): ReadonlyArray<{ el: AnalogElement; subElementName: string }> {
    return this._subElementLabelInfo;
  }
}
