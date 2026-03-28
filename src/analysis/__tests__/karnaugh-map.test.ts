/**
 * Tests for Karnaugh Map visualization (Task 8.2.3).
 *
 * Covers:
 *   render2var    — 2-variable → 2×2 grid
 *   render4var    — 4-variable → 4×4 grid with correct Gray code labels
 *   cellClick     — click cell, verify value toggles and change event emitted
 *   implicantLoops — provide prime implicants, verify colored loops drawn around correct cells
 *   5varSplit     — 5 variables → two 4×4 maps side by side
 *   grayCodeOrder — verify row/column labels follow Gray code sequence
 */

import { describe, expect, it } from 'vitest';
import {
  KarnaughMap,
  KarnaughMapTab,
  grayCodeSequence,
  cycleValue,
  type KMapRenderContext,
} from '../karnaugh-map.js';
import { TruthTable, type TernaryValue } from '../truth-table.js';
import type { Implicant } from '../quine-mccluskey.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTable(numInputBits: number, outputValues?: TernaryValue[]): TruthTable {
  // Create single-bit inputs named A, B, C, D, E, F
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const inputs = Array.from({ length: numInputBits }, (_, i) => ({
    name: names[i]!,
    bitWidth: 1,
  }));
  const outputs = [{ name: 'Y', bitWidth: 1 }];
  const rows = 1 << numInputBits;
  const data: TernaryValue[] = outputValues ?? (new Array(rows).fill(0n) as TernaryValue[]);
  return new TruthTable(inputs, outputs, data);
}

/** Minimal mock render context that records all draw calls. */
class MockKMapRenderer implements KMapRenderContext {
  readonly rects: { x: number; y: number; width: number; height: number }[] = [];
  readonly texts: { text: string; x: number; y: number }[] = [];
  readonly loops: { x: number; y: number; width: number; height: number; colorIndex: number }[] =
    [];

  drawRect(x: number, y: number, width: number, height: number): void {
    this.rects.push({ x, y, width, height });
  }

  drawText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y });
  }

  drawLoop(x: number, y: number, width: number, height: number, colorIndex: number): void {
    this.loops.push({ x, y, width, height, colorIndex });
  }
}

// ---------------------------------------------------------------------------
// grayCodeSequence unit tests (used by render2var / render4var / grayCodeOrder)
// ---------------------------------------------------------------------------

describe('grayCodeSequence', () => {
  it('length-2 sequence is [0, 1]', () => {
    expect(grayCodeSequence(2)).toEqual([0, 1]);
  });

  it('length-4 sequence is [0, 1, 3, 2]', () => {
    expect(grayCodeSequence(4)).toEqual([0, 1, 3, 2]);
  });

  it('adjacent entries differ in exactly one bit for length 4', () => {
    const seq = grayCodeSequence(4);
    for (let i = 0; i < seq.length - 1; i++) {
      const diff = seq[i]! ^ seq[i + 1]!;
      // popcount of diff must be 1
      expect(diff & (diff - 1)).toBe(0);
      expect(diff).toBeGreaterThan(0);
    }
  });
});

