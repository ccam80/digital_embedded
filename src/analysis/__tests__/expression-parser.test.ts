/**
 * Tests for expression-parser.ts (Task 8.2.4).
 *
 * Covers:
 *   simpleAnd      - "A & B" → correct BoolExpr tree
 *   precedence     - "A | B & C" → OR(A, AND(B,C))
 *   notOperator    - "!A" → NOT(A)
 *   parentheses    - "(A | B) & C" → AND(OR(A,B), C)
 *   syntaxError    - "A & " → error with position
 *   allOperators   - &, *, |, +, !, ~ all recognized
 */

import { describe, expect, it } from 'vitest';
import { parseExpression, ParseError } from '../expression-parser.js';
import { exprToString, evaluate } from '../expression.js';

// ---------------------------------------------------------------------------
// simpleAnd- "A & B" → correct BoolExpr tree
// ---------------------------------------------------------------------------

describe('simpleAnd', () => {
  it('parses "A & B" to AND(A, B)', () => {
    const expr = parseExpression('A & B');
    expect(expr.kind).toBe('and');
    if (expr.kind === 'and') {
      expect(expr.operands).toHaveLength(2);
      expect(expr.operands[0]).toEqual({ kind: 'variable', name: 'A', negated: false });
      expect(expr.operands[1]).toEqual({ kind: 'variable', name: 'B', negated: false });
    }
  });

  it('round-trips to "A & B" string', () => {
    const expr = parseExpression('A & B');
    expect(exprToString(expr)).toBe('A & B');
  });

  it('parses single variable "A"', () => {
    const expr = parseExpression('A');
    expect(expr).toEqual({ kind: 'variable', name: 'A', negated: false });
  });

  it('parses constant "1"', () => {
    const expr = parseExpression('1');
    expect(expr).toEqual({ kind: 'constant', value: true });
  });

  it('parses constant "0"', () => {
    const expr = parseExpression('0');
    expect(expr).toEqual({ kind: 'constant', value: false });
  });
});

// ---------------------------------------------------------------------------
// precedence- "A | B & C" → OR(A, AND(B,C))
// ---------------------------------------------------------------------------

