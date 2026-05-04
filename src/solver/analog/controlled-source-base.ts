/**
 * Base class for expression-driven controlled analog sources.
 *
 * All four controlled source types (VCVS, VCCS, CCVS, CCCS) share a common
 * structure: a transfer function expression that maps a control quantity
 * (voltage or current) to an output quantity, with symbolic differentiation
 * for the Jacobian contribution in Newton-Raphson iteration.
 *
 * Subclasses implement:
 *   - `_bindContext(voltages)` to populate ctx with the relevant control values
 *     and set `_ctrlValue`.
 *   - `_stampLinear(solver)` to stamp linear topology-constant entries (e.g.
 *     voltage source branch incidence rows for VCVS/CCVS, sense 0V source for
 *     CCVS/CCCS). Default no-op.
 *   - `stampOutput(solver, value, derivative, ctrlValue)` to stamp either a
 *     dependent voltage source (VCVS, CCVS) or a dependent current source
 *     (VCCS, CCCS) at the output port.
 *
 * MNA load protocol (matches ngspice DEVload dispatch):
 *   `load(ctx)` reads voltages from ctx, binds the control quantity, stamps
 *   the linear incidence, evaluates expression and derivative at the current
 *   operating point, and dispatches to `stampOutput` with the results.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import type { LoadContext } from "./load-context.js";
import type { SetupContext } from "./setup-context.js";
import type { ExprNode } from "./expression.js";
import { compileExpression } from "./expression-evaluate.js";
import type { ExpressionContext } from "./expression-evaluate.js";

// ---------------------------------------------------------------------------
// MutableExpressionContext
// ---------------------------------------------------------------------------

/**
 * Mutable ExpressionContext whose V() and I() mappings are updated each NR
 * iteration via `_bindContext`.
 */
export class MutableExpressionContext implements ExpressionContext {
  private readonly _voltageMap: Map<string, number> = new Map();
  private readonly _currentMap: Map<string, number> = new Map();
  time = 0;
  freq?: number;

  setNodeVoltage(label: string, value: number): void {
    this._voltageMap.set(label, value);
  }

  setNodeVoltageByIndex(label: string, nodeId: number, rhsOld: Float64Array): void {
    const v = rhsOld[nodeId];
    this._voltageMap.set(label, v);
  }

  setBranchCurrentByIndex(label: string, rowIdx: number, rhsOld: Float64Array): void {
    const i = rowIdx >= 0 && rowIdx < rhsOld.length ? rhsOld[rowIdx] : 0;
    this._currentMap.set(label, i);
  }

  getNodeVoltage(label: string): number {
    return this._voltageMap.get(label) ?? 0;
  }

