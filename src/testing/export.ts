/**
 * Test Results Export — convert TestResults to CSV format.
 *
 * Exports test results to RFC 4180 compliant CSV for grading and record-keeping.
 *
 * CSV columns:
 *   Row, Status, Input1, Input2, ..., Expected_Output1, Actual_Output1, Expected_Output2, Actual_Output2, ...
 */

import type { TestResults } from '../headless/types.js';
import type { ParsedTestData } from './parser.js';

/**
 * Export test results to CSV format.
 *
 * @param results  The TestResults object (from executeTests)
 * @param testData The ParsedTestData (from parseTestData) for column headers
 * @returns        RFC 4180 compliant CSV string
 */
export function exportResultsCsv(results: TestResults, testData: ParsedTestData): string {
  const lines: string[] = [];

  // Build header row
  const headerRow: string[] = ['Row', 'Status'];

  // Add input column headers
  for (const name of testData.inputNames) {
    headerRow.push(name);
  }

  // Add output column headers (Expected and Actual for each output)
  for (const name of testData.outputNames) {
    headerRow.push(`Expected_${name}`);
    headerRow.push(`Actual_${name}`);
  }

  lines.push(csvEncode(headerRow));

  // Build data rows
  for (let i = 0; i < results.vectors.length; i++) {
    const vector = results.vectors[i];
    const dataRow: string[] = [];

    // Row number (1-indexed)
    dataRow.push(String(i + 1));

    // Status
    dataRow.push(vector.passed ? 'PASS' : 'FAIL');

    // Input values
    for (const name of testData.inputNames) {
      const val = vector.inputs[name];
      dataRow.push(String(val !== undefined ? val : ''));
    }

    // Expected and Actual output values
    for (const name of testData.outputNames) {
      const expected = vector.expectedOutputs[name];
      const actual = vector.actualOutputs[name];
      dataRow.push(String(expected !== undefined ? expected : ''));
      dataRow.push(String(actual !== undefined ? actual : ''));
    }

    lines.push(csvEncode(dataRow));
  }

  return lines.join('\n');
}

/**
 * Encode a row of CSV values according to RFC 4180.
 *
 * Rules:
 *   - Fields containing comma, newline, or double-quote are enclosed in double-quotes
 *   - Double-quotes within fields are doubled
 *   - Fields are separated by commas
 *
 * @param fields Array of field values (as strings or undefined)
 * @returns      Encoded CSV row
 */
function csvEncode(fields: (string | undefined)[]): string {
  return fields
    .map((field) => {
      const val = field === undefined ? '' : String(field);

      // Check if field needs quoting
      if (val.includes(',') || val.includes('\n') || val.includes('"')) {
        // Escape double-quotes by doubling them
        const escaped = val.replace(/"/g, '""');
        return `"${escaped}"`;
      }

      return val;
    })
    .join(',');
}