describe('cycleValue', () => {
  it('cycles 0 → 1 → X → 0', () => {
    expect(cycleValue(0n)).toBe(1n);
    expect(cycleValue(1n)).toBe(-1n);
    expect(cycleValue(-1n)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// render2var — 2-variable → 2×2 grid
// ---------------------------------------------------------------------------

describe('render2var', () => {
  it('KarnaughMap has 2×2 grid for 2 variables', () => {
    const kmap = new KarnaughMap(2);
    expect(kmap.layout.rows).toBe(2);
    expect(kmap.layout.cols).toBe(2);
  });

  it('produces exactly 4 cells for 2 variables', () => {
    const kmap = new KarnaughMap(2);
    expect(kmap.cells).toHaveLength(4);
  });

  it('cells cover all 4 truth-table rows', () => {
    const kmap = new KarnaughMap(2);
    const rows = kmap.cells.map((c) => c.truthTableRow).sort((a, b) => a - b);
    expect(rows).toEqual([0, 1, 2, 3]);
  });

  it('renders 4 cell rectangles for 2-variable table', () => {
    const table = makeTable(2);
    const tab = new KarnaughMapTab(table);
    const ctx = new MockKMapRenderer();
    tab.render(ctx);
    // 4 cells → 4 rects
    expect(ctx.rects).toHaveLength(4);
  });

  it('single sub-map for 2 variables', () => {
    const kmap = new KarnaughMap(2);
    expect(kmap.subMapCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// render4var — 4-variable → 4×4 grid with correct Gray code labels
// ---------------------------------------------------------------------------

describe('render4var', () => {
  it('KarnaughMap has 4×4 grid for 4 variables', () => {
    const kmap = new KarnaughMap(4);
    expect(kmap.layout.rows).toBe(4);
    expect(kmap.layout.cols).toBe(4);
  });

  it('produces exactly 16 cells for 4 variables', () => {
    const kmap = new KarnaughMap(4);
    expect(kmap.cells).toHaveLength(16);
  });

  it('cells cover all 16 truth-table rows', () => {
    const kmap = new KarnaughMap(4);
    const rows = kmap.cells.map((c) => c.truthTableRow).sort((a, b) => a - b);
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('renders 16 cell rectangles for 4-variable table', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);
    const ctx = new MockKMapRenderer();
    tab.render(ctx);
    expect(ctx.rects).toHaveLength(16);
  });

  it('renders correct Gray code column labels for 4 variables', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);
    const ctx = new MockKMapRenderer();
    tab.render(ctx);

    // Column labels are 2-bit Gray codes: 00, 01, 11, 10
    const expectedColLabels = ['00', '01', '11', '10'];
    // Texts include cell values AND labels; find the label texts
    const labelTexts = ctx.texts.filter((t) => /^[01]{2}$/.test(t.text)).map((t) => t.text);
    // There should be 4 column labels (Gray code patterns)
    for (const label of expectedColLabels) {
      expect(labelTexts).toContain(label);
    }
  });

  it('renders correct Gray code row labels for 4 variables', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);
    const ctx = new MockKMapRenderer();
    tab.render(ctx);

    // Row labels are also 2-bit Gray codes for 4-var: 00, 01, 11, 10
    const expectedRowLabels = ['00', '01', '11', '10'];
    const labelTexts = ctx.texts.filter((t) => /^[01]{2}$/.test(t.text)).map((t) => t.text);
    for (const label of expectedRowLabels) {
      expect(labelTexts).toContain(label);
    }
  });
});

// ---------------------------------------------------------------------------
// cellClick — click cell, verify value toggles and change event emitted
// ---------------------------------------------------------------------------

describe('cellClick', () => {
  it('toggles cell value from 0 to 1 on first click', () => {
    const table = makeTable(2, [0n, 0n, 0n, 0n]);
    const tab = new KarnaughMapTab(table);

    tab.handleCellClick(0, 0, 0);
    // Cell (0,0) maps to some truth-table row; its value should now be 1
    const cell = tab.kmap.getCell(0, 0, 0);
    expect(table.getOutput(cell.truthTableRow, 0)).toBe(1n);
  });

  it('cycles from 0 → 1 → X → 0 on repeated clicks', () => {
    const table = makeTable(2, [0n, 0n, 0n, 0n]);
    const tab = new KarnaughMapTab(table);
    const cell = tab.kmap.getCell(0, 0, 0);

    tab.handleCellClick(0, 0, 0); // 0 → 1
    expect(table.getOutput(cell.truthTableRow, 0)).toBe(1n);

    tab.handleCellClick(0, 0, 0); // 1 → X
    expect(table.getOutput(cell.truthTableRow, 0)).toBe(-1n);

    tab.handleCellClick(0, 0, 0); // X → 0
    expect(table.getOutput(cell.truthTableRow, 0)).toBe(0n);
  });

  it('emits change event with row index and new value', () => {
    const table = makeTable(2, [0n, 0n, 0n, 0n]);
    const tab = new KarnaughMapTab(table);

    const events: { row: number; value: TernaryValue }[] = [];
    tab.addChangeListener((row, value) => events.push({ row, value }));

    tab.handleCellClick(0, 0, 0);

    expect(events).toHaveLength(1);
    expect(events[0]!.value).toBe(1n);
    // row must be a valid truth-table row index
    expect(events[0]!.row).toBeGreaterThanOrEqual(0);
    expect(events[0]!.row).toBeLessThan(4);
  });

  it('emits correct truth-table row for cell (0,0,0)', () => {
    const table = makeTable(2, [0n, 0n, 0n, 0n]);
    const tab = new KarnaughMapTab(table);
    const cell = tab.kmap.getCell(0, 0, 0);

    const events: { row: number; value: TernaryValue }[] = [];
    tab.addChangeListener((row, value) => events.push({ row, value }));

    tab.handleCellClick(0, 0, 0);

    expect(events[0]!.row).toBe(cell.truthTableRow);
  });

  it('getCellValue returns current truth-table value', () => {
    const table = makeTable(2, [0n, 1n, 0n, 0n]);
    const tab = new KarnaughMapTab(table);

    // Find which cell maps to truth-table row 1
    const cell1 = tab.kmap.getCellForRow(1);
    expect(cell1).toBeDefined();
    const val = tab.getCellValue(cell1!.mapIndex, cell1!.row, cell1!.col);
    expect(val).toBe(1n);
  });

  it('removing change listener stops notifications', () => {
    const table = makeTable(2, [0n, 0n, 0n, 0n]);
    const tab = new KarnaughMapTab(table);

    let callCount = 0;
    const listener = () => callCount++;
    tab.addChangeListener(listener);
    tab.handleCellClick(0, 0, 0);
    expect(callCount).toBe(1);

    tab.removeChangeListener(listener);
    tab.handleCellClick(0, 0, 1);
    expect(callCount).toBe(1); // no additional calls
  });
});

// ---------------------------------------------------------------------------
// implicantLoops — provide prime implicants, verify colored loops drawn
// ---------------------------------------------------------------------------

describe('implicantLoops', () => {
  it('setImplicants stores loops accessible via loops getter', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);

    // Create a simple implicant covering minterms at rows 0 and 1
    const imp: Implicant = {
      literals: new Map([['A', false], ['B', false], ['C', false]]),
      minterms: new Set([1, 2]), // truth-table row + 1
    };
    tab.setImplicants([imp]);
    expect(tab.loops).toHaveLength(1);
  });

  it('loop colorIndex cycles through 0-7', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);

    const implicants: Implicant[] = Array.from({ length: 10 }, (_, i) => ({
      literals: new Map<string, boolean>(),
      minterms: new Set([i + 1]),
    }));
    tab.setImplicants(implicants);

    const colorIndices = tab.loops.map((l) => l.colorIndex);
    expect(colorIndices[0]).toBe(0);
    expect(colorIndices[7]).toBe(7);
    expect(colorIndices[8]).toBe(0); // wraps
    expect(colorIndices[9]).toBe(1);
  });

  it('renders loop rectangles when implicants are set', () => {
    const table = makeTable(2);
    const tab = new KarnaughMapTab(table);

    // Implicant covering truth-table rows 0 and 1
    // truthTableRow + 1 = minterm index in the implicant convention
    const kmap = tab.kmap;
    const cell00 = kmap.getCell(0, 0, 0);
    const cell01 = kmap.getCell(0, 0, 1);
    const imp: Implicant = {
      literals: new Map([['A', false]]),
      minterms: new Set([cell00.truthTableRow + 1, cell01.truthTableRow + 1]),
    };

    tab.setImplicants([imp]);

    const ctx = new MockKMapRenderer();
    tab.render(ctx);

    expect(ctx.loops).toHaveLength(1);
    expect(ctx.loops[0]!.colorIndex).toBe(0);
  });

  it('loop with no cells in sub-map is not rendered for that sub-map', () => {
    const table = makeTable(2);
    const tab = new KarnaughMapTab(table);

    // Empty implicant (no minterms)
    const imp: Implicant = {
      literals: new Map(),
      minterms: new Set(),
    };
    tab.setImplicants([imp]);

    const ctx = new MockKMapRenderer();
    tab.render(ctx);
    // No cells → no loop rectangle rendered
    expect(ctx.loops).toHaveLength(0);
  });

  it('multiple implicants produce multiple loops', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);

    const imp1: Implicant = {
      literals: new Map([['A', false]]),
      minterms: new Set([1, 2]),
    };
    const imp2: Implicant = {
      literals: new Map([['B', true]]),
      minterms: new Set([3, 4]),
    };
    tab.setImplicants([imp1, imp2]);

    // Both loops should be stored
    expect(tab.loops).toHaveLength(2);
    expect(tab.loops[0]!.colorIndex).toBe(0);
    expect(tab.loops[1]!.colorIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5varSplit — 5 variables → two 4×4 maps side by side
// ---------------------------------------------------------------------------

describe('5varSplit', () => {
  it('KarnaughMap has 2 sub-maps for 5 variables', () => {
    const kmap = new KarnaughMap(5);
    expect(kmap.subMapCount).toBe(2);
  });

  it('each sub-map has 4×4 grid for 5 variables', () => {
    const kmap = new KarnaughMap(5);
    expect(kmap.layout.rows).toBe(4);
    expect(kmap.layout.cols).toBe(4);
  });

  it('produces 32 cells total for 5 variables', () => {
    const kmap = new KarnaughMap(5);
    expect(kmap.cells).toHaveLength(32);
  });

  it('cells cover all 32 truth-table rows for 5 variables', () => {
    const kmap = new KarnaughMap(5);
    const rows = kmap.cells.map((c) => c.truthTableRow).sort((a, b) => a - b);
    expect(rows).toHaveLength(32);
    for (let i = 0; i < 32; i++) {
      expect(rows[i]).toBe(i);
    }
  });

  it('renders 32 cell rectangles for 5-variable table', () => {
    const table = makeTable(5);
    const tab = new KarnaughMapTab(table);
    const ctx = new MockKMapRenderer();
    tab.render(ctx);
    expect(ctx.rects).toHaveLength(32);
  });

  it('sub-map 0 and sub-map 1 have 16 cells each', () => {
    const kmap = new KarnaughMap(5);
    const map0 = kmap.cells.filter((c) => c.mapIndex === 0);
    const map1 = kmap.cells.filter((c) => c.mapIndex === 1);
    expect(map0).toHaveLength(16);
    expect(map1).toHaveLength(16);
  });

  it('sub-map cells have distinct truth-table rows', () => {
    const kmap = new KarnaughMap(5);
    const map0Rows = new Set(kmap.cells.filter((c) => c.mapIndex === 0).map((c) => c.truthTableRow));
    const map1Rows = new Set(kmap.cells.filter((c) => c.mapIndex === 1).map((c) => c.truthTableRow));
    // No overlap
    for (const r of map0Rows) {
      expect(map1Rows.has(r)).toBe(false);
    }
  });

  it('KarnaughMapTab constructor accepts 5-variable table', () => {
    const table = makeTable(5);
    expect(() => new KarnaughMapTab(table)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// grayCodeOrder — verify row/column labels follow Gray code sequence
// ---------------------------------------------------------------------------

describe('grayCodeOrder', () => {
  it('adjacent row Gray codes differ in exactly one bit for 4-var map', () => {
    const kmap = new KarnaughMap(4);
    const seq = grayCodeSequence(kmap.layout.rows);
    for (let i = 0; i < seq.length - 1; i++) {
      const diff = seq[i]! ^ seq[i + 1]!;
      expect(diff & (diff - 1)).toBe(0);
      expect(diff).toBeGreaterThan(0);
    }
  });

  it('adjacent column Gray codes differ in exactly one bit for 4-var map', () => {
    const kmap = new KarnaughMap(4);
    const seq = grayCodeSequence(kmap.layout.cols);
    for (let i = 0; i < seq.length - 1; i++) {
      const diff = seq[i]! ^ seq[i + 1]!;
      expect(diff & (diff - 1)).toBe(0);
      expect(diff).toBeGreaterThan(0);
    }
  });

  it('all 4 row Gray codes are unique for 4-var map', () => {
    const seq = grayCodeSequence(4);
    expect(new Set(seq).size).toBe(4);
  });

  it('Gray code labels rendered by KarnaughMapTab match grayCodeSequence', () => {
    const table = makeTable(4);
    const tab = new KarnaughMapTab(table);
    const ctx = new MockKMapRenderer();
    tab.render(ctx);

    const colVarCount = tab.kmap.layout.colVarCount;
    const rowVarCount = tab.kmap.layout.rowVarCount;

    // Extract column labels (2-bit binary strings matching colVarCount bits)
    const colPattern = new RegExp(`^[01]{${colVarCount}}$`);
    const rowPattern = new RegExp(`^[01]{${rowVarCount}}$`);

    const colLabels = ctx.texts.filter((t) => colPattern.test(t.text)).map((t) => t.text);
    const rowLabels = ctx.texts.filter((t) => rowPattern.test(t.text)).map((t) => t.text);

    // Expected sequences
    const expectedColSeq = grayCodeSequence(tab.cols).map((v) =>
      v.toString(2).padStart(colVarCount, '0'),
    );
    const expectedRowSeq = grayCodeSequence(tab.rows).map((v) =>
      v.toString(2).padStart(rowVarCount, '0'),
    );

    for (const label of expectedColSeq) {
      expect(colLabels).toContain(label);
    }
    for (const label of expectedRowSeq) {
      expect(rowLabels).toContain(label);
    }
  });

  it('3-variable K-map has 2 rows and 4 columns', () => {
    const kmap = new KarnaughMap(3);
    expect(kmap.layout.rows).toBe(2);
    expect(kmap.layout.cols).toBe(4);
  });

  it('3-variable K-map produces 8 cells covering all truth-table rows', () => {
    const kmap = new KarnaughMap(3);
    expect(kmap.cells).toHaveLength(8);
    const rows = kmap.cells.map((c) => c.truthTableRow).sort((a, b) => a - b);
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

// ---------------------------------------------------------------------------
// Additional correctness tests
// ---------------------------------------------------------------------------

describe('KarnaughMap correctness', () => {
  it('throws for < 2 variables', () => {
    expect(() => new KarnaughMap(1)).toThrow(RangeError);
  });

  it('throws for > 6 variables', () => {
    expect(() => new KarnaughMap(7)).toThrow(RangeError);
  });

  it('KarnaughMapTab throws for 1-variable table', () => {
    const table = new TruthTable(
      [{ name: 'A', bitWidth: 1 }],
      [{ name: 'Y', bitWidth: 1 }],
      [0n, 1n],
    );
    expect(() => new KarnaughMapTab(table)).toThrow(RangeError);
  });

  it('2-var: top-left cell maps to truth-table row 0', () => {
    // For 2 variables A (MSB) and B (LSB):
    // The cell at row=0, col=0 should correspond to A=0, B=0 → truth-table row 0
    const kmap = new KarnaughMap(2);
    // Row Gray[0]=0, Col Gray[0]=0 → A=0, B=0 → row 0
    const cell = kmap.getCell(0, 0, 0);
    expect(cell.truthTableRow).toBe(0);
  });

  it('4-var: all cells have unique truth-table rows', () => {
    const kmap = new KarnaughMap(4);
    const rows = kmap.cells.map((c) => c.truthTableRow);
    expect(new Set(rows).size).toBe(16);
  });

  it('getCellForRow returns correct cell', () => {
    const kmap = new KarnaughMap(2);
    for (let r = 0; r < 4; r++) {
      const cell = kmap.getCellForRow(r);
      expect(cell).toBeDefined();
      expect(cell!.truthTableRow).toBe(r);
    }
  });

  it('6-variable map has 4 sub-maps and 64 cells', () => {
    const kmap = new KarnaughMap(6);
    expect(kmap.subMapCount).toBe(4);
    expect(kmap.cells).toHaveLength(64);
    const rows = kmap.cells.map((c) => c.truthTableRow).sort((a, b) => a - b);
    for (let i = 0; i < 64; i++) {
      expect(rows[i]).toBe(i);
    }
  });
});
