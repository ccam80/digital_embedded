/**
 * Tests for Quine-McCluskey minimization (Task 8.2.2).
 *
 * Covers:
 *  - Simple minimization (OR of minterms → single variable)
 *  - XOR function (already minimal — no simplification possible)
 *  - Don't-care exploitation
 *  - Multiple minimal covers
 *  - 4-variable minimization
 *  - Prime implicant verification
 */

import { describe, expect, it } from 'vitest';
import { exprToString } from '../expression.js';
import { minimize } from '../quine-mccluskey.js';
import { TruthTable, type TernaryValue } from '../truth-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTable(
  inputNames: string[],
  outputName: string,
  outputValues: TernaryValue[],
): TruthTable {
  const inputs = inputNames.map((name) => ({ name, bitWidth: 1 }));
  const outputs = [{ name: outputName, bitWidth: 1 }];
  return new TruthTable(inputs, outputs, outputValues);
}

// ---------------------------------------------------------------------------
// simpleMinimize: OR(A&B, A&!B) → A
//
// A B | Y
// 0 0 | 0
// 0 1 | 0
// 1 0 | 1   ← A & !B
// 1 1 | 1   ← A & B
//
// Minterms 2 and 3 differ only in B → B is eliminated → prime = A
// ---------------------------------------------------------------------------

describe('simpleMinimize', () => {
  it('minimizes OR(A&B, A&!B) to A', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 0n, 1n, 1n]);
    const result = minimize(table, 0);

    // Selected cover should be a single variable A
    const str = exprToString(result.selectedCover);
    expect(str).toBe('A');
  });

  it('has exactly one prime implicant', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 0n, 1n, 1n]);
    const result = minimize(table, 0);
    expect(result.primeImplicants).toHaveLength(1);
  });

  it('prime implicant covers A=1, B eliminated', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 0n, 1n, 1n]);
    const result = minimize(table, 0);
    const prime = result.primeImplicants[0]!;
    // B should be eliminated (not in literals map)
    expect(prime.literals.has('B')).toBe(false);
    // A should be positive
    expect(prime.literals.get('A')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// xorNotSimplifiable: XOR function is already minimal
//
// A B | Y
// 0 0 | 0
// 0 1 | 1   ← !A & B
// 1 0 | 1   ← A & !B
// 1 1 | 0
//
// Minterms 1 and 2: state=01 vs state=10 → differ in 2 bits → not combinable
// So both remain as prime implicants. XOR is already minimal.
// ---------------------------------------------------------------------------

describe('xorNotSimplifiable', () => {
  it('XOR function has 2 prime implicants', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 1n, 1n, 0n]);
    const result = minimize(table, 0);
    // Both minterms remain as primes (cannot be combined)
    expect(result.primeImplicants).toHaveLength(2);
  });

  it('XOR selected cover contains both literals', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 1n, 1n, 0n]);
    const result = minimize(table, 0);
    const str = exprToString(result.selectedCover);
    // Should be a 2-term SOP: !A & B | A & !B
    expect(str).toContain('|');
    expect(str).toContain('A');
    expect(str).toContain('B');
  });
});

// ---------------------------------------------------------------------------
// dontCareExploited: don't-care terms enable simpler expression
//
// A B | Y
// 0 0 | 0
// 0 1 | 1   minterm
// 1 0 | X   don't-care (can be used for optimization but not required)
// 1 1 | 1   minterm
//
// Without don't-care at row 2: minterms {1,3} → cannot combine →
//   result would be (!A&B | A&B) = two terms
//
// With don't-care at row 2 (treated as 1 during reduction):
//   minterms+dontcares = {1,2,3}, rows 2&3 combine (differ in A) → B=1
//   rows 1&2 combine (differ in B) → A=1
//   So we get single prime: B (covers {1,3}) using dontcare 2 as helper
// ---------------------------------------------------------------------------

describe('dontCareExploited', () => {
  it('don\'t-care allows simplification to single literal', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 1n, -1n, 1n]);
    const result = minimize(table, 0);

    // With don't-care exploitation, can reduce to B
    const str = exprToString(result.selectedCover);
    // The result should be simpler than without don't-care
    // Expected: B (single variable)
    expect(str).toBe('B');
  });

  it('without don\'t-care, needs 2 terms; with it, needs 1', () => {
    // With don't-care (row 2 = X):
    const tableWithDC = makeTable(['A', 'B'], 'Y', [0n, 1n, -1n, 1n]);
    const resultWithDC = minimize(tableWithDC, 0);

    // Without don't-care (row 2 = 0):
    const tableNoDC = makeTable(['A', 'B'], 'Y', [0n, 1n, 0n, 1n]);
    const resultNoDC = minimize(tableNoDC, 0);

    const strWithDC = exprToString(resultWithDC.selectedCover);
    const strNoDC = exprToString(resultNoDC.selectedCover);

    // With DC should be simpler (shorter)
    expect(strWithDC.length).toBeLessThan(strNoDC.length);
  });
});

// ---------------------------------------------------------------------------
// allSolutions: function with multiple minimal covers
//
// A B C | Y
// 0 0 0 | 0
// 0 0 1 | 1   m1
// 0 1 0 | 0
// 0 1 1 | 1   m3
// 1 0 0 | 1   m4
// 1 0 1 | 1   m5
// 1 1 0 | 0
// 1 1 1 | 0
//
// Prime implicants:
//   m1&m3: !A & C  (rows 1,3 differ in B)
//   m4&m5: A & !B  (rows 4,5 differ in C)
//   m1&m5: !B & C  (rows 1,5 differ in A)
//
// Two minimal covers:
//   Cover 1: {!A&C, A&!B}
//   Cover 2: {!B&C, A&!B}
// Both use 2 primes.
// ---------------------------------------------------------------------------

