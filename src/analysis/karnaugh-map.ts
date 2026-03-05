/**
 * Karnaugh Map visualization and interaction for the analysis dialog.
 *
 * Supports 2 to 6 variables. For 5-6 variables two side-by-side 4×4 maps
 * are used (the extra variable selects which sub-map is active).
 *
 * The K-map uses Gray code ordering for rows and columns so that adjacent
 * cells differ in exactly one variable — the fundamental property that makes
 * prime implicant groupings visible as rectangles.
 *
 * Architecture:
 *   KarnaughMap      — pure data model: grid layout, cell ↔ truth-table-row
 *                      mapping, implicant loop geometry
 *   KarnaughMapTab   — UI controller: owns a KarnaughMap, handles click
 *                      events, emits change events, drives rendering
 */

import type { TruthTable, TernaryValue } from './truth-table.js';
import type { Implicant } from './quine-mccluskey.js';

// ---------------------------------------------------------------------------
// Gray code helpers
// ---------------------------------------------------------------------------

/**
 * Gray code sequence of length n (must be a power of 2).
 * Returns indices in Gray code order.
 *
 * 2-entry: [0, 1]  (1 bit)
 * 4-entry: [0, 1, 3, 2]  (2 bits: 00, 01, 11, 10)
 */
export function grayCodeSequence(n: number): number[] {
  const seq: number[] = [];
  for (let i = 0; i < n; i++) {
    seq.push(i ^ (i >> 1));
  }
  return seq;
}

/**
 * Return the position (0-based index) of a Gray code value in a sequence of
 * length n.  E.g. for n=4, value 3 (binary 11) is at index 2.
 */
export function grayCodeIndex(value: number, n: number): number {
  const seq = grayCodeSequence(n);
  const idx = seq.indexOf(value);
  if (idx === -1) throw new Error(`grayCodeIndex: value ${value} not found in sequence of ${n}`);
  return idx;
}

// ---------------------------------------------------------------------------
// Grid layout constants
// ---------------------------------------------------------------------------

/**
 * Layout parameters for a single K-map grid.
 * Row/column counts are always powers of two; their product = 2^numVars (per sub-map).
 */
export interface KMapLayout {
  /** Number of variables assigned to rows. */
  rowVarCount: number;
  /** Number of variables assigned to columns. */
  colVarCount: number;
  /** Number of rows in the grid (2^rowVarCount). */
  rows: number;
  /** Number of columns in the grid (2^colVarCount). */
  cols: number;
  /**
   * Variable indices assigned to the row axis, MSB first.
   * E.g. for 4 vars with 2 row vars: [0, 1] → row encodes vars 0 and 1.
   */
  rowVars: number[];
  /** Variable indices assigned to the column axis, MSB first. */
  colVars: number[];
}

/**
 * Compute the layout for a K-map with the given total variable count.
 * For a single map (numVars ≤ 4) the layout covers all variables.
 * For 5-6 variables the layout covers 4 variables (the remaining 1-2 select the sub-map).
 */
function computeLayout(numVars: number): KMapLayout {
  // Variables used in a single 4×4 (or smaller) sub-map
  const mapVars = Math.min(numVars, 4);
  const rowVarCount = Math.floor(mapVars / 2);
  const colVarCount = mapVars - rowVarCount;
  const rows = 1 << rowVarCount;
  const cols = 1 << colVarCount;

  // Assign variables: row vars are the higher-order ones, col vars the lower
  const rowVars = Array.from({ length: rowVarCount }, (_, i) => i);
  const colVars = Array.from({ length: colVarCount }, (_, i) => rowVarCount + i);

  return { rowVarCount, colVarCount, rows, cols, rowVars, colVars };
}

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------

/**
 * One cell in the K-map grid.
 * Carries its grid position and the truth-table row index it corresponds to.
 */
export interface KMapCell {
  /** Sub-map index (0 for primary, 1 for secondary in 5-6 var maps). */
  mapIndex: number;
  /** Row in the sub-map grid (0-based). */
  row: number;
  /** Column in the sub-map grid (0-based). */
  col: number;
  /** Row index in the truth table. */
  truthTableRow: number;
}

// ---------------------------------------------------------------------------
// Implicant loop
// ---------------------------------------------------------------------------

