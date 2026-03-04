import { describe, it, expect } from 'vitest';
import {
  type DigValue,
  type DigEntry,
  type DigCircuit,
  type DigVisualElement,
  type DigWire,
  type RomListData,
  DIG_VALUE_TYPES,
  isStringValue,
  isIntValue,
  isLongValue,
  isBooleanValue,
  isRotationValue,
  isColorValue,
  isTestDataValue,
  isInverterConfigValue,
  isDataValue,
  isInValueValue,
  isRomListValue,
  isEnumValue,
} from '../dig-schema.js';

describe('DigSchema', () => {
  describe('typesAreExhaustive', () => {
    it('covers all known XML attribute type variants', () => {
      // Verify DIG_VALUE_TYPES covers every discriminant in the union.
      // If DigValue is extended with a new type, the satisfies clause in the
      // source file will produce a compile error, and the count check here
      // catches any runtime mismatch.
      expect(DIG_VALUE_TYPES).toHaveLength(12);

      const expected = [
        'string', 'int', 'long', 'boolean', 'rotation',
        'color', 'testData', 'inverterConfig', 'data',
        'inValue', 'romList', 'enum',
      ];
      expect([...DIG_VALUE_TYPES].sort()).toEqual([...expected].sort());
    });

    it('type guard for string variant', () => {
      const v: DigValue = { type: 'string', value: 'hello' };
      expect(isStringValue(v)).toBe(true);
      expect(isIntValue(v)).toBe(false);
    });

    it('type guard for int variant', () => {
      const v: DigValue = { type: 'int', value: 42 };
      expect(isIntValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for long variant', () => {
      const v: DigValue = { type: 'long', value: 9999999999999999n };
      expect(isLongValue(v)).toBe(true);
      expect(isIntValue(v)).toBe(false);
    });

    it('type guard for boolean variant', () => {
      const v: DigValue = { type: 'boolean', value: true };
      expect(isBooleanValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for rotation variant', () => {
      const v: DigValue = { type: 'rotation', value: 3 };
      expect(isRotationValue(v)).toBe(true);
      expect(isIntValue(v)).toBe(false);
    });

    it('type guard for color variant', () => {
      const v: DigValue = { type: 'color', value: { r: 255, g: 0, b: 128, a: 255 } };
      expect(isColorValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for testData variant', () => {
      const v: DigValue = { type: 'testData', value: 'A B Y\n0 0 0' };
      expect(isTestDataValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for inverterConfig variant', () => {
      const v: DigValue = { type: 'inverterConfig', value: ['A', 'B'] };
      expect(isInverterConfigValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for data variant', () => {
      const v: DigValue = { type: 'data', value: '0,1,2,3' };
      expect(isDataValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for inValue variant', () => {
      const v: DigValue = { type: 'inValue', value: { value: 7n, highZ: false } };
      expect(isInValueValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for romList variant', () => {
      const romData: RomListData = { files: [{ name: 'prog.hex', data: '0,1,2' }] };
      const v: DigValue = { type: 'romList', value: romData };
      expect(isRomListValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('type guard for enum variant', () => {
      const v: DigValue = { type: 'enum', xmlTag: 'barrelShifterMode', value: 'left' };
      expect(isEnumValue(v)).toBe(true);
      expect(isStringValue(v)).toBe(false);
    });

    it('each type guard returns false for every other type', () => {
      const samples: DigValue[] = [
        { type: 'string', value: 'x' },
        { type: 'int', value: 0 },
        { type: 'long', value: 0n },
        { type: 'boolean', value: false },
        { type: 'rotation', value: 0 },
        { type: 'color', value: { r: 0, g: 0, b: 0, a: 0 } },
        { type: 'testData', value: '' },
        { type: 'inverterConfig', value: [] },
        { type: 'data', value: '' },
        { type: 'inValue', value: { value: 0n, highZ: false } },
        { type: 'romList', value: { files: [] } },
        { type: 'enum', xmlTag: 'x', value: 'y' },
      ];

      const guards = [
        isStringValue, isIntValue, isLongValue, isBooleanValue,
        isRotationValue, isColorValue, isTestDataValue, isInverterConfigValue,
        isDataValue, isInValueValue, isRomListValue, isEnumValue,
      ];

      // Each guard should match exactly one sample (the one at the same index).
      samples.forEach((sample, i) => {
        guards.forEach((guard, j) => {
          expect(guard(sample)).toBe(i === j);
        });
      });
    });
  });

  describe('entryStructure', () => {
    it('constructs DigEntry with string value', () => {
      const entry: DigEntry = { key: 'Label', value: { type: 'string', value: 'A' } };
      expect(entry.key).toBe('Label');
      expect(entry.value.type).toBe('string');
      if (isStringValue(entry.value)) {
        expect(entry.value.value).toBe('A');
      }
    });

    it('constructs DigEntry with int value', () => {
      const entry: DigEntry = { key: 'Bits', value: { type: 'int', value: 8 } };
      expect(entry.key).toBe('Bits');
      if (isIntValue(entry.value)) {
        expect(entry.value.value).toBe(8);
      }
    });

    it('constructs DigEntry with long value preserving bigint precision', () => {
      const bigVal = 0xFFFFFFFFFFFFFFFFn;
      const entry: DigEntry = { key: 'Value', value: { type: 'long', value: bigVal } };
      if (isLongValue(entry.value)) {
        expect(entry.value.value).toBe(bigVal);
        // Verify it exceeds Number.MAX_SAFE_INTEGER to confirm bigint is required
        expect(Number(entry.value.value) > Number.MAX_SAFE_INTEGER).toBe(true);
      }
    });

    it('constructs DigEntry with boolean value', () => {
      const entry: DigEntry = { key: 'wideShape', value: { type: 'boolean', value: true } };
      if (isBooleanValue(entry.value)) {
        expect(entry.value.value).toBe(true);
      }
    });

    it('constructs DigEntry with rotation value 0', () => {
      const entry: DigEntry = { key: 'rotation', value: { type: 'rotation', value: 0 } };
      if (isRotationValue(entry.value)) {
        expect(entry.value.value).toBe(0);
      }
    });

    it('constructs DigEntry with rotation value 3', () => {
      const entry: DigEntry = { key: 'rotation', value: { type: 'rotation', value: 3 } };
      if (isRotationValue(entry.value)) {
        expect(entry.value.value).toBe(3);
      }
    });

    it('constructs DigEntry with color value', () => {
      const color = { r: 255, g: 128, b: 0, a: 200 };
      const entry: DigEntry = { key: 'Color', value: { type: 'color', value: color } };
      if (isColorValue(entry.value)) {
        expect(entry.value.value.r).toBe(255);
        expect(entry.value.value.g).toBe(128);
        expect(entry.value.value.b).toBe(0);
        expect(entry.value.value.a).toBe(200);
      }
    });

    it('constructs DigEntry with testData value', () => {
      const entry: DigEntry = { key: 'Testdata', value: { type: 'testData', value: 'A B Y\n0 0 0\n1 1 1' } };
      if (isTestDataValue(entry.value)) {
        expect(entry.value.value).toContain('A B Y');
      }
    });

    it('constructs DigEntry with inverterConfig value', () => {
      const entry: DigEntry = { key: 'inverterConfig', value: { type: 'inverterConfig', value: ['In_1', 'In_2'] } };
      if (isInverterConfigValue(entry.value)) {
        expect(entry.value.value).toEqual(['In_1', 'In_2']);
      }
    });

    it('constructs DigEntry with data value', () => {
      const entry: DigEntry = { key: 'Data', value: { type: 'data', value: '0,1,FF,3(0)' } };
      if (isDataValue(entry.value)) {
        expect(entry.value.value).toBe('0,1,FF,3(0)');
      }
    });

    it('constructs DigEntry with inValue (non-highZ)', () => {
      const entry: DigEntry = { key: 'InDefault', value: { type: 'inValue', value: { value: 5n, highZ: false } } };
      if (isInValueValue(entry.value)) {
        expect(entry.value.value.value).toBe(5n);
        expect(entry.value.value.highZ).toBe(false);
      }
    });

    it('constructs DigEntry with inValue (highZ)', () => {
      const entry: DigEntry = { key: 'InDefault', value: { type: 'inValue', value: { value: 0n, highZ: true } } };
      if (isInValueValue(entry.value)) {
        expect(entry.value.value.highZ).toBe(true);
      }
    });

    it('constructs DigEntry with romList value', () => {
      const romData: RomListData = {
        files: [
          { name: 'rom0.hex', data: '0,1,2,3' },
          { name: 'rom1.hex', data: 'FF,FE' },
        ],
      };
      const entry: DigEntry = { key: 'romContent', value: { type: 'romList', value: romData } };
      if (isRomListValue(entry.value)) {
        expect(entry.value.value.files).toHaveLength(2);
        expect(entry.value.value.files[0].name).toBe('rom0.hex');
        expect(entry.value.value.files[1].data).toBe('FF,FE');
      }
    });

    it('constructs DigEntry with enum value', () => {
      const entry: DigEntry = {
        key: 'Direction',
        value: { type: 'enum', xmlTag: 'direction', value: 'left' },
      };
      if (isEnumValue(entry.value)) {
        expect(entry.value.xmlTag).toBe('direction');
        expect(entry.value.value).toBe('left');
      }
    });

    it('constructs a complete DigCircuit', () => {
      const circuit: DigCircuit = {
        version: 2,
        attributes: [],
        visualElements: [
          {
            elementName: 'And',
            pos: { x: 100, y: 200 },
            elementAttributes: [
              { key: 'wideShape', value: { type: 'boolean', value: true } },
              { key: 'Inputs', value: { type: 'int', value: 2 } },
            ],
          },
        ],
        wires: [
          { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } },
        ],
        measurementOrdering: ['A', 'B', 'Y'],
      };

      expect(circuit.version).toBe(2);
      expect(circuit.visualElements).toHaveLength(1);
      expect(circuit.visualElements[0].elementName).toBe('And');
      expect(circuit.visualElements[0].pos).toEqual({ x: 100, y: 200 });
      expect(circuit.wires).toHaveLength(1);
      expect(circuit.measurementOrdering).toEqual(['A', 'B', 'Y']);
    });

    it('DigCircuit measurementOrdering is optional', () => {
      const circuit: DigCircuit = {
        version: 2,
        attributes: [],
        visualElements: [],
        wires: [],
      };
      expect(circuit.measurementOrdering).toBeUndefined();
    });

    it('constructs DigVisualElement with correct fields', () => {
      const el: DigVisualElement = {
        elementName: 'In',
        pos: { x: 20, y: 40 },
        elementAttributes: [
          { key: 'Label', value: { type: 'string', value: 'clk' } },
        ],
      };
      expect(el.elementName).toBe('In');
      expect(el.pos.x).toBe(20);
      expect(el.pos.y).toBe(40);
      expect(el.elementAttributes[0].key).toBe('Label');
    });

    it('constructs DigWire with correct p1 and p2', () => {
      const wire: DigWire = { p1: { x: 10, y: 20 }, p2: { x: 50, y: 20 } };
      expect(wire.p1.x).toBe(10);
      expect(wire.p1.y).toBe(20);
      expect(wire.p2.x).toBe(50);
      expect(wire.p2.y).toBe(20);
    });

    it('exhaustive switch on DigValue type compiles and works at runtime', () => {
      const values: DigValue[] = [
        { type: 'string', value: 'x' },
        { type: 'int', value: 1 },
        { type: 'long', value: 1n },
        { type: 'boolean', value: true },
        { type: 'rotation', value: 1 },
        { type: 'color', value: { r: 0, g: 0, b: 0, a: 0 } },
        { type: 'testData', value: '' },
        { type: 'inverterConfig', value: [] },
        { type: 'data', value: '' },
        { type: 'inValue', value: { value: 0n, highZ: false } },
        { type: 'romList', value: { files: [] } },
        { type: 'enum', xmlTag: 'x', value: 'y' },
      ];

      const handled: string[] = [];
      for (const v of values) {
        switch (v.type) {
          case 'string': handled.push('string'); break;
          case 'int': handled.push('int'); break;
          case 'long': handled.push('long'); break;
          case 'boolean': handled.push('boolean'); break;
          case 'rotation': handled.push('rotation'); break;
          case 'color': handled.push('color'); break;
          case 'testData': handled.push('testData'); break;
          case 'inverterConfig': handled.push('inverterConfig'); break;
          case 'data': handled.push('data'); break;
          case 'inValue': handled.push('inValue'); break;
          case 'romList': handled.push('romList'); break;
          case 'enum': handled.push('enum'); break;
        }
      }
      // All 12 types handled
      expect(handled).toHaveLength(12);
      expect(new Set(handled).size).toBe(12);
    });
  });
});
