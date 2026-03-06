/**
 * Tests for TruthTable data model.
 */

import { describe, it, expect, vi } from 'vitest';
import { TruthTable } from '../truth-table.js';
import type { SignalSpec, TernaryValue } from '../truth-table.js';

const A: SignalSpec = { name: 'A', bitWidth: 1 };
const B: SignalSpec = { name: 'B', bitWidth: 1 };
const C: SignalSpec = { name: 'C', bitWidth: 1 };
const Y: SignalSpec = { name: 'Y', bitWidth: 1 };
const Z: SignalSpec = { name: 'Z', bitWidth: 1 };

describe('TruthTable', () => {
  it('setOutput — set output value at row 2, verify stored', () => {
    const table = new TruthTable([A, B], [Y]);

    // 4 rows (2 inputs), all default to X (-1n)
    expect(table.getOutput(2, 0)).toBe(-1n);

    table.setOutput(2, 0, 1n);
    expect(table.getOutput(2, 0)).toBe(1n);

    table.setOutput(2, 0, 0n);
    expect(table.getOutput(2, 0)).toBe(0n);
  });

  it('reorderColumns — swap input A and B, verify row values rearranged', () => {
    // 2 inputs A, B; 1 output Y
    // Row layout: AB=00(r0), AB=01(r1), AB=10(r2), AB=11(r3)
    const table = new TruthTable([A, B], [Y]);

    // Set specific output values
    table.setOutput(0, 0, 0n);  // AB=00 → Y=0
    table.setOutput(1, 0, 1n);  // AB=01 → Y=1
    table.setOutput(2, 0, 0n);  // AB=10 → Y=0
    table.setOutput(3, 0, -1n); // AB=11 → Y=X

    // Swap: new order [1, 0] means new column 0 = old column 1 (B), new column 1 = old column 0 (A)
    table.reorderInputColumns([1, 0]);

    // After swap, inputs are [B, A]
    expect(table.inputs[0]!.name).toBe('B');
    expect(table.inputs[1]!.name).toBe('A');

    // New row layout: BA=00(r0), BA=01(r1), BA=10(r2), BA=11(r3)
    // BA=00 corresponds to old AB=00 → Y=0
    expect(table.getOutput(0, 0)).toBe(0n);
    // BA=01 corresponds to old AB=10 → Y=0
    expect(table.getOutput(1, 0)).toBe(0n);
    // BA=10 corresponds to old AB=01 → Y=1
    expect(table.getOutput(2, 0)).toBe(1n);
    // BA=11 corresponds to old AB=11 → Y=X
    expect(table.getOutput(3, 0)).toBe(-1n);
  });

  it('blank — creates table with all X outputs', () => {
    const table = TruthTable.blank([A, B, C], [Y, Z]);

    expect(table.rowCount).toBe(8); // 2^3
    expect(table.inputs).toHaveLength(3);
    expect(table.outputs).toHaveLength(2);

    for (let r = 0; r < 8; r++) {
      for (let o = 0; o < 2; o++) {
        expect(table.getOutput(r, o)).toBe(-1n);
      }
    }
  });

  it('getInputValues — returns correct values per row', () => {
    const table = new TruthTable([A, B], [Y]);

    expect(table.getInputValues(0)).toEqual([0n, 0n]); // AB=00
    expect(table.getInputValues(1)).toEqual([0n, 1n]); // AB=01
    expect(table.getInputValues(2)).toEqual([1n, 0n]); // AB=10
    expect(table.getInputValues(3)).toEqual([1n, 1n]); // AB=11
  });

  it('change listener fires on setOutput', () => {
    const table = new TruthTable([A], [Y]);
    const listener = vi.fn();
    table.addChangeListener(listener);

    table.setOutput(0, 0, 1n);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same value — no event
    table.setOutput(0, 0, 1n);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('addInput doubles rows', () => {
    const table = new TruthTable([A], [Y]);
    expect(table.rowCount).toBe(2);

    table.addInput(B);
    expect(table.rowCount).toBe(4);
    expect(table.inputs).toHaveLength(2);
  });

  it('removeInput halves rows', () => {
    const table = new TruthTable([A, B], [Y]);
    expect(table.rowCount).toBe(4);

    table.removeInput(1);
    expect(table.rowCount).toBe(2);
    expect(table.inputs).toHaveLength(1);
  });

  it('reorderOutputColumns swaps output columns', () => {
    const table = new TruthTable([A], [Y, Z]);
    table.setOutput(0, 0, 0n); // Y=0 at row 0
    table.setOutput(0, 1, 1n); // Z=1 at row 0

    table.reorderOutputColumns([1, 0]); // swap Y and Z

    expect(table.outputs[0]!.name).toBe('Z');
    expect(table.outputs[1]!.name).toBe('Y');
    expect(table.getOutput(0, 0)).toBe(1n); // was Z=1
    expect(table.getOutput(0, 1)).toBe(0n); // was Y=0
  });
});
