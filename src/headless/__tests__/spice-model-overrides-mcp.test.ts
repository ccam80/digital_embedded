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
import { BJT_NPN_DEFAULTS } from '../../components/semiconductors/bjt.js';
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

  const vcc = createElement('DcVoltageSource', { x: 0, y: 0 },  { label: 'Vcc', voltage: 5 });
  const vb  = createElement('DcVoltageSource', { x: 8, y: 0 },  { label: 'Vb',  voltage: 0.7 });
  const rc  = createElement('Resistor',        { x: 4, y: 0 },  { label: 'Rc',  resistance: 10000 });
  const q1  = createElement('NpnBJT',          { x: 4, y: 8 },  { label: 'Q1' });
  const gnd = createElement('Ground',          { x: 4, y: 16 });

  const circuit = new Circuit();
  circuit.addElement(vcc);
  circuit.addElement(vb);
  circuit.addElement(rc);
  circuit.addElement(q1);
  circuit.addElement(gnd);

  const vccPins = vcc.getPins();
  const vbPins  = vb.getPins();
  const rcPins  = rc.getPins();
  const q1Pins  = q1.getPins();
  const gndPins = gnd.getPins();

  const vccPos = pinWorldPosition(vcc, vccPins.find(p => p.label === 'pos')!);
  const vccNeg = pinWorldPosition(vcc, vccPins.find(p => p.label === 'neg')!);
  const vbPos  = pinWorldPosition(vb,  vbPins.find(p => p.label === 'pos')!);
  const vbNeg  = pinWorldPosition(vb,  vbPins.find(p => p.label === 'neg')!);
  const rcA    = pinWorldPosition(rc,  rcPins.find(p => p.label === 'A')!);
  const rcB    = pinWorldPosition(rc,  rcPins.find(p => p.label === 'B')!);
  const q1B    = pinWorldPosition(q1,  q1Pins.find(p => p.label === 'B')!);
  const q1C    = pinWorldPosition(q1,  q1Pins.find(p => p.label === 'C')!);
  const q1E    = pinWorldPosition(q1,  q1Pins.find(p => p.label === 'E')!);
  const gndOut = pinWorldPosition(gnd, gndPins[0]!);

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

describe('spice-model-overrides MCP surface — override via applySpiceImportResult', () => {
  it('applySpiceImportResult with large IS override changes DC operating point vs default', () => {
    // Compile default circuit (no overrides)
    const { circuit: circuitDefault, facade: facadeDefault } = buildBjtCircuit();
    facadeDefault.compile(circuitDefault);
    const dcDefault = facadeDefault.getDcOpResult();
    expect(dcDefault?.converged).toBe(true);
    const voltagesDefault = Array.from(dcDefault!.nodeVoltages);

    // Build identical circuit, then apply IS override (1e-10 vs default 1e-16)
    const { circuit: circuitOverridden, facade: facadeOverridden } = buildBjtCircuit();
    const q1 = circuitOverridden.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-10 }, modelName: 'Q2N2222_test', deviceType: 'NPN' },
      circuitOverridden,
      registry,
    );

    facadeOverridden.compile(circuitOverridden);
    const dcOverridden = facadeOverridden.getDcOpResult();
    expect(dcOverridden?.converged).toBe(true);
    const voltagesOverridden = Array.from(dcOverridden!.nodeVoltages);

    // Same topology, same bias — only IS differs. Voltages must diverge.
    expect(voltagesOverridden.length).toBe(voltagesDefault.length);
    let anyDiffers = false;
    for (let i = 0; i < voltagesDefault.length; i++) {
      if (Math.abs(voltagesOverridden[i]! - voltagesDefault[i]!) > 1e-6) {
        anyDiffers = true;
        break;
      }
    }
    expect(anyDiffers).toBe(true);
  });

  it('applySpiceImportResult stores model name in element model property', () => {
    const { circuit, facade: _ } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;

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
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;

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
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;

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
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    // The model entry params should only contain overridden values
    const entry = circuit.metadata.models?.['NpnBJT']?.['Q2N2222'];
    expect(entry!.params['IS']).toBe(1e-14);
    // BF not in overrides, so not in entry.params (defaults come from component definition)
    expect(entry!.params['BF']).toBeUndefined();

    facade.compile(circuit);
    expect(facade.getDcOpResult()?.converged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Round-trip serialization
// ---------------------------------------------------------------------------

describe('spice-model-overrides MCP surface — round-trip serialization', () => {
  it('overrides survive serialize -> deserialize -> recompile', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;

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
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;

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
      expect(voltagesReloaded[i]).toBeCloseTo(voltagesOriginal[i]!, 6);
    }
  });
});
