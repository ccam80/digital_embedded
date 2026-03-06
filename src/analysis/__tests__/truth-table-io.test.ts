/**
 * Tests for truth table import/export.
 */

import { describe, it, expect } from 'vitest';
import { TruthTable } from '../truth-table.js';
import type { SignalSpec, TernaryValue } from '../truth-table.js';
import {
  exportCsv,
  importCsv,
  exportHex,
  exportLatex,
  exportTestCase,
  loadTru,
  saveTru,
} from '../truth-table-io.js';

const A: SignalSpec = { name: 'A', bitWidth: 1 };
const B: SignalSpec = { name: 'B', bitWidth: 1 };
const Y: SignalSpec = { name: 'Y', bitWidth: 1 };

function makeAndTable(): TruthTable {
  // 2-input AND gate truth table
  const data: TernaryValue[] = [0n, 0n, 0n, 1n]; // Y = A & B
  return new TruthTable([A, B], [Y], data);
}

describe('TruthTable I/O', () => {
  it('csvRoundTrip — export to CSV, import back, verify identical', () => {
    const original = makeAndTable();
    const csv = exportCsv(original);
    const restored = importCsv(csv);

    expect(restored.inputs).toHaveLength(original.inputs.length);
    expect(restored.outputs).toHaveLength(original.outputs.length);
    expect(restored.rowCount).toBe(original.rowCount);

    for (let r = 0; r < original.rowCount; r++) {
      for (let o = 0; o < original.outputs.length; o++) {
        expect(restored.getOutput(r, o)).toBe(original.getOutput(r, o));
      }
    }
  });

  it('hexExport — 2-input 1-output hex output matches values', () => {
    const table = makeAndTable();
    const hex = exportHex(table);
    const lines = hex.split('\n').filter((l) => !l.startsWith('#'));

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('0'); // AB=00 → 0
    expect(lines[1]).toBe('0'); // AB=01 → 0
    expect(lines[2]).toBe('0'); // AB=10 → 0
    expect(lines[3]).toBe('1'); // AB=11 → 1
  });

  it('latexExport — contains tabular environment and correct columns', () => {
    const table = makeAndTable();
    const latex = exportLatex(table);

    expect(latex).toContain('\\begin{tabular}');
    expect(latex).toContain('\\end{tabular}');
    expect(latex).toContain('A');
    expect(latex).toContain('B');
    expect(latex).toContain('Y');
    // Should have 4 data rows + header
    const dataLines = latex.split('\n').filter((l) => l.includes('\\\\'));
    expect(dataLines).toHaveLength(5); // 1 header + 4 data
  });

  it('testCaseExport — valid Digital test syntax', () => {
    const table = makeAndTable();
    const testCase = exportTestCase(table);
    const lines = testCase.split('\n');

    // First line is header
    expect(lines[0]).toBe('A B Y');
    // Data rows
    expect(lines[1]).toBe('0 0 0');
    expect(lines[2]).toBe('0 1 0');
    expect(lines[3]).toBe('1 0 0');
    expect(lines[4]).toBe('1 1 1');
  });

  it('truRoundTrip — save and load .tru format', () => {
    const original = makeAndTable();
    const tru = saveTru(original);
    const restored = loadTru(tru);

    expect(restored.rowCount).toBe(original.rowCount);
    for (let r = 0; r < original.rowCount; r++) {
      expect(restored.getOutput(r, 0)).toBe(original.getOutput(r, 0));
    }
  });

  it('csvWithDontCare — X values preserved in round-trip', () => {
    const data: TernaryValue[] = [0n, -1n, 1n, -1n];
    const table = new TruthTable([A, B], [Y], data);

    const csv = exportCsv(table);
    expect(csv).toContain('X');

    const restored = importCsv(csv);
    expect(restored.getOutput(1, 0)).toBe(-1n);
    expect(restored.getOutput(3, 0)).toBe(-1n);
  });
});
