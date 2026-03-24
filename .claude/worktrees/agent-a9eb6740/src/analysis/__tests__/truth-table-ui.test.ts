/**
 * Tests for TruthTableTab UI.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { TruthTable } from '../truth-table.js';
import { TruthTableTab } from '../truth-table-ui.js';
import type { SignalSpec } from '../truth-table.js';

const A: SignalSpec = { name: 'A', bitWidth: 1 };
const B: SignalSpec = { name: 'B', bitWidth: 1 };
const C: SignalSpec = { name: 'C', bitWidth: 1 };
const Y: SignalSpec = { name: 'Y', bitWidth: 1 };
const Z: SignalSpec = { name: 'Z', bitWidth: 1 };

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('TruthTableTab', () => {
  it('renderGrid — 2 inputs, 1 output renders 4 rows', () => {
    const table = new TruthTable([A, B], [Y]);
    const tab = new TruthTableTab(table);
    const container = makeContainer();

    tab.render(container);

    const rows = tab.getRows();
    expect(rows).toHaveLength(4);

    // Check header columns
    const headers = container.querySelectorAll('th');
    expect(headers).toHaveLength(3); // A, B, Y
    expect(headers[0]!.textContent).toBe('A');
    expect(headers[1]!.textContent).toBe('B');
    expect(headers[2]!.textContent).toBe('Y');
  });

  it('editCell — click output cell, value cycles 0→1→X→0', () => {
    const table = new TruthTable([A], [Y]);
    table.setOutput(0, 0, 0n);

    const tab = new TruthTableTab(table);
    const container = makeContainer();
    tab.render(container);

    const cell = tab.getOutputCell(0, 0)!;
    expect(cell.textContent).toBe('0');

    // Click: 0 → 1
    cell.click();
    expect(cell.textContent).toBe('1');
    expect(table.getOutput(0, 0)).toBe(1n);

    // Click: 1 → X
    cell.click();
    expect(cell.textContent).toBe('X');
    expect(table.getOutput(0, 0)).toBe(-1n);

    // Click: X → 0
    cell.click();
    expect(cell.textContent).toBe('0');
    expect(table.getOutput(0, 0)).toBe(0n);
  });

  it('blankTable — 3 inputs, 2 outputs creates 8 rows with all X', () => {
    const table = TruthTable.blank([A, B, C], [Y, Z]);
    const tab = new TruthTableTab(table);
    const container = makeContainer();

    tab.render(container);

    const rows = tab.getRows();
    expect(rows).toHaveLength(8);

    // All output cells should show X
    const outputCells = container.querySelectorAll('.tt-output-cell');
    expect(outputCells).toHaveLength(16); // 8 rows × 2 outputs
    for (const cell of Array.from(outputCells)) {
      expect(cell.textContent).toBe('X');
    }
  });
});
