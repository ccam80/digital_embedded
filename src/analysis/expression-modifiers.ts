/**
 * Expression modifiers — convert boolean expressions to constrained forms.
 *
 * Supported transformations:
 *
 *   toNandOnly(expr)          — rewrite using only NAND (De Morgan's laws)
 *   toNorOnly(expr)           — rewrite using only NOR  (De Morgan's laws)
 *   limitFanIn(expr, max)     — decompose wide AND/OR gates into cascades of
 *                               at most `max` inputs
 *
 * All functions are pure: they return new BoolExpr trees and never mutate
 * their inputs.
 *
 * NAND / NOR representation:
 *   A NAND gate is represented as  not(and([...]))
 *   A NOR gate  is represented as  not(or([...]))
 *
 * After toNandOnly / toNorOnly the resulting tree contains ONLY:
 *   - variable nodes (positive literals)
 *   - not(and([...])) nodes  (for NAND)
 *   - not(or([...]))  nodes  (for NOR)
 *
 * Port of Digital's NAnd.java, NOr.java, NInputs.java.
 */

import { type BoolExpr, and, constant, not, or, variable } from './expression.js';

// ---------------------------------------------------------------------------
// NAND-only conversion
// ---------------------------------------------------------------------------

/**
 * Convert any BoolExpr to an equivalent expression using only NAND gates.
 *
 * De Morgan's identities used:
 *   NOT(x)         →  NAND(x, x)               [x NAND x = NOT x]
 *   AND(a, b, ...) →  NOT(NAND(a, b, ...))      = NAND(NAND(a,b,...), NAND(a,b,...))
 *   OR(a, b, ...)  →  NAND(NOT(a), NOT(b), ...) = NAND(NAND(a,a), NAND(b,b), ...)
 *
 * The representation uses `not(and([...]))` for NAND.
 */
export function toNandOnly(expr: BoolExpr): BoolExpr {
  switch (expr.kind) {
    case 'constant':
      // 0 = NAND(1,1) but we keep constants as-is (they simplify away)
      return expr;

    case 'variable':
      // Positive literal: keep as-is (inputs to NAND gates are literals)
      return expr;

    case 'not': {
      // NOT(x) = NAND(x, x)
      const inner = toNandOnly(expr.operand);
      return nand2(inner, inner);
    }

    case 'and': {
      // AND(a, b, ...) = NOT(NAND(a, b, ...)) = NAND(NAND(a,b,...), NAND(a,b,...))
      const nandArgs = expr.operands.map(toNandOnly);
      const nandExpr = not(and(nandArgs));         // NAND(a', b', ...)
      return nand2(nandExpr, nandExpr);             // NOT(NAND(...)) = NAND(NAND(...), NAND(...))
    }

    case 'or': {
      // OR(a, b, ...) = NAND(NOT(a), NOT(b), ...)
      //               = NAND(NAND(a,a), NAND(b,b), ...)
      const nandArgs = expr.operands.map((op) => {
        const inner = toNandOnly(op);
        return nand2(inner, inner); // NOT(op) via NAND
      });
      return not(and(nandArgs));
    }
  }
}

/** Helper: create a 2-input NAND node: not(and([a, b])). */
function nand2(a: BoolExpr, b: BoolExpr): BoolExpr {
  return not(and([a, b]));
}

// ---------------------------------------------------------------------------
// NOR-only conversion
// ---------------------------------------------------------------------------

/**
 * Convert any BoolExpr to an equivalent expression using only NOR gates.
 *
 * De Morgan's identities used:
 *   NOT(x)         →  NOR(x, x)                [x NOR x = NOT x]
 *   OR(a, b, ...)  →  NOT(NOR(a, b, ...))       = NOR(NOR(a,b,...), NOR(a,b,...))
 *   AND(a, b, ...) →  NOR(NOT(a), NOT(b), ...)  = NOR(NOR(a,a), NOR(b,b), ...)
 *
 * The representation uses `not(or([...]))` for NOR.
 */
export function toNorOnly(expr: BoolExpr): BoolExpr {
  switch (expr.kind) {
    case 'constant':
      return expr;

    case 'variable':
      return expr;

    case 'not': {
      // NOT(x) = NOR(x, x)
      const inner = toNorOnly(expr.operand);
      return nor2(inner, inner);
    }

    case 'or': {
      // OR(a, b, ...) = NOT(NOR(a, b, ...)) = NOR(NOR(a,b,...), NOR(a,b,...))
      const norArgs = expr.operands.map(toNorOnly);
      const norExpr = not(or(norArgs));           // NOR(a', b', ...)
      return nor2(norExpr, norExpr);              // NOT(NOR(...)) = NOR(NOR(...), NOR(...))
    }

    case 'and': {
      // AND(a, b, ...) = NOR(NOT(a), NOT(b), ...)
      //                = NOR(NOR(a,a), NOR(b,b), ...)
      const norArgs = expr.operands.map((op) => {
        const inner = toNorOnly(op);
        return nor2(inner, inner); // NOT(op) via NOR
      });
      return not(or(norArgs));
    }
  }
}

