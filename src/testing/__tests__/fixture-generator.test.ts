/**
 * Tests for generateTestFixture() — task 7.3.4.
 *
 * Tests:
 *   - headerLine:       circuit with inputs A, B and output Y → header line "A B Y"
 *   - exhaustive2bit:   2 single-bit inputs → 4 rows with all combinations
 *   - partial5bit:      5 single-bit inputs → partial template (not all 32 rows)
 *   - dontCareOutputs:  all output values are X (don't-care placeholder)
 */

import { describe, it, expect } from 'vitest';
import { generateTestFixture } from '../fixture-generator.js';
import { Circuit } from '../../core/circuit.js';
import type { CircuitElement } from '../../core/element.js';
import { PropertyBag } from '../../core/properties.js';

// ---------------------------------------------------------------------------
// Helpers: minimal stub elements for In/Out components
// ---------------------------------------------------------------------------

/**
 * Build a minimal CircuitElement stub with the given typeId and label.
 * Used to simulate In/Out components without importing their full implementations.
 */
function makeElement(typeId: 'In' | 'Out', label: string): CircuitElement {
  const props = new PropertyBag([['label', label]]);
  return {
    typeId,
    instanceId: `${typeId}-${label}`,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => props,
    getAttribute: (name: string) => props.has(name) ? props.get(name) : undefined,
    getBoundingBox: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    draw: () => {},
    serialize: () => ({
      typeId,
      instanceId: `${typeId}-${label}`,
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      mirror: false,
      properties: { label },
    }),
  };
}

/** Build a Circuit with the given In/Out signal names. */
function makeCircuit(
  name: string,
  inputs: string[],
  outputs: string[],
): Circuit {
  const circuit = new Circuit({ name });
  for (const inp of inputs) {
    circuit.addElement(makeElement('In', inp));
  }
  for (const out of outputs) {
    circuit.addElement(makeElement('Out', out));
  }
  return circuit;
}

// ---------------------------------------------------------------------------
// Parse the header line from a fixture string
// ---------------------------------------------------------------------------

function parseHeaderLine(fixture: string): string {
  const lines = fixture.split('\n');
  return lines.find((l) => !l.startsWith('#') && l.trim().length > 0) ?? '';
}

