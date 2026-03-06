/**
 * Tests for expression-modifiers.ts (Task 8.2.5).
 *
 * Covers:
 *   nandConversion       — A & B → NAND(NAND(A,B)) equivalent
 *   norConversion        — A | B → NOR(NOR(A,B)) equivalent
 *   fanInLimit           — 4-input AND with limit 2 → cascade of 2-input ANDs
 *   functionalEquivalence — original and modified expressions produce same truth table
 *   nandOnlyVerify       — converted expression contains only NAND and NOT nodes
 */

import { describe, expect, it } from 'vitest';
import {
  toNandOnly,
  toNorOnly,
  limitFanIn,
  isNandOnly,
  isNorOnly,
} from '../expression-modifiers.js';
import { and, constant, evaluate, not, or, variable } from '../expression.js';
import type { BoolExpr } from '../expression.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Enumerate all 2^n assignments for variable names (sorted), call fn for each. */
function forAllAssignments(varNames: string[], fn: (env: Map<string, boolean>) => void): void {
  const n = varNames.length;
  for (let row = 0; row < (1 << n); row++) {
    const env = new Map<string, boolean>();
    for (let i = 0; i < n; i++) {
      env.set(varNames[i]!, Boolean((row >> (n - 1 - i)) & 1));
    }
    fn(env);
  }
}

/** Collect all variable names from an expression (for driving evaluation). */
function collectVars(expr: BoolExpr): string[] {
  const vars = new Set<string>();
  function visit(e: BoolExpr): void {
    switch (e.kind) {
      case 'variable': vars.add(e.name); break;
      case 'not': visit(e.operand); break;
      case 'and': case 'or': e.operands.forEach(visit); break;
      case 'constant': break;
    }
  }
  visit(expr);
  return [...vars].sort();
}

/** Check functional equivalence of two expressions over all variable assignments. */
function areFunctionallyEquivalent(a: BoolExpr, b: BoolExpr): boolean {
  const vars = [...new Set([...collectVars(a), ...collectVars(b)])].sort();
  let equivalent = true;
  forAllAssignments(vars, (env) => {
    if (evaluate(a, env) !== evaluate(b, env)) equivalent = false;
  });
  return equivalent;
}

// ---------------------------------------------------------------------------
// nandConversion — A & B → NAND equivalent
// ---------------------------------------------------------------------------

