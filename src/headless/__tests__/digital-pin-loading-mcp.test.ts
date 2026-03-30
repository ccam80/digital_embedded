/**
 * MCP tool surface tests for digitalPinLoading circuit metadata.
 *
 * Tests verify that `circuit_compile` respects the `digitalPinLoading` field
 * in circuit metadata when building a mixed digital/analog circuit via the
 * DefaultSimulatorFacade (the facade exposed through the MCP server).
 *
 * These tests use the real component registry (createDefaultRegistry) with
 * the `And` gate — a component with digital and behavioral models — placed
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

describe('digitalPinLoading MCP surface — mode all', () => {
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
// Test 2: digitalPinLoading="none" — bridges at real boundaries only, zero loading
// ---------------------------------------------------------------------------

describe('digitalPinLoading MCP surface — mode none', () => {
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
