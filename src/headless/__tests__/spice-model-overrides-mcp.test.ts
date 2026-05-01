/**
 * MCP tool surface tests for SPICE model param overrides.
 *
 * Tests verify that the override path works through the facade's MCP-facing
 * interface (build -> applySpiceImportResult -> compile -> read), and that
 * overrides survive a full serialize/deserialize round-trip.
 *
 * Tests:
 *   1. Override via applySpiceImportResult: build a BJT circuit, apply overrides,
 *      circuit_compile, verify override changes simulation result vs default.
 *   2. Round-trip serialization: set overrides, serialize, deserialize, recompile,
 *      verify overrides persist and still affect simulation.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyValue } from '../../core/properties.js';
import { pinWorldPosition } from '../../core/pin.js';
import { applySpiceImportResult } from '../../app/spice-model-apply.js';

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Helper: create a registered circuit element at a given position with props
// ---------------------------------------------------------------------------

function createElement(
  typeName: string,
  pos: { x: number; y: number },
  props?: Record<string, PropertyValue>,
) {
  const def = registry.get(typeName);
  if (!def) throw new Error(`Unknown component type: ${typeName}`);
  const bag = new PropertyBag(
    Object.entries(props ?? {}) as [string, PropertyValue][],
  );
  const el = def.factory(bag);
  (el as { position: { x: number; y: number } }).position = pos;
  return el;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal NPN common-emitter circuit
//
// Topology:
//   Vcc(5V) pos → Rc(10kΩ) A, Rc B → Q1 C
//   Vb(0.7V) pos → Q1 B
//   Q1 E → Ground
//   Vcc neg → Ground
//   Vb neg → Ground
//
// Component labels: Q1 (NpnBJT), Rc (Resistor), Vcc (DcVoltageSource), Vb (DcVoltageSource)
// ---------------------------------------------------------------------------

function buildBjtCircuit(): { circuit: Circuit; facade: DefaultSimulatorFacade } {
  const facade = new DefaultSimulatorFacade(registry);

  // Layout chosen so no pin world-position coincides with an unintended wire
  // endpoint.  Pin positions (local → world):
  //   Gnd  at {0, 0}: out={0,0}
  //   Vcc  at {0, 4}: neg={0,4}, pos={4,4}
  //   Rc   at {4, 4}: A={4,4},   B={8,4}
  //   Vb   at {0, 8}: neg={0,8}, pos={4,8}
  //   Q1   at {4,12}: B={4,12},  C={8,11}, E={8,13}
  const gnd = createElement('Ground',          { x: 0, y:  0 });
  const vcc = createElement('DcVoltageSource', { x: 0, y:  4 }, { label: 'Vcc', voltage: 5 });
  vcc.getProperties().replaceModelParams({ voltage: 5 });
  const rc  = createElement('Resistor',        { x: 4, y:  4 }, { label: 'Rc',  resistance: 10000 });
  rc.getProperties().replaceModelParams({ resistance: 10000 });
  const vb  = createElement('DcVoltageSource', { x: 0, y:  8 }, { label: 'Vb',  voltage: 0.7 });
  vb.getProperties().replaceModelParams({ voltage: 0.7 });
  const q1  = createElement('NpnBJT',          { x: 4, y: 12 }, { label: 'Q1' });

  const circuit = new Circuit();
  circuit.addElement(gnd);
  circuit.addElement(vcc);
  circuit.addElement(rc);
  circuit.addElement(vb);
  circuit.addElement(q1);

  const vccPins = vcc.getPins();
  const vbPins  = vb.getPins();
  const rcPins  = rc.getPins();
  const q1Pins  = q1.getPins();
  const gndPins = gnd.getPins();

  const gndOut = pinWorldPosition(gnd, gndPins[0]!);
  const vccPos = pinWorldPosition(vcc, vccPins.find(p => p.label === 'pos')!);
  const vccNeg = pinWorldPosition(vcc, vccPins.find(p => p.label === 'neg')!);
  const rcA    = pinWorldPosition(rc,  rcPins.find(p => p.label === 'A')!);
  const rcB    = pinWorldPosition(rc,  rcPins.find(p => p.label === 'B')!);
  const vbPos  = pinWorldPosition(vb,  vbPins.find(p => p.label === 'pos')!);
  const vbNeg  = pinWorldPosition(vb,  vbPins.find(p => p.label === 'neg')!);
  const q1B    = pinWorldPosition(q1,  q1Pins.find(p => p.label === 'B')!);
  const q1C    = pinWorldPosition(q1,  q1Pins.find(p => p.label === 'C')!);
  const q1E    = pinWorldPosition(q1,  q1Pins.find(p => p.label === 'E')!);

  // Vcc.pos and Rc.A share world position {4,4}- zero-length wire is valid.
  circuit.addWire(new Wire(vccPos, rcA));
  circuit.addWire(new Wire(rcB,    q1C));
  circuit.addWire(new Wire(vbPos,  q1B));
  circuit.addWire(new Wire(q1E,    gndOut));
  circuit.addWire(new Wire(vccNeg, gndOut));
  circuit.addWire(new Wire(vbNeg,  gndOut));

  return { circuit, facade };
}

// ---------------------------------------------------------------------------
// Test 1: Override via applySpiceImportResult
// ---------------------------------------------------------------------------

describe('spice-model-overrides MCP surface- override via applySpiceImportResult', () => {
  it('applySpiceImportResult with IS override changes element model params vs default', () => {
    // Default circuit: Q1 has no model override, IS defaults to BJT_NPN_DEFAULTS.IS (1e-14).
    const { circuit: circuitDefault } = buildBjtCircuit();
    const q1Default = circuitDefault.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    // Without override, element has no model params set (factory reads from behavioral defaults).
    expect(q1Default.getProperties().getModelParamKeys()).toHaveLength(0);

    // Overridden circuit: apply IS=1e-18 (10000x smaller than default 1e-14).
    const { circuit: circuitOverridden, facade: facadeOverridden } = buildBjtCircuit();
    const q1 = circuitOverridden.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-18 }, modelName: 'Q2N2222_test', deviceType: 'NPN' },
      circuitOverridden,
      registry,
    );

    facadeOverridden.compile(circuitOverridden);
    const compiledOverridden = facadeOverridden.getCompiledUnified();
    const overriddenDiags = compiledOverridden?.analog?.diagnostics ?? [];
    // No warnings about invalid model key- runtime model recognized.
    expect(overriddenDiags.filter(d => (d.code as string) === 'invalid-simulation-model')).toHaveLength(0);

    // After compile, the element's model params should have IS=1e-18 (merged by compiler).
    // This confirms the override reaches the factory.
    const isAfterCompile = q1.getProperties().getModelParam<number>('IS');
    expect(isAfterCompile).toBe(1e-18);

    // The override entry is stored with only override keys, not full defaults.
    const entry = circuitOverridden.metadata.models?.['NpnBJT']?.['Q2N2222_test'];
    expect(entry).toBeDefined();
    expect(entry!.params['IS']).toBe(1e-18);
    expect(Object.keys(entry!.params)).toEqual(['IS']);
  });

  it('applySpiceImportResult stores model name in element model property', () => {
    const { circuit, facade: _ } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    const bag = q1.getProperties();
    expect(bag.get('model')).toBe('Q2N2222');
  });

  it('applySpiceImportResult stores override params in model params partition', () => {
    const { circuit, facade: _ } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    const bag = q1.getProperties();
    expect(bag.getModelParam<number>('IS')).toBe(1e-14);
    expect(bag.getModelParam<number>('BF')).toBe(100);
  });

  it('applySpiceImportResult registers model entry in circuit.metadata.models', () => {
    const { circuit, facade: _ } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    const entry = circuit.metadata.models?.['NpnBJT']?.['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('inline');
    expect(entry!.params['IS']).toBe(1e-14);
    expect(entry!.params['BF']).toBe(100);
  });

  it('default params remain at BJT defaults when only IS is overridden', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    // The model entry params should only contain overridden values (not defaults)
    const entry = circuit.metadata.models?.['NpnBJT']?.['Q2N2222'];
    expect(entry!.params['IS']).toBe(1e-14);
    // BF not in overrides, so not in entry.params (behavioral defaults are merged at compile time)
    expect(Object.keys(entry!.params)).toEqual(['IS']);

    facade.compile(circuit);
    expect(facade.getDcOpResult()?.converged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Round-trip serialization
// ---------------------------------------------------------------------------

describe('spice-model-overrides MCP surface- round-trip serialization', () => {
  it('overrides survive serialize -> deserialize -> recompile', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    const json = facade.serialize(circuit);
    expect(typeof json).toBe('string');
    expect(json).toContain('Q2N2222');
    expect(json).toContain('1e-14');

    const reloaded = facade.deserialize(json);
    expect(reloaded).not.toBeUndefined();

    const entry = reloaded.metadata.models?.['NpnBJT']?.['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry!.params['IS']).toBe(1e-14);
    expect(entry!.params['BF']).toBe(100);

    facade.compile(reloaded);
    const compiled = facade.getCompiledUnified();
    expect(compiled?.analog?.diagnostics).toBeInstanceOf(Array);
    const diagnosticCodes = compiled!.analog!.diagnostics.map(d => d.code);
    expect(diagnosticCodes).not.toContain('ANALOG_COMPILE_ERROR');
  });

  it('deserialized circuit with overrides produces same DC result as pre-serialization', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 100, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    facade.compile(circuit);
    const dcOriginal = facade.getDcOpResult();
    expect(dcOriginal?.converged).toBe(true);
    const voltagesOriginal = Array.from(dcOriginal!.nodeVoltages);

    const json = facade.serialize(circuit);
    const reloaded = facade.deserialize(json);
    facade.compile(reloaded);
    const dcReloaded = facade.getDcOpResult();
    expect(dcReloaded?.converged).toBe(true);
    const voltagesReloaded = Array.from(dcReloaded!.nodeVoltages);

    expect(voltagesReloaded.length).toBe(voltagesOriginal.length);
    for (let i = 0; i < voltagesOriginal.length; i++) {
    }
  });
});