  getBranchCurrent(label: string): number {
    return this._currentMap.get(label) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// ControlledSourceElement (abstract)
// ---------------------------------------------------------------------------

/**
 * Abstract base for expression-driven controlled sources.
 *
 * Concrete subclasses supply:
 *   - `_pinNodes` initialization in the constructor
 *   - `abstract readonly branchIndex` (or mutable field)
 *   - `_bindContext(voltages)` to populate ctx with the relevant control values
 *     and set `_ctrlValue`.
 *   - `_stampLinear(solver)` for linear topology-constant entries. Default
 *     no-op; VCVS/CCVS/CCCS override to stamp branch incidence.
 *   - `stampOutput(solver, value, derivative, ctrlValue)` for the output stamp.
 *
 * The `ctrlValue` parameter passed to `stampOutput` is the scalar control
 * quantity at the current operating point (V_ctrl for voltage-controlled,
 * I_sense for current-controlled). Subclasses use it to compute the correct
 * NR linearized RHS: `value - derivative * ctrlValue`.
 *
 * Sources that own a branch row (VCVS, CCVS) inherit the shared
 * `findBranchFor` implementation from this base class (per ssA.6).
 */
export abstract class ControlledSourceElement implements AnalogElement {
  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;

  abstract readonly ngspiceLoadOrder: number;
  abstract getPinCurrents(rhs: Float64Array): number[];

  setParam(_key: string, _value: number): void {}

  protected readonly _compiledExpr: (ctx: ExpressionContext) => number;
  protected readonly _compiledDeriv: (ctx: ExpressionContext) => number;

  /** Live context updated by `_bindContext` before each expression evaluation. */
  protected readonly _ctx: MutableExpressionContext = new MutableExpressionContext();

  /**
   * Scalar control quantity at the last operating point. Set by `_bindContext`
   * in subclasses; read by `load()` to pass to `stampOutput`.
   *
   * For VCVS/VCCS: `_ctrlValue = V_ctrl+ - V_ctrl-`
   * For CCVS/CCCS: `_ctrlValue = I_sense`
   */
  protected _ctrlValue = 0;

  constructor(
    expression: ExprNode,
    derivative: ExprNode,
    public readonly controlLabel: string,
    public readonly controlType: "voltage" | "current",
  ) {
    this._compiledExpr = compileExpression(expression);
    this._compiledDeriv = compileExpression(derivative);
  }

  /**
   * Idempotent branch-row allocation shared by VCVS and CCVS.
   *
   * VCVS/CCVS call this from their `setup()` and also expose it as
   * `findBranchFor` so that CCCS/CCVS controlling elements can lazy-allocate
   * the branch row when a name match is found.
   *
   * Matches the idempotent makeCur pattern in ssA.5 and ssA.6.
   */
  findBranchFor(_name: string, ctx: SetupContext): number {
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    return this.branchIndex;
  }

  /**
   * Unified hot-path method called every NR iteration.
   *
   * Binds the control quantity from the current solution vector, stamps the
   * linear topology incidence, evaluates the transfer function expression and
   * its symbolic derivative at the current operating point, and dispatches to
   * `stampOutput` which performs the Jacobian and NR-linearized RHS stamps.
   *
   * Matches ngspice DEVload one-call-per-iteration dispatch.
   */
  load(ctx: LoadContext): void {
    this._bindContext(ctx.rhsOld);
    this._stampLinear(ctx.solver);
    const value = this._compiledExpr(this._ctx);
    const deriv = this._compiledDeriv(this._ctx);
    this.stampOutput(ctx.solver, ctx.rhs, value, deriv, this._ctrlValue);
  }

  /**
   * Stamp linear (topology-constant) entries.
   * Default: no-op. Subclasses that introduce branch rows (VCVS, CCVS, CCCS)
   * override this to stamp the voltage source / sense source incidence
   * columns.
   */
  protected _stampLinear(_solver: SparseSolver): void {
    // default: no linear entries
  }

  /**
   * Populate the expression context with the control variable value.
   *
   * Implementations must also set `this._ctrlValue` to the scalar control
   * quantity for use in the NR linearized RHS computation in `stampOutput`.
   */
  protected abstract _bindContext(rhsOld: Float64Array): void;

  /**
   * Stamp the output contribution.
   *
   * @param solver     - The MNA solver being assembled
   * @param value      - Transfer function result f(ctrl0) at the current operating point
   * @param derivative - Jacobian contribution f'(ctrl0) at the current operating point
   * @param ctrlValue  - The scalar control quantity ctrl0 (V_ctrl or I_sense)
   *
   * For NR linearization, the branch equation RHS should be:
   *   `value - derivative * ctrlValue`
   * which equals `f(ctrl0) - f'(ctrl0) * ctrl0`, the constant term after
   * factoring out the Jacobian contribution to the C sub-matrix.
   */
  abstract stampOutput(
    solver: SparseSolver,
    rhs: Float64Array,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void;

  /**
   * `setup()` is a no-op in the base class. Subclasses that introduce branch
   * rows or TSTALLOC entries override this and call `findBranchFor` followed
   * by TSTALLOC allocations. The pattern follows ssA.5 idempotent allocation.
   */
  setup(_ctx: SetupContext): void {
    // base: no allocation- subclasses override
  }
}

// ---------------------------------------------------------------------------
// buildControlledSourceContext
// ---------------------------------------------------------------------------

/**
 * Create an ExpressionContext factory that binds to live engine state.
 *
 * Returns a context whose `getNodeVoltage` resolves labels via the compiled
 * circuit's `labelToNodeId` map, reading live values from `voltages`.
 * `getBranchCurrent` resolves labels via a branch-index map, reading from
 * the branch portion of the solution vector (indices >= nodeCount).
 */
export function buildControlledSourceContext(params: {
  labelToNodeId: Map<string, number>;
  branchLabelToRowIdx: Map<string, number>;
  getVoltages: () => Float64Array;
  getTime: () => number;
}): ExpressionContext {
  const { labelToNodeId, branchLabelToRowIdx, getVoltages, getTime } = params;

  return {
    get time(): number {
      return getTime();
    },

    getNodeVoltage(label: string): number {
      const nodeId = labelToNodeId.get(label);
      if (nodeId === undefined) return 0;
      const voltages = getVoltages();
      return voltages[nodeId];
    },

    getBranchCurrent(label: string): number {
      const rowIdx = branchLabelToRowIdx.get(label);
      if (rowIdx === undefined) return 0;
      const voltages = getVoltages();
      return rowIdx >= 0 && rowIdx < voltages.length ? voltages[rowIdx] : 0;
    },
  };
}
