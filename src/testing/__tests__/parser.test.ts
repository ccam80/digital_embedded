import { describe, it, expect } from 'vitest';
import { parseTestData, parseSIValue, type ParsedTestData, type TestValue } from '../parser.js';

describe('parser', () => {
  describe('simpleTable', () => {
    it('parses a basic AND-gate truth table with 2 inputs and 1 output', () => {
      const text = 'A B Y\n0 0 0\n0 1 1\n1 0 1\n1 1 1';
      const result: ParsedTestData = parseTestData(text, 2);

      expect(result.inputNames).toEqual(['A', 'B']);
      expect(result.outputNames).toEqual(['Y']);
      expect(result.vectors).toHaveLength(4);

      // Check first vector: A=0, B=0, Y=0
      const v0 = result.vectors[0];
      expect(v0.inputs.get('A')).toEqual({ kind: 'value', value: 0n });
      expect(v0.inputs.get('B')).toEqual({ kind: 'value', value: 0n });
      expect(v0.outputs.get('Y')).toEqual({ kind: 'value', value: 0n });

      // Check last vector: A=1, B=1, Y=1
      const v3 = result.vectors[3];
      expect(v3.inputs.get('A')).toEqual({ kind: 'value', value: 1n });
      expect(v3.inputs.get('B')).toEqual({ kind: 'value', value: 1n });
      expect(v3.outputs.get('Y')).toEqual({ kind: 'value', value: 1n });
    });
  });

  describe('hexValues', () => {
    it('parses 0xFF as bigint 255', () => {
      const text = 'A B\n0xFF 0x0A';
      const result = parseTestData(text, 1);

      expect(result.vectors[0].inputs.get('A')).toEqual({ kind: 'value', value: 255n });
      expect(result.vectors[0].outputs.get('B')).toEqual({ kind: 'value', value: 10n });
    });

    it('parses decimal 255 as bigint 255', () => {
      const text = 'A\n255';
      const result = parseTestData(text);

      expect(result.vectors[0].inputs.get('A')).toEqual({ kind: 'value', value: 255n });
    });
  });

  describe('dontCare', () => {
    it('parses X in output column as dontCare', () => {
      const text = 'A Y\n0 X\n1 1';
      const result = parseTestData(text, 1);

      const dontCare: TestValue = { kind: 'dontCare' };
      expect(result.vectors[0].outputs.get('Y')).toEqual(dontCare);
      expect(result.vectors[1].outputs.get('Y')).toEqual({ kind: 'value', value: 1n });
    });

    it('parses X in input column as dontCare', () => {
      const text = 'A B\nX 1';
      const result = parseTestData(text);

      expect(result.vectors[0].inputs.get('A')).toEqual({ kind: 'dontCare' });
    });
  });

  describe('clockPulse', () => {
    it('parses C as clock', () => {
      const text = 'CLK Q\nC 0\nC 1';
      const result = parseTestData(text, 1);

      const clock: TestValue = { kind: 'clock' };
      expect(result.vectors[0].inputs.get('CLK')).toEqual(clock);
      expect(result.vectors[1].inputs.get('CLK')).toEqual(clock);
    });
  });

  describe('highZ', () => {
    it('parses Z as highZ', () => {
      const text = 'A Y\n0 Z\n1 1';
      const result = parseTestData(text, 1);

      const highZ: TestValue = { kind: 'highZ' };
      expect(result.vectors[0].outputs.get('Y')).toEqual(highZ);
      expect(result.vectors[1].outputs.get('Y')).toEqual({ kind: 'value', value: 1n });
    });
  });

  describe('loopExpansion', () => {
    it('expands loop(i, 3) body to 3 identical vectors', () => {
      const text = 'A B\nloop(i, 3)\n0 1\nend loop';
      const result = parseTestData(text, 1);

      expect(result.vectors).toHaveLength(3);
      for (const v of result.vectors) {
        expect(v.inputs.get('A')).toEqual({ kind: 'value', value: 0n });
        expect(v.outputs.get('B')).toEqual({ kind: 'value', value: 1n });
      }
    });

    it('expands nested loops correctly', () => {
      const text = 'A B\nloop(i, 2)\nloop(j, 2)\n0 1\nend loop\nend loop';
      const result = parseTestData(text, 1);

      expect(result.vectors).toHaveLength(4);
    });
  });

  describe('repeatExpansion', () => {
    it('expands repeat(5) row to 5 identical vectors', () => {
      const text = 'A B\nrepeat(5) 1 0';
      const result = parseTestData(text, 1);

      expect(result.vectors).toHaveLength(5);
      for (const v of result.vectors) {
        expect(v.inputs.get('A')).toEqual({ kind: 'value', value: 1n });
        expect(v.outputs.get('B')).toEqual({ kind: 'value', value: 0n });
      }
    });

    it('expands repeat(1) to a single vector', () => {
      const text = 'X\nrepeat(1) 42';
      const result = parseTestData(text);

      expect(result.vectors).toHaveLength(1);
      expect(result.vectors[0].inputs.get('X')).toEqual({ kind: 'value', value: 42n });
    });
  });

  describe('comments', () => {
    it('ignores lines starting with #', () => {
      const text = '# this is a comment\nA B\n# another comment\n0 1\n1 0';
      const result = parseTestData(text, 1);

      expect(result.inputNames).toEqual(['A']);
      expect(result.outputNames).toEqual(['B']);
      expect(result.vectors).toHaveLength(2);
    });

    it('ignores mid-line # comments', () => {
      const text = 'A B\n0 1 # inline comment\n1 0';
      const result = parseTestData(text, 1);

      expect(result.vectors).toHaveLength(2);
    });
  });

  describe('emptyInput', () => {
    it('throws a descriptive error for empty string', () => {
      expect(() => parseTestData('')).toThrow();
    });

    it('throws a descriptive error for whitespace-only input', () => {
      expect(() => parseTestData('   \n  \n')).toThrow();
    });

    it('error message is descriptive', () => {
      let caught: Error | undefined;
      try {
        parseTestData('');
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message.length).toBeGreaterThan(5);
    });
  });

  describe('malformedRow', () => {
    it('throws with line number information when row has wrong column count', () => {
      const text = 'A B Y\n0 0 0\n1 1'; // third row only has 2 values
      let caught: Error | undefined;
      try {
        parseTestData(text, 2);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      // The error message should contain a line number
      expect(caught!.message).toMatch(/line \d+/i);
    });

    it('throws when row has too many columns', () => {
      const text = 'A B\n0 1 1';
      expect(() => parseTestData(text, 1)).toThrow(/line \d+/i);
    });
  });

  describe('multipleSignals', () => {
    it('handles half-adder style truth table (2 inputs, 2 outputs)', () => {
      const text = 'A B S C\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1';
      const result = parseTestData(text, 2);

      expect(result.inputNames).toEqual(['A', 'B']);
      expect(result.outputNames).toEqual(['S', 'C']);
      expect(result.vectors).toHaveLength(4);

      const v3 = result.vectors[3]; // 1 1 0 1
      expect(v3.inputs.get('A')).toEqual({ kind: 'value', value: 1n });
      expect(v3.inputs.get('B')).toEqual({ kind: 'value', value: 1n });
      expect(v3.outputs.get('S')).toEqual({ kind: 'value', value: 0n });
      expect(v3.outputs.get('C')).toEqual({ kind: 'value', value: 1n });
    });
  });

  describe('bitsExpansion', () => {
    it('expands bits(4, 0xA) into 4 individual bit columns', () => {
      // bits(4, 0xA) = 1010 → 4 columns: 1, 0, 1, 0
      const text = 'A B C D\nbits(4, 0xA)';
      const result = parseTestData(text);

      expect(result.vectors).toHaveLength(1);
      const v = result.vectors[0];
      expect(v.inputs.get('A')).toEqual({ kind: 'value', value: 1n });
      expect(v.inputs.get('B')).toEqual({ kind: 'value', value: 0n });
      expect(v.inputs.get('C')).toEqual({ kind: 'value', value: 1n });
      expect(v.inputs.get('D')).toEqual({ kind: 'value', value: 0n });
    });
  });

  describe('noInputCount', () => {
    it('returns all names as inputs and empty outputNames when inputCount is omitted', () => {
      const text = 'A B Y\n0 0 0\n1 1 1';
      const result = parseTestData(text);

      expect(result.inputNames).toEqual(['A', 'B', 'Y']);
      expect(result.outputNames).toEqual([]);
      expect(result.vectors).toHaveLength(2);
    });
  });

  describe('whitespace', () => {
    it('handles extra whitespace between columns', () => {
      const text = 'A  B   Y\n0  0   1';
      const result = parseTestData(text, 2);

      expect(result.vectors).toHaveLength(1);
      expect(result.vectors[0].inputs.get('A')).toEqual({ kind: 'value', value: 0n });
    });
  });

  describe('caseInsensitiveSpecialValues', () => {
    it('parses lowercase x as dontCare', () => {
      const text = 'A\nx';
      const result = parseTestData(text);
      expect(result.vectors[0].inputs.get('A')).toEqual({ kind: 'dontCare' });
    });

    it('parses lowercase c as clock', () => {
      const text = 'CLK\nc';
      const result = parseTestData(text);
      expect(result.vectors[0].inputs.get('CLK')).toEqual({ kind: 'clock' });
    });

    it('parses lowercase z as highZ', () => {
      const text = 'A\nz';
      const result = parseTestData(text);
      expect(result.vectors[0].inputs.get('A')).toEqual({ kind: 'highZ' });
    });
  });

  describe('parseSIValue', () => {









    it('throws on non-numeric input', () => {
      expect(() => parseSIValue('abc')).toThrow();
    });
  });

  describe('analogDomain', () => {
    it('parses float value as analogValue when domain is analog', () => {
      const domains = new Map([['Vout', 'analog' as const]]);
      const text = 'Vin Vout\n5 3.3';
      const result = parseTestData(text, 1, domains);
      expect(result.vectors[0].outputs.get('Vout')).toEqual({ kind: 'analogValue', value: 3.3 });
    });

    it('parses SI suffix value in analog domain', () => {
      const domains = new Map([['Vout', 'analog' as const]]);
      const text = 'Vin Vout\n5 4.7k';
      const result = parseTestData(text, 1, domains);
      const v = result.vectors[0].outputs.get('Vout');
      expect(v?.kind).toBe('analogValue');
    });

    it('parses analog value with relative tolerance', () => {
      const domains = new Map([['Vout', 'analog' as const]]);
      const text = 'Vin Vout\n5 3.3~5%';
      const result = parseTestData(text, 1, domains);
      const v = result.vectors[0].outputs.get('Vout');
      expect(v?.kind).toBe('analogValue');
      if (v?.kind === 'analogValue') {
        expect(v.tolerance).toEqual({ relative: 0.05 });
      }
    });

    it('parses analog value with absolute tolerance', () => {
      const domains = new Map([['Vout', 'analog' as const]]);
      const text = 'Vin Vout\n5 3.3~100m';
      const result = parseTestData(text, 1, domains);
      const v = result.vectors[0].outputs.get('Vout');
      expect(v?.kind).toBe('analogValue');
      if (v?.kind === 'analogValue') {
      }
    });

    it('parses X as dontCare in analog domain', () => {
      const domains = new Map([['Vout', 'analog' as const]]);
      const text = 'Vin Vout\n5 X';
      const result = parseTestData(text, 1, domains);
      expect(result.vectors[0].outputs.get('Vout')).toEqual({ kind: 'dontCare' });
    });

    it('rejects C in analog domain', () => {
      const domains = new Map([['CLK', 'analog' as const]]);
      const text = 'CLK Vout\nC 3.3';
      expect(() => parseTestData(text, 1, domains)).toThrow();
    });

    it('rejects Z in analog domain', () => {
      const domains = new Map([['Vout', 'analog' as const]]);
      const text = 'Vin Vout\n5 Z';
      expect(() => parseTestData(text, 1, domains)).toThrow();
    });
  });

  describe('analogPragmas', () => {
    it('parses #analog:tolerance relative pragma', () => {
      const text = '#analog:tolerance 5%\nA B\n0 1';
      const result = parseTestData(text, 1);
      expect(result.analogPragmas?.tolerance).toEqual({ relative: 0.05 });
    });

    it('parses #analog:abstol pragma', () => {
      const text = '#analog:abstol 1m\nA B\n0 1';
      const result = parseTestData(text, 1);
    });

    it('parses #analog:settle pragma', () => {
      const text = '#analog:settle 10m\nA B\n0 1';
      const result = parseTestData(text, 1);
    });

    it('returns empty analogPragmas when no pragmas present', () => {
      const text = 'A B\n0 1';
      const result = parseTestData(text, 1);
      expect(result.analogPragmas).toBeDefined();
      expect(result.analogPragmas?.tolerance).toBeUndefined();
    });
  });
});
