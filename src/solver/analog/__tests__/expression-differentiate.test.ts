/**
 * Tests for symbolic differentiation and simplification of the expression AST.
 */

import { describe, it, expect } from "vitest";
import { parseExpression } from "../expression.js";
import { differentiate, simplify } from "../expression-differentiate.js";
import { evaluate } from "../expression-evaluate.js";
import { numNode, varNode, binOp } from "../expression.js";

// ---------------------------------------------------------------------------
// Helper: parse an expression, differentiate w.r.t. variable, evaluate result
// ---------------------------------------------------------------------------

function mkCtx(vars: Record<string, number>) {
  return {
    getNodeVoltage: (label: string) => {
      if (label in vars) return vars[label];
      throw new Error(`Unknown node ${label}`);
    },
    getBranchCurrent: (label: string) => {
      if (label in vars) return vars[label];
      throw new Error(`Unknown branch ${label}`);
    },
    time: vars["time"] ?? 0,
    freq: vars["freq"],
    variables: vars,
  };
}

function diffEval(exprText: string, variable: string, vars: Record<string, number>): number {
  const expr = parseExpression(exprText);
  const deriv = differentiate(expr, variable);
  return evaluate(deriv, mkCtx(vars));
}

// ===========================================================================
// Differentiate tests
// ===========================================================================

describe("Differentiate", () => {
  it("constant_is_zero — d/dx(5) = 0", () => {
    const expr = parseExpression("5");
    const deriv = differentiate(expr, "x");
    const result = evaluate(deriv, mkCtx({}));
    expect(result).toBe(0);
  });

  it("variable_is_one — d/dx(x) = 1", () => {
    const expr = parseExpression("x");
    const deriv = differentiate(expr, "x");
    const result = evaluate(deriv, mkCtx({ x: 99 }));
    expect(result).toBe(1);
  });

  it("other_variable_is_zero — d/dx(y) = 0", () => {
    const expr = parseExpression("y");
    const deriv = differentiate(expr, "x");
    const result = evaluate(deriv, mkCtx({ y: 5 }));
    expect(result).toBe(0);
  });

  it("product_rule — d/dx(x*sin(x)) = sin(x) + x*cos(x); evaluate at x=pi/4", () => {
    const x = Math.PI / 4;
    const result = diffEval("x * sin(x)", "x", { x });
    const expected = Math.sin(x) + x * Math.cos(x);
  });

  it("chain_rule — d/dx(sin(x^2)) = 2x*cos(x^2); evaluate at x=1", () => {
    const x = 1;
    const result = diffEval("sin(x ^ 2)", "x", { x });
    const expected = 2 * x * Math.cos(x * x);
  });

  it("quotient_rule — d/dx(x/(1+x)) = 1/(1+x)^2; evaluate at x=2", () => {
    const x = 2;
    const result = diffEval("x / (1 + x)", "x", { x });
    const expected = 1 / ((1 + x) * (1 + x));
  });

  it("power_rule — d/dx(x^3) = 3x^2; evaluate at x=2 gives 12", () => {
    const x = 2;
    const result = diffEval("x ^ 3", "x", { x });
  });

  it("sum_rule — d/dx(x + x^2) = 1 + 2x; at x=3 gives 7", () => {
    const x = 3;
    const result = diffEval("x + x ^ 2", "x", { x });
  });

  it("difference_rule — d/dx(x^2 - x) = 2x - 1; at x=4 gives 7", () => {
    const x = 4;
    const result = diffEval("x ^ 2 - x", "x", { x });
  });

  it("exp_rule — d/dx(exp(x)) = exp(x); at x=1", () => {
    const x = 1;
    const result = diffEval("exp(x)", "x", { x });
  });

  it("log_rule — d/dx(log(x)) = 1/x; at x=2 gives 0.5", () => {
    const x = 2;
    const result = diffEval("log(x)", "x", { x });
  });

  it("sqrt_rule — d/dx(sqrt(x)) = 1/(2*sqrt(x)); at x=4 gives 0.25", () => {
    const x = 4;
    const result = diffEval("sqrt(x)", "x", { x });
  });

  it("cos_rule — d/dx(cos(x)) = -sin(x); at x=pi/3", () => {
    const x = Math.PI / 3;
    const result = diffEval("cos(x)", "x", { x });
  });
});

// ===========================================================================
// Simplify tests
// ===========================================================================

describe("Simplify", () => {
  it("zero_plus_x — simplify 0 + x → x", () => {
    const expr = binOp("+", numNode(0), varNode("x"));
    const s = simplify(expr);
    expect(s.kind).toBe("variable");
    if (s.kind === "variable") expect(s.name).toBe("x");
  });

  it("x_plus_zero — simplify x + 0 → x", () => {
    const expr = binOp("+", varNode("x"), numNode(0));
    const s = simplify(expr);
    expect(s.kind).toBe("variable");
    if (s.kind === "variable") expect(s.name).toBe("x");
  });

  it("x_times_zero — simplify x * 0 → 0", () => {
    const expr = binOp("*", varNode("x"), numNode(0));
    const s = simplify(expr);
    expect(s.kind).toBe("number");
    if (s.kind === "number") expect(s.value).toBe(0);
  });

  it("zero_times_x — simplify 0 * x → 0", () => {
    const expr = binOp("*", numNode(0), varNode("x"));
    const s = simplify(expr);
    expect(s.kind).toBe("number");
    if (s.kind === "number") expect(s.value).toBe(0);
  });

  it("x_times_one — simplify x * 1 → x", () => {
    const expr = binOp("*", varNode("x"), numNode(1));
    const s = simplify(expr);
    expect(s.kind).toBe("variable");
    if (s.kind === "variable") expect(s.name).toBe("x");
  });

  it("one_times_x — simplify 1 * x → x", () => {
    const expr = binOp("*", numNode(1), varNode("x"));
    const s = simplify(expr);
    expect(s.kind).toBe("variable");
    if (s.kind === "variable") expect(s.name).toBe("x");
  });

  it("x_to_power_one — simplify x^1 → x", () => {
    const expr = binOp("^", varNode("x"), numNode(1));
    const s = simplify(expr);
    expect(s.kind).toBe("variable");
    if (s.kind === "variable") expect(s.name).toBe("x");
  });

  it("x_to_power_zero — simplify x^0 → 1", () => {
    const expr = binOp("^", varNode("x"), numNode(0));
    const s = simplify(expr);
    expect(s.kind).toBe("number");
    if (s.kind === "number") expect(s.value).toBe(1);
  });

  it("constant_fold_addition — simplify 3 + 4 → 7", () => {
    const expr = binOp("+", numNode(3), numNode(4));
    const s = simplify(expr);
    expect(s.kind).toBe("number");
    if (s.kind === "number") expect(s.value).toBe(7);
  });

  it("constant_fold_multiplication — simplify 3 * 4 → 12", () => {
    const expr = binOp("*", numNode(3), numNode(4));
    const s = simplify(expr);
    expect(s.kind).toBe("number");
    if (s.kind === "number") expect(s.value).toBe(12);
  });

  it("unary_minus_zero — simplify -(0) → 0", () => {
    const expr = { kind: "unary" as const, op: "-" as const, operand: numNode(0) };
    const s = simplify(expr);
    expect(s.kind).toBe("number");
    if (s.kind === "number") expect(s.value).toBe(0);
  });
});