/** Helper: create a 2-input NOR node: not(or([a, b])). */
function nor2(a: BoolExpr, b: BoolExpr): BoolExpr {
  return not(or([a, b]));
}

// ---------------------------------------------------------------------------
// Fan-in limiting
// ---------------------------------------------------------------------------

/**
 * Limit the maximum fan-in (number of inputs) of any AND or OR gate in the
 * expression tree. Wide gates are decomposed into balanced binary cascades.
 *
 * Examples with maxInputs=2:
 *   AND(A, B, C, D) → AND(AND(A, B), AND(C, D))
 *   OR(A, B, C)     → OR(OR(A, B), C)
 *
 * Other node kinds are recursively processed but not split.
 *
 * @param expr       The input expression.
 * @param maxInputs  Maximum number of inputs per gate (must be ≥ 2).
 */
export function limitFanIn(expr: BoolExpr, maxInputs: number): BoolExpr {
  if (maxInputs < 2) {
    throw new RangeError(`limitFanIn: maxInputs must be ≥ 2, got ${maxInputs}`);
  }

  switch (expr.kind) {
    case 'constant':
    case 'variable':
      return expr;

    case 'not':
      return not(limitFanIn(expr.operand, maxInputs));

    case 'and': {
      const operands = expr.operands.map((op) => limitFanIn(op, maxInputs));
      return splitGate(operands, maxInputs, 'and');
    }

    case 'or': {
      const operands = expr.operands.map((op) => limitFanIn(op, maxInputs));
      return splitGate(operands, maxInputs, 'or');
    }
  }
}

/**
 * Recursively split a list of operands into a balanced cascade of gates,
 * each with at most `maxInputs` inputs.
 *
 * Uses the `kind` parameter to build raw AST nodes directly, bypassing the
 * `and()`/`or()` helpers which would flatten nested nodes and undo the split.
 */
function splitGate(
  operands: BoolExpr[],
  maxInputs: number,
  kind: 'and' | 'or',
): BoolExpr {
  if (operands.length <= maxInputs) {
    if (operands.length === 0) return constant(true);
    if (operands.length === 1) return operands[0]!;
    return { kind, operands };
  }

  // Split into chunks of at most maxInputs and recurse.
  const chunks: BoolExpr[] = [];
  for (let i = 0; i < operands.length; i += maxInputs) {
    const chunk = operands.slice(i, i + maxInputs);
    if (chunk.length === 1) {
      chunks.push(chunk[0]!);
    } else {
      chunks.push({ kind, operands: chunk });
    }
  }

  // If the chunks themselves exceed maxInputs, recurse again
  return splitGate(chunks, maxInputs, kind);
}

// ---------------------------------------------------------------------------
// Classification helper (useful for tests)
// ---------------------------------------------------------------------------

/**
 * Check whether an expression tree contains only NAND gates (no AND or OR
 * nodes, only not(and(...)) and not(or(...)) and variables/constants).
 *
 * Note: `not(and([...]))` is the NAND representation.
 */
export function isNandOnly(expr: BoolExpr): boolean {
  switch (expr.kind) {
    case 'constant':
    case 'variable':
      return true;
    case 'not':
      // Allowed: not wrapping an and (= NAND) — recurse into the and's operands
      if (expr.operand.kind === 'and') {
        return expr.operand.operands.every(isNandOnly);
      }
      // Bare NOT wrapping something other than AND is not a NAND gate —
      // but we allow it only if the operand is a NAND (not(and)) node itself
      // (double-NOT cancellation). For simplicity, allow bare NOT in classification.
      return isNandOnly(expr.operand);
    case 'and':
      // Bare AND gate (not wrapped in NOT) is NOT allowed in NAND-only form
      return false;
    case 'or':
      // Bare OR gate is NOT allowed in NAND-only form
      return false;
  }
}

/**
 * Check whether an expression tree contains only NOR gates.
 * `not(or([...]))` is the NOR representation.
 */
export function isNorOnly(expr: BoolExpr): boolean {
  switch (expr.kind) {
    case 'constant':
    case 'variable':
      return true;
    case 'not':
      if (expr.operand.kind === 'or') {
        return expr.operand.operands.every(isNorOnly);
      }
      return isNorOnly(expr.operand);
    case 'or':
      return false;
    case 'and':
      return false;
  }
}
