/**
 * Tests for the arithmetic expression parser and evaluator.
 *
 * Covers:
 *   - Basic arithmetic with correct operator precedence
 *   - Right-associative power operator
 *   - Unary minus
 *   - Parenthesized sub-expressions
 *   - Variable binding from environment
 *   - Built-in constants (pi, e)
 *   - Built-in functions (trig, exp/log, min/max, etc.)
 *   - Multi-argument functions
 *   - Error cases: missing variable, invalid syntax, unknown function
 *   - IEEE 754 edge cases (division by zero → Infinity)
 *   - Primary use case: 5 * sin(2 * pi * 1000 * t)
 */

import { describe, it, expect } from "vitest";
import {
  parseExpression,
  evaluateExpression,
  ExprParseError,
  UnknownNodeKindError,
  numNode,
  varNode,
  binOp,
  unaryOp,
  callNode,
} from "../expression.js";

// ---------------------------------------------------------------------------
// Helper: parse + evaluate in one step
// ---------------------------------------------------------------------------

function calc(text: string, env: Record<string, number> = {}): number {
  return evaluateExpression(parseExpression(text), env);
}

// ===========================================================================
// ExprParser tests
// ===========================================================================

describe("ExprParser", () => {
  it("basic_arithmetic — 2 + 3 * 4 = 14", () => {
    expect(calc("2 + 3 * 4")).toBe(14);
  });

  it("operator_precedence — 2 + 3 * 4 ^ 2 = 50", () => {
    expect(calc("2 + 3 * 4 ^ 2")).toBe(50);
  });

  it("parentheses — (2 + 3) * 4 = 20", () => {
    expect(calc("(2 + 3) * 4")).toBe(20);
  });

  it("unary_minus — -3 + 5 = 2", () => {
    expect(calc("-3 + 5")).toBe(2);
  });

  it("variables — 2 * t + 1 with t=3 gives 7", () => {
    expect(calc("2 * t + 1", { t: 3 })).toBe(7);
  });

  it("trig_functions — sin(pi / 2) ≈ 1.0", () => {
    expect(calc("sin(pi / 2)")).toBeCloseTo(1.0, 10);
  });

  it("nested_functions — sqrt(abs(-16)) = 4.0", () => {
    expect(calc("sqrt(abs(-16))")).toBe(4.0);
  });

  it("multi_arg_functions — max(3, 7) = 7", () => {
    expect(calc("max(3, 7)")).toBe(7);
  });

  it("exp_and_log — log(exp(3)) ≈ 3.0", () => {
    expect(calc("log(exp(3))")).toBeCloseTo(3.0, 10);
  });

  it("power_right_associative — 2 ^ 3 ^ 2 = 512", () => {
    // Right-associative: 2 ^ (3 ^ 2) = 2 ^ 9 = 512
    // NOT (2 ^ 3) ^ 2 = 8 ^ 2 = 64
    expect(calc("2 ^ 3 ^ 2")).toBe(512);
  });

  it("constants — 2 * pi ≈ 6.2832", () => {
    expect(calc("2 * pi")).toBeCloseTo(2 * Math.PI, 4);
  });

  it("division_by_zero — 1 / 0 = Infinity (IEEE 754)", () => {
    expect(calc("1 / 0")).toBe(Infinity);
  });

  it("missing_variable_throws — x + 1 with empty env throws ExprParseError mentioning 'x'", () => {
    const expr = parseExpression("x + 1");
    expect(() => evaluateExpression(expr, {})).toThrow(ExprParseError);
    expect(() => evaluateExpression(expr, {})).toThrow("x");
  });

  it("invalid_syntax_throws — '2 + + 3' throws ExprParseError with position", () => {
    expect(() => parseExpression("2 + + 3")).toThrow(ExprParseError);
  });

  it("complex_expression — 5 * sin(2 * pi * 1000 * t) at t=0.00025 ≈ 5.0", () => {
    // Quarter period of 1kHz: sin(2π * 1000 * 0.00025) = sin(π/2) = 1.0
    const result = calc("5 * sin(2 * pi * 1000 * t)", { t: 0.00025 });
    expect(result).toBeCloseTo(5.0, 8);
  });
});

// ===========================================================================
// Additional coverage
// ===========================================================================

