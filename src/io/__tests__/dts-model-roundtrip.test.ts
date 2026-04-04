/**
 * Round-trip tests for the .dts model serialization system.
 *
 * Covers: circuit.metadata.models serialization/deserialization, per-element
 * modelParamDeltas round-trip, and rejection of old-format fields.
 */

import { describe, it, expect } from 'vitest';
import { serializeCircuit } from '../dts-serializer.js';
import { deserializeDts } from '../dts-deserializer.js';
import { Circuit } from '../../core/circuit.js';
import { PropertyBag } from '../../core/properties.js';
import { ComponentRegistry, ComponentCategory } from '../../core/registry.js';
import type { ModelEntry } from '../../core/registry.js';
import type { PropertyValue } from '../../core/properties.js';
import {
  BJT_MODEL_ENTRY,
  BJT_PARAM_DEFS,
  STUB_ANALOG_FACTORY,
} from '../../test-fixtures/model-fixtures.js';
import { TestElement } from '../../test-fixtures/test-element.js';

function makeElement(
  typeName: string,
  instanceId: string,
  props: Record<string, PropertyValue> = {},
): TestElement {
  const bag = new PropertyBag(Object.entries(props));
  return new TestElement(typeName, instanceId, { x: 0, y: 0 }, [], bag);
}

function makeBjtRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register({
    name: 'NpnBJT',
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement('NpnBJT', 'inst-NpnBJT', { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.SEMICONDUCTORS,
    helpText: 'NPN BJT',
    models: { digital: undefined as never },
    modelRegistry: {
      behavioral: BJT_MODEL_ENTRY,
    },
  });
  return registry;
}

// ---------------------------------------------------------------------------
// Round-trip: circuit.metadata.models
// ---------------------------------------------------------------------------

describe('models_roundtrip', () => {
  it('roundtrip_inline_model_entry_preserves_params', () => {
    const registry = makeBjtRegistry();
    const circuit = new Circuit({ name: 'BJT Circuit' });

    const modelEntry2N2222: ModelEntry = {
      kind: 'inline',
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: { BF: 200, IS: 1.4e-14, NF: 1, BR: 1, VAF: 100 },
    };

    circuit.metadata.models = {
      NpnBJT: {
        '2N2222': modelEntry2N2222,
      },
    };

    const json = serializeCircuit(circuit);
    const restored = deserializeDts(json, registry);

    const entry = restored.metadata.models!['NpnBJT']['2N2222'];
    expect(entry.kind).toBe('inline');
    expect(entry.params['BF']).toBe(200);
  });

  it('serialized_inline_entry_strips_factory', () => {
    const circuit = new Circuit({ name: 'BJT Circuit' });
    circuit.metadata.models = {
      NpnBJT: {
        '2N2222': {
          kind: 'inline',
          factory: STUB_ANALOG_FACTORY,
          paramDefs: BJT_PARAM_DEFS,
          params: { BF: 200, IS: 1e-14 },
        },
      },
    };

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const serializedEntry = (
      (parsed['models'] as Record<string, unknown>)['NpnBJT'] as Record<string, unknown>
    )['2N2222'] as Record<string, unknown>;

    expect(serializedEntry['kind']).toBe('inline');
    expect(serializedEntry['params']).toEqual({ BF: 200, IS: 1e-14 });
    expect('factory' in serializedEntry).toBe(false);
    expect('paramDefs' in serializedEntry).toBe(false);
  });

  it('absent_models_not_serialized', () => {
    const circuit = new Circuit({ name: 'NoModels' });
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect('models' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: per-element modelParamDeltas
// ---------------------------------------------------------------------------

describe('element_modelParamDeltas_roundtrip', () => {
  it('roundtrip_element_with_delta_BF_250', () => {
    const registry = makeBjtRegistry();
    const circuit = new Circuit({ name: 'BJT Delta' });

    const baseParams = { BF: 200, IS: 1.4e-14, NF: 1, BR: 1, VAF: 100 };

    const modelEntry2N2222: ModelEntry = {
      kind: 'inline',
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: baseParams,
    };

    circuit.metadata.models = {
      NpnBJT: {
        '2N2222': modelEntry2N2222,
      },
    };

    const el = makeElement('NpnBJT', 'q1', { model: '2N2222' });
    el.getProperties().replaceModelParams({ ...baseParams, BF: 250 });
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const restored = deserializeDts(json, registry);

    expect(restored.elements).toHaveLength(1);
    const restoredEl = restored.elements[0];
    expect(restoredEl.getProperties().getModelParam<number>('BF')).toBe(250);
  });

  it('delta_only_saves_modified_params', () => {
    const circuit = new Circuit({ name: 'BJT Delta' });

    const modelEntry2N2222: ModelEntry = {
      kind: 'inline',
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: { BF: 200, IS: 1e-14, NF: 1 },
    };

    circuit.metadata.models = {
      NpnBJT: {
        '2N2222': modelEntry2N2222,
      },
    };

    const el = makeElement('NpnBJT', 'q1', { model: '2N2222' });
    el.getProperties().replaceModelParams({ BF: 250, IS: 1e-14, NF: 1 });
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const elements = (
      (parsed['circuit'] as Record<string, unknown>)['elements'] as Array<Record<string, unknown>>
    );
    const deltas = elements[0]['modelParamDeltas'] as Record<string, unknown>;

    expect(deltas['model']).toBe('2N2222');
    const params = deltas['params'] as Record<string, number>;
    expect(params['BF']).toBe(250);
    expect('IS' in params).toBe(false);
    expect('NF' in params).toBe(false);
  });

  it('no_modelParamDeltas_when_no_model_set', () => {
    const circuit = new Circuit({ name: 'NoModel' });
    const el = makeElement('NpnBJT', 'q1');
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const elements = (
      (parsed['circuit'] as Record<string, unknown>)['elements'] as Array<Record<string, unknown>>
    );

    expect('modelParamDeltas' in elements[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Crash test: old-format fields
// ---------------------------------------------------------------------------

describe('old_format_crash', () => {
  it('throws_on_namedParameterSets_field', () => {
    const registry = makeBjtRegistry();
    const doc = JSON.stringify({
      format: 'dts',
      version: 1,
      circuit: { name: 'Test', elements: [], wires: [] },
      namedParameterSets: {
        '2N2222': { deviceType: 'NPN', params: { BF: 200 } },
      },
    });

    expect(() => deserializeDts(doc, registry)).toThrow(/"namedParameterSets" is an obsolete field/);
  });
});
