import { describe, it, expect } from 'vitest';
import {
  PropertyType,
  PropertyBag,
  propertyBagToJson,
  type PropertyValue,
} from '../properties';

// ---------------------------------------------------------------------------
// PropertyType enum
// ---------------------------------------------------------------------------

describe('PropertyType enum', () => {
  it('has all required variants', () => {
    expect(PropertyType.INT).toBe('INT');
    expect(PropertyType.STRING).toBe('STRING');
    expect(PropertyType.ENUM).toBe('ENUM');
    expect(PropertyType.BOOLEAN).toBe('BOOLEAN');
    expect(PropertyType.BIT_WIDTH).toBe('BIT_WIDTH');
    expect(PropertyType.HEX_DATA).toBe('HEX_DATA');
    expect(PropertyType.COLOR).toBe('COLOR');
    expect(PropertyType.LONG).toBe('LONG');
    expect(PropertyType.FILE).toBe('FILE');
    expect(PropertyType.ROTATION).toBe('ROTATION');
    expect(PropertyType.INTFORMAT).toBe('INTFORMAT');
  });
});

// ---------------------------------------------------------------------------
// PropertyBag — construction
// ---------------------------------------------------------------------------

describe('PropertyBag construction', () => {
  it('starts empty when no entries provided', () => {
    const bag = new PropertyBag();
    expect(bag.size).toBe(0);
  });

  it('accepts initial entries from iterable', () => {
    const bag = new PropertyBag([
      ['bitWidth', 8],
      ['label', 'A'],
    ]);
    expect(bag.size).toBe(2);
    expect(bag.get<number>('bitWidth')).toBe(8);
    expect(bag.get<string>('label')).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// PropertyBag — get / set / has
// ---------------------------------------------------------------------------

describe('PropertyBag CRUD', () => {
  it('set and get a number', () => {
    const bag = new PropertyBag();
    bag.set('inputCount', 4);
    expect(bag.get<number>('inputCount')).toBe(4);
  });

  it('set and get a string', () => {
    const bag = new PropertyBag();
    bag.set('label', 'CLK');
    expect(bag.get<string>('label')).toBe('CLK');
  });

  it('set and get a boolean', () => {
    const bag = new PropertyBag();
    bag.set('signed', true);
    expect(bag.get<boolean>('signed')).toBe(true);
  });

  it('set and get a bigint', () => {
    const bag = new PropertyBag();
    const val = BigInt('9007199254740993'); // > Number.MAX_SAFE_INTEGER
    bag.set('value', val);
    expect(bag.get<bigint>('value')).toBe(val);
  });

  it('set and get a number array', () => {
    const bag = new PropertyBag();
    bag.set('hexData', [0xDE, 0xAD, 0xBE, 0xEF]);
    expect(bag.get<number[]>('hexData')).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('has() returns false for absent key', () => {
    const bag = new PropertyBag();
    expect(bag.has('missing')).toBe(false);
  });

  it('has() returns true after set', () => {
    const bag = new PropertyBag();
    bag.set('x', 1);
    expect(bag.has('x')).toBe(true);
  });

  it('get() throws for absent key', () => {
    const bag = new PropertyBag();
    expect(() => bag.get('absent')).toThrow('PropertyBag: key "absent" not found');
  });

  it('overwriting a key replaces the value', () => {
    const bag = new PropertyBag();
    bag.set('bits', 4);
    bag.set('bits', 8);
    expect(bag.get<number>('bits')).toBe(8);
  });

  it('size increments correctly', () => {
    const bag = new PropertyBag();
    expect(bag.size).toBe(0);
    bag.set('a', 1);
    expect(bag.size).toBe(1);
    bag.set('b', 2);
    expect(bag.size).toBe(2);
    bag.set('a', 99); // overwrite, not new key
    expect(bag.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PropertyBag — getOrDefault
// ---------------------------------------------------------------------------

describe('PropertyBag.getOrDefault', () => {
  it('returns default when key is absent', () => {
    const bag = new PropertyBag();
    expect(bag.getOrDefault('missing', 42)).toBe(42);
  });

  it('returns stored value when key is present', () => {
    const bag = new PropertyBag();
    bag.set('bits', 16);
    expect(bag.getOrDefault('bits', 1)).toBe(16);
  });

  it('returns string default correctly', () => {
    const bag = new PropertyBag();
    expect(bag.getOrDefault<string>('label', 'Q')).toBe('Q');
  });
});

// ---------------------------------------------------------------------------
// PropertyBag — clone independence
// ---------------------------------------------------------------------------

describe('PropertyBag.clone', () => {
  it('clone is a distinct object', () => {
    const bag = new PropertyBag([['x', 1]]);
    const clone = bag.clone();
    expect(clone).not.toBe(bag);
  });

  it('clone contains same primitive values', () => {
    const bag = new PropertyBag([
      ['n', 42],
      ['s', 'hello'],
      ['b', false],
    ]);
    const clone = bag.clone();
    expect(clone.get<number>('n')).toBe(42);
    expect(clone.get<string>('s')).toBe('hello');
    expect(clone.get<boolean>('b')).toBe(false);
  });

  it('mutating clone does not affect original', () => {
    const bag = new PropertyBag([['bits', 8]]);
    const clone = bag.clone();
    clone.set('bits', 16);
    expect(bag.get<number>('bits')).toBe(8);
    expect(clone.get<number>('bits')).toBe(16);
  });

  it('mutating original does not affect clone', () => {
    const bag = new PropertyBag([['bits', 8]]);
    const clone = bag.clone();
    bag.set('bits', 32);
    expect(clone.get<number>('bits')).toBe(8);
  });

  it('array values are deeply cloned (not shared)', () => {
    const original = [1, 2, 3];
    const bag = new PropertyBag([['data', original]]);
    const clone = bag.clone();
    const clonedArray = clone.get<number[]>('data');
    clonedArray.push(4);
    expect(bag.get<number[]>('data')).toEqual([1, 2, 3]);
  });

  it('clone preserves bigint values', () => {
    const big = BigInt('123456789012345678');
    const bag = new PropertyBag([['val', big]]);
    const clone = bag.clone();
    expect(clone.get<bigint>('val')).toBe(big);
  });

  it('adding new key to clone does not affect original size', () => {
    const bag = new PropertyBag([['a', 1]]);
    const clone = bag.clone();
    clone.set('b', 2);
    expect(bag.size).toBe(1);
    expect(clone.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PropertyBag — entries iteration
// ---------------------------------------------------------------------------

describe('PropertyBag.entries', () => {
  it('iterates all entries', () => {
    const bag = new PropertyBag([
      ['alpha', 1],
      ['beta', 'two'],
    ]);
    const collected: [string, PropertyValue][] = [];
    for (const entry of bag.entries()) {
      collected.push(entry);
    }
    expect(collected).toHaveLength(2);
    expect(collected.map(([k]) => k).sort()).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: propertyBagToJson
// ---------------------------------------------------------------------------

describe('propertyBagToJson', () => {
  it('serializes number, string, boolean, array values', () => {
    const bag = new PropertyBag([
      ['bits', 8],
      ['label', 'OUT'],
      ['enabled', true],
      ['data', [0xAA, 0xBB]],
    ]);
    const serialized = propertyBagToJson(bag);
    expect(serialized['bits']).toBe(8);
    expect(serialized['label']).toBe('OUT');
    expect(serialized['enabled']).toBe(true);
    expect(serialized['data']).toEqual([0xAA, 0xBB]);
  });

  it('encodes bigint values as "0n<digits>"', () => {
    const big = BigInt('9007199254740993');
    const bag = new PropertyBag([['value', big]]);
    const serialized = propertyBagToJson(bag);
    expect(serialized['value']).toBe('0n9007199254740993');
  });

  it('serialized output contains only JSON-compatible types', () => {
    const bag = new PropertyBag([
      ['n', 1],
      ['s', 'x'],
      ['b', false],
    ]);
    const json = propertyBagToJson(bag);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
