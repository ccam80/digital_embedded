/**
 * Tests for Test Results Export.
 *
 * Verifies CSV generation for test results.
 */

import { describe, it, expect } from 'vitest';
import { exportResultsCsv } from '../export.js';
import type { TestResults } from '../../headless/types.js';
import type { ParsedTestData } from '../parser.js';

describe('exportResultsCsv', () => {
  it('csvHeader', () => {
    const testData: ParsedTestData = {
      inputNames: ['A', 'B'],
      outputNames: ['Y'],
      vectors: [],
    };

    const results: TestResults = {
      passed: 0,
      failed: 0,
      total: 0,
      vectors: [],
    };

    const csv = exportResultsCsv(results, testData);
    const lines = csv.split('\n');
    const headerLine = lines[0];

    // Verify header contains all expected column names
    expect(headerLine).toContain('Row');
    expect(headerLine).toContain('Status');
    expect(headerLine).toContain('A');
    expect(headerLine).toContain('B');
    expect(headerLine).toContain('Expected_Y');
    expect(headerLine).toContain('Actual_Y');
  });

  it('csvRows', () => {
    const testData: ParsedTestData = {
      inputNames: ['A', 'B'],
      outputNames: ['Y'],
      vectors: [
        {
          inputs: new Map([['A', { kind: 'value', value: 0n }], ['B', { kind: 'value', value: 0n }]]),
          outputs: new Map([['Y', { kind: 'value', value: 0n }]]),
        },
        {
          inputs: new Map([['A', { kind: 'value', value: 0n }], ['B', { kind: 'value', value: 1n }]]),
          outputs: new Map([['Y', { kind: 'value', value: 1n }]]),
        },
        {
          inputs: new Map([['A', { kind: 'value', value: 1n }], ['B', { kind: 'value', value: 0n }]]),
          outputs: new Map([['Y', { kind: 'value', value: 1n }]]),
        },
      ],
    };

    const results: TestResults = {
      passed: 3,
      failed: 0,
      total: 3,
      vectors: [
        {
          passed: true,
          inputs: { A: 0, B: 0 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 0 },
        },
        {
          passed: true,
          inputs: { A: 0, B: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
        {
          passed: true,
          inputs: { A: 1, B: 0 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
      ],
    };

    const csv = exportResultsCsv(results, testData);
    const lines = csv.split('\n');

    // Should have header + 3 data rows
    expect(lines.length).toBe(4);

    // Verify each data row has correct structure
    const row1 = lines[1];
    expect(row1).toContain('1');
    expect(row1).toContain('PASS');
  });

  it('passFailStatus', () => {
    const testData: ParsedTestData = {
      inputNames: ['A'],
      outputNames: ['Y'],
      vectors: [
        {
          inputs: new Map([['A', { kind: 'value', value: 0n }]]),
          outputs: new Map([['Y', { kind: 'value', value: 0n }]]),
        },
        {
          inputs: new Map([['A', { kind: 'value', value: 1n }]]),
          outputs: new Map([['Y', { kind: 'value', value: 1n }]]),
        },
      ],
    };

    const results: TestResults = {
      passed: 1,
      failed: 1,
      total: 2,
      vectors: [
        {
          passed: true,
          inputs: { A: 0 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 0 },
        },
        {
          passed: false,
          inputs: { A: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 0 },
        },
      ],
    };

    const csv = exportResultsCsv(results, testData);
    const lines = csv.split('\n');

    // Check row 1 (passed)
    expect(lines[1]).toContain('PASS');

    // Check row 2 (failed)
    expect(lines[2]).toContain('FAIL');
  });

  it('valuesCorrect', () => {
    const testData: ParsedTestData = {
      inputNames: ['X', 'Y'],
      outputNames: ['Z'],
      vectors: [
        {
          inputs: new Map([['X', { kind: 'value', value: 42n }], ['Y', { kind: 'value', value: 100n }]]),
          outputs: new Map([['Z', { kind: 'value', value: 142n }]]),
        },
      ],
    };

    const results: TestResults = {
      passed: 1,
      failed: 0,
      total: 1,
      vectors: [
        {
          passed: true,
          inputs: { X: 42, Y: 100 },
          expectedOutputs: { Z: 142 },
          actualOutputs: { Z: 142 },
        },
      ],
    };

    const csv = exportResultsCsv(results, testData);
    const lines = csv.split('\n');

    // Verify input values appear in correct columns
    const dataRow = lines[1];
    const fields = dataRow.split(',');

    // Row number at index 0
    expect(fields[0]).toBe('1');
    // Status at index 1
    expect(fields[1]).toBe('PASS');
    // X value at index 2
    expect(fields[2]).toBe('42');
    // Y value at index 3
    expect(fields[3]).toBe('100');
    // Expected_Z at index 4
    expect(fields[4]).toBe('142');
    // Actual_Z at index 5
    expect(fields[5]).toBe('142');
  });
});
