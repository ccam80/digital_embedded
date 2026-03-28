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
// validate::validDocument
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('validDocument', () => {
    const doc = {
      format: 'dts',
      version: 1,
      circuit: {
        name: 'Test',
        elements: [],
        wires: [],
      },
    };
    expect(() => validateDtsDocument(doc)).not.toThrow();
    const result = validateDtsDocument(doc);
    expect(result.format).toBe('dts');
    expect(result.version).toBe(1);
    expect(result.circuit.name).toBe('Test');
  });

  // -------------------------------------------------------------------------
  // validate::missingFormat
  // -------------------------------------------------------------------------

  it('missingFormat', () => {
    const doc = {
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/missing.*"format"/i);
  });

  // -------------------------------------------------------------------------
  // validate::wrongVersion
  // -------------------------------------------------------------------------

  it('wrongVersion', () => {
    const doc = {
      format: 'dts',
      version: 99,
      circuit: { name: 'Test', elements: [], wires: [] },
    };
    expect(() => validateDtsDocument(doc)).toThrow(/unsupported version/i);
  });

  // -------------------------------------------------------------------------
  // validate::missingCircuit
  // -------------------------------------------------------------------------

  it('missingCircuit', () => {
    const doc = {
      format: 'dts',
      version: 1,
    };
    expect(() => validateDtsDocument(doc)).toThrow(/missing.*"circuit"/i);
  });
});

// ---------------------------------------------------------------------------
// serialize::roundTrip
// ---------------------------------------------------------------------------

describe('serialize', () => {
  it('roundTrip', () => {
    const registry = makeRegistry('In', 'Out');

    const circuit = new Circuit({ name: 'RoundTrip' });
    circuit.addElement(makeElement('In', 'id-1', 100, 200));
    circuit.addElement(makeElement('Out', 'id-2', 300, 200));
    circuit.addWire(new Wire({ x: 120, y: 200 }, { x: 280, y: 200 }));

    const json1 = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json1, registry);
    const json2 = serializeCircuit(restored);

    expect(json1).toBe(json2);
  });

  // -------------------------------------------------------------------------
  // serialize::withSubcircuits
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // serialize::noSubcircuits
  // -------------------------------------------------------------------------

  it('noSubcircuits', () => {
    const circuit = new Circuit({ name: 'Standalone' });
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect('subcircuitDefinitions' in parsed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // serialize::preservesAllFields
  // -------------------------------------------------------------------------

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