describe('nandConversion', () => {
  it('converts "A & B" to a NAND-only expression', () => {
    const expr = and([variable('A'), variable('B')]);
    const result = toNandOnly(expr);
    expect(isNandOnly(result)).toBe(true);
  });

  it('"A & B" NAND conversion is functionally equivalent', () => {
    const expr = and([variable('A'), variable('B')]);
    const result = toNandOnly(expr);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('converts NOT to NAND-only', () => {
    const expr = not(variable('A'));
    const result = toNandOnly(expr);
    // NOT(A) = NAND(A, A)
    expect(result.kind).toBe('not');
    if (result.kind === 'not') {
      expect(result.operand.kind).toBe('and');
    }
  });

  it('NOT(A) NAND conversion is functionally equivalent', () => {
    const expr = not(variable('A'));
    const result = toNandOnly(expr);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('converts "A | B" to NAND-only', () => {
    const expr = or([variable('A'), variable('B')]);
    const result = toNandOnly(expr);
    expect(isNandOnly(result)).toBe(true);
  });

  it('"A | B" NAND conversion is functionally equivalent', () => {
    const expr = or([variable('A'), variable('B')]);
    const result = toNandOnly(expr);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('converts 3-variable expression to NAND-only', () => {
    // (A & B) | C
    const expr = or([and([variable('A'), variable('B')]), variable('C')]);
    const result = toNandOnly(expr);
    expect(isNandOnly(result)).toBe(true);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// norConversion — A | B → NOR equivalent
// ---------------------------------------------------------------------------

describe('norConversion', () => {
  it('converts "A | B" to NOR-only', () => {
    const expr = or([variable('A'), variable('B')]);
    const result = toNorOnly(expr);
    expect(isNorOnly(result)).toBe(true);
  });

  it('"A | B" NOR conversion is functionally equivalent', () => {
    const expr = or([variable('A'), variable('B')]);
    const result = toNorOnly(expr);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('converts "A & B" to NOR-only', () => {
    const expr = and([variable('A'), variable('B')]);
    const result = toNorOnly(expr);
    expect(isNorOnly(result)).toBe(true);
  });

  it('"A & B" NOR conversion is functionally equivalent', () => {
    const expr = and([variable('A'), variable('B')]);
    const result = toNorOnly(expr);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('converts NOT to NOR-only', () => {
    const expr = not(variable('A'));
    const result = toNorOnly(expr);
    // NOT(A) = NOR(A, A)
    expect(result.kind).toBe('not');
    if (result.kind === 'not') {
      expect(result.operand.kind).toBe('or');
    }
  });

  it('NOT(A) NOR conversion is functionally equivalent', () => {
    const expr = not(variable('A'));
    const result = toNorOnly(expr);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('converts 3-variable expression to NOR-only', () => {
    const expr = or([and([variable('A'), variable('B')]), variable('C')]);
    const result = toNorOnly(expr);
    expect(isNorOnly(result)).toBe(true);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fanInLimit — 4-input AND with limit 2 → cascade of 2-input ANDs
// ---------------------------------------------------------------------------

describe('fanInLimit', () => {
  it('4-input AND with limit 2 produces a cascade', () => {
    const expr = and([variable('A'), variable('B'), variable('C'), variable('D')]);
    const result = limitFanIn(expr, 2);
    // Top node should be AND
    expect(result.kind).toBe('and');
    if (result.kind === 'and') {
      // Each operand should have at most 2 children
      expect(result.operands).toHaveLength(2);
      for (const op of result.operands) {
        if (op.kind === 'and') {
          expect(op.operands.length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('4-input AND with limit 2 is functionally equivalent', () => {
    const expr = and([variable('A'), variable('B'), variable('C'), variable('D')]);
    const result = limitFanIn(expr, 2);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('2-input AND with limit 2 is unchanged structurally', () => {
    const expr = and([variable('A'), variable('B')]);
    const result = limitFanIn(expr, 2);
    expect(result.kind).toBe('and');
    if (result.kind === 'and') {
      expect(result.operands).toHaveLength(2);
    }
  });

  it('3-input OR with limit 2 splits to 2 levels', () => {
    const expr = or([variable('A'), variable('B'), variable('C')]);
    const result = limitFanIn(expr, 2);
    // Should produce OR(OR(A,B), C) or OR(A, OR(B,C))
    expect(result.kind).toBe('or');
    if (result.kind === 'or') {
      expect(result.operands).toHaveLength(2);
    }
  });

  it('3-input OR with limit 2 is functionally equivalent', () => {
    const expr = or([variable('A'), variable('B'), variable('C')]);
    const result = limitFanIn(expr, 2);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('maxInputs < 2 throws RangeError', () => {
    const expr = variable('A');
    expect(() => limitFanIn(expr, 1)).toThrow(RangeError);
  });

  it('variables and constants pass through unchanged', () => {
    expect(limitFanIn(variable('A'), 2)).toEqual(variable('A'));
    expect(limitFanIn(constant(true), 2)).toEqual(constant(true));
  });

  it('6-input AND with limit 2 produces no gates with more than 2 inputs', () => {
    const vars = ['A', 'B', 'C', 'D', 'E', 'F'].map(variable);
    const expr = and(vars);
    const result = limitFanIn(expr, 2);

    // Verify no AND or OR node has more than 2 operands
    function checkMaxFanIn(e: BoolExpr): void {
      if (e.kind === 'and' || e.kind === 'or') {
        expect(e.operands.length).toBeLessThanOrEqual(2);
        e.operands.forEach(checkMaxFanIn);
      } else if (e.kind === 'not') {
        checkMaxFanIn(e.operand);
      }
    }
    checkMaxFanIn(result);
  });

  it('6-input AND with limit 2 is functionally equivalent', () => {
    const vars = ['A', 'B', 'C', 'D', 'E', 'F'].map(variable);
    const expr = and(vars);
    const result = limitFanIn(expr, 2);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });

  it('limit 3 allows up to 3-input gates', () => {
    const vars = ['A', 'B', 'C', 'D'].map(variable);
    const expr = and(vars);
    const result = limitFanIn(expr, 3);

    function checkMaxFanIn(e: BoolExpr): void {
      if (e.kind === 'and' || e.kind === 'or') {
        expect(e.operands.length).toBeLessThanOrEqual(3);
        e.operands.forEach(checkMaxFanIn);
      } else if (e.kind === 'not') {
        checkMaxFanIn(e.operand);
      }
    }
    checkMaxFanIn(result);
    expect(areFunctionallyEquivalent(expr, result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// functionalEquivalence — all conversions produce same truth table
// ---------------------------------------------------------------------------

describe('functionalEquivalence', () => {
  const testCases: [string, BoolExpr][] = [
    ['A & B', and([variable('A'), variable('B')])],
    ['A | B', or([variable('A'), variable('B')])],
    ['!A & B', and([not(variable('A')), variable('B')])],
    ['A | !B | C', or([variable('A'), not(variable('B')), variable('C')])],
    ['(A & B) | (!A & !B)', or([
      and([variable('A'), variable('B')]),
      and([not(variable('A')), not(variable('B'))]),
    ])],
  ];

  for (const [name, expr] of testCases) {
    it(`toNandOnly(${name}) is functionally equivalent`, () => {
      const result = toNandOnly(expr);
      expect(areFunctionallyEquivalent(expr, result)).toBe(true);
    });

    it(`toNorOnly(${name}) is functionally equivalent`, () => {
      const result = toNorOnly(expr);
      expect(areFunctionallyEquivalent(expr, result)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// nandOnlyVerify — converted expression contains only NAND and NOT nodes
// ---------------------------------------------------------------------------

describe('nandOnlyVerify', () => {
  it('AND(A,B) converted to NAND-only passes isNandOnly check', () => {
    const expr = and([variable('A'), variable('B')]);
    expect(isNandOnly(toNandOnly(expr))).toBe(true);
  });

  it('OR(A,B) converted to NAND-only passes isNandOnly check', () => {
    const expr = or([variable('A'), variable('B')]);
    expect(isNandOnly(toNandOnly(expr))).toBe(true);
  });

  it('complex expression converted to NAND-only passes isNandOnly check', () => {
    const expr = or([
      and([variable('A'), variable('B')]),
      not(variable('C')),
    ]);
    expect(isNandOnly(toNandOnly(expr))).toBe(true);
  });

  it('bare AND fails isNandOnly check', () => {
    const expr = and([variable('A'), variable('B')]);
    expect(isNandOnly(expr)).toBe(false);
  });

  it('bare OR fails isNandOnly check', () => {
    const expr = or([variable('A'), variable('B')]);
    expect(isNandOnly(expr)).toBe(false);
  });

  it('NOR-only check works for OR(A,B) converted', () => {
    const expr = or([variable('A'), variable('B')]);
    expect(isNorOnly(toNorOnly(expr))).toBe(true);
  });

  it('bare OR fails isNorOnly check', () => {
    const expr = or([variable('A'), variable('B')]);
    expect(isNorOnly(expr)).toBe(false);
  });
});