describe('precedence', () => {
  it('"A | B & C" has AND binding tighter than OR', () => {
    const expr = parseExpression('A | B & C');
    expect(expr.kind).toBe('or');
    if (expr.kind === 'or') {
      expect(expr.operands).toHaveLength(2);
      expect(expr.operands[0]).toEqual({ kind: 'variable', name: 'A', negated: false });
      const andExpr = expr.operands[1]!;
      expect(andExpr.kind).toBe('and');
      if (andExpr.kind === 'and') {
        expect(andExpr.operands).toHaveLength(2);
        expect(andExpr.operands[0]).toEqual({ kind: 'variable', name: 'B', negated: false });
        expect(andExpr.operands[1]).toEqual({ kind: 'variable', name: 'C', negated: false });
      }
    }
  });

  it('"A & B | C & D" groups correctly', () => {
    const expr = parseExpression('A & B | C & D');
    expect(expr.kind).toBe('or');
    if (expr.kind === 'or') {
      expect(expr.operands).toHaveLength(2);
      expect(expr.operands[0]!.kind).toBe('and');
      expect(expr.operands[1]!.kind).toBe('and');
    }
  });

  it('NOT binds tighter than AND: "!A & B" → AND(NOT(A), B)', () => {
    const expr = parseExpression('!A & B');
    expect(expr.kind).toBe('and');
    if (expr.kind === 'and') {
      expect(expr.operands[0]!.kind).toBe('not');
      expect(expr.operands[1]).toEqual({ kind: 'variable', name: 'B', negated: false });
    }
  });

  it('evaluates consistently with precedence rules', () => {
    // A | B & C with A=0, B=1, C=1 → 0 | (1&1) = 1
    const expr = parseExpression('A | B & C');
    const env = new Map([['A', false], ['B', true], ['C', true]]);
    expect(evaluate(expr, env)).toBe(true);

    // A | B & C with A=0, B=0, C=1 → 0 | (0&1) = 0
    const env2 = new Map([['A', false], ['B', false], ['C', true]]);
    expect(evaluate(expr, env2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// notOperator- "!A" → NOT(A)
// ---------------------------------------------------------------------------

describe('notOperator', () => {
  it('"!A" produces a not node wrapping variable A', () => {
    const expr = parseExpression('!A');
    expect(expr.kind).toBe('not');
    if (expr.kind === 'not') {
      expect(expr.operand).toEqual({ kind: 'variable', name: 'A', negated: false });
    }
  });

  it('double NOT "!!A" cancels correctly at evaluation', () => {
    const expr = parseExpression('!!A');
    expect(expr.kind).toBe('not');
    // evaluate: !!true = true, !!false = false
    expect(evaluate(expr, new Map([['A', true]]))).toBe(true);
    expect(evaluate(expr, new Map([['A', false]]))).toBe(false);
  });

  it('"~A" also produces NOT node', () => {
    const expr = parseExpression('~A');
    expect(expr.kind).toBe('not');
  });

  it('"!A" evaluates to negation', () => {
    const expr = parseExpression('!A');
    expect(evaluate(expr, new Map([['A', true]]))).toBe(false);
    expect(evaluate(expr, new Map([['A', false]]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parentheses- "(A | B) & C" → AND(OR(A,B), C)
// ---------------------------------------------------------------------------

describe('parentheses', () => {
  it('"(A | B) & C" overrides precedence', () => {
    const expr = parseExpression('(A | B) & C');
    expect(expr.kind).toBe('and');
    if (expr.kind === 'and') {
      expect(expr.operands[0]!.kind).toBe('or');
      expect(expr.operands[1]).toEqual({ kind: 'variable', name: 'C', negated: false });
    }
  });

  it('"(A | B) & C" evaluates correctly', () => {
    const expr = parseExpression('(A | B) & C');
    // A=0,B=0,C=1 → (0|0)&1 = 0
    expect(evaluate(expr, new Map([['A', false], ['B', false], ['C', true]]))).toBe(false);
    // A=1,B=0,C=1 → (1|0)&1 = 1
    expect(evaluate(expr, new Map([['A', true], ['B', false], ['C', true]]))).toBe(true);
    // A=1,B=0,C=0 → (1|0)&0 = 0
    expect(evaluate(expr, new Map([['A', true], ['B', false], ['C', false]]))).toBe(false);
  });

  it('nested parentheses parse correctly', () => {
    const expr = parseExpression('((A))');
    expect(expr).toEqual({ kind: 'variable', name: 'A', negated: false });
  });

  it('unmatched RPAREN throws ParseError', () => {
    expect(() => parseExpression('A & B)')).toThrow(ParseError);
  });

  it('unmatched LPAREN throws ParseError', () => {
    expect(() => parseExpression('(A & B')).toThrow(ParseError);
  });
});

// ---------------------------------------------------------------------------
// syntaxError- "A & " → error with position
// ---------------------------------------------------------------------------

describe('syntaxError', () => {
  it('"A & " throws ParseError', () => {
    expect(() => parseExpression('A & ')).toThrow(ParseError);
  });

  it('error position is reported', () => {
    try {
      parseExpression('A & ');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).position).toBeGreaterThanOrEqual(0);
    }
  });

  it('"A & " error position points past the operator (at EOF)', () => {
    try {
      parseExpression('A & ');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      // EOF is at position 4 (length of 'A & ')
      expect((err as ParseError).position).toBe(4);
    }
  });

  it('error message includes position', () => {
    try {
      parseExpression('A & ');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toContain('position');
    }
  });

  it('unknown character throws ParseError', () => {
    expect(() => parseExpression('A @ B')).toThrow(ParseError);
  });

  it('unknown character error position is correct', () => {
    try {
      parseExpression('A @ B');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).position).toBe(2); // '@' is at index 2
    }
  });
});

// ---------------------------------------------------------------------------
// allOperators- &, *, |, +, !, ~ all recognized
// ---------------------------------------------------------------------------

describe('allOperators', () => {
  it('"A * B" is AND', () => {
    const expr = parseExpression('A * B');
    expect(expr.kind).toBe('and');
  });

  it('"A + B" is OR', () => {
    const expr = parseExpression('A + B');
    expect(expr.kind).toBe('or');
  });

  it('"A & B" is AND', () => {
    const expr = parseExpression('A & B');
    expect(expr.kind).toBe('and');
  });

  it('"A | B" is OR', () => {
    const expr = parseExpression('A | B');
    expect(expr.kind).toBe('or');
  });

  it('"!A" is NOT', () => {
    const expr = parseExpression('!A');
    expect(expr.kind).toBe('not');
  });

  it('"~A" is NOT', () => {
    const expr = parseExpression('~A');
    expect(expr.kind).toBe('not');
  });

  it('"A · B" (middle dot) is AND', () => {
    const expr = parseExpression('A · B');
    expect(expr.kind).toBe('and');
    if (expr.kind === 'and') {
      expect(expr.operands[0]).toEqual({ kind: 'variable', name: 'A', negated: false });
      expect(expr.operands[1]).toEqual({ kind: 'variable', name: 'B', negated: false });
    }
  });

  it('"¬A" (logical not symbol) is NOT', () => {
    const expr = parseExpression('¬A');
    expect(expr.kind).toBe('not');
  });

  it('all AND operators produce functionally equivalent results', () => {
    const expr1 = parseExpression('A & B');
    const expr2 = parseExpression('A * B');
    const expr3 = parseExpression('A · B');

    for (const [a, b] of [[true, true], [true, false], [false, true], [false, false]] as [boolean, boolean][]) {
      const env = new Map([['A', a], ['B', b]]);
      expect(evaluate(expr1, env)).toBe(evaluate(expr2, env));
      expect(evaluate(expr1, env)).toBe(evaluate(expr3, env));
    }
  });

  it('all OR operators produce functionally equivalent results', () => {
    const expr1 = parseExpression('A | B');
    const expr2 = parseExpression('A + B');

    for (const [a, b] of [[true, true], [true, false], [false, true], [false, false]] as [boolean, boolean][]) {
      const env = new Map([['A', a], ['B', b]]);
      expect(evaluate(expr1, env)).toBe(evaluate(expr2, env));
    }
  });

  it('multi-character variable names parsed correctly', () => {
    const expr = parseExpression('var1 & x0');
    expect(expr.kind).toBe('and');
    if (expr.kind === 'and') {
      expect(expr.operands[0]).toEqual({ kind: 'variable', name: 'var1', negated: false });
      expect(expr.operands[1]).toEqual({ kind: 'variable', name: 'x0', negated: false });
    }
  });
});
