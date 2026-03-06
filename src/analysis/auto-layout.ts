/**
 * Auto-layout for synthesised circuits.
 *
 * Implements a left-to-right flow layout:
 *   Column 0: input (In) components
 *   Column 1…depth: gate layers (ordered by expression tree depth)
 *   Column (depth+1): output (Out) components
 *
 * Components in the same column are spaced vertically with enough room for
 * wires (VERTICAL_STEP grid units per slot).
 *
 * All positions are snapped to integer grid coordinates.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';

// ---------------------------------------------------------------------------
// Layout constants (grid units)
// ---------------------------------------------------------------------------

/** Horizontal distance between column centres. */
const HORIZONTAL_STEP = 8;

/** Vertical spacing between components within a column. */
const VERTICAL_STEP = 6;

/** Horizontal padding before the first column. */
const LEFT_MARGIN = 2;

/** Vertical padding before the first row. */
const TOP_MARGIN = 2;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Position all elements in `circuit` using a left-to-right flow layout.
 *
 * Elements must have been added to the circuit before calling this function.
 * Their positions are updated in place.
 *
 * Columns are determined by the `_layoutColumn` property stored on each
 * element via the layout metadata map passed in.
 *
 * @param circuit    The circuit whose elements are to be repositioned.
 * @param columnMap  Maps each element's instanceId to its column index.
 */
export function layoutCircuit(circuit: Circuit, columnMap: ReadonlyMap<string, number>): void {
  // Group elements by column
  const columns = new Map<number, CircuitElement[]>();

  for (const el of circuit.elements) {
    const col = columnMap.get(el.instanceId) ?? 0;
    let list = columns.get(col);
    if (list === undefined) {
      list = [];
      columns.set(col, list);
    }
    list.push(el);
  }

  // Sort column indices so we can assign x positions in order
  const sortedCols = Array.from(columns.keys()).sort((a, b) => a - b);

  // Assign x per column
  const colX = new Map<number, number>();
  for (let i = 0; i < sortedCols.length; i++) {
    colX.set(sortedCols[i]!, LEFT_MARGIN + i * HORIZONTAL_STEP);
  }

  // Assign y per element within each column
  for (const col of sortedCols) {
    const elements = columns.get(col)!;
    for (let row = 0; row < elements.length; row++) {
      const el = elements[row]!;
      el.position = {
        x: colX.get(col)!,
        y: TOP_MARGIN + row * VERTICAL_STEP,
      };
    }
  }
}
