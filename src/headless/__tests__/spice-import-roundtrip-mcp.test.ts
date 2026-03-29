/**
 * MCP surface tests for SPICE .MODEL import round-trip (W7).
 *
 * Tests verify the full import path:
 *   parseModelCard -> applySpiceImportResult (with circuit) -> compile
 *
 * Tests:
 *   1. Parsed .MODEL card parameters stored in circuit.metadata.namedParameterSets.
 *   2. applySpiceImportResult writes both per-instance and library-level entries.
 *   3. After apply + compile, circuit compiles cleanly with overrides active.
 *   4. Serialize -> deserialize preserves namedParameterSets entries.
 *   5. Deserialized circuit produces same DC result as before serialization.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyValue } from '../../core/properties.js';
import { pinWorldPosition } from '../../core/pin.js';
import { parseModelCard } from '../../solver/analog/model-parser.js';
import { applySpiceImportResult } from '../../app/spice-model-apply.js';

const registry = createDefaultRegistry();

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
// Test suite 1: parseModelCard + applySpiceImportResult storage
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- parseModelCard to namedParameterSets', () => {
  it('parseModelCard correctly extracts name, deviceType, and params from .MODEL text', () => {
    const modelText = '.MODEL Q2N2222 NPN (IS=1e-14 BF=200 VAF=100 IKF=0.3)';
    const result = parseModelCard(modelText);
    expect('message' in result).toBe(false);
    const parsed = result as Exclude<typeof result, { message: string }>;
    expect(parsed.name).toBe('Q2N2222');
    expect(parsed.deviceType).toBe('NPN');
    expect(parsed.params['IS']).toBeCloseTo(1e-14, 20);
    expect(parsed.params['BF']).toBe(200);
    expect(parsed.params['VAF']).toBe(100);
    expect(parsed.params['IKF']).toBeCloseTo(0.3, 5);
  });

  it('applySpiceImportResult writes to circuit.metadata.namedParameterSets', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    expect(q1).toBeDefined();
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    expect(circuit.metadata.namedParameterSets).toBeDefined();
    const entry = circuit.metadata.namedParameterSets!['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry.deviceType).toBe('NPN');
    expect(entry.params['IS']).toBeCloseTo(1e-14, 20);
    expect(entry.params['BF']).toBe(200);
  });

  it('applySpiceImportResult writes _spiceModelOverrides to the element', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    const bag = q1.getProperties();
    expect(bag.has('_spiceModelOverrides')).toBe(true);
    const stored = bag.get('_spiceModelOverrides') as Record<string, number>;
    expect(stored['IS']).toBeCloseTo(1e-14, 20);
    expect(stored['BF']).toBe(200);
  });

  it('applySpiceImportResult writes _spiceModelName to the element', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    const bag = q1.getProperties();
    expect(bag.has('_spiceModelName')).toBe(true);
    expect(bag.get('_spiceModelName')).toBe('Q2N2222');
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: apply -> compile
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- apply then compile', () => {
  it('circuit with applySpiceImportResult compiles without INVALID_SPICE_OVERRIDES', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();
    const diagnosticCodes = compiled!.analog!.diagnostics.map(d => d.code);
    expect(diagnosticCodes).not.toContain('INVALID_SPICE_OVERRIDES');
  });

  it('parsed .MODEL card applied via applySpiceImportResult: circuit compiles and DC converges', () => {
    const { circuit, facade } = buildBjtCircuit();
    const modelText = '.MODEL Q2N2222 NPN (IS=1e-14 BF=200 VAF=100)';
    const parsed = parseModelCard(modelText);
    expect('message' in parsed).toBe(false);
    const parsedModel = parsed as Exclude<typeof parsed, { message: string }>;
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: parsedModel.params, modelName: parsedModel.name, deviceType: parsedModel.deviceType },
      circuit,
    );
    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();
    // Override params were stored in namedParameterSets and element overrides
    expect(circuit.metadata.namedParameterSets!['Q2N2222'].params['IS']).toBeCloseTo(1e-14, 20);
    expect(circuit.metadata.namedParameterSets!['Q2N2222'].params['BF']).toBe(200);
    // Simulation must converge with the override active
    const dc = facade.getDcOpResult();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // BJT circuit has 4 non-ground nodes: Vcc+, Vb+, Rc midpoint (collector), and emitter
    expect(dc!.nodeVoltages.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: serialize -> deserialize preserves namedParameterSets
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- serialize/deserialize preserves namedParameterSets', () => {
  it('namedParameterSets entry survives serialize -> deserialize', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    const json = facade.serialize(circuit);
    expect(json).toContain('Q2N2222');
    expect(json).toContain('namedParameterSets');
    const reloaded = facade.deserialize(json);
    expect(reloaded.metadata.namedParameterSets).toBeDefined();
    const entry = reloaded.metadata.namedParameterSets!['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry.deviceType).toBe('NPN');
    expect(entry.params['IS']).toBeCloseTo(1e-14, 20);
    expect(entry.params['BF']).toBe(200);
    expect(entry.params['VAF']).toBe(100);
  });

  it('deserialized circuit with namedParameterSets compiles cleanly', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    const json = facade.serialize(circuit);
    const reloaded = facade.deserialize(json);
    facade.compile(reloaded);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();
    const codes = compiled!.analog!.diagnostics.map(d => d.code);
    expect(codes).not.toContain('INVALID_SPICE_OVERRIDES');
  });

  it('deserialized circuit produces same DC result as pre-serialization', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
    );
    facade.compile(circuit);
    const dcOriginal = facade.getDcOpResult();
    expect(dcOriginal).not.toBeNull();
    expect(dcOriginal!.converged).toBe(true);
    const voltagesOriginal = Array.from(dcOriginal!.nodeVoltages);
    const json = facade.serialize(circuit);
    const reloaded = facade.deserialize(json);
    facade.compile(reloaded);
    const dcReloaded = facade.getDcOpResult();
    expect(dcReloaded).not.toBeNull();
    expect(dcReloaded!.converged).toBe(true);
    const voltagesReloaded = Array.from(dcReloaded!.nodeVoltages);
    expect(voltagesReloaded.length).toBe(voltagesOriginal.length);
    for (let i = 0; i < voltagesOriginal.length; i++) {
      expect(voltagesReloaded[i]).toBeCloseTo(voltagesOriginal[i]!, 6);
    }
  });
});