/**
 * Visual representation of a prime implicant as a rectangle (or pair of
 * rectangles for wrap-around groups) over the K-map grid.
 */
export interface ImplicantLoop {
  /** The original implicant. */
  implicant: Implicant;
  /** Color index (0–7) for visual differentiation. */
  colorIndex: number;
  /** The cells covered by this implicant. */
  cells: KMapCell[];
}

// ---------------------------------------------------------------------------
// KarnaughMap — pure data model
// ---------------------------------------------------------------------------

/**
 * Pure data model for a Karnaugh map.
 *
 * Computes the mapping between grid positions and truth-table rows, and
 * converts prime implicants into loop geometry.
 */
export class KarnaughMap {
  private readonly _numVars: number;
  private readonly _layout: KMapLayout;
  /** Number of sub-maps (1 for ≤4 vars, 2+ for 5-6 vars). */
  private readonly _subMapCount: number;
  /** Variables that select the sub-map (for 5-6 var maps). */
  private readonly _subMapVars: number[];
  private readonly _cells: KMapCell[];

  constructor(numVars: number) {
    if (numVars < 2 || numVars > 6) {
      throw new RangeError(`KarnaughMap: numVars must be 2-6, got ${numVars}`);
    }
    this._numVars = numVars;
    this._layout = computeLayout(numVars);
    this._subMapVars = Array.from({ length: numVars - Math.min(numVars, 4) }, (_, i) => 4 + i);
    this._subMapCount = 1 << this._subMapVars.length;
    this._cells = this._buildCells();
  }

  get numVars(): number {
    return this._numVars;
  }

  get layout(): KMapLayout {
    return this._layout;
  }

  get subMapCount(): number {
    return this._subMapCount;
  }

  get cells(): readonly KMapCell[] {
    return this._cells;
  }

  /**
   * Get the cell for a given sub-map index, row, and column.
   */
  getCell(mapIndex: number, row: number, col: number): KMapCell {
    const cell = this._cells.find(
      (c) => c.mapIndex === mapIndex && c.row === row && c.col === col,
    );
    if (!cell) {
      throw new Error(`KarnaughMap.getCell: no cell at map=${mapIndex} row=${row} col=${col}`);
    }
    return cell;
  }

  /**
   * Get the cell for a given truth-table row index.
   */
  getCellForRow(truthTableRow: number): KMapCell | undefined {
    return this._cells.find((c) => c.truthTableRow === truthTableRow);
  }

