/**
 * Tests for expression-editor.ts (Task 8.2.4).
 *
 * Covers:
 *   toTruthTable — parse "A & B", generate truth table, verify 4 rows with correct values
 */

import { describe, expect, it } from 'vitest';
import { ExpressionEditorTab } from '../expression-editor.js';
import { ParseError } from '../expression-parser.js';

// ---------------------------------------------------------------------------
// toTruthTable — parse "A & B", generate truth table, verify 4 rows with correct values
// ---------------------------------------------------------------------------

describe('toTruthTable', () => {
  it('generates 4-row truth table for "A & B"', () => {
    const editor = new ExpressionEditorTab('A & B');
    editor.parse();
    const table = editor.toTruthTable();
    expect(table.rowCount).toBe(4);
  });

  it('"A & B" truth table has correct output values', () => {
    const editor = new ExpressionEditorTab('A & B');
    editor.parse();
    const table = editor.toTruthTable();

    // A=0,B=0 → 0
    expect(table.getOutput(0, 0)).toBe(0n);
    // A=0,B=1 → 0
    expect(table.getOutput(1, 0)).toBe(0n);
    // A=1,B=0 → 0
    expect(table.getOutput(2, 0)).toBe(0n);
    // A=1,B=1 → 1
    expect(table.getOutput(3, 0)).toBe(1n);
  });

  it('"A & B" truth table has 2 inputs named A and B', () => {
    const editor = new ExpressionEditorTab('A & B');
    editor.parse();
    const table = editor.toTruthTable();

    expect(table.inputs).toHaveLength(2);
    expect(table.inputs[0]!.name).toBe('A');
    expect(table.inputs[1]!.name).toBe('B');
  });

  it('"A | B" truth table has correct OR values', () => {
    const editor = new ExpressionEditorTab('A | B');
    editor.parse();
    const table = editor.toTruthTable();

    // A=0,B=0 → 0
    expect(table.getOutput(0, 0)).toBe(0n);
    // A=0,B=1 → 1
    expect(table.getOutput(1, 0)).toBe(1n);
    // A=1,B=0 → 1
    expect(table.getOutput(2, 0)).toBe(1n);
    // A=1,B=1 → 1
    expect(table.getOutput(3, 0)).toBe(1n);
  });

  it('"!A" truth table has 2 rows (1 variable)', () => {
    const editor = new ExpressionEditorTab('!A');
    editor.parse();
    const table = editor.toTruthTable();

    expect(table.rowCount).toBe(2);
    // A=0 → !0 = 1
    expect(table.getOutput(0, 0)).toBe(1n);
    // A=1 → !1 = 0
    expect(table.getOutput(1, 0)).toBe(0n);
  });

  it('output name defaults to Y', () => {
    const editor = new ExpressionEditorTab('A & B');
    editor.parse();
    const table = editor.toTruthTable();
    expect(table.outputs[0]!.name).toBe('Y');
  });

  it('custom output name is used', () => {
    const editor = new ExpressionEditorTab('A & B');
    editor.parse();
    const table = editor.toTruthTable('Z');
    expect(table.outputs[0]!.name).toBe('Z');
  });

  it('throws if expression text is invalid', () => {
    const editor = new ExpressionEditorTab('A & ');
    editor.parse();
    expect(() => editor.toTruthTable()).toThrow();
  });

  it('3-variable expression generates 8-row table', () => {
    const editor = new ExpressionEditorTab('A & B | C');
    editor.parse();
    const table = editor.toTruthTable();
    expect(table.rowCount).toBe(8);
    expect(table.inputs).toHaveLength(3);
  });

  it('"A & B | C" evaluates all rows correctly', () => {
    const editor = new ExpressionEditorTab('A & B | C');
    editor.parse();
    const table = editor.toTruthTable();

    // Variables sorted: A (MSB), B, C (LSB)
    // row = A<<2 | B<<1 | C<<0
    for (let row = 0; row < 8; row++) {
      const a = Boolean((row >> 2) & 1);
      const b = Boolean((row >> 1) & 1);
      const c = Boolean(row & 1);
      const expected = (a && b) || c;
      expect(table.getOutput(row, 0)).toBe(expected ? 1n : 0n);
    }
  });
});

// ---------------------------------------------------------------------------
// parse() and change events
// ---------------------------------------------------------------------------

describe('parse', () => {
  it('returns successful result for valid expression', () => {
    const editor = new ExpressionEditorTab('A & B');
    const result = editor.parse();
    expect(result.expr).not.toBeNull();
    expect(result.error).toBeNull();
    expect(result.errorPosition).toBe(-1);
  });

  it('returns error result for invalid expression', () => {
    const editor = new ExpressionEditorTab('A & ');
    const result = editor.parse();
    expect(result.expr).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.errorPosition).toBeGreaterThanOrEqual(0);
  });

  it('fires change listener on parse', () => {
    const editor = new ExpressionEditorTab('A & B');
    const events: unknown[] = [];
    editor.addChangeListener((r) => events.push(r));
    editor.parse();
    expect(events).toHaveLength(1);
  });

  it('change listener receives parse result', () => {
    const editor = new ExpressionEditorTab('A | B');
    let received: unknown = null;
    editor.addChangeListener((r) => { received = r; });
    editor.parse();
    expect((received as { expr: unknown }).expr).not.toBeNull();
  });

  it('removing listener stops notifications', () => {
    const editor = new ExpressionEditorTab('A');
    let count = 0;
    const listener = () => count++;
    editor.addChangeListener(listener);
    editor.parse();
    expect(count).toBe(1);
    editor.removeChangeListener(listener);
    editor.parse();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectVariables
// ---------------------------------------------------------------------------

describe('detectVariables', () => {
  it('detects variables from "A & B | C"', () => {
    const editor = new ExpressionEditorTab('A & B | C');
    editor.parse();
    const vars = editor.detectVariables();
    expect(vars).toEqual(['A', 'B', 'C']);
  });

  it('variables are sorted alphabetically', () => {
    const editor = new ExpressionEditorTab('C | B & A');
    editor.parse();
    const vars = editor.detectVariables();
    expect(vars).toEqual(['A', 'B', 'C']);
  });

  it('duplicate variables appear once', () => {
    const editor = new ExpressionEditorTab('A & A | A');
    editor.parse();
    const vars = editor.detectVariables();
    expect(vars).toEqual(['A']);
  });

  it('returns empty array for invalid expression', () => {
    const editor = new ExpressionEditorTab('A & ');
    // Don't parse first — detectVariables should try and return []
    const vars = editor.detectVariables();
    expect(vars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// setText / text getter
// ---------------------------------------------------------------------------

describe('setText', () => {
  it('updates text property', () => {
    const editor = new ExpressionEditorTab('A');
    editor.setText('B | C');
    expect(editor.text).toBe('B | C');
  });

  it('subsequent parse uses updated text', () => {
    const editor = new ExpressionEditorTab('A & B');
    editor.parse();
    editor.setText('A | B');
    const result = editor.parse();
    expect(result.expr!.kind).toBe('or');
  });
});
