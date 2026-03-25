/**
 * Tests for ControlledSourceElement base class and buildControlledSourceContext.
 *
 * Verifies expression evaluation, symbolic derivative evaluation, and context
 * binding behaviour without instantiating any full circuit or solver.
 */

import { describe, it, expect } from "vitest";
import { parseExpression } from "../expression.js";
import { differentiate, simplify } from "../expression-differentiate.js";
import {
  ControlledSourceElement,
  buildControlledSourceContext,
} from "../controlled-source-base.js";
import type { SparseSolver } from "../sparse-solver.js";
import type { ExpressionContext } from "../expression-evaluate.js";

// ---------------------------------------------------------------------------
// Concrete test subclass
// ---------------------------------------------------------------------------

/**
 * Minimal concrete subclass of ControlledSourceElement for testing.
 *
 * Records the most recent `stampOutput` call arguments so tests can verify
 * what was passed from `stampNonlinear`.
 */
class TestControlledSource extends ControlledSourceElement {
  readonly pinNodeIds: readonly number[] = [1, 0];
  readonly allNodeIds: readonly number[] = [1, 0];
  readonly branchIndex = -1;

  lastValue = 0;
  lastDerivative = 0;
  lastCtrlValue = 0;

  // Expose ctx for direct manipulation in tests
  get mutableCtx() {
    return this._ctx;
  }

  protected _bindContext(_voltages: Float64Array): void {
    // Tests set ctx values directly; this is a no-op for unit tests.
  }

  stampOutput(_solver: SparseSolver, value: number, derivative: number, ctrlValue: number): void {
    this.lastValue = value;
    this.lastDerivative = derivative;
    this.lastCtrlValue = ctrlValue;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a TestControlledSource with the given expression string, automatically
 * computing the symbolic derivative with respect to the given variable.
 */
function makeSource(
  exprStr: string,
  variable: string,
  controlType: "voltage" | "current" = "voltage",
): TestControlledSource {
  const expr = parseExpression(exprStr);
  const deriv = simplify(differentiate(expr, variable));
  return new TestControlledSource(expr, deriv, variable, controlType);
}

/**
 * Null SparseSolver — stampOutput in tests doesn't use the solver.
 * We cast null to SparseSolver since the test subclass ignores the solver arg.
 */
const nullSolver = null as unknown as SparseSolver;

// ---------------------------------------------------------------------------
// Tests: Base
// ---------------------------------------------------------------------------

describe("Base", () => {
  it("linear_expression_evaluates", () => {
    const src = makeSource("2 * V(ctrl)", "V(ctrl)");

    // Set V(ctrl) = 1.5 in the context
    src.mutableCtx.setNodeVoltage("ctrl", 1.5);

    src.stampNonlinear(nullSolver);

    expect(src.lastValue).toBeCloseTo(3.0, 10);
  });

  it("derivative_correct_for_linear", () => {
    // d/dV(ctrl) [2 * V(ctrl)] = 2
    const src = makeSource("2 * V(ctrl)", "V(ctrl)");

    src.mutableCtx.setNodeVoltage("ctrl", 1.5);

    src.stampNonlinear(nullSolver);

    expect(src.lastDerivative).toBeCloseTo(2.0, 10);
  });

  it("nonlinear_expression_evaluates", () => {
    // 0.01 * V(ctrl)^2 at V(ctrl)=3 → 0.01 * 9 = 0.09
    const src = makeSource("0.01 * V(ctrl)^2", "V(ctrl)");

    src.mutableCtx.setNodeVoltage("ctrl", 3.0);

    src.stampNonlinear(nullSolver);

    expect(src.lastValue).toBeCloseTo(0.09, 10);
  });

  it("nonlinear_derivative", () => {
    // d/dV(ctrl) [0.01 * V(ctrl)^2] = 0.02 * V(ctrl); at V(ctrl)=3 → 0.06
    const src = makeSource("0.01 * V(ctrl)^2", "V(ctrl)");

    src.mutableCtx.setNodeVoltage("ctrl", 3.0);

    src.stampNonlinear(nullSolver);

    expect(src.lastDerivative).toBeCloseTo(0.06, 10);
  });

  it("context_binds_to_engine", () => {
    // Build context from mock engine data and verify V(label) resolves correctly.
    const labelToNodeId = new Map<string, number>([
      ["supply", 1],
      ["mid", 2],
    ]);
    const branchLabelToRowIdx = new Map<string, number>();
    let voltages = new Float64Array([5.0, 2.5]);

    const ctx = buildControlledSourceContext({
      labelToNodeId,
      branchLabelToRowIdx,
      getVoltages: () => voltages,
      getTime: () => 0,
    });

    expect(ctx.getNodeVoltage("supply")).toBeCloseTo(5.0, 10);
    expect(ctx.getNodeVoltage("mid")).toBeCloseTo(2.5, 10);

    // Update voltages; context reads live
    voltages = new Float64Array([3.3, 1.65]);
    expect(ctx.getNodeVoltage("supply")).toBeCloseTo(3.3, 10);
    expect(ctx.getNodeVoltage("mid")).toBeCloseTo(1.65, 10);

    // Unknown label returns 0
    expect(ctx.getNodeVoltage("unknown")).toBe(0);
  });
});
