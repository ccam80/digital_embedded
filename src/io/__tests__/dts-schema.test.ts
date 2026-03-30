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
// Old-format field rejection
// ---------------------------------------------------------------------------

describe('old_format_field_rejection', () => {
  it('rejects_namedParameterSets_field', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      namedParameterSets: {
        '1N4148': { deviceType: 'D', params: { IS: 2.52e-9 } },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"namedParameterSets" is an obsolete field/);
  });

  it('rejects_modelDefinitions_field', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      modelDefinitions: {
        MYOPAMP: {
          ports: ['INP', 'OUT'],
          elements: [],
          internalNetCount: 0,
          netlist: [],
        },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"modelDefinitions" is an obsolete field/);
  });

  it('rejects_subcircuitBindings_field', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      subcircuitBindings: { 'el-1': 'MyModel' },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"subcircuitBindings" is an obsolete field/);
  });
});

// ---------------------------------------------------------------------------
// models field in DtsDocument
// ---------------------------------------------------------------------------

describe('models_field', () => {
  it('schema_accepts_inline_models_entry', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      models: {
        NpnBJT: {
          '2N2222': { kind: 'inline', params: { BF: 200, IS: 1.4e-14 } },
        },
      },
    };
    expect(() => validateDtsDocument(doc)).not.toThrow();
    const result = validateDtsDocument(doc);
    expect(result.models).toBeDefined();
    const entry = result.models!['NpnBJT']['2N2222'];
    expect(entry.kind).toBe('inline');
    expect(entry.params['BF']).toBe(200);
  });

  it('schema_rejects_models_not_object', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      models: 'invalid',
    };
    expect(() => validateDtsDocument(doc)).toThrow(/"models" must be an object/);
  });

  it('schema_rejects_entry_with_invalid_kind', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      models: {
        NpnBJT: {
          '2N2222': { kind: 'unknown', params: {} },
        },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/kind.*must be "inline" or "netlist"/);
  });

  it('schema_rejects_entry_params_not_object', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      models: {
        NpnBJT: {
          '2N2222': { kind: 'inline', params: 'bad' },
        },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/\.params.*must be an object/);
  });

  it('schema_rejects_entry_params_value_not_number', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      models: {
        NpnBJT: {
          '2N2222': { kind: 'inline', params: { BF: 'bad' } },
        },
      },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/params\["BF"\].*must be a number/);
  });

  it('absent_models_not_serialized', () => {
    const circuit = new Circuit({ name: 'NoModels' });
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect('models' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mirror round-trip tests
// ---------------------------------------------------------------------------

describe('mirror', () => {
  it('serializes_mirror_true_when_set', () => {
    const circuit = new Circuit({ name: 'MirrorTest' });
    const el = makeElement('In', 'id-1', 100, 200);
    el.mirror = true;
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const elements = (parsed['circuit'] as Record<string, unknown>)['elements'] as Array<Record<string, unknown>>;

    expect(elements[0]['mirror']).toBe(true);
  });

  it('deserializes_mirror_true', () => {
    const registry = makeRegistry('In');
    const circuit = new Circuit({ name: 'MirrorTest' });
    const el = makeElement('In', 'id-1', 100, 200);
    el.mirror = true;
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.elements[0].mirror).toBe(true);
  });

  it('omits_mirror_field_when_false', () => {
    const circuit = new Circuit({ name: 'NoMirrorTest' });
    const el = makeElement('In', 'id-1', 100, 200);
    el.mirror = false;
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const elements = (parsed['circuit'] as Record<string, unknown>)['elements'] as Array<Record<string, unknown>>;

    expect('mirror' in elements[0]).toBe(false);
  });

  it('defaults_mirror_to_false_when_absent', () => {
    const registry = makeRegistry('In');
    const doc = {
      format: 'dts',
      version: 1,
      circuit: {
        name: 'DefaultMirror',
        elements: [
          {
            type: 'In',
            id: 'id-1',
            position: { x: 0, y: 0 },
            rotation: 0,
            properties: {},
          },
        ],
        wires: [],
      },
    };

    const { circuit } = deserializeDts(JSON.stringify(doc), registry);

    expect(circuit.elements[0].mirror).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// measurementOrdering round-trip tests
// ---------------------------------------------------------------------------

describe('measurementOrdering', () => {
  it('serializes_measurementOrdering_when_non_empty', () => {
    const circuit = new Circuit({ name: 'OrdTest' });
    circuit.metadata.measurementOrdering = ['probe1', 'probe2'];

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const circ = parsed['circuit'] as Record<string, unknown>;

    expect(circ['measurementOrdering']).toEqual(['probe1', 'probe2']);
  });

  it('deserializes_measurementOrdering', () => {
    const registry = makeRegistry();
    const circuit = new Circuit({ name: 'OrdTest' });
    circuit.metadata.measurementOrdering = ['probe1', 'probe2'];

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.measurementOrdering).toEqual(['probe1', 'probe2']);
  });

  it('omits_measurementOrdering_when_empty', () => {
    const circuit = new Circuit({ name: 'EmptyOrd' });
    // measurementOrdering defaults to []

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const circ = parsed['circuit'] as Record<string, unknown>;

    expect('measurementOrdering' in circ).toBe(false);
  });

  it('defaults_measurementOrdering_to_empty_when_absent', () => {
    const registry = makeRegistry();
    const doc = {
      format: 'dts',
      version: 1,
      circuit: {
        name: 'NoOrd',
        elements: [],
        wires: [],
      },
    };

    const { circuit } = deserializeDts(JSON.stringify(doc), registry);

    expect(circuit.metadata.measurementOrdering).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parity: mirror + measurementOrdering together
// ---------------------------------------------------------------------------

describe('mirror_and_measurementOrdering_parity', () => {
  it('round_trips_both_fields_together', () => {
    const registry = makeRegistry('In');
    const circuit = new Circuit({ name: 'Parity' });
    circuit.metadata.measurementOrdering = ['out1', 'out2'];

    const el = makeElement('In', 'id-1', 50, 50);
    el.mirror = true;
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.measurementOrdering).toEqual(['out1', 'out2']);
    expect(restored.elements[0].mirror).toBe(true);
  });
});
