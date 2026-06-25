import { describe, it, expect } from 'vitest';
import { applyAttributeMappings, getUnmapped, testDataConverter } from '../attribute-map.js';
import type { DigAttributeMapping } from '../attribute-map.js';
import type { DigEntry, DigValue } from '../dig-schema.js';
import type { PropertyValue } from '../../core/properties.js';

/**
 * Build a typed DigAttributeMapping inline. `applyAttributeMappings` consumes
 * mappings via `convertDigValue`; this is the shape the Testcase component's
 * `testDataConverter()` produces and the loader routes through this function.
 */
function mapping(
  xmlName: string,
  propertyKey: string,
  convertDigValue: (v: DigValue) => PropertyValue,
): DigAttributeMapping {
  return { xmlName, propertyKey, convert: (s) => s, convertDigValue };
}

const intMapping = (xmlName: string, key: string) =>
  mapping(xmlName, key, (v) => (v.type === 'int' ? v.value : 0));
const stringMapping = (xmlName: string, key: string) =>
  mapping(xmlName, key, (v) => (v.type === 'string' ? v.value : ''));

describe('applyAttributeMappings', () => {
  it('dispatches convertDigValue by xmlName into the PropertyBag', () => {
    const entries: DigEntry[] = [
      { key: 'Bits', value: { type: 'int', value: 8 } },
      { key: 'Label', value: { type: 'string', value: 'Q' } },
    ];
    const bag = applyAttributeMappings(entries, [
      intMapping('Bits', 'bitWidth'),
      stringMapping('Label', 'label'),
    ]);
    expect(bag.get<number>('bitWidth')).toBe(8);
    expect(bag.get<string>('label')).toBe('Q');
  });

  it('omits a mapping whose attribute is absent from the entries', () => {
    const entries: DigEntry[] = [{ key: 'Label', value: { type: 'string', value: 'Q' } }];
    const bag = applyAttributeMappings(entries, [
      stringMapping('Label', 'label'),
      intMapping('Bits', 'bitWidth'),
    ]);
    expect(bag.has('label')).toBe(true);
    expect(bag.has('bitWidth')).toBe(false);
  });

  it('produces an empty PropertyBag for empty entries', () => {
    const bag = applyAttributeMappings([], [stringMapping('Label', 'label')]);
    expect(bag.size).toBe(0);
  });

  it('preserves unmapped entries, retrievable via getUnmapped', () => {
    const entries: DigEntry[] = [
      { key: 'Label', value: { type: 'string', value: 'A' } },
      { key: 'UnknownAttr', value: { type: 'string', value: 'x' } },
      { key: 'FutureAttr', value: { type: 'int', value: 9 } },
    ];
    const bag = applyAttributeMappings(entries, [stringMapping('Label', 'label')]);
    expect(bag.has('UnknownAttr')).toBe(false);

    const unmapped = getUnmapped(bag);
    expect(unmapped.size).toBe(2);
    expect(unmapped.has('UnknownAttr')).toBe(true);
    expect(unmapped.has('FutureAttr')).toBe(true);
    expect(unmapped.get('UnknownAttr')?.type).toBe('string');
  });

  it('getUnmapped returns an empty map when all entries are mapped', () => {
    const entries: DigEntry[] = [{ key: 'Bits', value: { type: 'int', value: 4 } }];
    const bag = applyAttributeMappings(entries, [intMapping('Bits', 'bitWidth')]);
    expect(getUnmapped(bag).size).toBe(0);
  });

  it('propagates a converter throw on an unexpected DigValue type', () => {
    const entries: DigEntry[] = [{ key: 'Bits', value: { type: 'string', value: 'eight' } }];
    const mappings = [
      mapping('Bits', 'bitWidth', (v) => {
        if (v.type !== 'int') throw new Error(`expected int, got ${v.type}`);
        return v.value;
      }),
    ];
    expect(() => applyAttributeMappings(entries, mappings)).toThrow();
  });
});

describe('testDataConverter (live — Testcase component attribute map)', () => {
  it('converts a testData DigValue to the raw string under "testData"', () => {
    const dataString = 'A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1';
    const entries: DigEntry[] = [
      { key: 'Testdata', value: { type: 'testData', value: dataString } },
    ];
    const bag = applyAttributeMappings(entries, [testDataConverter()]);
    expect(bag.get<string>('testData')).toBe(dataString);
  });

  it('uses xmlName "Testdata" and propertyKey "testData"', () => {
    const m = testDataConverter();
    expect(m.xmlName).toBe('Testdata');
    expect(m.propertyKey).toBe('testData');
  });
});
