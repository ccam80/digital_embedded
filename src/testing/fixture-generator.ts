/**
 * Behavioral Fixture Generator — auto-generate a test template from a circuit's I/O.
 *
 * Extracts input and output signal names from the circuit's In/Out components,
 * then creates a skeleton test data string:
 *   - Comment header identifying the circuit
 *   - Signal names header line (inputs first, then outputs)
 *   - Data rows with input combinations and X (don't-care) for all outputs
 *
 * For circuits with ≤4 single-bit inputs, generates all 2^N combinations.
 * For circuits with >4 inputs, generates a partial template with representative rows.
 *
 */

import type { Circuit } from '../core/circuit.js';

// ---------------------------------------------------------------------------
// Signal extraction helpers
// ---------------------------------------------------------------------------

/** Maximum number of single-bit inputs for exhaustive generation. */
const EXHAUSTIVE_INPUT_LIMIT = 4;

/** Number of representative rows in partial templates (for large circuits). */
const PARTIAL_ROW_COUNT = 8;

/**
 * Extract input signal labels from the circuit.
 *
 * Finds all elements with typeId 'In' or 'Port' and returns their label properties.
 * Falls back to a generated name ("in0", "in1", ...) if no label is set.
 */
function extractInputNames(circuit: Circuit): string[] {
  const names: string[] = [];
  for (const element of circuit.elements) {
    if (element.typeId === 'In' || element.typeId === 'Port') {
      const label = element.getAttribute('label');
      if (typeof label === 'string' && label.trim().length > 0) {
        names.push(label.trim());
      } else {
        names.push(`in${names.length}`);
      }
    }
  }
  return names;
}

/**
 * Extract output signal labels from the circuit.
 *
 * Finds all elements with typeId 'Out' or 'Port' and returns their label properties.
 * Falls back to a generated name ("out0", "out1", ...) if no label is set.
 */
function extractOutputNames(circuit: Circuit): string[] {
  const names: string[] = [];
  for (const element of circuit.elements) {
    if (element.typeId === 'Out' || element.typeId === 'Port') {
      const label = element.getAttribute('label');
      if (typeof label === 'string' && label.trim().length > 0) {
        names.push(label.trim());
      } else {
        names.push(`out${names.length}`);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Row generation
// ---------------------------------------------------------------------------

/**
 * Format a single data row: input bit pattern followed by X for each output.
 *
 * @param inputValues  Array of 0/1 values for each input column.
 * @param outputCount  Number of output columns (all rendered as X).
 * @param colWidths    Column widths for alignment (one per total column).
 */
function formatRow(
  inputValues: number[],
  outputCount: number,
  colWidths: number[],
): string {
  const cells: string[] = [];
  for (let i = 0; i < inputValues.length; i++) {
    cells.push(String(inputValues[i]).padEnd(colWidths[i]));
  }
  for (let i = 0; i < outputCount; i++) {
    const colIdx = inputValues.length + i;
    cells.push('X'.padEnd(colWidths[colIdx]));
  }
  // Trim trailing whitespace from last cell
  if (cells.length > 0) {
    cells[cells.length - 1] = cells[cells.length - 1].trimEnd();
  }
  return cells.join(' ');
}

/**
 * Generate all 2^N input combinations for N single-bit inputs.
 * Returns an array of row arrays, each containing N values (0 or 1).
 */
function exhaustiveCombinations(n: number): number[][] {
  const count = 1 << n;
  const rows: number[][] = [];
  for (let i = 0; i < count; i++) {
    const row: number[] = [];
    for (let bit = n - 1; bit >= 0; bit--) {
      row.push((i >> bit) & 1);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Generate a partial set of representative input rows for N inputs.
 *
 * Produces PARTIAL_ROW_COUNT rows chosen to cover boundary conditions
 * and a mix of patterns. When N > PARTIAL_ROW_COUNT, not all combinations
 * are listed — just representative ones.
 */
function partialCombinations(n: number): number[][] {
  const rows: number[][] = [];
  // Always include all-zeros
  rows.push(new Array(n).fill(0));
  // All-ones
  rows.push(new Array(n).fill(1));
  // Walking 1: one input high at a time
  for (let i = 0; i < n && rows.length < PARTIAL_ROW_COUNT; i++) {
    const row = new Array(n).fill(0);
    row[i] = 1;
    rows.push(row);
  }
  // Walking 0: one input low at a time
  for (let i = 0; i < n && rows.length < PARTIAL_ROW_COUNT; i++) {
    const row = new Array(n).fill(1);
    row[i] = 0;
    rows.push(row);
  }
  // Alternating
  for (let j = 0; rows.length < PARTIAL_ROW_COUNT; j++) {
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      row.push((i + j) % 2);
    }
    rows.push(row);
    if (rows.length >= PARTIAL_ROW_COUNT) break;
  }
  return rows.slice(0, PARTIAL_ROW_COUNT);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a test fixture template for the given circuit.
 *
 * The template is returned as a string in Digital's test vector format:
 *   - Comment lines with circuit name and instructions
 *   - Header line with signal names (inputs then outputs)
 *   - Data rows with input combinations and X (don't-care) for all outputs
 *
 * For circuits with ≤4 single-bit inputs, all 2^N input combinations are listed.
 * For circuits with >4 inputs, PARTIAL_ROW_COUNT representative rows are generated.
 *
 * @param circuit  The circuit to generate a test template for.
 * @returns        Test vector string ready to paste into a Testcase component.
 */
export function generateTestFixture(circuit: Circuit): string {
  const inputNames = extractInputNames(circuit);
  const outputNames = extractOutputNames(circuit);

  const circuitName = circuit.metadata.name;

  // Build the header comment and name line
  const lines: string[] = [];
  lines.push(`# Auto-generated test template for: ${circuitName}`);
  lines.push('# Fill in expected output values, then run tests');

  if (inputNames.length === 0 && outputNames.length === 0) {
    lines.push('# No inputs or outputs found in circuit');
    return lines.join('\n');
  }

  // Determine column widths for alignment
  const allNames = [...inputNames, ...outputNames];
  const colWidths = allNames.map((name) => Math.max(name.length, 1));

  // Header line
  const headerCells = allNames.map((name, i) => name.padEnd(colWidths[i]));
  // Trim last cell's trailing padding
  if (headerCells.length > 0) {
    headerCells[headerCells.length - 1] = headerCells[headerCells.length - 1].trimEnd();
  }
  lines.push(headerCells.join(' '));

  // Choose row generation strategy
  const useExhaustive = inputNames.length <= EXHAUSTIVE_INPUT_LIMIT;
  const inputRows = useExhaustive
    ? exhaustiveCombinations(inputNames.length)
    : partialCombinations(inputNames.length);

  // Emit rows
  for (const row of inputRows) {
    lines.push(formatRow(row, outputNames.length, colWidths));
  }

  return lines.join('\n');
}
