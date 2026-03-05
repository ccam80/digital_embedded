import { describe, it, expect } from 'vitest';
import { FacadeError, type TestResults } from '../types.js';

describe('FacadeTypes', () => {
  describe('testResultsShape', () => {
    it('TestResults has passed, failed, total as numbers and vectors as array', () => {
      const results: TestResults = {
        passed: 5,
        failed: 2,
        total: 7,
        vectors: [],
      };

      expect(typeof results.passed).toBe('number');
      expect(typeof results.failed).toBe('number');
      expect(typeof results.total).toBe('number');
      expect(Array.isArray(results.vectors)).toBe(true);
      expect(results.passed).toBe(5);
      expect(results.failed).toBe(2);
      expect(results.total).toBe(7);
    });

    it('TestResults.vectors contains test vector objects', () => {
      const results: TestResults = {
        passed: 1,
        failed: 0,
        total: 1,
        vectors: [
          {
            inputs: { A: 1, B: 0 },
            expectedOutputs: { Q: 1 },
            actualOutputs: { Q: 1 },
            passed: true,
          },
        ],
      };

      expect(results.vectors).toHaveLength(1);
      expect(results.vectors[0].passed).toBe(true);
      expect(results.vectors[0].inputs).toEqual({ A: 1, B: 0 });
    });
  });

  describe('facadeErrorCarriesContext', () => {
    it('FacadeError carries componentName context', () => {
      const error = new FacadeError(
        'Unknown component type "Andd". Did you mean "And"?',
        'Andd'
      );

      expect(error.message).toContain('Unknown component type');
      expect(error.componentName).toBe('Andd');
      expect(error.message).toContain('And');
    });

    it('FacadeError carries pinLabel context', () => {
      const error = new FacadeError(
        'Pin "badPin" not found. Valid pins: A, B, Q',
        undefined,
        'badPin'
      );

      expect(error.pinLabel).toBe('badPin');
      expect(error.message).toContain('badPin');
    });

    it('FacadeError carries multiple context fields', () => {
      const error = new FacadeError(
        'Cannot connect pins with mismatched bit widths',
        'And1',
        'A'
      );

      expect(error.componentName).toBe('And1');
      expect(error.pinLabel).toBe('A');
      expect(error.message).toContain('bit width');
    });

    it('FacadeError message reads as plain English', () => {
      const error = new FacadeError(
        'Unknown component type "Andd". Did you mean "And"?',
        'Andd'
      );

      // Should not be a raw stack trace
      expect(error.message).not.toContain('at ');
      expect(error.message).not.toContain('Error:');
      // Should be readable
      expect(error.message).toMatch(/Unknown component type/);
    });

    it('FacadeError can carry arbitrary context', () => {
      const error = new FacadeError(
        'Bit width mismatch',
        undefined,
        undefined,
        undefined,
        { expectedWidth: 8, actualWidth: 1 }
      );

      expect(error.context).toEqual({ expectedWidth: 8, actualWidth: 1 });
    });

    it('FacadeError is instanceof Error', () => {
      const error = new FacadeError('Test error');
      expect(error instanceof Error).toBe(true);
      expect(error.name).toBe('FacadeError');
    });
  });
});