/** Return data rows (non-comment, non-header lines). */
function parseDataRows(fixture: string): string[] {
  const lines = fixture.split('\n');
  let headerFound = false;
  const rows: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#') || line.trim().length === 0) continue;
    if (!headerFound) {
      headerFound = true; // skip header
      continue;
    }
    rows.push(line.trim());
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateTestFixture', () => {
  // -------------------------------------------------------------------------
  // headerLine
  // -------------------------------------------------------------------------

  it('headerLine — circuit with inputs A, B and output Y → header "A B Y"', () => {
    const circuit = makeCircuit('AND Gate', ['A', 'B'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const header = parseHeaderLine(fixture);

    // Header tokens should be A, B, Y in that order (inputs first, then outputs)
    const tokens = header.split(/\s+/).filter((t) => t.length > 0);
    expect(tokens).toEqual(['A', 'B', 'Y']);
  });

  it('headerLine — single input, single output → 2-token header', () => {
    const circuit = makeCircuit('Buffer', ['IN'], ['OUT']);

    const fixture = generateTestFixture(circuit);
    const header = parseHeaderLine(fixture);

    const tokens = header.split(/\s+/).filter((t) => t.length > 0);
    expect(tokens).toEqual(['IN', 'OUT']);
  });

  it('headerLine — multiple outputs → all appear after inputs', () => {
    const circuit = makeCircuit('Half Adder', ['A', 'B'], ['S', 'C']);

    const fixture = generateTestFixture(circuit);
    const header = parseHeaderLine(fixture);

    const tokens = header.split(/\s+/).filter((t) => t.length > 0);
    expect(tokens).toEqual(['A', 'B', 'S', 'C']);
  });

  it('headerLine — no inputs or outputs → returns comment only', () => {
    const circuit = new Circuit({ name: 'Empty' });

    const fixture = generateTestFixture(circuit);

    // Should contain a comment and no data rows
    expect(fixture).toContain('#');
    const dataRows = parseDataRows(fixture);
    expect(dataRows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // exhaustive2bit
  // -------------------------------------------------------------------------

  it('exhaustive2bit — 2 single-bit inputs → exactly 4 rows (all combinations)', () => {
    const circuit = makeCircuit('AND Gate', ['A', 'B'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    expect(rows).toHaveLength(4);
  });

  it('exhaustive2bit — 2 inputs: rows cover all 4 input combinations', () => {
    const circuit = makeCircuit('AND Gate', ['A', 'B'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    // Extract input columns (first 2 tokens per row)
    const inputCombos = rows.map((row) => {
      const tokens = row.split(/\s+/).filter((t) => t.length > 0);
      return `${tokens[0]} ${tokens[1]}`;
    });

    expect(inputCombos).toContain('0 0');
    expect(inputCombos).toContain('0 1');
    expect(inputCombos).toContain('1 0');
    expect(inputCombos).toContain('1 1');
  });

  it('exhaustive2bit — 1 input → 2 rows (0 and 1)', () => {
    const circuit = makeCircuit('Buffer', ['A'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    expect(rows).toHaveLength(2);

    const inputValues = rows.map((row) => row.split(/\s+/)[0]);
    expect(inputValues).toContain('0');
    expect(inputValues).toContain('1');
  });

  it('exhaustive2bit — 4 inputs → 16 rows (2^4)', () => {
    const circuit = makeCircuit('4-input', ['A', 'B', 'C', 'D'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    expect(rows).toHaveLength(16);
  });

  // -------------------------------------------------------------------------
  // partial5bit
  // -------------------------------------------------------------------------

  it('partial5bit — 5 single-bit inputs → partial template, fewer than 32 rows', () => {
    const circuit = makeCircuit('5-input', ['A', 'B', 'C', 'D', 'E'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    // Must not be all 32 combinations
    expect(rows.length).toBeLessThan(32);
    // Must have at least 1 row
    expect(rows.length).toBeGreaterThan(0);
  });

  it('partial5bit — 8 inputs → partial template', () => {
    const circuit = makeCircuit('8-input', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    expect(rows.length).toBeLessThan(256);
    expect(rows.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // dontCareOutputs
  // -------------------------------------------------------------------------

  it('dontCareOutputs — all output values are X (don\'t-care placeholder)', () => {
    const circuit = makeCircuit('AND Gate', ['A', 'B'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const tokens = row.split(/\s+/).filter((t) => t.length > 0);
      // Last token is the output column (Y)
      const outputToken = tokens[tokens.length - 1];
      expect(outputToken).toBe('X');
    }
  });

  it('dontCareOutputs — multiple outputs: all are X', () => {
    const circuit = makeCircuit('Half Adder', ['A', 'B'], ['S', 'C']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    for (const row of rows) {
      const tokens = row.split(/\s+/).filter((t) => t.length > 0);
      // Columns 2 and 3 are outputs (S and C)
      expect(tokens[2]).toBe('X');
      expect(tokens[3]).toBe('X');
    }
  });

  it('dontCareOutputs — input values are 0 or 1, never X', () => {
    const circuit = makeCircuit('AND Gate', ['A', 'B'], ['Y']);

    const fixture = generateTestFixture(circuit);
    const rows = parseDataRows(fixture);

    for (const row of rows) {
      const tokens = row.split(/\s+/).filter((t) => t.length > 0);
      // First 2 tokens are inputs (A, B)
      expect(['0', '1']).toContain(tokens[0]);
      expect(['0', '1']).toContain(tokens[1]);
    }
  });

  // -------------------------------------------------------------------------
  // Comment header
  // -------------------------------------------------------------------------

  it('comment — fixture starts with comment containing circuit name', () => {
    const circuit = makeCircuit('MyCircuit', ['A'], ['Y']);

    const fixture = generateTestFixture(circuit);

    expect(fixture).toContain('# Auto-generated test template for: MyCircuit');
  });

  it('comment — fixture includes instruction comment', () => {
    const circuit = makeCircuit('Test', ['A'], ['Y']);

    const fixture = generateTestFixture(circuit);

    expect(fixture).toContain('Fill in expected output values');
  });
});
