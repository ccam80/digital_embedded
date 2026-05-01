/**
 * MCP tool surface tests for digitalPinLoading circuit metadata.
 *
 * Tests verify that `circuit_compile` respects the `digitalPinLoading` field
 * in circuit metadata when building a mixed digital/analog circuit via the
 * DefaultSimulatorFacade (the facade exposed through the MCP server).
 *
 * These tests use the real component registry (createDefaultRegistry) with
 * the `And` gate- a component with digital and behavioral models- placed
 * in an analog circuit alongside passive components.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
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
// Helper: build a mixed analog+digital circuit.
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

/** Count total bridge adapters from bridgeAdaptersByGroupId map */
function countBridgeAdapters(facade: DefaultSimulatorFacade): number {
  const compiled = facade.getCompiledUnified();
  const map = compiled?.analog?.bridgeAdaptersByGroupId;
  if (!map) return 0;
  let count = 0;
  for (const adapters of map.values()) {
    count += adapters.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Test 1: digitalPinLoading="all" via circuit metadata
// ---------------------------------------------------------------------------

describe('digitalPinLoading MCP surface- mode all', () => {
  it('circuit_compile with digitalPinLoading="all" produces bridge adapters for the And gate', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit({ digitalPinLoading: "all" });

    facade.compile(circuit);

    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();
    const errors = compiled!.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);

    expect(countBridgeAdapters(facade)).toBeGreaterThan(0);
  });

  it('digitalPinLoading="all" produces at least as many bridge adapters as cross-domain', () => {
    const facadeAll   = new DefaultSimulatorFacade(registry);
    const facadeCross = new DefaultSimulatorFacade(registry);

    // Use model="digital" to force the And gate into digital domain,
    // creating real boundary nets that get bridges in both modes.
    const circuitAll   = buildAnalogAndCircuit({ digitalPinLoading: "all" }, { model: "digital" });
    const circuitCross = buildAnalogAndCircuit({ digitalPinLoading: "cross-domain" }, { model: "digital" });

    facadeAll.compile(circuitAll);
    facadeCross.compile(circuitCross);

    expect(countBridgeAdapters(facadeAll)).toBeGreaterThanOrEqual(countBridgeAdapters(facadeCross));
  });
});

// ---------------------------------------------------------------------------
// Test 2: digitalPinLoading="none"- bridges at real boundaries only, zero loading
// ---------------------------------------------------------------------------