describe("ExprParser extended", () => {
  it("subtraction — 10 - 3 = 7", () => {
    expect(calc("10 - 3")).toBe(7);
  });

  it("division — 10 / 4 = 2.5", () => {
    expect(calc("10 / 4")).toBe(2.5);
  });

  it("chained addition — 1 + 2 + 3 = 6", () => {
    expect(calc("1 + 2 + 3")).toBe(6);
  });

  it("nested unary — --5 = 5", () => {
    expect(calc("- -5")).toBe(5);
  });

  it("e constant is Euler's number", () => {
    expect(calc("e")).toBeCloseTo(Math.E, 10);
  });

  it("atan2 two-arg function — atan2(1, 1) ≈ pi/4", () => {
    expect(calc("atan2(1, 1)")).toBeCloseTo(Math.PI / 4, 10);
  });

  it("pow function — pow(2, 10) = 1024", () => {
    expect(calc("pow(2, 10)")).toBe(1024);
  });

  it("min function — min(5, 3) = 3", () => {
    expect(calc("min(5, 3)")).toBe(3);
  });

  it("floor function — floor(3.7) = 3", () => {
    expect(calc("floor(3.7)")).toBe(3);
  });

  it("ceil function — ceil(3.1) = 4", () => {
    expect(calc("ceil(3.1)")).toBe(4);
  });

  it("round function — round(3.5) = 4", () => {
    expect(calc("round(3.5)")).toBe(4);
  });

  it("log10 — log10(1000) = 3", () => {
    expect(calc("log10(1000)")).toBeCloseTo(3, 10);
  });

  it("sqrt — sqrt(9) = 3", () => {
    expect(calc("sqrt(9)")).toBe(3);
  });

  it("cos — cos(0) = 1", () => {
    expect(calc("cos(0)")).toBe(1);
  });

  it("asin — asin(1) ≈ pi/2", () => {
    expect(calc("asin(1)")).toBeCloseTo(Math.PI / 2, 10);
  });

  it("acos — acos(1) = 0", () => {
    expect(calc("acos(1)")).toBeCloseTo(0, 10);
  });

  it("atan — atan(1) ≈ pi/4", () => {
    expect(calc("atan(1)")).toBeCloseTo(Math.PI / 4, 10);
  });

  it("unknown function throws ExprParseError", () => {
    const expr = parseExpression("foo(1)");
    expect(() => evaluateExpression(expr, {})).toThrow(ExprParseError);
    expect(() => evaluateExpression(expr, {})).toThrow("foo");
  });

  it("deeply nested parentheses — ((2 + 3)) * 4 = 20", () => {
    expect(calc("((2 + 3)) * 4")).toBe(20);
  });

  it("expression with multiple variables", () => {
    expect(calc("a + b * c", { a: 1, b: 2, c: 3 })).toBe(7);
  });

  it("unary minus on variable — -t with t=5 gives -5", () => {
    expect(calc("-t", { t: 5 })).toBe(-5);
  });

  it("unary minus on function — -sin(0) = 0", () => {
    expect(calc("-sin(0)")).toBe(-0);
  });

  it("integer literal = exact value", () => {
    expect(calc("42")).toBe(42);
  });

  it("decimal literal — 3.14 parses correctly", () => {
    expect(calc("3.14")).toBeCloseTo(3.14, 10);
  });

  it("scientific notation — 1e-3 = 0.001", () => {
    expect(calc("1e-3")).toBeCloseTo(0.001, 15);
  });

  it("scientific notation uppercase E — 2.5E6 = 2500000", () => {
    expect(calc("2.5E6")).toBe(2500000);
  });
});

// ===========================================================================
// AST constructor helpers
// ===========================================================================

describe("AST helpers", () => {
  it("numNode creates a number node", () => {
    const n = numNode(42);
    expect(n.kind).toBe("number");
    if (n.kind === "number") expect(n.value).toBe(42);
  });

  it("varNode creates a variable node", () => {
    const n = varNode("t");
    expect(n.kind).toBe("variable");
    if (n.kind === "variable") expect(n.name).toBe("t");
  });

  it("binOp creates a binary node", () => {
    const n = binOp("+", numNode(1), numNode(2));
    expect(n.kind).toBe("binary");
    if (n.kind === "binary") expect(n.op).toBe("+");
  });

  it("unaryOp creates a unary node", () => {
    const n = unaryOp("-", numNode(5));
    expect(n.kind).toBe("unary");
    if (n.kind === "unary") expect(n.op).toBe("-");
  });

  it("callNode creates a call node", () => {
    const n = callNode("sin", [numNode(0)]);
    expect(n.kind).toBe("call");
    if (n.kind === "call") {
      expect(n.fn).toBe("sin");
      expect(n.args).toHaveLength(1);
    }
  });

  it("AST built programmatically evaluates correctly — sin(pi/2) = 1", () => {
    // Build: sin(pi / 2) manually
    const ast = callNode("sin", [binOp("/", varNode("pi"), numNode(2))]);
    expect(evaluateExpression(ast, {})).toBeCloseTo(1.0, 10);
  });

  it("UnknownNodeKindError is thrown for unknown node kind", () => {
    const badNode = { kind: "unknown-kind" } as unknown as import("../expression.js").ExprNode;
    expect(() => evaluateExpression(badNode, {})).toThrow(UnknownNodeKindError);
  });
});

// ===========================================================================
// Error message quality
// ===========================================================================

describe("ExprParseError quality", () => {
  it("ExprParseError has position field", () => {
    try {
      parseExpression("1 + @");
    } catch (e) {
      expect(e).toBeInstanceOf(ExprParseError);
      expect((e as ExprParseError).position).toBeGreaterThanOrEqual(0);
    }
  });

  it("missing variable error mentions the variable name", () => {
    const expr = parseExpression("foo + 1");
    let thrown: Error | undefined;
    try {
      evaluateExpression(expr, {});
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("foo");
  });
});