  /**
   * Compute implicant loops from a list of prime implicants.
   * Each prime implicant is mapped to the set of cells it covers.
   */
  computeLoops(implicants: readonly Implicant[]): ImplicantLoop[] {
    return implicants.map((imp, idx) => {
      const cells = this._cellsForImplicant(imp);
      return {
        implicant: imp,
        colorIndex: idx % 8,
        cells,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _buildCells(): KMapCell[] {
    const { rows, cols, rowVars, colVars } = this._layout;
    const rowGray = grayCodeSequence(rows);
    const colGray = grayCodeSequence(cols);
    const subMapGray = grayCodeSequence(this._subMapCount);

    const cells: KMapCell[] = [];

    for (let si = 0; si < this._subMapCount; si++) {
      const subMapGrayVal = subMapGray[si]!;

      for (let r = 0; r < rows; r++) {
        const rowGrayVal = rowGray[r]!;

        for (let c = 0; c < cols; c++) {
          const colGrayVal = colGray[c]!;

          // Compute the truth-table row by assembling bits from all variable axes.
          // Variables are ordered MSB-first in the truth table:
          //   var 0 occupies bit (numVars-1), var 1 occupies bit (numVars-2), etc.
          const truthTableRow = this._assembleTruthTableRow(
            rowGrayVal,
            colGrayVal,
            subMapGrayVal,
            rowVars,
            colVars,
          );

          cells.push({ mapIndex: si, row: r, col: c, truthTableRow });
        }
      }
    }

    return cells;
  }

  /**
   * Assemble a truth-table row index from the Gray code values on each axis.
   *
   * Variables are mapped to bit positions in the truth-table row such that
   * var[i] controls bit (numVars - 1 - i).
   */
  private _assembleTruthTableRow(
    rowGrayVal: number,
    colGrayVal: number,
    subMapGrayVal: number,
    rowVars: number[],
    colVars: number[],
  ): number {
    let row = 0;
    const n = this._numVars;

    // Row axis variables: MSB of rowGrayVal → highest-index rowVar
    for (let i = 0; i < rowVars.length; i++) {
      const varIdx = rowVars[i]!;
      // Bit within rowGrayVal: MSB of rowVars is the highest bit
      const bitPos = rowVars.length - 1 - i;
      const bitVal = (rowGrayVal >> bitPos) & 1;
      // Place in truth-table row at position (n - 1 - varIdx)
      row |= bitVal << (n - 1 - varIdx);
    }

    // Column axis variables
    for (let i = 0; i < colVars.length; i++) {
      const varIdx = colVars[i]!;
      const bitPos = colVars.length - 1 - i;
      const bitVal = (colGrayVal >> bitPos) & 1;
      row |= bitVal << (n - 1 - varIdx);
    }

    // Sub-map axis variables (for 5-6 vars)
    for (let i = 0; i < this._subMapVars.length; i++) {
      const varIdx = this._subMapVars[i]!;
      const bitPos = this._subMapVars.length - 1 - i;
      const bitVal = (subMapGrayVal >> bitPos) & 1;
      row |= bitVal << (n - 1 - varIdx);
    }

    return row;
  }

  private _cellsForImplicant(imp: Implicant): KMapCell[] {
    // An implicant covers the cells whose truth-table rows are in imp.minterms
    return this._cells.filter((c) => imp.minterms.has(c.truthTableRow + 1));
  }
}

// ---------------------------------------------------------------------------
// KarnaughMapTab — UI controller
// ---------------------------------------------------------------------------

export type KMapChangeListener = (row: number, value: TernaryValue) => void;

/**
 * UI controller for the Karnaugh map tab in the analysis dialog.
 *
 * Owns a KarnaughMap data model, holds a reference to the TruthTable (source
 * of truth), handles click events, and emits change events to keep other
 * tabs synchronized.
 *
 * Rendering is performed by calling render() with any RenderContext-compatible
 * object; in production that will be a Canvas2D adapter; in tests a
 * MockRenderContext records the draw calls.
 */
export class KarnaughMapTab {
  private readonly _kmap: KarnaughMap;
  private readonly _table: TruthTable;
  private readonly _listeners = new Set<KMapChangeListener>();
  private _loops: ImplicantLoop[] = [];

  constructor(table: TruthTable) {
    const numVars = table.totalInputBits;
    if (numVars < 2 || numVars > 6) {
      throw new RangeError(
        `KarnaughMapTab: truth table must have 2-6 input bits, got ${numVars}`,
      );
    }
    this._table = table;
    this._kmap = new KarnaughMap(numVars);
  }

  /** The underlying data model. */
  get kmap(): KarnaughMap {
    return this._kmap;
  }

  /** Number of sub-maps (1 for 2-4 variables, 2 for 5 variables, 4 for 6 variables). */
  get subMapCount(): number {
    return this._kmap.subMapCount;
  }

  /** Number of rows per sub-map. */
  get rows(): number {
    return this._kmap.layout.rows;
  }

  /** Number of columns per sub-map. */
  get cols(): number {
    return this._kmap.layout.cols;
  }

  /** Current implicant loops. */
  get loops(): readonly ImplicantLoop[] {
    return this._loops;
  }

  /**
   * Update the displayed prime implicant loops.
   * Called when the user selects a different minimal cover.
   */
  setImplicants(implicants: readonly Implicant[]): void {
    this._loops = this._kmap.computeLoops(implicants);
  }

  /**
   * Handle a click at a given grid position.
   *
   * Cycles the cell's output value through 0 → 1 → X → 0 for the first
   * output column (index 0). Fires change listeners with the truth-table
   * row index and new value.
   *
   * @param mapIndex  Sub-map index (0 for 2-4 var maps).
   * @param row       Grid row within the sub-map.
   * @param col       Grid column within the sub-map.
   * @param outputIndex  Which output column to cycle (default 0).
   */
  handleCellClick(mapIndex: number, row: number, col: number, outputIndex = 0): void {
    const cell = this._kmap.getCell(mapIndex, row, col);
    const current = this._table.getOutput(cell.truthTableRow, outputIndex);
    const next = cycleValue(current);
    this._table.setOutput(cell.truthTableRow, outputIndex, next);
    this._emit(cell.truthTableRow, next);
  }

  /**
   * Get the display value for a cell (reads from the truth table).
   */
  getCellValue(mapIndex: number, row: number, col: number, outputIndex = 0): TernaryValue {
    const cell = this._kmap.getCell(mapIndex, row, col);
    return this._table.getOutput(cell.truthTableRow, outputIndex);
  }

  addChangeListener(listener: KMapChangeListener): void {
    this._listeners.add(listener);
  }

  removeChangeListener(listener: KMapChangeListener): void {
    this._listeners.delete(listener);
  }

  /**
   * Render the K-map into a render-context-compatible object.
   *
   * The renderer receives a sequence of draw calls describing:
   *  - Cell background rectangles
   *  - Cell value text (0, 1, X)
   *  - Row/column Gray code labels
   *  - Implicant loop rectangles (one per loop, using colorIndex)
   *
   * @param ctx     Any object with the subset of RenderContext methods used here.
   * @param cellSize  Pixel size of each cell (default 40).
   * @param outputIndex  Which output column to display (default 0).
   */
  render(
    ctx: KMapRenderContext,
    cellSize = 40,
    outputIndex = 0,
  ): void {
    const { rows, cols } = this._kmap.layout;
    const rowGray = grayCodeSequence(rows);
    const colGray = grayCodeSequence(cols);
    const labelOffset = cellSize;

    for (let si = 0; si < this._kmap.subMapCount; si++) {
      const xOffset = si * (cols + 1) * cellSize;

      // Draw grid cells
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = xOffset + labelOffset + c * cellSize;
          const y = labelOffset + r * cellSize;
          ctx.drawRect(x, y, cellSize, cellSize);

          const value = this.getCellValue(si, r, c, outputIndex);
          const text = value === 0n ? '0' : value === 1n ? '1' : 'X';
          ctx.drawText(text, x + cellSize / 2, y + cellSize / 2);
        }
      }

      // Draw column labels (Gray code)
      for (let c = 0; c < cols; c++) {
        const x = xOffset + labelOffset + c * cellSize + cellSize / 2;
        const y = labelOffset / 2;
        ctx.drawText(colGray[c]!.toString(2).padStart(this._kmap.layout.colVarCount, '0'), x, y);
      }

      // Draw row labels (Gray code)
      for (let r = 0; r < rows; r++) {
        const x = xOffset + labelOffset / 2;
        const y = labelOffset + r * cellSize + cellSize / 2;
        ctx.drawText(rowGray[r]!.toString(2).padStart(this._kmap.layout.rowVarCount, '0'), x, y);
      }

      // Draw implicant loops
      for (const loop of this._loops) {
        const loopCells = loop.cells.filter((c) => c.mapIndex === si);
        if (loopCells.length === 0) continue;

        const cellRows = loopCells.map((c) => c.row);
        const cellCols = loopCells.map((c) => c.col);
        const rMin = Math.min(...cellRows);
        const rMax = Math.max(...cellRows);
        const cMin = Math.min(...cellCols);
        const cMax = Math.max(...cellCols);

        const x = xOffset + labelOffset + cMin * cellSize;
        const y = labelOffset + rMin * cellSize;
        const w = (cMax - cMin + 1) * cellSize;
        const h = (rMax - rMin + 1) * cellSize;
        ctx.drawLoop(x, y, w, h, loop.colorIndex);
      }
    }
  }

  private _emit(row: number, value: TernaryValue): void {
    for (const listener of this._listeners) {
      listener(row, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal render context interface (subset of RenderContext)
// ---------------------------------------------------------------------------

/**
 * Minimal interface required by KarnaughMapTab.render().
 * Tests supply a mock that records calls; production uses a Canvas2D adapter.
 */
export interface KMapRenderContext {
  drawRect(x: number, y: number, width: number, height: number): void;
  drawText(text: string, x: number, y: number): void;
  drawLoop(x: number, y: number, width: number, height: number, colorIndex: number): void;
}

// ---------------------------------------------------------------------------
// Value cycling
// ---------------------------------------------------------------------------

/**
 * Cycle a ternary value: 0 → 1 → X(-1) → 0.
 */
export function cycleValue(current: TernaryValue): TernaryValue {
  if (current === 0n) return 1n;
  if (current === 1n) return -1n;
  return 0n;
}
