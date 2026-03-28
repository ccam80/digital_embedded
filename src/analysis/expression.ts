/**
 * Boolean expression representation.
 *
 * BoolExpr is a tagged-union AST for boolean algebra expressions. Each node
 * kind corresponds to a fundamental construct:
 *
 *   variable  — a named signal, optionally negated
 *   and       — conjunction of two or more sub-expressions
 *   or        — disjunction of two or more sub-expressions
 *   not       — logical negation of a sub-expression
 *   constant  — a literal true or false value
 *
 * The `negated` flag on variable nodes allows compact representation of
 * literals (A, !A) without an extra `not` wrapper. The `not` node kind is
 * available for general use (e.g. NOT of compound sub-expressions).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BoolExpr =
  | { readonly kind: 'variable'; readonly name: string; readonly negated: boolean }
  | { readonly kind: 'and'; readonly operands: readonly BoolExpr[] }
  | { readonly kind: 'or'; readonly operands: readonly BoolExpr[] }
  | { readonly kind: 'not'; readonly operand: BoolExpr }
  | { readonly kind: 'constant'; readonly value: boolean };

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** Create a positive (un-negated) variable literal. */
export function variable(name: string): BoolExpr {
  return { kind: 'variable', name, negated: false };
}

/** Create a negated variable literal. */
export function negatedVariable(name: string): BoolExpr {
  return { kind: 'variable', name, negated: true };
}

/** Create a NOT node around any expression. */
export function not(operand: BoolExpr): BoolExpr {
  return { kind: 'not', operand };
}

/**
 * Create an AND node.
 * Flattens nested AND nodes so the result is always a flat conjunction.
 * Returns the single operand directly when given exactly one.
 * Returns a constant TRUE when given an empty list.
 */
export function and(operands: readonly BoolExpr[]): BoolExpr {
  const flat = flattenKind('and', operands);
  if (flat.length === 0) return constant(true);
  if (flat.length === 1) return flat[0]!;
  return { kind: 'and', operands: flat };
}

/**
 * Create an OR node.
 * Flattens nested OR nodes so the result is always a flat disjunction.
 * Returns the single operand directly when given exactly one.
 * Returns a constant FALSE when given an empty list.
 */
export function or(operands: readonly BoolExpr[]): BoolExpr {
  const flat = flattenKind('or', operands);
  if (flat.length === 0) return constant(false);
  if (flat.length === 1) return flat[0]!;
  return { kind: 'or', operands: flat };
}

/** Create a boolean constant. */
export function constant(value: boolean): BoolExpr {
  return { kind: 'constant', value };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a BoolExpr given a mapping from variable names to boolean values.
 */
export function evaluate(expr: BoolExpr, env: ReadonlyMap<string, boolean>): boolean {
  switch (expr.kind) {
    case 'constant':
      return expr.value;
    case 'variable': {
      const v = env.get(expr.name);
      if (v === undefined) {
        throw new Error(`evaluate: variable "${expr.name}" not bound in environment`);
      }
      return expr.negated ? !v : v;
    }
    case 'not':
      return !evaluate(expr.operand, env);
    case 'and':
      return expr.operands.every((op) => evaluate(op, env));
    case 'or':
      return expr.operands.some((op) => evaluate(op, env));
  }
}

// ---------------------------------------------------------------------------
// Plain-text formatting
// ---------------------------------------------------------------------------

/**
 * Format a BoolExpr as a plain-text boolean expression string.
 *
 * Operator symbols:
 *   AND  →  " & "
 *   OR   →  " | "
 *   NOT  →  "!"
 *
 * Parentheses are added where needed to preserve precedence.
 * AND binds tighter than OR (standard convention).
 */
export function exprToString(expr: BoolExpr): string {
  return formatPlain(expr, 0);
}

/** Precedence levels used for parenthesisation. Higher = binds tighter. */
const PREC_OR = 1;
const PREC_AND = 2;
const PREC_NOT = 3;

function formatPlain(expr: BoolExpr, outerPrec: number): string {
  switch (expr.kind) {
    case 'constant':
      return expr.value ? '1' : '0';

    case 'variable':
      return expr.negated ? `!${expr.name}` : expr.name;

    case 'not': {
      const inner = formatPlain(expr.operand, PREC_NOT);
      const result = `!${inner}`;
      return outerPrec > PREC_NOT ? `(${result})` : result;
    }

    case 'and': {
      const parts = expr.operands.map((op) => formatPlain(op, PREC_AND));
      const joined = parts.join(' & ');
      return outerPrec > PREC_AND ? `(${joined})` : joined;
    }

    case 'or': {
      const parts = expr.operands.map((op) => formatPlain(op, PREC_OR));
      const joined = parts.join(' | ');
      return outerPrec > PREC_OR ? `(${joined})` : joined;
    }
  }
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

function flattenKind(kind: 'and' | 'or', operands: readonly BoolExpr[]): BoolExpr[] {
  const result: BoolExpr[] = [];
  for (const op of operands) {
    if (op.kind === kind) {
      result.push(...op.operands);
    } else {
      result.push(op);
    }
  }
  return result;
}
