/**
 * Mixed-mode and analog Port tests (SE-9a follow-up).
 *
 * The Port component is documented as "domain-agnostic subcircuit interface
 * element", but every test in port-mcp.test.ts uses purely digital circuits.
 * These tests cover the analog and mixed-mode cases that are Port's core
 * value proposition over plain In/Out.
 *
 * Tests:
 *   1. Port connected to Resistor- pure analog circuit, Port is neutral
 *      infrastructure.  Compilation must succeed with zero errors.
 *   2. Port in mixed-mode subcircuit- And gate (digital) + Resistor (analog)
 *      with Port interfaces.  Compilation must succeed; partition/bridge
 *      mechanism must handle Port correctly.
 *   3. Port label resolution in analog domain- when the analog compiler's
 *      labelToNodeId includes Port, readAllSignals() must expose that label.
 *
 * If any test reveals that Port does not work with analog components, the
 * assertion is left as-is so the failure is reported faithfully.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Test 1: Port connected to Resistor- pure analog
//
// Circuit topology (no digital components):
//   DcVoltageSource(pos) → Port("P_in") → Resistor("R1") → Ground
//
// Port has models:{} (neutral infrastructure). The analog compiler must skip
// Port when building MNA elements and resolve the Port's label into
// labelToNodeId so that readAllSignals() returns a "P_in" entry.
// ---------------------------------------------------------------------------

describe('Port + Resistor- pure analog compile', () => {
  it('compiles a circuit with Port connected to Resistor without errors', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'vsrc', type: 'DcVoltageSource', props: { label: 'V1', voltage: 5 } },
        { id: 'port', type: 'Port', props: { label: 'P_in', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor',        props: { label: 'R1', resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        // Port:port is BIDIRECTIONAL; connect it as the source side.
        // vsrc:pos is INPUT (positive terminal node); port:port→vsrc:pos is
        // BIDIRECTIONAL→INPUT which the builder accepts.
        ['port:port', 'vsrc:pos'],
        ['port:port', 'r1:A'],
        ['r1:B',     'gnd:out'],
        ['vsrc:neg', 'gnd:out'],
      ],
    });

    // Validate- no fatal errors expected
    const diagnostics = facade.validate(circuit);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors, `Unexpected errors: ${JSON.stringify(errors)}`).toHaveLength(0);

    // Compile must not throw
    expect(() => facade.compile(circuit)).not.toThrow();
  });

  it('Port is skipped as a neutral element in the analog MNA matrix (no analog model)', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Port.models is {}- it must not be stamped into the MNA matrix.
    // We verify this indirectly: if Port were stamped as an unknown element
    // the compile() call would throw or produce an error diagnostic.
    const circuit = facade.build({
      components: [
        { id: 'vsrc', type: 'DcVoltageSource', props: { voltage: 5 } },
        { id: 'port', type: 'Port',            props: { label: 'P_mid', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor',        props: { resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['port:port', 'vsrc:pos'],
        ['port:port', 'r1:A'],
        ['r1:B',     'gnd:out'],
        ['vsrc:neg', 'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);
    facade.step(engine);
    // Port is neutral infrastructure- verify the circuit compiles and steps
    // without error, and the analog domain has elements (vsrc + r1, not Port).
    const signals = facade.readAllSignals(engine);
    expect(Object.keys(signals).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Port in mixed-mode subcircuit
//
// Circuit: And gate (digital) outputs through a Port into a Resistor (analog).
// The And gate sends its output into the digital partition; the Resistor is in
// the analog partition; Port sits on the boundary.
//
// The partition/bridge mechanism must handle Port without crashing.  Port
// resolves as "neutral" so it is not assigned to either partition's component
// list- the bridge is created between the two connectivity groups that span
// the Port's wire.
//
// Structural test: compile must succeed without throwing.
// ---------------------------------------------------------------------------

describe('Port in mixed-mode circuit- And gate + Resistor', () => {
  it('compile() does not throw when Port sits between digital And gate and analog Resistor', () => {
    const facade = new DefaultSimulatorFacade(registry);

    // In/Out for digital driver; Resistor/Ground for analog load.
    // Port is the neutral interface element between the two domains.
    const circuit = facade.build({
      components: [
        { id: 'inA',  type: 'In',      props: { label: 'A', bitWidth: 1 } },
        { id: 'inB',  type: 'In',      props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'port', type: 'Port',    props: { label: 'P_bnd', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor', props: { resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['inA:out',  'gate:In_1'],
        ['inB:out',  'gate:In_2'],
        ['gate:out', 'port:port'],
        ['port:port', 'r1:A'],
        ['r1:B',     'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);
    expect(engine).toBeDefined();
    expect(facade.readAllSignals(engine)).toBeDefined();
  });

  it('netlist lists the Port component in a mixed-mode circuit', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'inA',  type: 'In',      props: { label: 'A', bitWidth: 1 } },
        { id: 'inB',  type: 'In',      props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'port', type: 'Port',    props: { label: 'P_bnd', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor', props: { resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['inA:out',  'gate:In_1'],
        ['inB:out',  'gate:In_2'],
        ['gate:out', 'port:port'],
        ['port:port', 'r1:A'],
        ['r1:B',     'gnd:out'],
      ],
    });

    const netlist = facade.netlist(circuit);
    const portComponents = netlist.components.filter(c => c.typeId === 'Port');
    expect(portComponents).toHaveLength(1);
    expect(portComponents[0]!.label).toBe('P_bnd');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Port label resolution in analog domain
//
// Port labels must appear in labelToNodeId via the partition compiler path
// (compileAnalogPartition) with "Port" in its labelTypes set.
// ---------------------------------------------------------------------------

describe('Port label resolution in analog domain via readAllSignals()', () => {
  it('Port label appears in readAllSignals() for a pure analog circuit', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'vsrc', type: 'DcVoltageSource', props: { voltage: 5 } },
        { id: 'port', type: 'Port',            props: { label: 'P_probe', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor',        props: { resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['port:port', 'vsrc:pos'],
        ['port:port', 'r1:A'],
        ['r1:B',     'gnd:out'],
        ['vsrc:neg', 'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);
    facade.step(engine);

    const signals = facade.readAllSignals(engine);

    // Port must appear in labelToNodeId via the partition compiler path
    // (compileAnalogPartition) with "Port" in its labelTypes set.
    expect('P_probe' in signals).toBe(true);
    // The voltage at the Port node should be ~5V (DcVoltageSource sets it directly).
    expect(signals['P_probe']).toBeGreaterThan(4.9);
  });

  it('readSignal() via Port label works in a pure analog circuit', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'vsrc', type: 'DcVoltageSource', props: { voltage: 5 } },
        { id: 'port', type: 'Port',            props: { label: 'P_read', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor',        props: { resistance: 1000 } },
        { id: 'gnd',  type: 'Ground' },
      ],
      connections: [
        ['port:port', 'vsrc:pos'],
        ['port:port', 'r1:A'],
        ['r1:B',     'gnd:out'],
        ['vsrc:neg', 'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);
    facade.step(engine);

    // readSignal() throws FacadeError when the label is absent from
    // labelSignalMap. If Port labels are not resolved by compileAnalogPartition,
    // this will throw and the test will fail- exposing the gap.
    expect(() => facade.readSignal(engine, 'P_read')).not.toThrow();
    const voltage = facade.readSignal(engine, 'P_read');
    // With 5V source and 1kΩ load, the voltage at the Port node is ~5V
    // (DcVoltageSource sets the node to exactly 5V).
    expect(voltage).toBeGreaterThan(4.9);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Port in pure-digital circuit- no regression
// ---------------------------------------------------------------------------

describe('Port in pure-digital circuit- no regression', () => {
  it('Port works as expected in a digital-only circuit', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'inA', type: 'In',  props: { label: 'A', bitWidth: 1 } },
        { id: 'port', type: 'Port', props: { label: 'P_dig', bitWidth: 1 } },
        { id: 'out', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [
        ['inA:out', 'port:port'],
        ['port:port', 'out:in'],
      ],
    });

    const engine = facade.compile(circuit);
    facade.setSignal(engine, 'A', 1);
    facade.step(engine);

    const y = facade.readSignal(engine, 'Y');
    expect(y).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Port at cross-domain boundary- connected to both digital and analog
// ---------------------------------------------------------------------------

describe('Port at cross-domain boundary', () => {
  it('readSignal() returns a value for Port at digital-analog boundary', () => {
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: 'inA',  type: 'In',       props: { label: 'A', bitWidth: 1 } },
        { id: 'inB',  type: 'In',       props: { label: 'B', bitWidth: 1 } },
        { id: 'gate', type: 'And' },
        { id: 'port', type: 'Port',     props: { label: 'P_bnd', bitWidth: 1 } },
        { id: 'r1',   type: 'Resistor', props: { resistance: 1000 } },
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

    // Compile should succeed- Port spans both domains via the bridge mechanism
    const engine = facade.compile(circuit);
    facade.step(engine);

    const value = facade.readSignal(engine, 'P_bnd');
    expect(value).toBeDefined();
  });
});
