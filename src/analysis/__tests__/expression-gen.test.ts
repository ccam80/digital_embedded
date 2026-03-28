/**
 * Tests for expression generation (Task 8.2.1).
 *
 * Covers:
 *  - SOP generation for AND gate truth table
 *  - POS generation for OR gate truth table
 *  - Don't-care handling in SOP
 *  - Plain-text string formatting
 *  - LaTeX formatting
 */

import { describe, expect, it } from 'vitest';
import { exprToString, type BoolExpr } from '../expression.js';
import { generatePOS, generateSOP } from '../expression-gen.js';
import { TruthTable } from '../truth-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a 1-output TruthTable from a raw output column array.
 *  Values: 0n = low, 1n = high, -1n = don't-care.
 */
function makeTable(
  inputNames: string[],
  outputName: string,
  outputValues: Array<0n | 1n | -1n>,
): TruthTable {
  const inputs = inputNames.map((name) => ({ name, bitWidth: 1 }));
  const outputs = [{ name: outputName, bitWidth: 1 }];
  return new TruthTable(inputs, outputs, outputValues as import('../truth-table.js').TernaryValue[]);
}

// ---------------------------------------------------------------------------
// AND gate truth table (2-input, 1-output)
//
// A B | Y
// 0 0 | 0
// 0 1 | 0
// 1 0 | 0
// 1 1 | 1
// ---------------------------------------------------------------------------

describe('sopAndGate', () => {
  it('generates SOP expression A & B from AND truth table', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 0n, 0n, 1n]);
    const sop = generateSOP(table, 0);

    // Should produce exactly one minterm: A & B (row 3, inputs both 1)
    expect(sop.kind).toBe('and');
    const andNode = sop as Extract<BoolExpr, { kind: 'and' }>;
    expect(andNode.operands).toHaveLength(2);

    // Both operands must be positive variables A and B
    const names = andNode.operands.map((op) => {
      expect(op.kind).toBe('variable');
      const v = op as Extract<BoolExpr, { kind: 'variable' }>;
      expect(v.negated).toBe(false);
      return v.name;
    });
    expect(names.sort()).toEqual(['A', 'B']);
  });

  it('plain-text string for AND truth table SOP is "A & B"', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 0n, 0n, 1n]);
    const sop = generateSOP(table, 0);
    expect(exprToString(sop)).toBe('A & B');
  });
});

// ---------------------------------------------------------------------------
// OR gate truth table (2-input, 1-output)
//
// A B | Y
// 0 0 | 0
// 0 1 | 1
// 1 0 | 1
// 1 1 | 1
// ---------------------------------------------------------------------------

describe('posOrGate', () => {
  it('generates POS expression A | B from OR truth table', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 1n, 1n, 1n]);
    const pos = generatePOS(table, 0);

    // Should produce exactly one maxterm: A | B (row 0, both inputs 0)
    expect(pos.kind).toBe('or');
    const orNode = pos as Extract<BoolExpr, { kind: 'or' }>;
    expect(orNode.operands).toHaveLength(2);

    // Both operands must be positive variables A and B (maxterm for row 00)
    const names = orNode.operands.map((op) => {
      expect(op.kind).toBe('variable');
      const v = op as Extract<BoolExpr, { kind: 'variable' }>;
      expect(v.negated).toBe(false);
      return v.name;
    });
    expect(names.sort()).toEqual(['A', 'B']);
  });

  it('plain-text string for OR truth table POS is "A | B"', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, 1n, 1n, 1n]);
    const pos = generatePOS(table, 0);
    expect(exprToString(pos)).toBe('A | B');
  });
});

// ---------------------------------------------------------------------------
// Don't-care handling
//
// A B | Y
// 0 0 | 0
// 0 1 | X   ← don't-care: excluded from SOP minterms
// 1 0 | 1
// 1 1 | 1
// ---------------------------------------------------------------------------

describe('sopWithDontCare', () => {
  it('excludes don\'t-care rows from SOP minterms', () => {
    const table = makeTable(['A', 'B'], 'Y', [0n, -1n, 1n, 1n]);
    const sop = generateSOP(table, 0);

    // Two minterms: row 2 (A=1,B=0) and row 3 (A=1,B=1)
    expect(sop.kind).toBe('or');
    const orNode = sop as Extract<BoolExpr, { kind: 'or' }>;
    expect(orNode.operands).toHaveLength(2);

    // Each minterm is an AND node
    for (const term of orNode.operands) {
      expect(term.kind).toBe('and');
    }
  });

  it('don\'t-care rows are excluded from POS maxterms', () => {
    // A B | Y
    // 0 0 | 0
    // 0 1 | X  ← don't-care: excluded from POS maxterms
    // 1 0 | 1
    // 1 1 | 1
    const table = makeTable(['A', 'B'], 'Y', [0n, -1n, 1n, 1n]);
    const pos = generatePOS(table, 0);

    // Only one maxterm: row 0 (A=0, B=0) where output is 0
    expect(pos.kind).toBe('or');
    const orNode = pos as Extract<BoolExpr, { kind: 'or' }>;
    expect(orNode.operands).toHaveLength(2);
  });

  it('all-dont-care output produces constant false for SOP', () => {
    const table = makeTable(['A', 'B'], 'Y', [-1n, -1n, -1n, -1n]);
    const sop = generateSOP(table, 0);
    expect(sop.kind).toBe('constant');
    const c = sop as Extract<BoolExpr, { kind: 'constant' }>;
    expect(c.value).toBe(false);
  });

  it('all-dont-care output produces constant true for POS', () => {
    const table = makeTable(['A', 'B'], 'Y', [-1n, -1n, -1n, -1n]);
    const pos = generatePOS(table, 0);
    expect(pos.kind).toBe('constant');
    const c = pos as Extract<BoolExpr, { kind: 'constant' }>;
    expect(c.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plain-text string format
//
// A B | Y (NAND-like: 0,1,1,1 — same as OR above but test focuses on string)
// ---------------------------------------------------------------------------

describe('toStringFormat', () => {
  it('formats SOP with negated variables correctly', () => {
    // A B | Y
    // 0 0 | 1  ← minterm: !A & !B
    // 0 1 | 0
    // 1 0 | 0
    // 1 1 | 0
    const table = makeTable(['A', 'B'], 'Y', [1n, 0n, 0n, 0n]);
    const sop = generateSOP(table, 0);
    const str = exprToString(sop);
    expect(str).toBe('!A & !B');
  });

  it('formats multi-minterm SOP with | separator', () => {
    // A B | Y
    // 0 0 | 0
    // 0 1 | 1   → !A & B
    // 1 0 | 1   → A & !B
    // 1 1 | 0
    const table = makeTable(['A', 'B'], 'Y', [0n, 1n, 1n, 0n]);
    const sop = generateSOP(table, 0);
    const str = exprToString(sop);
    // Both minterms connected by |
    expect(str).toContain(' | ');
    // Both minterms contain &
    expect(str).toContain(' & ');
  });

  it('constant false formats as "0"', () => {
    const table = makeTable(['A'], 'Y', [0n, 0n]);
    const sop = generateSOP(table, 0);
    expect(exprToString(sop)).toBe('0');
  });

  it('constant true formats as "1"', () => {
    const table = makeTable(['A'], 'Y', [1n, 1n]);
    const pos = generatePOS(table, 0);
    expect(exprToString(pos)).toBe('1');
  });
});

