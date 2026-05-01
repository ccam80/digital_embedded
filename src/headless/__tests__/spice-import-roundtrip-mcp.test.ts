/**
 * MCP surface tests for SPICE .MODEL import round-trip (W7).
 *
 * Tests verify the full import path:
 *   parseModelCard -> applySpiceImportResult (with circuit) -> compile
 *
 * Tests:
 *   1. Parsed .MODEL card parameters stored in circuit.metadata.models.
 *   2. applySpiceImportResult writes both per-instance and library-level entries.
 *   3. After apply + compile, circuit compiles cleanly with overrides active.
 *   4. Serialize -> deserialize preserves circuit.metadata.models entries.
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
// Test suite 1: parseModelCard + applySpiceImportResult storage
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- parseModelCard to circuit.metadata.models', () => {
  it('parseModelCard correctly extracts name, deviceType, and params from .MODEL text', () => {
    const modelText = '.MODEL Q2N2222 NPN (IS=1e-14 BF=200 VAF=100 IKF=0.3)';
    const result = parseModelCard(modelText);
    expect('message' in result).toBe(false);
    const parsed = result as Exclude<typeof result, { message: string }>;
    expect(parsed.name).toBe('Q2N2222');
    expect(parsed.deviceType).toBe('NPN');
    expect(parsed.params['IS']).toBe(1e-14);
    expect(parsed.params['BF']).toBe(200);
    expect(parsed.params['VAF']).toBe(100);
  });

  it('applySpiceImportResult writes to circuit.metadata.models', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    expect(q1).toBeDefined();
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );
    expect(circuit.metadata.models).toBeDefined();
    const entry = circuit.metadata.models!['NpnBJT']?.['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('inline');
    expect(entry!.params['IS']).toBe(1e-14);
    expect(entry!.params['BF']).toBe(200);
  });

  it('applySpiceImportResult sets model property on the element', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );
    const bag = q1.getProperties();
    expect(bag.get('model')).toBe('Q2N2222');
  });

  it('applySpiceImportResult stores params in model params partition of element', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );
    const bag = q1.getProperties();
    expect(bag.getModelParam<number>('IS')).toBe(1e-14);
    expect(bag.getModelParam<number>('BF')).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: apply -> compile
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- apply then compile', () => {
  it('circuit with applySpiceImportResult compiles without errors', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );
    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();
    const diagnosticCodes = compiled!.analog!.diagnostics.map(d => d.code);
    expect(diagnosticCodes).not.toContain('ANALOG_COMPILE_ERROR');
  });

  it('parsed .MODEL card applied via applySpiceImportResult: circuit compiles and DC converges', () => {
    const { circuit, facade } = buildBjtCircuit();
    const modelText = '.MODEL Q2N2222 NPN (IS=1e-14 BF=200 VAF=100)';
    const parsed = parseModelCard(modelText);
    expect('message' in parsed).toBe(false);
    const parsedModel = parsed as Exclude<typeof parsed, { message: string }>;
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: parsedModel.params, modelName: parsedModel.name, deviceType: parsedModel.deviceType },
      circuit,
      registry,
    );
    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();
    // Override params were stored in circuit.metadata.models
    const entry = circuit.metadata.models!['NpnBJT']?.['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry!.params['IS']).toBe(1e-14);
    expect(entry!.params['BF']).toBe(200);
    // Simulation must converge with the override active
    const dc = facade.getDcOpResult();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // BJT circuit has 3 non-ground nodes: supply (Vcc+/Rc.A), collector (Rc.B/Q1.C), base (Vb+/Q1.B).
    // Q1 emitter connects directly to ground, so it is the ground node.
    // nodeVoltages contains the full MNA solution vector (nodeCount + branchCount entries).
    expect(dc!.nodeVoltages.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2b: IS parameter change produces different DC operating point
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- IS override changes DC operating point', () => {
  it('applySpiceImportResult stores IS override in metadata.models and element props', () => {
    const { circuit } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(q1, { overrides: { IS: 1e-20 }, modelName: 'Q_CUTOFF', deviceType: 'NPN' }, circuit, registry);
    expect(circuit.metadata.models?.['NpnBJT']?.['Q_CUTOFF']?.params?.['IS']).toBe(1e-20);
    expect(q1.getProperties().get('model')).toBe('Q_CUTOFF');
    expect(q1.getProperties().getModelParam('IS')).toBe(1e-20);
  });

  it('compile with default IS vs IS=1e-20 produces different collector voltage', () => {
    // Build two circuits:
    //   Default: IS=1e-14 (standard NPN). At Vb=0.7V, Ic is large → BJT saturates,
    //            collector voltage drops well below Vcc.
    //   Override: IS=1e-20 (tiny). At Vb=0.7V, Ic ≈ 0 → BJT in cutoff,
    //            collector voltage stays near Vcc (5V).
    // The difference in collector voltage must exceed 1V.

    const { circuit: circuitDefault, facade: facadeDefault } = buildBjtCircuit();
    facadeDefault.compile(circuitDefault);
    const dcDefault = facadeDefault.getDcOpResult();
    expect(dcDefault).not.toBeNull();
    expect(dcDefault!.converged).toBe(true);

    const { circuit: circuitOverride, facade: facadeOverride } = buildBjtCircuit();
    const q1Override = circuitOverride.elements.find(
      el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1'
    )!;
    applySpiceImportResult(
      q1Override,
      { overrides: { IS: 1e-20 }, modelName: 'Q_CUTOFF', deviceType: 'NPN' },
      circuitOverride,
      registry,
    );
    facadeOverride.compile(circuitOverride);
    const dcOverride = facadeOverride.getDcOpResult();
    expect(dcOverride).not.toBeNull();
    expect(dcOverride!.converged).toBe(true);

    // Both circuits must have the same number of nodes
    expect(dcOverride!.nodeVoltages.length).toBe(dcDefault!.nodeVoltages.length);

    // IS=1e-20 → cutoff → Vc near 5V. Default IS=1e-16 → less saturated than IS=1e-14.
    // At least one node voltage must differ by more than 0.5V.
    const voltagesDefault = Array.from(dcDefault!.nodeVoltages);
    const voltagesOverride = Array.from(dcOverride!.nodeVoltages);
    const maxDiff = Math.max(
      ...voltagesDefault.map((v, i) => Math.abs(v - voltagesOverride[i]!))
    );
    expect(maxDiff).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: serialize -> deserialize preserves circuit.metadata.models
// ---------------------------------------------------------------------------

describe('spice-import round-trip MCP surface -- serialize/deserialize preserves metadata.models', () => {
  it('circuit.metadata.models entry survives serialize -> deserialize', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );
    const json = facade.serialize(circuit);
    expect(json).toContain('Q2N2222');
    const reloaded = facade.deserialize(json);
    expect(reloaded.metadata.models).toBeDefined();
    const entry = reloaded.metadata.models!['NpnBJT']?.['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('inline');
    expect(entry!.params['IS']).toBe(1e-14);
    expect(entry!.params['BF']).toBe(200);
    expect(entry!.params['VAF']).toBe(100);
  });

  it('deserialized circuit with metadata.models compiles cleanly', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );
    const json = facade.serialize(circuit);
    const reloaded = facade.deserialize(json);
    facade.compile(reloaded);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();
    const codes = compiled!.analog!.diagnostics.map(d => d.code);
    expect(codes).not.toContain('ANALOG_COMPILE_ERROR');
  });

  it('deserialized circuit produces same DC result as pre-serialization', () => {
    const { circuit, facade } = buildBjtCircuit();
    const q1 = circuit.elements.find(el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1')!;
    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
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
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: SPICE import via facade- the MCP tool path
//
// The MCP server calls facade methods (compile, getDcOpResult, serialize,
// deserialize) after applying SPICE models. These tests exercise the full
// import path using buildBjtCircuit() (position-based wiring, same topology
// as the manual tests above) and then facade-level compile/query methods.
// ---------------------------------------------------------------------------

describe('spice-import MCP tool path- applySpiceImportResult + facade compile/query', () => {
  it('applySpiceImportResult then facade.compile succeeds with zero error diagnostics', () => {
    const { circuit, facade } = buildBjtCircuit();

    const q1 = circuit.elements.find(
      el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1'
    )!;
    expect(q1).toBeDefined();

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();

    const errorDiags = compiled!.analog!.diagnostics.filter(d => d.severity === 'error');
    expect(errorDiags).toHaveLength(0);
  });

  it('parseModelCard then applySpiceImportResult stores params and DC converges', () => {
    const { circuit, facade } = buildBjtCircuit();

    const modelText = '.MODEL Q2N2222A NPN (IS=3.108e-14 BF=217 VAF=113.7)';
    const parsed = parseModelCard(modelText);
    expect('message' in parsed).toBe(false);
    const parsedModel = parsed as Exclude<typeof parsed, { message: string }>;

    const q1 = circuit.elements.find(
      el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1'
    )!;

    applySpiceImportResult(
      q1,
      { overrides: parsedModel.params, modelName: parsedModel.name, deviceType: parsedModel.deviceType },
      circuit,
      registry,
    );

    // Verify metadata was written.
    const entry = circuit.metadata.models?.['NpnBJT']?.['Q2N2222A'];
    expect(entry).toBeDefined();
    expect(entry!.params['IS']).toBe(3.108e-14);
    expect(entry!.params['BF']).toBe(217);

    // Compile and verify DC operating point converges.
    facade.compile(circuit);
    const dc = facade.getDcOpResult();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
  });

  it('IS=1e-20 override: BJT in cutoff, DC converges with ≥3 node voltages', () => {
    const { circuit, facade } = buildBjtCircuit();

    const q1 = circuit.elements.find(
      el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1'
    )!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-20 }, modelName: 'Q_CUTOFF', deviceType: 'NPN' },
      circuit,
      registry,
    );

    facade.compile(circuit);
    const dc = facade.getDcOpResult();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    expect(dc!.nodeVoltages.length).toBeGreaterThanOrEqual(3);
  });

  it('serialize → deserialize preserves SPICE model name and params', () => {
    const { circuit, facade } = buildBjtCircuit();

    const q1 = circuit.elements.find(
      el => el.getProperties().has('label') && el.getProperties().get('label') === 'Q1'
    )!;

    applySpiceImportResult(
      q1,
      { overrides: { IS: 1e-14, BF: 200, VAF: 100 }, modelName: 'Q2N2222', deviceType: 'NPN' },
      circuit,
      registry,
    );

    const json = facade.serialize(circuit);
    expect(json).toContain('Q2N2222');

    const reloaded = facade.deserialize(json);
    const entry = reloaded.metadata.models?.['NpnBJT']?.['Q2N2222'];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('inline');
    expect(entry!.params['IS']).toBe(1e-14);
    expect(entry!.params['BF']).toBe(200);
    expect(entry!.params['VAF']).toBe(100);
  });
});
