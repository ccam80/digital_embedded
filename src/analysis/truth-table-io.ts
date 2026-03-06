/**
 * Truth table import/export in multiple formats.
 *
 * Formats:
 *   - CSV: standard comma-separated with header row
 *   - Hex: one hex output value per line
 *   - LaTeX: tabular environment
 *   - TestCase: Digital test syntax for embedding in Testcase components
 *   - .tru: Digital's truth table file format
 */

import { TruthTable } from './truth-table.js';
import type { SignalSpec, TernaryValue } from './truth-table.js';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Export truth table to CSV.
 * Header row: input names, then output names.
 * Values: 0, 1, or X for don't-care.
 */
export function exportCsv(table: TruthTable): string {
  const headers = [
    ...table.inputs.map((s) => s.name),
    ...table.outputs.map((s) => s.name),
  ];

  const lines: string[] = [headers.join(',')];

  for (let r = 0; r < table.rowCount; r++) {
    const inputVals = table.getInputValues(r).map((v) => v.toString());
    const outputVals = table.getOutputRow(r).map(formatTernary);
    lines.push([...inputVals, ...outputVals].join(','));
  }

  return lines.join('\n');
}

/**
 * Import truth table from CSV.
 * First row is header (signal names). All signals assumed 1-bit.
 * Output columns are detected by presence of 'X' values or by being
 * listed after input columns. Heuristic: columns containing any 'X' are outputs.
 * If no X values, the last half of columns are treated as outputs.
 */
export function importCsv(text: string): TruthTable {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    throw new Error('importCsv: need at least a header row and one data row');
  }

  const headers = lines[0]!.split(',').map((h) => h.trim());
  const dataRows = lines.slice(1).map((l) => l.split(',').map((v) => v.trim()));

  // Detect output columns: any column with an 'X' value is an output
  const isOutput = new Array(headers.length).fill(false);
  let hasX = false;
  for (const row of dataRows) {
    for (let c = 0; c < row.length; c++) {
      if (row[c]!.toUpperCase() === 'X') {
        isOutput[c] = true;
        hasX = true;
      }
    }
  }

  // If no X values found, use row count heuristic
  if (!hasX) {
    // Number of rows = 2^inputBits, so inputBits = log2(rows)
    const inputBits = Math.round(Math.log2(dataRows.length));
    for (let c = inputBits; c < headers.length; c++) {
      isOutput[c] = true;
    }
  }

  const inputs: SignalSpec[] = [];
  const outputs: SignalSpec[] = [];
  const inputIndices: number[] = [];
  const outputIndices: number[] = [];

  for (let c = 0; c < headers.length; c++) {
    if (isOutput[c]) {
      outputs.push({ name: headers[c]!, bitWidth: 1 });
      outputIndices.push(c);
    } else {
      inputs.push({ name: headers[c]!, bitWidth: 1 });
      inputIndices.push(c);
    }
  }

  const data: TernaryValue[] = [];
  for (const row of dataRows) {
    for (const oi of outputIndices) {
      data.push(parseTernary(row[oi]!));
    }
  }

  return new TruthTable(inputs, outputs, data);
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

/**
 * Export truth table outputs as hex values, one per row.
 * Each line is the concatenated output value in hex.
 * Header comment shows output signal names.
 */
export function exportHex(table: TruthTable): string {
  const lines: string[] = [
    `# ${table.outputs.map((s) => s.name).join(' ')}`,
  ];

  for (let r = 0; r < table.rowCount; r++) {
    const outputRow = table.getOutputRow(r);
    // Combine outputs into single value (MSB = first output)
    let combined = 0n;
    for (const val of outputRow) {
      combined = (combined << 1n) | (val === 1n ? 1n : 0n);
    }
    lines.push(combined.toString(16).toUpperCase());
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LaTeX
// ---------------------------------------------------------------------------

/**
 * Export truth table as a LaTeX tabular environment.
 */
export function exportLatex(table: TruthTable): string {
  const allSignals = [...table.inputs, ...table.outputs];
  const colSpec = allSignals.map(() => 'c').join('|');

  const lines: string[] = [];
  lines.push(`\\begin{tabular}{${colSpec}}`);
  lines.push('\\hline');

  // Header
  const headerNames = allSignals.map((s) => s.name);
  lines.push(headerNames.join(' & ') + ' \\\\');
  lines.push('\\hline');

  // Rows
  for (let r = 0; r < table.rowCount; r++) {
    const inputVals = table.getInputValues(r).map((v) => v.toString());
    const outputVals = table.getOutputRow(r).map(formatTernary);
    lines.push([...inputVals, ...outputVals].join(' & ') + ' \\\\');
  }

  lines.push('\\hline');
  lines.push('\\end{tabular}');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// TestCase (Digital test syntax)
// ---------------------------------------------------------------------------

/**
 * Export truth table as Digital test case syntax.
 * Format compatible with Testcase components and the test parser (6.3.1).
 */
export function exportTestCase(table: TruthTable): string {
  const allSignals = [...table.inputs, ...table.outputs];

  const lines: string[] = [];
  lines.push(allSignals.map((s) => s.name).join(' '));

  for (let r = 0; r < table.rowCount; r++) {
    const inputVals = table.getInputValues(r).map((v) => v.toString());
    const outputVals = table.getOutputRow(r).map(formatTernary);
    lines.push([...inputVals, ...outputVals].join(' '));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// .tru format (Digital truth table files)
// ---------------------------------------------------------------------------

/**
 * Load a .tru truth table file.
 * Format: first line is header with signal names separated by whitespace.
 * Subsequent lines are values. Lines starting with # are comments.
 */
export function loadTru(text: string): TruthTable {
  const lines = text.trim().split(/\r?\n/).filter((l) => !l.startsWith('#') && l.trim() !== '');
  if (lines.length < 2) {
    throw new Error('loadTru: need at least a header and one data row');
  }

  const headers = lines[0]!.trim().split(/\s+/);
  const dataRows = lines.slice(1).map((l) => l.trim().split(/\s+/));

  // Determine input count from row count: 2^inputBits = dataRows.length
  const inputBits = Math.round(Math.log2(dataRows.length));
  const inputs: SignalSpec[] = headers.slice(0, inputBits).map((name) => ({ name, bitWidth: 1 }));
  const outputs: SignalSpec[] = headers.slice(inputBits).map((name) => ({ name, bitWidth: 1 }));

  const data: TernaryValue[] = [];
  for (const row of dataRows) {
    for (let c = inputBits; c < row.length; c++) {
      data.push(parseTernary(row[c]!));
    }
  }

  return new TruthTable(inputs, outputs, data);
}

/**
 * Save a truth table to .tru format.
 */
export function saveTru(table: TruthTable): string {
  const allSignals = [...table.inputs, ...table.outputs];
  const lines: string[] = [allSignals.map((s) => s.name).join(' ')];

  for (let r = 0; r < table.rowCount; r++) {
    const inputVals = table.getInputValues(r).map((v) => v.toString());
    const outputVals = table.getOutputRow(r).map(formatTernary);
    lines.push([...inputVals, ...outputVals].join(' '));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTernary(value: TernaryValue): string {
  if (value === -1n) return 'X';
  return value.toString();
}

function parseTernary(s: string): TernaryValue {
  const upper = s.toUpperCase().trim();
  if (upper === 'X') return -1n;
  return BigInt(upper) === 0n ? 0n : 1n;
}
