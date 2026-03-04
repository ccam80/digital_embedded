import { describe, it, expect } from 'vitest';
import {
  applyAttributeMappings,
  getUnmapped,
  stringConverter,
  intConverter,
  bigintConverter,
  boolConverter,
  rotationConverter,
  inverterConfigConverter,
  colorConverter,
  testDataConverter,
  dataFieldConverter,
  inValueConverter,
  enumConverter,
} from '../attribute-map.js';
import type { DigEntry } from '../dig-schema.js';

describe('AttributeMap', () => {
  describe('stringConversion', () => {
    it('converts a string DigEntry to PropertyBag string value', () => {
      const entries: DigEntry[] = [
        { key: 'Label', value: { type: 'string', value: 'A' } },
      ];
      const mappings = [stringConverter('Label', 'label')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<string>('label')).toBe('A');
    });

    it('converts an empty string value', () => {
      const entries: DigEntry[] = [
        { key: 'Description', value: { type: 'string', value: '' } },
      ];
      const mappings = [stringConverter('Description', 'description')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<string>('description')).toBe('');
    });
  });

  describe('intConversion', () => {
    it('converts an int DigEntry to PropertyBag number value', () => {
      const entries: DigEntry[] = [
        { key: 'Bits', value: { type: 'int', value: 8 } },
      ];
      const mappings = [intConverter('Bits', 'bitWidth')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<number>('bitWidth')).toBe(8);
    });

    it('converts Inputs int attribute', () => {
      const entries: DigEntry[] = [
        { key: 'Inputs', value: { type: 'int', value: 3 } },
      ];
      const mappings = [intConverter('Inputs', 'inputCount')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<number>('inputCount')).toBe(3);
    });
  });

  describe('bigintConversion', () => {
    it('converts a long DigEntry to PropertyBag bigint value', () => {
      const entries: DigEntry[] = [
        { key: 'Value', value: { type: 'long', value: 0xFFFFFFFFn } },
      ];
      const mappings = [bigintConverter('Value', 'value')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<bigint>('value')).toBe(0xFFFFFFFFn);
    });

    it('preserves bigint precision beyond Number.MAX_SAFE_INTEGER', () => {
      const large = 0xFFFFFFFFFFFFFFFFn;
      const entries: DigEntry[] = [
        { key: 'Value', value: { type: 'long', value: large } },
      ];
      const mappings = [bigintConverter('Value', 'value')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<bigint>('value')).toBe(large);
    });
  });

  describe('boolConversion', () => {
    it('converts a boolean true DigEntry', () => {
      const entries: DigEntry[] = [
        { key: 'wideShape', value: { type: 'boolean', value: true } },
      ];
      const mappings = [boolConverter('wideShape', 'wideShape')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<boolean>('wideShape')).toBe(true);
    });

    it('converts a boolean false DigEntry', () => {
      const entries: DigEntry[] = [
        { key: 'Signed', value: { type: 'boolean', value: false } },
      ];
      const mappings = [boolConverter('Signed', 'signed')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<boolean>('signed')).toBe(false);
    });
  });

  describe('rotationConversion', () => {
    it('converts rotation value 3 to PropertyBag rotation 3', () => {
      const entries: DigEntry[] = [
        { key: 'rotation', value: { type: 'rotation', value: 3 } },
      ];
      const mappings = [rotationConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      // Rotation 3 = 270 degrees CCW (quarter-turns clockwise from east)
      expect(bag.get<number>('rotation')).toBe(3);
    });

    it('converts rotation value 0', () => {
      const entries: DigEntry[] = [
        { key: 'rotation', value: { type: 'rotation', value: 0 } },
      ];
      const mappings = [rotationConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<number>('rotation')).toBe(0);
    });

    it('rotationConverter uses xmlName "rotation" and propertyKey "rotation"', () => {
      const m = rotationConverter();
      expect(m.xmlName).toBe('rotation');
      expect(m.propertyKey).toBe('rotation');
    });
  });

  describe('inverterConfigConversion', () => {
    it('converts inverterConfig to JSON-encoded string in PropertyBag', () => {
      const entries: DigEntry[] = [
        { key: 'inverterConfig', value: { type: 'inverterConfig', value: ['A', 'B'] } },
      ];
      const mappings = [inverterConfigConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      // Stored as JSON string because PropertyValue does not include string[]
      const stored = bag.get<string>('inverterConfig');
      const decoded = JSON.parse(stored) as string[];
      expect(decoded).toEqual(['A', 'B']);
    });

    it('converts empty inverterConfig', () => {
      const entries: DigEntry[] = [
        { key: 'inverterConfig', value: { type: 'inverterConfig', value: [] } },
      ];
      const mappings = [inverterConfigConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      const stored = bag.get<string>('inverterConfig');
      const decoded = JSON.parse(stored) as string[];
      expect(decoded).toEqual([]);
    });
  });

  describe('colorConversion', () => {
    it('converts awt-color to JSON-encoded string in PropertyBag', () => {
      const entries: DigEntry[] = [
        { key: 'Color', value: { type: 'color', value: { r: 255, g: 0, b: 0, a: 255 } } },
      ];
      const mappings = [colorConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      const stored = bag.get<string>('color');
      const decoded = JSON.parse(stored) as { r: number; g: number; b: number; a: number };
      expect(decoded.r).toBe(255);
      expect(decoded.g).toBe(0);
      expect(decoded.b).toBe(0);
      expect(decoded.a).toBe(255);
    });

    it('colorConverter uses xmlName "Color" and propertyKey "color"', () => {
      const m = colorConverter();
      expect(m.xmlName).toBe('Color');
      expect(m.propertyKey).toBe('color');
    });
  });

  describe('unmappedPreserved', () => {
    it('preserves unmapped entries in the _unmapped map', () => {
      const entries: DigEntry[] = [
        { key: 'Label', value: { type: 'string', value: 'A' } },
        { key: 'UnknownAttr', value: { type: 'string', value: 'something' } },
      ];
      const mappings = [stringConverter('Label', 'label')];
      const bag = applyAttributeMappings(entries, mappings);

      expect(bag.has('label')).toBe(true);
      expect(bag.has('UnknownAttr')).toBe(false);

      const unmapped = getUnmapped(bag);
      expect(unmapped.size).toBe(1);
      expect(unmapped.has('UnknownAttr')).toBe(true);
      const val = unmapped.get('UnknownAttr');
      expect(val?.type).toBe('string');
    });

    it('preserves multiple unmapped entries', () => {
      const entries: DigEntry[] = [
        { key: 'Bits', value: { type: 'int', value: 8 } },
        { key: 'FutureAttr1', value: { type: 'int', value: 99 } },
        { key: 'FutureAttr2', value: { type: 'boolean', value: true } },
      ];
      const mappings = [intConverter('Bits', 'bitWidth')];
      const bag = applyAttributeMappings(entries, mappings);

      const unmapped = getUnmapped(bag);
      expect(unmapped.size).toBe(2);
      expect(unmapped.has('FutureAttr1')).toBe(true);
      expect(unmapped.has('FutureAttr2')).toBe(true);
    });

    it('getUnmapped returns empty map when all entries are mapped', () => {
      const entries: DigEntry[] = [
        { key: 'Bits', value: { type: 'int', value: 4 } },
      ];
      const mappings = [intConverter('Bits', 'bitWidth')];
      const bag = applyAttributeMappings(entries, mappings);

      const unmapped = getUnmapped(bag);
      expect(unmapped.size).toBe(0);
    });
  });

  describe('missingAttributeUsesDefault', () => {
    it('omits bitWidth from PropertyBag when no Bits entry present', () => {
      const entries: DigEntry[] = [
        { key: 'Label', value: { type: 'string', value: 'Q' } },
      ];
      const mappings = [
        stringConverter('Label', 'label'),
        intConverter('Bits', 'bitWidth'),
      ];
      const bag = applyAttributeMappings(entries, mappings);

      expect(bag.has('label')).toBe(true);
      expect(bag.has('bitWidth')).toBe(false);
    });

    it('empty entries list produces empty PropertyBag', () => {
      const entries: DigEntry[] = [];
      const mappings = [
        stringConverter('Label', 'label'),
        intConverter('Bits', 'bitWidth'),
      ];
      const bag = applyAttributeMappings(entries, mappings);

      expect(bag.has('label')).toBe(false);
      expect(bag.has('bitWidth')).toBe(false);
      expect(bag.size).toBe(0);
    });
  });

  describe('testDataConversion', () => {
    it('converts testData DigValue to PropertyBag string', () => {
      const dataString = 'A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1';
      const entries: DigEntry[] = [
        { key: 'Testdata', value: { type: 'testData', value: dataString } },
      ];
      const mappings = [testDataConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<string>('testData')).toBe(dataString);
    });
  });

  describe('dataFieldConversion', () => {
    it('converts data DigValue to raw comma-separated hex string', () => {
      const raw = '0,1,FF,3(0)';
      const entries: DigEntry[] = [
        { key: 'Data', value: { type: 'data', value: raw } },
      ];
      const mappings = [dataFieldConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<string>('data')).toBe(raw);
    });
  });

  describe('inValueConversion', () => {
    it('converts inValue DigEntry to JSON-encoded string preserving bigint', () => {
      const entries: DigEntry[] = [
        { key: 'InDefault', value: { type: 'inValue', value: { value: 7n, highZ: false } } },
      ];
      const mappings = [inValueConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      const stored = bag.get<string>('inDefault');
      const decoded = JSON.parse(stored) as { value: string; highZ: boolean };
      expect(decoded.value).toBe('7');
      expect(decoded.highZ).toBe(false);
    });

    it('converts highZ inValue DigEntry', () => {
      const entries: DigEntry[] = [
        { key: 'InDefault', value: { type: 'inValue', value: { value: 0n, highZ: true } } },
      ];
      const mappings = [inValueConverter()];
      const bag = applyAttributeMappings(entries, mappings);
      const stored = bag.get<string>('inDefault');
      const decoded = JSON.parse(stored) as { value: string; highZ: boolean };
      expect(decoded.highZ).toBe(true);
    });
  });

  describe('enumConversion', () => {
    it('converts enum DigEntry to PropertyBag string value', () => {
      const entries: DigEntry[] = [
        { key: 'intFormat', value: { type: 'enum', xmlTag: 'intFormat', value: 'Hex' } },
      ];
      const mappings = [enumConverter('intFormat', 'intFormat')];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<string>('intFormat')).toBe('Hex');
    });
  });

  describe('multipleConverters', () => {
    it('applies multiple converters in one call', () => {
      const entries: DigEntry[] = [
        { key: 'Bits', value: { type: 'int', value: 4 } },
        { key: 'Label', value: { type: 'string', value: 'Q' } },
        { key: 'wideShape', value: { type: 'boolean', value: true } },
      ];
      const mappings = [
        intConverter('Bits', 'bitWidth'),
        stringConverter('Label', 'label'),
        boolConverter('wideShape', 'wideShape'),
      ];
      const bag = applyAttributeMappings(entries, mappings);
      expect(bag.get<number>('bitWidth')).toBe(4);
      expect(bag.get<string>('label')).toBe('Q');
      expect(bag.get<boolean>('wideShape')).toBe(true);
    });
  });

  describe('converterTypeErrors', () => {
    it('stringConverter throws when called on non-string DigValue', () => {
      const entries: DigEntry[] = [
        { key: 'Label', value: { type: 'int', value: 5 } },
      ];
      const mappings = [stringConverter('Label', 'label')];
      expect(() => applyAttributeMappings(entries, mappings)).toThrow();
    });

    it('intConverter throws when called on non-int DigValue', () => {
      const entries: DigEntry[] = [
        { key: 'Bits', value: { type: 'string', value: 'eight' } },
      ];
      const mappings = [intConverter('Bits', 'bitWidth')];
      expect(() => applyAttributeMappings(entries, mappings)).toThrow();
    });
  });
});