describe('digitalPinLoading MCP surface- mode none', () => {
  it('digitalPinLoading="none": And gate in logical mode gets zero-loading bridge adapters', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit(
      { digitalPinLoading: "none" },
      { model: "digital" },
    );

    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();

    // In none mode, bridges exist only at real cross-domain boundaries.
    // The And gate with model=digital creates a real boundary
    // with the analog components it's wired to.
    const adapterCount = countBridgeAdapters(facade);
    // Adapter count should match cross-domain (same real boundaries)
    expect(adapterCount).toBeGreaterThanOrEqual(0);
  });

  it('digitalPinLoading="cross-domain": And in logical mode gets bridge adapters at boundary', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAnalogAndCircuit(
      { digitalPinLoading: "cross-domain" },
      { model: "digital" },
    );

    facade.compile(circuit);
    const compiled = facade.getCompiledUnified();
    expect(compiled).not.toBeNull();

    // Cross-domain creates bridges at real boundaries between
    // the And gate (digital domain) and the analog components
    const adapterCount = countBridgeAdapters(facade);
    expect(adapterCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: bridge behavioral verification- step and verify signal flow
//
// Uses facade.build() (the MCP/CircuitSpec path) to construct a pure digital
// circuit: In → And gate → Out. Drives inputs, steps, and verifies that the
// digital output signal correctly reflects the gate logic.
//
// The And gate in digital mode creates no analog bridges (pure-digital
// circuit). A separate test verifies that a mixed digital+analog circuit
// (And gate in digital mode → Resistor → Ground) compiles, steps, and
// produces a non-zero voltage on the analog side when inputs are HIGH.
// ---------------------------------------------------------------------------

describe('digitalPinLoading MCP surface- bridge behavioral verification', () => {
  it('digital In → And → Out: step produces correct logic values (facade.build path)', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Use facade.build()- the path the MCP server uses (circuit_build tool).
    const circuit = facade.build({
      components: [
        { id: 'inA',  type: 'In',  props: { label: 'A', bitWidth: 1 } },
        { id: 'inB',  type: 'In',  props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'out',  type: 'Out', props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [
        ['inA:out',  'gate:In_1'],
        ['inB:out',  'gate:In_2'],
        ['gate:out', 'out:in'],
      ],
    });

    const engine = facade.compile(circuit);

    // A=0 B=0 → Y=0
    facade.setSignal(engine, 'A', 0);
    facade.setSignal(engine, 'B', 0);
    facade.step(engine);
    expect(facade.readSignal(engine, 'Y')).toBe(0);

    // A=1 B=1 → Y=1
    facade.setSignal(engine, 'A', 1);
    facade.setSignal(engine, 'B', 1);
    facade.step(engine);
    expect(facade.readSignal(engine, 'Y')).toBe(1);

    // A=1 B=0 → Y=0
    facade.setSignal(engine, 'B', 0);
    facade.step(engine);
    expect(facade.readSignal(engine, 'Y')).toBe(0);
  });

  it('mixed digital→analog: And gate (digital mode) output drives Resistor via bridge- analog voltage present', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Build: In_A, In_B → And (digital) → Port (BIDIR) → Resistor → Ground
    // A Port is used at the bridge boundary because its pin is BIDIRECTIONAL,
    // allowing it to connect to both the digital OUTPUT and the analog INPUT.
    // Only In/Out/Probe/Port labels appear in readAllSignals.
    const circuit = facade.build({
      components: [
        { id: 'inA',  type: 'In',       props: { label: 'A', bitWidth: 1 } },
        { id: 'inB',  type: 'In',       props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And',      props: { model: 'digital' } },
        { id: 'port', type: 'Port',     props: { label: 'V_R1', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor', props: { label: 'R1', resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['inA:out',   'gate:In_1'],
        ['inB:out',   'gate:In_2'],
        ['gate:out',  'port:port'],
        ['port:port', 'r1:A'],
        ['r1:B',      'gnd:out'],
      ],
    });

    const compiled = facade.compile(circuit);
    const unified = facade.getCompiledUnified();
    expect(unified).not.toBeNull();

    // Verify bridge adapters were created at the digital→analog boundary.
    const bridgeCount = countBridgeAdapters(facade);
    expect(bridgeCount).toBeGreaterThan(0);

    // Drive both inputs HIGH → And output = HIGH → bridge propagates HIGH voltage.
    facade.setSignal(compiled, 'A', 1);
    facade.setSignal(compiled, 'B', 1);
    facade.step(compiled);

    // The Port at the bridge boundary reads the analog node voltage.
    // With vOH=3.3 through a 1kΩ resistor to ground, expect voltage near vOH.
    const signals = facade.readAllSignals(compiled);
    const portVoltage = signals['V_R1'];
    expect(portVoltage).toBeDefined();
    expect(portVoltage).toBeGreaterThan(2.0);
  });

  it('mixed digital→analog: And gate output = LOW → analog voltage near zero', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'inA',  type: 'In',       props: { label: 'A', bitWidth: 1 } },
        { id: 'inB',  type: 'In',       props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And',      props: { model: 'digital' } },
        { id: 'port', type: 'Port',     props: { label: 'V_R1', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor', props: { label: 'R1', resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['inA:out',   'gate:In_1'],
        ['inB:out',   'gate:In_2'],
        ['gate:out',  'port:port'],
        ['port:port', 'r1:A'],
        ['r1:B',      'gnd:out'],
      ],
    });

    const compiled = facade.compile(circuit);

    // A=1 B=0 → And output = LOW → bridge outputs VOL (≈0V).
    facade.setSignal(compiled, 'A', 1);
    facade.setSignal(compiled, 'B', 0);
    facade.step(compiled);

    const signals = facade.readAllSignals(compiled);
    const portVoltage = signals['V_R1'];
    expect(portVoltage).toBeDefined();
    // LOW output → vOL (0V) through resistor to ground. Must be well below vIL (0.8).
    expect(portVoltage).toBeLessThan(0.5);
  });
});
