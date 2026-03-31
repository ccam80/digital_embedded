/**
 * Runtime evaluator for the extended expression AST.
 *
 * Handles the full ExprNode union including circuit-voltage, circuit-current,
 * builtin-var (time, freq), and builtin-func (random) nodes introduced in
 * Phase 5. Provides both a tree-walking interpreter and a compiled closure
 * for hot-path evaluation.
 */

import type { ExprNode } from "./expression.js";
import { UnknownNodeKindError } from "./expression.js";

// ---------------------------------------------------------------------------
// ExpressionContext
// ---------------------------------------------------------------------------

/**
 * Runtime binding context supplied to the evaluator during simulation.
 * Resolves circuit quantities and simulation state for V(), I(), time, freq.
 */
export interface ExpressionContext {
  /** Returns the voltage at the node identified by label. */
  getNodeVoltage(label: string): number;
  /** Returns the branch current flowing through the element identified by label. */
  getBranchCurrent(label: string): number;
  /** Current simulation time in seconds. */
  time: number;
  /** Frequency for AC analysis in Hz. Undefined during transient/DC. */
  freq?: number;
  /**
   * Optional map of plain named variables (e.g. parameter sweeps, symbolic
   * differentiation evaluation). Looked up for `variable` nodes after
   * built-in constants.
   */
  variables?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Built-in constants and math functions (shared with base parser)
// ---------------------------------------------------------------------------

const BUILTIN_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const BUILTIN_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  pow: Math.pow,
};

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

/**
 * Evaluate an ExprNode AST given a runtime context.
 *
 * Handles all node types including the Phase 5 extensions (circuit-voltage,
 * circuit-current, builtin-var, builtin-func). Built-in constants (pi, e) are
 * always available; variable nodes look up in BUILTIN_CONSTANTS first.
 *
 * Throws UnknownNodeKindError for any unrecognized node kind.
 */
export function evaluate(expr: ExprNode, ctx: ExpressionContext): number {
  switch (expr.kind) {
    case "number":
      return expr.value;

    case "variable": {
      const name = expr.name;
      if (name in BUILTIN_CONSTANTS) {
        return BUILTIN_CONSTANTS[name];
      }
      if (ctx.variables !== undefined && name in ctx.variables) {
        return ctx.variables[name];
      }
      throw new Error(`Undefined variable "${name}" — use ExpressionContext for runtime bindings`);
    }

    case "unary":
      return -evaluate(expr.operand, ctx);

    case "binary": {
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "^": return Math.pow(left, right);
      }
    }

    case "call": {
      const fn = expr.fn;
      const impl = BUILTIN_FUNCTIONS[fn];
      if (impl === undefined) {
        throw new Error(`Unknown function "${fn}"`);
      }
      const args = expr.args.map((a) => evaluate(a, ctx));
      return impl(...args);
    }

    case "circuit-voltage":
      return ctx.getNodeVoltage(expr.label);

    case "circuit-current":
      return ctx.getBranchCurrent(expr.label);

    case "builtin-var":
      if (expr.name === "time") return ctx.time;
      if (expr.name === "freq") return ctx.freq ?? 0;
      throw new UnknownNodeKindError((expr as { name: string }).name);

    case "builtin-func":
      if (expr.name === "random") return Math.random();
      throw new UnknownNodeKindError((expr as { name: string }).name);

    default: {
      const exhaustive: never = expr;
      throw new UnknownNodeKindError((exhaustive as ExprNode).kind);
    }
  }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile an ExprNode AST into a closure for repeated evaluation.
 *
 * The returned function avoids repeated tree-walking on the hot path. The
 * compiled closure captures the AST structure at call sites and invokes the
 * same semantics as `evaluate()`.
 */
export function compileExpression(expr: ExprNode): (ctx: ExpressionContext) => number {
  switch (expr.kind) {
    case "number": {
      const v = expr.value;
      return () => v;
    }

    case "variable": {
      const name = expr.name;
      if (name in BUILTIN_CONSTANTS) {
        const v = BUILTIN_CONSTANTS[name];
        return () => v;
      }
      return (ctx) => {
        if (ctx.variables !== undefined && name in ctx.variables) {
          return ctx.variables[name];
        }
        throw new Error(`Undefined variable "${name}"`);
      };
    }

    case "unary": {
      const compiledOperand = compileExpression(expr.operand);
      return (ctx) => -compiledOperand(ctx);
    }

    case "binary": {
      const compiledLeft = compileExpression(expr.left);
      const compiledRight = compileExpression(expr.right);
      switch (expr.op) {
        case "+": return (ctx) => compiledLeft(ctx) + compiledRight(ctx);
        case "-": return (ctx) => compiledLeft(ctx) - compiledRight(ctx);
        case "*": return (ctx) => compiledLeft(ctx) * compiledRight(ctx);
        case "/": return (ctx) => compiledLeft(ctx) / compiledRight(ctx);
        case "^": return (ctx) => Math.pow(compiledLeft(ctx), compiledRight(ctx));
      }
    }

    case "call": {
      const fn = expr.fn;
      const impl = BUILTIN_FUNCTIONS[fn];
      if (impl === undefined) {
        return () => { throw new Error(`Unknown function "${fn}"`); };
      }
      const compiledArgs = expr.args.map(compileExpression);
      return (ctx) => impl(...compiledArgs.map((a) => a(ctx)));
    }

    case "circuit-voltage": {
      const label = expr.label;
      return (ctx) => ctx.getNodeVoltage(label);
    }

    case "circuit-current": {
      const label = expr.label;
      return (ctx) => ctx.getBranchCurrent(label);
    }

    case "builtin-var": {
      if (expr.name === "time") return (ctx) => ctx.time;
      if (expr.name === "freq") return (ctx) => ctx.freq ?? 0;
      const name = expr.name;
      return () => { throw new UnknownNodeKindError(name); };
    }

    case "builtin-func": {
      if (expr.name === "random") return () => Math.random();
      const name = (expr as { name: string }).name;
      return () => { throw new UnknownNodeKindError(name); };
    }

    default: {
      const exhaustive: never = expr;
      const kind = (exhaustive as ExprNode).kind;
      return () => { throw new UnknownNodeKindError(kind); };
    }
  }
}
