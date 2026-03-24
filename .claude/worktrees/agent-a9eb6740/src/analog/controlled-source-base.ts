/**
 * Base class for expression-driven controlled analog sources.
 *
 * All four controlled source types (VCVS, VCCS, CCVS, CCCS) share a common
 * structure: a transfer function expression that maps a control quantity
 * (voltage or current) to an output quantity, with symbolic differentiation
 * for the Jacobian contribution in Newton-Raphson iteration.
 *
 * Subclasses implement `stampOutput(solver, value, derivative, ctrlValue)` to
 * stamp either a dependent voltage source (VCVS, CCVS) or a dependent current
 * source (VCCS, CCCS) at the output port.
 *
 * MNA stamping protocol:
 *   - `stamp(solver)`: stamps the linear topology-constant entries (e.g.
 *     voltage source branch incidence rows for VCVS/CCVS).
 *   - `stampNonlinear(solver)`: evaluates expression and derivative at the
 *     current operating point; calls `stampOutput` with the results.
 *   - `updateOperatingPoint(voltages)`: reads node voltages and branch currents
 *     from the current NR solution and updates the internal context state.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import type { ExprNode } from "./expression.js";
import { compileExpression } from "./expression-evaluate.js";
import type { ExpressionContext } from "./expression-evaluate.js";

// ---------------------------------------------------------------------------
// MutableExpressionContext
// ---------------------------------------------------------------------------

/**
 * Mutable ExpressionContext whose V() and I() mappings are updated each NR
 * iteration via `updateOperatingPoint`.
 */
export class MutableExpressionContext implements ExpressionContext {
  private readonly _voltageMap: Map<string, number> = new Map();
  private readonly _currentMap: Map<string, number> = new Map();
  time = 0;
  freq: number | undefined = undefined;

  setNodeVoltage(label: string, value: number): void {
    this._voltageMap.set(label, value);
  }

  setNodeVoltageByIndex(label: string, nodeId: number, voltages: Float64Array): void {
    const v = nodeId > 0 ? voltages[nodeId - 1] : 0;
    this._voltageMap.set(label, v);
  }

  setBranchCurrentByIndex(label: string, rowIdx: number, voltages: Float64Array): void {
    const i = rowIdx >= 0 && rowIdx < voltages.length ? voltages[rowIdx] : 0;
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
 *   - `nodeIndices` and `branchIndex`
 *   - `stamp(solver)` for linear topology entries (overrides no-op default)
 *   - `_bindContext(voltages)` to populate ctx with the relevant control values
 *   - `stampOutput(solver, value, derivative, ctrlValue)` for the output stamp
 *
 * The `ctrlValue` parameter passed to `stampOutput` is the scalar control
 * quantity at the current operating point (V_ctrl for voltage-controlled,
 * I_sense for current-controlled). Subclasses use it to compute the correct
 * NR linearized RHS: `value - derivative * ctrlValue`.
 */
export abstract class ControlledSourceElement implements AnalogElement {
  abstract readonly nodeIndices: readonly number[];
  abstract readonly branchIndex: number;

  readonly isNonlinear = true as const;
  readonly isReactive = false as const;

  label?: string;

  protected readonly _compiledExpr: (ctx: ExpressionContext) => number;
  protected readonly _compiledDeriv: (ctx: ExpressionContext) => number;

  /** Live context updated by updateOperatingPoint before each stampNonlinear. */
  protected readonly _ctx: MutableExpressionContext = new MutableExpressionContext();

  /**
   * Scalar control quantity at the last operating point. Set by `_bindContext`
   * in subclasses; read by `stampNonlinear` to pass to `stampOutput`.
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
   * Stamp linear (topology-constant) entries.
   * Non-abstract default: no-op. Subclasses that introduce branch rows
   * (VCVS, CCVS) override this to stamp the voltage source incidence columns.
   */
  stamp(_solver: SparseSolver): void {
    // default: no linear entries
  }

  /**
   * Evaluate expression and derivative at the current operating point;
   * dispatch to `stampOutput`.
   */
  stampNonlinear(solver: SparseSolver): void {
    const value = this._compiledExpr(this._ctx);
    const deriv = this._compiledDeriv(this._ctx);
    this.stampOutput(solver, value, deriv, this._ctrlValue);
  }

  /**
   * Update context from the latest NR solution vector. Subclasses override
   * `_bindContext` to extract the correct control variable (voltage or current)
   * and set `_ctrlValue`.
   */
  updateOperatingPoint(voltages: Float64Array): void {
    this._bindContext(voltages);
  }

  /**
   * Populate the expression context with the control variable value.
   *
   * Implementations must also set `this._ctrlValue` to the scalar control
   * quantity for use in the NR linearized RHS computation in `stampOutput`.
   */
  protected abstract _bindContext(voltages: Float64Array): void;

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
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void;
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
      return nodeId > 0 ? voltages[nodeId - 1] : 0;
    },

    getBranchCurrent(label: string): number {
      const rowIdx = branchLabelToRowIdx.get(label);
      if (rowIdx === undefined) return 0;
      const voltages = getVoltages();
      return rowIdx >= 0 && rowIdx < voltages.length ? voltages[rowIdx] : 0;
    },
  };
}
