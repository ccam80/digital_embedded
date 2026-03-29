/**
 * Tests for .dts format schema, serializer, and deserializer.
 */

import { describe, it, expect } from 'vitest';
import { validateDtsDocument } from '../dts-schema.js';
import { serializeCircuit, serializeWithSubcircuits } from '../dts-serializer.js';
import { deserializeDts } from '../dts-deserializer.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { AbstractCircuitElement } from '../../core/element.js';
import { PropertyBag } from '../../core/properties.js';
import { ComponentRegistry, ComponentCategory } from '../../core/registry.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { Pin } from '../../core/pin.js';
import type { PropertyValue } from '../../core/properties.js';

// ---------------------------------------------------------------------------
// Minimal stub element for tests
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] {
    return [];
  }
  draw(_ctx: RenderContext): void {
    // no-op
  }
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
}

function makeElement(
  typeName: string,
  instanceId: string,
  x: number,
  y: number,
  props: Record<string, PropertyValue> = {},
): StubElement {
  const bag = new PropertyBag(Object.entries(props));
  return new StubElement(typeName, instanceId, { x, y }, 0, false, bag);
}

function makeRegistry(...typeNames: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of typeNames) {
    registry.register({
      name,
      typeId: -1,
      factory: (props: PropertyBag) =>
        new StubElement(name, `inst-${name}`, { x: 0, y: 0 }, 0, false, props),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: name,
      models: {
        digital: { executeFn: () => {} },
      },
    });
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('Validation', () => {
  it('accepts_format_dts', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).not.toThrow();
    const result = validateDtsDocument(doc);
    expect(result.format).toBe('dts');
    expect(result.version).toBe(1);
    expect(result.circuit.name).toBe('Test');
  });

  it('accepts_legacy_format_digb', () => {
    const doc = {
      format: 'digb',
      version: 1,
      circuit: { name: 'Legacy', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).not.toThrow();
    const result = validateDtsDocument(doc);
    // Normalized to 'dts'
    expect(result.format).toBe('dts');
  });

  it('rejects_unknown_format', () => {
    const doc = {
      format: 'foo',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"format" must be "dts"/);
  });

  it('missingFormat', () => {
    const doc = {
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/missing.*"format"/i);
  });

  it('wrongVersion', () => {
    const doc = {
      format: 'dts',
      version: 99,
      circuit: { name: 'Test', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/unsupported version/i);
  });

  it('missingCircuit', () => {
    const doc = {
      format: 'dts',
      version: 1,
    };
    expect(() => validateDtsDocument(doc)).toThrow(/missing.*"circuit"/i);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('Serialization', () => {
  it('round_trip_dts', () => {
    const registry = makeRegistry('In', 'Out');

    const circuit = new Circuit({ name: 'RoundTrip' });
    circuit.addElement(makeElement('In', 'id-1', 100, 200));
    circuit.addElement(makeElement('Out', 'id-2', 300, 200));
    circuit.addWire(new Wire({ x: 120, y: 200 }, { x: 280, y: 200 }));

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // New documents must have format: 'dts'
    expect(parsed['format']).toBe('dts');

    const { circuit: restored } = deserializeDts(json, registry);
    const json2 = serializeCircuit(restored);

    expect(json).toBe(json2);
    expect(restored.metadata.name).toBe('RoundTrip');
  });

  it('withSubcircuits', () => {
    const registry = makeRegistry('And', 'In', 'Out');

    const main = new Circuit({ name: 'Main' });
    main.addElement(makeElement('And', 'id-m', 0, 0));

    const sub1 = new Circuit({ name: 'Sub1' });
    sub1.addElement(makeElement('In', 'id-s1', 10, 10));

    const sub2 = new Circuit({ name: 'Sub2' });
    sub2.addElement(makeElement('Out', 'id-s2', 20, 20));

    const subcircuits = new Map<string, Circuit>([
      ['Sub1', sub1],
      ['Sub2', sub2],
    ]);

    const json = serializeWithSubcircuits(main, subcircuits);
    const { circuit: restoredMain, subcircuits: restoredSubs } = deserializeDts(json, registry);

    expect(restoredMain.metadata.name).toBe('Main');
    expect(restoredSubs.size).toBe(2);
    expect(restoredSubs.has('Sub1')).toBe(true);
    expect(restoredSubs.has('Sub2')).toBe(true);
    expect(restoredSubs.get('Sub1')!.metadata.name).toBe('Sub1');
    expect(restoredSubs.get('Sub2')!.metadata.name).toBe('Sub2');
  });

  it('noSubcircuits', () => {
    const circuit = new Circuit({ name: 'Standalone' });
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect('subcircuitDefinitions' in parsed).toBe(false);
  });

  it('preservesAllFields', () => {
    const registry = makeRegistry('ROM');

    const circuit = new Circuit({
      name: 'Full',
      description: 'A circuit with all fields',
      isGeneric: true,
    });

    const el = makeElement('ROM', 'id-rom', 50, 60, {
      label: 'myROM',
      bitWidth: 8,
      addrBits: 4,
      value: 255n,
    });
    circuit.addElement(el);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 10 }));

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.name).toBe('Full');
    expect(restored.metadata.description).toBe('A circuit with all fields');
    expect(restored.metadata.isGeneric).toBe(true);

    expect(restored.elements).toHaveLength(1);
    const restoredEl = restored.elements[0];
    expect(restoredEl.typeId).toBe('ROM');
    expect(restoredEl.getProperties().get('label')).toBe('myROM');
    expect(restoredEl.getProperties().get('bitWidth')).toBe(8);
    expect(restoredEl.getProperties().get('addrBits')).toBe(4);
    expect(restoredEl.getProperties().get('value')).toBe(255n);

    expect(restored.wires).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// namedParameterSets in DtsDocument
// ---------------------------------------------------------------------------

describe('namedParameterSets', () => {
  it('schema_accepts_namedParameterSets', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      namedParameterSets: {
        '1N4148': { deviceType: 'D', params: { IS: 2.52e-9, N: 1.752 } },
        '2N2222': { deviceType: 'NPN', params: { IS: 1.4e-14, BF: 300 } },
      },
    };
    expect(() => validateDtsDocument(doc)).not.toThrow();
    const result = validateDtsDocument(doc);
    expect(result.namedParameterSets).toBeDefined();
    expect(result.namedParameterSets!['1N4148'].deviceType).toBe('D');
    expect(result.namedParameterSets!['2N2222'].params['BF']).toBe(300);
  });

  it('schema_rejects_namedParameterSets_not_object', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      namedParameterSets: 'invalid',
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"namedParameterSets" must be an object/);
  });

  it('schema_rejects_entry_missing_deviceType', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      namedParameterSets: {
        '1N4148': { params: { IS: 2.52e-9 } },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/deviceType.*must be a string/);
  });

  it('schema_rejects_params_value_not_number', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      namedParameterSets: {
        '1N4148': { deviceType: 'D', params: { IS: 'not-a-number' } },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/params\["IS"\].*must be a number/);
  });

  it('roundtrip_namedParameterSets', () => {
    const registry = makeRegistry('In');
    const circuit = new Circuit({ name: 'SPICE' });
    circuit.metadata.namedParameterSets = {
      '1N4148': { deviceType: 'D', params: { IS: 2.52e-9, N: 1.752 } },
    };

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['namedParameterSets']).toBeDefined();

    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.namedParameterSets).toBeDefined();
    expect(restored.metadata.namedParameterSets!['1N4148'].deviceType).toBe('D');
    expect(restored.metadata.namedParameterSets!['1N4148'].params['IS']).toBe(2.52e-9);
    expect(restored.metadata.namedParameterSets!['1N4148'].params['N']).toBe(1.752);
  });

  it('absent_namedParameterSets_not_serialized', () => {
    const circuit = new Circuit({ name: 'NoModels' });
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect('namedParameterSets' in parsed).toBe(false);

    const registry = makeRegistry();
    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.namedParameterSets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// modelDefinitions in DtsDocument
// ---------------------------------------------------------------------------

describe('modelDefinitions', () => {
  it('schema_accepts_modelDefinitions', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      modelDefinitions: {
        MYOPAMP: {
          name: 'MYOPAMP',
          elements: [],
          wires: [],
          attributes: { ports: '["INP","INN","OUT"]', elementCount: '5' },
        },
      },
    };
    expect(() => validateDtsDocument(doc)).not.toThrow();
    const result = validateDtsDocument(doc);
    expect(result.modelDefinitions).toBeDefined();
    expect(result.modelDefinitions!['MYOPAMP'].name).toBe('MYOPAMP');
  });

  it('schema_rejects_modelDefinitions_not_object', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      modelDefinitions: 42,
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"modelDefinitions" must be an object/);
  });

  it('roundtrip_modelDefinitions', () => {
    const registry = makeRegistry('In');
    const circuit = new Circuit({ name: 'WithModel' });
    circuit.metadata.modelDefinitions = {
      MYOPAMP: { ports: ['INP', 'INN', 'OUT'], elementCount: 5 },
    };

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['modelDefinitions']).toBeDefined();

    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.modelDefinitions).toBeDefined();
    const def = restored.metadata.modelDefinitions!['MYOPAMP'];
    expect(def.ports).toEqual(['INP', 'INN', 'OUT']);
    expect(def.elementCount).toBe(5);
  });

  it('absent_modelDefinitions_not_serialized', () => {
    const circuit = new Circuit({ name: 'NoModels' });
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect('modelDefinitions' in parsed).toBe(false);

    const registry = makeRegistry();
    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.modelDefinitions).toBeUndefined();
  });

  it('roundtrip_both_fields_together', () => {
    const registry = makeRegistry('In');
    const circuit = new Circuit({ name: 'BothFields' });
    circuit.metadata.namedParameterSets = {
      '2N2222': { deviceType: 'NPN', params: { BF: 200 } },
    };
    circuit.metadata.modelDefinitions = {
      RDIV: { ports: ['A', 'B'], elementCount: 2 },
    };

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.namedParameterSets!['2N2222'].params['BF']).toBe(200);
    expect(restored.metadata.modelDefinitions!['RDIV'].ports).toEqual(['A', 'B']);
    expect(restored.metadata.modelDefinitions!['RDIV'].elementCount).toBe(2);
  });
});