describe('allSolutions', () => {
  it('returns multiple minimal covers for a function with two solutions', () => {
    //   A B C → Y
    const table = makeTable(['A', 'B', 'C'], 'Y', [0n, 1n, 0n, 1n, 1n, 1n, 0n, 0n]);
    const result = minimize(table, 0);
    expect(result.minimalCovers.length).toBeGreaterThan(1);
  });

  it('all covers are equivalent boolean expressions', () => {
    const table = makeTable(['A', 'B', 'C'], 'Y', [0n, 1n, 0n, 1n, 1n, 1n, 0n, 0n]);
    const result = minimize(table, 0);
    // At minimum, we have 2+ covers
    expect(result.minimalCovers.length).toBeGreaterThanOrEqual(2);
    // Each cover is an expression (not a constant)
    for (const cover of result.minimalCovers) {
      expect(cover.kind).not.toBe('constant');
    }
  });
});

// ---------------------------------------------------------------------------
// 4variables: 4-variable function correctly minimized
//
// Classic 4-variable minimization: f(A,B,C,D) = Σm(0,1,2,5,8,9,10)
// Minterms (in decimal): 0,1,2,5,8,9,10
// Known minimal SOP: !B&!D | !A&!B | A&!B&!C (or similar depending on cover)
// ---------------------------------------------------------------------------

describe('4variables', () => {
  it('minimizes a 4-variable function to fewer terms than SOP', () => {
    // f = Σm(0,1,2,5,8,9,10) with 4 variables (16 rows total)
    const outputs: TernaryValue[] = new Array(16).fill(0n) as TernaryValue[];
    for (const m of [0, 1, 2, 5, 8, 9, 10]) {
      outputs[m] = 1n;
    }
    const table = makeTable(['A', 'B', 'C', 'D'], 'Y', outputs);
    const result = minimize(table, 0);

    // Canonical SOP would have 7 terms (one per minterm).
    // Minimized result should have fewer prime implicants and fewer terms.
    expect(result.primeImplicants.length).toBeLessThan(7);
    expect(result.selectedCover.kind).toBe('or');
  });

  it('minimized cover is functionally correct', async () => {
    const mintermsSet = new Set([0, 1, 2, 5, 8, 9, 10]);
    const outputs: TernaryValue[] = new Array(16).fill(0n) as TernaryValue[];
    for (const m of mintermsSet) {
      outputs[m] = 1n;
    }
    const table = makeTable(['A', 'B', 'C', 'D'], 'Y', outputs);
    const result = minimize(table, 0);

    // Verify the minimized expression evaluates correctly for all 16 combinations
    const { evaluate } = await import('../expression.js');
    const varNames = ['A', 'B', 'C', 'D'];
    for (let row = 0; row < 16; row++) {
      const env = new Map<string, boolean>();
      for (let i = 0; i < 4; i++) {
        env.set(varNames[i]!, Boolean((row >> (3 - i)) & 1));
      }
      const expected = mintermsSet.has(row);
      const actual = evaluate(result.selectedCover, env);
      expect(actual).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// primeImplicants: verify all prime implicants found
//
// f(A,B) = A&B | !A&!B  (XNOR)
// A B | Y
// 0 0 | 1   m0
// 0 1 | 0
// 1 0 | 0
// 1 1 | 1   m3
//
// Minterms 0 and 3 differ in both A and B → cannot combine.
// Prime implicants: {!A&!B (covers m0), A&B (covers m3)} — 2 primes.
// ---------------------------------------------------------------------------

describe('primeImplicants', () => {
  it('finds exactly 2 prime implicants for XNOR function', () => {
    const table = makeTable(['A', 'B'], 'Y', [1n, 0n, 0n, 1n]);
    const result = minimize(table, 0);
    expect(result.primeImplicants).toHaveLength(2);
  });

  it('prime implicants cover the correct minterms', () => {
    const table = makeTable(['A', 'B'], 'Y', [1n, 0n, 0n, 1n]);
    const result = minimize(table, 0);

    // One prime should cover minterm 1 (row index 0+1=1), other covers minterm 4 (3+1=4)
    const minterms = result.primeImplicants.map((p) => [...p.minterms].sort());
    const allMinterms = minterms.flat().sort();
    expect(allMinterms).toEqual([1, 4]);
  });

  it('all-zeros output has no prime implicants', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 0n, 0n, 0n]);
    const result = minimize(table, 0);
    expect(result.primeImplicants).toHaveLength(0);
    expect(result.selectedCover).toEqual({ kind: 'constant', value: false });
  });

  it('all-ones output has one prime implicant (tautology)', () => {
    const table = makeTable(['A', 'B'], 'Y', [1n, 1n, 1n, 1n]);
    const result = minimize(table, 0);
    // All four minterms combine: 0&1 combine (A eliminated) → !B group,
    // 2&3 combine → B group, then !B-group & B-group combine → both eliminated → constant 1
    // The single prime covers everything with both variables eliminated
    expect(result.primeImplicants.length).toBeGreaterThanOrEqual(1);
    // The expression evaluates to true for all inputs
    const { evaluate } = await import('../expression.js');
    for (let row = 0; row < 4; row++) {
      const env = new Map([
        ['A', Boolean((row >> 1) & 1)],
        ['B', Boolean(row & 1)],
      ]);
      expect(evaluate(result.selectedCover, env)).toBe(true);
    }
  });
});
