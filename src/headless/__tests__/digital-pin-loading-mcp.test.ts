/**
 * MCP tool surface tests for digitalPinLoading circuit metadata (W6.1).
 *
 * Tests verify that `circuit_compile` respects the `digitalPinLoading` field
 * in circuit metadata when building a mixed digital/analog circuit via the
 * DefaultSimulatorFacade (the facade exposed through the MCP server).
 *
 * These tests use the real component registry (createDefaultRegistry) with
 * the `And` gate — a dual-model component (digital + mna behavioral) — placed
 * in an analog circuit alongside passive components.
 *
 * Tests:
 *   1. circuit_compile with digitalPinLoading="all" metadata: And gate (digital
 *      mode by default) gets inline bridge adapters.
 *   2. circuit_compile with digitalPinLoading="none": And in logical mode gets
 *      bridge adapters with rIn=Infinity on inputs and rOut=0 on outputs.
 *   3. circuit_compile with digitalPinLoading="cross-domain": And in logical
 *      mode gets bridge adapters with finite rIn.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyValue } from '../../core/properties.js';
import { pinWorldPosition } from '../../core/pin.js';
import { BridgeInputAdapter, BridgeOutputAdapter } from '../../solver/analog/bridge-adapter.js';

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
// Helper: build a mixed analog+digital circuit.
//
// The And gate has pins named `In_1`, `In_2` (inputs) and `out` (output).
// We wire it with a Resistor and DcVoltageSource to create a real analog
// partition. The And gate may be set to logical mode to force bridging.
//
// Topology:
//   Vs+ → R1.A, R1.B → And.In_1
//   Vs+ → And.In_2   (shared high rail)
//   And.out → Gnd
//   Vs- → Gnd
// ---------------------------------------------------------------------------

function buildAnalogAndCircuit(
  metadata: Partial<import('../../core/circuit.js').CircuitMetadata> = {},
  andProps: Record<string, PropertyValue> = {},
) {
  const circuit = new Circuit(metadata);

  const vs  = createElement('DcVoltageSource', { x: 0, y: 0 },  { label: 'Vs', voltage: 5 });
  const r1  = createElement('Resistor',        { x: 4, y: 0 },  { label: 'R1', resistance: 1000 });
  const and = createElement('And',             { x: 8, y: 0 },  { label: 'U1', ...andProps });
  const gnd = createElement('Ground',          { x: 0, y: 16 });

  circuit.addElement(vs);
  circuit.addElement(r1);
  circuit.addElement(and);
  circuit.addElement(gnd);

  const vsPins  = vs.getPins();
  const r1Pins  = r1.getPins();
  const andPins = and.getPins();
  const gndPins = gnd.getPins();

  const vsPos  = pinWorldPosition(vs,  vsPins.find(p => p.label === 'pos')!);
  const vsNeg  = pinWorldPosition(vs,  vsPins.find(p => p.label === 'neg')!);
  const r1A    = pinWorldPosition(r1,  r1Pins.find(p => p.label === 'A')!);
  const r1B    = pinWorldPosition(r1,  r1Pins.find(p => p.label === 'B')!);
  const andIn1 = pinWorldPosition(and, andPins.find(p => p.label === 'In_1')!);
  const andIn2 = pinWorldPosition(and, andPins.find(p => p.label === 'In_2')!);
  const andOut = pinWorldPosition(and, andPins.find(p => p.label === 'out')!);
  const gndOut = pinWorldPosition(gnd, gndPins[0]!);

  circuit.addWire(new Wire(vsPos,  r1A));
  circuit.addWire(new Wire(r1B,    andIn1));
  circuit.addWire(new Wire(vsPos,  andIn2));
  circuit.addWire(new Wire(andOut, gndOut));
  circuit.addWire(new Wire(vsNeg,  gndOut));

  return circuit;
}

// ---------------------------------------------------------------------------
// Test 1: digitalPinLoading="all" via circuit metadata
// ---------------------------------------------------------------------------

describe('digitalPinLoading MCP surface — mode all', () => {
  it('circuit_compile with digitalPinLoading="all" produces bridge adapters for the And gate', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit({ digitalPinLoading: "all" });

    facade.compile(circuit);

    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    const errors = compiled!.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);

    const totalAdapters = (compiled!.analog?.bridges ?? []).reduce(
      (n, b) => n + b.inputAdapters.length + b.outputAdapters.length,
      0,
    );
    expect(totalAdapters).toBeGreaterThan(0);
  });

  it('digitalPinLoading="all" produces more bridge adapters than cross-domain for same circuit', () => {
    const facadeAll   = new DefaultSimulatorFacade(registry);
    const facadeCross = new DefaultSimulatorFacade(registry);

    const circuitAll   = buildAnalogAndCircuit({ digitalPinLoading: "all" });
    const circuitCross = buildAnalogAndCircuit({ digitalPinLoading: "cross-domain" });

    facadeAll.compile(circuitAll);
    facadeCross.compile(circuitCross);

    const countAdapters = (facade: DefaultSimulatorFacade) => {
      const compiled = facade.getCompiledUnified();
      return (compiled?.analog?.bridges ?? []).reduce(
        (n, b) => n + b.inputAdapters.length + b.outputAdapters.length,
        0,
      );
    };

    expect(countAdapters(facadeAll)).toBeGreaterThan(countAdapters(facadeCross));
  });
});

// ---------------------------------------------------------------------------
// Test 2: digitalPinLoading="none" produces ideal bridge parameters
// ---------------------------------------------------------------------------

describe('digitalPinLoading MCP surface — mode none', () => {
  it('digitalPinLoading="none": And gate in logical mode gets rIn=Infinity on input adapters', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit(
      { digitalPinLoading: "none" },
      { simulationModel: "logical" },
    );

    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();

    const bridges = compiled!.analog!.bridges;
    expect(bridges.length).toBeGreaterThan(0);

    for (const bridge of bridges) {
      for (const adapter of bridge.inputAdapters) {
        expect((adapter as BridgeInputAdapter).rIn).toBe(Infinity);
      }
    }
  });

  it('digitalPinLoading="none": And gate in logical mode gets rOut=0 on output adapters', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit(
      { digitalPinLoading: "none" },
      { simulationModel: "logical" },
    );

    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();

    const bridges = compiled!.analog!.bridges;
    expect(bridges.length).toBeGreaterThan(0);

    for (const bridge of bridges) {
      for (const adapter of bridge.outputAdapters) {
        expect((adapter as BridgeOutputAdapter).rOut).toBe(0);
      }
    }
  });

  it('digitalPinLoading="cross-domain": And in logical mode gets finite rIn (not ideal)', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit(
      { digitalPinLoading: "cross-domain" },
      { simulationModel: "logical" },
    );

    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    expect(compiled!.analog).not.toBeNull();

    const bridges = compiled!.analog!.bridges;
    expect(bridges.length).toBeGreaterThan(0);

    for (const bridge of bridges) {
      for (const adapter of bridge.inputAdapters) {
        expect(isFinite((adapter as BridgeInputAdapter).rIn)).toBe(true);
      }
    }
  });
});
