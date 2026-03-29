/**
 * MCP tool surface tests for _spiceModelOverrides (P3.2).
 *
 * Tests verify that the override path works through the facade's MCP-facing
 * interface (build → patch → compile → read), and that overrides survive a
 * full serialize/deserialize round-trip.
 *
 * Tests:
 *   1. Override via MCP: build a BJT circuit, patch to set _spiceModelOverrides,
 *      circuit_compile, verify override changes simulation result vs default.
 *   2. Round-trip serialization: set overrides, serialize, deserialize, recompile,
 *      verify overrides persist and still affect simulation.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { BJT_NPN_DEFAULTS } from '../../solver/analog/model-defaults.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyValue } from '../../core/properties.js';
import { pinWorldPosition } from '../../core/pin.js';

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
//
// Placed with distinct positions so pin world positions don't collide.
// Wires connect by pin world position (analog topology resolution).
// ---------------------------------------------------------------------------

function buildBjtCircuit(): { circuit: Circuit; facade: DefaultSimulatorFacade } {
  const facade = new DefaultSimulatorFacade(registry);

  // Place components at distinct grid positions
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

  // Resolve pin world positions
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

  // Wire topology: VCC → Rc → Q1(C); Vb → Q1(B); Q1(E) → Gnd; negatives → Gnd
  circuit.addWire(new Wire(vccPos, rcA));
  circuit.addWire(new Wire(rcB,    q1C));
  circuit.addWire(new Wire(vbPos,  q1B));
  circuit.addWire(new Wire(q1E,    gndOut));
  circuit.addWire(new Wire(vccNeg, gndOut));
  circuit.addWire(new Wire(vbNeg,  gndOut));

  return { circuit, facade };
}

// ---------------------------------------------------------------------------
// Test 1: Override via MCP
//
// Use circuit_patch (op: 'set') to apply _spiceModelOverrides on Q1,
// then circuit_compile and verify:
//   a) compiled analog diagnostics do not include INVALID_SPICE_OVERRIDES
//   b) DC node voltages differ from those compiled without the override
// ---------------------------------------------------------------------------

describe('spice-model-overrides MCP surface — override via patch', () => {
  it('patch with _spiceModelOverrides changes DC operating point vs default', () => {
    // Compile the same circuit topology twice — once without overrides, once with.
    // The ONLY difference is the _spiceModelOverrides patch on Q1.
    const { circuit: circuitDefault, facade: facadeDefault } = buildBjtCircuit();

    facadeDefault.compile(circuitDefault);
    const compiledDefault = facadeDefault.getCompiledUnified();
    expect(compiledDefault?.analog?.diagnostics).toBeInstanceOf(Array);

    const dcDefault = facadeDefault.getDcOpResult();
    expect(dcDefault?.converged).toBe(true);
    const voltagesDefault = Array.from(dcDefault!.nodeVoltages);

    const baselineCodes = compiledDefault!.analog!.diagnostics.map(d => d.code);
    expect(baselineCodes).not.toContain('INVALID_SPICE_OVERRIDES');

    // Build an identical circuit, then apply override via patch
    const { circuit: circuitOverridden, facade: facadeOverridden } = buildBjtCircuit();

    // Override IS: default 1e-16, override to 1e-10 (1M× increase)
    facadeOverridden.patch(circuitOverridden, [
      { op: 'set', target: 'Q1', props: { _spiceModelOverrides: { IS: 1e-10 } } },
    ]);

    facadeOverridden.compile(circuitOverridden);
    const compiledOverridden = facadeOverridden.getCompiledUnified();
    expect(compiledOverridden?.analog?.diagnostics).toBeInstanceOf(Array);

    const overriddenCodes = compiledOverridden!.analog!.diagnostics.map(d => d.code);
    expect(overriddenCodes).not.toContain('INVALID_SPICE_OVERRIDES');

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

  it('patch with _spiceModelOverrides records the override in _spiceModelOverrides property', () => {
    const { circuit, facade } = buildBjtCircuit();

    // Apply IS override via patch
    const patchResult = facade.patch(circuit, [
      {
        op: 'set',
        target: 'Q1',
        props: { _spiceModelOverrides: { IS: 1e-14, BF: 100 } },
      },
    ]);

    // Patch must succeed without errors
    expect(patchResult.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

    // The Q1 element in the circuit must now have _spiceModelOverrides stored
    const q1Element = circuit.elements.find(el => {
      const bag = el.getProperties();
      return bag.has('label') && bag.get('label') === 'Q1';
    });
    expect(q1Element).not.toBeUndefined();

    const bag = q1Element!.getProperties();
    expect(bag.has('_spiceModelOverrides')).toBe(true);

    const stored = bag.get('_spiceModelOverrides') as Record<string, number>;
    expect(stored['IS']).toBe(1e-14);
    expect(stored['BF']).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Round-trip serialization
//
// Set overrides, serialize, deserialize, recompile — overrides must persist
// and the circuit must still compile without INVALID_SPICE_OVERRIDES.
// The DC node voltages after round-trip must match the pre-serialization result.
// ---------------------------------------------------------------------------

describe('spice-model-overrides MCP surface — round-trip serialization', () => {
  it('overrides survive serialize → deserialize → recompile', () => {
    const { circuit, facade } = buildBjtCircuit();

    // Apply _spiceModelOverrides
    facade.patch(circuit, [
      {
        op: 'set',
        target: 'Q1',
        props: { _spiceModelOverrides: { IS: 1e-14, BF: 100 } },
      },
    ]);

    const json = facade.serialize(circuit);
    expect(typeof json).toBe('string');
    expect(json).toContain('_spiceModelOverrides');
    expect(json).toContain('1e-14');

    // Deserialize and recompile (circuit_load equivalent)
    const reloaded = facade.deserialize(json);
    expect(reloaded).not.toBeUndefined();

    facade.compile(reloaded);
    const compiled = facade.getCompiledUnified();
    expect(compiled?.analog?.diagnostics).toBeInstanceOf(Array);

    // No INVALID_SPICE_OVERRIDES — JSON survived serialization intact
    const diagnosticCodes = compiled!.analog!.diagnostics.map(d => d.code);
    expect(diagnosticCodes).not.toContain('INVALID_SPICE_OVERRIDES');
  });

  it('deserialized circuit with overrides produces same DC result as pre-serialization', () => {
    const { circuit, facade } = buildBjtCircuit();

    facade.patch(circuit, [
      {
        op: 'set',
        target: 'Q1',
        props: { _spiceModelOverrides: { IS: 1e-14, BF: 100, VAF: 100 } },
      },
    ]);

    const json = facade.serialize(circuit);

    // Compile original and capture DC operating point
    facade.compile(circuit);
    const dcOriginal = facade.getDcOpResult();
    expect(dcOriginal?.converged).toBe(true);
    const voltagesOriginal = Array.from(dcOriginal!.nodeVoltages);

    // Deserialize and recompile (circuit_load + circuit_compile equivalent)
    const reloaded = facade.deserialize(json);
    facade.compile(reloaded);
    const dcReloaded = facade.getDcOpResult();
    expect(dcReloaded?.converged).toBe(true);
    const voltagesReloaded = Array.from(dcReloaded!.nodeVoltages);

    // Node voltage arrays must have the same length
    expect(voltagesReloaded.length).toBe(voltagesOriginal.length);

    // Every node voltage must match within floating-point tolerance
    for (let i = 0; i < voltagesOriginal.length; i++) {
      expect(voltagesReloaded[i]).toBeCloseTo(voltagesOriginal[i]!, 6);
    }
  });
});
