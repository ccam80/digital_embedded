/**
 * MCP tool surface tests for Port-based subcircuits (SE-9a).
 *
 * Tests verify that the headless facade and compiler correctly handle
 * Port components as subcircuit interface elements, including:
 *   - circuit_build with Port appears in netlist
 *   - circuit_compile succeeds for Port-interface subcircuits
 *   - circuit_test resolves test vector columns to Port labels
 *   - setInput()/readOutput() resolve Port labels via labelSignalMap
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Test 1: circuit_build with a Port component succeeds and netlist shows Port
// ---------------------------------------------------------------------------

describe('Port MCP surface — build and netlist', () => {
  it('circuit_build with a Port component succeeds and netlist lists the Port', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'in1',  type: 'In',   props: { label: 'A', bitWidth: 1 } },
        { id: 'port1', type: 'Port', props: { label: 'P', bitWidth: 1 } },
        { id: 'out1', type: 'Out',  props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [
        ['in1:out', 'port1:port'],
        ['port1:port', 'out1:in'],
      ],
    });

    const netlist = facade.netlist(circuit);

    // Port must appear in the component list
    const portComponents = netlist.components.filter(c => c.typeId === 'Port');
    expect(portComponents.length).toBe(1);
    expect(portComponents[0]!.label).toBe('P');
  });
});

// ---------------------------------------------------------------------------
// Test 2: circuit_compile succeeds for a Port-interface subcircuit
// ---------------------------------------------------------------------------

describe('Port MCP surface — compile', () => {
  it('Port-only interface circuit compiles without In/Out elements', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Build a NOT gate with ONLY Port elements as interface — no In/Out
    const circuit = facade.build({
      components: [
        { id: 'pIn',  type: 'Port', props: { label: 'X', bitWidth: 1, face: 'left'  } },
        { id: 'gate', type: 'Not' },
        { id: 'pOut', type: 'Port', props: { label: 'Z', bitWidth: 1, face: 'right' } },
      ],
      connections: [
        ['pIn:port',  'gate:in'],
        ['gate:out',  'pOut:port'],
      ],
    });

    // Compile must not throw — Port-only circuits are valid subcircuit definitions
    expect(() => facade.compile(circuit)).not.toThrow();

    const diagnostics = facade.validate(circuit);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);

    // Port labels appear in signal snapshot
    const engine = facade.compile(circuit);
    const signals = facade.readAllSignals(engine);
    expect('X' in signals).toBe(true);
    expect('Z' in signals).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: circuit_test resolves test vector columns to Port labels
// ---------------------------------------------------------------------------

describe('Port MCP surface — test vectors resolve Port labels', () => {
  it('circuit_test resolves Port label as output column in test vectors', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // AND gate: In-labeled inputs, Port-labeled output (no Out needed)
    const circuit = facade.build({
      components: [
        { id: 'A',    type: 'In',   props: { label: 'A', bitWidth: 1 } },
        { id: 'B',    type: 'In',   props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'pOut', type: 'Port', props: { label: 'Y', bitWidth: 1, face: 'right' } },
      ],
      connections: [
        ['A:out',    'gate:In_1'],
        ['B:out',    'gate:In_2'],
        ['gate:out', 'pOut:port'],
      ],
    });

    const engine = facade.compile(circuit);

    // Port label Y used directly as the output column
    const testData = 'A B | Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1';
    const results = facade.runTests(engine, circuit, testData);

    expect(results.total).toBe(4);
    expect(results.passed).toBe(4);
    expect(results.failed).toBe(0);
  });

  it('Port label appears in readAllSignals snapshot', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'in1',  type: 'In',   props: { label: 'A', bitWidth: 1 } },
        { id: 'pOut', type: 'Port', props: { label: 'P_out', bitWidth: 1, face: 'right' } },
        { id: 'out1', type: 'Out',  props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [
        ['in1:out',  'pOut:port'],
        ['pOut:port','out1:in'],
      ],
    });

    const engine = facade.compile(circuit);
    facade.setInput(engine, 'A', 1);
    facade.step(engine);

    const signals = facade.readAllSignals(engine);

    // Port label must appear in the signal snapshot
    expect('P_out' in signals).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 4: setInput()/readOutput() resolve Port labels
// ---------------------------------------------------------------------------

describe('Port MCP surface — setInput/readOutput via Port labels', () => {
  it('setInput and readOutput resolve Port labels in a wire-through circuit', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Circuit: In("src") → Port("mid") → Out("dst")
    // Port is on the same net as In and Out — signal passes through transparently.
    const circuit = facade.build({
      components: [
        { id: 'src', type: 'In',   props: { label: 'src', bitWidth: 1 } },
        { id: 'mid', type: 'Port', props: { label: 'mid', bitWidth: 1, face: 'right' } },
        { id: 'dst', type: 'Out',  props: { label: 'dst', bitWidth: 1 } },
      ],
      connections: [
        ['src:out', 'mid:port'],
        ['mid:port', 'dst:in'],
      ],
    });

    const engine = facade.compile(circuit);

    // Drive via In label, read via Out label — both should work
    facade.setInput(engine, 'src', 1);
    facade.step(engine);
    expect(facade.readOutput(engine, 'dst')).toBe(1);

    // Port label itself must be readable (same net)
    expect(facade.readOutput(engine, 'mid')).toBe(1);

    // Change value
    facade.setInput(engine, 'src', 0);
    facade.step(engine);
    expect(facade.readOutput(engine, 'mid')).toBe(0);
    expect(facade.readOutput(engine, 'dst')).toBe(0);
  });

  it('Port label resolves in labelSignalMap — setInput via Port label drives the net', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Circuit: Port("drive") → Out("observe")
    // Port is connected to Out — driving the Port net drives the Out.
    // We also need an In as the digital driver source for the compiler.
    const circuit = facade.build({
      components: [
        { id: 'inp',   type: 'In',   props: { label: 'drive', bitWidth: 1 } },
        { id: 'pDrive', type: 'Port', props: { label: 'drive_port', bitWidth: 1 } },
        { id: 'obs',   type: 'Out',  props: { label: 'observe', bitWidth: 1 } },
      ],
      connections: [
        ['inp:out',     'pDrive:port'],
        ['pDrive:port', 'obs:in'],
      ],
    });

    const engine = facade.compile(circuit);

    // The Port label must exist in the compiled labelSignalMap
    const netlist = facade.netlist(circuit);
    const portComp = netlist.components.find(c => c.typeId === 'Port');
    expect(portComp!.label).toBe('drive_port');

    // readOutput via Port label works
    facade.setInput(engine, 'drive', 1);
    facade.step(engine);
    expect(facade.readOutput(engine, 'drive_port')).toBe(1);
    expect(facade.readOutput(engine, 'observe')).toBe(1);
  });
});
